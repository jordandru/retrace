import { Event, EventStore, HistoryQuery, Share } from "@retrace/core";

export class D1Store implements EventStore {
  constructor(private db: D1Database) {}

  async head(project: string) {
    const row = await this.db.prepare("SELECT seq, hash FROM events WHERE project = ? ORDER BY seq DESC LIMIT 1").bind(project).first<{ seq: number; hash: string }>();
    return row ?? null;
  }

  async insert(e: Event) {
    const stmts = [
      this.db
        .prepare(
          `INSERT INTO events (id, project, seq, timestamp, received_at, actor_type, actor_id, action, caused_by, idempotency_key, prev_hash, hash, body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(e.id, e.project, e.seq, e.timestamp, e.received_at, e.actor.type, e.actor.id, e.action, e.caused_by ?? null, e.idempotency_key ?? null, e.prev_hash, e.hash, JSON.stringify(e)),
      ...e.artifacts.map((a) => this.db.prepare("INSERT OR IGNORE INTO event_artifacts (event_id, project, artifact_id) VALUES (?, ?, ?)").bind(e.id, e.project, a.id)),
    ];
    await this.db.batch(stmts); // batch is atomic in D1
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

  async history(q: HistoryQuery) {
    const where: string[] = ["e.project = ?"];
    const params: (string | number)[] = [q.project];
    let join = "";
    if (q.artifact_id) { join = "JOIN event_artifacts ea ON ea.event_id = e.id"; where.push("ea.artifact_id = ?"); params.push(q.artifact_id); }
    if (q.actor_id) { where.push("e.actor_id = ?"); params.push(q.actor_id); }
    if (q.actor_type) { where.push("e.actor_type = ?"); params.push(q.actor_type); }
    if (q.action) { where.push("e.action = ?"); params.push(q.action); }
    if (q.since) { where.push("e.timestamp >= ?"); params.push(q.since); }
    if (q.until) { where.push("e.timestamp <= ?"); params.push(q.until); }
    if (q.text) { where.push("e.body LIKE ?"); params.push(`%${q.text}%`); }
    const limit = Math.min(q.limit ?? 100, 100000);
    const sql = `SELECT DISTINCT e.body, e.seq FROM events e ${join} WHERE ${where.join(" AND ")} ORDER BY e.seq ASC LIMIT ${limit}`;
    const { results } = await this.db.prepare(sql).bind(...params).all<{ body: string }>();
    return results.map((r) => JSON.parse(r.body) as Event);
  }
}
