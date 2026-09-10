import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, sealEvent, verifyProject, EventInput, HeadMovedError } from "@retrace-dev/core";
import { SqliteStore } from "./sqlite-store.js";

const ev = (over: Partial<EventInput>): EventInput => ({ project: "junk", actor: { type: "agent", id: "claude" }, action: "edited", artifacts: [{ id: "a" }], ...over });
const audit = (store: SqliteStore) => store.head("ops").then((h) => sealEvent(ev({ project: "ops", action: "deleted", artifacts: [{ id: "project:junk" }] }), h));

test("SqliteStore: artifact role is body-only — survives insert → get/all/history, no index column involved", async () => {
  const store = new SqliteStore(":memory:");
  const { event } = await appendEvent(store, ev({ artifacts: [{ id: "in", role: "used" }, { id: "out", role: "generated" }, { id: "legacy" }] }));
  for (const got of [await store.get(event.id), (await store.all("junk"))[0], (await store.history({ project: "junk", artifact_id: "out" })).events[0]]) {
    assert.deepEqual(got?.artifacts, [{ id: "in", role: "used" }, { id: "out", role: "generated" }, { id: "legacy" }]);
    assert.equal(got?.hash, event.hash);
  }
  assert.equal((await verifyProject(store, "junk")).ok, true);
  // the lookup index is untouched: one row per (event, artifact), nothing but ids
  const cols = (store as any).db.prepare("PRAGMA table_info(event_artifacts)").all().map((c: any) => c.name);
  assert.deepEqual(cols, ["event_id", "project", "artifact_id"]);
});

test("SqliteStore.history: % and _ in text are literals; LIMIT is bound and clamped", async () => {
  const store = new SqliteStore(":memory:");
  await appendEvent(store, ev({ intent: "100% coverage", artifacts: [{ id: "pct" }] }));
  await appendEvent(store, ev({ intent: "plain edit", artifacts: [{ id: "plain" }] }));
  const pct = await store.history({ project: "junk", text: "100%" });
  assert.equal(pct.events.length, 1);
  assert.equal(pct.events[0].intent, "100% coverage");
  assert.equal(pct.truncated, false);
  const underscore = await store.history({ project: "junk", text: "plain_edit" });
  assert.equal(underscore.events.length, 0, "unescaped _ would have matched 'plain edit'");
  const one = await store.history({ project: "junk", limit: 1 });
  assert.equal(one.events.length, 1);
  assert.equal(one.events[0].seq, 1, "limit 1 is the newest event, not genesis");
  assert.equal(one.truncated, true);
  assert.equal(one.next_before_seq, 1);
  const older = await store.history({ project: "junk", limit: 1, before_seq: one.next_before_seq });
  assert.equal(older.events[0].seq, 0);
  assert.equal(older.truncated, false);
  const huge = await store.history({ project: "junk", limit: 9e9 });
  assert.equal(huge.events.length, 2, "oversize limit is clamped, not interpolated");
  assert.equal(huge.truncated, false);
});

test("SqliteStore.deleteProject: deletes + audit insert commit together", async () => {
  const store = new SqliteStore(":memory:");
  await appendEvent(store, ev({ artifacts: [{ id: "a" }, { id: "b" }] }));
  await appendEvent(store, ev({}));
  await appendEvent(store, ev({ project: "keep" }));
  await store.createShare({ id: "sh_1", project: "junk", created_at: "2026-08-20T00:00:00Z" });
  const counts = await store.deleteProject("junk", await audit(store), (await store.head("junk"))!);
  assert.deepEqual(counts, { events: 2, event_artifacts: 3, event_artifact_index: 3, pending_deliveries: 0, shares: 1, project_policies: 0 });
  assert.deepEqual(await store.projects(), ["keep", "ops"]);
  assert.equal((await store.all("ops")).length, 1);
  assert.equal((await verifyProject(store, "ops")).ok, true);
});

test("SqliteStore.deleteProject: audit insert failure rolls the deletes back (B3)", async () => {
  const store = new SqliteStore(":memory:");
  await appendEvent(store, ev({}));
  await store.createShare({ id: "sh_1", project: "junk", created_at: "2026-08-20T00:00:00Z" });
  const stale = await audit(store); // sealed at ops seq 0 …
  await appendEvent(store, ev({ project: "ops", action: "deleted", artifacts: [{ id: "project:other" }] })); // … then someone else takes seq 0
  await assert.rejects(store.deleteProject("junk", stale, (await store.head("junk"))!), /UNIQUE/);
  assert.equal((await store.all("junk")).length, 1);
  assert.ok(await store.getShare("sh_1"));
  assert.equal((await store.all("ops")).length, 1); // only the competing event, no half-written audit
});

test("SqliteStore.deleteProject: a head that moved since the audit was sealed throws HeadMovedError and commits nothing", async () => {
  const store = new SqliteStore(":memory:");
  await appendEvent(store, ev({}));
  await store.createShare({ id: "sh_1", project: "junk", created_at: "2026-08-20T00:00:00Z" });
  const seen = (await store.head("junk"))!; // router reads the head and seals the audit from it …
  const sealed = await audit(store);
  await appendEvent(store, ev({ artifacts: [{ id: "late" }] })); // … then a write lands on junk before the transaction
  await assert.rejects(store.deleteProject("junk", sealed, seen), (e: any) => e instanceof HeadMovedError && e.name === "HeadMovedError");
  assert.equal((await store.all("junk")).length, 2);
  assert.ok(await store.getShare("sh_1"));
  assert.equal((await store.all("ops")).length, 0);
  // retry with the fresh head succeeds
  const counts = await store.deleteProject("junk", await audit(store), (await store.head("junk"))!);
  assert.deepEqual(counts, { events: 2, event_artifacts: 2, event_artifact_index: 2, pending_deliveries: 0, shares: 1, project_policies: 0 });
  assert.equal((await store.all("ops")).length, 1);
});

test("SqliteStore writes event_artifact_index on insert and matches sameArtifact aliases within a seq window", async () => {
  const store = new SqliteStore(":memory:");
  await appendEvent(store, ev({ artifacts: [{ id: "repo:jordandru/retrace#a.ts", role: "both" }], method: { params: { sealed_by: "pinned:codex" } } }));
  await appendEvent(store, ev({ artifacts: [{ id: "repo:retrace#a.ts" }] }));
  await appendEvent(store, ev({ artifacts: [{ id: "repo:otherorg/retrace#a.ts" }] }));
  await appendEvent(store, ev({ artifacts: [{ id: "repo:jordandru/retrace#b.ts" }] }));
  const cols = (store as any).db.prepare("PRAGMA table_info(event_artifact_index)").all().map((c: any) => c.name);
  assert.deepEqual(cols, ["project", "artifact_key", "seq", "actor_type", "actor_id", "role", "sealed_by"]);
  const hit = await store.eventsReferencingArtifacts({
    project: "junk", artifact_keys: ["repo:jordandru/retrace#a.ts"], after_seq: -1, through_seq: 10, row_cap: 100, deadline: Date.now() + 5_000,
  });
  assert.equal(hit.ok, true);
  if (hit.ok) assert.deepEqual(hit.events.map((e) => e.seq), [0, 1]);

  const shortQuery = await store.eventsReferencingArtifacts({
    project: "junk", artifact_keys: ["repo:retrace#a.ts"], after_seq: -1, through_seq: 10, row_cap: 100, deadline: Date.now() + 5_000,
  });
  assert.equal(shortQuery.ok, true);
  if (shortQuery.ok) assert.deepEqual(shortQuery.events.map((e) => e.seq), [0, 1, 2], "short name matches every owner/retrace#a.ts");

  const windowed = await store.eventsReferencingArtifacts({
    project: "junk", artifact_keys: ["repo:jordandru/retrace#a.ts"], after_seq: 0, through_seq: 1, row_cap: 100, deadline: Date.now() + 5_000,
  });
  assert.equal(windowed.ok, true);
  if (windowed.ok) assert.deepEqual(windowed.events.map((e) => e.seq), [1]);

  const budget = await store.eventsReferencingArtifacts({
    project: "junk", artifact_keys: ["repo:jordandru/retrace#a.ts", "repo:jordandru/retrace#b.ts"], after_seq: -1, through_seq: 10, row_cap: 1, deadline: Date.now() + 5_000,
  });
  assert.deepEqual(budget, { ok: false, reason: "budget" });
  const deadline = await store.eventsReferencingArtifacts({
    project: "junk", artifact_keys: ["a"], after_seq: -1, through_seq: 10, row_cap: 100, deadline: 0,
  }, () => 1);
  assert.deepEqual(deadline, { ok: false, reason: "deadline" });
});

test("SqliteStore backfills event_artifact_index once from existing events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-sqlite-index-"));
  const file = join(dir, "ledger.db");
  const store = new SqliteStore(file);
  await appendEvent(store, ev({ artifacts: [{ id: "repo:jordandru/retrace#a.ts", role: "generated" }], method: { params: { sealed_by: "pinned:x" } } }));
  (store as any).db.exec("DELETE FROM event_artifact_index");
  assert.equal((store as any).db.prepare("SELECT COUNT(*) AS n FROM event_artifact_index").get().n, 0);
  const reopened = new SqliteStore(file);
  const rows = (reopened as any).db.prepare("SELECT project, artifact_key, seq, actor_type, actor_id, role, sealed_by FROM event_artifact_index").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].artifact_key, "repo:jordandru/retrace#a.ts");
  assert.equal(rows[0].role, "generated");
  assert.equal(rows[0].sealed_by, "pinned:x");
  const hit = await reopened.eventsReferencingArtifacts({
    project: "junk", artifact_keys: ["repo:retrace#a.ts"], after_seq: -1, through_seq: 10, row_cap: 10, deadline: Date.now() + 5_000,
  });
  assert.equal(hit.ok, true);
  if (hit.ok) assert.equal(hit.events.length, 1);
});

test("SqliteStore pending_deliveries insert, list-older-than, delete", async () => {
  const store = new SqliteStore(":memory:");
  await store.insertPendingDelivery({ delivery_id: "d1", project: "retrace", raw_body: "a", received_at: "2026-09-01T00:00:00.000Z" });
  await store.insertPendingDelivery({ delivery_id: "d2", project: "retrace", raw_body: "b", received_at: "2026-09-08T00:00:00.000Z" });
  const old = await store.listPendingDeliveriesOlderThan("2026-09-05T00:00:00.000Z");
  assert.deepEqual(old.map((r) => r.delivery_id), ["d1"]);
  assert.equal(await store.deletePendingDelivery("d1"), true);
  assert.deepEqual((await store.listPendingDeliveriesOlderThan("2026-09-10T00:00:00.000Z")).map((r) => r.delivery_id), ["d2"]);
  assert.equal(await store.deletePendingDelivery("missing"), false);
});

test("builder note 2: failed policy write rolls back activation, document, and route", async () => {
  const store = new SqliteStore(":memory:");
  const { createHandler, POLICY_PROFILE, planPolicyPut } = await import("@retrace-dev/core");
  const h = createHandler(store, { token: "owner-token-long-enough", ownerPrincipal: { type: "human", id: "o" } });
  const body = {
    profile: POLICY_PROFILE, project: "p", trusted_hook_stamps: [], unresolved_claims: "record",
    repositories: [{ name: "acme/r", aliases: [] }], github_repos: ["acme/r"],
  };
  const ok = await h(new Request("http://test/projects/p/policy", {
    method: "PUT", headers: { authorization: "Bearer owner-token-long-enough", "content-type": "application/json", "if-match": "none" },
    body: JSON.stringify(body),
  }));
  assert.equal(ok.status, 201);
  const v1 = await ok.json() as { digest: string };
  const policies1 = await store.listPolicies("p");
  const routes1 = await store.listPolicyRoutes("p");
  const events1 = await store.all("p");
  const planned = await planPolicyPut({
    project: "p",
    rawBody: JSON.stringify({ ...body, trusted_hook_stamps: ["assert:x"] }),
    ifMatchHeader: v1.digest,
    ownerPrincipal: { type: "human", id: "o" },
    current: await store.getPolicy("p", { current: true }),
    currentByProject: { p: await store.getPolicy("p", { current: true }) },
    routeByRepo: (repo) => store.getPolicyRoute(repo),
    heads: { p: await store.head("p") },
  });
  assert.equal(planned.status, 201);
  if (planned.status !== 201) return;
  planned.write.documents.push(policies1[0]!);
  await assert.rejects(() => store.applyPolicyWrite(planned.write, planned.expectedHeads), /UNIQUE/);
  assert.equal((await store.listPolicies("p")).length, 1);
  assert.deepEqual(await store.listPolicyRoutes("p"), routes1);
  assert.equal((await store.all("p")).length, events1.length);
});
