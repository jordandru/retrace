import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent, sealEvent, verifyProject, EventInput, HeadMovedError, createHandler, POLICY_PROFILE,
  eventsReferencingArtifactsSql, eventsReferencingArtifactsStatements, MemoryEventStore, recordWebhookClassifyOutcome,
} from "@retrace-dev/core";
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

test("SqliteStore.amendmentEventsUpTo returns only attribution amendments at or below U", async () => {
  const store = new SqliteStore(":memory:");
  await appendEvent(store, ev({ action: "other", action_detail: "amended" }));
  const method = (await appendEvent(store, ev({
    action: "other", action_detail: "amended", method: { params: { attribution: null } },
  }))).event;
  const tag = (await appendEvent(store, ev({
    action: "other", action_detail: "amended", tags: ["attribution"],
  }))).event;
  await appendEvent(store, ev({ action: "edited", tags: ["attribution"] }));
  const above = (await appendEvent(store, ev({
    action: "other", action_detail: "amended", method: { params: { attribution: { from: "late" } } },
  }))).event;

  const got = await store.amendmentEventsUpTo("junk", tag.seq, 10);
  assert.deepEqual(got.map((e) => e.id), [method.id, tag.id]);
  const many = await store.getMany([above.id, method.id, "missing", method.id]);
  assert.deepEqual(many.map((e) => e.id).sort(), [above.id, method.id].sort());
  const indexes = (store as any).db.prepare("PRAGMA index_list(events)").all().map((r: any) => r.name);
  assert.ok(indexes.includes("idx_events_amendment_candidates"));
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
  assert.deepEqual(counts, { events: 2, event_artifacts: 3, event_artifact_index: 3, pending_deliveries: 0, shares: 1, project_policies: 0, classification_contexts: 0, classification_path_lowers: 0, classification_breakers: 0 });
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
  assert.deepEqual(counts, { events: 2, event_artifacts: 2, event_artifact_index: 2, pending_deliveries: 0, shares: 1, project_policies: 0, classification_contexts: 0, classification_path_lowers: 0, classification_breakers: 0 });
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

test("SqliteStore artifact prefixes find abbreviated and full commit references", async () => {
  const store = new SqliteStore(":memory:");
  const sha = "a1234567890b".padEnd(40, "c");
  for (const suffix of [sha.slice(0, 12), sha]) {
    await appendEvent(store, ev({
      action: "committed",
      artifacts: [{ id: `commit:acme/app@${suffix}`, role: "generated" }],
      method: { tool: "git", params: { sha } },
    }));
  }
  const query = {
    project: "junk",
    artifact_keys: [],
    artifact_prefixes: [`commit:acme/app@${sha.slice(0, 7)}`],
    after_seq: -1,
    through_seq: 10,
    row_cap: 10,
    deadline: Date.now() + 5_000,
  };
  const hit = await store.eventsReferencingArtifacts(query);
  assert.equal(hit.ok, true);
  if (hit.ok) assert.deepEqual(hit.events.map((e) => e.seq), [0, 1]);
  const { sql, params } = eventsReferencingArtifactsSql(query);
  const plan = (store as any).db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row: any) => row.detail).join("\n");
  assert.match(plan, /idx_eai_project_key_seq \(project=\? AND artifact_key>[?] AND artifact_key<[?]\)/);
});

test("SqliteStore artifact-index lookups are index range seeks on a populated store (PR 51 round 5, Codex F3)", async () => {
  const store = new SqliteStore(":memory:");
  const db = (store as any).db;
  for (let i = 0; i < 5_000; i++) {
    await appendEvent(store, ev({ action: "edited", artifacts: [{ id: `repo:acme/app#noise/${i}.ts`, role: "generated" }], intent: "n".repeat(1024) }));
  }
  const sha = "a1234567890b".padEnd(40, "c");
  await appendEvent(store, ev({ action: "committed", artifacts: [{ id: `commit:acme/app@${sha.slice(0, 12)}`, role: "generated" }, { id: "repo:acme/app#other.ts", role: "generated" }], method: { tool: "git", params: { sha } } }));
  await appendEvent(store, ev({ action: "edited", artifacts: [{ id: "repo:acme/app#a.ts", role: "generated" }] }));
  await appendEvent(store, ev({ action: "committed", artifacts: [{ id: `commit:acme/app@${sha}`, role: "generated" }, { id: "repo:acme/app#a.ts", role: "generated" }], method: { tool: "git", params: { sha } } }));
  const base = { project: "junk", after_seq: -1, through_seq: 10_000, row_cap: 20_000, deadline: Date.now() + 60_000 };
  const shapes: Record<string, { query: any; expect: number[] }> = {
    // the classifier's alias-expanded path predicate: owner/repo key, its basename alias, and an owner-less alias glob
    aliasPath: { query: { ...base, artifact_keys: ["repo:acme/app#a.ts", "repo:app#a.ts", "repo:old-name#a.ts"] }, expect: [5001, 5002] },
    // the producer-group query: three literal commit-reference prefixes
    threePrefix: { query: { ...base, artifact_keys: [], artifact_prefixes: [`commit:acme/app@${sha.slice(0, 7)}`, `commit:app@${sha.slice(0, 7)}`, `commit:old-name@${sha.slice(0, 7)}`] }, expect: [5000, 5002] },
    // the ordinary pre-PR single-key lookup
    singleKey: { query: { ...base, artifact_keys: ["repo:acme/app#a.ts"] }, expect: [5001, 5002] },
  };
  for (const [name, { query, expect }] of Object.entries(shapes)) {
    const statements = eventsReferencingArtifactsStatements(query);
    assert.equal(statements.length, 1, `${name}: fits one statement`);
    const { sql, params } = statements[0]!;
    assert.doesNotMatch(sql, /INDEXED BY/, `${name}: no forced index hint`);
    const plan: string[] = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row: any) => row.detail);
    const indexSearches = plan.filter((line) => /SEARCH i /.test(line));
    assert.ok(indexSearches.length >= 1, `${name}: at least one index term\n${plan.join("\n")}`);
    for (const line of indexSearches) {
      assert.match(line, /idx_eai_project_key_seq \(project=\? AND artifact_key[=>]/, `${name}: every artifact-index term seeks the key index\n${plan.join("\n")}`);
    }
    assert.ok(!plan.some((line) => /idx_eai_project_key_seq \(project=\?\)$/.test(line)), `${name}: no project-only index search\n${plan.join("\n")}`);
    assert.ok(plan.some((line) => /SEARCH e USING INDEX \S+ \(project=\? AND seq=\?\)/.test(line)), `${name}: the events side is a unique (project, seq) probe\n${plan.join("\n")}`);
    assert.ok(!plan.some((line) => /SEARCH e USING INDEX \S+ \(project=\?\)$/.test(line)), `${name}: no project-only walk of events\n${plan.join("\n")}`);
    const started = Date.now();
    const result = await store.eventsReferencingArtifacts(query);
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true, name);
    if (result.ok) assert.deepEqual(result.events.map((e) => e.seq), expect, name);
    assert.ok(elapsed < 500, `${name}: ${elapsed} ms on 5,000 events must stay far inside the classifier budget`);
  }
});

test("SqliteStore counts matching artifact rows, not events, against row_cap (PR 51 round 6, Codex F5)", async () => {
  const store = new SqliteStore(":memory:");
  const memory = new MemoryEventStore();
  const input = ev({ artifacts: [{ id: "x:one", role: "generated" }, { id: "x:two", role: "generated" }] });
  await appendEvent(store, input);
  await appendEvent(memory, input);
  const q = { project: "junk", artifact_keys: ["x:one", "x:two"], after_seq: -1, through_seq: 100, row_cap: 1, deadline: Date.now() + 5_000 };
  assert.deepEqual(await store.eventsReferencingArtifacts(q), { ok: false, reason: "budget" }, "two matching artifacts on one event consume two budget units");
  assert.deepEqual(await memory.eventsReferencingArtifacts(q), { ok: false, reason: "budget" });
  const two = await store.eventsReferencingArtifacts({ ...q, row_cap: 2 });
  assert.equal(two.ok, true);
  if (two.ok) assert.equal(two.events.length, 1, "the event is returned once");
  // the same artifact row reached through two overlapping terms (exact key + prefix) counts once
  const overlap = await store.eventsReferencingArtifacts({ ...q, artifact_keys: ["x:one"], artifact_prefixes: ["x:on"], row_cap: 1 });
  assert.equal(overlap.ok, true);
});

test("SqliteStore prefix ranges match exactly what the in-memory spec matches at Unicode edges (PR 51 round 6, Codex F6)", async () => {
  const cases: [string, string, boolean][] = [
    ["", "\u{1F600}", true],
    ["x:\uffff", "x:\uffff\u{1F600}", true],
    ["x:\uffff", "x:\uffff\uffff", true],
    ["x:\ud7ff", "x:\ue000", false],
    ["x:\u{1F600}", "x:\u{1F601}", false],
    ["x:\u{10ffff}", "x:\u{10ffff}\u{10ffff}", true],
    ["commit:acme/app@a12", "commit:acme/app@a12abc", true],
    ["commit:acme/app@a12", "commit:acme/app@a13", false],
  ];
  for (const [prefix, key, expected] of cases) {
    const store = new SqliteStore(":memory:");
    const memory = new MemoryEventStore();
    const input = ev({ artifacts: [{ id: key, role: "generated" }] });
    await appendEvent(store, input);
    await appendEvent(memory, input);
    const q = { project: "junk", artifact_keys: [], artifact_prefixes: [prefix], after_seq: -1, through_seq: 100, row_cap: 10, deadline: Date.now() + 5_000 };
    const sql = await store.eventsReferencingArtifacts(q);
    const mem = await memory.eventsReferencingArtifacts(q);
    assert.equal(sql.ok, true); assert.equal(mem.ok, true);
    if (sql.ok && mem.ok) {
      assert.equal(mem.events.length, expected ? 1 : 0, `memory spec for ${JSON.stringify(prefix)} vs ${JSON.stringify(key)}`);
      assert.deepEqual(sql.events.map((e) => e.seq), mem.events.map((e) => e.seq), `SQLite must match the spec for ${JSON.stringify(prefix)} vs ${JSON.stringify(key)}`);
    }
  }
});

test("SqliteStore batches a 501-term lookup and keeps window, budget and deduplication across batches", async () => {
  const store = new SqliteStore(":memory:");
  for (let i = 0; i < 6; i++) await appendEvent(store, ev({ artifacts: [{ id: `task:${i}`, role: "generated" }] }));
  const keys = Array.from({ length: 501 }, (_, i) => `task:${i}`);
  const q = { project: "junk", artifact_keys: keys, after_seq: 0, through_seq: 4, row_cap: 10, deadline: Date.now() + 5_000 };
  const statements = eventsReferencingArtifactsStatements(q);
  assert.ok(statements.length > 1, "501 exact terms cannot fit one statement");
  for (const st of statements) {
    assert.ok(st.params.length <= 100, `params ${st.params.length}`);
    assert.ok((st.sql.match(/ UNION /g) ?? []).length + 1 <= 5, "D1 allows five compound terms");
    for (const p of st.params.slice(3, -2)) assert.ok((JSON.parse(p as string) as unknown[]).length <= 400);
  }
  const hit = await store.eventsReferencingArtifacts(q);
  assert.equal(hit.ok, true);
  if (hit.ok) assert.deepEqual(hit.events.map((e: { seq: number }) => e.seq), [1, 2, 3, 4], "window (0, 4] honoured across batches");
  assert.deepEqual(await store.eventsReferencingArtifacts({ ...q, row_cap: 3 }), { ok: false, reason: "budget" }, "budget counted across batches");
});

test("SqliteStore matches the memory spec for keys that look like JSON numbers or contain JSON syntax", async () => {
  const store = new SqliteStore(":memory:");
  const memory = new MemoryEventStore();
  const keys = ["123", "1e3", "0x1f", "true", "null", "[1]", "{\"a\":1}", "repo:acme/app#a \"quoted\" \\ path.ts", "line\nbreak"];
  for (const id of keys) {
    const e = ev({ artifacts: [{ id, role: "generated" }] });
    await appendEvent(store, e);
    await appendEvent(memory, e);
  }
  for (const [i, key] of keys.entries()) {
    const q = { project: "junk", artifact_keys: [key], after_seq: -1, through_seq: 100, row_cap: 10, deadline: Date.now() + 5_000 };
    const sql = await store.eventsReferencingArtifacts(q);
    const mem = await memory.eventsReferencingArtifacts(q);
    assert.equal(sql.ok, true); assert.equal(mem.ok, true);
    if (sql.ok && mem.ok) {
      assert.deepEqual(mem.events.map((e) => e.seq), [i], `memory spec finds ${JSON.stringify(key)}`);
      assert.deepEqual(sql.events.map((e) => e.seq), mem.events.map((e) => e.seq), `json_each must hand ${JSON.stringify(key)} back as the same text`);
    }
    const prefixed = await store.eventsReferencingArtifacts({ ...q, artifact_keys: [], artifact_prefixes: [key.slice(0, 2)] });
    const memPrefixed = await memory.eventsReferencingArtifacts({ ...q, artifact_keys: [], artifact_prefixes: [key.slice(0, 2)] });
    assert.equal(prefixed.ok, true); assert.equal(memPrefixed.ok, true);
    if (prefixed.ok && memPrefixed.ok) assert.deepEqual(prefixed.events.map((e) => e.seq), memPrefixed.events.map((e) => e.seq), `prefix ${JSON.stringify(key.slice(0, 2))}`);
  }
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

test("F3: sqlite concurrent A/B PUT claiming one repo is one 201 and one 409", async () => {
  const store = new SqliteStore(":memory:");
  const h = createHandler(store, { token: "owner-token-long-enough", ownerPrincipal: { type: "human", id: "o" } });
  const raw = (project: string) => JSON.stringify({
    profile: POLICY_PROFILE, project, trusted_hook_stamps: [], unresolved_claims: "record",
    repositories: [{ name: "acme/shared", aliases: [] }], github_repos: ["acme/shared"],
  });
  const put = (project: string) => h(new Request(`http://test/projects/${project}/policy`, {
    method: "PUT",
    headers: { authorization: "Bearer owner-token-long-enough", "content-type": "application/json", "if-match": "none" },
    body: raw(project),
  }));
  const [r1, r2] = await Promise.all([put("a"), put("b")]);
  assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
  const routes = [await store.getPolicyRoute("acme/shared")];
  assert.equal(routes.filter((r) => r?.state === "active").length, 1);
});

test("F15: readPolicySnapshot uses indexed getPolicyByActivationSeq, not all()", async () => {
  const store = new SqliteStore(":memory:");
  let allCalls = 0;
  const origAll = store.all.bind(store);
  store.all = async (...args: Parameters<SqliteStore["all"]>) => { allCalls++; return origAll(...args); };
  let idxCalls = 0;
  const origIdx = store.getPolicyByActivationSeq.bind(store);
  store.getPolicyByActivationSeq = async (...args: Parameters<SqliteStore["getPolicyByActivationSeq"]>) => {
    idxCalls++;
    return origIdx(...args);
  };
  await store.readPolicySnapshot("p", 0);
  assert.equal(allCalls, 0);
  assert.equal(idxCalls, 1);
  const dead = await store.readPolicySnapshot("p", 0, { deadline: 0, now: () => 1 });
  assert.equal(dead.unavailable, "deadline");
  store.getPolicyByActivationSeq = async () => { throw new Error("disk on fire"); };
  const snap = await store.readPolicySnapshot("p", 0);
  assert.equal(snap.unavailable, "store_error");
});

test("A2: two SqliteStore connections racing insert-if-absent keep one context row", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "retrace-ctx-")), "ledger.db");
  const a = new SqliteStore(path);
  const b = new SqliteStore(path);
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
  const later = { ...row, read_head_seq: 99, per_path_lower: { "a.ts": 8 } };
  const [r1, r2] = await Promise.all([
    a.insertClassificationContextIfAbsent(row),
    b.insertClassificationContextIfAbsent(later),
  ]);
  assert.equal([r1, r2].filter((r) => r.inserted).length, 1);
  assert.equal(r1.context.read_head_seq, r2.context.read_head_seq);
  const got = await a.getClassificationContext("p", "acme/app", row.sha);
  assert.equal(got?.read_head_seq, r1.context.read_head_seq);
});

test("F11 SQLite: two connections elect one lease owner; expiry reclaims and stale completion loses", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "retrace-lease-")), "ledger.db");
  const a = new SqliteStore(path);
  const b = new SqliteStore(path);
  await a.insertPendingDelivery({
    delivery_id: "delivery", project: "p", raw_body: "{}", received_at: "2026-09-10T12:00:00.000Z",
    repo: "acme/app", routing_state: "received",
  });
  const [one, two] = await Promise.all([
    a.claimPendingDeliveryLease("delivery", "owner-a", "2026-09-10T12:00:00.000Z", "2026-09-10T12:01:00.000Z"),
    b.claimPendingDeliveryLease("delivery", "owner-b", "2026-09-10T12:00:00.000Z", "2026-09-10T12:01:00.000Z"),
  ]);
  assert.equal([one, two].filter(Boolean).length, 1);
  const winner = one ? "owner-a" : "owner-b";
  const loser = one ? "owner-b" : "owner-a";
  assert.equal((one ?? two)!.lease_owner, winner);
  const reclaim = await b.claimPendingDeliveryLease("delivery", loser, "2026-09-10T12:01:01.000Z", "2026-09-10T12:02:01.000Z");
  assert.equal(reclaim?.lease_owner, loser);
  assert.equal(await a.updatePendingDeliveryIfLeaseOwner({ ...(one ?? two)!, state: "done" }, winner), false);
  assert.equal(await b.updatePendingDeliveryIfLeaseOwner({
    ...reclaim!, state: "terminal_failure", outcomes: '{"sha":{"status":"budget_failed","attempt_count":3}}',
  }, loser), true);
  assert.equal((await a.getPendingDelivery("delivery"))?.state, "terminal_failure");
  assert.match((await a.getPendingDelivery("delivery"))?.outcomes ?? "", /budget_failed/);
});

test("F14 SQLite: concurrent breaker outcomes from separate stores retry lost CAS updates", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "retrace-breaker-")), "ledger.db");
  const a = new SqliteStore(path);
  const b = new SqliteStore(path);
  await Promise.all([
    recordWebhookClassifyOutcome(a, "p", "deadline", 1_000, false),
    recordWebhookClassifyOutcome(b, "p", "deadline", 1_001, false),
    recordWebhookClassifyOutcome(a, "p", "deadline", 1_002, false),
  ]);
  const row = await b.getBreaker("p");
  assert.equal(row?.failures, 3);
  assert.equal(row?.state, "open");
});
