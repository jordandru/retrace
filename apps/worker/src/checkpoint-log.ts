import { CheckpointLogStore, CheckpointLogRow } from "@retrace-dev/core";

/** D1-backed log for the hourly checkpoint cron (see core runCheckpointCron). INSERT OR REPLACE lets a successful
 *  witness retry replace the failed state for the same head; the (project, seq) primary key also means a rewritten head at the same seq overwrites its row —
 *  which is fine, because the previous row's witness already lives in Rekor, where nothing overwrites anything. */
export class D1CheckpointLog implements CheckpointLogStore {
  constructor(private db: D1Database) {}
  async latest(project: string) {
    const row = await this.db.prepare("SELECT seq, head_hash, witness IS NOT NULL AS witnessed FROM checkpoints WHERE project = ? ORDER BY seq DESC LIMIT 1").bind(project).first<{ seq: number; head_hash: string; witnessed: number }>();
    return row ? { seq: row.seq, head_hash: row.head_hash, witnessed: row.witnessed === 1 } : null;
  }
  async save(r: CheckpointLogRow) {
    await this.db
      .prepare("INSERT OR REPLACE INTO checkpoints (project, seq, head_hash, at, checkpoint, witness, witness_error) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(r.project, r.seq, r.head_hash, r.at, r.checkpoint, r.witness, r.witness_error ?? null)
      .run();
  }
}
