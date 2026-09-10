import { ArtifactIndexQuery, ArtifactIndexResult, ChainHead, Event, EventStore, HeadMovedError, HistoryQuery, HistoryPage, PendingDelivery, Share, artifactIndexRows, clampHistoryLimit, eventsReferencingArtifactsSql, historyPageFromNewestFirst, likeContains, policyDocumentFromRow, policySnapshotFromIndex, assertRouteWriteConsistent, RouteConflictError } from "@retrace-dev/core";
import type { BreakerRow, ClassificationContextRow, PolicyRouteRow, PolicySnapshot, PolicySnapshotBudget, PolicyWrite } from "@retrace-dev/core";

export class D1Store implements EventStore {
  constructor(private db: D1Database) {}

  async head(project: string) {
    const row = await this.db.prepare("SELECT seq, hash FROM events WHERE project = ? ORDER BY seq DESC LIMIT 1").bind(project).first<{ seq: number; hash: string }>();
    return row ?? null;
  }

  /** Row writes for one event. With `guard`, each INSERT becomes `INSERT … SELECT … WHERE <guard>` so it writes
   *  nothing unless the guard predicate holds at execution time (used by deleteProject's head check). */
  private insertStatements(e: Event, guard?: { sql: string; params: unknown[] }) {
    const where = guard ? ` WHERE ${guard.sql}` : "";
    const gp = guard?.params ?? [];
    return [
      this.db
        .prepare(
          `INSERT INTO events (id, project, seq, timestamp, received_at, actor_type, actor_id, action, caused_by, idempotency_key, prev_hash, hash, body)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${where}`,
        )
        .bind(e.id, e.project, e.seq, e.timestamp, e.received_at, e.actor.type, e.actor.id, e.action, e.caused_by ?? null, e.idempotency_key ?? null, e.prev_hash, e.hash, JSON.stringify(e), ...gp),
      ...e.artifacts.map((a) => this.db.prepare(`INSERT OR IGNORE INTO event_artifacts (event_id, project, artifact_id) SELECT ?, ?, ?${where}`).bind(e.id, e.project, a.id, ...gp)),
      ...artifactIndexRows(e).map((r) =>
        this.db
          .prepare(`INSERT OR IGNORE INTO event_artifact_index (project, artifact_key, seq, actor_type, actor_id, role, sealed_by) SELECT ?, ?, ?, ?, ?, ?, ?${where}`)
          .bind(r.project, r.artifact_key, r.seq, r.actor_type, r.actor_id, r.role, r.sealed_by, ...gp),
      ),
    ];
  }

  async insert(e: Event) {
    await this.db.batch(this.insertStatements(e)); // batch is atomic in D1
  }

  /** Deletes + the audit insert run in one D1 batch, which is atomic: if the audit's (project, seq) collides the
   *  deletes roll back too (B3). A batch has no control flow, so the head check is expressed in SQL: the audit row
   *  is only inserted if the target project's head is still exactly `expectedHead`, and every DELETE is conditioned
   *  on that audit row existing. If a write raced the delete, the batch is a no-op and we throw HeadMovedError. */
  async deleteProject(project: string, audit: Event, expectedHead: ChainHead) {
    if (audit.project === project) throw new Error("audit event must not live in the project being deleted");
    // Keep every project-owned row in this guarded transaction. In particular, leaving export_cache behind would
    // retain the deleted ledger bytes and could serve them as a stale bundle if the project name were recreated.
    const tables = ["events", "event_artifacts", "event_artifact_index", "pending_deliveries", "shares", "checkpoints", "export_cache", "project_policies", "classification_contexts", "classification_path_lowers", "classification_breakers"];
    const headMatches = {
      sql: "EXISTS (SELECT 1 FROM events WHERE project = ? AND seq = ? AND hash = ?) AND NOT EXISTS (SELECT 1 FROM events WHERE project = ? AND seq > ?)",
      params: [project, expectedHead.seq, expectedHead.hash, project, expectedHead.seq],
    };
    const auditLanded = "EXISTS (SELECT 1 FROM events WHERE id = ?)";
    const [auditEvent, ...auditArtifacts] = this.insertStatements(audit, headMatches);
    const results = await this.db.batch([
      auditEvent,
      ...auditArtifacts, // the guard still holds here: the audit lives in another project, so the target head is unchanged
      ...tables.map((t) => this.db.prepare(`DELETE FROM ${t} WHERE project = ? AND ${auditLanded}`).bind(project, audit.id)),
    ]);
    const landed = results[0].meta.changes === 1 || (results[0].meta.changes == null && !!(await this.get(audit.id)));
    if (!landed) throw new HeadMovedError(project, expectedHead);
    const offset = 1 + auditArtifacts.length;
    return Object.fromEntries(tables.map((t, i) => [t, results[offset + i].meta.changes ?? 0]));
  }

  async createShare(s: Share) {
    await this.db.prepare("INSERT INTO shares (id, project, artifact_id, label, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(s.id, s.project, s.artifact_id ?? null, s.label ?? null, s.created_at, s.expires_at ?? null, s.created_by ?? null).run();
  }
  async getShare(id: string) {
    const r = await this.db.prepare("SELECT * FROM shares WHERE id = ?").bind(id).first<any>();
    if (!r) return null;
    return { id: r.id, project: r.project, artifact_id: r.artifact_id ?? undefined, label: r.label ?? undefined, created_at: r.created_at, expires_at: r.expires_at ?? undefined, created_by: r.created_by ?? undefined } as Share;
  }
  async deleteShare(id: string) {
    const r = await this.db.prepare("DELETE FROM shares WHERE id = ?").bind(id).run();
    return (r.meta.changes ?? 0) > 0;
  }

  async byIdempotencyKey(project: string, key: string) {
    const row = await this.db.prepare("SELECT body FROM events WHERE project = ? AND idempotency_key = ? LIMIT 1").bind(project, key).first<{ body: string }>();
    return row ? (JSON.parse(row.body) as Event) : null;
  }

  async get(id: string) {
    const row = await this.db.prepare("SELECT body FROM events WHERE id = ?").bind(id).first<{ body: string }>();
    return row ? (JSON.parse(row.body) as Event) : null;
  }

  async all(project: string) {
    const { results } = await this.db.prepare("SELECT body FROM events WHERE project = ? ORDER BY seq ASC").bind(project).all<{ body: string }>();
    return results.map((r) => JSON.parse(r.body) as Event);
  }

  async projects() {
    const { results } = await this.db.prepare("SELECT DISTINCT project FROM events ORDER BY project").all<{ project: string }>();
    return results.map((r) => r.project);
  }

  async history(q: HistoryQuery): Promise<HistoryPage> {
    const where: string[] = ["e.project = ?"];
    const params: (string | number)[] = [q.project];
    let join = "";
    if (q.artifact_id) { join = "JOIN event_artifacts ea ON ea.event_id = e.id"; where.push("ea.artifact_id = ?"); params.push(q.artifact_id); }
    if (q.actor_id) { where.push("e.actor_id = ?"); params.push(q.actor_id); }
    if (q.actor_type) { where.push("e.actor_type = ?"); params.push(q.actor_type); }
    if (q.action) { where.push("e.action = ?"); params.push(q.action); }
    if (q.since) { where.push("e.timestamp >= ?"); params.push(q.since); }
    if (q.until) { where.push("e.timestamp <= ?"); params.push(q.until); }
    if (q.text) { const like = likeContains(q.text); where.push(like.sql); params.push(like.pattern); }
    if (typeof q.before_seq === "number" && Number.isFinite(q.before_seq)) { where.push("e.seq < ?"); params.push(q.before_seq); }
    const limit = clampHistoryLimit(q.limit);
    const sql = `SELECT DISTINCT e.body, e.seq FROM events e ${join} WHERE ${where.join(" AND ")} ORDER BY e.seq DESC LIMIT ?`;
    const { results } = await this.db.prepare(sql).bind(...params, limit + 1).all<{ body: string }>();
    return historyPageFromNewestFirst(results.map((r) => JSON.parse(r.body) as Event), limit);
  }

  async eventsReferencingArtifacts(q: ArtifactIndexQuery, now: () => number = Date.now): Promise<ArtifactIndexResult> {
    if (now() >= q.deadline) return { ok: false, reason: "deadline" };
    if (!q.artifact_keys.length) return { ok: true, events: [] };
    try {
      const { sql, params } = eventsReferencingArtifactsSql(q);
      const { results } = await this.db.prepare(sql).bind(...params).all<{ body: string }>();
      if (now() >= q.deadline) return { ok: false, reason: "deadline" };
      if (results.length > q.row_cap) return { ok: false, reason: "budget" };
      const seen = new Set<string>();
      const events: Event[] = [];
      for (const r of results) {
        const e = JSON.parse(r.body) as Event;
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        events.push(e);
      }
      return { ok: true, events };
    } catch {
      return { ok: false, reason: "store_error" };
    }
  }

  async insertPendingDelivery(row: PendingDelivery) {
    try {
      await this.db.prepare(
        "INSERT INTO pending_deliveries (delivery_id, project, raw_body, received_at, repo, routing_source, routing_digest, routing_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(row.delivery_id, row.project, row.raw_body, row.received_at, row.repo ?? null, row.routing_source ?? null, row.routing_digest ?? null, row.routing_state ?? null).run();
    } catch (e: unknown) {
      if (!/UNIQUE/i.test(String((e as Error)?.message))) throw e;
    }
  }

  async getPendingDelivery(delivery_id: string): Promise<PendingDelivery | null> {
    return (await this.db.prepare(
      "SELECT delivery_id, project, raw_body, received_at, repo, routing_source, routing_digest, routing_state FROM pending_deliveries WHERE delivery_id = ?",
    ).bind(delivery_id).first<PendingDelivery>()) ?? null;
  }

  async listPendingDeliveriesOlderThan(received_at: string): Promise<PendingDelivery[]> {
    const { results } = await this.db.prepare(
      "SELECT delivery_id, project, raw_body, received_at, repo, routing_source, routing_digest, routing_state FROM pending_deliveries WHERE received_at < ? ORDER BY received_at ASC",
    ).bind(received_at).all<PendingDelivery>();
    return results;
  }

  async deletePendingDelivery(delivery_id: string): Promise<boolean> {
    const r = await this.db.prepare("DELETE FROM pending_deliveries WHERE delivery_id = ?").bind(delivery_id).run();
    return (r.meta.changes ?? 0) > 0;
  }

  async getPolicy(project: string, lookup: { digest?: string; version?: number; current?: boolean } = { current: true }) {
    const row = lookup.digest
      ? await this.db.prepare("SELECT body, envelope, digest FROM project_policies WHERE project = ? AND digest = ?").bind(project, lookup.digest).first<{ body: string; envelope: string; digest: string }>()
      : lookup.version !== undefined
        ? await this.db.prepare("SELECT body, envelope, digest FROM project_policies WHERE project = ? AND version = ?").bind(project, lookup.version).first<{ body: string; envelope: string; digest: string }>()
        : await this.db.prepare("SELECT body, envelope, digest FROM project_policies WHERE project = ? ORDER BY version DESC LIMIT 1").bind(project).first<{ body: string; envelope: string; digest: string }>();
    return row ? policyDocumentFromRow(row) : null;
  }

  async listPolicies(project: string, limit = 50) {
    const { results } = await this.db.prepare("SELECT body, envelope, digest FROM project_policies WHERE project = ? ORDER BY version DESC LIMIT ?").bind(project, limit).all<{ body: string; envelope: string; digest: string }>();
    return results.map(policyDocumentFromRow);
  }

  async getPolicyRoute(repo: string) {
    return (await this.db.prepare("SELECT repo, state, project, digest, activation_seq, set_at FROM policy_routes WHERE repo = ?").bind(repo).first<PolicyRouteRow>()) ?? null;
  }

  async listPolicyRoutes(project: string) {
    const { results } = await this.db.prepare("SELECT repo, state, project, digest, activation_seq, set_at FROM policy_routes WHERE project = ? ORDER BY repo").bind(project).all<PolicyRouteRow>();
    return results;
  }

  async getPolicyByActivationSeq(project: string, throughSeq: number) {
    const row = await this.db.prepare("SELECT body, envelope, digest FROM project_policies WHERE project = ? AND activation_seq <= ? ORDER BY activation_seq DESC LIMIT 1").bind(project, throughSeq).first<{ body: string; envelope: string; digest: string }>();
    return row ? policyDocumentFromRow(row) : null;
  }

  async readPolicySnapshot(project: string, U?: number, budget?: PolicySnapshotBudget): Promise<PolicySnapshot> {
    const head = await this.head(project);
    return policySnapshotFromIndex({
      project,
      U,
      budget,
      headSeq: head?.seq,
      getByActivationSeq: (p, seq) => this.getPolicyByActivationSeq(p, seq),
      getEvent: (id) => this.get(id),
    });
  }

  async applyPolicyWrite(write: PolicyWrite, expectedHeads: Record<string, ChainHead | null>) {
    for (const [project, expected] of Object.entries(expectedHeads)) {
      const head = await this.head(project);
      if (expected === null) {
        if (head) throw new HeadMovedError(project, { seq: -1, hash: "none" });
      } else if (!head || head.seq !== expected.seq || head.hash !== expected.hash) {
        throw new HeadMovedError(project, expected);
      }
    }
    const liveByProject = new Map<string, import("@retrace-dev/core").PolicyDocument | null>();
    const existingByRepo = new Map<string, PolicyRouteRow | null>();
    for (const r of write.routes) {
      if (r.state !== "active") continue;
      const existing = await this.getPolicyRoute(r.repo);
      existingByRepo.set(r.repo, existing);
      if (existing && existing.project !== r.project && !liveByProject.has(existing.project))
        liveByProject.set(existing.project, await this.getPolicy(existing.project, { current: true }));
    }
    assertRouteWriteConsistent(
      write,
      (repo) => existingByRepo.get(repo) ?? null,
      (project) => write.documents.find((d) => d.body.project === project) ?? liveByProject.get(project) ?? null,
    );
    // Route CAS first. D1 cannot RAISE outside a trigger, so a lost upsert is a no-op;
    // events and documents are INSERT…SELECT…WHERE the active routes now belong to us.
    // If CAS lost, those writes insert nothing and the batch has no loser activation.
    const activeRoutes = write.routes.filter((r) => r.state === "active");
    const guard = activeRoutes.length
      ? {
        sql: activeRoutes.map(() => "EXISTS (SELECT 1 FROM policy_routes WHERE repo = ? AND project = ?)").join(" AND "),
        params: activeRoutes.flatMap((r) => [r.repo, r.project]),
      }
      : undefined;
    const stmts = [
      ...write.routes.map((r) => this.db.prepare(
        `INSERT INTO policy_routes (repo, state, project, digest, activation_seq, set_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo) DO UPDATE SET state=excluded.state, project=excluded.project, digest=excluded.digest, activation_seq=excluded.activation_seq, set_at=excluded.set_at
         WHERE policy_routes.project = excluded.project
            OR policy_routes.state = 'revoked'
            OR EXISTS (
              SELECT 1 FROM project_policies pp
              WHERE pp.project = policy_routes.project
                AND pp.activation_seq = (SELECT MAX(activation_seq) FROM project_policies WHERE project = policy_routes.project)
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(json_extract(pp.body, '$.github_repos')) je
                  WHERE je.value = excluded.repo
                )
            )`,
      ).bind(r.repo, r.state, r.project, r.digest, r.activation_seq, r.set_at)),
      ...write.events.flatMap((e) => this.insertStatements(e, guard)),
      ...write.documents.map((d) => {
        const where = guard ? ` WHERE ${guard.sql}` : "";
        const gp = guard?.params ?? [];
        return this.db.prepare(
          `INSERT INTO project_policies (project, version, digest, body, envelope, activation_seq, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?${where}`,
        ).bind(d.body.project, d.envelope.version, d.digest, JSON.stringify(d.body), JSON.stringify(d.envelope), d.envelope.activation.seq, d.envelope.created_at, ...gp);
      }),
    ];
    await this.db.batch(stmts);
    for (const r of write.routes) {
      if (r.state !== "active") continue;
      const landed = await this.getPolicyRoute(r.repo);
      if (!landed || landed.project !== r.project)
        throw new RouteConflictError(`repository ${r.repo} is already claimed`);
    }
  }

  private async loadContext(project: string, repo: string, sha: string): Promise<ClassificationContextRow | null> {
    const row = await this.db.prepare(
      `SELECT project, canonical_repo, sha, read_head_seq, read_head_hash, policy_digest, first_producer, first_F_digest,
              first_claim_digest, classifier_profile, rollout_mode, amendment_snapshot, legacy_client_decision, created_at
       FROM classification_contexts WHERE project = ? AND canonical_repo = ? AND sha = ?`,
    ).bind(project, repo, sha).first<Omit<ClassificationContextRow, "per_path_lower">>();
    if (!row) return null;
    const { results } = await this.db.prepare(
      "SELECT path, lower_seq FROM classification_path_lowers WHERE project = ? AND canonical_repo = ? AND sha = ?",
    ).bind(project, repo, sha).all<{ path: string; lower_seq: number }>();
    const per_path_lower: Record<string, number> = {};
    for (const l of results) per_path_lower[l.path] = l.lower_seq;
    return { ...row, per_path_lower };
  }

  async getClassificationContext(project: string, canonicalRepo: string, sha: string) {
    return this.loadContext(project, canonicalRepo, sha);
  }

  async insertClassificationContextIfAbsent(row: ClassificationContextRow) {
    const ins = await this.db.prepare(
      `INSERT OR IGNORE INTO classification_contexts
       (project, canonical_repo, sha, read_head_seq, read_head_hash, policy_digest, first_producer, first_F_digest,
        first_claim_digest, classifier_profile, rollout_mode, amendment_snapshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(row.project, row.canonical_repo, row.sha, row.read_head_seq, row.read_head_hash, row.policy_digest,
      row.first_producer, row.first_F_digest, row.first_claim_digest, row.classifier_profile, row.rollout_mode,
      row.amendment_snapshot, row.created_at).run();
    const ctx = await this.loadContext(row.project, row.canonical_repo, row.sha);
    if (!ctx) throw new Error("classification context insert vanished");
    return { inserted: (ins.meta.changes ?? 0) > 0, context: ctx };
  }

  async ensureClassificationPathLowers(project: string, canonicalRepo: string, sha: string, derived: Record<string, number>) {
    const stmts = Object.entries(derived).map(([path, lower]) =>
      this.db.prepare(
        "INSERT OR IGNORE INTO classification_path_lowers (project, canonical_repo, sha, path, lower_seq) VALUES (?, ?, ?, ?, ?)",
      ).bind(project, canonicalRepo, sha, path, lower),
    );
    if (stmts.length) await this.db.batch(stmts);
    const ctx = await this.loadContext(project, canonicalRepo, sha);
    return ctx?.per_path_lower ?? {};
  }

  async setClassificationLegacyDecision(project: string, canonicalRepo: string, sha: string, decision: unknown) {
    await this.db.prepare(
      "UPDATE classification_contexts SET legacy_client_decision = ? WHERE project = ? AND canonical_repo = ? AND sha = ?",
    ).bind(JSON.stringify(decision), project, canonicalRepo, sha).run();
  }

  async getBreaker(project: string) {
    return (await this.db.prepare(
      "SELECT project, state, failures, failure_window_start, last_failure_at, opened_at, probe_lease_until, probe_lease_owner FROM classification_breakers WHERE project = ?",
    ).bind(project).first<BreakerRow>()) ?? null;
  }

  async casBreaker(expected: BreakerRow | null, next: BreakerRow) {
    if (!expected) {
      const r = await this.db.prepare(
        `INSERT OR IGNORE INTO classification_breakers (project, state, failures, failure_window_start, last_failure_at, opened_at, probe_lease_until, probe_lease_owner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(next.project, next.state, next.failures, next.failure_window_start, next.last_failure_at, next.opened_at, next.probe_lease_until, next.probe_lease_owner).run();
      return (r.meta.changes ?? 0) > 0;
    }
    const r = await this.db.prepare(
      `UPDATE classification_breakers SET state=?, failures=?, failure_window_start=?, last_failure_at=?, opened_at=?, probe_lease_until=?, probe_lease_owner=?
       WHERE project=? AND state=? AND failures=?
         AND IFNULL(opened_at,'') = IFNULL(?, '')
         AND IFNULL(probe_lease_until,'') = IFNULL(?, '')
         AND IFNULL(probe_lease_owner,'') = IFNULL(?, '')`,
    ).bind(next.state, next.failures, next.failure_window_start, next.last_failure_at, next.opened_at, next.probe_lease_until, next.probe_lease_owner,
      next.project, expected.state, expected.failures, expected.opened_at, expected.probe_lease_until, expected.probe_lease_owner).run();
    return (r.meta.changes ?? 0) > 0;
  }

  async listDrainablePendingDeliveries(nowIso: string, limit = 20) {
    const { results } = await this.db.prepare(
      `SELECT delivery_id, project, raw_body, received_at, repo, routing_source, routing_digest, routing_state,
              lease_owner, lease_until, outcomes, attempt_count, state
       FROM pending_deliveries
       WHERE IFNULL(state, '') NOT IN ('done', 'budget_failed')
         AND (lease_until IS NULL OR lease_until <= ?)
       ORDER BY received_at ASC LIMIT ?`,
    ).bind(nowIso, limit).all<PendingDelivery>();
    return results;
  }

  async updatePendingDelivery(row: PendingDelivery) {
    await this.db.prepare(
      `UPDATE pending_deliveries SET project=?, raw_body=?, repo=?, routing_source=?, routing_digest=?, routing_state=?,
              lease_owner=?, lease_until=?, outcomes=?, attempt_count=?, state=? WHERE delivery_id=?`,
    ).bind(row.project, row.raw_body, row.repo ?? null, row.routing_source ?? null, row.routing_digest ?? null,
      row.routing_state ?? null, row.lease_owner ?? null, row.lease_until ?? null, row.outcomes ?? null,
      row.attempt_count ?? 0, row.state ?? null, row.delivery_id).run();
  }
}
