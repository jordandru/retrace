/**
 * NOOA audit durable fix, step 1: verifyExportBundle reads policy selection from one forward pass over the events and a binary
 * search per reference (offlinePolicySelectionVerifier) instead of one verifyPolicySelectionOffline call per policy-reference event.
 * Equivalence is the spec: the whole ExportVerdict must equal the one the per-reference loop gave. The reference below is
 * verifyExportBundle and checkCoverage as they stood on main at f8d15aa7, copied verbatim except for their names.
 * Synthetic fixtures only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Event, GENESIS_HASH } from "./schema.js";
import { computeHash, hashRule, sha256Hex } from "./chain.js";
import { ProducerKey, countProducerSigs } from "./producer-sig.js";
import { generateSigningKey, keyId, signCanonical, verifyCanonical } from "./signing.js";
import { ExportBundle, ExportCoverage, ExportScope, ExportVerdict, EXPORT_FORMAT, verifyExportBundle } from "./export.js";
import {
  POLICY_ACTOR_ID, POLICY_PROFILE, SUPPORTED_POLICY_PROFILES, PolicyDocument, PolicyVerifyFinding, canonicalPolicyV1, eventPolicyRef,
  offlinePolicySelectionVerifier, policyDigestOf, policyHashObject, validatePolicyBody, validatePolicyEnvelope,
  verifyPolicySelectionOffline,
} from "./policy.js";
import { SEALED_BY_OWNER } from "./store.js";

// ---- Reference: main at f8d15aa7, packages/core/src/export.ts lines 143–293 ----

const MISSING_SEQ_CAP = 50;

/** Omission check over a bundle whose events are sorted by seq. Pushes problems; returns the coverage record. */
function referenceCheckCoverage(bundle: ExportBundle, sorted: Event[], problems: string[]): ExportCoverage {
  const s = bundle.scope ?? ({} as ExportScope);
  const scoped = !!(s.artifact_id || s.actor_id || s.since || s.until);
  const total = bundle.chain?.total_events;
  const n = sorted.length;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) {
    problems.push("bundle does not state chain.total_events — omission cannot be checked");
    return { scope: scoped ? "scoped" : "full", events: n, total_events: -1, complete: scoped ? undefined : false, note: "issuer did not declare the project size at export time" };
  }
  // Checks that hold for every bundle: no seq outside the claimed range, no duplicate seq.
  const seen = new Set<number>();
  for (const e of sorted) {
    if (e.seq < 0 || e.seq >= total) problems.push(`event #${e.seq} lies outside the ${total} events claimed at export`);
    if (seen.has(e.seq)) problems.push(`event #${e.seq} appears more than once`);
    seen.add(e.seq);
  }
  if (scoped) {
    return {
      scope: "scoped", events: n, total_events: total,
      note: `scoped bundle: ${n} of ${total} project events (${bundle.context_events ?? 0} causal context); omission within the scope cannot be verified offline — compare against a full export or a published head checkpoint`,
    };
  }
  // Full export: every claimed event must be present, contiguous from 0, and end at the claimed head.
  const missing: number[] = [];
  for (let i = 0; i < total; i++) if (!seen.has(i)) { if (missing.length < MISSING_SEQ_CAP) missing.push(i); }
  const missingCount = total - seen.size + [...seen].filter((x) => x < 0 || x >= total).length;
  let complete = true;
  if (n !== total || missingCount > 0) {
    complete = false;
    const tail = missing.length && missing[0] === n && missing.at(-1) === total - 1 && missingCount === total - n;
    problems.push(
      tail
        ? `bundle ends at #${n - 1} but ${total} events were claimed at export — the tail (${missingCount} event${missingCount === 1 ? "" : "s"}) is missing`
        : `bundle holds ${n} of ${total} claimed events — missing seq ${missing.slice(0, 10).join(", ")}${missingCount > 10 ? ` … (${missingCount} total)` : ""}`,
    );
  }
  const last = sorted.at(-1);
  let head_hash_matches: boolean | undefined;
  if (!bundle.chain.head_hash) {
    if (total > 0) { complete = false; problems.push("bundle does not state chain.head_hash — the export cannot be anchored to a chain head"); }
  } else if (last) {
    head_hash_matches = last.hash === bundle.chain.head_hash;
    if (!head_hash_matches && complete) { complete = false; problems.push(`last event #${last.seq} hash does not match the head_hash claimed at export — tail truncated or altered`); }
    else if (!head_hash_matches) problems.push("last event hash does not match the claimed head_hash");
  } else if (total > 0) { complete = false; head_hash_matches = false; }
  return {
    scope: "full", events: n, total_events: total, complete, head_hash_matches, missing_seqs: missing.length ? missing : undefined,
    note: complete
      ? `full export: all ${total} events present, contiguous from #0, ending at the claimed head — no omission since export time (the head itself is the issuer's claim; pin it with a checkpoint)`
      : `full export is incomplete: ${n} of ${total} claimed events`,
  };
}

/** Offline verification: signature + per-event content hashes + adjacency links + omission (coverage). */
async function referenceVerifyExportBundle(bundle: ExportBundle, trustedPublicKey?: JsonWebKey, vopts?: { producers?: ProducerKey[]; trustedHookStamps?: readonly string[]; project?: string }): Promise<ExportVerdict> {
  const problems: string[] = [];
  let signature: ExportVerdict["signature"] = "unsigned";
  if (bundle.signature && bundle.issuer) {
    const pub = trustedPublicKey ?? bundle.issuer.public_key;
    if (trustedPublicKey && (await keyId(trustedPublicKey)) !== bundle.issuer.kid) problems.push("issuer kid does not match trusted key");
    const ok = await verifyCanonical(pub, { ...bundle, signature: undefined }, bundle.signature);
    if (!ok) { signature = "invalid"; problems.push("signature does not verify — bundle altered or wrong key"); }
    else if (trustedPublicKey) signature = "valid";
    else {
      // The bundle carries its own public key, so a verifier that trusts it only learns that the bundle is internally
      // consistent — anyone can re-sign an altered bundle with a fresh key. That is not "valid"; it is self-attested.
      signature = "self_attested";
      problems.push(`signature verifies against the key embedded in the bundle (kid ${bundle.issuer.kid}) — not against a trusted key; confirm the kid with the issuer's /.well-known/retrace-pubkey or pass the issuer's public key`);
    }
  } else problems.push("bundle is unsigned");

  let events_intact = true;
  let legacy_hash_events = 0;
  for (const e of bundle.events) {
    if (hashRule(e) === "legacy") legacy_hash_events++;
    if ((await computeHash(e)) !== e.hash) { events_intact = false; problems.push(`event #${e.seq} content hash mismatch`); }
  }
  let links_consistent = true;
  const sorted = [...bundle.events].sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (b.seq === a.seq + 1 && b.prev_hash !== a.hash) { links_consistent = false; problems.push(`event #${b.seq} prev_hash does not link to #${a.seq}`); }
  }
  if (sorted[0]?.seq === 0 && sorted[0].prev_hash !== GENESIS_HASH) { links_consistent = false; problems.push("event #0 is not anchored to genesis"); }
  const coverage = referenceCheckCoverage(bundle, sorted, problems);
  // Producer signatures (rung 5): a supplied trusted list REPLACES the bundle's own (which is self-attested, like the
  // issuer key); with neither, signed events are uncheckable and only the unsigned-agent count is meaningful.
  const producerKeys = vopts?.producers ?? bundle.producers ?? [];
  const project = vopts?.project ?? bundle.scope.project;
  // Document resolution is authoritative even if a caller supplies trustedHookStamps.
  const stampsFor = (e: Event) => {
    const digest = eventPolicyRef(e).digest;
    if (!digest) return undefined;
    const docs = bundle.policies ?? [];
    return docs.find((d) => d.digest === digest && d.body.project === e.project)?.body.trusted_hook_stamps;
  };
  const ps = await countProducerSigs(sorted, producerKeys, { stampsFor, project });
  problems.push(...ps.problems);
  const policy_findings: PolicyVerifyFinding[] = [];
  if (bundle.policies) {
    for (const d of bundle.policies) {
      try {
        const recomputed = await sha256Hex(canonicalPolicyV1(policyHashObject(d.body, d.envelope)));
        if (recomputed !== d.digest) {
          policy_findings.push("policy_corrupt");
          problems.push(`policy ${d.digest} digest mismatch`);
        }
        try {
          validatePolicyBody(d.body);
          validatePolicyEnvelope(d.envelope);
        } catch (err: any) {
          policy_findings.push("policy_corrupt");
          problems.push(`policy ${d.digest} failed policy validation: ${err?.message ?? err}`);
        }
        if (d.body.project !== bundle.scope.project) {
          policy_findings.push("policy_project_mismatch");
          problems.push(`policy ${d.digest} project ${d.body.project} != bundle ${bundle.scope.project}`);
        }
        if (!SUPPORTED_POLICY_PROFILES.has(d.body.profile)) {
          policy_findings.push("policy_unsupported_profile");
          problems.push(`policy ${d.digest} unsupported profile`);
        }
      } catch (e: any) {
        policy_findings.push("policy_corrupt");
        problems.push(`policy ${d.digest} failed to recompute: ${e?.message ?? e}`);
      }
    }
  }
  const refs = sorted.map((e) => ({ e, ref: eventPolicyRef(e) })).filter((x) => x.ref.digest);
  for (const { e, ref } of refs) {
    const result = verifyPolicySelectionOffline({
      project: e.project,
      claimedDigest: ref.digest,
      readHeadSeq: ref.readHeadSeq,
      events: sorted,
      policies: bundle.policies ?? [],
      coverageComplete: coverage.complete === true || (coverage.scope === "full" && coverage.complete !== false),
    });
    policy_findings.push(...result.findings);
    for (const f of result.findings) problems.push(`event #${e.seq} ${f}`);
  }
  return {
    signature, events_intact, links_consistent, chain_ok_at_export: !!bundle.chain?.ok, coverage, legacy_hash_events,
    producer_signed: ps.producer_signed, producer_invalid: ps.producer_invalid,
    producer_unsigned_agent_events: ps.producer_unsigned_agent_events,
    kid: bundle.issuer?.kid, problems, policy_findings: policy_findings.length ? policy_findings : undefined,
  };
}

// ---- Fixtures ----

const P = "p";
const Q = "q";
const AT = "2026-10-13T00:00:00.000Z";
const FOREIGN_DIGEST = "f".repeat(64);

type Random = () => number;
function xorshift(seed: number): Random {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

async function makeDocument(project: string, version: number, activation: { event_id: string; seq: number }, supersedes: string | null): Promise<PolicyDocument> {
  const body = validatePolicyBody({
    profile: POLICY_PROFILE, project, trusted_hook_stamps: [], unresolved_claims: "record", repositories: [], github_repos: [],
  });
  const envelope = validatePolicyEnvelope({ version, created_at: AT, set_by: { type: "human", id: "o" }, supersedes, activation });
  return { body, envelope, digest: await policyDigestOf(body, envelope) };
}

/** The fields of a well-formed activation of `doc`, sealed in `project` (normally the document's own). */
function activationFields(doc: PolicyDocument, project = doc.body.project): Partial<Event> {
  return {
    id: doc.envelope.activation.event_id,
    project,
    actor: { type: "system", id: POLICY_ACTOR_ID, on_behalf_of: `${doc.envelope.set_by.type}:${doc.envelope.set_by.id}` },
    action: "created",
    artifacts: [{ id: `policy:${project}@${doc.digest}`, kind: "policy", role: "generated" }],
    method: {
      tool: "retrace-api",
      automated: true,
      params: {
        policy_profile: doc.body.profile,
        policy_version: doc.envelope.version,
        policy_digest: doc.digest,
        supersedes: doc.envelope.supersedes,
        set_by: { ...doc.envelope.set_by },
        sealed_by: SEALED_BY_OWNER,
      },
    },
    idempotency_key: `policy:${project}:${doc.envelope.version}`,
  };
}

function ordinaryFields(seq: number, project = P): Partial<Event> {
  return {
    id: `evt_${seq}`,
    project,
    actor: { type: "human", id: "j" },
    action: "edited",
    artifacts: [{ id: `repo:acme/app#f${seq}` }],
    method: { tool: "cli", params: {} },
  };
}

type RefShape = "claim_decision" | "owner_login_decision" | "context";
function withReference(fields: Partial<Event>, shape: RefShape, digest: string, readHeadSeq: number | undefined): Partial<Event> {
  const context: Record<string, unknown> = { policy_digest: digest };
  if (readHeadSeq !== undefined) context.read_head_seq = readHeadSeq;
  const params = { ...(fields.method?.params ?? {}) } as Record<string, unknown>;
  if (shape === "claim_decision") params.claim_decision = { context };
  else if (shape === "owner_login_decision") params.owner_login_decision = { decision: { context } };
  else params.context = context;
  return { ...fields, method: { ...(fields.method ?? { tool: "cli" }), params } };
}

/** Seal `fields` (index = position) into hashed events linked by prev_hash in list order. */
async function sealAll(fields: (Partial<Event> & { seq: number })[]): Promise<Event[]> {
  const out: Event[] = [];
  let prev = GENESIS_HASH;
  for (const f of fields) {
    const e = {
      id: `evt_${f.seq}`, project: P, actor: { type: "human", id: "j" }, action: "edited", artifacts: [{ id: "a" }],
      timestamp: AT, received_at: AT, hash_v: 2, ...f, prev_hash: prev, hash: "",
    } as Event;
    e.hash = await computeHash(e);
    prev = e.hash;
    out.push(e);
  }
  return out;
}

function bundleOf(events: Event[], policies: PolicyDocument[] | undefined, opts: { total?: number; head?: string; scope?: ExportScope } = {}): ExportBundle {
  const bundle: ExportBundle = {
    format: EXPORT_FORMAT,
    generated_at: AT,
    scope: opts.scope ?? { project: P },
    chain: { ok: true, checked: opts.total ?? events.length, total_events: opts.total ?? events.length, head_hash: opts.head ?? events.at(-1)?.hash },
    events,
    context_events: 0,
  };
  if (policies) bundle.policies = policies;
  return bundle;
}

type ActivationKind =
  | "eligible" | "wrong_event_id" | "wrong_seq" | "wrong_version_param" | "wrong_digest_param" | "wrong_profile_param"
  | "wrong_supersedes_param" | "audit_actor" | "audit_on_behalf_of" | "audit_set_by" | "missing_document"
  | "other_project_document" | "unsupported_profile";
const ACTIVATION_KINDS: ActivationKind[] = [
  "eligible", "eligible", "eligible", "eligible", "eligible", "wrong_event_id", "wrong_seq", "wrong_version_param",
  "wrong_digest_param", "wrong_profile_param", "wrong_supersedes_param", "audit_actor", "audit_on_behalf_of", "audit_set_by",
  "missing_document", "other_project_document", "unsupported_profile",
];

type Coverage = "complete" | "gap" | "tail" | "scoped" | "fractional_seq" | "duplicate_seq";
const COVERAGES: Coverage[] = ["complete", "complete", "complete", "complete", "gap", "tail", "scoped", "fractional_seq", "duplicate_seq"];

/** A seeded bundle covering the cases the brief lists. Returns the events before coverage edits for the policy-level test. */
async function generateCase(random: Random, signingKey?: JsonWebKey): Promise<{ bundle: ExportBundle; digests: string[]; seqs: number[] }> {
  const r = (n: number) => random() % n;
  const chance = (k: number) => r(k) === 0;
  const pick = <T>(xs: readonly T[]): T => xs[r(xs.length)]!;
  const n = 4 + r(36);
  const pool = [...Array(n).keys()];
  for (let i = pool.length - 1; i > 0; i--) { const j = r(i + 1); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
  const slots: Partial<Event>[] = pool.map(() => ({}));
  const coverage = pick(COVERAGES);
  // A fractional seq replaces k by k + 0.5; keep activations and references off k so their own seq is unchanged.
  const fractionalAt = 1 + r(n - 2);
  const free = pool.filter((s) => coverage !== "fractional_seq" || s !== fractionalAt);
  const take = () => free.shift();

  const policies: PolicyDocument[] = [];
  const activations: { seq: number; doc: PolicyDocument }[] = [];
  const digests: string[] = [FOREIGN_DIGEST];
  const numDocs = r(4);
  const docSeqs: number[] = [];
  for (let v = 0; v < numDocs; v++) { const s = take(); if (s !== undefined) docSeqs.push(s); }
  if (!chance(4)) docSeqs.sort((a, b) => a - b); // usually versions rise with seq; sometimes a later version comes first
  let supersedes: string | null = null;
  for (let i = 0; i < docSeqs.length; i++) {
    const seq = docSeqs[i]!;
    const version = i + 1;
    const kind = pick(ACTIVATION_KINDS);
    const eventId = `evt_${seq}`;
    let doc = await makeDocument(kind === "other_project_document" ? Q : P, version, {
      event_id: kind === "wrong_event_id" ? `evt_elsewhere_${seq}` : eventId,
      seq: kind === "wrong_seq" ? seq + 1 : seq,
    }, supersedes);
    if (kind === "unsupported_profile") doc = { ...doc, body: { ...doc.body, profile: "retrace-project-policy/999" as typeof POLICY_PROFILE } };
    const act = activationFields(doc, P);
    act.id = eventId;
    const params = act.method!.params as Record<string, unknown>;
    if (kind === "wrong_version_param") params.policy_version = version + 1;
    if (kind === "wrong_digest_param") params.policy_digest = FOREIGN_DIGEST;
    if (kind === "wrong_profile_param") params.policy_profile = "retrace-project-policy/2";
    if (kind === "wrong_supersedes_param") params.supersedes = supersedes ? null : FOREIGN_DIGEST;
    if (kind === "audit_actor") act.actor = { type: "human", id: "forged" };
    if (kind === "audit_on_behalf_of") act.actor = { ...act.actor!, on_behalf_of: "human:someone-else" };
    if (kind === "audit_set_by") params.set_by = { type: "human", id: "someone-else" };
    slots[seq] = act;
    if (kind !== "missing_document") policies.push(doc);
    digests.push(doc.digest);
    activations.push({ seq, doc });
    supersedes = doc.digest;
  }
  // A copy of an older activation after a newer one: same fields, new id (clause 4), or with its own document under the
  // same digest (the duplicate is policy_corrupt; clause 5 must not let the older version win).
  if (activations.length && chance(3)) {
    const src = pick(activations);
    const seq = take();
    if (seq !== undefined) {
      if (chance(2)) {
        slots[seq] = { ...activationFields(src.doc, P), id: `evt_${seq}` };
      } else {
        const copy = await makeDocument(P, src.doc.envelope.version, { event_id: `evt_${seq}`, seq }, src.doc.envelope.supersedes);
        const sameDigest = { ...copy, digest: src.doc.digest };
        slots[seq] = { ...activationFields(sameDigest, P), id: `evt_${seq}` };
        policies.push(sameDigest);
      }
    }
  }
  // Duplicate documents: identical (no finding) or same digest with other content (policy_corrupt).
  if (policies.length && chance(4)) {
    const d = pick(policies);
    policies.push(chance(2) ? d : { ...d, body: { ...d.body, trusted_hook_stamps: ["changed"] } });
  }
  // A second project: its own document and activation, and ordinary events.
  const qProject = chance(3);
  if (qProject) {
    const seq = take();
    if (seq !== undefined) {
      const qdoc = await makeDocument(Q, 1, { event_id: `evt_${seq}`, seq }, null);
      slots[seq] = activationFields(qdoc, Q);
      policies.push(qdoc);
      digests.push(qdoc.digest);
    }
  }
  // References from ordinary events, with read_head_seq absent, negative, around each activation and beyond the end.
  const heads = (): number | undefined => {
    const act = activations.length ? pick(activations).seq : r(n);
    return pick([undefined, -1, -2.5, act - 1, act, act + 1, n - 1, n + 3, r(n), r(n) + 0.5, act]);
  };
  const refCount = r(7);
  for (let i = 0; i < refCount; i++) {
    const seq = take();
    if (seq === undefined) break;
    const project = qProject && chance(4) ? Q : P;
    slots[seq] = withReference(ordinaryFields(seq, project), pick(["claim_decision", "owner_login_decision", "context"] as const), pick(digests), heads());
  }
  for (let s = 0; s < n; s++) if (!slots[s]!.id) slots[s] = ordinaryFields(s, qProject && chance(6) ? Q : P);

  const fields = slots.map((f, seq) => ({ ...f, seq: coverage === "fractional_seq" && seq === fractionalAt ? seq + 0.5 : seq }));
  const sealed = await sealAll(fields);
  const head = sealed.at(-1)!.hash;
  let events = sealed;
  let scope: ExportScope = { project: P };
  if (coverage === "gap") events = sealed.filter((_, i) => i !== r(n - 1));
  if (coverage === "tail") events = sealed.slice(0, n - 1 - r(Math.min(3, n - 1)));
  if (coverage === "scoped") scope = { project: P, actor_id: "j" };
  if (coverage === "duplicate_seq") { const i = r(n); events = [...sealed.slice(0, i + 1), sealed[i]!, ...sealed.slice(i + 1)]; }
  if (chance(4)) events = [...events].sort(() => (random() & 1 ? 1 : -1)); // bundle order is not seq order
  const bundle = bundleOf(events, policies.length || chance(2) ? policies : undefined, { total: n, head, scope });
  if (signingKey && chance(8)) {
    const { publicFromPrivate } = await import("./signing.js");
    const pub = publicFromPrivate(signingKey);
    bundle.issuer = { kid: await keyId(pub), alg: "Ed25519", public_key: pub };
    bundle.signature = await signCanonical(signingKey, { ...bundle, signature: undefined });
  }
  return { bundle, digests, seqs: fields.map((f) => f.seq) };
}

async function settle<T>(p: Promise<T>): Promise<{ value: T } | { error: string }> {
  try { return { value: await p }; } catch (e: any) { return { error: `${e?.name}: ${e?.message}` }; }
}

// ---- Equivalence ----

test("durable fix step 1: verifyExportBundle equals the per-reference reference on 256 seeded bundles", async () => {
  const random = xorshift(0x0a0d17);
  const key = await generateSigningKey();
  const seen = new Map<PolicyVerifyFinding | "none", number>();
  let refEvents = 0;
  for (let i = 0; i < 256; i++) {
    const { bundle } = await generateCase(random, key.privateKey);
    const trusted = i % 16 === 0 ? key.publicKey : undefined;
    const actual = await verifyExportBundle(bundle, trusted);
    const expected = await referenceVerifyExportBundle(bundle, trusted);
    assert.deepEqual(actual, expected, `case ${i}`);
    // Tally outcomes per reference (today's call), so "none" means a reference with no finding.
    const sorted = [...bundle.events].sort((a, b) => a.seq - b.seq);
    const coverageComplete = actual.coverage.complete === true || (actual.coverage.scope === "full" && actual.coverage.complete !== false);
    for (const e of sorted) {
      const ref = eventPolicyRef(e);
      if (!ref.digest) continue;
      refEvents++;
      const { findings } = verifyPolicySelectionOffline({
        project: e.project, claimedDigest: ref.digest, readHeadSeq: ref.readHeadSeq, events: sorted, policies: bundle.policies ?? [], coverageComplete,
      });
      for (const f of findings.length ? findings : ["none" as const]) seen.set(f, (seen.get(f) ?? 0) + 1);
    }
  }
  // The generator must reach every outcome, or the equivalence above proves less than it claims.
  for (const f of ["none", "policy_missing", "policy_misselected", "policy_selection_unverifiable", "policy_corrupt",
    "policy_project_mismatch", "policy_unsupported_profile", "policy_audit_mismatch"] as const) {
    assert.ok((seen.get(f) ?? 0) > 0, `no case produced ${f}`);
  }
  assert.ok(refEvents > 256, `only ${refEvents} policy-reference events`);
  console.log(`# ${refEvents} policy-reference events; outcomes ${JSON.stringify(Object.fromEntries(seen))}`);
});

test("durable fix step 1: the one-pass verifier equals verifyPolicySelectionOffline for any seqs, U and coverage", async () => {
  const random = xorshift(0x5e1ec7);
  const r = (n: number) => random() % n;
  let queries = 0;
  for (let i = 0; i < 160; i++) {
    const { bundle, digests } = await generateCase(random);
    // Seqs a ledger never has: gaps, duplicates, negatives, fractions. The verifier must still match.
    const events = bundle.events.flatMap((e) => {
      const roll = r(14);
      if (roll === 0) return [{ ...e, seq: e.seq + 1 }];
      if (roll === 1) return [{ ...e, seq: -1 - r(3) }];
      if (roll === 2) return [{ ...e, seq: e.seq + 0.25 }];
      if (roll === 3) return [{ ...e, seq: Math.max(0, e.seq - 1) }];
      if (roll === 4) return [{ ...e, seq: -0.75 }];
      if (roll === 5) return [e, e]; // the same event twice: an eligible activation, then its copy at the same seq
      return [e];
    }).sort((a, b) => a.seq - b.seq);
    const policies = bundle.policies ?? [];
    const seqs = events.map((e) => e.seq);
    const heads = [undefined, NaN, -0, Infinity, -Infinity, -1, -0.5, -2.5, ...seqs, ...seqs.map((s) => s + 0.5), Math.max(...seqs, 0) + 1];
    for (const coverageComplete of [true, false]) {
      const check = offlinePolicySelectionVerifier({ events, policies, coverageComplete });
      assert.ok(check, `case ${i}: sorted finite seqs`);
      for (let k = 0; k < 40; k++) {
        const project = [P, Q, "r"][r(3)]!;
        const claimedDigest = r(6) === 0 ? undefined : digests[r(digests.length)];
        const readHeadSeq = heads[r(heads.length)];
        const expected = verifyPolicySelectionOffline({ project, claimedDigest, readHeadSeq, events, policies, coverageComplete }).findings;
        assert.deepEqual(check(project, claimedDigest, readHeadSeq), expected, `case ${i} ${project} ${claimedDigest?.slice(0, 8)} U=${readHeadSeq} cov=${coverageComplete}`);
        queries++;
      }
    }
  }
  assert.ok(queries >= 12_000);
});

// ---- Hand-written cases, one per finding ----

async function handCase(name: string, bundle: ExportBundle, expected: PolicyVerifyFinding[] | undefined) {
  const actual = await verifyExportBundle(bundle);
  assert.deepEqual(actual, await referenceVerifyExportBundle(bundle), `${name}: equals the reference`);
  assert.deepEqual(actual.policy_findings, expected, `${name}: findings`);
}

async function twoVersions() {
  const v1 = await makeDocument(P, 1, { event_id: "evt_1", seq: 1 }, null);
  const v2 = await makeDocument(P, 2, { event_id: "evt_3", seq: 3 }, v1.digest);
  return { v1, v2 };
}

test("durable fix step 1: a reference matching the selected policy has no finding", async () => {
  const { v1, v2 } = await twoVersions();
  const events = await sealAll([
    { seq: 0, ...ordinaryFields(0) }, { seq: 1, ...activationFields(v1) }, { seq: 2, ...withReference(ordinaryFields(2), "claim_decision", v1.digest, 1) },
    { seq: 3, ...activationFields(v2) }, { seq: 4, ...withReference(ordinaryFields(4), "owner_login_decision", v2.digest, 3) },
  ]);
  await handCase("match", bundleOf(events, [v1, v2]), undefined);
});

test("durable fix step 1: policy_misselected — v1 claimed when v2 is in force as of read_head_seq", async () => {
  const { v1, v2 } = await twoVersions();
  const events = await sealAll([
    { seq: 0, ...ordinaryFields(0) }, { seq: 1, ...activationFields(v1) }, { seq: 2, ...ordinaryFields(2) },
    { seq: 3, ...activationFields(v2) }, { seq: 4, ...withReference(ordinaryFields(4), "context", v1.digest, 4) },
  ]);
  await handCase("misselected", bundleOf(events, [v1, v2]), ["policy_misselected"]);
});

test("durable fix step 1: policy_missing — claimed digest, nothing activated by read_head_seq", async () => {
  const { v1 } = await twoVersions();
  const events = await sealAll([
    { seq: 0, ...withReference(ordinaryFields(0), "claim_decision", v1.digest, 0) }, { seq: 1, ...activationFields(v1) },
  ]);
  await handCase("missing before activation", bundleOf(events, [v1]), ["policy_missing"]);
});

test("durable fix step 1: policy_missing — a later activation whose document is absent fails closed", async () => {
  const { v1, v2 } = await twoVersions();
  const events = await sealAll([
    { seq: 0, ...ordinaryFields(0) }, { seq: 1, ...activationFields(v1) }, { seq: 2, ...ordinaryFields(2) },
    { seq: 3, ...activationFields(v2) }, { seq: 4, ...withReference(ordinaryFields(4), "claim_decision", v1.digest, 4) },
  ]);
  await handCase("missing document", bundleOf(events, [v1]), ["policy_missing"]);
});

test("durable fix step 1: policy_audit_mismatch — the only activation has the wrong audit identity", async () => {
  const { v1 } = await twoVersions();
  const events = await sealAll([
    { seq: 0, ...ordinaryFields(0) }, { seq: 1, ...activationFields(v1), actor: { type: "human", id: "forged" } },
    { seq: 2, ...withReference(ordinaryFields(2), "claim_decision", v1.digest, 2) },
  ]);
  await handCase("audit mismatch", bundleOf(events, [v1]), ["policy_audit_mismatch"]);
});

test("durable fix step 1: policy_selection_unverifiable — scoped bundle, and a fractional seq that breaks the prefix", async () => {
  const { v1 } = await twoVersions();
  const fields = [
    { seq: 0, ...ordinaryFields(0) }, { seq: 1, ...activationFields(v1) },
    { seq: 2, ...withReference(ordinaryFields(2), "claim_decision", v1.digest, 1) },
  ];
  await handCase("scoped", bundleOf(await sealAll(fields), [v1], { scope: { project: P, actor_id: "j" } }), ["policy_selection_unverifiable"]);
  // seqs 0, 1, 2.5, 3: the omission check calls four claimed events complete, but 0..2 is not a contiguous prefix.
  const gap = await sealAll([...fields.slice(0, 2), { seq: 2.5, ...ordinaryFields(2) }, { seq: 3, ...withReference(ordinaryFields(3), "context", v1.digest, 2) }]);
  const v = await verifyExportBundle(bundleOf(gap, [v1]));
  assert.equal(v.coverage.complete, true);
  await handCase("fractional seq", bundleOf(gap, [v1]), ["policy_selection_unverifiable"]);
});

test("durable fix step 1: policy_corrupt, policy_project_mismatch, policy_unsupported_profile — document-level findings repeat per reference", async () => {
  const { v1 } = await twoVersions();
  const changed = { ...v1, body: { ...v1.body, trusted_hook_stamps: ["changed"] } };
  const fields = [
    { seq: 0, ...ordinaryFields(0) }, { seq: 1, ...activationFields(v1) },
    { seq: 2, ...withReference(ordinaryFields(2), "claim_decision", v1.digest, 1) },
    { seq: 3, ...withReference(ordinaryFields(3), "claim_decision", v1.digest, 2) },
  ];
  const events = await sealAll(fields);
  // Bundle-level corrupt (digest mismatch) once, then per reference: duplicate key with other content.
  await handCase("duplicate corrupt document", bundleOf(events, [v1, changed]), ["policy_corrupt", "policy_corrupt", "policy_corrupt"]);
  const qdoc = await makeDocument(Q, 1, { event_id: "evt_q", seq: 9 }, null);
  await handCase("document of another project", bundleOf(events, [v1, qdoc]), ["policy_project_mismatch", "policy_project_mismatch", "policy_project_mismatch"]);
  const unsupported = { ...v1, body: { ...v1.body, profile: "retrace-project-policy/999" as typeof POLICY_PROFILE } };
  await handCase("unsupported profile", bundleOf(events, [unsupported]), [
    "policy_corrupt", "policy_corrupt", "policy_unsupported_profile", // digest mismatch, validation, profile
    "policy_unsupported_profile", "policy_corrupt", "policy_unsupported_profile", "policy_corrupt", // per reference: document, then selection
  ]);
  // An activation for project p that resolves (by bare digest) to project q's document is incomplete: policy_corrupt.
  const qSame = await makeDocument(Q, 1, { event_id: "evt_1", seq: 1 }, null);
  const qEvents = await sealAll([
    fields[0]!, { seq: 1, ...activationFields(qSame, P) }, { seq: 2, ...withReference(ordinaryFields(2), "claim_decision", qSame.digest, 1) },
  ]);
  await handCase("activation resolves to another project's document", bundleOf(qEvents, [qSame]), [
    "policy_project_mismatch", "policy_project_mismatch", "policy_corrupt",
  ]);
});

test("durable fix step 1: a copy of v1 after v2 cannot win, and a reference from a second project selects across projects", async () => {
  const { v1, v2 } = await twoVersions();
  const events = await sealAll([
    { seq: 0, ...ordinaryFields(0) }, { seq: 1, ...activationFields(v1) }, { seq: 2, ...ordinaryFields(2) },
    { seq: 3, ...activationFields(v2) }, { seq: 4, ...activationFields(v1), id: "evt_4" },
    { seq: 5, ...withReference(ordinaryFields(5), "claim_decision", v2.digest, 5) },
    // Today's selection scan does not filter by project: a q reference sees p's activations, and its documents are p's.
    { seq: 6, ...withReference(ordinaryFields(6, Q), "claim_decision", v2.digest, 5) },
  ]);
  await handCase("copy after newer; second project", bundleOf(events, [v1, v2]), ["policy_project_mismatch", "policy_project_mismatch"]);
});

test("durable fix step 1: activations sharing a seq — the first decisive one in event order is selected", async () => {
  const { v1, v2 } = await twoVersions();
  const v2at1 = await makeDocument(P, 2, { event_id: "evt_1b", seq: 1 }, v1.digest);
  const lone = await makeDocument(P, 3, { event_id: "evt_1c", seq: 1 }, null);
  const eligible = { ...activationFields(v1), seq: 1 } as Event;
  const missing = { ...activationFields(lone), seq: 1 } as Event; // its document is not in `policies`: incomplete
  const second = { ...activationFields(v2at1), seq: 1 } as Event;
  const ordinary = (seq: number) => ({ ...ordinaryFields(seq), seq }) as Event;
  for (const [name, group, policies] of [
    ["eligible then incomplete", [eligible, missing], [v1]],
    ["incomplete then eligible", [missing, eligible], [v1]],
    ["v1 then v2 at one seq", [eligible, second], [v1, v2at1]],
    ["v2 then v1 at one seq", [second, eligible], [v1, v2at1]],
    ["eligible twice", [eligible, eligible], [v1]],
  ] as const) {
    const events = [ordinary(0), ...group, ordinary(2)];
    const check = offlinePolicySelectionVerifier({ events, policies: [...policies], coverageComplete: true })!;
    for (const claimedDigest of [v1.digest, v2at1.digest, v2.digest]) {
      for (const U of [0, 1, 2]) {
        const expected = verifyPolicySelectionOffline({ project: P, claimedDigest, readHeadSeq: U, events, policies: [...policies], coverageComplete: true }).findings;
        assert.deepEqual(check(P, claimedDigest, U), expected, `${name} ${claimedDigest.slice(0, 4)} U=${U}`);
      }
    }
  }
});

test("durable fix step 1: a read_head_seq in (−1, 0) selects nothing but finds the claimed activation at a seq ≤ U", async () => {
  const { v1 } = await twoVersions();
  const events = [{ ...activationFields(v1), seq: -0.75 } as Event, { ...ordinaryFields(0), seq: 0 } as Event];
  const check = offlinePolicySelectionVerifier({ events, policies: [v1], coverageComplete: true })!;
  for (const U of [-0.5, -0.75, -1, -0]) {
    const expected = verifyPolicySelectionOffline({ project: P, claimedDigest: v1.digest, readHeadSeq: U, events, policies: [v1], coverageComplete: true }).findings;
    assert.deepEqual(check(P, v1.digest, U), expected, `U=${U}`);
  }
  assert.deepEqual(check(P, v1.digest, -0.5), ["policy_missing"]);
});

test("durable fix step 1: each special read head the seeded test draws, under both coverage values (#239)", async () => {
  const { v1, v2 } = await twoVersions();
  const events = await sealAll([
    { seq: 0, ...ordinaryFields(0) }, { seq: 1, ...activationFields(v1) }, { seq: 2, ...ordinaryFields(2) },
    { seq: 3, ...activationFields(v2) }, { seq: 4, ...ordinaryFields(4) },
  ]);
  const heads: [string, number | undefined][] = [
    ["undefined", undefined], ["NaN", NaN], ["-0", -0], ["+Infinity", Infinity], ["-Infinity", -Infinity], ["-0.5", -0.5],
  ];
  // With complete coverage, +Infinity passes the end of the contiguous prefix (seq 4), so selection is unverifiable. The other
  // heads select nothing, so the claimed digest is missing: undefined reads as −1, NaN, −Infinity and −0.5 admit no event, and −0
  // admits only seq 0, which is not an activation. With incomplete coverage every head is unverifiable.
  const pinned = (name: string, coverageComplete: boolean): PolicyVerifyFinding[] =>
    !coverageComplete || name === "+Infinity" ? ["policy_selection_unverifiable"] : ["policy_missing"];
  for (const coverageComplete of [true, false]) {
    const check = offlinePolicySelectionVerifier({ events, policies: [v1, v2], coverageComplete })!;
    for (const [name, U] of heads) {
      for (const claimedDigest of [v1.digest, v2.digest]) {
        const expected = verifyPolicySelectionOffline({ project: P, claimedDigest, readHeadSeq: U, events, policies: [v1, v2], coverageComplete }).findings;
        const label = `U=${name} cov=${coverageComplete} ${claimedDigest === v1.digest ? "v1" : "v2"}`;
        assert.deepEqual(check(P, claimedDigest, U), expected, label);
        assert.deepEqual(expected, pinned(name, coverageComplete), `${label}: pinned`);
      }
    }
  }
});

// ---- Fallback: bundles the forward pass does not take ----

test("durable fix step 1: unsorted or non-finite seqs go to the per-reference loop", async () => {
  const { v1 } = await twoVersions();
  const events = await sealAll([
    { seq: 0, ...ordinaryFields(0) }, { seq: 1, ...activationFields(v1) },
    { seq: 2, ...withReference(ordinaryFields(2), "claim_decision", v1.digest, 1) },
  ]);
  assert.equal(offlinePolicySelectionVerifier({ events: [events[1]!, events[0]!], policies: [v1], coverageComplete: true }), undefined);
  for (const bad of [NaN, Infinity, "1" as unknown as number]) {
    const odd = events.map((e, i) => (i === 0 ? { ...e, seq: bad } : e));
    assert.equal(offlinePolicySelectionVerifier({ events: odd, policies: [v1], coverageComplete: true }), undefined);
    const bundle = bundleOf(odd, [v1]);
    assert.deepEqual(await settle(verifyExportBundle(bundle)), await settle(referenceVerifyExportBundle(bundle)), `seq ${String(bad)}`);
  }
});

test("durable fix step 1: a malformed event gives today's result or today's error", async () => {
  const { v1 } = await twoVersions();
  const base = [
    { seq: 0, ...ordinaryFields(0) }, { seq: 1, ...activationFields(v1) },
    { seq: 2, ...withReference(ordinaryFields(2), "claim_decision", v1.digest, 2) },
    { seq: 3, ...withReference(ordinaryFields(3), "claim_decision", v1.digest, 0) },
  ];
  // The first throws in today's selection. Today's loop never reaches the other two; the forward pass must not trip over
  // the key beyond U (it stops at the largest U) and does trip over the null artifact (its index scans every event), so it
  // falls back.
  for (const [name, at, patch, expectError] of [
    ["non-string idempotency key, inside U", 2, { idempotency_key: 7 }, true],
    ["non-string idempotency key, beyond every U", 3, { idempotency_key: 7 }, false],
    ["null artifact, beyond every U", 3, { artifacts: [{ id: "x" }, null] }, false],
  ] as const) {
    const fields = base.map((f) => (f.seq === at ? { ...f, ...(patch as unknown as Partial<Event>) } : f));
    const bundle = bundleOf(await sealAll(fields), [v1]);
    const outcome = await settle(verifyExportBundle(bundle));
    assert.deepEqual(outcome, await settle(referenceVerifyExportBundle(bundle)), name);
    assert.equal("error" in outcome, expectError, `${name}: ${"error" in outcome ? outcome.error : "resolves"}`);
  }
});
