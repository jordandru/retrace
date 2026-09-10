import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKey, buildExportBundle, verifyExportBundle, exportVerdictOk, parseExportBundle, MemoryEventStore, appendEvent, POLICY_PROFILE, validatePolicyBody, validatePolicyEnvelope, policyDigestOf, Event } from "./index.js";

test("P3/P9: bundle.policies under signature; missing/misselected/unverifiable; two-project uses bundle policy", async () => {
  const store = new MemoryEventStore();
  const v1body = validatePolicyBody({
    profile: POLICY_PROFILE, project: "p", trusted_hook_stamps: ["X"], unresolved_claims: "record",
    repositories: [], github_repos: [],
  });
  // Seed via applyPolicyWrite-shaped document after a dummy event so seq 0 exists
  await appendEvent(store, { project: "p", actor: { type: "human", id: "j" }, action: "instructed", artifacts: [{ id: "t" }] });
  const key = await generateSigningKey();
  const empty = await buildExportBundle(store, { project: "p" }, { signingKey: key.privateKey });
  assert.equal(empty.policies, undefined);
  const envelope = validatePolicyEnvelope({
    version: 1, created_at: "2026-09-10T03:45:00.000Z", set_by: { type: "human", id: "o" },
    supersedes: null, activation: { event_id: "evt_pol", seq: 1 },
  });
  const digest = await policyDigestOf(v1body, envelope);
  const doc = { body: v1body, envelope, digest };
  store.policies.push(doc);
  const sealed = store.events[0]!;
  const withCtx = {
    ...sealed,
    method: { ...sealed.method, params: { ...sealed.method?.params, claim_decision: { context: { policy_digest: digest, read_head_seq: 0 } } } },
  } as Event;
  store.events[0] = withCtx;
  const bundle = await buildExportBundle(store, { project: "p" }, { signingKey: key.privateKey });
  assert.ok(bundle.policies?.some((d) => d.digest === digest));
  const v = await verifyExportBundle(bundle, key.publicKey);
  assert.equal(v.signature, "valid");

  const missing = JSON.parse(JSON.stringify(bundle));
  missing.policies = [];
  const vm = await verifyExportBundle(missing, key.publicKey);
  assert.ok(vm.problems.some((p) => /policy_missing|policy_selection_unverifiable/.test(p)) || vm.policy_findings?.includes("policy_missing") || vm.policy_findings?.includes("policy_selection_unverifiable"));
  assert.equal(exportVerdictOk(vm), false, "builder-note-1 / policy_missing must not be VALID");

  const other = JSON.parse(JSON.stringify(bundle));
  other.scope.project = "q";
  const vo = await verifyExportBundle(other, key.publicKey);
  assert.ok((vo.policy_findings ?? []).includes("policy_project_mismatch") || vo.problems.some((p) => /project/.test(p)));

  // PR 29 two-project case: B's bundle policy is the stamp source, not cwd/A.
  const qStore = new MemoryEventStore();
  await appendEvent(qStore, { project: "q", actor: { type: "human", id: "j" }, action: "instructed", artifacts: [{ id: "t" }] });
  const qBody = validatePolicyBody({
    profile: POLICY_PROFILE, project: "q", trusted_hook_stamps: ["Y"], unresolved_claims: "record",
    repositories: [], github_repos: [],
  });
  const qEnv = validatePolicyEnvelope({
    version: 1, created_at: "2026-09-10T03:45:00.000Z", set_by: { type: "human", id: "o" },
    supersedes: null, activation: { event_id: "evt_q", seq: 0 },
  });
  const qDigest = await policyDigestOf(qBody, qEnv);
  qStore.policies.push({ body: qBody, envelope: qEnv, digest: qDigest });
  const qSealed = qStore.events[0]!;
  qStore.events[0] = {
    ...qSealed,
    method: { ...qSealed.method, params: { ...qSealed.method?.params, claim_decision: { context: { policy_digest: qDigest, read_head_seq: 0 } } } },
  } as Event;
  const qBundle = await buildExportBundle(qStore, { project: "q" }, { signingKey: key.privateKey });
  assert.ok(qBundle.policies?.some((d) => d.digest === qDigest && d.body.trusted_hook_stamps.includes("Y")));
  const qv = await verifyExportBundle(qBundle, key.publicKey);
  assert.ok(!(qv.policy_findings ?? []).includes("policy_project_mismatch"));
  assert.equal(qBundle.policies![0]!.body.trusted_hook_stamps[0], "Y");
});

test("F2: duplicate keys at the bundle boundary are rejected", () => {
  assert.throws(() => parseExportBundle('{"format":"retrace-export/1","format":"retrace-export/1"}'), /duplicate object key|invalid export bundle/);
});

test("F6: caller-supplied trustedHookStamps must not override document stampsFor", async () => {
  const store = new MemoryEventStore();
  await appendEvent(store, { project: "p", actor: { type: "human", id: "j" }, action: "instructed", artifacts: [{ id: "t" }] });
  const key = await generateSigningKey();
  const body = validatePolicyBody({
    profile: POLICY_PROFILE, project: "p", trusted_hook_stamps: ["X"], unresolved_claims: "record",
    repositories: [], github_repos: [],
  });
  const envelope = validatePolicyEnvelope({
    version: 1, created_at: "2026-09-10T03:45:00.000Z", set_by: { type: "human", id: "o" },
    supersedes: null, activation: { event_id: "evt_pol", seq: 1 },
  });
  const digest = await policyDigestOf(body, envelope);
  store.policies.push({ body, envelope, digest });
  const sealed = store.events[0]!;
  store.events[0] = {
    ...sealed,
    method: { ...sealed.method, params: { ...sealed.method?.params, claim_decision: { context: { policy_digest: digest, read_head_seq: 0 } } } },
  } as Event;
  const bundle = await buildExportBundle(store, { project: "p" }, { signingKey: key.privateKey });
  const v = await verifyExportBundle(bundle, key.publicKey, { trustedHookStamps: ["Y-not-in-document"], project: "p" });
  assert.equal(v.signature, "valid");
  assert.ok(!(v.policy_findings ?? []).includes("policy_corrupt"));
});

test("F8: scoped export includes the referenced activation event before signing", async () => {
  const store = new MemoryEventStore();
  await appendEvent(store, { project: "p", actor: { type: "human", id: "j" }, action: "instructed", artifacts: [{ id: "t" }] });
  const key = await generateSigningKey();
  const v1body = validatePolicyBody({
    profile: POLICY_PROFILE, project: "p", trusted_hook_stamps: ["X"], unresolved_claims: "record",
    repositories: [], github_repos: [],
  });
  const actId = "evt_activation_scoped";
  const envelope = validatePolicyEnvelope({
    version: 1, created_at: "2026-09-10T03:45:00.000Z", set_by: { type: "human", id: "o" },
    supersedes: null, activation: { event_id: actId, seq: 1 },
  });
  const digest = await policyDigestOf(v1body, envelope);
  store.policies.push({ body: v1body, envelope, digest });
  await appendEvent(store, { project: "p", actor: { type: "human", id: "j" }, action: "edited", artifacts: [{ id: "file:x" }] });
  const second = store.events[1]!;
  store.events.push({
    ...second,
    id: actId,
    seq: 99,
    action: "created",
    idempotency_key: "policy:p:1",
    artifacts: [{ id: `policy:p@${digest}`, kind: "policy", role: "generated" }],
  } as Event);
  const work = store.events.find((e) => e.action === "edited")!;
  work.method = { ...work.method, params: { ...work.method?.params, claim_decision: { context: { policy_digest: digest, read_head_seq: 1 } } } };
  const scoped = await buildExportBundle(store, { project: "p", artifact_id: "file:x" }, { signingKey: key.privateKey });
  assert.ok(scoped.policies?.some((d) => d.digest === digest));
  assert.ok(scoped.events.some((e) => e.id === actId), "activation event must be in the scoped bundle before signing");
});
