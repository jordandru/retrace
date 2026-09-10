-- Idempotent D1 schema (CREATE IF NOT EXISTS / INSERT OR IGNORE).
-- Applied by migrate.mjs via wrangler d1 execute --command (query API), not --file (import API / OAuth).
-- project_policies + policy_routes are created below (step 2 half B).

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

-- Trailer-consistency §3.5: classification index. Distinct from event_artifacts (history join by exact id).
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

-- Trailer-consistency §5.3: durable webhook deliveries. Handler does not write yet.
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

-- Hourly scheduled head checkpoints (roadmap rung 2): {signed checkpoint, Rekor witness} per moved head.
CREATE TABLE IF NOT EXISTS checkpoints (
  project TEXT NOT NULL,
  seq INTEGER NOT NULL,
  head_hash TEXT NOT NULL,
  at TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  witness TEXT,
  witness_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project, seq)
);

-- Cron-precomputed signed full exports (503 CPU-limit fix, option a): the hourly cron stores the exact bundle JSON
-- in ordered chunks (D1 caps a single value ~2MB); the request path serves stored bytes instead of rebuilding.
CREATE TABLE IF NOT EXISTS export_cache (
  project TEXT NOT NULL,
  chunk INTEGER NOT NULL,
  head_seq INTEGER NOT NULL,
  head_hash TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  total_chunks INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (project, chunk)
);

-- One-time backfill of event_artifact_index from existing events. Idempotent (INSERT OR IGNORE).
-- artifact_key is the event's artifact id, which is core artifactKey() (sameArtifact's comparison identity).
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

-- Existing DBs created by half A lack routing columns on pending_deliveries.
ALTER TABLE pending_deliveries ADD COLUMN repo TEXT;
ALTER TABLE pending_deliveries ADD COLUMN routing_source TEXT;
ALTER TABLE pending_deliveries ADD COLUMN routing_digest TEXT;
ALTER TABLE pending_deliveries ADD COLUMN routing_state TEXT;

