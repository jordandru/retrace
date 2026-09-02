import { test } from "node:test";
import assert from "node:assert/strict";
import { Event, EventInput, EventStore, Share, createHandler, generateSigningKey, appendEvent, verifyExportBundle, ExportBundle, pageHistoryNewest } from "./index.js";
import { signProducer, PRODUCER_SIG_VERDICT_PARAM } from "./producer-sig.js";

class MemStore implements EventStore {
  events: Event[] = []; shares = new Map<string, Share>();
  async head(p: string) { const e = this.events.filter((x) => x.project === p).at(-1); return e ? { seq: e.seq, hash: e.hash } : null; }
  async insert(e: Event) { this.events.push(e); }
  async byIdempotencyKey(p: string, k: string) { return this.events.find((e) => e.project === p && e.idempotency_key === k) ?? null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(p: string) { return this.events.filter((e) => e.project === p).sort((a, b) => a.seq - b.seq); }
  async projects() { return [...new Set(this.events.map((e) => e.project))]; }
  async history(q: Parameters<typeof pageHistoryNewest>[1]) { return pageHistoryNewest(this.events, q); }
  async createShare(s: Share) { this.shares.set(s.id, s); }
  async getShare(id: string) { return this.shares.get(id) ?? null; }
}

const post = (handle: (r: Request) => Promise<Response>, path: string, body: unknown, bearer: string) =>
  handle(new Request(`http://test${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) }));

const input = (over: Partial<EventInput> = {}): EventInput => ({
  project: "p", actor: { type: "agent", id: "claude-code", on_behalf_of: "j@x.com" }, action: "edited",
  artifacts: [{ id: "repo:o/r#a.ts", role: "both" }], timestamp: "2026-09-02T06:00:00.000Z", idempotency_key: "rk-" + Math.random().toString(36).slice(2), ...over,
});

async function rig(requireSig = false) {
  const key = await generateSigningKey();
  const other = await generateSigningKey();
  const store = new MemStore();
  const handle = createHandler(store, {
    token: "owner-tok",
    signingKey: (await generateSigningKey()).privateKey,
    credentials: [
      { token: "cred-claude-0123456789", actor: { type: "agent", id: "claude-code", on_behalf_of: "j@x.com" }, trust: "pinned" as const, public_key: key.publicKey, require_signature: requireSig },
      { token: "cred-nokey-0123456789a", actor: { type: "agent", id: "gemini" }, trust: "pinned" as const },
    ],
  });
  return { key, other, store, handle };
}
const verdictOf = (e: Event) => (e.method?.params as Record<string, unknown>)?.[PRODUCER_SIG_VERDICT_PARAM];

test("router: verified / invalid / unknown_kid / none verdicts are stamped server-side; caller-supplied verdicts are stripped", async () => {
  const { key, other, store, handle } = await rig();
  // verified
  let res = await post(handle, "/events", await signProducer(input(), key.privateKey), "cred-claude-0123456789");
  assert.equal(res.status, 201);
  assert.equal(verdictOf(store.events.at(-1)!), "verified");
  // forged: someone else's sig wearing my kid
  const mine = await signProducer(input(), key.privateKey);
  const theirs = await signProducer(input({ idempotency_key: mine.idempotency_key }), other.privateKey);
  res = await post(handle, "/events", { ...mine, idempotency_key: "rk-forged", producer_sig: { kid: mine.producer_sig.kid, sig: theirs.producer_sig.sig } }, "cred-claude-0123456789");
  assert.equal(res.status, 201);
  assert.equal(verdictOf(store.events.at(-1)!), "invalid");
  // sign-as-yourself, submit on a credential pinned to someone else with the same registered key shape: the pinned
  // rewrite changes the actor, so the recomputed payload differs → invalid (kid matches, bytes don't)
  const asCodex = await signProducer(input({ actor: { type: "agent", id: "codex" }, idempotency_key: "rk-launder" }), key.privateKey);
  res = await post(handle, "/events", asCodex, "cred-claude-0123456789");
  assert.equal(res.status, 201);
  assert.equal(verdictOf(store.events.at(-1)!), "invalid");
  // cross-project replay of a captured signed body
  const captured = await signProducer(input({ idempotency_key: "rk-replay" }), key.privateKey);
  res = await post(handle, "/events", { ...captured, project: "q" }, "cred-claude-0123456789");
  assert.equal(res.status, 201);
  assert.equal(verdictOf(store.events.at(-1)!), "invalid");
  // a signature on a credential with NO registered key
  res = await post(handle, "/events", { ...(await signProducer(input({ actor: { type: "agent", id: "gemini" }, idempotency_key: "rk-nokey" }), key.privateKey)) }, "cred-nokey-0123456789a");
  assert.equal(res.status, 201);
  assert.equal(verdictOf(store.events.at(-1)!), "unknown_kid");
  // no signature at all; caller tries to smuggle a verdict
  res = await post(handle, "/events", { ...input({ idempotency_key: "rk-smuggle" }), method: { tool: "mcp", params: { [PRODUCER_SIG_VERDICT_PARAM]: "verified" } } }, "cred-claude-0123456789");
  assert.equal(res.status, 201);
  assert.equal(verdictOf(store.events.at(-1)!), "none");
  // owner writes are exempt: verdict none, never 401
  res = await post(handle, "/events", input({ idempotency_key: "rk-owner" }), "owner-tok");
  assert.equal(res.status, 201);
  assert.equal(verdictOf(store.events.at(-1)!), "none");
});

test("router: require_signature turns every non-verified verdict into a 401 that seals nothing and never echoes the signature", async () => {
  const { key, other, store, handle } = await rig(true);
  const cases: [string, EventInput][] = [
    ["none", input({ idempotency_key: "rk-401-none" })],
    ["unknown_kid", { ...(await signProducer(input({ idempotency_key: "rk-401-kid" }), key.privateKey)), producer_sig: { kid: "feedfacefeedface", sig: (await signProducer(input({ idempotency_key: "rk-401-kid" }), key.privateKey)).producer_sig.sig } }],
    ["invalid", { ...(await signProducer(input({ idempotency_key: "rk-401-bad" }), key.privateKey)), intent: "tampered after signing" }],
  ];
  for (const [expect, body] of cases) {
    const before = store.events.length;
    const res = await post(handle, "/events", body, "cred-claude-0123456789");
    assert.equal(res.status, 401, expect);
    const text = await res.text();
    assert.match(text, new RegExp(expect));
    if ((body as EventInput).producer_sig) assert.ok(!text.includes((body as EventInput & { producer_sig: { sig: string } }).producer_sig.sig), "the response must not echo the signature");
    assert.equal(store.events.length, before, "nothing sealed");
  }
  // and the happy path still seals
  const res = await post(handle, "/events", await signProducer(input({ idempotency_key: "rk-401-ok" }), key.privateKey), "cred-claude-0123456789");
  assert.equal(res.status, 201);
  assert.equal(verdictOf(store.events.at(-1)!), "verified");
});

test("export: bundles carry registered producer keys under the bundle signature; offline verify recounts through every legitimate server mutation", async () => {
  const { key, store, handle } = await rig();
  // an event that exercises the router's whole annotation surface: bad caused_by (tag + params note), location.client
  // (dropped), model (backfilled by the pin), plus sealed_by/verdict stamps
  const signed = await signProducer(input({
    caused_by: "evt_" + "b".repeat(32), idempotency_key: "rk-e2e",
    location: { system: "claude-code", session: "s1", client: "claude-code@2.1" },
    method: { tool: "mcp", automated: true },
  }), key.privateKey);
  const res = await post(handle, "/events", { ...signed, actor: { ...signed.actor, model: "claude-fable-5" } }, "cred-claude-0123456789");
  assert.equal(res.status, 201);
  await post(handle, "/events", input({ actor: { type: "agent", id: "gemini" }, idempotency_key: "rk-unsigned" }), "cred-nokey-0123456789a");
  const expRes = await handle(new Request("http://test/projects/p/export", { headers: { authorization: "Bearer owner-tok" } }));
  const bundle = await expRes.json() as ExportBundle;
  assert.equal(bundle.producers?.length, 1);
  assert.equal(bundle.producers![0].actor_id, "claude-code");
  const v = await verifyExportBundle(bundle, bundle.issuer!.public_key);
  assert.deepEqual([v.producer_signed, v.producer_invalid, v.producer_unsigned_agent_events], [1, 0, 1], v.problems.join(" | "));
  // the producers list is covered by the bundle signature
  const swapped = { ...bundle, producers: [{ ...bundle.producers![0], actor_id: "codex" }] };
  const vs = await verifyExportBundle(swapped, bundle.issuer!.public_key);
  assert.notEqual(vs.signature, "valid", "a swapped producers list invalidates the bundle signature");
  // a trusted --producers list REPLACES a (self-attested) bundle list: here it exposes the swap
  const vt = await verifyExportBundle(swapped, undefined, { producers: bundle.producers });
  assert.equal(vt.producer_signed, 1, "the trusted list still validates the honest event");
});
