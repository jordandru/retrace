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
