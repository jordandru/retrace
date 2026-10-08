import assert from "node:assert/strict";
import test from "node:test";
import { captureReadContract } from "./capture-read-fixture.js";
import { MemoryEventStore } from "./mem-store.js";
import { CaptureIndexHit, runCaptureIndexStatements } from "./store.js";
captureReadContract("Memory", () => new MemoryEventStore());
test("capture runner rejects malformed fields, missing fallback bodies and truncated key arrays", async () => {
  const query = { project: "p", artifact_keys: ["task:1"], after_seq: -1, through_seq: 10, row_cap: 10, deadline: Infinity };
  const valid = { seq: 1, keys: '["task:1"]', action: "read", stamped: 0, body: null };
  for (const patch of [{ seq: 1.1 }, { seq: "1" }, { keys: null }, { keys: '[]' }, { keys: '[1]' }, { keys: '["task:1"' },
    { keys: '["task:1","task:1"]' }, { stamped: undefined }, { stamped: 2 }, { stamped: null }, { action: undefined }, { action: "nonsense" },
    { action: "committed" }, { body: '{}' }, { body: undefined }, { stamped: null, body: 'null' }, { stamped: null, body: '{' }]) {
    assert.deepEqual(await runCaptureIndexStatements(query, () => 0, async () => [{ ...valid, ...patch } as CaptureIndexHit]),
      { ok: false, reason: "store_error" }, JSON.stringify(patch));
  }
  assert.deepEqual(await runCaptureIndexStatements(query, () => 0, async () => { throw new Error("SQL"); }), { ok: false, reason: "store_error" });
  assert.deepEqual(await runCaptureIndexStatements(query, () => Infinity, async () => []), { ok: false, reason: "deadline" });
});

test("#164 the runner's seven cross-row and body checks each fail closed as store_error, and the positive cases hold", async () => {
  // 401 keys → two statements (ARTIFACT_INDEX_MAX_TERMS is 400); `exec` answers each statement from its own list
  const keys = Array.from({ length: 401 }, (_, i) => `task:${i}`);
  const query = { project: "p", artifact_keys: keys, after_seq: -1, through_seq: 10, row_cap: 10, deadline: Infinity };
  const event = (over: Record<string, unknown> = {}) => JSON.stringify({ id: "evt_1", seq: 1, project: "p", action: "committed", artifacts: [], method: { params: { sealed_by: "assert:hook" } }, ...over });
  const stamped = (patch: Partial<CaptureIndexHit> = {}): CaptureIndexHit => ({ seq: 1, keys: '["task:0"]', action: "committed", stamped: 1, body: event(), ...patch });
  const run = (lists: CaptureIndexHit[][]) => {
    let call = 0;
    return runCaptureIndexStatements(query, () => 0, async () => lists[call++] ?? []);
  };
  const storeError = { ok: false, reason: "store_error" };
  // 1. the same seq with a different stamped flag in two statements
  assert.deepEqual(await run([[stamped()], [stamped({ keys: '["task:400"]', stamped: 0, body: null, action: "read" })]]), storeError, "1: stamped flag differs across statements");
  // 2. the same seq with a body present in one statement and absent in the other
  assert.deepEqual(await run([[stamped()], [{ seq: 1, keys: '["task:400"]', action: "read", stamped: 1, body: null }]]), storeError, "2: body present then absent");
  // 3. a returned body whose seq differs from the row's
  assert.deepEqual(await run([[stamped({ body: event({ seq: 2 }) })]]), storeError, "3: body seq differs");
  // 4. a returned body whose project differs from the query's
  assert.deepEqual(await run([[stamped({ body: event({ project: "q" }) })]]), storeError, "4: body project differs");
  // 5. a returned body whose action differs from the events.action column
  assert.deepEqual(await run([[stamped({ body: event({ action: "merged" }) })]]), storeError, "5: body action differs");
  // 6. SQL stamped 1 while the returned body has no string sealed_by
  assert.deepEqual(await run([[stamped({ body: event({ method: { params: {} } }) })]]), storeError, "6: stamped 1, unstamped body");
  // 7. SQL stamped 0 while the returned body has a string sealed_by
  assert.deepEqual(await run([[stamped({ stamped: 0 })]]), storeError, "7: stamped 0, stamped body");
  // an unknown stamp (NULL) is decided in JavaScript from the body
  const unknown = await run([[stamped({ stamped: null })]]);
  assert.ok(unknown.ok && unknown.rows[0].stamped === true, "NULL stamp decided from the body's sealed_by");
  const unknownUnstamped = await run([[stamped({ stamped: null, body: event({ method: { params: {} } }) })]]);
  assert.ok(unknownUnstamped.ok && unknownUnstamped.rows[0].stamped === false, "NULL stamp decided false from a body without sealed_by");
  // a pair matched in two statements counts once: row_cap 2 is ok, row_cap 1 is budget
  const twice = (cap: number) => {
    let call = 0;
    return runCaptureIndexStatements({ ...query, row_cap: cap }, () => 0, async () => (call++ === 0 ? [stamped({ keys: '["task:0","task:400"]' })] : [stamped({ keys: '["task:0"]' })]));
  };
  const ok2 = await twice(2);
  assert.ok(ok2.ok && ok2.rows.length === 1 && ok2.rows[0].keys.length === 2, "the repeated pair counts once; two distinct pairs fit cap 2");
  assert.deepEqual(await twice(1), { ok: false, reason: "budget" }, "two distinct pairs exceed cap 1");
  // and a consistent row across both statements merges its keys
  const merged = await run([[stamped()], [stamped({ keys: '["task:400"]' })]]);
  assert.ok(merged.ok && merged.rows.length === 1 && merged.rows[0].keys.length === 2);
});
