/** Runs `eventsReferencingArtifacts` against D1 in workerd itself (Miniflare) with the production schema, because
 *  workerd enforces limits ordinary SQLite does not: 100 bound parameters and SQLITE_LIMIT_COMPOUND_SELECT = 5
 *  (PR 51 round 6, Codex F4 — the round-6 shape passed every SQLite double and failed here). Membership is checked
 *  against `MemoryEventStore`, the specification. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { MemoryEventStore, appendEvent, eventsReferencingArtifactsStatements } from "@retrace-dev/core";
import type { ArtifactIndexQuery, Event } from "@retrace-dev/core";
import { D1Store } from "./d1-store.js";

const schemaSql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"), "utf8");

async function withD1(run: (db: D1Database) => Promise<void>) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{ name: "test", modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "pr51-workerd-test" }, compatibilityDate: "2025-06-01" }],
  }));
  try {
    const db = await mf.getD1Database("DB") as unknown as D1Database;
    for (const statement of schemaSql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean)) {
      if (/^INSERT OR IGNORE INTO event_artifact_index/.test(statement)) continue; // backfill: nothing to backfill on an empty database
      try {
        await db.prepare(statement).run();
      } catch (e) {
        if (!/duplicate column name/i.test(String((e as Error).message))) throw e; // ALTER TABLE … ADD COLUMN on a fresh schema, as migrate.mjs tolerates
      }
    }
    await run(db);
  } finally {
    await mf.dispose();
  }
}

function seqs(r: { ok: true; events: Event[] } | { ok: false; reason: string }) {
  return r.ok ? r.events.map((e) => e.seq) : r;
}

test("D1 in workerd: the four-file classifier query is one statement and matches the memory spec", { timeout: 60_000 }, async () => {
  await withD1(async (db) => {
    const store = new D1Store(db);
    const memory = new MemoryEventStore();
    const fixtures: string[][] = [
      ["repo:acme/app#src/a.ts", "file:src/a.ts"],
      ["repo:other/app#src/b.ts"],
      ["repo:acme/old-name#src/c.ts", "task:1"],
      ["repo:acme/app#src/z.ts"],
      ["😀", "x:\uffff\uffff", "x:\ue000", "\u{10ffff}x"],
      ["task:85", "task:170", "task:499", "task:500"],
    ];
    for (const ids of fixtures) {
      const input = { project: "p", actor: { type: "agent" as const, id: "A" }, action: "edited" as const, artifacts: ids.map((id) => ({ id, role: "generated" as const })) };
      await appendEvent(memory, input);
      await appendEvent(store, input);
    }
    const base = { project: "p", after_seq: -1, through_seq: 100, row_cap: 100, deadline: Date.now() + 30_000 };
    const cases: Record<string, ArtifactIndexQuery> = {
      fourFiles: { ...base, artifact_keys: ["a.ts", "b.ts", "c.ts", "d.ts"].flatMap((f) => [`repo:acme/app#src/${f}`, `repo:app#src/${f}`, `repo:old-name#src/${f}`, `file:src/${f}`, `src/${f}`]) },
      manyKeysAndPrefix: { ...base, artifact_keys: Array.from({ length: 501 }, (_, i) => `task:${i}`), artifact_prefixes: ["task:"] },
      window: { ...base, after_seq: 1, through_seq: 3, artifact_keys: ["repo:acme/app#src/a.ts", "task:1", "repo:acme/app#src/z.ts"] },
      emptyPrefix: { ...base, artifact_keys: [], artifact_prefixes: [""] },
      ffffPrefix: { ...base, artifact_keys: [], artifact_prefixes: ["x:\uffff"] },
      d7ffPrefix: { ...base, artifact_keys: [], artifact_prefixes: ["x:\ud7ff"] },
      allMaxPrefix: { ...base, artifact_keys: [], artifact_prefixes: ["\u{10ffff}"] },
      twoKeysOneEventCap: { ...base, row_cap: 1, artifact_keys: ["task:85", "task:170"] },
      overlapCountsOnce: { ...base, row_cap: 1, artifact_keys: ["😀"], artifact_prefixes: ["😀"] },
      // `task:1` matches task:1 (seq 2) and task:170 (seq 5) and `task:` matches those plus task:85/499/500 — five distinct
      // rows, two of them reached twice (Codex round-8 N1: `task:0` matched nothing, so the earlier cases never overlapped)
      sameKindOverlapOverBudget: { ...base, row_cap: 4, artifact_keys: [], artifact_prefixes: ["task:", "task:1"] },
      sameKindOverlapSufficient: { ...base, row_cap: 5, artifact_keys: [], artifact_prefixes: ["task:", "task:1"] },
    };
    for (const [name, q] of Object.entries(cases)) {
      const statements = eventsReferencingArtifactsStatements(q);
      for (const st of statements) {
        assert.ok(st.params.length <= 100, `${name}: ${st.params.length} parameters`);
        assert.ok((st.sql.match(/ UNION /g) ?? []).length + 1 <= 5, `${name}: compound terms`);
      }
      if (name === "fourFiles") assert.equal(statements.length, 1, "the four-file query is one statement");
      const got = await store.eventsReferencingArtifacts(q);
      const want = await memory.eventsReferencingArtifacts(q);
      assert.deepEqual(seqs(got), seqs(want), `${name}: workerd D1 must match the memory spec`);
    }
    assert.deepEqual(await store.eventsReferencingArtifacts(cases.twoKeysOneEventCap!), { ok: false, reason: "budget" }, "two matching artifact rows on one event exceed row_cap 1");
    assert.deepEqual(seqs(await store.eventsReferencingArtifacts(cases.overlapCountsOnce!)), [4], "one artifact reached by a key and a prefix counts once (seq 4 is the fifth event)");
    assert.deepEqual(await store.eventsReferencingArtifacts(cases.sameKindOverlapOverBudget!), { ok: false, reason: "budget" }, "overlapping prefixes of one kind: five distinct task rows exceed row_cap 4 even though duplicates would fit LIMIT 5 (round 7, Codex F5)");
    assert.deepEqual(seqs(await store.eventsReferencingArtifacts(cases.sameKindOverlapSufficient!)), [2, 5], "overlapping prefixes of one kind: every event, not the first event's duplicates");
  });
});

test("D1 in workerd: this harness enforces the five-term compound limit the round-6 shape hit", { timeout: 60_000 }, async () => {
  await withD1(async (db) => {
    const union = (n: number) => Array.from({ length: n }, (_, i) => `SELECT ${i}`).join(" UNION ");
    await db.prepare(union(5)).all();
    await assert.rejects(db.prepare(union(6)).all(), /too many terms in compound SELECT/);
  });
});

test("D1 in workerd: alias lookup whose old GLOB exceeded 50 bytes returns the matching row", { timeout: 60_000 }, async () => {
  await withD1(async (db) => {
    const glob50 = "a".repeat(50);
    const glob51 = "a".repeat(51);
    await db.prepare("SELECT 'x' GLOB ?").bind(glob50).all();
    await assert.rejects(db.prepare("SELECT 'x' GLOB ?").bind(glob51).all(), /LIKE or GLOB pattern too complex/);

    const path = "packages/mcp-server/src/sqlite-store.test.ts";
    const oldGlob = `repo:*/retrace#${path}`;
    assert.equal(new TextEncoder().encode(oldGlob).length, 59);
    assert.ok(new TextEncoder().encode(oldGlob).length > 50);

    const store = new D1Store(db);
    const memory = new MemoryEventStore();
    const hit = `repo:jordandru/retrace#${path}`;
    const miss = `repo:jordandru/retrace-extra#${path}`;
    for (const id of [hit, miss]) {
      const input = { project: "p", actor: { type: "agent" as const, id: "A" }, action: "edited" as const, artifacts: [{ id, role: "generated" as const }] };
      await appendEvent(memory, input);
      await appendEvent(store, input);
    }
    const q: ArtifactIndexQuery = {
      project: "p", artifact_keys: [`repo:retrace#${path}`], after_seq: -1, through_seq: 10, row_cap: 100, deadline: Date.now() + 30_000,
    };
    for (const st of eventsReferencingArtifactsStatements(q)) {
      assert.doesNotMatch(st.sql, /\bGLOB\b|\bLIKE\b/);
    }
    const got = await store.eventsReferencingArtifacts(q);
    const want = await memory.eventsReferencingArtifacts(q);
    assert.equal(got.ok, true, `D1 must not throw store_error; got ${JSON.stringify(got)}`);
    assert.deepEqual(seqs(got), seqs(want), "workerd D1 must match the memory spec");
    assert.deepEqual(seqs(got), [0], "hit owner/retrace#path; near-miss retrace-extra must not match");
  });
});

test("D1 in workerd: refuses NUL and unpaired surrogates and accepts an astral-plane path", { timeout: 60_000 }, async () => {
  await withD1(async (db) => {
    const store = new D1Store(db);
    const high = "repo:o/retrace#a\uD800b";
    const low = "repo:o/retrace#a\uDC00b";
    const nul = "repo:o/retrace#a\0b";
    const astral = "repo:o/retrace#😀.ts";
    for (const [id, re] of [[nul, /U\+0000/], [high, /unpaired surrogates/], [low, /unpaired surrogates/]] as const) {
      await assert.rejects(
        () => appendEvent(store, { project: "p", actor: { type: "agent" as const, id: "A" }, action: "edited" as const, artifacts: [{ id, role: "generated" as const }] }),
        (e: unknown) => e instanceof Error && re.test(e.message),
      );
    }
    const { event } = await appendEvent(store, { project: "p", actor: { type: "agent" as const, id: "A" }, action: "edited" as const, artifacts: [{ id: astral, role: "generated" as const }] });
    assert.equal(event.artifacts[0]?.id, astral);
    const q: ArtifactIndexQuery = {
      project: "p", artifact_keys: [`repo:retrace#😀.ts`], after_seq: -1, through_seq: 10, row_cap: 100, deadline: Date.now() + 30_000,
    };
    for (const st of eventsReferencingArtifactsStatements(q)) {
      assert.doesNotMatch(st.sql, /\bGLOB\b|\bLIKE\b/);
    }
    const got = await store.eventsReferencingArtifacts(q);
    assert.equal(got.ok, true, `D1 must not throw; got ${JSON.stringify(got)}`);
    assert.deepEqual(seqs(got), [0]);
  });
});

test("D1 in workerd: suffix lookup drops the U+FFFE/U+FFFF false positive old GLOB admitted", { timeout: 60_000 }, async () => {
  await withD1(async (db) => {
    const stored = "repo:o/retrace#\uFFFE";
    const store = new D1Store(db);
    await appendEvent(store, { project: "p", actor: { type: "agent" as const, id: "A" }, action: "edited" as const, artifacts: [{ id: stored, role: "generated" as const }] });
    const glob = await db.prepare("SELECT COUNT(*) AS n FROM event_artifact_index WHERE artifact_key GLOB ?").bind("repo:*/retrace#\uFFFF").all() as { results: { n: number }[] };
    assert.equal(glob.results[0]?.n, 1, "old GLOB overmatched U+FFFE against U+FFFF");
    const q: ArtifactIndexQuery = {
      project: "p", artifact_keys: ["repo:retrace#\uFFFF"], after_seq: -1, through_seq: 10, row_cap: 100, deadline: Date.now() + 30_000,
    };
    for (const st of eventsReferencingArtifactsStatements(q)) {
      assert.doesNotMatch(st.sql, /\bGLOB\b|\bLIKE\b/);
    }
    const got = await store.eventsReferencingArtifacts(q);
    assert.equal(got.ok, true, `D1 must not throw; got ${JSON.stringify(got)}`);
    assert.deepEqual(seqs(got), [], "new byte predicate must not restore the overmatch");
    const trueAlias = await store.eventsReferencingArtifacts({
      ...q, artifact_keys: ["repo:retrace#\uFFFE"],
    });
    assert.deepEqual(seqs(trueAlias), [0]);
  });
});

test("T18 §1.2 D1 pending gh_event round-trip, redelivery receipt and NULL migration", async () => {
  await withD1(async db => {
    const store = new D1Store(db);
    const row = { delivery_id: "comment", project: "p", gh_event: "issue_comment", raw_body: "{}", received_at: "2026-09-28T00:00:00Z" };
    await store.insertPendingDelivery(row);
    await store.insertPendingDelivery({ ...row, gh_event: "push", received_at: "later" });
    await store.insertPendingDelivery({ ...row, delivery_id: "legacy", gh_event: null });
    assert.equal((await store.getPendingDelivery("comment"))!.gh_event, "issue_comment");
    assert.equal((await store.getPendingDelivery("comment"))!.received_at, row.received_at);
    assert.equal((await store.getPendingDelivery("legacy"))!.gh_event, null);
    assert.equal((await store.claimPendingDeliveryLease("comment", "owner", "2026-09-29T00:00:00Z", "2026-09-29T00:01:00Z"))!.gh_event, "issue_comment");
  });
});

test("T17 workerd consumption batch rolls back on either constraint and reads over 100 ids at U", async () => {
  await withD1(async db => {
    const { ownerLoginScenario } = await import("../../../packages/core/dist/owner-login-fixture.js");
    const { appendOwnerLoginEvent, ownerLoginRecord } = await import("@retrace-dev/core");
    const store = new D1Store(db), f = await ownerLoginScenario(store);
    const first = await appendOwnerLoginEvent(store, f.input, f.policy, f.repo, Date.now()+5000);
    const second = await appendOwnerLoginEvent(store, { ...f.input, idempotency_key: "second" }, f.policy, f.repo, Date.now()+5000);
    assert.equal(ownerLoginRecord(first.event)!.decision.status, "declared_by_seat");
    assert.equal(ownerLoginRecord(second.event)!.decision.status, "unresolved");
    const ids = [...Array.from({ length: 200 }, (_, i) => `absent-${i}`), f.declaration.id];
    assert.deepEqual(await store.ownerLoginConsumptionUpTo(f.project, ids, 0, { deadline: Date.now()+2000, row_cap: 2 }), { ok: true, rows: [] });
    const rows = await store.ownerLoginConsumptionUpTo(f.project, ids, second.event.seq, { deadline: Date.now()+2000, row_cap: 2 });
    assert.equal(rows.ok && rows.rows.length, 1);
    await assert.rejects(store.insert({ ...first.event, id: "bad" }, { owner_login_consumption: [{ declaration_event_id: "unused" }] }), /UNIQUE/);
    assert.equal(await store.ownerLoginConsumptionRow(f.project, "unused"), null);
    await assert.rejects(store.insert({ ...first.event, id: "bad2", seq: 3 }, { owner_login_consumption: [{ declaration_event_id: f.declaration.id }] }), /owner_login_consumption/);
    assert.equal(await store.get("bad2"), null);
    assert.equal((await store.all(f.project)).length, 3);
  });
});

test("D1 in workerd: owner-login amendment capture reads all 11 files of 5d7290f", { timeout: 60_000 }, async () => {
  await withD1(async db => {
    const { ownerLoginScenario } = await import("../../../packages/core/dist/owner-login-fixture.js");
    const { appendOwnerLoginEvent, ownerLoginRecord } = await import("@retrace-dev/core");
    // git show --format= --name-only 5d7290f: the production amendment's target files.
    const paths = [
      "packages/core/src/producer-sig.test.ts",
      "packages/core/src/producer-sig.ts",
      "packages/mcp-server/README.md",
      "packages/mcp-server/src/admin.test.ts",
      "packages/mcp-server/src/admin.ts",
      "packages/mcp-server/src/export-cli.test.ts",
      "packages/mcp-server/src/export-cli.ts",
      "packages/mcp-server/src/git-hook.test.ts",
      "packages/mcp-server/src/git-hook.ts",
      "packages/mcp-server/src/producer-key.test.ts",
      "packages/mcp-server/src/producer-key.ts",
    ];
    const oldPatterns = paths.map(path => `repo:*/retrace#${path}`);
    assert.equal(oldPatterns.filter(pattern => Buffer.byteLength(pattern) > 50).length, 7);
    assert.equal(Math.max(...oldPatterns.map(pattern => Buffer.byteLength(pattern))), 59);

    const store = new D1Store(db), f = await ownerLoginScenario(store);
    f.policy.body.repositories.push({ name: "jordandru/retrace", aliases: ["retrace"] });
    const root = (await appendEvent(store, { project: f.project, actor: { type: "human", id: "owner" },
      action: "instructed", artifacts: [{ id: "task:amendment", role: "used" }] })).event;
    const files = paths.map(path => ({ id: `repo:jordandru/retrace#${path}`, role: "generated" as const }));
    const evidence = (await appendEvent(store, { project: f.project, actor: { type: "agent", id: "other" },
      action: "edited", artifacts: files, caused_by: root.id })).event;
    const target = (await appendEvent(store, { project: f.project, actor: { type: "agent", id: "codex" },
      action: "edited", artifacts: files, caused_by: root.id })).event;
    await appendEvent(store, { project: f.project, actor: root.actor, action: "other", action_detail: "amended",
      tags: ["amendment", "attribution"], intent: "synthetic correction with the production target's file set",
      caused_by: root.id, artifacts: [{ id: `event:${target.id}`, role: "used" }, { id: `event:${evidence.id}`, role: "used" }],
      method: { tool: "retrace_amend", params: { sealed_by: "owner", target_event_id: target.id,
        attribution: { from: target.actor, to: evidence.actor, evidence: [evidence.id] } } } });

    const { classifyOwnerLogin } = await import("@retrace-dev/core");
    const clock = Date.now(), readHead = (await store.head(f.project))!;
    const measured = await classifyOwnerLogin({ store, input: f.input, policy: f.policy, canonicalR: f.repo,
      readHead, deadline: clock + 5000, now: () => clock });
    const timingFault = await classifyOwnerLogin({ store, input: f.input, policy: f.policy, canonicalR: f.repo,
      readHead, deadline: clock + 5000, now: () => clock, amendmentsTimingCapture: () => { throw new Error("capture fault"); } });
    assert.equal(measured.kind, "decision"); assert.equal(timingFault.kind, "decision");
    if (measured.kind !== "decision" || timingFault.kind !== "decision") throw new Error("fixture");
    const measuredDecision = structuredClone(ownerLoginRecord(measured.input)!.decision);
    const uninstrumentedDecision = structuredClone(ownerLoginRecord(timingFault.input)!.decision);
    const calls = measuredDecision.timing.amendments_calls!;
    assert.deepEqual(calls.map((entry) => entry.call), ["amendment_rows", "dependencies", "capture_targets"]);
    for (const entry of calls) {
      assert.ok(entry.body_chars > 0, JSON.stringify(entry));
      assert.ok(entry.parse_ms >= 0, JSON.stringify(entry));
      assert.ok(typeof entry.sql_ms === "number" && entry.sql_ms >= 0, JSON.stringify(entry));
      assert.equal(entry.statements, 1, JSON.stringify(entry));
      assert.equal(entry.outcome, "ok");
    }
    assert.equal(uninstrumentedDecision.timing.amendments_calls, undefined);
    delete measuredDecision.timing.amendments_calls;
    assert.equal(JSON.stringify(measuredDecision), JSON.stringify(uninstrumentedDecision),
      "after removing the observation field, instrumentation must leave byte-identical decision JSON");

    const captureReads: { query: ArtifactIndexQuery; result: Awaited<ReturnType<D1Store["eventsReferencingArtifacts"]>> }[] = [];
    const read = store.eventsReferencingArtifacts.bind(store);
    store.eventsReferencingArtifacts = async (query, now) => {
      const result = await read(query, now);
      if (query.artifact_keys.some(key => key.startsWith("repo:retrace#"))) captureReads.push({ query, result });
      return result;
    };
    const appended = await appendOwnerLoginEvent(store, f.input, f.policy, f.repo);
    assert.equal(captureReads.length, 1, "owner-login must reach amendmentCaptureDependencies' file read");
    const capture = captureReads[0]!;
    assert.deepEqual(capture.query.artifact_keys.filter(key => key.startsWith("repo:retrace#")).sort(),
      paths.map(path => `repo:retrace#${path}`).sort());
    assert.equal(capture.result.ok, true, `amendment capture read: ${JSON.stringify(capture.result)}`);
    if (capture.result.ok) assert.deepEqual(capture.result.events.map(e => e.id), [evidence.id, target.id]);
    const decision = ownerLoginRecord(appended.event)!.decision;
    assert.equal(decision.status, "declared_by_seat", JSON.stringify(decision));
    assert.equal(decision.timing.stage_failed, null);
    assert.deepEqual(decision.consumed, [f.declaration.id]);
  });
});
