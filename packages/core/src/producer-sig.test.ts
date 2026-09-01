import { test } from "node:test";
import assert from "node:assert/strict";
import { Event, EventInput, EventStore, Share, appendEvent, generateSigningKey, computeHash, canonicalize } from "./index.js";
import { producerSignedPayload, signProducer, verifyProducerSig, producerSigVerdict, countProducerSigs, PRODUCER_SIG_VERDICT_PARAM } from "./producer-sig.js";
import { SEALED_BY_PARAM } from "./store.js";

class MemStore implements EventStore {
  events: Event[] = []; shares = new Map<string, Share>();
  async head(p: string) { const e = this.events.filter((x) => x.project === p).at(-1); return e ? { seq: e.seq, hash: e.hash } : null; }
  async insert(e: Event) { this.events.push(e); }
  async byIdempotencyKey(p: string, k: string) { return this.events.find((e) => e.project === p && e.idempotency_key === k) ?? null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(p: string) { return this.events.filter((e) => e.project === p); }
  async projects() { return ["p"]; }
  // typed loosely on purpose: history() is changing shape in an in-flight branch, and this test never calls it
  async history(_q?: unknown): Promise<never> { throw new Error("not used in these tests"); }
  async createShare(s: Share) { this.shares.set(s.id, s); }
  async getShare(id: string) { return this.shares.get(id) ?? null; }
}

const base = (): EventInput => ({
  project: "p", actor: { type: "agent", id: "claude-code", on_behalf_of: "j@example.com" }, action: "edited",
  artifacts: [{ id: "repo:o/r#a.ts", kind: "file", role: "both" }], timestamp: "2026-09-01T12:00:00.000Z",
  intent: "edit a.ts", caused_by: "evt_" + "a".repeat(32), idempotency_key: "k1",
});

test("round-trip parity: the payload from the submitted input equals the payload from the sealed event, through every legitimate server mutation", async () => {
  const key = await generateSigningKey();
  const signed = await signProducer(base(), key.privateKey);
  // server-side mutations that must NOT affect the signature: caused_by verification tag + params note (the parent
  // does not exist in this store), sealed_by stamp, verdict stamp, location.client drop, actor.model backfill
  const mutated = {
    ...signed,
    actor: { ...signed.actor, model: "claude-fable-5", display_name: "Claude" },
    location: { system: "claude-code" },
    method: { tool: "mcp", params: { [SEALED_BY_PARAM]: "pinned:x", [PRODUCER_SIG_VERDICT_PARAM]: "verified" } },
  };
  const store = new MemStore();
  const { event } = await appendEvent(store, mutated);
  assert.ok(event.tags?.includes("caused_by:unverified"), "precondition: the server annotated the event");
  assert.equal(canonicalize(producerSignedPayload(signed)), canonicalize(producerSignedPayload(event)));
  assert.equal(await verifyProducerSig(event, key.publicKey), true);
  assert.equal(await producerSigVerdict(event, key.publicKey), "verified");
});

test("signProducer refuses an input without timestamp; absent optional fields and undefined are the same payload", async () => {
  const key = await generateSigningKey();
  await assert.rejects(() => signProducer({ ...base(), timestamp: undefined } as EventInput, key.privateKey), /must set timestamp/);
  const a = producerSignedPayload({ ...base(), change: undefined, duration_ms: undefined });
  const { change: _c, duration_ms: _d, ...rest } = base() as EventInput & { change?: unknown; duration_ms?: unknown };
  assert.equal(canonicalize(a), canonicalize(producerSignedPayload(rest as EventInput)));
  const withChange = producerSignedPayload({ ...base(), change: { summary: "x" } });
  assert.notEqual(canonicalize(a), canonicalize(withChange));
});

test("verdicts: forged sig, kid swap, unregistered key, actor rewrite, cross-project replay, missing timestamp", async () => {
  const mine = await generateSigningKey();
  const other = await generateSigningKey();
  const signed = await signProducer(base(), mine.privateKey);
  assert.equal(await producerSigVerdict(signed, mine.publicKey), "verified");
  assert.equal(await producerSigVerdict({ ...base() }, mine.publicKey), "none", "no signature presented");
  assert.equal(await producerSigVerdict(signed, null), "unknown_kid", "signature but no registered key");
  // forged: someone else's signature carrying my kid
  const forged = { ...signed, producer_sig: { kid: signed.producer_sig.kid, sig: (await signProducer(base(), other.privateKey)).producer_sig.sig } };
  assert.equal(await producerSigVerdict(forged, mine.publicKey), "invalid");
  // kid swap: my valid sig relabelled with an unregistered kid
  assert.equal(await producerSigVerdict({ ...signed, producer_sig: { ...signed.producer_sig, kid: "feedfacefeedface" } }, mine.publicKey), "unknown_kid");
  // the pinned rewrite resolved a different actor than I signed (sign-as-self, submit on another's credential)
  assert.equal(await producerSigVerdict({ ...signed, actor: { type: "agent", id: "codex", on_behalf_of: "j@example.com" } }, mine.publicKey), "invalid");
  // credential resolves a different on_behalf_of than was signed
  assert.equal(await producerSigVerdict({ ...signed, actor: { ...signed.actor, on_behalf_of: "someone@else.com" } }, mine.publicKey), "invalid");
  // replay the signed body into another project
  assert.equal(await producerSigVerdict({ ...signed, project: "q" }, mine.publicKey), "invalid");
  // producer_sig present but no timestamp (never signable, and never re-verifiable)
  assert.equal(await producerSigVerdict({ ...signed, timestamp: undefined } as EventInput, mine.publicKey), "invalid");
});

test("dedupe: an idempotent resubmission with a different signature returns the ORIGINAL sealed event; the first signature wins", async () => {
  const key = await generateSigningKey();
  const store = new MemStore();
  const first = await appendEvent(store, await signProducer(base(), key.privateKey));
  const resigned = await signProducer({ ...base(), intent: "changed my mind" }, key.privateKey);
  const second = await appendEvent(store, resigned);
  assert.equal(second.deduped, true);
  assert.equal(second.event.producer_sig!.sig, first.event.producer_sig!.sig);
  assert.equal(store.events.length, 1);
});

test("stripping producer_sig after the seal breaks the chain", async () => {
  const key = await generateSigningKey();
  const store = new MemStore();
  const { event } = await appendEvent(store, await signProducer(base(), key.privateKey));
  assert.equal(await computeHash(event), event.hash, "sanity: sealed hash matches");
  const { producer_sig: _p, ...stripped } = event;
  assert.notEqual(await computeHash(stripped as Event), event.hash, "the server cannot shed a signature post-seal without a detectable hash mismatch");
});

test("countProducerSigs: actor binding, invalid counting, unsigned agents, and the empty-list (uncheckable) rule", async () => {
  const a = await generateSigningKey(); const b = await generateSigningKey();
  const store = new MemStore();
  const mk = (over: Partial<EventInput>) => ({ ...base(), idempotency_key: undefined, ...over });
  const e1 = (await appendEvent(store, await signProducer(mk({}), a.privateKey))).event;                          // verified
  const badSig = await signProducer(mk({ intent: "x" }), a.privateKey);
  const e2 = (await appendEvent(store, { ...badSig, intent: "tampered after signing" })).event;                    // invalid
  const e3 = (await appendEvent(store, mk({ actor: { type: "agent", id: "gemini" } }))).event;                     // unsigned agent
  const e4 = (await appendEvent(store, mk({ actor: { type: "human", id: "j@example.com" } }))).event;              // unsigned human
  const crossActor = await signProducer(mk({ actor: { type: "agent", id: "codex", on_behalf_of: "j@example.com" } }), b.privateKey);
  const e5 = (await appendEvent(store, crossActor)).event;                                                          // sig by b, but b's key is registered to grok
  const keys = [
    { kid: e1.producer_sig!.kid, public_key: a.publicKey, actor_id: "claude-code" },
    { kid: e5.producer_sig!.kid, public_key: b.publicKey, actor_id: "grok" },
  ];
  const c = await countProducerSigs([e1, e2, e3, e4, e5], keys);
  assert.equal(c.producer_signed, 1);
  assert.equal(c.producer_invalid, 2);
  assert.ok(c.problems.some((p) => /not a registered key for actor codex/.test(p)), "key material reuse across actors is named");
  assert.equal(c.producer_unsigned_agent_events, 1, "the human event is not counted");
  const un = await countProducerSigs([e1, e2, e5], []);
  assert.deepEqual([un.producer_signed, un.producer_invalid, un.problems.length], [0, 0, 0], "no keys = uncheckable, never invalid");
});
