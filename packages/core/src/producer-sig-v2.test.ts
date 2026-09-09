import { test } from "node:test";
import assert from "node:assert/strict";
import { Event, EventInput, EventStore, Share, appendEvent, canonicalize, createHandler, generateSigningKey, pageHistoryNewest } from "./index.js";
import {
  CLAIM_DECISION_PARAM, PRODUCER_SIG_FORMAT, PRODUCER_SIG_FORMAT_V2, PRODUCER_SIG_V2_MIN_CLI_VERSION,
  PRODUCER_SIG_VERDICT_PARAM, PRODUCER_SIGNED_ACTOR_PARAM, RESERVED_METHOD_PARAMS, RESERVED_METHOD_PARAMS_V2,
  countProducerSigs, deriveProducerSignedActor, parseTrailerPolicy, producerSigCheck, producerSignedPayload,
  producerSigVerdict, signProducer, verifyProducerSig, verifyProducerSigResult,
} from "./producer-sig.js";
import { SEALED_BY_PARAM } from "./store.js";

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

const HOOK_TOKEN = "git-hook-token-0123456789abc";

function commitInput(over: Partial<EventInput> = {}): EventInput {
  return {
    project: "p",
    actor: { type: "agent", id: "claude-code", on_behalf_of: "jordan@example.com" },
    action: "committed",
    artifacts: [{ id: "commit:p@abc1234abc12", kind: "commit", role: "generated" }, { id: "repo:p#a.ts", kind: "file", role: "generated" }],
    timestamp: "2026-09-09T12:00:00.000Z",
    idempotency_key: "git:" + Math.random().toString(36).slice(2),
    intent: "signed bump",
    method: {
      tool: "git",
      automated: true,
      params: {
        branch: "main",
        parents: ["defdefdefdefdefdefdefdefdefdefdefdefdefd"],
        files: 1,
        insertions: 1,
        deletions: 0,
        sha: "abcabcabcabcabcabcabcabcabcabcabcabcabca",
        raw_message: "signed bump\n\nRetrace-Actor: claude-code\n",
        author: { name: "Jordan", email: "jordan@example.com" },
      },
    },
    ...over,
  };
}

async function hookHandler(trailerPolicy: "off" | "shadow" | "enforce", publicKey: JsonWebKey) {
  const store = new MemStore();
  const handle = createHandler(store, {
    token: "owner-tok-0123456789",
    trailerPolicy,
    credentials: [{
      token: HOOK_TOKEN,
      actor: { type: "system", id: "retrace-git" },
      trust: "assert",
      allowed_actors: [{ type: "agent", id: "claude-code" }, { type: "human", id: "jordan@example.com" }],
      public_key: publicKey,
    }],
  });
  return { store, handle };
}

test("parseTrailerPolicy defaults to off", () => {
  assert.equal(parseTrailerPolicy(undefined), "off");
  assert.equal(parseTrailerPolicy(""), "off");
  assert.equal(parseTrailerPolicy("bogus"), "off");
  assert.equal(parseTrailerPolicy("shadow"), "shadow");
  assert.equal(parseTrailerPolicy("enforce"), "enforce");
});

test("RESERVED_METHOD_PARAMS_V2 is the complete /2 annotation surface; /1 exclusions are unchanged", () => {
  assert.deepEqual([...RESERVED_METHOD_PARAMS_V2], [
    "sealed_by", "producer_sig_verdict", "relayed_by", "claim_decision", "producer_signed_actor",
  ]);
  assert.deepEqual([...RESERVED_METHOD_PARAMS], ["sealed_by", "producer_sig_verdict", "relayed_by", "caused_by_problem"]);
});

test("T27: /2 round trip — version is inside signed bytes; /2 annotations leave the signature valid", async () => {
  const key = await generateSigningKey();
  const signed = await signProducer(commitInput(), key.privateKey, { format: PRODUCER_SIG_FORMAT_V2 });
  assert.equal(signed.producer_sig.format, PRODUCER_SIG_FORMAT_V2);
  assert.equal(producerSignedPayload(signed).v, PRODUCER_SIG_FORMAT_V2);
  const asV1 = { ...signed, producer_sig: { kid: signed.producer_sig.kid, sig: signed.producer_sig.sig } };
  assert.equal(await verifyProducerSig(asV1, key.publicKey), false, "unsigned format cannot select the /1 verifier for /2 bytes");

  const annotated = {
    ...signed,
    method: {
      ...signed.method,
      params: {
        ...signed.method!.params,
        [SEALED_BY_PARAM]: "assert:git hook (assert)",
        [PRODUCER_SIG_VERDICT_PARAM]: "verified",
        [CLAIM_DECISION_PARAM]: { policy: "trailer-consistency/1", shadow: true },
        [PRODUCER_SIGNED_ACTOR_PARAM]: { type: "human", id: "forged@example.com" },
      },
    },
  };
  const result = await verifyProducerSigResult(annotated, key.publicKey);
  assert.equal(result.ok, true);
  assert.deepEqual(result.signed_actor, { type: "agent", id: "claude-code", on_behalf_of: "jordan@example.com" });
  assert.notEqual(result.signed_actor?.id, "forged@example.com", "stored producer_signed_actor is ignored");
  const { event } = await appendEvent(new MemStore(), annotated);
  assert.equal(await verifyProducerSig(event, key.publicKey), true, "offline recompute ignores stored producer_signed_actor");
});

test("T27: /2 tampered signed field is invalid; /1 legacy commit verifies under the /1 rule", async () => {
  const key = await generateSigningKey();
  const signed = await signProducer(commitInput(), key.privateKey, { format: PRODUCER_SIG_FORMAT_V2 });
  assert.equal(await verifyProducerSig({ ...signed, intent: "tampered after signing" }, key.publicKey), false);

  const legacy = await signProducer({
    ...commitInput(),
    method: { tool: "git", automated: true, params: { branch: "main", parents: ["p"], files: 1, sha: "abc" } },
  }, key.privateKey);
  assert.equal(legacy.producer_sig.format, undefined);
  assert.equal(producerSignedPayload(legacy).v, PRODUCER_SIG_FORMAT);
  const { event } = await appendEvent(new MemStore(), {
    ...legacy,
    method: { ...legacy.method, params: { ...legacy.method!.params, [SEALED_BY_PARAM]: "assert:hook", [PRODUCER_SIG_VERDICT_PARAM]: "verified", caused_by_problem: "missing" } },
  });
  assert.equal(await verifyProducerSig(event, key.publicKey), true);
  assert.equal(await producerSigVerdict(event, key.publicKey), "verified");
});

test("T27 online: /2 record (off) and shadow stamp derived producer_signed_actor; /1 stays byte-compatible", async () => {
  const key = await generateSigningKey();
  for (const policy of ["off", "shadow"] as const) {
    const { store, handle } = await hookHandler(policy, key.publicKey);
    const signed = await signProducer(commitInput(), key.privateKey, { format: PRODUCER_SIG_FORMAT_V2 });
    const res = await post(handle, "/events", signed, HOOK_TOKEN);
    assert.equal(res.status, 201, policy);
    const sealed = store.events.at(-1)!;
    assert.equal(await verifyProducerSig(sealed, key.publicKey), true, `${policy} offline`);
    assert.deepEqual(sealed.method?.params?.[PRODUCER_SIGNED_ACTOR_PARAM], {
      type: "agent", id: "claude-code", on_behalf_of: "jordan@example.com",
    });
    assert.equal(canonicalize(producerSignedPayload(signed)), canonicalize(producerSignedPayload(sealed)));
  }

  const { store, handle } = await hookHandler("shadow", key.publicKey);
  const legacy = await signProducer({
    ...commitInput(),
    method: { tool: "git", automated: true, params: { branch: "main", parents: ["p"], files: 1, sha: "abc" } },
  }, key.privateKey);
  const res = await post(handle, "/events", legacy, HOOK_TOKEN);
  assert.equal(res.status, 201);
  const sealed = store.events.at(-1)!;
  assert.equal(sealed.method?.params?.[PRODUCER_SIGNED_ACTOR_PARAM], undefined, "/1 must not receive /2 annotations");
  assert.equal(sealed.method?.params?.[CLAIM_DECISION_PARAM], undefined);
  assert.equal(await verifyProducerSig(sealed, key.publicKey), true);
  assert.equal(canonicalize(producerSignedPayload(legacy)), canonicalize(producerSignedPayload(sealed)));
});

test("unknown producer_sig.format fails closed as invalid", async () => {
  const key = await generateSigningKey();
  const signed = await signProducer(commitInput({ action: "edited", method: { tool: "mcp" } }), key.privateKey);
  const unknown = { ...signed, producer_sig: { ...signed.producer_sig, format: "retrace-producer-sig/99" } };
  assert.equal(await producerSigVerdict(unknown, key.publicKey), "invalid");
  assert.equal((await verifyProducerSigResult(unknown, key.publicKey)).ok, false);
});

test("T39: signed-actor derivation from author email, malformed trailer → human, dropping author is invalid", async () => {
  const key = await generateSigningKey();
  const agent = await signProducer(commitInput(), key.privateKey, { format: PRODUCER_SIG_FORMAT_V2 });
  const agentV = await verifyProducerSigResult(agent, key.publicKey);
  assert.equal(agentV.ok, true);
  assert.deepEqual(agentV.signed_actor, { type: "agent", id: "claude-code", on_behalf_of: "jordan@example.com" });

  const malformed = await signProducer(commitInput({
    actor: { type: "human", id: "jordan@example.com", display_name: "Jordan" },
    method: {
      tool: "git",
      automated: false,
      params: {
        branch: "main",
        parents: [],
        files: 1,
        sha: "abc",
        raw_message: "oops\n\nRetrace-Actor: not a valid id!!\n",
        author: { name: "Jordan", email: "jordan@example.com" },
      },
    },
  }), key.privateKey, { format: PRODUCER_SIG_FORMAT_V2 });
  const malformedV = await verifyProducerSigResult(malformed, key.publicKey);
  assert.equal(malformedV.ok, true);
  assert.deepEqual(malformedV.signed_actor, { type: "human", id: "jordan@example.com" });

  const { author: _drop, ...rest } = agent.method!.params as Record<string, unknown> & { author: unknown };
  const dropped = { ...agent, method: { ...agent.method, params: rest } };
  assert.equal(await verifyProducerSig(dropped, key.publicKey), false);
  assert.equal(deriveProducerSignedActor(dropped, PRODUCER_SIG_FORMAT_V2), undefined);
});

test("T38: /1 commit seal in shadow is stored and counted legacy_client; enforce returns 426; unsigned is stored", async () => {
  const key = await generateSigningKey();
  const legacyBody = {
    ...commitInput(),
    method: { tool: "git", automated: true, params: { branch: "main", parents: ["p"], files: 1, sha: "abc" } },
  };

  const shadow = await hookHandler("shadow", key.publicKey);
  const signed = await signProducer(legacyBody, key.privateKey);
  assert.equal((await post(shadow.handle, "/events", signed, HOOK_TOKEN)).status, 201);
  const status = await shadow.handle(new Request("http://test/projects/p/status", { headers: { authorization: "Bearer owner-tok-0123456789" } }));
  const body = await status.json() as { capture: { legacy_client: number } };
  assert.equal(body.capture.legacy_client, 1);

  const enforce = await hookHandler("enforce", key.publicKey);
  const refused = await post(enforce.handle, "/events", await signProducer({ ...legacyBody, idempotency_key: "git:enforce" }, key.privateKey), HOOK_TOKEN);
  assert.equal(refused.status, 426);
  const refusedBody = await refused.json() as { min_cli_version: string; format: string };
  assert.equal(refusedBody.min_cli_version, PRODUCER_SIG_V2_MIN_CLI_VERSION);
  assert.equal(refusedBody.format, PRODUCER_SIG_FORMAT_V2);
  assert.equal(enforce.store.events.length, 0);

  const unsigned = await post(enforce.handle, "/events", { ...legacyBody, idempotency_key: "git:unsigned" }, HOOK_TOKEN);
  assert.equal(unsigned.status, 201, "unsigned commit seals are stored in enforce");
  assert.equal(enforce.store.events.at(-1)!.producer_sig, undefined);
});

test("GET /api advertises producer-sig/2; enforce names min_cli_version", async () => {
  const off = createHandler(new MemStore(), { token: "owner-tok-0123456789" });
  const offApi = await (await off(new Request("http://test/api"))).json() as { capabilities: string[]; min_cli_version?: string };
  assert.ok(offApi.capabilities.includes("producer-sig/2"));
  assert.equal(offApi.min_cli_version, undefined);

  const enforce = createHandler(new MemStore(), { token: "owner-tok-0123456789", trailerPolicy: "enforce" });
  const enApi = await (await enforce(new Request("http://test/api"))).json() as { min_cli_version: string };
  assert.equal(enApi.min_cli_version, PRODUCER_SIG_V2_MIN_CLI_VERSION);
});

test("offline countProducerSigs recomputes signed actor and does not trust a stored copy", async () => {
  const key = await generateSigningKey();
  const signed = await signProducer(commitInput(), key.privateKey, { format: PRODUCER_SIG_FORMAT_V2 });
  const { event } = await appendEvent(new MemStore(), {
    ...signed,
    method: { ...signed.method, params: { ...signed.method!.params, [PRODUCER_SIGNED_ACTOR_PARAM]: { type: "agent", id: "codex" } } },
  });
  const c = await countProducerSigs([event], [{ kid: signed.producer_sig.kid, public_key: key.publicKey }]);
  assert.equal(c.producer_signed, 1);
  assert.equal(c.producer_invalid, 0);
  const check = await producerSigCheck(event, key.publicKey);
  assert.equal(check.signed_actor?.id, "claude-code");
});
