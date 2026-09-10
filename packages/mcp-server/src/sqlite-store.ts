/** Local SQLite store using Node's built-in node:sqlite (Node >= 22.13). No native deps. */
import { DatabaseSync } from "node:sqlite";
import {
  ArtifactIndexQuery, ArtifactIndexResult, BACKFILL_ARTIFACT_INDEX_SQL, ChainHead, Event, EventStore, HeadMovedError,
  HistoryQuery, HistoryPage, PendingDelivery, SCHEMA_PENDING_ROUTE_COLUMNS_SQL, SCHEMA_SQL, Share, artifactIndexRows, clampHistoryLimit,
  eventsReferencingArtifactsSql, historyPageFromNewestFirst, likeContains,
} from "@retrace-dev/core";
import type { PolicyRouteRow, PolicySnapshot, PolicyWrite } from "@retrace-dev/core";
import { policyDocumentFromRow } from "@retrace-dev/core";

export class SqliteStore implements EventStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA_SQL);
    for (const sql of SCHEMA_PENDING_ROUTE_COLUMNS_SQL) {
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
    const tables = ["events", "event_artifacts", "event_artifact_index", "pending_deliveries", "shares", "project_policies"];
    this.db.exec("BEGIN");
    try {
      const head = this.headSync(project); // synchronous: the transaction never yields between check and deletes
      if (!head || head.seq !== expectedHead.seq || head.hash !== expectedHead.hash) throw new HeadMovedError(project, expectedHead);
      const counts = Object.fromEntries(tables.map((t) => [t, Number(this.db.prepare(`DELETE FROM ${t} WHERE project = ?`).run(project).changes)]));
      this.db.prepare("DELETE FROM policy_routes WHERE project = ?").run(project);
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
    this.db.prepare(
      "INSERT OR REPLACE INTO pending_deliveries (delivery_id, project, raw_body, received_at, repo, routing_source, routing_digest, routing_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(row.delivery_id, row.project, row.raw_body, row.received_at, row.repo ?? null, row.routing_source ?? null, row.routing_digest ?? null, row.routing_state ?? null);
  }

  async listPendingDeliveriesOlderThan(received_at: string): Promise<PendingDelivery[]> {
    return this.db.prepare(
      "SELECT delivery_id, project, raw_body, received_at, repo, routing_source, routing_digest, routing_state FROM pending_deliveries WHERE received_at < ? ORDER BY received_at ASC",
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

  async readPolicySnapshot(project: string, U?: number): Promise<PolicySnapshot> {
    const events = await this.all(project);
    const u = U ?? (events.at(-1)?.seq ?? -1);
    const slice = events.filter((e) => e.seq <= u);
    return { U: u, events: slice, activations: slice.filter((e) => (e.idempotency_key ?? "").startsWith("policy:")) };
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
}
