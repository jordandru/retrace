import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sealEvent, verifyChain, canonicalize, computeHash, hashPayload, hashRule, HASH_VERSION, sha256Hex, EventInput, Event, GENESIS_HASH, defaultArtifactRole, applyDefaultRoles, Action } from "./index.js";

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
  assert.deepEqual(r, { ok: true, checked: 2, legacy_events: 0 });
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

// ---- artifact role (PROV used / generated) ----

test("artifact role: used/generated/both validate, anything else is rejected, absent is legal", () => {
  for (const role of ["used", "generated", "both"] as const) assert.equal(EventInput.parse(base({ artifacts: [{ id: "a", role }] })).artifacts[0].role, role);
  assert.throws(() => EventInput.parse(base({ artifacts: [{ id: "a", role: "input" as any }] })));
  assert.equal("role" in EventInput.parse(base()).artifacts[0], false, "absent stays absent through parse");
});

test("artifact role is hash-covered on new events; an absent role hashes exactly like today", async () => {
  const plain = await sealEvent(base(), null, new Date("2026-08-25T00:00:00Z"));
  const withRole = await sealEvent(base({ artifacts: [{ id: "repo:x#a.ts", role: "both" }] }), null, new Date("2026-08-25T00:00:00Z"));
  assert.notEqual(hashPayload({ ...withRole, id: plain.id }), hashPayload(plain), "role is part of the attested content");
  // explicit `role: undefined` is byte-identical to no role at all
  const undef = Event.parse({ ...plain, artifacts: [{ ...plain.artifacts[0], role: undefined }] });
  assert.equal(hashPayload(undef), hashPayload(plain));
  assert.equal(await computeHash(undef), plain.hash);
});

test("hash invariance: a real event sealed before `role` existed re-parses byte-identically and its hash recomputes", async () => {
  // seq 126 of the live `retrace` project (git-hook commit b382cc3, remote-sealed 2026-08-24): two refs, no role.
  const raw = JSON.parse(readFileSync(new URL("../test-fixtures/sealed-event-seq126.json", import.meta.url), "utf8"));
  const parsed = Event.parse(raw);
  assert.equal(canonicalize(parsed), canonicalize(raw), "the new schema adds nothing to a role-less event");
  assert.ok(parsed.artifacts.every((a) => !("role" in a)));
  assert.equal(await computeHash(parsed), raw.hash, "sealed hash still recomputes — never backfilled, never re-hashed");
  assert.equal(raw.hash, "73793107015d76d66b257fcae57df5faa722bde9f79868bc84b48dff607242c1");
  // Pre-change digest omitted received_at, so rewriting it still matches (the hole this change closes for new seals).
  const rewritten = { ...parsed, received_at: "2099-01-01T00:00:00.000Z" };
  assert.equal(await computeHash(rewritten), raw.hash, "legacy digest does not cover received_at");
});

test("received_at is hash-covered on new seals; a backdated timestamp is visible against it", async () => {
  const now = new Date("2026-08-30T12:00:00.000Z");
  const e = await sealEvent(base({ timestamp: "2020-01-01T00:00:00.000Z" }), null, now);
  assert.equal(e.timestamp, "2020-01-01T00:00:00.000Z");
  assert.equal(e.received_at, now.toISOString());
  assert.notEqual(hashPayload(e), hashPayload(e, { includeReceivedAt: false }), "received_at is in the attested content");
  assert.equal(await computeHash(e), e.hash);
  assert.equal((await verifyChain([e])).ok, true);

  const tamperedArrival = { ...e, received_at: "2020-01-01T00:00:00.000Z" };
  const r = await verifyChain([tamperedArrival]);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /tampered/);
});

test("defaultArtifactRole table and applyDefaultRoles fill-absent semantics", () => {
  const table: Record<Action, ReturnType<typeof defaultArtifactRole>> = {
    read: "used",
    created: "generated", committed: "generated", merged: "generated",
    edited: "both", moved: "both", renamed: "both",
    executed: "used", sent: "used", received: "used", approved: "used", rejected: "used",
    deleted: undefined, instructed: undefined, other: undefined,
  };
  for (const [action, role] of Object.entries(table)) assert.equal(defaultArtifactRole(action as Action), role, action);
  const refs = [{ id: "a" }, { id: "b", role: "generated" as const }];
  assert.deepEqual(applyDefaultRoles("read", refs), [{ id: "a", role: "used" }, { id: "b", role: "generated" }], "caller role wins");
  const untouched = applyDefaultRoles("deleted", refs);
  assert.deepEqual(untouched, refs);
  assert.equal(untouched[0], refs[0], "no default → the same object, no role key added");
});

test("hash_v marker: a received_at edit on a v2 event is tampering; stripping the marker cannot downgrade the check", async () => {
  const e0 = await sealEvent(base(), null, new Date("2026-08-30T10:00:00Z"));
  assert.equal(e0.hash_v, HASH_VERSION);
  assert.equal(hashRule(e0), "v2");
  assert.equal(await computeHash(e0), e0.hash);

  // Edit received_at, keep the stored hash: before the marker this re-verified via the legacy digest.
  const edited = { ...e0, received_at: "2026-08-30T09:00:00Z" };
  assert.notEqual(await computeHash(edited), e0.hash, "received_at edit detected");
  assert.equal((await verifyChain([edited as Event])).ok, false);

  // Strip the marker to force the legacy rule: the stored hash covered the marker, so no digest matches.
  const { hash_v: _v, ...stripped } = edited as any;
  assert.equal(hashRule(stripped), "legacy");
  assert.notEqual(await computeHash(stripped), e0.hash, "downgrade detected");
  const { hash_v: _v2, ...strippedOnly } = e0 as any;
  assert.notEqual(await computeHash(strippedOnly), e0.hash, "marker removal alone is tampering");

  // Legacy events (sealed without a marker) still verify under either rule and are counted.
  const legacy: any = { ...e0 }; delete legacy.hash_v;
  legacy.hash = await sha256Hex(hashPayload(legacy, { includeReceivedAt: false }));
  const legacyEdited = { ...legacy, received_at: "2026-08-30T09:00:00Z" };
  const r = await verifyChain([legacyEdited as Event]);
  assert.equal(r.ok, true, "legacy events are best-effort by design");
  assert.equal(r.legacy_events, 1);
  assert.equal((await verifyChain([e0])).legacy_events, 0);
});
