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

test("D1 in workerd: equality, prefix, and alias-suffix lookups include a U+0000 in the key", { timeout: 60_000 }, async () => {
  await withD1(async (db) => {
    const store = new D1Store(db);
    const memory = new MemoryEventStore();
    const path = `a\0b`;
    const hit = `repo:o/retrace#${path}`;
    const missExtra = `repo:o/retrace-extra#${path}`;
    const missCase = `repo:o/retrace#A\0b`;
    for (const id of [hit, missExtra, missCase]) {
      const input = { project: "p", actor: { type: "agent" as const, id: "A" }, action: "edited" as const, artifacts: [{ id, role: "generated" as const }] };
      await appendEvent(memory, input);
      await appendEvent(store, input);
    }
    const base = { project: "p", after_seq: -1, through_seq: 10, row_cap: 100, deadline: Date.now() + 30_000 };
    const cases: Record<string, ArtifactIndexQuery> = {
      suffix: { ...base, artifact_keys: [`repo:retrace#${path}`] },
      equality: { ...base, artifact_keys: [hit] },
      prefix: { ...base, artifact_keys: [], artifact_prefixes: [`repo:o/retrace#a\0`] },
    };
    for (const [name, q] of Object.entries(cases)) {
      const statements = eventsReferencingArtifactsStatements(q);
      assert.equal(statements.length, 1, name);
      assert.doesNotMatch(statements[0]!.sql, /\bGLOB\b|\bLIKE\b/, name);
      const plan = await db.prepare(`EXPLAIN QUERY PLAN ${statements[0]!.sql}`).bind(...statements[0]!.params).all();
      const details = (plan.results as { detail: string }[]).map((row) => row.detail);
      const indexSearches = details.filter((line) => /SEARCH i /.test(line));
      assert.ok(indexSearches.length >= 1, `${name}: ${details.join("\n")}`);
      for (const line of indexSearches) {
        assert.match(line, /idx_eai_project_key_seq \(project=\? AND artifact_key[=>]/, `${name}: workerd D1 still seeks the key range\n${details.join("\n")}`);
      }
      const got = await store.eventsReferencingArtifacts(q);
      const want = await memory.eventsReferencingArtifacts(q);
      assert.equal(got.ok, true, `${name}: D1 must not throw; got ${JSON.stringify(got)}`);
      assert.deepEqual(seqs(got), seqs(want), `${name}: workerd D1 must match the memory spec`);
      assert.deepEqual(seqs(got), [0], `${name}: hit a<NUL>b; retrace-extra and A<NUL>b must not match`);
    }
  });
});
