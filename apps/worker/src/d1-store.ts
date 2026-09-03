import { ChainHead, Event, EventStore, HeadMovedError, HistoryQuery, HistoryPage, Share, clampHistoryLimit, historyPageFromNewestFirst, likeContains } from "@retrace-dev/core";

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
    const tables = ["events", "event_artifacts", "shares", "checkpoints", "export_cache"];
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
}
