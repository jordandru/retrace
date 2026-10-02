import type { ExportCacheLastRefresh, RefreshResult } from "@retrace-dev/core";

export async function readExportCacheLastRefresh(db: D1Database, project: string): Promise<ExportCacheLastRefresh | null> {
  const row = await db.prepare(
    "SELECT attempted_at, result, error, last_ok_at FROM export_cache_refresh WHERE project = ?",
  ).bind(project).first<{ attempted_at: string; result: RefreshResult["action"]; error: string | null; last_ok_at: string | null }>();
  if (!row) return null;
  return {
    attempted_at: row.attempted_at,
    result: row.result,
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.last_ok_at === null ? {} : { last_ok_at: row.last_ok_at }),
  };
}

export async function recordExportCacheRefreshResults(
  db: D1Database,
  results: readonly RefreshResult[],
  attemptedAt = new Date().toISOString(),
): Promise<void> {
  for (const result of results) {
    try {
      await db.prepare(`
        INSERT INTO export_cache_refresh (project, attempted_at, result, head_seq, error, last_ok_at)
        VALUES (?, ?, ?, ?, ?, CASE WHEN ? IN ('refreshed', 'unchanged') THEN ? ELSE NULL END)
        ON CONFLICT(project) DO UPDATE SET
          attempted_at = excluded.attempted_at,
          result = excluded.result,
          head_seq = excluded.head_seq,
          error = excluded.error,
          last_ok_at = CASE
            WHEN excluded.result IN ('refreshed', 'unchanged') THEN excluded.attempted_at
            ELSE export_cache_refresh.last_ok_at
          END
      `).bind(
        result.project,
        attemptedAt,
        result.action,
        result.head_seq ?? null,
        result.error ?? null,
        result.action,
        attemptedAt,
      ).run();
    } catch (error) {
      console.error(
        `export cache refresh status write failed for ${result.project}:`,
        String((error as Error)?.message ?? error),
      );
    }
  }
}
