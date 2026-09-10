import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@retrace-dev/core";
import { POLICY_PROFILE, SCHEMA_SQL, RouteConflictError, planPolicyPut } from "@retrace-dev/core";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
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
    ["events", "event_artifacts", "event_artifact_index", "pending_deliveries", "shares", "checkpoints", "export_cache", "project_policies", "classification_contexts", "classification_path_lowers", "classification_breakers"],
  );
  for (const statement of deletes) {
    assert.match(statement.sql, /EXISTS \(SELECT 1 FROM events WHERE id = \?\)$/);
    assert.deepEqual(statement.params, [project, audit.id]);
  }
  assert.deepEqual(deleted, {
    events: 1, event_artifacts: 1, event_artifact_index: 1, pending_deliveries: 1, shares: 1, checkpoints: 1, export_cache: 1, project_policies: 1, classification_contexts: 1, classification_path_lowers: 1, classification_breakers: 1,
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
  assert.match(db.last!.sql, /INSERT INTO pending_deliveries/);
  assert.doesNotMatch(db.last!.sql, /OR REPLACE/);
  assert.deepEqual(db.last!.params, ["123", "retrace", "{\"ok\":true}", "2026-09-08T00:00:00.000Z", null, null, null, null]);
  await store.listPendingDeliveriesOlderThan("2026-09-09T00:00:00.000Z");
  assert.match(db.last!.sql, /FROM pending_deliveries WHERE received_at < \?/);
  await store.deletePendingDelivery("123");
  assert.match(db.last!.sql, /DELETE FROM pending_deliveries WHERE delivery_id = \?/);
  assert.deepEqual(db.last!.params, ["123"]);
});

class SqliteD1Statement {
  params: SQLInputValue[] = [];
  constructor(private db: DatabaseSync, readonly sql: string) {}
  bind(...params: unknown[]) {
    this.params = params as SQLInputValue[];
    return this;
  }
  private stmt() {
    return this.db.prepare(this.sql);
  }
  async first() {
    const row = this.params.length ? this.stmt().get(...this.params) : this.stmt().get();
    return row ?? null;
  }
  async all() {
    const results = this.params.length ? this.stmt().all(...this.params) : this.stmt().all();
    return { results };
  }
  async run() {
    const info = this.params.length ? this.stmt().run(...this.params) : this.stmt().run();
    return { meta: { changes: Number(info.changes) } };
  }
}

class SqliteD1 {
  constructor(private db: DatabaseSync) {}
  prepare(sql: string) {
    return new SqliteD1Statement(this.db, sql);
  }
  async batch(statements: SqliteD1Statement[]) {
    this.db.exec("BEGIN");
    try {
      const out: { meta: { changes: number } }[] = [];
      for (const s of statements) {
        if (/^\s*select/i.test(s.sql)) {
          await s.all();
          out.push({ meta: { changes: 0 } });
        } else {
          out.push(await s.run());
        }
      }
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    }
  }
}

test("Codex-D1: a lost route CAS aborts the batch — loser has no policy row and no activation", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA_SQL);
  const store = new D1Store(new SqliteD1(sqlite) as unknown as D1Database);
  const owner = { type: "human" as const, id: "o" };
  const bodyFor = (project: string) => JSON.stringify({
    profile: POLICY_PROFILE, project, trusted_hook_stamps: [], unresolved_claims: "record",
    repositories: [{ name: "acme/shared", aliases: [] }], github_repos: ["acme/shared"],
  });
  const plannedA = await planPolicyPut({
    project: "a", rawBody: bodyFor("a"), ifMatchHeader: "none", ownerPrincipal: owner,
    current: null, currentByProject: { a: null }, routeByRepo: async () => null, heads: { a: null },
  });
  assert.equal(plannedA.status, 201);
  if (plannedA.status !== 201) throw new Error("plan A");
  await store.applyPolicyWrite(plannedA.write, plannedA.expectedHeads);
  assert.equal((await store.getPolicyRoute("acme/shared"))?.project, "a");
  assert.ok(await store.getPolicy("a", { current: true }));
  assert.equal((await store.all("a")).length, 1);

  const plannedB = await planPolicyPut({
    project: "b", rawBody: bodyFor("b"), ifMatchHeader: "none", ownerPrincipal: owner,
    current: null, currentByProject: { b: null }, routeByRepo: async () => null, heads: { b: null },
  });
  assert.equal(plannedB.status, 201);
  if (plannedB.status !== 201) throw new Error("plan B");
  const origRoute = store.getPolicyRoute.bind(store);
  let hideLiveRoute = true;
  store.getPolicyRoute = async (repo) => hideLiveRoute ? null : origRoute(repo);
  try {
    await assert.rejects(
      () => store.applyPolicyWrite(plannedB.write, plannedB.expectedHeads),
      (e: unknown) => e instanceof RouteConflictError,
    );
  } finally {
    hideLiveRoute = false;
    store.getPolicyRoute = origRoute;
  }
  assert.equal(await store.getPolicy("b", { current: true }), null, "loser must not keep a policy row");
  assert.equal((await store.all("b")).length, 0, "loser must not keep an activation event");
  assert.equal((await store.getPolicyRoute("acme/shared"))?.project, "a");
  assert.ok(await store.getPolicy("a", { current: true }));
  assert.equal((await store.all("a")).length, 1);
});

test("A2 D1: two connections racing insert-if-absent keep one classification context", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "retrace-d1-ctx-")), "ledger.db");
  const db1 = new DatabaseSync(path);
  db1.exec(SCHEMA_SQL);
  const db2 = new DatabaseSync(path);
  const a = new D1Store(new SqliteD1(db1) as unknown as D1Database);
  const b = new D1Store(new SqliteD1(db2) as unknown as D1Database);
  const row = {
    project: "p",
    canonical_repo: "acme/app",
    sha: "a".repeat(40),
    read_head_seq: 3,
    read_head_hash: "h".repeat(64),
    policy_digest: "d".repeat(64),
    first_producer: "git-hook" as const,
    first_F_digest: "f".repeat(64),
    first_claim_digest: "c".repeat(64),
    classifier_profile: "trailer-consistency/1",
    rollout_mode: "shadow",
    amendment_snapshot: "[]",
    per_path_lower: { "a.ts": 0 },
    created_at: "2026-09-10T12:00:00.000Z",
  };
  const [r1, r2] = await Promise.all([
    a.insertClassificationContextIfAbsent(row),
    b.insertClassificationContextIfAbsent({ ...row, read_head_seq: 99 }),
  ]);
  assert.equal([r1, r2].filter((r) => r.inserted).length, 1);
  assert.equal(r1.context.read_head_seq, r2.context.read_head_seq);
});
