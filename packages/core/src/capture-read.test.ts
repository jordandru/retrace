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
