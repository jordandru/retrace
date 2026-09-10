import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalPolicyV1, canonicalRepositoryR, compareUtf8, contextKey, eventPolicyRef, jcsSerialize,
  parseJsonRejectDuplicateKeys, policyDigestOf, policyHashObject, selectPolicyForContext,
  validatePolicyBody, validatePolicyEnvelope, verifyPolicySelectionOffline, POLICY_PROFILE,
  PolicyDocument, evaluateActivation, localConfigDrift,
} from "./policy.js";
import { SEALED_BY_OWNER } from "./store.js";
import { Event } from "./schema.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/policy-v1");

function loadVectors() {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
    const raw = readFileSync(join(dir, f), "utf8");
    return { file: f, raw, data: JSON.parse(raw) as { name: string; body: unknown; envelope: unknown; canonical?: string; digest?: string } };
  });
}

test("P2: golden body+envelope vectors are byte-exact and recomputed every run", async () => {
  const vectors = loadVectors();
  assert.ok(vectors.length >= 5, "need at least five golden vectors");
  const names = new Set(vectors.map((v) => v.data.name));
  assert.ok(names.has("ascii"));
  assert.ok(names.has("non-ascii"));
  assert.ok(names.has("escapes"));
  assert.ok(names.has("v1-supersedes-null"));
  assert.ok(names.has("v2-supersedes"));
  for (const v of vectors) {
    const body = validatePolicyBody(v.data.body);
    const envelope = validatePolicyEnvelope(v.data.envelope);
    const canonical = canonicalPolicyV1(policyHashObject(body, envelope));
    const digest = await policyDigestOf(body, envelope);
    if (!v.data.canonical || !v.data.digest) {
      assert.fail(`${v.file} missing frozen canonical/digest. computed canonical=${canonical} digest=${digest}`);
    }
    assert.equal(canonical, v.data.canonical, v.file);
    assert.equal(digest, v.data.digest, v.file);
    assert.equal(envelope.version >= 1, true);
    if (v.data.name === "v1-supersedes-null") assert.equal(envelope.supersedes, null);
    if (v.data.name === "v2-supersedes") assert.ok(typeof envelope.supersedes === "string");
  }
});

test("P2 / builder note 3: \"a\" and \"\\u0061\" produce one digest; duplicate keys rejected on raw bytes", async () => {
  const a = validatePolicyBody({
    profile: POLICY_PROFILE, project: "p", trusted_hook_stamps: ["a"], unresolved_claims: "record",
    repositories: [], github_repos: [],
  });
  const escaped = parseJsonRejectDuplicateKeys(`{"profile":"${POLICY_PROFILE}","project":"p","trusted_hook_stamps":["\\u0061"],"unresolved_claims":"record","repositories":[],"github_repos":[]}`);
  const b = validatePolicyBody(escaped);
  assert.equal(await policyDigestOf(a, env1()), await policyDigestOf(b, env1()));
  assert.equal(canonicalPolicyV1({ s: "a" } as any), canonicalPolicyV1({ s: "\u0061" } as any));
  assert.throws(() => parseJsonRejectDuplicateKeys('{"a":1,"a":2}'), /duplicate object key/);
  assert.throws(() => parseJsonRejectDuplicateKeys('{"outer":{"x":1,"x":2}}'), /duplicate object key/);
  const ok = parseJsonRejectDuplicateKeys('{"a":1,"b":{"a":2}}');
  assert.equal(JSON.stringify(ok), JSON.stringify({ a: 1, b: { a: 2 } }));
  assert.equal(Object.getPrototypeOf(ok), null);
});

test("P2: unsorted/duplicate arrays, floats, negatives, 2^53, lone surrogate, unknown fields → 400", () => {
  const base = { profile: POLICY_PROFILE, project: "p", trusted_hook_stamps: ["a"], unresolved_claims: "record", repositories: [], github_repos: [] };
  assert.throws(() => validatePolicyBody({ ...base, trusted_hook_stamps: ["b", "a"] }), /sorted/);
  assert.throws(() => validatePolicyBody({ ...base, trusted_hook_stamps: ["a", "a"] }), /unique/);
  assert.throws(() => validatePolicyBody({ ...base, extra: true } as any), /unknown field/);
  assert.throws(() => validatePolicyBody({ ...base, repositories: [{ name: "acme/r", aliases: [], nope: 1 }] } as any), /unknown field/);
  assert.throws(() => validatePolicyEnvelope({ version: 1.5, created_at: "2026-09-10T03:45:00.000Z", set_by: { type: "human", id: "x" }, supersedes: null, activation: { event_id: "e", seq: 0 } }), /integer/);
  assert.throws(() => validatePolicyEnvelope({ version: -1, created_at: "2026-09-10T03:45:00.000Z", set_by: { type: "human", id: "x" }, supersedes: null, activation: { event_id: "e", seq: 0 } }), /integer/);
  assert.throws(() => validatePolicyEnvelope({ version: 9007199254740992, created_at: "2026-09-10T03:45:00.000Z", set_by: { type: "human", id: "x" }, supersedes: null, activation: { event_id: "e", seq: 0 } } as any), /integer|2\^53/);
  assert.throws(() => jcsSerialize(1.5), /integer/);
  const lone = "\uD800";
  assert.throws(() => validatePolicyBody({ ...base, project: lone }), /surrogate/);
});

function env1() {
  return validatePolicyEnvelope({
    version: 1, created_at: "2026-09-10T03:45:00.000Z", set_by: { type: "human", id: "x" },
    supersedes: null, activation: { event_id: "evt_a", seq: 0 },
  });
}

function fakeEvent(over: Partial<Event> & { seq: number; id: string; project?: string }): Event {
  const overMethod = over.method;
  const { method: _method, ...rest } = over;
  return {
    project: over.project ?? "p",
    actor: { type: "system", id: "retrace-api", on_behalf_of: "human:x" },
    action: "created",
    artifacts: over.artifacts ?? [{ id: "policy:p@dead", kind: "policy", role: "generated" }],
    intent: "policy v1 activated",
    method: {
      tool: "retrace-api",
      ...overMethod,
      params: {
        sealed_by: SEALED_BY_OWNER,
        policy_profile: POLICY_PROFILE,
        policy_version: 1,
        policy_digest: "dead",
        supersedes: null,
        set_by: { type: "human", id: "x" },
        ...overMethod?.params,
      },
    },
    idempotency_key: over.idempotency_key ?? "policy:p:1",
    timestamp: "2026-09-10T03:45:00.000Z",
    prev_hash: "0".repeat(64),
    hash: "h",
    received_at: "2026-09-10T03:45:00.000Z",
    hash_v: 2,
    ...rest,
    id: over.id,
    seq: over.seq,
  } as Event;
}

test("P4 / builder note 1: missing v2 document fails closed; copied v1 after v2 is ignored", async () => {
  const v1: PolicyDocument = {
    body: validatePolicyBody({ profile: POLICY_PROFILE, project: "p", trusted_hook_stamps: ["X"], unresolved_claims: "record", repositories: [], github_repos: [] }),
    envelope: validatePolicyEnvelope({ version: 1, created_at: "2026-09-10T03:45:00.000Z", set_by: { type: "human", id: "x" }, supersedes: null, activation: { event_id: "evt_v1", seq: 5 } }),
    digest: "d1".padEnd(64, "0"),
  };
  v1.body = v1.body; // keep
  const v1art = `policy:p@${v1.digest}`;
  const ev1 = fakeEvent({
    id: "evt_v1", seq: 5, artifacts: [{ id: v1art, kind: "policy", role: "generated" }],
    method: { tool: "retrace-api", params: { sealed_by: SEALED_BY_OWNER, policy_profile: POLICY_PROFILE, policy_version: 1, policy_digest: v1.digest, supersedes: null } },
    idempotency_key: "policy:p:1",
  });
  const ev2 = fakeEvent({
    id: "evt_v2", seq: 6, artifacts: [{ id: "policy:p@" + "d2".padEnd(64, "0"), kind: "policy", role: "generated" }],
    method: { tool: "retrace-api", params: { sealed_by: SEALED_BY_OWNER, policy_profile: POLICY_PROFILE, policy_version: 2, policy_digest: "d2".padEnd(64, "0"), supersedes: v1.digest } },
    idempotency_key: "policy:p:2",
  });
  const docs = new Map<string, PolicyDocument>([[`${"p"}\0${v1.digest}`, v1], [v1.digest, v1]]);
  const missingV2 = selectPolicyForContext({ U: 6, events: [ev1, ev2], activations: [ev1, ev2] }, docs);
  assert.equal(missingV2.status, "incomplete");
  assert.equal(missingV2.status === "incomplete" && missingV2.reason, "policy_missing");

  const copy = fakeEvent({
    id: "evt_copy", seq: 7, artifacts: [{ id: v1art, kind: "policy", role: "generated" }],
    method: { tool: "retrace-api", params: { sealed_by: SEALED_BY_OWNER, policy_profile: POLICY_PROFILE, policy_version: 1, policy_digest: v1.digest, supersedes: null } },
    idempotency_key: "not-reserved",
  });
  const v2: PolicyDocument = {
    body: { ...v1.body, trusted_hook_stamps: [] },
    envelope: validatePolicyEnvelope({ version: 2, created_at: "2026-09-10T04:00:00.000Z", set_by: { type: "human", id: "x" }, supersedes: v1.digest, activation: { event_id: "evt_v2", seq: 6 } }),
    digest: "d2".padEnd(64, "0"),
  };
  const both = new Map(docs);
  both.set(`p\0${v2.digest}`, v2);
  both.set(v2.digest, v2);
  const ev2ok = fakeEvent({
    id: "evt_v2", seq: 6, artifacts: [{ id: `policy:p@${v2.digest}`, kind: "policy", role: "generated" }],
    method: { tool: "retrace-api", params: { sealed_by: SEALED_BY_OWNER, policy_profile: POLICY_PROFILE, policy_version: 2, policy_digest: v2.digest, supersedes: v1.digest } },
    idempotency_key: "policy:p:2",
  });
  const selected = selectPolicyForContext({ U: 7, events: [ev1, ev2ok, copy], activations: [ev1, ev2ok, copy] }, both);
  assert.equal(selected.status, "selected");
  if (selected.status === "selected") assert.equal(selected.digest, v2.digest);

  const at100 = selectPolicyForContext({ U: 5, events: [ev1, ev2ok], activations: [ev1] }, both);
  assert.equal(at100.status, "selected");
  if (at100.status === "selected") assert.equal(at100.digest, v1.digest);

  const prefix = [0, 1, 2, 3, 4].map((seq) => fakeEvent({
    id: `evt_${seq}`, seq, project: "p", idempotency_key: `other:${seq}`,
    artifacts: [{ id: "a" }], action: "edited", actor: { type: "agent", id: "x" },
    method: { tool: "cli", params: {} },
  }));
  const mis = verifyPolicySelectionOffline({
    project: "p", claimedDigest: v2.digest, readHeadSeq: 5, events: [...prefix, ev1, ev2ok], policies: [v1, v2], coverageComplete: true,
  });
  assert.equal(mis.ok, false);
  assert.ok(mis.findings.includes("policy_misselected"));

  const incompleteEvidence = verifyPolicySelectionOffline({
    project: "p", claimedDigest: v1.digest, readHeadSeq: 6, events: [...prefix, ev1, ev2], policies: [v1], coverageComplete: true,
  });
  assert.equal(incompleteEvidence.ok, false);
  assert.ok(incompleteEvidence.findings.includes("policy_missing"), JSON.stringify(incompleteEvidence.findings));
  assert.ok(!incompleteEvidence.findings.every((f) => f === "policy_misselected"));

  const scoped = verifyPolicySelectionOffline({
    project: "p", claimedDigest: v1.digest, readHeadSeq: 5, events: [ev1], policies: [v1], coverageComplete: false,
  });
  assert.ok(scoped.findings.includes("policy_selection_unverifiable"));
});

test("P7: context key is (project, canonical R, sha); aliases collapse to one R", () => {
  const body = validatePolicyBody({
    profile: POLICY_PROFILE, project: "p", trusted_hook_stamps: [], unresolved_claims: "record",
    repositories: [{ name: "acme/app", aliases: ["acme-app", "app"] }], github_repos: ["acme/app"],
  });
  assert.equal(canonicalRepositoryR(body, "app"), "acme/app");
  assert.equal(canonicalRepositoryR(body, "acme-app"), "acme/app");
  assert.equal(contextKey("p", "acme/app", "abc"), contextKey("p", canonicalRepositoryR(body, "app")!, "abc"));
  const renamed = validatePolicyBody({
    profile: POLICY_PROFILE, project: "p", trusted_hook_stamps: [], unresolved_claims: "record",
    repositories: [{ name: "acme/app", aliases: ["legacy"] }], github_repos: ["acme/app"],
  });
  assert.equal(canonicalRepositoryR(renamed, "legacy"), "acme/app");
  assert.equal(contextKey("p", canonicalRepositoryR(body, "app")!, "abc"), contextKey("p", canonicalRepositoryR(renamed, "legacy")!, "abc"));
  assert.notEqual(contextKey("p", "acme/app", "abc"), contextKey("p", "acme/fork", "abc"));
  assert.equal(compareUtf8("a", "b") < 0, true);
  assert.ok(eventPolicyRef({ method: { params: { claim_decision: { context: { policy_digest: "d", read_head_seq: 3 } } } } } as unknown as Event).digest === "d");
});

test("F1: prototype-safe parse rejects __proto__ wrapper and unescaped newlines", () => {
  const body = {
    profile: POLICY_PROFILE, project: "p", trusted_hook_stamps: [], unresolved_claims: "record",
    repositories: [], github_repos: [],
  };
  assert.throws(() => parseJsonRejectDuplicateKeys(`{"__proto__":${JSON.stringify(body)}}`), /forbidden object key/);
  assert.throws(() => parseJsonRejectDuplicateKeys('{"a":"line\nbreak"}'), /unescaped control character/);
  const protoSafe = parseJsonRejectDuplicateKeys('{"ok":1}') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(protoSafe), null);
  assert.equal(protoSafe.ok, 1);
});

test("F4: activation identity mismatch is ignored so a later real activation can win", () => {
  const v1: PolicyDocument = {
    body: validatePolicyBody({ profile: POLICY_PROFILE, project: "p", trusted_hook_stamps: [], unresolved_claims: "record", repositories: [], github_repos: [] }),
    envelope: validatePolicyEnvelope({ version: 1, created_at: "2026-09-10T03:45:00.000Z", set_by: { type: "human", id: "x" }, supersedes: null, activation: { event_id: "evt_v1", seq: 5 } }),
    digest: "d1".padEnd(64, "0"),
  };
  const art = `policy:p@${v1.digest}`;
  const docs = new Map<string, PolicyDocument>([[`p\0${v1.digest}`, v1], [v1.digest, v1]]);
  const forged = fakeEvent({
    id: "evt_v1", seq: 5, artifacts: [{ id: art, kind: "policy", role: "generated" }],
    actor: { type: "human", id: "invented" },
    method: { tool: "retrace-api", params: { sealed_by: SEALED_BY_OWNER, policy_profile: POLICY_PROFILE, policy_version: 1, policy_digest: v1.digest, supersedes: null, set_by: { type: "human", id: "other" } } },
    idempotency_key: "policy:p:1",
  });
  const ev = evaluateActivation(forged, docs, []);
  assert.equal(ev.status, "ignored");
});

test("F14: localConfigDrift compares aliases, not only repository names", () => {
  const body = validatePolicyBody({
    profile: POLICY_PROFILE, project: "p", trusted_hook_stamps: ["a"], unresolved_claims: "record",
    repositories: [{ name: "acme/app", aliases: ["new"] }], github_repos: ["acme/app"],
  });
  const sameNames = localConfigDrift({
    stamps: ["a"],
    repositories: [{ name: "acme/app", aliases: ["old"] }],
  }, body);
  assert.equal(sameNames.drifted, true);
  assert.match(sameNames.detail, /repositories/);
  const match = localConfigDrift({
    stamps: ["a"],
    repositories: [{ name: "acme/app", aliases: ["new"] }],
  }, body);
  assert.equal(match.drifted, false);
});
