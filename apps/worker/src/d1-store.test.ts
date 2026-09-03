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

  async all() {
    return { results: [] as { body: string }[] };
  }
}

class FakeD1 {
  batched: PreparedStatement[] = [];
  last?: PreparedStatement;

  prepare(sql: string) {
    const stmt = new PreparedStatement(sql);
    this.last = stmt;
    return stmt;
  }

  async batch(statements: PreparedStatement[]) {
    this.batched = statements;
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

test("deleteProject deletes checkpoint and export-cache rows in the guarded atomic batch", async () => {
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
    ["events", "event_artifacts", "shares", "checkpoints", "export_cache"],
  );
  for (const statement of deletes) {
    assert.match(statement.sql, /EXISTS \(SELECT 1 FROM events WHERE id = \?\)$/);
    assert.deepEqual(statement.params, [project, audit.id]);
  }
  assert.deepEqual(deleted, { events: 1, event_artifacts: 1, shares: 1, checkpoints: 1, export_cache: 1 });
});

test("history SQL is newest-first with an exclusive before_seq bound and a limit+1 probe", async () => {
  const db = new FakeD1();
  const store = new D1Store(db as unknown as D1Database);
  await store.history({ project: "retrace", limit: 10, before_seq: 50 });
  const stmt = db.last!;
  assert.match(stmt.sql, /ORDER BY e\.seq DESC LIMIT \?/);
  assert.match(stmt.sql, /e\.seq < \?/);
  assert.equal(stmt.params.at(-1), 11, "fetches limit+1 so truncated is detectable");
  assert.equal(stmt.params.includes(50), true);
});
