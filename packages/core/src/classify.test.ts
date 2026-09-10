import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_DECISION_PARAM, MemoryEventStore, POLICY_PROFILE, SEALED_BY_PARAM, appendEvent,
  applyBreakerFailure, applyBreakerSuccess, breakerIsOpen, breakerShouldOpen, classifyCommitClaim,
  createHandler, decideFromTable, emptyBreaker, reconstructWithheldPayload, wouldWrite,
  type ClaimRecord, type EventInput,
} from "./index.js";

const OWNER = { authorization: "Bearer owner-token-long-enough" };
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ROOT = "evt_" + "c".repeat(32);

function policyBody(over: Record<string, unknown> = {}) {
  return {
    profile: POLICY_PROFILE,
    project: "p",
    trusted_hook_stamps: ["assert:git hook (assert)"],
    unresolved_claims: "record",
    repositories: [{ name: "acme/app", aliases: ["app"] }],
    github_repos: ["acme/app"],
    ...over,
  };
}

function handler(store = new MemoryEventStore()) {
  return {
    store,
    h: createHandler(store, {
      token: "owner-token-long-enough",
      ownerPrincipal: { type: "human", id: "owner@example.com" },
      ownerActor: { type: "human", id: "owner@example.com" },
    }),
  };
}

async function putPolicy(store: MemoryEventStore, project = "p", body: Record<string, unknown> = {}, reassign?: string) {
  const { h } = handler(store);
  const url = reassign
    ? `http://test/projects/${project}/policy?reassign=${reassign}`
    : `http://test/projects/${project}/policy`;
  const res = await h(new Request(url, {
    method: "PUT",
    headers: { ...OWNER, "content-type": "application/json", "if-match": "none" },
    body: JSON.stringify({ ...policyBody({ project }), ...body, project }),
  }));
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return JSON.parse(text);
}

function commitInput(over: Partial<EventInput> & { files?: string[]; actorId?: string; raw?: string } = {}): EventInput {
  const files = over.files ?? ["a.ts"];
  const actorId = over.actorId ?? "codex";
  const raw = over.raw ?? `work\n\nRetrace-Actor: ${actorId}\n`;
  const { files: _f, actorId: _a, raw: _r, ...rest } = over;
  return {
    project: "p",
    actor: { type: "agent", id: actorId, on_behalf_of: "jordan@example.com" },
    action: "committed",
    artifacts: [
      { id: `commit:acme/app@${SHA.slice(0, 12)}`, kind: "commit", role: "generated" },
      ...files.map((f) => ({ id: `repo:acme/app#${f}`, kind: "file", role: "generated" as const })),
    ],
    timestamp: "2026-09-10T12:00:00.000Z",
    method: {
      tool: "git",
      automated: true,
      params: {
        sha: SHA,
        parents: ["dddddddddddddddddddddddddddddddddddddddd"],
        raw_message: raw,
        author: { name: "Jordan", email: "jordan@example.com" },
        files: files.length,
      },
    },
    ...rest,
  };
}

async function pinnedEdit(store: MemoryEventStore, opts: { actor: string; path: string; client?: string; project?: string }) {
  await appendEvent(store, {
    project: opts.project ?? "p",
    actor: { type: "agent", id: opts.actor },
    action: "edited",
    artifacts: [{ id: `repo:acme/app#${opts.path}`, kind: "file", role: "generated" }],
    timestamp: "2026-09-10T11:00:00.000Z",
    method: { tool: "editor", params: { [SEALED_BY_PARAM]: `pinned:${opts.actor}` } },
    ...(opts.client ? { location: { client: opts.client } } : {}),
  });
}

async function classify(store: MemoryEventStore, input: EventInput, extra: Record<string, unknown> = {}) {
  return classifyCommitClaim({
    store,
    input,
    producer: "git-hook",
    sealedBy: "assert:git hook (assert)",
    trailerPolicy: "shadow",
    canonicalR: "acme/app",
    ...extra,
  });
}

const agentClaim = (id = "codex"): ClaimRecord => ({
  type: "agent", id, source: "retrace-actor", raw_trailers: { "retrace-actor": id },
});

test("wouldWrite / A1 table: conflicting withholds, unresolved follows policy, else claim", () => {
  assert.deepEqual(wouldWrite("conflicting", "record", "no_match"), { actor_written: "withheld", reason: "no_match" });
  assert.deepEqual(wouldWrite("unresolved", "withhold", "unrooted"), { actor_written: "withheld", reason: "unrooted" });
  assert.deepEqual(wouldWrite("unresolved", "record", "unrooted"), { actor_written: "claim" });
  assert.deepEqual(wouldWrite("supported", "withhold"), { actor_written: "claim" });
});

test("T1/T3/T6 decideFromTable: wall membership is per-commit actor equality", () => {
  assert.deepEqual(
    decideFromTable({ claim: agentClaim(), wall: [{ type: "agent", id: "opencode" }], looseHints: 0, authenticatedIngress: true, isMergeNoFiles: false }),
    { status: "conflicting", reason: "no_match" },
  );
  assert.deepEqual(
    decideFromTable({ claim: agentClaim(), wall: [{ type: "agent", id: "codex" }], looseHints: 0, authenticatedIngress: true, isMergeNoFiles: false }),
    { status: "supported" },
  );
  assert.deepEqual(
    decideFromTable({ claim: agentClaim(), wall: [{ type: "agent", id: "codex" }, { type: "agent", id: "opencode" }], looseHints: 0, authenticatedIngress: true, isMergeNoFiles: false }),
    { status: "supported" },
  );
});

test("T2 decideFromTable: empty wall is unresolved, reason by evidence kind", () => {
  assert.deepEqual(
    decideFromTable({ claim: agentClaim(), wall: [], looseHints: 0, root: { id: ROOT, action: "instructed", actor: { type: "human", id: "j" } }, authenticatedIngress: true, isMergeNoFiles: false }),
    { status: "unresolved", reason: "root_only" },
  );
  assert.deepEqual(
    decideFromTable({ claim: agentClaim(), wall: [], looseHints: 2, authenticatedIngress: true, isMergeNoFiles: false }),
    { status: "unresolved", reason: "loose_evidence_only" },
  );
  assert.deepEqual(
    decideFromTable({ claim: agentClaim(), wall: [], looseHints: 0, authenticatedIngress: true, isMergeNoFiles: false }),
    { status: "unresolved", reason: "unrooted" },
  );
});

test("T8/T9 decideFromTable: malformed is conflicting iff Wall nonempty", () => {
  const malformed: ClaimRecord = { type: "human", id: "jordan@example.com", source: "malformed", raw_trailers: { "retrace-actor": "not valid" } };
  assert.deepEqual(
    decideFromTable({ claim: malformed, wall: [{ type: "agent", id: "github-copilot" }], looseHints: 0, authenticatedIngress: true, isMergeNoFiles: false }),
    { status: "conflicting", reason: "malformed_claim" },
  );
  assert.deepEqual(
    decideFromTable({ claim: malformed, wall: [], looseHints: 0, authenticatedIngress: true, isMergeNoFiles: false }),
    { status: "unresolved", reason: "malformed_claim" },
  );
});

test("breaker (c): three failures in window open; success resets; aged failure starts a new streak", () => {
  const t0 = Date.parse("2026-09-10T12:00:00.000Z");
  let row = applyBreakerFailure(null, "p", new Date(t0).toISOString(), t0);
  row = applyBreakerFailure(row, "p", new Date(t0 + 1000).toISOString(), t0 + 1000);
  assert.equal(row.state, "closed");
  row = applyBreakerFailure(row, "p", new Date(t0 + 2000).toISOString(), t0 + 2000);
  assert.equal(row.state, "open");
  assert.equal(breakerShouldOpen(row, t0 + 2000), true);
  const closed = applyBreakerSuccess(row, "p");
  assert.equal(closed.state, "closed");
  assert.equal(closed.failures, 0);
  const aged = applyBreakerFailure(row, "p", new Date(t0 + 6 * 60 * 1000).toISOString(), t0 + 6 * 60 * 1000);
  assert.equal(aged.failures, 1);
  assert.equal(aged.state, "closed");
  assert.equal(breakerIsOpen(emptyBreaker("p"), t0), false);
});

test("T1+A1: shadow conflicting writes claim, would_write withheld, actor unchanged, rule 3 silent", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  await pinnedEdit(store, { actor: "opencode", path: "a.ts" });
  const input = commitInput();
  const got = await classify(store, input);
  assert.equal(got.kind, "decision");
  if (got.kind !== "decision") return;
  assert.equal(got.record.decision.status, "conflicting");
  assert.equal(got.record.decision.reason, "no_match");
  assert.equal(got.record.decision.actor_written, "claim");
  assert.equal(got.record.decision.shadow, true);
  assert.equal(got.record.decision.would_write.actor_written, "withheld");
  assert.equal(got.record.claim.id, "codex");
  const sealed = { ...input, method: { ...input.method, params: { ...input.method?.params, [CLAIM_DECISION_PARAM]: got.record, [SEALED_BY_PARAM]: "assert:git hook (assert)" } } };
  assert.equal(reconstructWithheldPayload(sealed, { trustedHookStamps: ["assert:git hook (assert)"], project: "p" }), undefined);
});

test("T2: root-only chain, no file edits → unresolved/root_only; withhold policy only in would_write", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store, "p", { unresolved_claims: "withhold" });
  const { event: instruct } = await appendEvent(store, {
    project: "p", actor: { type: "human", id: "jordan@example.com" }, action: "instructed",
    artifacts: [{ id: "task:1" }], timestamp: "2026-09-10T10:00:00.000Z",
  });
  const got = await classify(store, commitInput({ caused_by: instruct.id, raw: `work\n\nRetrace-Actor: codex\nRetrace-Caused-By: ${instruct.id}\n` }));
  assert.equal(got.kind, "decision");
  if (got.kind !== "decision") return;
  assert.equal(got.record.decision.status, "unresolved");
  assert.equal(got.record.decision.reason, "root_only");
  assert.equal(got.record.decision.actor_written, "claim");
  assert.equal(got.record.decision.would_write.actor_written, "withheld");
  assert.equal(got.record.decision.unresolved_policy, "withhold");
});

test("T5: a prior git seal is never a witness → unresolved, never supported", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  await appendEvent(store, commitInput({
    idempotency_key: "git:prior",
    method: {
      tool: "git",
      automated: true,
      params: {
        sha: SHA2, parents: ["eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
        raw_message: "prior\n\nRetrace-Actor: codex\n",
        author: { name: "Jordan", email: "jordan@example.com" },
        [SEALED_BY_PARAM]: "assert:git hook (assert)",
      },
    },
  }));
  const got = await classify(store, commitInput({ files: ["a.ts"] }));
  assert.equal(got.kind, "decision");
  if (got.kind !== "decision") return;
  assert.notEqual(got.record.decision.status, "supported");
  assert.equal(got.record.decision.witnesses.length, 0);
});

test("T6: one matching pinned edit among other agents → supported", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  await pinnedEdit(store, { actor: "codex", path: "a.ts" });
  await pinnedEdit(store, { actor: "opencode", path: "b.ts" });
  const got = await classify(store, commitInput({ files: ["a.ts", "b.ts", "c.ts"] }));
  assert.equal(got.kind, "decision");
  if (got.kind !== "decision") return;
  assert.equal(got.record.decision.status, "supported");
});

test("T7: caused_by problems are recorded; status is still witness-only", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  await pinnedEdit(store, { actor: "codex", path: "a.ts" });
  const missing = "evt_" + "d".repeat(32);
  const got = await classify(store, commitInput({ caused_by: missing, raw: `work\n\nRetrace-Actor: codex\nRetrace-Caused-By: ${missing}\n` }));
  assert.equal(got.kind, "decision");
  if (got.kind !== "decision") return;
  assert.equal(got.record.caused_by.problem, "missing");
  assert.equal(got.record.decision.status, "supported");
});

test("T8: invalid Retrace-Actor + pinned copilot edits → conflicting/malformed_claim", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  await pinnedEdit(store, { actor: "github-copilot", path: "a.ts" });
  const got = await classify(store, commitInput({
    actor: { type: "human", id: "jordan@example.com" },
    actorId: "codex",
    raw: "work\n\nRetrace-Actor: not a valid id\n",
  }));
  assert.equal(got.kind, "decision");
  if (got.kind !== "decision") return;
  assert.equal(got.record.claim.source, "malformed");
  assert.equal(got.record.decision.status, "conflicting");
  assert.equal(got.record.decision.reason, "malformed_claim");
});

test("T9: literal \\\\n trailer block, no edits → unresolved/malformed_claim", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  const got = await classify(store, commitInput({
    actor: { type: "human", id: "jordan@example.com" },
    raw: "work\\n\\nRetrace-Actor: codex",
  }));
  assert.equal(got.kind, "decision");
  if (got.kind !== "decision") return;
  assert.equal(got.record.claim.source, "malformed");
  assert.equal(got.record.decision.status, "unresolved");
  assert.equal(got.record.decision.reason, "malformed_claim");
});

test("T10: same agent id from two credentials both witness; sealed_by differs", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  await appendEvent(store, {
    project: "p", actor: { type: "agent", id: "codex" }, action: "edited",
    artifacts: [{ id: "repo:acme/app#a.ts", kind: "file", role: "generated" }],
    timestamp: "2026-09-10T11:00:00.000Z",
    method: { tool: "editor", params: { [SEALED_BY_PARAM]: "pinned:codex-cli" } },
  });
  await appendEvent(store, {
    project: "p", actor: { type: "agent", id: "codex" }, action: "edited",
    artifacts: [{ id: "repo:acme/app#a.ts", kind: "file", role: "generated" }],
    timestamp: "2026-09-10T11:01:00.000Z",
    method: { tool: "editor", params: { [SEALED_BY_PARAM]: "pinned:codex-ide" } },
  });
  const got = await classify(store, commitInput());
  assert.equal(got.kind, "decision");
  if (got.kind !== "decision") return;
  assert.equal(got.record.decision.status, "supported");
  assert.equal(got.record.decision.witnesses.length, 2);
  assert.deepEqual(new Set(got.record.decision.witnesses.map((w) => w.sealed_by)), new Set(["pinned:codex-cli", "pinned:codex-ide"]));
  assert.equal(got.record.decision.witness_actors.length, 1);
});

test("T11: second producer reuses the first context (identical window)", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  await pinnedEdit(store, { actor: "codex", path: "a.ts" });
  const first = await classify(store, commitInput());
  await pinnedEdit(store, { actor: "opencode", path: "a.ts" });
  const second = await classify(store, commitInput(), { producer: "github-push", sealedBy: "webhook:github" });
  assert.equal(first.kind, "decision");
  assert.equal(second.kind, "decision");
  if (first.kind !== "decision" || second.kind !== "decision") return;
  assert.deepEqual(first.record.decision.window, second.record.decision.window);
  assert.equal(first.record.decision.status, second.record.decision.status);
  assert.equal(store.contexts.size, 1);
});

test("T22/A3: harness.mismatch is informational and does not change status or would_write", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  await pinnedEdit(store, { actor: "codex", path: "a.ts", client: "cursor@1" });
  const disagree = await classify(store, commitInput({ location: { client: "opencode@1" } }));
  const store2 = new MemoryEventStore();
  await putPolicy(store2);
  await pinnedEdit(store2, { actor: "codex", path: "a.ts", client: "cursor@1" });
  const agree = await classify(store2, commitInput({ location: { client: "cursor@2" } }));
  assert.equal(disagree.kind, "decision");
  assert.equal(agree.kind, "decision");
  if (disagree.kind !== "decision" || agree.kind !== "decision") return;
  assert.equal(disagree.record.decision.harness.mismatch, true);
  assert.equal(agree.record.decision.harness.mismatch, false);
  assert.equal(disagree.record.decision.status, agree.record.decision.status);
  assert.deepEqual(disagree.record.decision.would_write, agree.record.decision.would_write);
});

test("A4: loose refs never enter witnesses; loose_hints is a count", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  await appendEvent(store, {
    project: "p", actor: { type: "agent", id: "codex" }, action: "edited",
    artifacts: [
      { id: "repo:acme/app#a.ts", role: "used" },
      { id: "file:a.ts" },
      { id: "a.ts" },
      { id: "repo:acme/app#other.ts", role: "generated" },
    ],
    timestamp: "2026-09-10T11:00:00.000Z",
    method: { tool: "editor", params: { [SEALED_BY_PARAM]: "pinned:codex" } },
  });
  const got = await classify(store, commitInput({
    files: ["a.ts"],
    artifacts: [
      { id: `commit:acme/app@${SHA.slice(0, 12)}`, kind: "commit", role: "generated" },
      { id: "repo:acme/app#a.ts", kind: "file", role: "generated" },
      { id: "file:stuffed.ts" },
      { id: "not-in-F" },
    ],
  }));
  assert.equal(got.kind, "decision");
  if (got.kind !== "decision") return;
  assert.equal(got.record.decision.witnesses.length, 0);
  assert.equal(got.record.decision.witness_actors.length, 0);
  assert.equal(typeof got.record.decision.loose_hints, "number");
  assert.ok(got.record.decision.loose_hints >= 1);
  assert.equal(got.record.decision.status, "unresolved");
});

test("T24: unstamped local ingress → unresolved/no_authenticated_ingress", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  const got = await classify(store, commitInput(), { sealedBy: "unstamped" });
  assert.equal(got.kind, "decision");
  if (got.kind !== "decision") return;
  assert.equal(got.record.decision.status, "unresolved");
  assert.equal(got.record.decision.reason, "no_authenticated_ingress");
});

test("T26: later pinned edit after U is outside the frozen window", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  const first = await classify(store, commitInput());
  await pinnedEdit(store, { actor: "codex", path: "a.ts" });
  const second = await classify(store, commitInput());
  assert.equal(first.kind, "decision");
  assert.equal(second.kind, "decision");
  if (first.kind !== "decision" || second.kind !== "decision") return;
  assert.equal(first.record.decision.context.read_head_seq, second.record.decision.context.read_head_seq);
  assert.equal(second.record.decision.status, "unresolved");
  assert.equal(store.contexts.size, 1);
});

test("T31: A-edits / B-commits with A's trailer is supported — documented gap", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  await pinnedEdit(store, { actor: "codex", path: "a.ts" });
  const got = await classify(store, commitInput({ actorId: "codex" }));
  assert.equal(got.kind, "decision");
  if (got.kind !== "decision") return;
  assert.equal(got.record.decision.status, "supported");
  assert.equal(got.record.claim.id, "codex");
});

test("T35/T37: second producer may submit a new path; lower(b) is frozen at context U", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  await pinnedEdit(store, { actor: "codex", path: "a.ts" });
  const first = await classify(store, commitInput({ files: ["a.ts"] }));
  const u = first.kind === "decision" ? first.record.decision.window.upper_seq : -1;
  await pinnedEdit(store, { actor: "codex", path: "b.ts" });
  const second = await classify(store, commitInput({ files: ["a.ts", "b.ts"] }), { producer: "github-push", sealedBy: "webhook:github" });
  assert.equal(first.kind, "decision");
  assert.equal(second.kind, "decision");
  if (first.kind !== "decision" || second.kind !== "decision") return;
  assert.equal(second.record.decision.window.upper_seq, u);
  assert.equal(typeof second.record.decision.window.per_path_lower["b.ts"], "number");
  assert.ok(second.record.decision.window.per_path_lower["b.ts"] <= u);
  assert.equal(store.contexts.size, 1);
  assert.notEqual(first.record.decision.submitted.F_digest, second.record.decision.submitted.F_digest);
});

test("P4: existing context retrieves the named policy digest, never latest", async () => {
  const store = new MemoryEventStore();
  const v1 = await putPolicy(store);
  await pinnedEdit(store, { actor: "codex", path: "a.ts" });
  const first = await classify(store, commitInput());
  const { h } = handler(store);
  const v2 = await h(new Request("http://test/projects/p/policy", {
    method: "PUT",
    headers: { ...OWNER, "content-type": "application/json", "if-match": v1.digest },
    body: JSON.stringify(policyBody({ trusted_hook_stamps: ["assert:git hook (assert)", "assert:other"] })),
  }));
  assert.equal(v2.status, 201);
  const second = await classify(store, commitInput());
  assert.equal(first.kind, "decision");
  assert.equal(second.kind, "decision");
  if (first.kind !== "decision" || second.kind !== "decision") return;
  assert.equal(first.record.decision.context.policy_digest, v1.digest);
  assert.equal(second.record.decision.context.policy_digest, v1.digest);
});

test("P7: alias maps to the same R; a fork is a different context", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store, "p", {
    repositories: [{ name: "acme/app", aliases: ["app"] }, { name: "acme/fork", aliases: [] }],
    github_repos: ["acme/app", "acme/fork"],
  });
  await classify(store, commitInput(), { canonicalR: "app" });
  await classify(store, commitInput(), { canonicalR: "acme/app" });
  await classify(store, commitInput({
    artifacts: [
      { id: `commit:acme/fork@${SHA.slice(0, 12)}`, kind: "commit", role: "generated" },
      { id: "repo:acme/fork#a.ts", kind: "file", role: "generated" },
    ],
  }), { canonicalR: "acme/fork" });
  assert.equal(store.contexts.size, 2);
});

test("P8: missing policy → unavailable policy_missing, nothing sealed", async () => {
  const store = new MemoryEventStore();
  const got = await classify(store, commitInput());
  assert.equal(got.kind, "unavailable");
  if (got.kind !== "unavailable") return;
  assert.equal(got.reason, "policy_missing");
  assert.equal(store.contexts.size, 0);
});

test("T40: clean supported commit records shadow claim with no withheld selector", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  await pinnedEdit(store, { actor: "codex", path: "a.ts" });
  const got = await classify(store, commitInput());
  assert.equal(got.kind, "decision");
  if (got.kind !== "decision") return;
  assert.equal(got.record.decision.status, "supported");
  assert.equal(got.record.decision.actor_written, "claim");
  assert.equal(got.record.decision.would_write.actor_written, "claim");
  assert.equal(got.record.decision.shadow, true);
});

test("A2: concurrent first classifiers share one context row", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  await pinnedEdit(store, { actor: "codex", path: "a.ts" });
  const [a, b] = await Promise.all([classify(store, commitInput()), classify(store, commitInput({ idempotency_key: "git:other" }))]);
  assert.equal(a.kind, "decision");
  assert.equal(b.kind, "decision");
  if (a.kind !== "decision" || b.kind !== "decision") return;
  assert.equal(store.contexts.size, 1);
  assert.deepEqual(a.record.decision.window.per_path_lower, b.record.decision.window.per_path_lower);
});

test("A5/Q4: reassign + different canonical R → a second context, no (project, sha) lookup", async () => {
  const store = new MemoryEventStore();
  await putPolicy(store);
  const first = await classify(store, commitInput());
  assert.equal(first.kind, "decision");
  await putPolicy(store, "b", {
    project: "b",
    repositories: [{ name: "acme/app", aliases: [] }],
    github_repos: ["acme/app"],
  }, "p");
  const second = await classify(store, commitInput({ project: "b" }), { canonicalR: "acme/app" });
  assert.equal(second.kind, "decision");
  const sameProjectFork = await classify(store, commitInput({
    artifacts: [
      { id: `commit:acme/other@${SHA.slice(0, 12)}`, kind: "commit", role: "generated" },
      { id: "repo:acme/other#a.ts", kind: "file", role: "generated" },
    ],
  }), { canonicalR: "acme/other" });
  assert.equal(sameProjectFork.kind, "decision");
  assert.equal(store.contexts.size, 3);
  assert.ok(store.contexts.has("p\0acme/app\0" + SHA));
  assert.ok(store.contexts.has("b\0acme/app\0" + SHA));
  assert.ok(store.contexts.has("p\0acme/other\0" + SHA));
});
