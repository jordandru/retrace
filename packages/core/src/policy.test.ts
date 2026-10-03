import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalPolicyV1, canonicalRepositoryR, compareUtf8, contextKey, eventPolicyRef, jcsSerialize,
  documentMapKey, matchesPolicyActivationClausesOneToThree, parseJsonRejectDuplicateKeys,
  policyDigestOf, policyHashObject, selectPolicyForContext,
  validatePolicyBody, validatePolicyEnvelope, verifyPolicySelectionOffline, POLICY_PROFILE,
  PolicyDocument, PolicySelection, PolicySnapshot, evaluateActivation, localConfigDrift,
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

function oldSelectPolicyForContext(
  snapshot: PolicySnapshot,
  documents: ReadonlyMap<string, PolicyDocument>,
): PolicySelection {
  const activations = (snapshot.activations.length ? snapshot.activations : snapshot.events)
    .filter((e) => e.seq <= snapshot.U)
    .sort((a, b) => b.seq - a.seq);

  const olderEligibleVersions = (seq: number): number[] => {
    const older = activations.filter((e) => e.seq < seq).sort((a, b) => a.seq - b.seq);
    const versions: number[] = [];
    for (const e of older) {
      const ev = evaluateActivation(e, documents, versions);
      if (ev.status === "eligible") versions.push(ev.version);
    }
    return versions;
  };

  for (const e of activations) {
    const ev = evaluateActivation(e, documents, olderEligibleVersions(e.seq));
    if (ev.status === "incomplete") return ev;
    if (ev.status === "eligible") {
      return { status: "selected", digest: ev.digest, version: ev.version, seq: ev.seq, document: ev.document };
    }
  }
  return { status: "none" };
}

function policyDocument(
  project: string,
  version: number,
  seq: number,
  opts: { digest?: string; eventId?: string; supersedes?: string | null } = {},
): PolicyDocument {
  const digest = opts.digest ?? version.toString(16).padStart(64, "0");
  return {
    body: validatePolicyBody({
      profile: POLICY_PROFILE,
      project,
      trusted_hook_stamps: [],
      unresolved_claims: "record",
      repositories: [],
      github_repos: [],
    }),
    envelope: validatePolicyEnvelope({
      version,
      created_at: "2026-09-10T03:45:00.000Z",
      set_by: { type: "human", id: "x" },
      supersedes: opts.supersedes ?? null,
      activation: { event_id: opts.eventId ?? `evt_policy_${seq}`, seq },
    }),
    digest,
  };
}

function activationEvent(doc: PolicyDocument, over: Partial<Event> = {}): Event {
  return fakeEvent({
    id: doc.envelope.activation.event_id,
    seq: doc.envelope.activation.seq,
    project: doc.body.project,
    artifacts: [{ id: `policy:${doc.body.project}@${doc.digest}`, kind: "policy", role: "generated" }],
    method: {
      tool: "retrace-api",
      params: {
        sealed_by: SEALED_BY_OWNER,
        policy_profile: doc.body.profile,
        policy_version: doc.envelope.version,
        policy_digest: doc.digest,
        supersedes: doc.envelope.supersedes,
        set_by: doc.envelope.set_by,
      },
    },
    idempotency_key: `policy:${doc.body.project}:${doc.envelope.version}`,
    ...over,
  });
}

function policyDocuments(...docs: PolicyDocument[]): Map<string, PolicyDocument> {
  const result = new Map<string, PolicyDocument>();
  for (const doc of docs) {
    result.set(documentMapKey(doc.body.project, doc.digest), doc);
    result.set(doc.digest, doc);
  }
  return result;
}

function assertSelectionEquivalent(
  name: string,
  snapshot: PolicySnapshot,
  documents: ReadonlyMap<string, PolicyDocument>,
): void {
  assert.deepEqual(selectPolicyForContext(snapshot, documents), oldSelectPolicyForContext(snapshot, documents), name);
}

test("issue #153: policy selection optimization preserves reference results", () => {
  const v1 = policyDocument("p", 1, 2);
  const v2 = policyDocument("p", 2, 4, { supersedes: v1.digest });
  const ev1 = activationEvent(v1);
  const ev2 = activationEvent(v2);
  const ordinary = fakeEvent({
    id: "evt_ordinary",
    seq: 1,
    action: "edited",
    artifacts: [{ id: "repo:acme/app#README.md" }],
    idempotency_key: "edit:1",
    method: { tool: "cli", params: {} },
  });

  const noActivation = { U: 1, events: [ordinary], activations: [ordinary] };
  assertSelectionEquivalent("no activation", noActivation, new Map());

  const oneEligible = { U: 2, events: [ordinary, ev1], activations: [ordinary, ev1] };
  assertSelectionEquivalent("one eligible activation", oneEligible, policyDocuments(v1));

  const twoVersions = { U: 4, events: [ordinary, ev1, ev2], activations: [ordinary, ev1, ev2] };
  assertSelectionEquivalent("v1 then v2", twoVersions, policyDocuments(v1, v2));

  const copiedV1 = policyDocument("p", 1, 6, { digest: v1.digest });
  const copyEvent = activationEvent(copiedV1);
  const copyAfterV2 = { U: 6, events: [ordinary, ev1, ev2, copyEvent], activations: [ordinary, ev1, ev2, copyEvent] };
  assertSelectionEquivalent("copy of v1 after v2", copyAfterV2, policyDocuments(copiedV1, v2));
  const copySelected = selectPolicyForContext(copyAfterV2, policyDocuments(copiedV1, v2));
  assert.equal(copySelected.status === "selected" ? copySelected.digest : undefined, v2.digest);

  const missingDoc = policyDocument("p", 3, 8, { supersedes: v2.digest });
  const missingLater = { U: 8, events: [ev1, ev2, activationEvent(missingDoc)], activations: [ev1, ev2, activationEvent(missingDoc)] };
  assertSelectionEquivalent("later activation with missing document", missingLater, policyDocuments(v1, v2));
  assert.equal(selectPolicyForContext(missingLater, policyDocuments(v1, v2)).status, "incomplete");

  const forged = activationEvent(v2, { id: "evt_forged", seq: 5 });
  const forgedClause4 = { U: 5, events: [ev1, ev2, forged], activations: [ev1, ev2, forged] };
  assertSelectionEquivalent("forged activation", forgedClause4, policyDocuments(v1, v2));

  const auditMismatch = activationEvent(v1, { actor: { type: "human", id: "forged" } });
  const auditSnapshot = { U: 2, events: [auditMismatch], activations: [auditMismatch] };
  assertSelectionEquivalent("audit identity mismatch", auditSnapshot, policyDocuments(v1));
  const auditResult = verifyPolicySelectionOffline({
    project: "p",
    claimedDigest: v1.digest,
    readHeadSeq: 2,
    events: [
      fakeEvent({ id: "evt_0", seq: 0, action: "edited", artifacts: [{ id: "a" }], idempotency_key: "other:0", method: { tool: "cli", params: {} } }),
      fakeEvent({ id: "evt_1", seq: 1, action: "edited", artifacts: [{ id: "a" }], idempotency_key: "other:1", method: { tool: "cli", params: {} } }),
      auditMismatch,
    ],
    policies: [v1],
    coverageComplete: true,
  });
  assert.ok(auditResult.findings.includes("policy_audit_mismatch"));

  const otherProject = policyDocument("q", 1, 2, { digest: v1.digest, eventId: v1.envelope.activation.event_id });
  const wrongProject = { U: 2, events: [ev1], activations: [ev1] };
  assertSelectionEquivalent("policy for another project", wrongProject, policyDocuments(otherProject));

  const unsupported = policyDocument("p", 1, 2);
  unsupported.body = { ...unsupported.body, profile: "retrace-project-policy/999" as typeof POLICY_PROFILE };
  const unsupportedEvent = activationEvent(unsupported);
  const unsupportedProfile = { U: 2, events: [unsupportedEvent], activations: [unsupportedEvent] };
  assertSelectionEquivalent("unsupported profile", unsupportedProfile, policyDocuments(unsupported));

  const nonStringArtifact = fakeEvent({
    id: "evt_non_string",
    seq: 2,
    artifacts: [{ id: 42 } as unknown as Event["artifacts"][number]],
  });
  const nonString = { U: 2, events: [nonStringArtifact], activations: [nonStringArtifact] };
  assert.equal(matchesPolicyActivationClausesOneToThree(nonStringArtifact), false);
  assertSelectionEquivalent("non-string policy artifact id", nonString, new Map());
});

test("issue #153: optimized selection matches reference on 2,048 seeded mixed events", () => {
  let state = 0x153c0de;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  const events: Event[] = [];
  const docs: PolicyDocument[] = [];
  let previousDigest: string | null = null;
  for (let seq = 0; seq < 2_048; seq++) {
    const value = random();
    if (seq % 257 === 0) {
      const doc = policyDocument("p", docs.length + 1, seq, { supersedes: previousDigest });
      docs.push(doc);
      previousDigest = doc.digest;
      events.push(activationEvent(doc));
    } else if (docs.length && value % 89 === 0) {
      const doc = docs[value % docs.length]!;
      events.push(activationEvent(doc, { id: `evt_copy_${seq}`, seq }));
    } else {
      const variants = [
        { idempotency_key: `ordinary:${seq}` },
        { action: "edited" as const },
        { method: { tool: "cli", params: { sealed_by: SEALED_BY_OWNER } } },
        { artifacts: [{ id: `repo:acme/app#${seq}` }] },
      ];
      events.push(fakeEvent({ id: `evt_${seq}`, seq, ...variants[value % variants.length]! }));
    }
  }

  const snapshot = { U: events.length - 1, events, activations: events };
  assertSelectionEquivalent("seeded mixed sequence", snapshot, policyDocuments(...docs));
});

test("issue #153: ordinary-event selection work grows linearly", () => {
  const filterCalls = (count: number): number => {
    let calls = 0;
    const events = Array.from({ length: count }, (_, seq) => {
      const event = fakeEvent({
        id: `evt_${seq}`,
        seq,
        action: "edited",
        idempotency_key: `ordinary:${seq}`,
        artifacts: [{ id: `repo:acme/app#${seq}` }],
        method: { tool: "cli", params: {} },
      });
      const artifacts = event.artifacts;
      Object.defineProperty(artifacts, "filter", {
        value: (...args: Parameters<typeof artifacts.filter>) => {
          calls++;
          return Array.prototype.filter.apply(artifacts, args);
        },
      });
      return event;
    });
    assert.deepEqual(selectPolicyForContext({ U: count - 1, events, activations: events }, new Map()), { status: "none" });
    return calls;
  };

  assert.equal(filterCalls(200), 200);
  assert.equal(filterCalls(400), 400);
});

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
  assert.equal(ev.status === "ignored" ? ev.reason : undefined, "policy_audit_mismatch");
});

test("N3: spoofed activation actor/set_by is policy_audit_mismatch, not policy_missing", () => {
  const v1: PolicyDocument = {
    body: validatePolicyBody({ profile: POLICY_PROFILE, project: "p", trusted_hook_stamps: [], unresolved_claims: "record", repositories: [], github_repos: [] }),
    envelope: validatePolicyEnvelope({ version: 1, created_at: "2026-09-10T03:45:00.000Z", set_by: { type: "human", id: "x" }, supersedes: null, activation: { event_id: "evt_v1", seq: 5 } }),
    digest: "d1".padEnd(64, "0"),
  };
  const art = `policy:p@${v1.digest}`;
  const prefix = [0, 1, 2, 3, 4].map((seq) => fakeEvent({
    id: `e${seq}`, seq, action: "instructed", artifacts: [{ id: "t" }],
    actor: { type: "human", id: "j" }, idempotency_key: `x:${seq}`,
  }));
  const forged = fakeEvent({
    id: "evt_v1", seq: 5, artifacts: [{ id: art, kind: "policy", role: "generated" }],
    actor: { type: "human", id: "invented" },
    method: { tool: "retrace-api", params: { sealed_by: SEALED_BY_OWNER, policy_profile: POLICY_PROFILE, policy_version: 1, policy_digest: v1.digest, supersedes: null, set_by: { type: "human", id: "other" } } },
    idempotency_key: "policy:p:1",
  });
  const result = verifyPolicySelectionOffline({
    project: "p",
    claimedDigest: v1.digest,
    readHeadSeq: 5,
    events: [...prefix, forged],
    policies: [v1],
    coverageComplete: true,
  });
  assert.ok(result.findings.includes("policy_audit_mismatch"), JSON.stringify(result.findings));
  assert.equal(result.findings.includes("policy_missing"), false, JSON.stringify(result.findings));

  const other = "d2".padEnd(64, "0");
  const olderSpoof = fakeEvent({
    id: "evt_old", seq: 3, artifacts: [{ id: art, kind: "policy", role: "generated" }],
    actor: { type: "human", id: "invented" },
    method: { tool: "retrace-api", params: { sealed_by: SEALED_BY_OWNER, policy_profile: POLICY_PROFILE, policy_version: 1, policy_digest: v1.digest, supersedes: null, set_by: { type: "human", id: "other" } } },
    idempotency_key: "policy:p:1",
  });
  const unrelated = fakeEvent({
    id: "e5b", seq: 5, action: "instructed", artifacts: [{ id: "t" }],
    actor: { type: "human", id: "j" }, idempotency_key: "x:5",
  });
  const onlyClaimed = verifyPolicySelectionOffline({
    project: "p",
    claimedDigest: other,
    readHeadSeq: 5,
    events: [...prefix.slice(0, 3), olderSpoof, prefix[4]!, unrelated],
    policies: [v1],
    coverageComplete: true,
  });
  assert.ok(onlyClaimed.findings.includes("policy_missing"), JSON.stringify(onlyClaimed.findings));
  assert.equal(onlyClaimed.findings.includes("policy_audit_mismatch"), false, "audit mismatch is for the claimed activation only");
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

test("§1.3 /2 golden vectors, App identities and case-insensitive uniqueness; /1 remains frozen", async () => {
  const v2dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/policy-v2");
  for (const filename of readdirSync(v2dir)) {
    const vector = JSON.parse(readFileSync(join(v2dir, filename), "utf8"));
    if (vector.rejected) { assert.throws(() => validatePolicyBody(vector.body), /unique case-insensitively/); continue; }
    const body = validatePolicyBody(vector.body);
    assert.equal(canonicalPolicyV1(policyHashObject(body, vector.envelope)), vector.canonical);
    assert.equal(await policyDigestOf(body, vector.envelope), vector.digest);
  }
  const base = { profile: "retrace-project-policy/2", project: "p", trusted_hook_stamps: [], unresolved_claims: "record", repositories: [], github_repos: [] };
  const good = { ...base, github: { shared_logins: [], identities: {} } };
  assert.equal(validatePolicyBody(good).profile, "retrace-project-policy/2");
  assert.throws(() => validatePolicyBody(base), /missing required field github/);
  assert.throws(() => validatePolicyBody({ ...good, profile: POLICY_PROFILE }), /unknown field/);
  for (const github of [
    { shared_logins: ["z", "a"], identities: {} },
    { shared_logins: ["bad_login"], identities: {} },
    { shared_logins: ["-bad"], identities: {} },
    { shared_logins: ["bad-"], identities: {} },
    { shared_logins: ["a".repeat(40)], identities: {} },
    { shared_logins: [], identities: { "Bot[bot]": "one", "bot[bot]": "two" } },
    { shared_logins: [], identities: { "valid": "" } },
    { shared_logins: [], identities: {}, extra: [] },
    { shared_logins: [] },
  ]) assert.throws(() => validatePolicyBody({ ...base, github }), e => (e as any).status === 400);
  assert.equal(validatePolicyBody({ ...base, github: { shared_logins: ["A", "retrace-claude-code[bot]"], identities: { "retrace-claude-code[bot]": "claude-code" } } }).github!.identities["retrace-claude-code[bot]"], "claude-code");
});

test("§1.3 /1 → /2 activation stamps the document profile, retains historical selection and verifies mixed export", async () => {
  const { MemoryEventStore, createHandler, buildExportBundle, verifyExportBundle, generateSigningKey } = await import("./index.js");
  const store = new MemoryEventStore();
  const handler = createHandler(store, { token: "owner-token", ownerPrincipal: { type: "human", id: "owner" } });
  const base = { profile: POLICY_PROFILE, project: "p", trusted_hook_stamps: [], unresolved_claims: "record", repositories: [], github_repos: [] };
  const put = async (body: unknown, previous: string) => {
    const response = await handler(new Request("http://test/projects/p/policy", { method: "PUT", headers: { authorization: "Bearer owner-token", "content-type": "application/json", "if-match": previous }, body: JSON.stringify(body) }));
    assert.equal(response.status, 201, await response.clone().text());
    return await response.json() as PolicyDocument;
  };
  const first = await put(base, "none");
  const second = await put({ ...base, profile: "retrace-project-policy/2", github: { shared_logins: ["jordandru"], identities: {} } }, first.digest);
  assert.equal(store.events[1].method!.params!.policy_profile, "retrace-project-policy/2");
  for (const [doc, head] of [[first, 0], [second, 1]] as const) {
    const result = verifyPolicySelectionOffline({ project: "p", claimedDigest: doc.digest, readHeadSeq: head, events: store.events, policies: [first, second], coverageComplete: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.selected?.status, "selected");
  }
  const key = await generateSigningKey();
  const bundle = await buildExportBundle(store, { project: "p" }, { signingKey: key.privateKey });
  const verdict = await verifyExportBundle(bundle);
  assert.deepEqual(verdict.policy_findings ?? [], []);
});
