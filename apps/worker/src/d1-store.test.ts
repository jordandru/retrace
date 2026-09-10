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

  async run() {
    return { meta: { changes: 1 } };
  }

  async first() {
    return null;
  }
}

class FakeD1 {
  batched: PreparedStatement[] = [];
  last?: PreparedStatement;
  prepared: PreparedStatement[] = [];

  prepare(sql: string) {
    const stmt = new PreparedStatement(sql);
    this.last = stmt;
    this.prepared.push(stmt);
    return stmt;
  }

  async batch(statements: PreparedStatement[]) {
    this.batched = statements;
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

const event: Event = {
  id: "evt_1",
  project: "retrace",
  seq: 4,
  timestamp: "2026-09-08T12:00:00.000Z",
  received_at: "2026-09-08T12:00:00.000Z",
  actor: { type: "agent", id: "codex" },
  action: "edited",
  artifacts: [{ id: "repo:jordandru/retrace#a.ts", role: "both" }, { id: "task:1" }],
  method: { params: { sealed_by: "pinned:codex" } },
  prev_hash: "a".repeat(64),
  hash: "b".repeat(64),
};

test("deleteProject deletes checkpoint, export-cache, artifact index and pending delivery rows in the guarded atomic batch", async () => {
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
    ["events", "event_artifacts", "event_artifact_index", "pending_deliveries", "shares", "checkpoints", "export_cache", "project_policies", "policy_routes"],
  );
  for (const statement of deletes) {
    assert.match(statement.sql, /EXISTS \(SELECT 1 FROM events WHERE id = \?\)$/);
    assert.deepEqual(statement.params, [project, audit.id]);
  }
  assert.deepEqual(deleted, {
    events: 1, event_artifacts: 1, event_artifact_index: 1, pending_deliveries: 1, shares: 1, checkpoints: 1, export_cache: 1, project_policies: 1,
  });
});

test("insert writes event_artifact_index rows from artifactKey on every event", async () => {
  const db = new FakeD1();
  const store = new D1Store(db as unknown as D1Database);
  await store.insert(event);
  const index = db.batched.filter((s) => s.sql.includes("INSERT OR IGNORE INTO event_artifact_index"));
  assert.equal(index.length, 2);
  assert.deepEqual(index[0].params.slice(0, 7), [
    "retrace", "repo:jordandru/retrace#a.ts", 4, "agent", "codex", "both", "pinned:codex",
  ]);
  assert.deepEqual(index[1].params.slice(0, 7), [
    "retrace", "task:1", 4, "agent", "codex", null, "pinned:codex",
  ]);
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

test("eventsReferencingArtifacts SQL joins the index, binds keys, and uses row_cap+1", async () => {
  const db = new FakeD1();
  const store = new D1Store(db as unknown as D1Database);
  const result = await store.eventsReferencingArtifacts({
    project: "retrace",
    artifact_keys: ["repo:jordandru/retrace#a.ts"],
    after_seq: 1,
    through_seq: 9,
    row_cap: 20,
    deadline: Date.now() + 5_000,
  });
  assert.equal(result.ok, true);
  const stmt = db.last!;
  assert.match(stmt.sql, /JOIN event_artifact_index i ON i\.project = e\.project AND i\.seq = e\.seq/);
  assert.match(stmt.sql, /i\.seq > \? AND i\.seq <= \?/);
  assert.equal(stmt.params[0], "retrace");
  assert.equal(stmt.params[1], 1);
  assert.equal(stmt.params[2], 9);
  assert.equal(stmt.params.at(-1), 21);
  assert.ok(stmt.params.includes("repo:jordandru/retrace#a.ts"));
  assert.ok(stmt.params.includes("repo:retrace#a.ts"));
});

test("eventsReferencingArtifacts returns typed over-budget on a past deadline without querying", async () => {
  const db = new FakeD1();
  const store = new D1Store(db as unknown as D1Database);
  const result = await store.eventsReferencingArtifacts({
    project: "retrace", artifact_keys: ["a"], after_seq: 0, through_seq: 10, row_cap: 5, deadline: 0,
  }, () => 1);
  assert.deepEqual(result, { ok: false, reason: "deadline" });
  assert.equal(db.prepared.length, 0);
});

test("pending_deliveries insert/list/delete SQL", async () => {
  const db = new FakeD1();
  const store = new D1Store(db as unknown as D1Database);
  await store.insertPendingDelivery({
    delivery_id: "123", project: "retrace", raw_body: "{\"ok\":true}", received_at: "2026-09-08T00:00:00.000Z",
  });
  assert.match(db.last!.sql, /INSERT OR REPLACE INTO pending_deliveries/);
  assert.deepEqual(db.last!.params, ["123", "retrace", "{\"ok\":true}", "2026-09-08T00:00:00.000Z", null, null, null, null]);
  await store.listPendingDeliveriesOlderThan("2026-09-09T00:00:00.000Z");
  assert.match(db.last!.sql, /FROM pending_deliveries WHERE received_at < \?/);
  await store.deletePendingDelivery("123");
  assert.match(db.last!.sql, /DELETE FROM pending_deliveries WHERE delivery_id = \?/);
  assert.deepEqual(db.last!.params, ["123"]);
});
