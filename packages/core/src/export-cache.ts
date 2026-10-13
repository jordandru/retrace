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
import { ExportByteSink, StreamedFullExport, StreamingExportOptions } from "./export-stream.js";

export interface CachedExport {
  project: string;
  /** the head the cached bundle claims (bundle.chain.total_events - 1 / head_hash) — compared against the live head */
  head_seq: number;
  head_hash: string;
  generated_at: string;
  /** the exact JSON served to clients — stored verbatim so the signature covers what readers download */
  bundle_json: string;
}

export type CachedExportMeta = Omit<CachedExport, "bundle_json">;

/** A cached export as `get` returns it: the stored JSON whole, or, from a store that streams, its UTF-8 bytes as a
 *  stream with their exact count, so that serving never holds the export in memory (export-cache handoff §4f). */
export type CachedExportRead = CachedExport | (CachedExportMeta & { body: ReadableStream<Uint8Array>; bytes: number });

export interface ExportCacheStore {
  get(project: string): Promise<CachedExportRead | null>;
  put(entry: CachedExport): Promise<void>;
  meta?(project: string): Promise<CachedExportMeta | null>;
  delete?(project: string): Promise<boolean>;
  /** Writes a new entry of exactly `bytes` bytes, produced by `write`. A throw from `write`, or any other length,
   *  leaves the old entry in place. */
  putStream?(entry: CachedExportMeta, bytes: number, write: (sink: ExportByteSink) => Promise<void>): Promise<void>;
}

/** Absent cache is null; a torn/inconsistent chunk set must throw this instead of looking like a miss. */
export class TornExportCacheError extends Error {
  readonly torn = true as const;
  constructor(project: string) {
    super(`export cache for project "${project}" is torn (inconsistent chunks)`);
    this.name = "TornExportCacheError";
  }
}

export interface RefreshResult {
  project: string;
  action: "unchanged" | "refreshed" | "skipped" | "failed";
  head_seq?: number;
  error?: string;
}

export interface ExportCacheLastRefresh {
  attempted_at: string;
  /** `started`: a build began at `attempted_at` and has not recorded its outcome. It is not a success: a run the
   *  runtime ends during the build leaves it, and `last_ok_at` still names the last success. */
  result: RefreshResult["action"] | "started";
  error?: string;
  last_ok_at?: string;
}

export interface ExportCacheStatus {
  state: "hit" | "stale" | "miss" | "unavailable";
  cached_head_seq?: number;
  cached_generated_at?: string;
  age_seconds?: number;
  live_head_seq?: number;
  last_refresh?: ExportCacheLastRefresh;
}

export async function readExportCacheStatus(
  project: string,
  liveHead: { seq: number; hash: string } | null,
  cache: ExportCacheStore,
  readLastRefresh: ((project: string) => Promise<ExportCacheLastRefresh | null>) | undefined,
  now = new Date(),
): Promise<ExportCacheStatus> {
  const live = liveHead ? { live_head_seq: liveHead.seq } : {};
  try {
    if (!readLastRefresh) throw new Error("export cache refresh status reader is not configured");
    const [cached, lastRefresh] = await Promise.all([cachedExportMeta(cache, project), readLastRefresh(project)]);
    const refresh = lastRefresh ? { last_refresh: lastRefresh } : {};
    if (!cached) return { state: "miss", ...live, ...refresh };
    const generatedAt = Date.parse(cached.generated_at);
    if (!Number.isFinite(generatedAt)) throw new Error("export cache generated_at is invalid");
    return {
      state: liveHead && liveHead.seq === cached.head_seq && liveHead.hash === cached.head_hash ? "hit" : "stale",
      cached_head_seq: cached.head_seq,
      cached_generated_at: cached.generated_at,
      age_seconds: Math.max(0, Math.floor((now.getTime() - generatedAt) / 1000)),
      ...live,
      ...refresh,
    };
  } catch {
    return { state: "unavailable", ...live };
  }
}

/** The cached entry's claim, read through `meta` (an R2 head) when the store has it, so that deciding never downloads
 *  the export (export-cache handoff §4a); otherwise through `get`, cancelling a streamed body unread. */
export async function cachedExportMeta(cache: ExportCacheStore, project: string): Promise<CachedExportMeta | null> {
  if (cache.meta) return cache.meta(project);
  const entry = await cache.get(project);
  if (!entry) return null;
  if ("body" in entry) await entry.body.cancel().catch(() => {});
  return { project: entry.project, head_seq: entry.head_seq, head_hash: entry.head_hash, generated_at: entry.generated_at };
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
      const cached = await cachedExportMeta(cache, project);
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

export interface StreamingRefreshOptions extends StreamingExportOptions {
  /** Called before a project's build starts (the Worker records `started`). The host's hook logs its own failures. */
  onStart?: (project: string) => Promise<void>;
  /** Called with each project's result as soon as it is known (the Worker records it). */
  onResult?: (result: RefreshResult) => Promise<void>;
}

/**
 * `refreshExportCache` for a store that streams: each moved project's export is built and signed by
 * `StreamedFullExport` straight into `cache.putStream`, in memory bounded by a page of events. The cache records the
 * bundle's own claim, as `refreshExportCache` does. A failure on one project never blocks the others, and a failed
 * build leaves the old entry.
 */
export async function refreshExportCacheStream(
  store: EventStore,
  cache: ExportCacheStore,
  projects: readonly string[],
  opts: StreamingRefreshOptions,
): Promise<RefreshResult[]> {
  const results: RefreshResult[] = [];
  for (const project of new Set(projects)) {
    let result: RefreshResult;
    try {
      if (!cache.putStream) throw new Error("export cache store cannot write a stream");
      const head = await store.head(project);
      const cached = head ? await cachedExportMeta(cache, project) : null;
      if (!head) result = { project, action: "skipped" };
      else if (cached && cached.head_seq === head.seq && cached.head_hash === head.hash) result = { project, action: "unchanged" };
      else {
        await opts.onStart?.(project);
        const plan = await StreamedFullExport.plan(store, project, opts);
        if (!plan.head_hash || plan.total_events < 1) result = { project, action: "skipped" };
        else {
          const head_seq = plan.total_events - 1;
          await cache.putStream({ project, head_seq, head_hash: plan.head_hash, generated_at: plan.generated_at }, plan.bytes, (sink) => plan.write(sink));
          result = { project, action: "refreshed", head_seq };
        }
      }
    } catch (e) {
      result = { project, action: "failed", error: String((e as Error)?.message ?? e).slice(0, 200) };
    }
    results.push(result);
    await opts.onResult?.(result);
  }
  return results;
}
