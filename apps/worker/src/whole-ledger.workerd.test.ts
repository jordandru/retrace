/** #237 PR 1 in workerd's D1 (Miniflare) with the production schema: the routes and MCP tools PR 1 moves give today's
 *  responses on the same rows, at tiny pages, for an intact ledger, tampered rows and attribution amendments. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { verifyProject } from "@retrace-dev/core";
import { D1Store } from "./d1-store.js";
import { P, assertSameResponses, seedLedger, tinyPages, todayStore } from "./whole-ledger-fixture.js";

const schemaSql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"), "utf8");

async function withD1(run: (db: D1Database) => Promise<void>) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{ name: "test", modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "pr237-workerd-test" }, compatibilityDate: "2025-06-01" }],
  }));
  try {
    const db = await mf.getD1Database("DB") as unknown as D1Database;
    for (const statement of schemaSql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean)) {
      if (/^INSERT OR IGNORE INTO event_artifact_index/.test(statement)) continue; // backfill: nothing to backfill on an empty database
      try {
        await db.prepare(statement).run();
      } catch (e) {
        if (!/duplicate column name/i.test(String((e as Error).message))) throw e;
      }
    }
    await run(db);
  } finally {
    await mf.dispose();
  }
}

test("D1 in workerd: verify, share verify, status and MCP verify/history/why match today's path", { timeout: 300_000 }, async () => {
  await withD1(async (db) => {
    const store = new D1Store(db);
    const ids = await seedLedger(store, 23, { amendments: [9], decoys: [4] });
    await db.prepare("UPDATE events SET action = 'other' WHERE project = ? AND seq = 4").bind(P).run();
    for (const [rows, chars] of [[1000, Number.MAX_SAFE_INTEGER], [4, Number.MAX_SAFE_INTEGER], [1000, 1]] as const) {
      const got = await assertSameResponses(tinyPages(store, rows, chars), `workerd rows=${rows} chars=${chars}`, { whyEventId: ids[20] });
      assert.deepEqual(JSON.parse(got.verify.body), { ok: true, checked: 23, legacy_events: 0 });
      assert.match(JSON.parse(got.mcp_history_all.body).content[0].text, /untrusted_snapshot/);
    }
    // A negative seq column is read first, as `all` reads it; the first page has no lower bound.
    await db.prepare("UPDATE events SET seq = -3 WHERE project = ? AND seq = 0").bind(P).run();
    assert.deepEqual(await verifyProject(tinyPages(store, 4), P), await verifyProject(todayStore(store), P));
    assert.equal((await verifyProject(tinyPages(store, 4), P)).checked, 23);
  });
});

test("D1 in workerd: tampered rows give today's verdict", { timeout: 300_000 }, async () => {
  const cases: Array<[string, string]> = [
    ["a changed body", "UPDATE events SET body = json_set(body, '$.intent', 'changed') WHERE project = ? AND seq = 7"],
    ["a seq gap", "DELETE FROM events WHERE project = ? AND seq = 11"],
    ["a body seq that disagrees with its row", "UPDATE events SET body = json_set(body, '$.seq', 40) WHERE project = ? AND seq = 5"],
    ["a body project that disagrees with its row", "UPDATE events SET body = json_set(body, '$.project', 'elsewhere') WHERE project = ? AND seq = 13"],
    ["a last body whose hash disagrees with the row", "UPDATE events SET body = json_set(body, '$.hash', '" + "f".repeat(64) + "') WHERE project = ? AND seq = 15"],
  ];
  for (const [label, sql] of cases) {
    await withD1(async (db) => {
      const store = new D1Store(db);
      const ids = await seedLedger(store, 16);
      await db.prepare(sql).bind(P).run();
      const got = await assertSameResponses(tinyPages(store, 4), `workerd ${label}`, { whyEventId: ids[14] });
      assert.equal(JSON.parse(got.verify.body).ok, false, label);
    });
  }
});

test("D1 in workerd: a TEXT seq column falls back to today's read, with a tamper past page one", { timeout: 300_000 }, async () => {
  for (const at of [15, 6]) {
    await withD1(async (db) => {
      const store = new D1Store(db);
      const ids = await seedLedger(store, 16);
      await db.prepare("UPDATE events SET body = json_set(body, '$.intent', 'changed') WHERE project = ? AND seq = 10").bind(P).run();
      await db.prepare("UPDATE events SET seq = 'not-an-integer' WHERE project = ? AND seq = ?").bind(P, at).run();
      assert.equal((await db.prepare("SELECT typeof(seq) AS t FROM events WHERE id = ?").bind(ids[at]).first<{ t: string }>())?.t, "text");
      const got = await assertSameResponses(tinyPages(store, 4), `workerd TEXT seq at #${at}`, { whyEventId: ids[12] });
      assert.equal(JSON.parse(got.verify.body).ok, false, "the tamper at #10 is reported");
    });
  }
});
