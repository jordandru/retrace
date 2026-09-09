import { test } from "node:test";
import assert from "node:assert/strict";
import { Event, EventInput, EventStore, Share, appendEvent, canonicalize, createHandler, generateSigningKey, pageHistoryNewest } from "./index.js";
import {
  CLAIM_DECISION_PARAM, PRODUCER_HOOK_SYSTEM_ACTOR, PRODUCER_SIG_FORMAT, PRODUCER_SIG_FORMAT_V2, PRODUCER_SIG_V2_MIN_CLI_VERSION,
  PRODUCER_SIG_VERDICT_PARAM, PRODUCER_SIGNED_ACTOR_PARAM, PRODUCER_WEBHOOK_SYSTEM_ACTOR, RESERVED_METHOD_PARAMS, RESERVED_METHOD_PARAMS_V2,
  countProducerSigs, deriveProducerSignedActor, parseTrailerPolicy, payloadSignedActor, producerSigCheck, producerSignedPayload,
  producerSigVerdict, rederiveCommitClaim, signProducer, verifyProducerSig, verifyProducerSigResult,
} from "./producer-sig.js";
import { SEALED_BY_PARAM } from "./store.js";
import { captureSeals } from "./capture.js";

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

async function hookHandler(
  trailerPolicy: "off" | "shadow" | "enforce",
  publicKey: JsonWebKey,
  extra?: { require_signature?: boolean },
) {
  const store = new MemStore();
  const handle = createHandler(store, {
    token: "owner-tok-0123456789",
    trailerPolicy,
    credentials: [{
      token: HOOK_TOKEN,
      actor: { type: "system", id: "retrace-git" },
      trust: "assert",
      allowed_actors: [
        { type: "agent", id: "claude-code" },
        { type: "agent", id: "codex" },
        { type: "human", id: "jordan@example.com" },
      ],
      public_key: publicKey,
      require_signature: extra?.require_signature,
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

test("RESERVED_METHOD_PARAMS_V2 is /1's four plus claim_decision and producer_signed_actor", () => {
  assert.deepEqual([...RESERVED_METHOD_PARAMS_V2], [
    "sealed_by", "producer_sig_verdict", "relayed_by", "caused_by_problem", "claim_decision", "producer_signed_actor",
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
        caused_by_problem: "missing",
        [CLAIM_DECISION_PARAM]: { policy: "trailer-consistency/1", shadow: true, signed_actor: { type: "agent", id: "claude-code", on_behalf_of: "jordan@example.com" } },
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

test("/2 event that receives a caused_by_problem stamp still verifies", async () => {
  const key = await generateSigningKey();
  const signed = await signProducer(commitInput({ caused_by: "evt_" + "a".repeat(32) }), key.privateKey, { format: PRODUCER_SIG_FORMAT_V2 });
  const { event } = await appendEvent(new MemStore(), signed);
  assert.ok((event.method?.params as Record<string, unknown>)?.caused_by_problem, "precondition: appendEvent stamped caused_by_problem");
  assert.ok(event.tags?.includes("caused_by:unverified"));
  assert.equal(await verifyProducerSig(event, key.publicKey), true);
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
  assert.deepEqual(payloadSignedActor(dropped), { type: "agent", id: "claude-code", on_behalf_of: "jordan@example.com" });
  assert.equal(rederiveCommitClaim(dropped), undefined);
  assert.deepEqual(deriveProducerSignedActor(dropped, PRODUCER_SIG_FORMAT_V2), payloadSignedActor(dropped));

  const noAuthor = await signProducer({
    ...commitInput(),
    method: { tool: "git", automated: true, params: { branch: "main", parents: ["p"], files: 1, sha: "abc", raw_message: "x\n\nRetrace-Actor: claude-code\n" } },
  }, key.privateKey, { format: PRODUCER_SIG_FORMAT_V2 });
  assert.equal((await verifyProducerSigResult(noAuthor, key.publicKey)).ok, false, "T39: /2 git commit without author is invalid");
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

const claimedCodex = { type: "agent" as const, id: "codex", on_behalf_of: "jordan@example.com" };

function gitParams(over: Record<string, unknown> = {}) {
  return {
    branch: "main",
    parents: ["defdefdefdefdefdefdefdefdefdefdefdefdefd"],
    files: 1,
    insertions: 1,
    deletions: 0,
    sha: "abcabcabcabcabcabcabcabcabcabcabcabcabca",
    raw_message: "signed bump\n\nRetrace-Actor: codex\n",
    author: { name: "Jordan", email: "jordan@example.com" },
    ...over,
  };
}

async function signClaimed(
  key: JsonWebKey,
  over: { actor?: EventInput["actor"]; params?: Record<string, unknown>; format?: typeof PRODUCER_SIG_FORMAT | typeof PRODUCER_SIG_FORMAT_V2 } = {},
) {
  return signProducer(commitInput({
    actor: over.actor ?? claimedCodex,
    method: { tool: "git", automated: true, params: gitParams(over.params ?? {}) },
  }), key, { format: over.format ?? PRODUCER_SIG_FORMAT_V2 });
}

function withheldClaim(over: Record<string, unknown> = {}) {
  return {
    policy: "trailer-consistency/1",
    decision: { actor_written: "withheld" },
    signed_actor: { ...claimedCodex },
    claim: { type: claimedCodex.type, id: claimedCodex.id },
    ...over,
  };
}

function asWithheld(
  signed: Awaited<ReturnType<typeof signProducer>>,
  over: { actor?: EventInput["actor"]; sealedBy?: string; claimDecision?: Record<string, unknown> } = {},
) {
  return {
    ...signed,
    actor: over.actor ?? { ...PRODUCER_HOOK_SYSTEM_ACTOR },
    method: {
      ...signed.method,
      params: {
        ...signed.method!.params,
        [SEALED_BY_PARAM]: over.sealedBy ?? "assert:git hook (assert)",
        [CLAIM_DECISION_PARAM]: over.claimDecision ?? withheldClaim(),
      },
    },
  };
}

/** The exact stamp this fixture project's hook writes — same string captureSeals/reconcile would take from .retrace.json. */
const PROJECT_HOOK_STAMPS = ["assert:git hook (assert)"] as const;
const hookTrust = { trustedHookStamps: PROJECT_HOOK_STAMPS };

test("T32: valid withheld T27 fixture reconstructs; every rule-3 guard fails closed", async () => {
  const key = await generateSigningKey();
  const signed = await signClaimed(key.privateKey);
  const valid = asWithheld(signed);
  const ok = await verifyProducerSigResult(valid, key.publicKey, hookTrust);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.signed_actor, claimedCodex);
  const { event } = await appendEvent(new MemStore(), valid);
  assert.equal(await verifyProducerSig(event, key.publicKey, hookTrust), true);
  assert.deepEqual((await verifyProducerSigResult(event, key.publicKey, hookTrust)).signed_actor, claimedCodex);
  const counted = await countProducerSigs([event], [{ kid: signed.producer_sig.kid, public_key: key.publicKey }], hookTrust);
  assert.equal(counted.producer_signed, 1);
  assert.equal(counted.producer_invalid, 0);

  const webhook = asWithheld(signed, {
    actor: { ...PRODUCER_WEBHOOK_SYSTEM_ACTOR },
    sealedBy: "webhook:github",
  });
  assert.equal((await verifyProducerSigResult(webhook, key.publicKey)).ok, true, "webhook:github is trusted without a hook list");
  assert.equal((await verifyProducerSigResult(webhook, key.publicKey, hookTrust)).ok, true);

  const guards: [string, Awaited<ReturnType<typeof asWithheld>>][] = [
    ["competing top-level actor_written", asWithheld(signed, { claimDecision: withheldClaim({ actor_written: "withheld" }) })],
    ["competing top-level withheld", asWithheld(signed, { claimDecision: withheldClaim({ withheld: true }) })],
    ["pinned stamp", asWithheld(signed, { sealedBy: "pinned:retrace-git" })],
    ["untrusted assert stamp", asWithheld(signed, { sealedBy: "assert:hook" })],
    ["wrong system actor", asWithheld(signed, { actor: { ...PRODUCER_WEBHOOK_SYSTEM_ACTOR } })],
    ["system actor with on_behalf_of", asWithheld(signed, { actor: { ...PRODUCER_HOOK_SYSTEM_ACTOR, on_behalf_of: "jordan@example.com" } })],
    ["mismatched claim id", asWithheld(signed, { claimDecision: withheldClaim({ claim: { type: "agent", id: "claude-code" } }) })],
    ["missing nested selector", asWithheld(signed, { claimDecision: withheldClaim({ decision: { policy: "trailer-consistency/1" } }) })],
  ];
  for (const [name, fixture] of guards) {
    assert.equal((await verifyProducerSigResult(fixture, key.publicKey, hookTrust)).ok, false, name);
  }

  const nonCommit = { ...valid, action: "edited" as const };
  assert.equal((await verifyProducerSigResult(nonCommit, key.publicKey, hookTrust)).ok, false, "non-commit");

  const idMismatchSigned = await signClaimed(key.privateKey, { params: { raw_message: "signed bump\n\nRetrace-Actor: claude-code\n" } });
  assert.equal((await verifyProducerSigResult(asWithheld(idMismatchSigned), key.publicKey, hookTrust)).ok, false, "withheld actor-id mismatch");

  const oboMismatchSigned = await signClaimed(key.privateKey, {
    actor: { type: "agent", id: "codex", on_behalf_of: "payload@example.com" },
  });
  assert.equal(
    (await verifyProducerSigResult(asWithheld(oboMismatchSigned, {
      claimDecision: withheldClaim({ signed_actor: { type: "agent", id: "codex", on_behalf_of: "payload@example.com" } }),
    }), key.publicKey, hookTrust)).ok,
    false,
    "withheld on_behalf_of mismatch vs re-derived author email",
  );

  const legacy = await signClaimed(key.privateKey, {
    format: PRODUCER_SIG_FORMAT,
    params: { [CLAIM_DECISION_PARAM]: withheldClaim() },
  });
  const legacyWithheld = asWithheld(legacy);
  assert.equal((await verifyProducerSigResult(legacyWithheld, key.publicKey, hookTrust)).ok, false, "/1 never substitutes");
});

test("T32: trusted hook stamps are exact membership, not a name heuristic", async () => {
  const key = await generateSigningKey();
  const signed = await signClaimed(key.privateKey);
  const valid = asWithheld(signed);

  assert.equal((await verifyProducerSigResult(valid, key.publicKey)).ok, false, "no list supplied → fail closed");
  assert.equal((await verifyProducerSigResult(valid, key.publicKey, { trustedHookStamps: [] })).ok, false, "empty list → fail closed");

  for (const lookalike of ["assert:not a git hook", "assert:untrusted retrace-git observer"]) {
    const fixture = asWithheld(signed, { sealedBy: lookalike });
    assert.equal((await verifyProducerSigResult(fixture, key.publicKey, hookTrust)).ok, false, lookalike);
    const captured = captureSeals([{ ...fixture, id: "evt_lookalike", seq: 0, hash: "0", prev_hash: "0", received_at: fixture.timestamp!, timestamp: fixture.timestamp! }], {
      repoName: "p",
      hookSealedBy: [...PROJECT_HOOK_STAMPS],
    });
    assert.equal(captured.length, 0, `${lookalike} is not a captureSeals hook seal`);
  }

  const custom = asWithheld(signed, { sealedBy: "assert:release-recorder" });
  assert.equal((await verifyProducerSigResult(custom, key.publicKey, hookTrust)).ok, false, "custom stamp is not in project A's list");
  assert.equal(
    (await verifyProducerSigResult(custom, key.publicKey, { trustedHookStamps: ["assert:release-recorder"] })).ok,
    true,
    "configured custom stamp substitutes",
  );

  assert.equal(
    (await verifyProducerSigResult(valid, key.publicKey, { trustedHookStamps: ["assert:release-recorder"] })).ok,
    false,
    "cross-project: project A's stamps supplied while verifying project B's event",
  );
});

test("finding 2: signed_actor is the verified payload actor, not the re-derived claim", async () => {
  const key = await generateSigningKey();
  const idMismatch = await signClaimed(key.privateKey, {
    params: { raw_message: "signed bump\n\nRetrace-Actor: claude-code\n" },
  });
  const idV = await verifyProducerSigResult(idMismatch, key.publicKey);
  assert.equal(idV.ok, true);
  assert.equal(idV.signed_actor?.id, "codex");
  assert.notEqual(idV.signed_actor?.id, "claude-code");

  const oboMismatch = await signClaimed(key.privateKey, {
    actor: { type: "agent", id: "codex", on_behalf_of: "payload@example.com" },
  });
  const oboV = await verifyProducerSigResult(oboMismatch, key.publicKey);
  assert.equal(oboV.ok, true);
  assert.equal(oboV.signed_actor?.on_behalf_of, "payload@example.com");
  assert.notEqual(oboV.signed_actor?.on_behalf_of, "jordan@example.com");

  const { store, handle } = await hookHandler("off", key.publicKey);
  const res = await post(handle, "/events", idMismatch, HOOK_TOKEN);
  assert.equal(res.status, 201);
  assert.equal((store.events.at(-1)!.method?.params?.[PRODUCER_SIGNED_ACTOR_PARAM] as { id: string }).id, "codex");
});

test("finding 4: /1 ingress preserves claim_decision and producer_signed_actor", async () => {
  const key = await generateSigningKey();
  const planted = {
    [CLAIM_DECISION_PARAM]: { policy: "trailer-consistency/1", signed_actor: { type: "agent", id: "forged" } },
    [PRODUCER_SIGNED_ACTOR_PARAM]: { type: "agent", id: "forged" },
  };
  for (const requireSig of [false, true]) {
    for (const name of [CLAIM_DECISION_PARAM, PRODUCER_SIGNED_ACTOR_PARAM] as const) {
      const { store, handle } = await hookHandler("shadow", key.publicKey, { require_signature: requireSig });
      const extra = { [name]: planted[name] };
      const signed = await signProducer({
        ...commitInput(),
        method: { tool: "git", automated: true, params: { branch: "main", parents: ["p"], files: 1, sha: "abc", ...extra } },
      }, key.privateKey);
      const res = await post(handle, "/events", signed, HOOK_TOKEN);
      assert.equal(res.status, 201, `${name} require_signature=${requireSig}`);
      const sealed = store.events.at(-1)!;
      assert.deepEqual(sealed.method?.params?.[name], extra[name]);
      assert.equal(await verifyProducerSig(sealed, key.publicKey), true);
      if (name === CLAIM_DECISION_PARAM) {
        assert.equal(sealed.method?.params?.[PRODUCER_SIGNED_ACTOR_PARAM], undefined, "/1 must not receive a server /2 stamp");
      }
    }
  }
});
