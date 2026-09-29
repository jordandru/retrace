import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Event, EventInput, GENESIS_HASH } from "./schema.js";
import { MemoryEventStore } from "./mem-store.js";
import { EventStore } from "./store.js";
import { PolicyDocument, POLICY_PROFILE_V2 } from "./policy.js";
import { mapGithubWebhook, githubBodySha256 } from "./github.js";
import { classifyOwnerLogin, ownerLoginRecord, declarationProject, declarationPinned, declarationAgent, declarationUnamended,
  declarationAction, declarationWindow, declarationUnconsumed, declarationTarget, declarationContent, normaliseGithubAction } from "./owner-login.js";

const ingress = "2026-09-28T12:00:00.000Z";
const repo = "owner/repo";
const policy: PolicyDocument = { body: { profile: POLICY_PROFILE_V2, project: "p", trusted_hook_stamps: [], unresolved_claims: "record",
  repositories: [{ name: repo, aliases: [] }], github_repos: [repo], github: { shared_logins: ["owner"], identities: {} } },
  envelope: { version: 1, created_at: ingress, set_by: { type: "human", id: "owner" }, supersedes: null, activation: { event_id: "policy", seq: 1 } }, digest: "a".repeat(64) };
async function comment(): Promise<EventInput> {
  return (await mapGithubWebhook("issue_comment", { repository: { full_name: repo }, action: "created", sender: { login: "Owner" },
    issue: { number: 1, pull_request: {} }, comment: { id: 1, body: "hello", created_at: ingress } }, { project: "p", ingressAt: ingress, deliveryId: "delivery" }))[0];
}
async function declaration(over: Partial<Event> = {}): Promise<Event> {
  return { id: "declaration", seq: 0, hash: "b".repeat(64), prev_hash: GENESIS_HASH, hash_v: 2, timestamp: "2099-01-01T00:00:00Z", received_at: ingress,
    project: "p", actor: { type: "agent", id: "codex", on_behalf_of: "owner" }, action: "sent", artifacts: [{ id: `pr:${repo}#1`, role: "used" }],
    method: { params: { sealed_by: "pinned:codex", producer_sig_verdict: "verified", github_action: { kind: "comment", repo, login: "owner", pr: 1, body_sha256: await githubBodySha256("hello") } } }, ...over };
}
function storeOf(events: Event[]): EventStore & MemoryEventStore {
  const store: EventStore & MemoryEventStore = new MemoryEventStore(); store.events = events;
  store.ownerLoginConsumptionUpTo = async () => ({ ok: true, rows: [] });
  return store;
}
async function classify(store: EventStore, input?: EventInput, doc = policy, deadline = Date.now() + 1000) {
  const result = await classifyOwnerLogin({ store, input: input ?? await comment(), policy: doc, canonicalR: repo,
    readHead: await store.head("p") ?? { seq: -1, hash: GENESIS_HASH }, deadline });
  assert.equal(result.kind, "decision");
  if (result.kind !== "decision") throw new Error("not applicable");
  return ownerLoginRecord(result.input)!;
}

test("T1 T19 sequence-zero declaration and same-seat duplicates select only the lowest seq", async () => {
  const first = await declaration(), next = await declaration({ id: "later", seq: 2 });
  const record = await classify(storeOf([first, next]));
  assert.equal(record.decision.status, "declared_by_seat");
  assert.deepEqual(record.decision.consumed, [first.id]);
  assert.deepEqual(record.decision.declarations.map(e => e.id), [first.id]);
  assert.deepEqual(record.decision.actor_written, { type: "agent", id: "codex", on_behalf_of: "owner" });
  assert.equal(record.decision.received.webhook, null);
  assert.equal(record.decision.evidence_level, "declaration_only");
});

test("T4 conflicting declarations retain account and consume nothing", async () => {
  const record = await classify(storeOf([await declaration(), await declaration({ id: "other", seq: 1, actor: { type: "agent", id: "other" } })]));
  assert.equal(record.decision.status, "conflicting");
  assert.equal(record.decision.actor_written.type, "system");
  assert.equal(record.decision.declarations.length, 2);
  assert.deepEqual(record.decision.consumed, []);
});

test("T5 T6 owner claims, unverified signatures and wrong content are proximity only", async () => {
  for (const params of [{ sealed_by: "owner" }, { producer_sig_verdict: "none" }, { github_action: { kind: "comment", repo, login: "owner", pr: 1, body_sha256: "wrong" } }]) {
    const e = await declaration(); e.method!.params = { ...e.method!.params, ...params };
    const record = await classify(storeOf([e]));
    assert.equal(record.decision.status, "unresolved"); assert.equal(record.decision.reason, "proximity_only");
    assert.equal(record.decision.proximity_hints, 1); assert.deepEqual(record.decision.declarations, []);
  }
});

test("T7 T15 T18 only server receipt and inclusive ingress window admit declarations; outcomes are excluded", async () => {
  for (const [offset, expected] of [[-1800001, "unresolved"], [-1800000, "declared_by_seat"], [-1000, "declared_by_seat"], [0, "declared_by_seat"], [1, "unresolved"]] as const) {
    const e = await declaration({ timestamp: "2000-01-01T00:00:00Z", received_at: new Date(Date.parse(ingress) + offset).toISOString() });
    assert.equal((await classify(storeOf([e]))).decision.status, expected);
  }
  const e = await declaration(); (e.method!.params!.github_action as any).result = {};
  assert.equal((await classify(storeOf([e]))).decision.status, "unresolved");
});

test("T8 T12 /1, empty and unlisted mappings preserve actor; identity mapping performs no declaration read", async () => {
  const input = await comment();
  for (const body of [{ ...policy.body, profile: "retrace-project-policy/1" as const, github: undefined }, { ...policy.body, github: { shared_logins: [], identities: {} } }, { ...policy.body, github: { shared_logins: ["someone"], identities: {} } }]) {
    const before = JSON.stringify(input);
    assert.deepEqual(await classifyOwnerLogin({ store: storeOf([]), input, policy: { ...policy, body }, canonicalR: repo, readHead: { seq: -1, hash: GENESIS_HASH }, deadline: Date.now()+1000 }), { kind: "not_applicable" });
    assert.equal(JSON.stringify(input), before);
  }
  const store = storeOf([]); store.eventsReferencingArtifacts = async () => { assert.fail("identity must not query declarations"); };
  const mapped = await classify(store, input, { ...policy, body: { ...policy.body, github: { shared_logins: [], identities: { OWNER: "app-seat" } } } });
  assert.equal(mapped.decision.status, "identity_mapped"); assert.equal(mapped.decision.actor_written.id, "app-seat");
});

test("T9 lifetime rows, store/amendment failures and shared deadline fail closed", async () => {
  const e = await declaration();
  const old = Array.from({ length: 2001 }, (_, i) => ({ ...e, id: `old-${i}`, seq: i, received_at: "2000-01-01T00:00:00Z" }));
  const over = await classify(storeOf([...old, { ...e, seq: 2001 }]));
  assert.equal(over.decision.reason, "budget"); assert.equal(over.decision.status, "unavailable");
  for (const operation of ["eventsReferencingArtifacts", "amendmentEventsUpTo", "ownerLoginConsumptionUpTo"] as const) {
    const store = storeOf([e]); store[operation] = async () => { throw new Error("read failed"); };
    const record = await classify(store); assert.equal(record.decision.reason, "store_error"); assert.equal(record.decision.actor_written.type, "system");
  }
  const store = storeOf([e]); store.amendmentEventsUpTo = async () => new Promise(() => {});
  assert.equal((await classify(store, undefined, policy, Date.now()+20)).decision.reason, "deadline");
});

test("T16 consumed declaration cannot resolve repeated/title-only operations; review aliases remain narrow", async () => {
  const e = await declaration(); const store = storeOf([e]);
  store.ownerLoginConsumptionUpTo = async () => ({ ok: true, rows: [{ project: "p", declaration_event_id: e.id, consumed_by_event_id: "winner", consumed_by_seq: 0, consumed_at: ingress }] });
  assert.equal((await classify(store)).decision.reason, "no_declaration");
  const payload = { body_sha256: "body", title_sha256: "title", review_state: "commented", head_sha: "head" };
  assert.equal(declarationContent({ ...payload, title_sha256: "other" }, "pr_edit", payload), false);
  for (const state of ["COMMENT", "COMMENTED", "commented"]) assert.equal(declarationContent({ body_sha256: "body", state, commit_id: "head" }, "review", payload), true);
  for (const state of ["APPROVE", "approved", "REQUEST_CHANGES", "COMMENTING", " COMMENT "]) assert.equal(declarationContent({ body_sha256: "body", state, commit_id: "head" }, "review", payload), false);
  assert.equal(declarationContent({ ...payload, head_sha: "different" }, "review", payload), false);
  assert.equal(normaliseGithubAction({ state: "REQUEST_CHANGES" }).review_state, "changes_requested");
});

test("§1.4 each predicate clause refuses its independent counterexample", async () => {
  const e = await declaration(), input = await comment(), payload = input.method!.params!.github_payload as any, action = declarationAction(e)!;
  assert.equal(declarationProject(e, input), true); assert.equal(declarationProject({ ...e, project: "other" }, input), false);
  assert.equal(declarationPinned(e), true); assert.equal(declarationPinned({ ...e, method: undefined }), false);
  assert.equal(declarationAgent(e), true); assert.equal(declarationAgent({ ...e, actor: { type: "system", id: "account" } }), false);
  assert.equal(declarationUnamended(e, new Set()), true); assert.equal(declarationUnamended(e, new Set([e.id])), false);
  assert.equal(declarationUnamended({ ...e, action_detail: "amended" }, new Set()), false);
  assert.equal(declarationAction({ ...e, method: { params: { github_action: { ...action, result: null } } } }), undefined);
  assert.equal(declarationWindow(e, Date.parse(ingress), 0), true); assert.equal(declarationWindow(e, Date.parse(ingress), -1), false);
  assert.equal(declarationUnconsumed(e, new Set([e.id])), false);
  assert.equal(declarationTarget(e, action, "comment", repo, 1, payload), true);
  for (const patch of [{ repo: "other/repo" }, { login: "other" }, { kind: "review" }, { pr: 2 }]) assert.equal(declarationTarget(e, { ...action, ...patch }, "comment", repo, 1, payload), false);
  assert.equal(declarationContent({}, "comment", payload), false);
});

test("T14a T14b real PR130 declaration found by branch/commit; reconstructed payload refuses missing title only", async () => {
  const real = JSON.parse(readFileSync(new URL("./fixtures/owner-login/pr130-declaration.json", import.meta.url), "utf8")) as Event;
  const reconstructed = JSON.parse(readFileSync(new URL("./fixtures/owner-login/pr130-reconstructed.json", import.meta.url), "utf8"));
  assert.match(reconstructed.provenance, /Reconstructed/);
  assert.equal(await githubBodySha256(reconstructed.payload.pull_request.body), reconstructed.body_sha256);
  const [input] = await mapGithubWebhook("pull_request", reconstructed.payload, { project: real.project, ingressAt: reconstructed.ingress_at, deliveryId: "reconstructed-pr130" });
  const doc = { ...policy, body: { ...policy.body, project: real.project, repositories: [{ name: "jordandru/retrace", aliases: [] }], github: { shared_logins: ["jordandru"], identities: {} } } };
  const run = async (e: Event) => {
    const store = storeOf([e]);
    const result = await classifyOwnerLogin({ store, input, policy: doc, canonicalR: "jordandru/retrace", readHead: { seq: e.seq, hash: e.hash }, deadline: Date.now()+1000 });
    assert.equal(result.kind, "decision"); return result.kind === "decision" ? ownerLoginRecord(result.input)! : undefined!;
  };
  const refused = await run(real); assert.equal(refused.decision.status, "unresolved"); assert.equal(refused.decision.reason, "proximity_only");
  const compliant = structuredClone(real); (compliant.method!.params!.github_action as any).title_sha256 = (input.method!.params!.github_payload as any).title_sha256;
  const matched = await run(compliant); assert.equal(matched.decision.status, "declared_by_seat"); assert.equal(matched.decision.actor_written.id, "claude-code");
});

test("§1.4 effective attribution amendment excludes an otherwise eligible pr_open declaration", async () => {
  const base = await declaration();
  const branch = `git:${repo}#feature`;
  const root: Event = { ...base, id: "root", seq: 0, actor: { type: "human", id: "owner" }, action: "instructed", artifacts: [{ id: "task:root", role: "generated" }], method: undefined };
  const evidence: Event = { ...base, id: "evidence", seq: 1, actor: { type: "agent", id: "other" }, action: "edited", artifacts: [{ id: branch, role: "generated" }], caused_by: root.id, method: { params: { sealed_by: "assert:other" } } };
  const [input] = await mapGithubWebhook("pull_request", { repository: { full_name: repo }, action: "opened", sender: { login: "owner" },
    pull_request: { number: 1, title: "title", body: "body", updated_at: ingress, head: { ref: "feature", sha: "a".repeat(40) } } }, { project: "p", ingressAt: ingress });
  const gp = input.method!.params!.github_payload as any;
  const target: Event = { ...base, seq: 2, action: "created", artifacts: [{ id: branch, role: "generated" }], caused_by: root.id,
    method: { params: { sealed_by: "pinned:codex", producer_sig_verdict: "verified", github_action: { kind: "pr_open", repo, login: "owner", body_sha256: gp.body_sha256, title_sha256: gp.title_sha256, head_sha: gp.head_sha } } } };
  const amendment: Event = { ...base, id: "amendment", seq: 3, actor: root.actor, action: "other", action_detail: "amended", tags: ["amendment", "attribution"], intent: "corroborated correction", caused_by: root.id,
    artifacts: [{ id: `event:${target.id}`, role: "used" }, { id: `event:${evidence.id}`, role: "used" }],
    method: { tool: "retrace_amend", params: { sealed_by: "owner", target_event_id: target.id, attribution: { from: { type: "agent", id: "codex" }, to: { type: "agent", id: "other" }, evidence: [evidence.id] } } } };
  assert.equal((await classify(storeOf([root, evidence, target]), input)).decision.status, "declared_by_seat");
  assert.equal((await classify(storeOf([root, evidence, target, amendment]), input)).decision.status, "unresolved");
});

test("T9 aggregate row cap counts amendment rows after candidate reads", async () => {
  const e = await declaration();
  const store = storeOf(Array.from({ length: 1999 }, (_, i) => ({ ...e, id: `candidate-${i}`, seq: i })));
  store.amendmentEventsUpTo = async () => [{ ...e, id: "amend-1", action_detail: "amended" }, { ...e, id: "amend-2", action_detail: "amended" }];
  const record = await classify(store);
  assert.equal(record.decision.status, "unavailable"); assert.equal(record.decision.reason, "budget");
});
