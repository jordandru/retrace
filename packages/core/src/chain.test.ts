import { test } from "node:test";
import assert from "node:assert/strict";
import { sealEvent, verifyChain, canonicalize, EventInput, GENESIS_HASH } from "./index.js";

const base = (over: Partial<EventInput> = {}): EventInput => ({
  project: "test",
  actor: { type: "agent", id: "claude", model: "claude-fable-5" },
  action: "edited",
  artifacts: [{ id: "repo:x#a.ts" }],
  intent: "fix bug",
  ...over,
});

test("canonicalize is key-order independent and drops undefined", () => {
  assert.equal(canonicalize({ b: 1, a: [{ d: 2, c: undefined }] }), canonicalize({ a: [{ d: 2 }], b: 1 }));
});

test("chain seals and verifies", async () => {
  const e0 = await sealEvent(base(), null);
  assert.equal(e0.seq, 0);
  assert.equal(e0.prev_hash, GENESIS_HASH);
  const e1 = await sealEvent(base({ caused_by: e0.id }), { seq: e0.seq, hash: e0.hash });
  assert.equal(e1.prev_hash, e0.hash);
  const r = await verifyChain([e0, e1]);
  assert.deepEqual(r, { ok: true, checked: 2 });
});

test("tampering is detected", async () => {
  const e0 = await sealEvent(base(), null);
  const e1 = await sealEvent(base(), { seq: 0, hash: e0.hash });
  const tampered = { ...e0, intent: "totally legit" };
  const r = await verifyChain([tampered, e1]);
  assert.equal(r.ok, false);
  assert.equal(r.first_bad_seq, 0);
  assert.match(r.reason!, /tampered/);
});

test("deleting a middle event breaks the chain", async () => {
  const e0 = await sealEvent(base(), null);
  const e1 = await sealEvent(base(), { seq: 0, hash: e0.hash });
  const e2 = await sealEvent(base(), { seq: 1, hash: e1.hash });
  const r = await verifyChain([e0, e2]);
  assert.equal(r.ok, false);
  assert.equal(r.first_bad_seq, 2);
});
