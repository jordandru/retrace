import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "@retrace-dev/core";
import { D1Store } from "./d1-store.js";

class PreparedStatement {
  params: unknown[] = [];

  constructor(readonly sql: string) {}

  bind(...params: unknown[]) {
    this.params = params;
    return this;
  }
}

class FakeD1 {
  batched: PreparedStatement[] = [];

  prepare(sql: string) {
    return new PreparedStatement(sql);
  }

  async batch(statements: PreparedStatement[]) {
    this.batched = statements;
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

test("deleteProject deletes checkpoint rows in the guarded atomic batch", async () => {
  const db = new FakeD1();
  const store = new D1Store(db as unknown as D1Database);
  const project = "project-being-deleted";
  const audit: Event = {
    id: "evt_delete_audit",
    project: "retrace",
    seq: 10,
    timestamp: "2026-08-31T12:00:00.000Z",
    received_at: "2026-08-31T12:00:00.000Z",
    actor: { type: "agent", id: "codex" },
    action: "deleted",
    artifacts: [{ id: `project:${project}`, role: "used" }],
    prev_hash: "a".repeat(64),
    hash: "b".repeat(64),
  };

  const deleted = await store.deleteProject(project, audit, { seq: 7, hash: "c".repeat(64) });
  const deletes = db.batched.filter((statement) => statement.sql.startsWith("DELETE FROM "));

  assert.deepEqual(
    deletes.map((statement) => statement.sql.match(/^DELETE FROM (\w+)/)?.[1]),
    ["events", "event_artifacts", "shares", "checkpoints"],
  );
  for (const statement of deletes) {
    assert.match(statement.sql, /EXISTS \(SELECT 1 FROM events WHERE id = \?\)$/);
    assert.deepEqual(statement.params, [project, audit.id]);
  }
  assert.deepEqual(deleted, { events: 1, event_artifacts: 1, shares: 1, checkpoints: 1 });
});
