import { CheckpointLogStore, CheckpointLogRow } from "@retrace-dev/core";

/** D1-backed log for the hourly checkpoint cron (see core runCheckpointCron). INSERT OR REPLACE keeps a re-run of the
 *  same head idempotent; the (project, seq) primary key means a rewritten head at the same seq overwrites its row —
 *  which is fine, because the previous row's witness already lives in Rekor, where nothing overwrites anything. */
export class D1CheckpointLog implements CheckpointLogStore {
  constructor(private db: D1Database) {}
  async latest(project: string) {
    const row = await this.db.prepare("SELECT seq, head_hash FROM checkpoints WHERE project = ? ORDER BY seq DESC LIMIT 1").bind(project).first<{ seq: number; head_hash: string }>();
    return row ?? null;
  }
  async save(r: CheckpointLogRow) {
    await this.db
      .prepare("INSERT OR REPLACE INTO checkpoints (project, seq, head_hash, at, checkpoint, witness, witness_error) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(r.project, r.seq, r.head_hash, r.at, r.checkpoint, r.witness, r.witness_error ?? null)
      .run();
  }
}
