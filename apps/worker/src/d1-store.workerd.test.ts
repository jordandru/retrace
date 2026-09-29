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
