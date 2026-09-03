import { CachedExport, ExportCacheStore } from "@retrace-dev/core";

/** D1 rows cap strings around 2MB and the retrace bundle already exceeds that, so the cached JSON is stored in
 *  ordered chunks. put() replaces a project's chunks in one atomic batch; get() re-validates that every chunk
 *  belongs to the same head and that none are missing before serving — a torn or half-replaced cache reads as
 *  absent, never as a corrupt bundle. */
const CHUNK_CHARS = 900_000;

export class D1ExportCache implements ExportCacheStore {
  constructor(private db: D1Database) {}

  async get(project: string): Promise<CachedExport | null> {
    const { results } = await this.db
      .prepare("SELECT chunk, head_seq, head_hash, generated_at, total_chunks, data FROM export_cache WHERE project = ? ORDER BY chunk")
      .bind(project)
      .all<{ chunk: number; head_seq: number; head_hash: string; generated_at: string; total_chunks: number; data: string }>();
    if (!results?.length) return null;
    const first = results[0];
    const consistent =
      results.length === first.total_chunks &&
      results.every((r, i) => r.chunk === i && r.head_seq === first.head_seq && r.head_hash === first.head_hash && r.total_chunks === first.total_chunks);
    if (!consistent) return null;
    return {
      project,
      head_seq: first.head_seq,
      head_hash: first.head_hash,
      generated_at: first.generated_at,
      bundle_json: results.map((r) => r.data).join(""),
    };
  }

  async put(e: CachedExport): Promise<void> {
    const chunks: string[] = [];
    for (let i = 0; i < e.bundle_json.length; i += CHUNK_CHARS) chunks.push(e.bundle_json.slice(i, i + CHUNK_CHARS));
    await this.db.batch([
      this.db.prepare("DELETE FROM export_cache WHERE project = ?").bind(e.project),
      ...chunks.map((data, i) =>
        this.db
          .prepare("INSERT INTO export_cache (project, chunk, head_seq, head_hash, generated_at, total_chunks, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(e.project, i, e.head_seq, e.head_hash, e.generated_at, chunks.length, data),
      ),
    ]);
  }
}
