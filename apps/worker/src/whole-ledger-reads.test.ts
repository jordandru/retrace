/**
 * #237 PR 1: the paged reader (`eventRowsPage`, `readProjectPages`), `verifyProject` over it, and the MCP attribution
 * note through `amendmentEventsUpTo`. Today's path and the new one run on the same D1 rows (node:sqlite behind the D1
 * interface) and must give the same responses: `/projects/:p/verify`, `/s/:id/verify`, `buildProjectStatus` JSON at a
 * fixed `now`, and MCP `verify`, `history` and `why`. Synthetic ledgers only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { appendEvent, verifyProject } from "@retrace-dev/core";
import type { EventStore } from "@retrace-dev/core";
import { P, assertSameResponses, responses, seedLedger, sqliteD1, tinyPages, todayStore } from "./whole-ledger-fixture.js";

const json = (o: { body: string }) => JSON.parse(o.body);

test("differential: ledgers of 0, 1, page − 1, page, page + 1 and 2,500 events, default pages", { timeout: 600_000 }, async () => {
  for (const n of [0, 1, 999, 1000, 1001, 2500]) {
    const { store } = sqliteD1();
    const ids = await seedLedger(store, n);
    const got = await assertSameResponses(store, `n=${n}`, { whyEventId: ids.at(-1) });
    assert.deepEqual(json(got.verify), { ok: true, checked: n, legacy_events: 0 }, `n=${n}`);
  }
});

test("differential: tiny pages by rows and by characters", { timeout: 300_000 }, async () => {
  for (const [rows, chars] of [[4, Number.MAX_SAFE_INTEGER], [1000, 1], [4, 700]] as const) {
    for (const n of [0, 1, 3, 4, 5, 41]) {
      const { store } = sqliteD1();
      const ids = await seedLedger(store, n);
      const got = await assertSameResponses(tinyPages(store, rows, chars), `n=${n} rows=${rows} chars=${chars}`, { whyEventId: ids.at(-1) });
      assert.equal(json(got.verify).checked, n);
    }
  }
});

/** A 30-event ledger read in pages of 4 rows, tampered in storage with `sql`. */
async function tampered(sql: string, params: (string | number)[] = []) {
  const { sqlite, store } = sqliteD1();
  const ids = await seedLedger(store, 30);
  sqlite.prepare(sql).run(...params);
  return { store: tinyPages(store, 4), ids, sqlite };
}

test("differential: tampering is the same verdict on both paths", { timeout: 300_000 }, async () => {
  const cases: Array<[string, string, (string | number)[], Record<string, unknown>]> = [
    ["a changed body", "UPDATE events SET body = json_set(body, '$.intent', 'changed') WHERE project = ? AND seq = 9", [P], { ok: false, first_bad_seq: 9, reason: "content hash mismatch (event tampered)" }],
    ["a seq gap", "DELETE FROM events WHERE project = ? AND seq = 13", [P], { ok: false, first_bad_seq: 14, reason: "sequence gap: expected 13, got 14" }],
    ["a prev_hash mismatch", "UPDATE events SET body = json_set(body, '$.prev_hash', '" + "0".repeat(64) + "') WHERE project = ? AND seq = 17", [P], { ok: false, first_bad_seq: 17, reason: "prev_hash mismatch (chain broken)" }],
    ["a body seq that disagrees with its row", "UPDATE events SET body = json_set(body, '$.seq', 99) WHERE project = ? AND seq = 6", [P], { ok: false, first_bad_seq: 99, reason: "sequence gap: expected 6, got 99" }],
    ["a body project that disagrees with its row", "UPDATE events SET body = json_set(body, '$.project', 'elsewhere') WHERE project = ? AND seq = 21", [P], { ok: false, first_bad_seq: 21, reason: "content hash mismatch (event tampered)" }],
    ["a last body whose hash disagrees with the row", "UPDATE events SET body = json_set(body, '$.hash', '" + "f".repeat(64) + "') WHERE project = ? AND seq = 29", [P], { ok: false, first_bad_seq: 29, reason: "content hash mismatch (event tampered)" }],
    ["a last row whose hash column disagrees with its body", "UPDATE events SET hash = ? WHERE project = ? AND seq = 29", ["e".repeat(64), P], { ok: true, checked: 30 }],
    ["a row whose action column disagrees with its body", "UPDATE events SET action = 'deleted' WHERE project = ? AND seq = 10", [P], { ok: true, checked: 30 }],
    ["a row whose id column disagrees with its body", "UPDATE events SET id = 'evt_column_only' WHERE project = ? AND seq = 11", [P], { ok: true, checked: 30 }],
    // `all` reads a negative column seq first; a reader that started at seq > -1 would skip the row and report a gap.
    ["a row whose seq column is negative", "UPDATE events SET seq = -5 WHERE project = ? AND seq = 0", [P], { ok: true, checked: 30 }],
  ];
  for (const [label, sql, params, expected] of cases) {
    const { store, ids } = await tampered(sql, params);
    const got = await assertSameResponses(store, label, { whyEventId: ids[25] });
    const verdict = json(got.verify);
    for (const [k, v] of Object.entries(expected)) assert.deepEqual(verdict[k], v, `${label}: ${k}`);
    assert.deepEqual(json(got.status_json).integrity, verdict, `${label}: status integrity is the verify verdict`);
  }
});

test("a body that is not JSON: verify and status fail as today's path fails; the MCP note no longer reads it", { timeout: 120_000 }, async () => {
  for (const seq of [2, 29]) {
    const { store, ids } = await tampered("UPDATE events SET body = '{not json' WHERE project = ? AND seq = ?", [P, seq]);
    // why on #0, an instruction with no cause, so the chain never reaches the bad row.
    const now = await responses(store, { whyEventId: ids[0] });
    const today = await responses(todayStore(store), { whyEventId: ids[0] });
    for (const key of ["verify", "share_verify", "status_json", "verify_direct", "mcp_verify"]) assert.deepEqual(now[key], today[key], `seq ${seq}: ${key}`);
    assert.equal(now.verify.status, 500);
    assert.match(now.verify_direct.body, /^threw SyntaxError: /);
    // A history page that holds the bad row fails on both paths, before the note (the default limit covers all 30 rows).
    assert.deepEqual(now.mcp_history_all, today.mcp_history_all, `seq ${seq}: mcp_history_all`);
    assert.equal(now.mcp_history_all.status, 1);
    // Otherwise today's history and why fail loading every body for the note; the note now reads amendment candidates only.
    const answers = seq === 2 ? ["mcp_history", "mcp_why"] : ["mcp_why"];
    if (seq === 29) assert.deepEqual(now.mcp_history, today.mcp_history, "the newest seven rows hold #29");
    for (const key of answers) {
      assert.equal(today[key].status, 1, `seq ${seq}: today's ${key} is an error`);
      assert.match(today[key].body, /JSON/);
      assert.equal(now[key].status, 0, `seq ${seq}: ${key} now answers`);
    }
  }
});

test("a chain failure before a later non-JSON body still throws, as today", async () => {
  const { sqlite, store } = sqliteD1();
  await seedLedger(store, 30);
  sqlite.prepare("UPDATE events SET body = json_set(body, '$.intent', 'changed') WHERE project = ? AND seq = 1").run(P);
  sqlite.prepare("UPDATE events SET body = '[' WHERE project = ? AND seq = 28").run(P);
  const paged = tinyPages(store, 4);
  const today = await verifyProject(todayStore(paged), P).then(() => "resolved", (e: Error) => `${e.name}: ${e.message}`);
  const now = await verifyProject(paged, P).then(() => "resolved", (e: Error) => `${e.name}: ${e.message}`);
  assert.match(today, /^SyntaxError/);
  assert.equal(now, today);
});

test("attribution note: none, one and several amendments, and candidates the column admits but the body refutes", { timeout: 300_000 }, async () => {
  const unavailable = /attribution evaluation unavailable: untrusted_snapshot/;
  for (const [label, amendments] of [["none", []], ["one", [12]], ["several", [3, 12, 27]]] as const) {
    const { store } = sqliteD1();
    const ids = await seedLedger(store, 30, { amendments: [...amendments] });
    const got = await assertSameResponses(tinyPages(store, 4), `amendments ${label}`, { whyEventId: ids[amendments[0] ?? 20] });
    if (amendments.length) assert.match(json(got.mcp_history_all).content[0].text, unavailable, label);
    else assert.doesNotMatch(json(got.mcp_history_all).content[0].text, unavailable, label);
  }
  // A body that is not an amendment (action edited) under an `action` column changed to `other`: the index admits it, the
  // body refutes it, and the chain stays intact. Alone, and before a real amendment: the note scans the bodies and agrees.
  const refuted = async (amendments: number[]) => {
    const { sqlite, store } = sqliteD1();
    const ids = await seedLedger(store, 30, { amendments, decoys: [8] });
    sqlite.prepare("UPDATE events SET action = 'other' WHERE project = ? AND seq = 8").run(P);
    return { store: tinyPages(store, 4), ids };
  };
  for (const [label, later] of [["alone", []], ["before a real amendment", [19]]] as const) {
    const { store, ids } = await refuted([...later]);
    const [candidate] = await store.amendmentEventsUpTo!(P, 29, 1);
    assert.equal(candidate?.seq, 8, "the column admits the refuted row first");
    const got = await assertSameResponses(store, `refuted ${label}`, { whyEventId: ids[20] });
    assert.equal(json(got.verify).ok, true, "only a column changed");
    assert.equal(unavailable.test(json(got.mcp_history_all).content[0].text), later.length > 0, label);
  }
});

test("attribution note: an amendment body under an `action` column that is not `other` is not a candidate (stated divergence)", async () => {
  const { sqlite, store } = sqliteD1();
  const ids = await seedLedger(store, 30, { amendments: [12] });
  sqlite.prepare("UPDATE events SET action = 'edited' WHERE project = ? AND seq = 12").run(P);
  const now = await responses(store, { whyEventId: ids[20] });
  const today = await responses(todayStore(store), { whyEventId: ids[20] });
  for (const key of ["verify", "share_verify", "status_json", "verify_direct", "mcp_verify"]) assert.deepEqual(now[key], today[key], key);
  // Today's note reads the body and says the evaluation is unavailable; the indexed read never sees the row.
  assert.match(json(today.mcp_history_all).content[0].text, /untrusted_snapshot/);
  assert.doesNotMatch(json(now.mcp_history_all).content[0].text, /untrusted_snapshot/);
  assert.match(json(now.mcp_history_all).content[0].text, /^#0 /, "no banner: the empty collection prints none");
});

test("D1 queries per request: /verify is 1 + one per page; MCP history and why read no page", { timeout: 600_000 }, async (t) => {
  const counts: Record<string, number> = {};
  for (const n of [0, 1001, 2500]) {
    const { d1, store } = sqliteD1();
    const ids = await seedLedger(store, n, n ? { amendments: [7] } : {});
    const before = d1.queries;
    const verdict = await verifyProject(store, P);
    const verifyQueries = d1.queries - before;
    assert.equal(verdict.checked, n);
    assert.equal(verifyQueries, 1 + Math.ceil(n / 1000), `n=${n}: the head, then one query per 1,000-row page`);
    const tiny = d1.queries;
    await verifyProject(store, P, { pageChars: 1 });
    assert.equal(d1.queries - tiny, 1 + n, `n=${n}: a one-character budget is one row per page`);
    // why on #0 (an instruction, no cause): a chain of one, so only the note could make it grow.
    const mcp = await mcpQueryCounts(store, d1, ids[0]);
    counts[`verify n=${n}`] = verifyQueries;
    counts[`mcp_history n=${n}`] = mcp.history;
    counts[`mcp_why n=${n}`] = mcp.why;
  }
  assert.equal(counts["mcp_history n=1001"], counts["mcp_history n=2500"], "history's queries do not grow with the ledger");
  assert.equal(counts["mcp_why n=1001"], counts["mcp_why n=2500"], "why's queries do not grow with the ledger");
  t.diagnostic(`D1 queries: ${JSON.stringify(counts)}`);
});

/** Statement counts of one MCP history and one why call against `store`'s counting D1. */
async function mcpQueryCounts(store: EventStore, d1: { queries: number }, whyId: string | undefined) {
  const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
  const { authenticateRemoteMcp, buildRemoteMcpServer } = await import("./mcp.js");
  const { createHandler, parseCredentials } = await import("@retrace-dev/core");
  const creds = JSON.stringify([{ token: "count-token-000000000000000000000", name: "count", actor: { type: "agent", id: "fixture-agent", on_behalf_of: "owner@example.com" }, trust: "pinned", projects: [P] }]);
  const parsed = await authenticateRemoteMcp(new Request("https://retrace.example/mcp", { headers: { authorization: "Bearer count-token-000000000000000000000" } }), creds);
  const server = buildRemoteMcpServer(store, parsed!, { requestUrl: "https://retrace.example/mcp", apiHandler: createHandler(store, { credentials: parseCredentials(creds) }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "count", version: "0.1" });
  await client.connect(a);
  let at = d1.queries;
  await client.callTool({ name: "retrace_history", arguments: { limit: 5 } });
  const history = d1.queries - at;
  at = d1.queries;
  if (whyId) await client.callTool({ name: "retrace_why", arguments: { event_id: whyId } });
  const why = d1.queries - at;
  await client.close();
  return { history, why };
}

test("snapshot: events appended during a paged verify change neither the verdict nor checked", async () => {
  const { store } = sqliteD1();
  await seedLedger(store, 23);
  const expected = await verifyProject(todayStore(store), P);
  let appended = 0;
  const racing: EventStore = new Proxy(store, {
    get(target, key) {
      if (key === "eventRowsPage") return async (...args: Parameters<NonNullable<EventStore["eventRowsPage"]>>) => {
        const page = await target.eventRowsPage!(...args);
        await appendEvent(target, { project: P, actor: { type: "agent", id: "late" }, action: "edited", artifacts: [{ id: `task:late-${appended++}` }] });
        return page;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const got = await verifyProject(racing, P, { pageRows: 5 });
  assert.deepEqual(got, expected);
  assert.equal(got.checked, 23);
  assert.equal(appended, 5, "one append after each of the five pages");
  assert.equal((await verifyProject(store, P)).checked, 28, "the appended events are on the chain afterwards");
});
