/**
 * Storage interface — implemented by SQLite (MCP server) and D1 (Worker).
 * SQL schema shared by both lives in SCHEMA_SQL.
 */
import { Event, EventInput } from "./schema.js";
import { sealEvent, verifyChain, VerifyResult } from "./chain.js";

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
  insert(e: Event): Promise<void>;
  byIdempotencyKey(project: string, key: string): Promise<Event | null>;
  get(id: string): Promise<Event | null>;
  history(q: HistoryQuery): Promise<Event[]>;
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
}

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
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  artifact_id TEXT,
  label TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  created_by TEXT
);
`;

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
  return undefined;
}

/** Append an event: idempotent, sealed onto the current chain head. */
export async function appendEvent(store: EventStore, input: EventInput): Promise<{ event: Event; deduped: boolean }> {
  const reserved = adapterIdempotencyError(input);
  if (reserved) throw new AdapterIdempotencyError(reserved);
  if (input.idempotency_key) {
    const existing = await store.byIdempotencyKey(input.project, input.idempotency_key);
    if (existing) return { event: existing, deduped: true };
  }
  const head = await store.head(input.project);
  const event = await sealEvent(input, head);
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
  const seen = new Set<string>();
  while (cur && chain.length < maxDepth && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.caused_by ? await store.get(cur.caused_by) : null;
  }
  return chain;
}
