import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Event, EventInput, GENESIS_HASH, InvalidArtifactIdError } from "./schema.js";
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

test("owner-login append rejects malformed artifact ids before classification or sealing", async () => {
  const { appendOwnerLoginEvent } = await import("./owner-login.js");
  for (const bad of ["pr:owner/repo#\0", "pr:owner/repo#\uD800", "pr:owner/repo#\uDC00"]) {
    for (const artifact of [{ id: bad }, { id: "pr:owner/repo#1", derived_from: [bad] }]) {
      const store = storeOf([]), input = { ...await comment(), artifacts: [artifact] };
      store.head = async () => { throw new Error("invalid input must fail before any store read"); };
      await assert.rejects(appendOwnerLoginEvent(store, input, policy, repo), InvalidArtifactIdError);
      await assert.rejects(appendOwnerLoginEvent(store, input, null, repo), InvalidArtifactIdError);
      assert.equal(store.events.length, 0);
    }
  }
  const store = storeOf([]), input = { ...await comment(), artifacts: [{ id: "pr:owner/repo#1", role: "used" as const, derived_from: ["repo:owner/repo#😀.ts"] }] };
  const { event } = await appendOwnerLoginEvent(store, input, policy, repo);
  assert.deepEqual(event.artifacts, input.artifacts);
});

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

test("T16 full pr_edit allocation followed by a title-only edit has no reusable declaration", async () => {
  const { appendOwnerLoginEvent } = await import("./owner-login.js");
  const store = new MemoryEventStore();
  const editIngress = new Date(Date.now()+1000).toISOString();
  const payload = { repository: { full_name: repo }, action: "edited", sender: { login: "owner" }, pull_request: { number: 1, title: "first title", body: "same body", head: { ref: "branch", sha: "a".repeat(40) } } };
  const first = (await mapGithubWebhook("pull_request", payload, { project: "p", ingressAt: editIngress, deliveryId: "edit1" }))[0];
  const gp = first.method!.params!.github_payload as any;
  const e = await declaration({ received_at: new Date().toISOString() }); (e.method!.params!.github_action as any) = { kind: "pr_edit", repo, login: "owner", pr: 1, body_sha256: gp.body_sha256, title_sha256: gp.title_sha256 };
  store.events.push(e);
  for (const input of [first]) input.method!.params!.sealed_by = "webhook:github";
  assert.equal(ownerLoginRecord((await appendOwnerLoginEvent(store, first, policy, repo, Date.now()+1000)).event)!.decision.status, "declared_by_seat");
  payload.pull_request.title = "second title";
  const next = (await mapGithubWebhook("pull_request", payload, { project: "p", ingressAt: editIngress, deliveryId: "edit2" }))[0];
  next.method!.params!.sealed_by = "webhook:github";
  const record = ownerLoginRecord((await appendOwnerLoginEvent(store, next, policy, repo, Date.now()+1000)).event)!;
  assert.equal(record.decision.status, "unresolved"); assert.equal(record.decision.reason, "no_declaration");
});

test("T12 unlisted GitHub bot retains the adapter heuristic without a decision", async () => {
  const [input] = await mapGithubWebhook("issue_comment", { repository: { full_name: repo }, action: "created", sender: { login: "dependabot[bot]", type: "Bot" },
    issue: { number: 1, pull_request: {} }, comment: { id: 2, body: "hello", created_at: ingress } }, { project: "p", ingressAt: ingress });
  const result = await classifyOwnerLogin({ store: storeOf([]), input, policy, canonicalR: repo, readHead: { seq: -1, hash: GENESIS_HASH }, deadline: Date.now()+1000 });
  assert.deepEqual(result, { kind: "not_applicable" }); assert.equal(input.actor.type, "system"); assert.equal(input.actor.id, "dependabot[bot]");
});

test("T17 failure before insert leaves no event/row and a redelivery can allocate; T19 next same-seat declaration stays available", async () => {
  const { appendOwnerLoginEvent } = await import("./owner-login.js");
  const store = new MemoryEventStore(); store.events = [await declaration(), await declaration({ id: "second", seq: 1 })];
  const original = store.insert.bind(store);
  store.insert = async () => { throw new Error("injected pre-write failure"); };
  await assert.rejects(appendOwnerLoginEvent(store, await comment(), policy, repo, Date.now()+1000), /injected/);
  assert.equal(store.events.length, 2); assert.equal(store.ownerLoginConsumption.size, 0);
  store.insert = original;
  const first = await appendOwnerLoginEvent(store, await comment(), policy, repo, Date.now()+1000);
  assert.deepEqual(ownerLoginRecord(first.event)!.decision.consumed, ["declaration"]);
  assert.equal(await store.ownerLoginConsumptionRow("p", "second"), null);
  const next = await appendOwnerLoginEvent(store, { ...await comment(), idempotency_key: "next-delivery" }, policy, repo, Date.now()+1000);
  assert.deepEqual(ownerLoginRecord(next.event)!.decision.consumed, ["second"]);
});

test("T-A1 T-A4 stage timings and pre-read timing distinguish direct and append callers", async () => {
  const { appendOwnerLoginEvent } = await import("./owner-login.js");
  const { ownerLoginScenario } = await import("./owner-login-fixture.js");
  const store = new MemoryEventStore(), f = await ownerLoginScenario(store);
  const clock = Date.now();
  const result = await classifyOwnerLogin({ store, input: f.input, policy: f.policy, canonicalR: f.repo,
    readHead: (await store.head(f.project))!, deadline: clock + 300, now: () => clock });
  assert.equal(result.kind, "decision"); if (result.kind !== "decision") throw new Error("fixture");
  const timing = ownerLoginRecord(result.input)!.decision.timing;
  for (const key of ["candidates_ms", "consumption_ms", "amendments_ms", "filter_ms"] as const)
    assert.ok(typeof timing[key] === "number" && timing[key]! >= 0, key);
  assert.equal(timing.stage_failed, null); assert.equal(timing.deadline_ms, 300);
  assert.equal(timing.pre_ms, null); assert.equal(timing.candidates_rows, 1);
  assert.equal(timing.budget_rows_remaining, 1999);
  let tick = clock;
  const head = store.head.bind(store), policyAt = store.getPolicyByActivationSeq.bind(store);
  store.head = async p => { tick += 7; return head(p); };
  store.getPolicyByActivationSeq = async (...args) => { tick += 11; return policyAt(...args); };
  const appended = await appendOwnerLoginEvent(store, f.input, f.policy, f.repo, clock + 100, () => tick);
  const measured = ownerLoginRecord(appended.event)!.decision.timing;
  assert.equal(measured.pre_ms, 18); assert.equal(measured.deadline_ms, 82);
});

test("amendments per-call timing records MemoryEventStore calls in order with bounded transfer counts", async () => {
  const { appendEvent } = await import("./store.js");
  const { ownerLoginScenario } = await import("./owner-login-fixture.js");
  const store = new MemoryEventStore(), f = await ownerLoginScenario(store);
  const root = (await appendEvent(store, { project: f.project, actor: { type: "human", id: "owner" },
    action: "instructed", artifacts: [{ id: "task:timing", role: "used" }] })).event;
  const file = `repo:${f.repo}#src/timing.ts`, sha = "1".repeat(40);
  await appendEvent(store, { project: f.project, actor: { type: "agent", id: "other" }, action: "committed",
    caused_by: root.id, artifacts: [{ id: `commit:${f.repo}@${sha}`, role: "generated" }, { id: file, role: "generated" }],
    method: { tool: "git", params: { sha, sealed_by: "owner" } } });
  const evidence = (await appendEvent(store, { project: f.project, actor: { type: "agent", id: "other" },
    action: "edited", caused_by: root.id, artifacts: [{ id: file, role: "generated" }] })).event;
  const target = (await appendEvent(store, { project: f.project, actor: { type: "agent", id: "codex" },
    action: "edited", caused_by: root.id, artifacts: [{ id: file, role: "generated" }] })).event;
  await appendEvent(store, { project: f.project, actor: root.actor, action: "other", action_detail: "amended",
    tags: ["amendment", "attribution"], caused_by: root.id,
    artifacts: [{ id: `event:${target.id}`, role: "used" }, { id: `event:${evidence.id}`, role: "used" }],
    method: { tool: "retrace_amend", params: { sealed_by: "owner", target_event_id: target.id,
      attribution: { from: target.actor, to: evidence.actor, evidence: [evidence.id] } } } });
  const result = await classifyOwnerLogin({ store, input: f.input, policy: f.policy, canonicalR: f.repo,
    readHead: (await store.head(f.project))!, deadline: Date.now() + 1000 });
  assert.equal(result.kind, "decision"); if (result.kind !== "decision") throw new Error("fixture");
  const record = ownerLoginRecord(result.input)!;
  const calls = record.decision.timing.amendments_calls!;
  assert.deepEqual(calls.map((entry) => entry.call), ["amendment_rows", "dependencies", "capture_targets", "capture_commits"]);
  assert.deepEqual(calls.map((entry) => entry.rows), [
    { statement_rows: 1, distinct_events: 1 },
    { statement_rows: 3, distinct_events: 3 },
    { statement_rows: 3, distinct_events: 3 },
    { statement_rows: 1, distinct_events: 1 },
  ]);
  for (const entry of calls) {
    assert.ok(entry.wall_ms >= 0);
    assert.equal(entry.body_chars, 0);
    assert.equal(entry.sql_ms, null);
    assert.equal(entry.statements, 0);
    assert.equal(entry.outcome, "ok");
  }
  assert.equal(record.decision.timing.amendments_calls_truncated, undefined);
});

test("amendments timing capture faults are omitted without changing the decision", async () => {
  const { ownerLoginScenario } = await import("./owner-login-fixture.js");
  const store = new MemoryEventStore(), f = await ownerLoginScenario(store);
  const readHead = (await store.head(f.project))!, clock = Date.now();
  const observed = await classifyOwnerLogin({ store, input: f.input, policy: f.policy, canonicalR: f.repo,
    readHead, deadline: clock + 1000, now: () => clock });
  const faulted = await classifyOwnerLogin({ store, input: f.input, policy: f.policy, canonicalR: f.repo,
    readHead, deadline: clock + 1000, now: () => clock, amendmentsTimingCapture: () => { throw new Error("timing fault"); } });
  assert.equal(observed.kind, "decision"); assert.equal(faulted.kind, "decision");
  if (observed.kind !== "decision" || faulted.kind !== "decision") throw new Error("fixture");
  const observedDecision = structuredClone(ownerLoginRecord(observed.input)!.decision);
  const faultedDecision = structuredClone(ownerLoginRecord(faulted.input)!.decision);
  assert.ok(observedDecision.timing.amendments_calls?.length);
  assert.equal(faultedDecision.timing.amendments_calls, undefined);
  delete observedDecision.timing.amendments_calls;
  assert.deepEqual(faultedDecision, observedDecision);
});

test("amendments per-call timing is capped at 16 entries and marks truncation", async () => {
  const base = await declaration();
  const root: Event = { ...base, id: "root", seq: 1, actor: { type: "human", id: "owner" },
    action: "instructed", artifacts: [{ id: "task:root", role: "used" }], method: undefined, caused_by: undefined };
  const chain: Event[] = [];
  let parent = root;
  for (let i = 0; i < 20; i++) {
    const event: Event = { ...base, id: `chain-${i}`, seq: i + 2, action: "read",
      artifacts: [{ id: `task:chain-${i}`, role: "used" }], method: undefined, caused_by: parent.id };
    chain.push(event); parent = event;
  }
  const target: Event = { ...base, id: "target", seq: 22, action: "edited", artifacts: [{ id: "task:target", role: "generated" }] };
  const evidence: Event = { ...base, id: "evidence", seq: 23, actor: { type: "agent", id: "other" },
    action: "edited", artifacts: [{ id: "task:target", role: "generated" }] };
  const amendment: Event = { ...base, id: "amendment", seq: 24, actor: root.actor, action: "other", action_detail: "amended",
    tags: ["amendment", "attribution"], caused_by: parent.id,
    artifacts: [{ id: `event:${target.id}`, role: "used" }, { id: `event:${evidence.id}`, role: "used" }],
    method: { tool: "retrace_amend", params: { sealed_by: "owner", target_event_id: target.id,
      attribution: { from: target.actor, to: evidence.actor, evidence: [evidence.id] } } } };
  const record = await classify(storeOf([base, root, ...chain, target, evidence, amendment]));
  assert.equal(record.decision.timing.amendments_calls?.length, 16);
  assert.equal(record.decision.timing.amendments_calls?.[0]?.call, "amendment_rows");
  assert.ok(record.decision.timing.amendments_calls?.slice(1).every((entry) => entry.call === "dependencies"));
  assert.equal(record.decision.timing.amendments_calls_truncated, true);
});

for (const [operation, stage] of [["eventsReferencingArtifacts", "candidates"],
  ["ownerLoginConsumptionUpTo", "consumption"], ["amendmentEventsUpTo", "amendments"]] as const) {
  test(`T-A2 T-A3 memory stalled ${stage} reports elapsed time at deadline`, async () => {
    const { ownerLoginScenario } = await import("./owner-login-fixture.js");
    const store = new MemoryEventStore(), f = await ownerLoginScenario(store);
    store[operation] = async () => new Promise<never>(() => {});
    const readHead = (await store.head(f.project))!;
    const result = await classifyOwnerLogin({ store, input: f.input, policy: f.policy, canonicalR: f.repo,
      readHead, deadline: Date.now() + 100 });
    assert.equal(result.kind, "decision"); if (result.kind !== "decision") throw new Error("fixture");
    const d = ownerLoginRecord(result.input)!.decision;
    assert.equal(d.status, "unavailable"); assert.equal(d.reason, "deadline");
    assert.equal(d.timing.stage_failed, stage);
    const earlierMs = stage === "candidates" ? 0 : d.timing.candidates_ms! + d.timing.filter_ms! +
        (stage === "amendments" ? d.timing.consumption_ms! : 0);
      assert.ok(d.timing[`${stage}_ms`]! >= d.timing.deadline_ms - earlierMs - 10, JSON.stringify(d.timing));
    assert.equal(d.timing.budget_rows_remaining, stage === "candidates" ? 2000 : 1999);
    if (stage === "amendments") {
      assert.equal(d.timing.amendments_calls?.length, 1);
      assert.equal(d.timing.amendments_calls?.[0]?.call, "amendment_rows");
      assert.equal(d.timing.amendments_calls?.[0]?.outcome, "deadline");
    }
  });
}

test("T-A local webhook seals 201 with failed-stage timing on a candidate deadline", async () => {
  const { createHandler } = await import("./router.js");
  const { ownerLoginScenario } = await import("./owner-login-fixture.js");
  const store = new MemoryEventStore(), f = await ownerLoginScenario(store);
  const handler = createHandler(store, { token: "test-owner", ownerPrincipal: { type: "human", id: "owner" },
    githubSecret: "test-secret", githubRepoProjects: { [f.repo]: f.project } });
  const put = await handler(new Request(`http://test/projects/${f.project}/policy`, { method: "PUT",
    headers: { authorization: "Bearer test-owner", "content-type": "application/json", "if-match": "none" }, body: JSON.stringify(f.policy.body) }));
  assert.equal(put.status, 201, await put.text());
  store.eventsReferencingArtifacts = async () => new Promise<never>(() => {});
  const body = JSON.stringify(f.payload), encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode("test-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body))), b => b.toString(16).padStart(2, "0")).join("");
  const response = await handler(new Request("http://test/hooks/github", { method: "POST", body,
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${signature}`,
      "x-github-event": "issue_comment", "x-github-delivery": "timing-deadline" } }));
  assert.equal(response.status, 201, await response.text());
  const d = ownerLoginRecord(store.events.at(-1)!)!.decision;
  assert.equal(d.status, "unavailable"); assert.equal(d.reason, "deadline");
  assert.equal(d.timing.stage_failed, "candidates");
  assert.ok(d.timing.pre_ms !== null && d.timing.pre_ms >= 0);
  assert.ok(d.timing.candidates_ms! >= d.timing.deadline_ms - 10);
});


test("T-A3 memory delayed candidates leave only the remaining budget for consumption", async () => {
  const { ownerLoginScenario } = await import("./owner-login-fixture.js");
  const store = new MemoryEventStore();
  {
    const f = await ownerLoginScenario(store), readHead = (await store.head(f.project))!;
    const candidates = store.eventsReferencingArtifacts!.bind(store);
    store.eventsReferencingArtifacts = async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 40));
      return candidates(...args);
    };
    store.ownerLoginConsumptionUpTo = async () => new Promise<never>(() => {});
    const result = await classifyOwnerLogin({ store, input: f.input, policy: f.policy, canonicalR: f.repo,
      readHead, deadline: Date.now() + 100 });
    assert.equal(result.kind, "decision"); if (result.kind !== "decision") throw new Error("fixture");
    const d = ownerLoginRecord(result.input)!.decision;
    assert.equal(d.status, "unavailable"); assert.equal(d.reason, "deadline");
    assert.equal(d.timing.stage_failed, "consumption");
    assert.ok(d.timing.candidates_ms! >= 30, JSON.stringify(d.timing));
    assert.ok(d.timing.candidates_ms! + d.timing.consumption_ms! >= d.timing.deadline_ms - 10, JSON.stringify(d.timing));
  }
});

test("T-A7 memory deadline during selection belongs to final_check", async () => {
  const { ownerLoginScenario } = await import("./owner-login-fixture.js");
  const store = new MemoryEventStore();
  {
    const f = await ownerLoginScenario(store), readHead = (await store.head(f.project))!;
    const started = Date.now(); let tick = started, selectionReady = false;
    const amendments = store.amendmentEventsUpTo!.bind(store);
    store.amendmentEventsUpTo = async (...args) => {
      const rows = await amendments(...args); selectionReady = true; return rows;
    };
    const payload = f.input.method!.params!.github_payload as Record<string, unknown>;
    const bodyHash = payload.body_sha256;
    // Content matching runs during selection, after every evidence read completed.
    Object.defineProperty(payload, "body_sha256", { enumerable: true, get() { if (selectionReady) tick = started + 100; return bodyHash; } });
    const result = await classifyOwnerLogin({ store, input: f.input, policy: f.policy, canonicalR: f.repo,
      readHead, deadline: started + 100, now: () => tick });
    assert.equal(result.kind, "decision"); if (result.kind !== "decision") throw new Error("fixture");
    const d = ownerLoginRecord(result.input)!.decision;
    assert.equal(d.status, "unavailable"); assert.equal(d.reason, "deadline");
    assert.equal(d.timing.stage_failed, "final_check");
    assert.equal(d.timing.filter_ms, 100);
    for (const key of ["candidates_ms", "consumption_ms", "amendments_ms"] as const) assert.equal(d.timing[key], 0);
    assert.equal(Object.hasOwn(d.timing, "final_check_ms"), false);
    assert.deepEqual(d.consumed, []); assert.deepEqual(d.declarations, []);
  }
});

for (const failure of ["ingress", "eventsReferencingArtifacts", "ownerLoginConsumptionUpTo"] as const) {
  test(`T-A8 memory setup failure ${failure} records no candidate read`, async () => {
    const { ownerLoginScenario } = await import("./owner-login-fixture.js");
    const store = new MemoryEventStore();
    {
      const f = await ownerLoginScenario(store), readHead = (await store.head(f.project))!;
      if (failure === "ingress") (f.input.method!.params!.github_payload as Record<string, unknown>).ingress_at = "invalid";
      else Object.defineProperty(store, failure, { value: undefined });
      if (failure !== "eventsReferencingArtifacts") store.eventsReferencingArtifacts = async () => { assert.fail("setup must fail before a read"); };
      const result = await classifyOwnerLogin({ store, input: f.input, policy: f.policy, canonicalR: f.repo,
        readHead, deadline: Date.now() + 100 });
      assert.equal(result.kind, "decision"); if (result.kind !== "decision") throw new Error("fixture");
      const d = ownerLoginRecord(result.input)!.decision;
      assert.equal(d.status, "unavailable"); assert.equal(d.reason, "store_error");
      assert.equal(d.timing.stage_failed, "setup"); assert.equal(d.timing.candidates_rows, null);
      for (const key of ["candidates_ms", "consumption_ms", "amendments_ms", "filter_ms"] as const) assert.equal(d.timing[key], null);
      assert.equal(Object.hasOwn(d.timing, "setup_ms"), false);
    }
  });
}
