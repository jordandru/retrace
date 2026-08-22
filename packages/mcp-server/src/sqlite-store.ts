/** Local SQLite store using Node's built-in node:sqlite (Node >= 22.13). No native deps. */
import { DatabaseSync } from "node:sqlite";
import { Event, EventStore, HistoryQuery, SCHEMA_SQL, Share } from "@retrace/core";

export class SqliteStore implements EventStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA_SQL);
  }

  async head(project: string) {
    const row = this.db
      .prepare("SELECT seq, hash FROM events WHERE project = ? ORDER BY seq DESC LIMIT 1")
      .get(project) as { seq: number; hash: string } | undefined;
    return row ?? null;
  }

  /** Raw row writes for one event — caller owns the transaction. */
  private insertRows(e: Event) {
    const ins = this.db.prepare(
      `INSERT INTO events (id, project, seq, timestamp, received_at, actor_type, actor_id, action, caused_by, idempotency_key, prev_hash, hash, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insArt = this.db.prepare("INSERT OR IGNORE INTO event_artifacts (event_id, project, artifact_id) VALUES (?, ?, ?)");
    ins.run(e.id, e.project, e.seq, e.timestamp, e.received_at, e.actor.type, e.actor.id, e.action, e.caused_by ?? null, e.idempotency_key ?? null, e.prev_hash, e.hash, JSON.stringify(e));
    for (const a of e.artifacts) insArt.run(e.id, e.project, a.id);
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

  /** Deletes + audit insert in one transaction (B3); the local server's DELETE /projects/:p needs this. */
  async deleteProject(project: string, audit: Event) {
    const tables = ["events", "event_artifacts", "shares"];
    this.db.exec("BEGIN");
    try {
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

  async history(q: HistoryQuery) {
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
    if (q.text) { where.push("e.body LIKE ?"); params.push(`%${q.text}%`); }
    const limit = Math.min(q.limit ?? 100, 1000);
    const sql = `SELECT DISTINCT e.body, e.seq FROM events e ${join} WHERE ${where.join(" AND ")} ORDER BY e.seq ASC LIMIT ${limit}`;
    const rows = this.db.prepare(sql).all(...params) as { body: string }[];
    return rows.map((r) => JSON.parse(r.body) as Event);
  }
}
