/**
 * Storage interface — implemented by SQLite (MCP server) and D1 (Worker).
 * SQL schema shared by both lives in SCHEMA_SQL.
 */
import { Event, EventInput } from "./schema.js";
import { sealEvent, verifyChain, VerifyResult } from "./chain.js";
import { markUntrustedText } from "./explain.js";
import { artifactKey, artifactLookup, sameArtifact } from "./capture.js";

export interface HistoryQuery {
  project: string;
  artifact_id?: string;
  actor_id?: string;
  actor_type?: string;
  action?: string;
  since?: string;
  until?: string;
  text?: string; // matches intent / action_detail / change.summary / tags
  limit?: number;
  /** Exclusive upper bound: only events with `seq < before_seq`. Walks older pages of a newest-first window. */
  before_seq?: number;
}

/** One page of history. `events` are ascending by seq; they are the *newest* `limit` matches, not genesis. */
export interface HistoryPage {
  events: Event[];
  truncated: boolean;
  /** Oldest seq in this page — pass as `before_seq` to fetch the previous (older) page. Absent when `truncated` is false. */
  next_before_seq?: number;
}

/** Max rows a history() query may return. Bound as a parameter, never interpolated (audit 2026-08-30). */
export const HISTORY_LIMIT_MAX = 100_000;
export function clampHistoryLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return 100;
  return Math.min(Math.floor(limit), HISTORY_LIMIT_MAX);
}

/** Turn newest-first rows (length `limit` or `limit+1`) into an ascending page with a truncation cursor. */
export function historyPageFromNewestFirst(newestFirst: Event[], limit: number): HistoryPage {
  const truncated = newestFirst.length > limit;
  const kept = truncated ? newestFirst.slice(0, limit) : newestFirst;
  const events = kept.slice().reverse();
  return { events, truncated, next_before_seq: truncated && events.length ? events[0].seq : undefined };
}

/** In-memory history: newest `limit` matches, ascending. Used by tests and as the spec SQL stores must match. */
export function pageHistoryNewest(events: Event[], q: HistoryQuery): HistoryPage {
  let rows = events.filter((e) => e.project === q.project);
  if (q.artifact_id) rows = rows.filter((e) => e.artifacts.some((a) => a.id === q.artifact_id));
  if (q.actor_id) rows = rows.filter((e) => e.actor.id === q.actor_id);
  if (q.actor_type) rows = rows.filter((e) => e.actor.type === q.actor_type);
  if (q.action) rows = rows.filter((e) => e.action === q.action);
  if (q.since) rows = rows.filter((e) => e.timestamp >= q.since!);
  if (q.until) rows = rows.filter((e) => e.timestamp <= q.until!);
  if (q.text) {
    const needle = q.text.toLowerCase();
    rows = rows.filter((e) => JSON.stringify(e).toLowerCase().includes(needle));
  }
  if (typeof q.before_seq === "number" && Number.isFinite(q.before_seq)) rows = rows.filter((e) => e.seq < q.before_seq!);
  rows.sort((a, b) => b.seq - a.seq);
  return historyPageFromNewestFirst(rows, clampHistoryLimit(q.limit));
}

/** Walk newest-window pages until complete. Scoped export uses this so a cap cannot omit matching events. */
export async function collectHistory(store: Pick<EventStore, "history">, q: HistoryQuery): Promise<Event[]> {
  const out: Event[] = [];
  const seen = new Set<string>();
  let before_seq = q.before_seq;
  for (let pages = 0; pages < 10_000; pages++) {
    const page = await store.history({ ...q, before_seq, limit: HISTORY_LIMIT_MAX });
    for (const e of page.events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    if (!page.truncated || page.next_before_seq === undefined) break;
    if (before_seq !== undefined && page.next_before_seq >= before_seq) break;
    before_seq = page.next_before_seq;
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/** Accept a HistoryPage or a legacy Event[] (pre-pagination Worker). An array is treated as complete (truncated: false). */
export function asHistoryPage(body: unknown): HistoryPage {
  if (Array.isArray(body)) return { events: body as Event[], truncated: false };
  if (body && typeof body === "object" && Array.isArray((body as HistoryPage).events)) {
    const p = body as HistoryPage;
    return {
      events: p.events,
      truncated: p.truncated === true,
      next_before_seq: typeof p.next_before_seq === "number" ? p.next_before_seq : undefined,
    };
  }
  throw new Error("history response was neither an event list nor a history page");
}

/** LIKE pattern for a substring search that treats % and _ as literals (audit 2026-08-30). */
export function likeContains(text: string): { sql: string; pattern: string } {
  const pattern = "%" + text.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_") + "%";
  return { sql: "e.body LIKE ? ESCAPE '!'", pattern };
}

export interface Share {
  id: string;
  project: string;
  artifact_id?: string;
  label?: string;
  created_at: string;
  expires_at?: string;
  created_by?: string;
}

export interface EventStore {
  head(project: string): Promise<ChainHead | null>;
  createShare(share: Share): Promise<void>;
  getShare(id: string): Promise<Share | null>;
  /** Owner-only share revoke (audit 2026-08-30). Optional — stores without it 501 DELETE /s/:id. */
  deleteShare?(id: string): Promise<boolean>;
  insert(e: Event): Promise<void>;
  byIdempotencyKey(project: string, key: string): Promise<Event | null>;
  get(id: string): Promise<Event | null>;
  history(q: HistoryQuery): Promise<HistoryPage>;
  all(project: string): Promise<Event[]>;
  projects(): Promise<string[]>;
  /** Delete every row belonging to a project AND insert `audit` (already sealed onto its own project's chain) in the
   *  same transaction, so a deletion can never exist without its audit record and vice versa (security review
   *  2026-08-21, B3). `expectedHead` is the target project's head the caller sealed the audit's `change` fields from:
   *  the store must check INSIDE the transaction that the head is still exactly that and throw `HeadMovedError`
   *  (committing nothing) if a write raced the delete, so the immortal audit record can never describe a head or
   *  event count other than the one actually deleted. Returns per-table deleted counts. Optional — stores without it
   *  don't serve DELETE /projects/:p. */
  deleteProject?(project: string, audit: Event, expectedHead: ChainHead): Promise<Record<string, number>>;
  /** Bounded artifact-index read (§3.5). Over budget / deadline / store error is a typed result, never a throw. */
  eventsReferencingArtifacts?(q: ArtifactIndexQuery, now?: () => number): Promise<ArtifactIndexResult>;
  insertPendingDelivery?(row: PendingDelivery): Promise<void>;
  getPendingDelivery?(delivery_id: string): Promise<PendingDelivery | null>;
  listPendingDeliveriesOlderThan?(received_at: string): Promise<PendingDelivery[]>;
  deletePendingDelivery?(delivery_id: string): Promise<boolean>;
  /** Current / digest / version lookup, constrained to `project` by the caller. */
  getPolicy?(project: string, lookup?: { digest?: string; version?: number; current?: boolean }): Promise<import("./policy.js").PolicyDocument | null>;
  listPolicies?(project: string, limit?: number): Promise<import("./policy.js").PolicyDocument[]>;
  getPolicyRoute?(repo: string): Promise<import("./policy.js").PolicyRouteRow | null>;
  listPolicyRoutes?(project: string): Promise<import("./policy.js").PolicyRouteRow[]>;
  /** Indexed: greatest activation_seq ≤ throughSeq for this project. */
  getPolicyByActivationSeq?(project: string, throughSeq: number): Promise<import("./policy.js").PolicyDocument | null>;
  readPolicySnapshot?(project: string, U?: number, budget?: import("./policy.js").PolicySnapshotBudget): Promise<import("./policy.js").PolicySnapshot>;
  /** One transaction: activation event(s) + documents + route upserts. Throws HeadMovedError if a head raced. */
  applyPolicyWrite?(write: import("./policy.js").PolicyWrite, expectedHeads: Record<string, ChainHead | null>): Promise<void>;
  /**
   * Classification context (step 3). Absent methods fail closed — never "no context".
   * RemoteStore must not stub these as empty: Worker classifies; local SQLite implements them.
   */
  getClassificationContext?(project: string, canonicalRepo: string, sha: string): Promise<import("./classify.js").ClassificationContextRow | null>;
  insertClassificationContextIfAbsent?(row: import("./classify.js").ClassificationContextRow): Promise<{ inserted: boolean; context: import("./classify.js").ClassificationContextRow }>;
  ensureClassificationPathLowers?(project: string, canonicalRepo: string, sha: string, derived: Record<string, number>): Promise<Record<string, number>>;
  setClassificationLegacyDecision?(project: string, canonicalRepo: string, sha: string, decision: unknown): Promise<void>;
  getBreaker?(project: string): Promise<import("./classify.js").BreakerRow | null>;
  casBreaker?(expected: import("./classify.js").BreakerRow | null, next: import("./classify.js").BreakerRow): Promise<boolean>;
  listDrainablePendingDeliveries?(nowIso: string, limit?: number): Promise<PendingDelivery[]>;
  updatePendingDelivery?(row: PendingDelivery): Promise<void>;
}

/** One row of the §3.5 artifact index. `event_artifacts` remains the history join table (event_id, artifact_id). */
export interface ArtifactIndexRow {
  project: string;
  artifact_key: string;
  seq: number;
  actor_type: string;
  actor_id: string;
  role: string | null;
  sealed_by: string | null;
}

export interface ArtifactIndexQuery {
  project: string;
  artifact_keys: string[];
  /** Exclusive lower bound. */
  after_seq: number;
  /** Inclusive upper bound U. */
  through_seq: number;
  row_cap: number;
  /** Absolute epoch ms. Reaching it yields `{ ok: false, reason: "deadline" }`. */
  deadline: number;
}

export const ARTIFACT_INDEX_DEFAULT_ROW_CAP = 20_000;

/** Typed result for the bounded artifact-index read. Never thrown. */
export type ArtifactIndexResult =
  | { ok: true; events: Event[] }
  | { ok: false; reason: "budget" | "deadline" | "store_error" };

export interface PendingDelivery {
  delivery_id: string;
  project: string;
  raw_body: string;
  received_at: string;
  /** Canonical repository identity pinned at receipt (§7). */
  repo?: string;
  /** policy | env | unresolved */
  routing_source?: string;
  routing_digest?: string;
  routing_state?: string;
  lease_owner?: string;
  lease_until?: string;
  outcomes?: string;
  attempt_count?: number;
  state?: string;
}

/** Index rows for one event, keyed by `artifactKey` (same comparison identity as `sameArtifact`). */
export function artifactIndexRows(e: Event): ArtifactIndexRow[] {
  const sealed = e.method?.params?.[SEALED_BY_PARAM];
  const sealed_by = typeof sealed === "string" ? sealed : null;
  const seen = new Set<string>();
  const rows: ArtifactIndexRow[] = [];
  for (const a of e.artifacts) {
    const key = artifactKey(a.id);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      project: e.project,
      artifact_key: key,
      seq: e.seq,
      actor_type: e.actor.type,
      actor_id: e.actor.id,
      role: a.role ?? null,
      sealed_by,
    });
  }
  return rows;
}

/** In-memory spec the SQL stores must match: sameArtifact matching, row cap on matching index rows. */
export function eventsReferencingArtifactKeys(events: Event[], q: ArtifactIndexQuery, nowMs: number): ArtifactIndexResult {
  if (nowMs >= q.deadline) return { ok: false, reason: "deadline" };
  if (!q.artifact_keys.length) return { ok: true, events: [] };
  const matched: Event[] = [];
  let rows = 0;
  const windowed = events
    .filter((e) => e.project === q.project && e.seq > q.after_seq && e.seq <= q.through_seq)
    .sort((a, b) => a.seq - b.seq);
  for (const e of windowed) {
    const hitKeys = new Set(
      e.artifacts.filter((a) => q.artifact_keys.some((k) => sameArtifact(artifactKey(a.id), k))).map((a) => artifactKey(a.id)),
    );
    if (!hitKeys.size) continue;
    rows += hitKeys.size;
    if (rows > q.row_cap) return { ok: false, reason: "budget" };
    matched.push(e);
  }
  return { ok: true, events: matched };
}

/** SQL predicate over `event_artifact_index` alias `i` that implements `artifactLookup` / `sameArtifact`. */
export function artifactKeyMatchSql(keys: string[]): { sql: string; params: string[] } {
  const equals = new Set<string>();
  const globs = new Set<string>();
  for (const k of keys) {
    const look = artifactLookup(k);
    for (const eq of look.equals) equals.add(eq);
    if (look.glob) globs.add(look.glob);
  }
  const parts: string[] = [];
  const params: string[] = [];
  if (equals.size) {
    parts.push(`i.artifact_key IN (${[...equals].map(() => "?").join(",")})`);
    params.push(...equals);
  }
  for (const g of globs) {
    parts.push("i.artifact_key GLOB ?");
    params.push(g);
  }
  if (!parts.length) return { sql: "0", params: [] };
  return { sql: `(${parts.join(" OR ")})`, params };
}

export function eventsReferencingArtifactsSql(q: ArtifactIndexQuery): { sql: string; params: (string | number)[] } {
  const match = artifactKeyMatchSql(q.artifact_keys);
  return {
    sql: `SELECT e.body FROM events e JOIN event_artifact_index i ON i.project = e.project AND i.seq = e.seq WHERE e.project = ? AND i.seq > ? AND i.seq <= ? AND ${match.sql} ORDER BY e.seq ASC LIMIT ?`,
    params: [q.project, q.after_seq, q.through_seq, ...match.params, q.row_cap + 1],
  };
}

/** One-time D1 backfill. `artifact_key` is the stored artifact id (`artifactKey` is that identity). Idempotent. */
export const BACKFILL_ARTIFACT_INDEX_SQL = `
INSERT OR IGNORE INTO event_artifact_index (project, artifact_key, seq, actor_type, actor_id, role, sealed_by)
SELECT
  e.project,
  json_extract(a.value, '$.id'),
  e.seq,
  e.actor_type,
  e.actor_id,
  json_extract(a.value, '$.role'),
  json_extract(e.body, '$.method.params.sealed_by')
FROM events e, json_each(COALESCE(json_extract(e.body, '$.artifacts'), '[]')) AS a
WHERE json_extract(a.value, '$.id') IS NOT NULL;
`;

export type ChainHead = { seq: number; hash: string };

/** Thrown by `deleteProject` when the target project's head no longer matches `expectedHead`: nothing was committed;
 *  re-read the head, re-seal the audit and retry. */
export class HeadMovedError extends Error {
  constructor(project: string, expected: ChainHead) {
    super(`project "${project}" was written to while being deleted (expected head ${expected.hash} seq ${expected.seq}); re-read its head and retry`);
    this.name = "HeadMovedError";
  }
}

export function isHeadMovedError(e: unknown): e is HeadMovedError {
  return e instanceof HeadMovedError || (e as any)?.name === "HeadMovedError";
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  seq INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  received_at TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  caused_by TEXT,
  idempotency_key TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  body TEXT NOT NULL,
  UNIQUE(project, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_project_ts ON events(project, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(project, actor_id);
CREATE INDEX IF NOT EXISTS idx_events_idem ON events(project, idempotency_key);
CREATE TABLE IF NOT EXISTS event_artifacts (
  event_id TEXT NOT NULL,
  project TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  PRIMARY KEY (event_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_ea_artifact ON event_artifacts(project, artifact_id);
CREATE TABLE IF NOT EXISTS event_artifact_index (
  project TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  role TEXT,
  sealed_by TEXT,
  PRIMARY KEY (project, artifact_key, seq)
);
CREATE INDEX IF NOT EXISTS idx_eai_project_key_seq ON event_artifact_index(project, artifact_key, seq);
CREATE INDEX IF NOT EXISTS idx_eai_project_seq ON event_artifact_index(project, seq);
CREATE TABLE IF NOT EXISTS pending_deliveries (
  delivery_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  raw_body TEXT NOT NULL,
  received_at TEXT NOT NULL,
  repo TEXT,
  routing_source TEXT,
  routing_digest TEXT,
  routing_state TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_deliveries_received ON pending_deliveries(received_at);
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  artifact_id TEXT,
  label TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS project_policies (
  project TEXT NOT NULL,
  version INTEGER NOT NULL,
  digest TEXT UNIQUE NOT NULL,
  body TEXT NOT NULL,
  envelope TEXT NOT NULL,
  activation_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project, version)
);
CREATE INDEX IF NOT EXISTS idx_project_policies_activation ON project_policies(project, activation_seq);
CREATE TABLE IF NOT EXISTS policy_routes (
  repo TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('active','revoked')),
  project TEXT NOT NULL,
  digest TEXT NOT NULL,
  activation_seq INTEGER NOT NULL,
  set_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_policy_routes_project ON policy_routes(project);
CREATE TABLE IF NOT EXISTS classification_contexts (
  project TEXT NOT NULL,
  canonical_repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  read_head_seq INTEGER NOT NULL,
  read_head_hash TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  first_producer TEXT NOT NULL,
  first_F_digest TEXT NOT NULL,
  first_claim_digest TEXT NOT NULL,
  classifier_profile TEXT NOT NULL,
  rollout_mode TEXT NOT NULL,
  amendment_snapshot TEXT NOT NULL DEFAULT '[]',
  legacy_client_decision TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project, canonical_repo, sha)
);
CREATE TABLE IF NOT EXISTS classification_path_lowers (
  project TEXT NOT NULL,
  canonical_repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  path TEXT NOT NULL,
  lower_seq INTEGER NOT NULL,
  PRIMARY KEY (project, canonical_repo, sha, path)
);
CREATE TABLE IF NOT EXISTS classification_breakers (
  project TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('closed','open')),
  failures INTEGER NOT NULL DEFAULT 0,
  failure_window_start TEXT,
  last_failure_at TEXT,
  opened_at TEXT,
  probe_lease_until TEXT,
  probe_lease_owner TEXT
);
`;

/** Idempotent ALTERs for DBs whose pending_deliveries table predated routing columns. */
export const SCHEMA_PENDING_ROUTE_COLUMNS_SQL = [
  "ALTER TABLE pending_deliveries ADD COLUMN repo TEXT",
  "ALTER TABLE pending_deliveries ADD COLUMN routing_source TEXT",
  "ALTER TABLE pending_deliveries ADD COLUMN routing_digest TEXT",
  "ALTER TABLE pending_deliveries ADD COLUMN routing_state TEXT",
];

/** Idempotent ALTERs for pending lease/outcome columns (step 3 drain). */
export const SCHEMA_PENDING_LEASE_COLUMNS_SQL = [
  "ALTER TABLE pending_deliveries ADD COLUMN lease_owner TEXT",
  "ALTER TABLE pending_deliveries ADD COLUMN lease_until TEXT",
  "ALTER TABLE pending_deliveries ADD COLUMN outcomes TEXT",
  "ALTER TABLE pending_deliveries ADD COLUMN attempt_count INTEGER",
  "ALTER TABLE pending_deliveries ADD COLUMN state TEXT",
];

export function newShareId(): string {
  const bytes = new Uint8Array(12);
  (globalThis as any).crypto.getRandomValues(bytes);
  return "sh_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function shareIsLive(s: Share, now: Date = new Date()): boolean {
  return !s.expires_at || new Date(s.expires_at) > now;
}

/** Thrown when a caller claims a git/Drive/GitHub idempotency prefix on an event those adapters would not emit. */
export class AdapterIdempotencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterIdempotencyError";
  }
}

/** Thrown when retrace_log (MCP) is given a caused_by the agent can fix and retry.
 *  POST /events and appendEvent do not throw this: adapters (git hook, Drive) must still seal the event. */
export class CausedByError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CausedByError";
  }
}

/** Hash-covered tag stamped when a caused_by is kept but does not pass exists/older/same-project. */
export const CAUSED_BY_UNVERIFIED_TAG = "caused_by:unverified";

/** method.params key the Worker stamps with WHO SEALED an event: "owner" (body actor stored verbatim under the owner
 *  token), "pinned:<credential>" (actor fixed by the Worker), "assert:<credential>" (actor bounded by an allow-list),
 *  "webhook:github" (HMAC-verified delivery) or "unauthenticated". Absent on events sealed by a local MCP/SQLite
 *  process or before this stamp existed. Server wins; a caller-supplied value is overwritten. */
export const SEALED_BY_PARAM = "sealed_by";
export const SEALED_BY_OWNER = "owner";
export const SEALED_BY_UNAUTHENTICATED = "unauthenticated";
export const SEALED_BY_GITHUB_WEBHOOK = "webhook:github";
/** Coarse class of a sealed_by value, for status counting. */
export function sealedByKind(v: unknown): "owner" | "pinned" | "assert" | "webhook" | "unauthenticated" | "unstamped" {
  if (typeof v !== "string" || !v) return "unstamped";
  if (v === SEALED_BY_OWNER) return "owner";
  if (v === SEALED_BY_UNAUTHENTICATED) return "unauthenticated";
  if (v.startsWith("pinned:")) return "pinned";
  if (v.startsWith("assert:")) return "assert";
  if (v.startsWith("webhook:")) return "webhook";
  return "unstamped";
}
export type CausedByProblem = "missing" | "wrong_project" | "not_older";

/** Classify a claimed parent. `not_older` is timestamp (Drive Activity can predate the current instruct). */
export function causedByProblem(
  parent: Event | null | undefined,
  input: Pick<EventInput, "caused_by" | "project" | "timestamp">,
): CausedByProblem | undefined {
  if (!input.caused_by) return undefined;
  if (!parent) return "missing";
  if (parent.project !== input.project) return "wrong_project";
  if (input.timestamp && parent.timestamp > input.timestamp) return "not_older";
  return undefined;
}

export function causedByErrorMessage(
  causedBy: string,
  problem: CausedByProblem,
  opts?: { parentProject?: string; project?: string },
): string {
  if (problem === "missing") return `caused_by ${markUntrustedText(causedBy)} does not name an event in this ledger`;
  if (problem === "wrong_project")
    return `caused_by ${markUntrustedText(causedBy)} is in project ${markUntrustedText(opts?.parentProject ?? "")}, not ${markUntrustedText(opts?.project ?? "")}`;
  return `caused_by ${markUntrustedText(causedBy)} is newer than this event`;
}

export function markCausedByUnverified(input: EventInput, problem: CausedByProblem): EventInput {
  const tags = input.tags ?? [];
  return {
    ...input,
    tags: tags.includes(CAUSED_BY_UNVERIFIED_TAG) ? tags : [...tags, CAUSED_BY_UNVERIFIED_TAG],
    method: { ...input.method, params: { ...input.method?.params, caused_by_problem: problem } },
  };
}

const GIT_IDEMPOTENCY_ACTIONS = new Set(["committed", "merged"]);

/** Adapter key namespaces (`git:` / `gd:` / `gh:`) may only be claimed by matching adapter-shaped events.
 *  Otherwise a POST /events or retrace_log can plant a key the git hook / Drive / GitHub mapper later
 *  treats as already logged (Claude 2026-08-29, store.ts appendEvent lookup). */
export function adapterIdempotencyError(input: EventInput): string | undefined {
  const k = input.idempotency_key;
  if (!k) return undefined;
  const tool = input.method?.tool ?? "";
  const tags = input.tags ?? [];
  if (k.startsWith("git:")) {
    if (tool === "git" && GIT_IDEMPOTENCY_ACTIONS.has(input.action)) return undefined;
    return 'idempotency_key prefix "git:" is reserved for the git adapter (action committed/merged, method.tool=git)';
  }
  if (k.startsWith("gd:")) {
    if (tags.includes("google-drive") || tool.startsWith("google-")) return undefined;
    return 'idempotency_key prefix "gd:" is reserved for the Drive adapter';
  }
  if (k.startsWith("gh:")) {
    if (tool.startsWith("github") || tags.includes("github")) return undefined;
    return 'idempotency_key prefix "gh:" is reserved for the GitHub adapter';
  }
  if (k.startsWith("policy:")) {
    return 'idempotency_key prefix "policy:" is reserved for policy activation (PUT /projects/:p/policy)';
  }
  return undefined;
}

/** Append an event: idempotent, sealed onto the current chain head. */
export async function appendEvent(store: EventStore, input: EventInput): Promise<{ event: Event; deduped: boolean }> {
  const reserved = adapterIdempotencyError(input);
  if (reserved) throw new AdapterIdempotencyError(reserved);
  let toSeal = input;
  if (input.caused_by) {
    const parent = await store.get(input.caused_by);
    const problem = causedByProblem(parent, input);
    // Keep the claimed link. Adapters (git hook, Drive) must not drop an event because a trailer is stale
    // or the instruct lives in another project/clone. retrace_log rejects instead (agent can retry).
    if (problem) toSeal = markCausedByUnverified(input, problem);
  }
  if (toSeal.idempotency_key) {
    const existing = await store.byIdempotencyKey(toSeal.project, toSeal.idempotency_key);
    if (existing) return { event: existing, deduped: true };
  }
  const head = await store.head(toSeal.project);
  const event = await sealEvent(toSeal, head);
  await store.insert(event);
  return { event, deduped: false };
}

export async function verifyProject(store: EventStore, project: string): Promise<VerifyResult> {
  return verifyChain(await store.all(project));
}

/** Walk caused_by links up to the root — the "why" chain. */
export async function explainEvent(store: EventStore, id: string, maxDepth = 25): Promise<Event[]> {
  const chain: Event[] = [];
  let cur = await store.get(id);
  const project = cur?.project;
  const seen = new Set<string>();
  while (cur && chain.length < maxDepth && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    const parent = cur.caused_by ? await store.get(cur.caused_by) : null;
    // A caused_by id is untrusted input. Never let a same-project query cross a project boundary.
    cur = parent?.project === project ? parent : null;
  }
  return chain;
}
