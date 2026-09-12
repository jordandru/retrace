/** Local SQLite store using Node's built-in node:sqlite (Node >= 22.13). No native deps. */
import { DatabaseSync } from "node:sqlite";
import {
  ArtifactIndexQuery, ArtifactIndexResult, BACKFILL_ARTIFACT_INDEX_SQL, ChainHead, Event, EventStore, HeadMovedError,
  HistoryQuery, HistoryPage, PendingDelivery, SCHEMA_PENDING_LEASE_COLUMNS_SQL, SCHEMA_PENDING_ROUTE_COLUMNS_SQL, SCHEMA_SQL, Share, artifactIndexRows, clampHistoryLimit,
  eventsReferencingArtifactsSql, historyPageFromNewestFirst, likeContains,
} from "@retrace-dev/core";
import type { BreakerRow, ClassificationContextRow, PolicyRouteRow, PolicySnapshot, PolicySnapshotBudget, PolicyWrite } from "@retrace-dev/core";
import { assertRouteWriteConsistent, policyDocumentFromRow, policySnapshotFromIndex, sameBreaker } from "@retrace-dev/core";

export class SqliteStore implements EventStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA_SQL);
    for (const sql of SCHEMA_PENDING_ROUTE_COLUMNS_SQL) {
      try { this.db.exec(sql); } catch { /* column already present */ }
    }
    for (const sql of SCHEMA_PENDING_LEASE_COLUMNS_SQL) {
      try { this.db.exec(sql); } catch { /* column already present */ }
    }
    this.backfillArtifactIndexOnce();
  }

  /** One-time: if events exist and the §3.5 index is empty, populate it from stored bodies. */
  private backfillArtifactIndexOnce() {
    const events = Number((this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n);
    const indexed = Number((this.db.prepare("SELECT COUNT(*) AS n FROM event_artifact_index").get() as { n: number }).n);
    if (events === 0 || indexed > 0) return;
    this.db.exec(BACKFILL_ARTIFACT_INDEX_SQL);
  }

  private headSync(project: string): ChainHead | null {
    const row = this.db.prepare("SELECT seq, hash FROM events WHERE project = ? ORDER BY seq DESC LIMIT 1").get(project) as ChainHead | undefined;
    return row ?? null;
  }

  async head(project: string) {
    return this.headSync(project);
  }

  /** Raw row writes for one event — caller owns the transaction. */
  private insertRows(e: Event) {
    const ins = this.db.prepare(
      `INSERT INTO events (id, project, seq, timestamp, received_at, actor_type, actor_id, action, caused_by, idempotency_key, prev_hash, hash, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insArt = this.db.prepare("INSERT OR IGNORE INTO event_artifacts (event_id, project, artifact_id) VALUES (?, ?, ?)");
    const insIdx = this.db.prepare(
      "INSERT OR IGNORE INTO event_artifact_index (project, artifact_key, seq, actor_type, actor_id, role, sealed_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    ins.run(e.id, e.project, e.seq, e.timestamp, e.received_at, e.actor.type, e.actor.id, e.action, e.caused_by ?? null, e.idempotency_key ?? null, e.prev_hash, e.hash, JSON.stringify(e));
    for (const a of e.artifacts) insArt.run(e.id, e.project, a.id);
    for (const r of artifactIndexRows(e)) insIdx.run(r.project, r.artifact_key, r.seq, r.actor_type, r.actor_id, r.role, r.sealed_by);
  }

  async insert(e: Event) {
    this.db.exec("BEGIN");
    try {
      this.insertRows(e);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Deletes + audit insert in one transaction (B3); the local server's DELETE /projects/:p needs this. The head
   *  check runs inside the same transaction, so the audit can only ever commit against the head it describes. */
  async deleteProject(project: string, audit: Event, expectedHead: ChainHead) {
    const tables = ["events", "event_artifacts", "event_artifact_index", "pending_deliveries", "shares", "project_policies", "classification_contexts", "classification_path_lowers", "classification_breakers"];
    this.db.exec("BEGIN");
    try {
      const head = this.headSync(project); // synchronous: the transaction never yields between check and deletes
      if (!head || head.seq !== expectedHead.seq || head.hash !== expectedHead.hash) throw new HeadMovedError(project, expectedHead);
      const counts = Object.fromEntries(tables.map((t) => [t, Number(this.db.prepare(`DELETE FROM ${t} WHERE project = ?`).run(project).changes)]));
      this.insertRows(audit);
      this.db.exec("COMMIT");
      return counts;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async createShare(s: Share) {
    this.db.prepare("INSERT INTO shares (id, project, artifact_id, label, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(s.id, s.project, s.artifact_id ?? null, s.label ?? null, s.created_at, s.expires_at ?? null, s.created_by ?? null);
  }
  async getShare(id: string) {
    const r = this.db.prepare("SELECT * FROM shares WHERE id = ?").get(id) as any;
    if (!r) return null;
    return { id: r.id, project: r.project, artifact_id: r.artifact_id ?? undefined, label: r.label ?? undefined, created_at: r.created_at, expires_at: r.expires_at ?? undefined, created_by: r.created_by ?? undefined } as Share;
  }
  async deleteShare(id: string) {
    const r = this.db.prepare("DELETE FROM shares WHERE id = ?").run(id);
    return r.changes > 0;
  }

  async byIdempotencyKey(project: string, key: string) {
    const row = this.db.prepare("SELECT body FROM events WHERE project = ? AND idempotency_key = ? LIMIT 1").get(project, key) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Event) : null;
  }

  async get(id: string) {
    const row = this.db.prepare("SELECT body FROM events WHERE id = ?").get(id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Event) : null;
  }

  async all(project: string) {
    const rows = this.db.prepare("SELECT body FROM events WHERE project = ? ORDER BY seq ASC").all(project) as { body: string }[];
    return rows.map((r) => JSON.parse(r.body) as Event);
  }

  async projects() {
    const rows = this.db.prepare("SELECT DISTINCT project FROM events ORDER BY project").all() as { project: string }[];
    return rows.map((r) => r.project);
  }

  async history(q: HistoryQuery): Promise<HistoryPage> {
    const where: string[] = ["e.project = ?"];
    const params: (string | number)[] = [q.project];
    let join = "";
    if (q.artifact_id) {
      join = "JOIN event_artifacts ea ON ea.event_id = e.id";
      where.push("ea.artifact_id = ?");
      params.push(q.artifact_id);
    }
    if (q.actor_id) { where.push("e.actor_id = ?"); params.push(q.actor_id); }
    if (q.actor_type) { where.push("e.actor_type = ?"); params.push(q.actor_type); }
    if (q.action) { where.push("e.action = ?"); params.push(q.action); }
    if (q.since) { where.push("e.timestamp >= ?"); params.push(q.since); }
    if (q.until) { where.push("e.timestamp <= ?"); params.push(q.until); }
    if (q.text) { const like = likeContains(q.text); where.push(like.sql); params.push(like.pattern); }
    if (typeof q.before_seq === "number" && Number.isFinite(q.before_seq)) { where.push("e.seq < ?"); params.push(q.before_seq); }
    const limit = clampHistoryLimit(q.limit);
    const sql = `SELECT DISTINCT e.body, e.seq FROM events e ${join} WHERE ${where.join(" AND ")} ORDER BY e.seq DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit + 1) as { body: string }[];
    return historyPageFromNewestFirst(rows.map((r) => JSON.parse(r.body) as Event), limit);
  }

  async eventsReferencingArtifacts(q: ArtifactIndexQuery, now: () => number = Date.now): Promise<ArtifactIndexResult> {
    if (now() >= q.deadline) return { ok: false, reason: "deadline" };
    if (!q.artifact_keys.length) return { ok: true, events: [] };
    try {
      const { sql, params } = eventsReferencingArtifactsSql(q);
      const rows = this.db.prepare(sql).all(...params) as { body: string }[];
      if (now() >= q.deadline) return { ok: false, reason: "deadline" };
      if (rows.length > q.row_cap) return { ok: false, reason: "budget" };
      const seen = new Set<string>();
      const events: Event[] = [];
      for (const r of rows) {
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
      this.db.prepare(
        "INSERT INTO pending_deliveries (delivery_id, project, raw_body, received_at, repo, routing_source, routing_digest, routing_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(row.delivery_id, row.project, row.raw_body, row.received_at, row.repo ?? null, row.routing_source ?? null, row.routing_digest ?? null, row.routing_state ?? null);
    } catch (e: unknown) {
      if (!/UNIQUE/i.test(String((e as Error)?.message))) throw e;
    }
  }

  async getPendingDelivery(delivery_id: string): Promise<PendingDelivery | null> {
    return (this.db.prepare(
      `SELECT delivery_id, project, raw_body, received_at, repo, routing_source, routing_digest, routing_state,
              lease_owner, lease_until, outcomes, attempt_count, state
       FROM pending_deliveries WHERE delivery_id = ?`,
    ).get(delivery_id) as PendingDelivery | undefined) ?? null;
  }

  async listPendingDeliveriesOlderThan(received_at: string): Promise<PendingDelivery[]> {
    return this.db.prepare(
      `SELECT delivery_id, project, raw_body, received_at, repo, routing_source, routing_digest, routing_state,
              lease_owner, lease_until, outcomes, attempt_count, state
       FROM pending_deliveries WHERE received_at < ? ORDER BY received_at ASC`,
    ).all(received_at) as unknown as PendingDelivery[];
  }

  async deletePendingDelivery(delivery_id: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM pending_deliveries WHERE delivery_id = ?").run(delivery_id).changes > 0;
  }

  async getPolicy(project: string, lookup: { digest?: string; version?: number; current?: boolean } = { current: true }) {
    let row: { body: string; envelope: string; digest: string } | undefined;
    if (lookup.digest) {
      row = this.db.prepare("SELECT body, envelope, digest FROM project_policies WHERE project = ? AND digest = ?").get(project, lookup.digest) as typeof row;
    } else if (lookup.version !== undefined) {
      row = this.db.prepare("SELECT body, envelope, digest FROM project_policies WHERE project = ? AND version = ?").get(project, lookup.version) as typeof row;
    } else {
      row = this.db.prepare("SELECT body, envelope, digest FROM project_policies WHERE project = ? ORDER BY version DESC LIMIT 1").get(project) as typeof row;
    }
    return row ? policyDocumentFromRow(row) : null;
  }

  async listPolicies(project: string, limit = 50) {
    const rows = this.db.prepare("SELECT body, envelope, digest FROM project_policies WHERE project = ? ORDER BY version DESC LIMIT ?").all(project, limit) as { body: string; envelope: string; digest: string }[];
    return rows.map(policyDocumentFromRow);
  }

  async getPolicyRoute(repo: string) {
    return (this.db.prepare("SELECT repo, state, project, digest, activation_seq, set_at FROM policy_routes WHERE repo = ?").get(repo) as PolicyRouteRow | undefined) ?? null;
  }

  async listPolicyRoutes(project: string) {
    return this.db.prepare("SELECT repo, state, project, digest, activation_seq, set_at FROM policy_routes WHERE project = ? ORDER BY repo").all(project) as unknown as PolicyRouteRow[];
  }

  async getPolicyByActivationSeq(project: string, throughSeq: number) {
    const row = this.db.prepare("SELECT body, envelope, digest FROM project_policies WHERE project = ? AND activation_seq <= ? ORDER BY activation_seq DESC LIMIT 1").get(project, throughSeq) as { body: string; envelope: string; digest: string } | undefined;
    return row ? policyDocumentFromRow(row) : null;
  }

  async readPolicySnapshot(project: string, U?: number, budget?: PolicySnapshotBudget): Promise<PolicySnapshot> {
    const head = this.headSync(project);
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [project, expected] of Object.entries(expectedHeads)) {
        const head = this.headSync(project);
        if (expected === null) {
          if (head) throw new HeadMovedError(project, { seq: -1, hash: "none" });
        } else if (!head || head.seq !== expected.seq || head.hash !== expected.hash) {
          throw new HeadMovedError(project, expected);
        }
      }
      assertRouteWriteConsistent(
        write,
        (repo) => (this.db.prepare("SELECT repo, state, project, digest, activation_seq, set_at FROM policy_routes WHERE repo = ?").get(repo) as PolicyRouteRow | undefined) ?? null,
        (project) => {
          const row = this.db.prepare("SELECT body, envelope, digest FROM project_policies WHERE project = ? ORDER BY version DESC LIMIT 1").get(project) as { body: string; envelope: string; digest: string } | undefined;
          return row ? policyDocumentFromRow(row) : null;
        },
      );
      for (const e of write.events) this.insertRows(e);
      const insPol = this.db.prepare("INSERT INTO project_policies (project, version, digest, body, envelope, activation_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const d of write.documents) {
        insPol.run(d.body.project, d.envelope.version, d.digest, JSON.stringify(d.body), JSON.stringify(d.envelope), d.envelope.activation.seq, d.envelope.created_at);
      }
      const ups = this.db.prepare("INSERT OR REPLACE INTO policy_routes (repo, state, project, digest, activation_seq, set_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const r of write.routes) ups.run(r.repo, r.state, r.project, r.digest, r.activation_seq, r.set_at);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private loadContext(project: string, repo: string, sha: string): ClassificationContextRow | null {
    const row = this.db.prepare(
      `SELECT project, canonical_repo, sha, read_head_seq, read_head_hash, policy_digest, first_producer, first_F_digest,
              first_claim_digest, classifier_profile, rollout_mode, amendment_snapshot, legacy_client_decision, created_at
       FROM classification_contexts WHERE project = ? AND canonical_repo = ? AND sha = ?`,
    ).get(project, repo, sha) as Omit<ClassificationContextRow, "per_path_lower"> | undefined;
    if (!row) return null;
    const lowers = this.db.prepare(
      "SELECT path, lower_seq FROM classification_path_lowers WHERE project = ? AND canonical_repo = ? AND sha = ?",
    ).all(project, repo, sha) as { path: string; lower_seq: number }[];
    const per_path_lower: Record<string, number> = {};
    for (const l of lowers) per_path_lower[l.path] = l.lower_seq;
    return { ...row, per_path_lower };
  }

  async getClassificationContext(project: string, canonicalRepo: string, sha: string) {
    return this.loadContext(project, canonicalRepo, sha);
  }

  async insertClassificationContextIfAbsent(row: ClassificationContextRow) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const info = this.db.prepare(
        `INSERT OR IGNORE INTO classification_contexts
         (project, canonical_repo, sha, read_head_seq, read_head_hash, policy_digest, first_producer, first_F_digest,
          first_claim_digest, classifier_profile, rollout_mode, amendment_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.project, row.canonical_repo, row.sha, row.read_head_seq, row.read_head_hash, row.policy_digest,
        row.first_producer, row.first_F_digest, row.first_claim_digest, row.classifier_profile, row.rollout_mode,
        row.amendment_snapshot, row.created_at);
      const ctx = this.loadContext(row.project, row.canonical_repo, row.sha)!;
      this.db.exec("COMMIT");
      return { inserted: info.changes > 0, context: ctx };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async ensureClassificationPathLowers(project: string, canonicalRepo: string, sha: string, derived: Record<string, number>) {
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO classification_path_lowers (project, canonical_repo, sha, path, lower_seq) VALUES (?, ?, ?, ?, ?)",
    );
    for (const [path, lower] of Object.entries(derived)) ins.run(project, canonicalRepo, sha, path, lower);
    const ctx = this.loadContext(project, canonicalRepo, sha);
    return ctx?.per_path_lower ?? {};
  }

  async setClassificationLegacyDecision(project: string, canonicalRepo: string, sha: string, decision: unknown) {
    this.db.prepare(
      "UPDATE classification_contexts SET legacy_client_decision = ? WHERE project = ? AND canonical_repo = ? AND sha = ?",
    ).run(JSON.stringify(decision), project, canonicalRepo, sha);
  }

  async getBreaker(project: string) {
    return (this.db.prepare(
      "SELECT project, state, failures, failure_window_start, last_failure_at, opened_at, probe_lease_until, probe_lease_owner FROM classification_breakers WHERE project = ?",
    ).get(project) as BreakerRow | undefined) ?? null;
  }

  async casBreaker(expected: BreakerRow | null, next: BreakerRow) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Keep the transaction synchronous: yielding while holding BEGIN IMMEDIATE lets another
      // connection block this event loop on its own BEGIN and prevents this owner from committing.
      const cur = (this.db.prepare(
        "SELECT project, state, failures, failure_window_start, last_failure_at, opened_at, probe_lease_until, probe_lease_owner FROM classification_breakers WHERE project = ?",
      ).get(next.project) as BreakerRow | undefined) ?? null;
      if (!sameBreaker(cur, expected)) { this.db.exec("ROLLBACK"); return false; }
      this.db.prepare(
        `INSERT INTO classification_breakers (project, state, failures, failure_window_start, last_failure_at, opened_at, probe_lease_until, probe_lease_owner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project) DO UPDATE SET state=excluded.state, failures=excluded.failures, failure_window_start=excluded.failure_window_start,
           last_failure_at=excluded.last_failure_at, opened_at=excluded.opened_at, probe_lease_until=excluded.probe_lease_until, probe_lease_owner=excluded.probe_lease_owner`,
      ).run(next.project, next.state, next.failures, next.failure_window_start, next.last_failure_at, next.opened_at, next.probe_lease_until, next.probe_lease_owner);
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async listDrainablePendingDeliveries(nowIso: string, limit = 20) {
    return this.db.prepare(
      `SELECT delivery_id, project, raw_body, received_at, repo, routing_source, routing_digest, routing_state,
              lease_owner, lease_until, outcomes, attempt_count, state
       FROM pending_deliveries
       WHERE IFNULL(routing_state, '') NOT IN ('unresolved', 'pending_policy')
         AND IFNULL(state, '') NOT IN ('done', 'terminal_failure')
         AND (lease_until IS NULL OR lease_until <= ?)
       ORDER BY received_at ASC LIMIT ?`,
    ).all(nowIso, limit) as unknown as PendingDelivery[];
  }

  async claimPendingDeliveryLease(delivery_id: string, owner: string, nowIso: string, untilIso: string) {
    const changed = this.db.prepare(
      `UPDATE pending_deliveries SET lease_owner=?, lease_until=?
       WHERE delivery_id=?
         AND IFNULL(routing_state, '') NOT IN ('unresolved', 'pending_policy')
         AND IFNULL(state, '') NOT IN ('done', 'terminal_failure')
         AND (lease_until IS NULL OR lease_until <= ?)`,
    ).run(owner, untilIso, delivery_id, nowIso).changes;
    if (changed < 1) return null;
    return (this.db.prepare(
      `SELECT delivery_id, project, raw_body, received_at, repo, routing_source, routing_digest, routing_state,
              lease_owner, lease_until, outcomes, attempt_count, state
       FROM pending_deliveries WHERE delivery_id=? AND lease_owner=?`,
    ).get(delivery_id, owner) as PendingDelivery | undefined) ?? null;
  }

  async updatePendingDeliveryIfLeaseOwner(row: PendingDelivery, owner: string) {
    return this.db.prepare(
      `UPDATE pending_deliveries SET project=?, raw_body=?, repo=?, routing_source=?, routing_digest=?, routing_state=?,
              lease_owner=?, lease_until=?, outcomes=?, attempt_count=?, state=?
       WHERE delivery_id=? AND lease_owner=?`,
    ).run(row.project, row.raw_body, row.repo ?? null, row.routing_source ?? null, row.routing_digest ?? null,
      row.routing_state ?? null, row.lease_owner ?? null, row.lease_until ?? null, row.outcomes ?? null,
      row.attempt_count ?? 0, row.state ?? null, row.delivery_id, owner).changes > 0;
  }

  async updatePendingDelivery(row: PendingDelivery) {
    this.db.prepare(
      `UPDATE pending_deliveries SET project=?, raw_body=?, repo=?, routing_source=?, routing_digest=?, routing_state=?,
              lease_owner=?, lease_until=?, outcomes=?, attempt_count=?, state=? WHERE delivery_id=?`,
    ).run(row.project, row.raw_body, row.repo ?? null, row.routing_source ?? null, row.routing_digest ?? null,
      row.routing_state ?? null, row.lease_owner ?? null, row.lease_until ?? null, row.outcomes ?? null,
      row.attempt_count ?? 0, row.state ?? null, row.delivery_id);
  }
}
