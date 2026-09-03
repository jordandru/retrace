/**
 * Precomputed full-export cache — the 503 CPU-limit fix, option (a).
 *
 * A full export re-does O(n) work per request (parse every event, hash the whole chain, assemble ~MBs of JSON,
 * Ed25519-sign it); at ~1.5k events that sits at the Worker's per-request CPU cap and tips into Cloudflare error
 * 1102 under load. The scheduled cron has a far larger CPU budget, and it already visits every opted-in project
 * hourly — so it builds and signs the bundle ONCE per moved head and stores the exact JSON; the request path then
 * serves stored bytes, O(1) CPU.
 *
 * Staleness is honest by construction: a cached bundle is a complete, signed, offline-verifiable full export as of
 * its own generated_at — exactly what a checkpoint comparison expects — and the serving layer labels how far behind
 * the live head it is. Portable: no runtime APIs beyond what buildExportBundle already uses.
 */
import { buildExportBundle, ExportBundle, ExportOptions } from "./export.js";
import { EventStore } from "./store.js";

export interface CachedExport {
  project: string;
  /** the head the cached bundle claims (bundle.chain.total_events - 1 / head_hash) — compared against the live head */
  head_seq: number;
  head_hash: string;
  generated_at: string;
  /** the exact JSON served to clients — stored verbatim so the signature covers what readers download */
  bundle_json: string;
}

export interface ExportCacheStore {
  get(project: string): Promise<CachedExport | null>;
  put(entry: CachedExport): Promise<void>;
}

export interface RefreshResult {
  project: string;
  action: "unchanged" | "refreshed" | "skipped" | "failed";
  head_seq?: number;
  error?: string;
}

/**
 * One scheduled pass: rebuild the cached bundle for every project whose head no longer matches its cache entry.
 * `build` is supplied by the host (the Worker passes its signing key and producer list) so the cached bundle is
 * byte-equivalent to what the live route would have produced. A failure on one project never blocks the others.
 */
export async function refreshExportCache(
  store: EventStore,
  cache: ExportCacheStore,
  projects: readonly string[],
  build: (project: string) => Promise<ExportBundle>,
): Promise<RefreshResult[]> {
  const results: RefreshResult[] = [];
  for (const project of new Set(projects)) {
    try {
      const head = await store.head(project);
      if (!head) {
        results.push({ project, action: "skipped" });
        continue;
      }
      const cached = await cache.get(project);
      if (cached && cached.head_seq === head.seq && cached.head_hash === head.hash) {
        results.push({ project, action: "unchanged" });
        continue;
      }
      const bundle = await build(project);
      const total = bundle.chain?.total_events ?? 0;
      if (!bundle.chain?.head_hash || total < 1) {
        results.push({ project, action: "skipped" });
        continue;
      }
      await cache.put({
        project,
        // record what the BUNDLE claims, not what we read a moment ago — the head may move mid-build, and the
        // cache's promise is "this JSON is a valid full export as of its own claim", never "this is current".
        head_seq: total - 1,
        head_hash: bundle.chain.head_hash,
        generated_at: bundle.generated_at,
        bundle_json: JSON.stringify(bundle),
      });
      results.push({ project, action: "refreshed", head_seq: total - 1 });
    } catch (e) {
      results.push({ project, action: "failed", error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
  return results;
}

/** Convenience for hosts that build with a fixed key/producer set (the Worker's scheduled handler). */
export function exportBuilder(store: EventStore, opts: ExportOptions): (project: string) => Promise<ExportBundle> {
  return (project) => buildExportBundle(store, { project }, opts);
}
