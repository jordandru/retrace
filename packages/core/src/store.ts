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

export interface EventStore {
  head(project: string): Promise<{ seq: number; hash: string } | null>;
  insert(e: Event): Promise<void>;
  byIdempotencyKey(project: string, key: string): Promise<Event | null>;
  get(id: string): Promise<Event | null>;
  history(q: HistoryQuery): Promise<Event[]>;
  all(project: string): Promise<Event[]>;
  projects(): Promise<string[]>;
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
`;

/** Append an event: idempotent, sealed onto the current chain head. */
export async function appendEvent(store: EventStore, input: EventInput): Promise<{ event: Event; deduped: boolean }> {
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
