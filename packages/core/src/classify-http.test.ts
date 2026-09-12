import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_DECISION_PARAM, MemoryEventStore, POLICY_PROFILE, SEALED_BY_PARAM, appendEvent,
  applyBreakerFailure, createHandler, drainPendingGithubDeliveries, generateSigningKey,
  signProducer, PRODUCER_SIG_FORMAT_V2, type EventInput,
} from "./index.js";

const OWNER = { authorization: "Bearer owner-token-long-enough" };
const HOOK = "git-hook-token-0123456789abc";
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function body(over: Record<string, unknown> = {}) {
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

async function ghSigned(secret: string, payload: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return "sha256=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function handler(store = new MemoryEventStore(), extra: Record<string, unknown> = {}) {
  return {
    store,
    h: createHandler(store, {
      token: "owner-token-long-enough",
      ownerPrincipal: { type: "human", id: "owner@example.com" },
      ownerActor: { type: "human", id: "owner@example.com" },
      trailerPolicy: "shadow",
      githubSecret: "s3cret",
      githubIncludePush: true,
      githubRepoProjects: { "acme/app": "p" },
      credentials: [{
        token: HOOK,
        trust: "assert",
        actor: { type: "system", id: "retrace-git" },
        projects: ["p"],
        allowed_actors: [
          { type: "agent", id: "codex" },
          { type: "human", id: "jordan@example.com" },
        ],
      }],
      ...extra,
    }),
  };
}

async function putPolicy(h: (r: Request) => Promise<Response>, project = "p", over: Record<string, unknown> = {}) {
  const res = await h(new Request(`http://test/projects/${project}/policy`, {
    method: "PUT",
    headers: { ...OWNER, "content-type": "application/json", "if-match": "none" },
    body: JSON.stringify(body({ project, ...over })),
  }));
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
}

function commitBody(over: Partial<EventInput> = {}): EventInput {
  return {
    project: "p",
    actor: { type: "agent", id: "codex", on_behalf_of: "jordan@example.com" },
    action: "committed",
    artifacts: [
      { id: `commit:acme/app@${SHA.slice(0, 12)}`, kind: "commit", role: "generated" },
      { id: "repo:acme/app#a.ts", kind: "file", role: "generated" },
    ],
    timestamp: "2026-09-10T12:00:00.000Z",
    method: {
      tool: "git",
      automated: true,
      params: {
        sha: SHA,
        parents: ["dddddddddddddddddddddddddddddddddddddddd"],
        raw_message: "work\n\nRetrace-Actor: codex\n",
        author: { name: "Jordan", email: "jordan@example.com" },
      },
    },
    ...over,
  };
}

function pushPayload(over: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main",
    before: "dddddddddddddddddddddddddddddddddddddddd",
    repository: { full_name: "acme/app" },
    pusher: { name: "jordandru" },
    commits: [{
      id: SHA,
      message: "work\n\nRetrace-Actor: codex\n",
      timestamp: "2026-09-10T12:00:00.000Z",
      author: { name: "Jordan", email: "jordan@example.com" },
      added: ["a.ts"],
      modified: [],
      removed: [],
    }],
    ...over,
  };
}

async function postPush(h: (r: Request) => Promise<Response>, payload: object, delivery: string) {
  const raw = JSON.stringify(payload);
  return h(new Request("http://test/hooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": await ghSigned("s3cret", raw),
      "x-github-event": "push",
      "x-github-delivery": delivery,
    },
    body: raw,
  }));
}

test("T17: caller-supplied claim_decision is discarded and re-derived", async () => {
  const { store, h } = handler();
  await putPolicy(h);
  const planted = {
    policy: "trailer-consistency/1",
    decision: { status: "supported", actor_written: "withheld", shadow: true },
    claim: { type: "agent", id: "forged" },
  };
  const res = await h(new Request("http://test/events", {
    method: "POST",
    headers: { authorization: `Bearer ${HOOK}`, "content-type": "application/json" },
    body: JSON.stringify(commitBody({
      method: {
        tool: "git",
        automated: true,
        params: {
          sha: SHA,
          parents: ["dddddddddddddddddddddddddddddddddddddddd"],
          raw_message: "work\n\nRetrace-Actor: codex\n",
          author: { name: "Jordan", email: "jordan@example.com" },
          [CLAIM_DECISION_PARAM]: planted,
        },
      },
    })),
  }));
  assert.equal(res.status, 201, await res.clone().text());
  const ev = store.events.find((e) => e.action === "committed")!;
  const cd = ev.method?.params?.[CLAIM_DECISION_PARAM] as { claim?: { id?: string }; decision?: { status?: string; actor_written?: string } };
  assert.notEqual(cd?.claim?.id, "forged");
  assert.equal(cd?.claim?.id, "codex");
  assert.equal(cd?.decision?.actor_written, "claim");
});

test("T17 /2: signed commit also discards planted claim_decision", async () => {
  const key = await generateSigningKey();
  const { store, h } = handler(new MemoryEventStore(), {
    credentials: [{
      token: HOOK,
      trust: "assert",
      actor: { type: "system", id: "retrace-git" },
      projects: ["p"],
      allowed_actors: [{ type: "agent", id: "codex" }, { type: "human", id: "jordan@example.com" }],
      public_key: key.publicKey,
    }],
  });
  await putPolicy(h);
  const signed = await signProducer(commitBody({
    idempotency_key: "git:" + SHA,
  }), key.privateKey, { format: PRODUCER_SIG_FORMAT_V2 });
  const planted = {
    ...signed,
    method: {
      ...signed.method,
      params: {
        ...signed.method?.params,
        [CLAIM_DECISION_PARAM]: { decision: { status: "supported", actor_written: "withheld" } },
      },
    },
  };
  const res = await h(new Request("http://test/events", {
    method: "POST",
    headers: { authorization: `Bearer ${HOOK}`, "content-type": "application/json" },
    body: JSON.stringify(planted),
  }));
  assert.equal(res.status, 201, await res.clone().text());
  const ev = store.events.find((e) => e.action === "committed")!;
  const cd = ev.method?.params?.[CLAIM_DECISION_PARAM] as { decision?: { actor_written?: string; shadow?: boolean } };
  assert.equal(cd?.decision?.actor_written, "claim");
  assert.equal(cd?.decision?.shadow, true);
});

test("P8 HTTP: shadow POST /events without policy is 503 queued loud", async () => {
  const { h } = handler();
  const res = await h(new Request("http://test/events", {
    method: "POST",
    headers: { authorization: `Bearer ${HOOK}`, "content-type": "application/json" },
    body: JSON.stringify(commitBody()),
  }));
  assert.equal(res.status, 503);
  const j = await res.json() as { pending?: boolean; hook?: string; reason?: string };
  assert.equal(j.pending, true);
  assert.equal(j.hook, "queued");
  assert.equal(j.reason, "policy_missing");
});

test("T18: webhook deadline → 202 pending; drain first-attempt creates the context", async () => {
  const { store, h } = handler();
  await putPolicy(h);
  const orig = store.eventsReferencingArtifacts!.bind(store);
  store.eventsReferencingArtifacts = async () => ({ ok: false, reason: "deadline" });
  const pending = await postPush(h, pushPayload(), "d-deadline");
  assert.equal(pending.status, 202, await pending.clone().text());
  const body = await pending.json() as { pending?: unknown; reason?: string };
  assert.equal(body.reason, "deadline");
  assert.equal(store.events.filter((e) => e.action === "committed").length, 0);
  store.eventsReferencingArtifacts = orig;
  const drain = await drainPendingGithubDeliveries(store, { trailerPolicy: "shadow" });
  assert.equal(drain.drained, 1);
  const sealed = store.events.find((e) => e.action === "committed");
  assert.ok(sealed);
  assert.ok(sealed!.method?.params?.[CLAIM_DECISION_PARAM]);
  assert.equal(store.contexts.size, 1);
});

test("T19+T36: three sync deadlines open only that project's breaker; drain still classifies", async () => {
  const { store, h } = handler();
  await putPolicy(h);
  await putPolicy(h, "q", {
    project: "q",
    repositories: [{ name: "acme/other", aliases: [] }],
    github_repos: ["acme/other"],
  });
  const t0 = Date.now();
  let row = applyBreakerFailure(null, "p", new Date(t0).toISOString(), t0);
  row = applyBreakerFailure(row, "p", new Date(t0 + 1).toISOString(), t0 + 1);
  row = applyBreakerFailure(row, "p", new Date(t0 + 2).toISOString(), t0 + 2);
  store.breakers.set("p", row);
  assert.equal(row.state, "open");

  const blocked = await postPush(h, pushPayload(), "d-open");
  assert.equal(blocked.status, 202);
  const blockedJson = await blocked.json() as { reason?: string };
  assert.equal(blockedJson.reason, "breaker_open");
  assert.equal(store.events.filter((e) => e.action === "committed").length, 0);

  const { h: hq } = handler(store, { githubRepoProjects: { "acme/other": "q" } });
  const other = await postPush(hq, pushPayload({
    repository: { full_name: "acme/other" },
    commits: [{
      id: SHA,
      message: "work\n\nRetrace-Actor: codex\n",
      timestamp: "2026-09-10T12:00:00.000Z",
      author: { name: "Jordan", email: "jordan@example.com" },
      added: ["a.ts"], modified: [], removed: [],
    }],
  }), "d-q");
  assert.equal(other.status, 201, await other.clone().text());

  const drain = await drainPendingGithubDeliveries(store, { trailerPolicy: "shadow" });
  assert.ok(drain.drained >= 1);
  assert.ok(store.events.some((e) => e.project === "p" && e.action === "committed"));
});

test("T23: duplicate github push delivery dedups on gh:push key, no second context write", async () => {
  const { store, h } = handler();
  await putPolicy(h);
  const first = await postPush(h, pushPayload(), "d1");
  assert.equal(first.status, 201, await first.clone().text());
  const n = store.events.filter((e) => e.action === "committed").length;
  const second = await postPush(h, pushPayload(), "d2");
  assert.equal(second.status, 201, await second.clone().text());
  const j = await second.json() as { logged?: { deduped?: boolean }[] };
  assert.equal(j.logged?.[0]?.deduped, true);
  assert.equal(store.events.filter((e) => e.action === "committed").length, n);
  assert.equal(store.contexts.size, 1);
});

test("T25 HTTP: shadow conflicting keeps submitted actor", async () => {
  const { store, h } = handler();
  await putPolicy(h);
  await appendEvent(store, {
    project: "p",
    actor: { type: "agent", id: "opencode" },
    action: "edited",
    artifacts: [{ id: "repo:acme/app#a.ts", kind: "file", role: "generated" }],
    timestamp: "2026-09-10T11:00:00.000Z",
    method: { tool: "editor", params: { [SEALED_BY_PARAM]: "pinned:opencode" } },
  });
  const res = await postPush(h, pushPayload(), "d-conflict");
  assert.equal(res.status, 201, await res.clone().text());
  const ev = store.events.find((e) => e.action === "committed")!;
  assert.equal(ev.actor.id, "codex");
  const cd = ev.method?.params?.[CLAIM_DECISION_PARAM] as { decision?: { status?: string; actor_written?: string; shadow?: boolean; would_write?: { actor_written?: string } } };
  assert.equal(cd?.decision?.status, "conflicting");
  assert.equal(cd?.decision?.actor_written, "claim");
  assert.equal(cd?.decision?.shadow, true);
  assert.equal(cd?.decision?.would_write?.actor_written, "withheld");
});

test("T11 hook: non-alias repo string shares the webhook context", async () => {
  const { store, h } = handler();
  await putPolicy(h);
  await appendEvent(store, {
    project: "p",
    actor: { type: "agent", id: "codex" },
    action: "edited",
    artifacts: [{ id: "repo:acme/app#a.ts", kind: "file", role: "generated" }],
    timestamp: "2026-09-10T11:00:00.000Z",
    method: { tool: "editor", params: { [SEALED_BY_PARAM]: "pinned:codex" } },
  });
  const hook = await h(new Request("http://test/events", {
    method: "POST",
    headers: { authorization: `Bearer ${HOOK}`, "content-type": "application/json" },
    body: JSON.stringify(commitBody({
      artifacts: [
        { id: `commit:local-checkout@${SHA.slice(0, 12)}`, kind: "commit", role: "generated" },
        { id: "repo:local-checkout#a.ts", kind: "file", role: "generated" },
      ],
    })),
  }));
  assert.equal(hook.status, 201, await hook.clone().text());
  const push = await postPush(h, pushPayload(), "d-t11-alias");
  assert.equal(push.status, 201, await push.clone().text());
  assert.equal(store.contexts.size, 1);
  assert.ok(store.contexts.has(`p\0acme/app\0${SHA}`));
  const hookEv = store.events.find((e) => e.action === "committed" && e.method?.params?.sealed_by !== "webhook:github");
  const pushEv = store.events.find((e) => e.action === "committed" && e.method?.params?.sealed_by === "webhook:github");
  type Decision = { decision?: {
    status?: string;
    submitted?: { F_digest?: string };
    context?: { read_head_seq?: number };
    window?: { upper_seq?: number; per_path_lower?: Record<string, number> };
    witnesses?: { id: string }[];
  } };
  const hookCd = hookEv?.method?.params?.[CLAIM_DECISION_PARAM] as Decision;
  const pushCd = pushEv?.method?.params?.[CLAIM_DECISION_PARAM] as Decision;
  assert.equal(hookCd?.decision?.context?.read_head_seq, pushCd?.decision?.context?.read_head_seq);
  assert.equal(hookCd?.decision?.window?.upper_seq, pushCd?.decision?.window?.upper_seq);
  assert.equal(hookCd?.decision?.submitted?.F_digest, pushCd?.decision?.submitted?.F_digest);
  assert.deepEqual(hookCd?.decision?.window?.per_path_lower, pushCd?.decision?.window?.per_path_lower);
  assert.deepEqual(hookCd?.decision?.witnesses, pushCd?.decision?.witnesses);
  assert.equal(hookCd?.decision?.status, "supported");
  assert.equal(pushCd?.decision?.status, "supported");
});

test("breaker (a)/(b): drain failures do not increment the breaker", async () => {
  const { store, h } = handler();
  await putPolicy(h);
  const orig = store.eventsReferencingArtifacts!.bind(store);
  store.eventsReferencingArtifacts = async () => ({ ok: false, reason: "deadline" });
  assert.equal((await postPush(h, pushPayload(), "d-a")).status, 202);
  const afterSync = store.breakers.get("p");
  assert.ok(afterSync);
  assert.equal(afterSync!.failures, 1);
  await drainPendingGithubDeliveries(store, { trailerPolicy: "shadow" });
  assert.equal(store.breakers.get("p")!.failures, 1, "drain must not call recordWebhookClassifyOutcome");
  store.eventsReferencingArtifacts = orig;
});

test("F2 HTTP: lower-bound deadline returns hook 503/webhook 202 and seals nothing", async () => {
  const run = async (source: "hook" | "webhook") => {
    const { store, h } = handler();
    await putPolicy(h);
    let clock = 0;
    const realNow = Date.now;
    const ensure = store.ensureClassificationPathLowers.bind(store);
    store.ensureClassificationPathLowers = async (...args) => {
      const result = await ensure(...args);
      clock = 501;
      return result;
    };
    Date.now = () => clock;
    try {
      const response = source === "hook"
        ? await h(new Request("http://test/events", {
          method: "POST", headers: { authorization: `Bearer ${HOOK}`, "content-type": "application/json" },
          body: JSON.stringify(commitBody()),
        }))
        : await postPush(h, pushPayload(), "d-lower-deadline");
      assert.equal(response.status, source === "hook" ? 503 : 202, await response.clone().text());
      assert.equal(store.events.filter((e) => e.action === "committed").length, 0);
      const result = await response.json() as { reason?: string };
      assert.equal(result.reason, "deadline");
    } finally {
      Date.now = realNow;
    }
  };
  await run("hook");
  await run("webhook");
});

test("F7: pinned client commit claim cannot create or freeze the producer context", async () => {
  const pinnedToken = "pinned-agent-token-0123456789";
  const { store, h } = handler(new MemoryEventStore(), {
    credentials: [
      {
        token: HOOK, trust: "assert", actor: { type: "system", id: "retrace-git" }, projects: ["p"],
        allowed_actors: [{ type: "agent", id: "codex" }, { type: "human", id: "jordan@example.com" }],
      },
      { token: pinnedToken, trust: "pinned", actor: { type: "agent", id: "codex" }, projects: ["p"] },
    ],
  });
  await putPolicy(h);
  const pinned = await h(new Request("http://test/events", {
    method: "POST", headers: { authorization: `Bearer ${pinnedToken}`, "content-type": "application/json" },
    body: JSON.stringify(commitBody()),
  }));
  assert.equal(pinned.status, 201, await pinned.clone().text());
  assert.equal(store.contexts.size, 0);
  const clientClaim = store.events.find((e) => e.action === "committed")!;
  assert.equal(clientClaim.method?.params?.sealed_by, "pinned:agent/codex");
  assert.equal(clientClaim.method?.params?.[CLAIM_DECISION_PARAM], undefined);

  const hook = await h(new Request("http://test/events", {
    method: "POST", headers: { authorization: `Bearer ${HOOK}`, "content-type": "application/json" },
    body: JSON.stringify(commitBody({ idempotency_key: "git:producer" })),
  }));
  assert.equal(hook.status, 201, await hook.clone().text());
  const push = await postPush(h, pushPayload(), "d-after-pinned");
  assert.equal(push.status, 201, await push.clone().text());
  assert.equal(store.contexts.size, 1);
  const ctx = [...store.contexts.values()][0]!;
  assert.equal(ctx.first_producer, "git-hook");
  assert.ok(ctx.read_head_seq >= clientClaim.seq);
});

test("F17: fileless push with incomplete parent facts is sealed as merge_unclassified", async () => {
  const { store, h } = handler();
  await putPolicy(h);
  const payload = pushPayload({
    commits: [{
      id: SHA, message: "Merge branch 'feature'", timestamp: "2026-09-10T12:00:00.000Z",
      author: { name: "Jordan", email: "jordan@example.com" },
      added: [], modified: [], removed: [],
    }],
  });
  const response = await postPush(h, payload, "d-fileless-merge");
  assert.equal(response.status, 201, await response.clone().text());
  const seal = store.events.find((event) => event.action === "committed")!;
  const claim = seal.method?.params?.[CLAIM_DECISION_PARAM] as { decision?: { status?: string }; submitted?: { parents?: string[] } };
  assert.deepEqual(seal.method?.params?.parents, []);
  assert.equal(seal.method?.params?.parents_complete, false);
  assert.equal(claim.decision?.status, "merge_unclassified");
});

test("F8: one 2s delivery budget returns 202 with current and remaining shas", async () => {
  const { store, h } = handler();
  await putPolicy(h);
  const shas = Array.from({ length: 6 }, (_, i) => String(i + 1).repeat(40));
  const commits = shas.map((id) => ({
    id, message: "work\n\nRetrace-Actor: codex\n", timestamp: "2026-09-10T12:00:00.000Z",
    author: { name: "Jordan", email: "jordan@example.com" },
    added: ["a.ts"], modified: [], removed: [],
  }));
  const realNow = Date.now;
  let clock = 0;
  Date.now = () => clock;
  const query = store.eventsReferencingArtifacts!.bind(store);
  store.eventsReferencingArtifacts = async (...args) => {
    clock += 400;
    return query(...args);
  };
  try {
    const response = await postPush(h, pushPayload({ commits }), "d-delivery-deadline");
    assert.equal(response.status, 202, await response.clone().text());
    const result = await response.json() as { pending?: string[]; reason?: string };
    assert.equal(result.reason, "deadline");
    assert.deepEqual(result.pending, shas.slice(4));
    assert.equal(store.events.filter((event) => event.action === "committed").length, 4);
    assert.ok(await store.getPendingDelivery("d-delivery-deadline"));
    assert.equal(clock, 2_000);
  } finally {
    Date.now = realNow;
  }
});

test("F8: an unsettled classification store operation is response-bounded", async () => {
  const { store, h } = handler();
  await putPolicy(h);
  store.eventsReferencingArtifacts = async () => new Promise(() => {});
  const started = Date.now();
  const response = await postPush(h, pushPayload(), "d-unsettled");
  const elapsed = Date.now() - started;
  assert.equal(response.status, 202, await response.clone().text());
  assert.equal((await response.json() as { reason?: string }).reason, "deadline");
  assert.equal(store.events.filter((event) => event.action === "committed").length, 0);
  assert.ok(elapsed >= 450 && elapsed < 1_500, `response took ${elapsed} ms`);
});

test("F9/F10: drain budgets are per-sha and terminal/policy-off work stays durable", async () => {
  const { store, h } = handler();
  await putPolicy(h);
  const shas = ["1".repeat(40), "2".repeat(40), "3".repeat(40)];
  const payload = pushPayload({ commits: shas.map((id) => ({
    id, message: "work\n\nRetrace-Actor: codex\n", timestamp: "2026-09-10T12:00:00.000Z",
    author: { name: "Jordan", email: "jordan@example.com" }, added: ["a.ts"], modified: [], removed: [],
  })) });
  await store.insertPendingDelivery({
    delivery_id: "d-per-sha", project: "p", raw_body: JSON.stringify(payload),
    received_at: "2026-09-10T12:00:00.000Z", repo: "acme/app", routing_state: "received",
  });
  let calls = 0;
  store.eventsReferencingArtifacts = async () => ({ ok: false, reason: calls++ === 0 ? "deadline" : "budget" });
  for (let drain = 0; drain < 3; drain++) await drainPendingGithubDeliveries(store, { trailerPolicy: "shadow" });
  let row = await store.getPendingDelivery("d-per-sha");
  assert.ok(row);
  let outcomes = JSON.parse(row!.outcomes!) as Record<string, { status: string; attempt_count: number; reason: string }>;
  assert.equal(outcomes[shas[0]!]!.status, "pending");
  assert.equal(outcomes[shas[0]!]!.attempt_count, 2);
  assert.equal(outcomes[shas[1]!]!.status, "budget_failed");
  assert.equal(outcomes[shas[2]!]!.status, "budget_failed");
  await drainPendingGithubDeliveries(store, { trailerPolicy: "shadow" });
  row = await store.getPendingDelivery("d-per-sha");
  assert.ok(row, "terminal audit row must remain");
  outcomes = JSON.parse(row!.outcomes!) as typeof outcomes;
  assert.ok(shas.every((sha) => outcomes[sha]!.status === "budget_failed"));
  assert.equal(row!.state, "terminal_failure");

  const offStore = new MemoryEventStore();
  await offStore.insertPendingDelivery({
    delivery_id: "d-off", project: "p", raw_body: JSON.stringify(pushPayload()),
    received_at: "2026-09-10T12:00:00.000Z", repo: "acme/app", routing_state: "received",
  });
  const off = await drainPendingGithubDeliveries(offStore, { trailerPolicy: "off" });
  assert.equal(off.failed, 1);
  const offRow = await offStore.getPendingDelivery("d-off");
  assert.ok(offRow);
  const offOutcome = JSON.parse(offRow!.outcomes!) as Record<string, { status: string; reason: string }>;
  assert.equal(offOutcome[SHA]!.status, "pending");
  assert.equal(offOutcome[SHA]!.reason, "policy_off");
});

test("F11/F12: one atomic drainer wins and unresolved rows cannot starve ready work", async () => {
  const store = new MemoryEventStore();
  const { h } = handler(store);
  await putPolicy(h);
  for (let i = 0; i < 20; i++) await store.insertPendingDelivery({
    delivery_id: `unresolved-${i}`, project: "", raw_body: "{}",
    received_at: "2026-09-01T00:00:00.000Z", routing_state: "unresolved",
  });
  await store.insertPendingDelivery({
    delivery_id: "d-ready", project: "p", raw_body: JSON.stringify(pushPayload()),
    received_at: "2026-09-10T12:00:00.000Z", repo: "acme/app", routing_state: "received",
  });
  const originalList = store.listDrainablePendingDeliveries.bind(store);
  let listed = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  store.listDrainablePendingDeliveries = async (...args) => {
    const rows = await originalList(...args);
    listed++;
    if (listed === 2) release();
    else await barrier;
    return rows;
  };
  let classifiers = 0;
  const query = store.eventsReferencingArtifacts!.bind(store);
  store.eventsReferencingArtifacts = async (...args) => {
    classifiers++;
    return query(...args);
  };
  await Promise.all([
    drainPendingGithubDeliveries(store, { trailerPolicy: "shadow" }),
    drainPendingGithubDeliveries(store, { trailerPolicy: "shadow" }),
  ]);
  assert.equal(classifiers, 1);
  assert.equal(await store.getPendingDelivery("d-ready"), null);
  assert.equal(store.pending.filter((row) => row.routing_state === "unresolved").length, 20);

  await store.insertPendingDelivery({
    delivery_id: "d-reclaim", project: "p", raw_body: JSON.stringify(pushPayload()),
    received_at: "2026-09-10T12:00:00.000Z", repo: "acme/app", routing_state: "received",
  });
  const first = await store.claimPendingDeliveryLease("d-reclaim", "owner-1", "2026-09-10T12:00:00.000Z", "2026-09-10T12:01:00.000Z");
  assert.ok(first);
  const blocked = await store.claimPendingDeliveryLease("d-reclaim", "owner-2", "2026-09-10T12:00:30.000Z", "2026-09-10T12:01:30.000Z");
  assert.equal(blocked, null);
  const reclaimed = await store.claimPendingDeliveryLease("d-reclaim", "owner-2", "2026-09-10T12:01:01.000Z", "2026-09-10T12:02:01.000Z");
  assert.ok(reclaimed);
  assert.equal(await store.updatePendingDeliveryIfLeaseOwner({ ...first!, state: "done" }, "owner-1"), false);
});

test("F13: success resets per commit; classifier store errors are 202; pending insert failure is 500", async () => {
  const { store, h } = handler();
  await putPolicy(h);
  const now = Date.now();
  let breaker = applyBreakerFailure(null, "p", new Date(now).toISOString(), now);
  breaker = applyBreakerFailure(breaker, "p", new Date(now + 1).toISOString(), now + 1);
  store.breakers.set("p", breaker);
  const query = store.eventsReferencingArtifacts!.bind(store);
  let calls = 0;
  store.eventsReferencingArtifacts = async (...args) => ++calls === 2 ? { ok: false, reason: "deadline" } : query(...args);
  const two = pushPayload({ commits: [
    { ...pushPayload().commits[0], id: "1".repeat(40) },
    { ...pushPayload().commits[0], id: "2".repeat(40) },
  ] });
  const partial = await postPush(h, two, "d-reset");
  assert.equal(partial.status, 202, await partial.clone().text());
  assert.equal(store.breakers.get("p")?.failures, 1);

  const throwing = new MemoryEventStore();
  const { h: throwingHandler } = handler(throwing);
  await putPolicy(throwingHandler);
  throwing.head = async () => { throw new Error("injected head failure"); };
  const unavailable = await postPush(throwingHandler, pushPayload(), "d-store-error");
  assert.equal(unavailable.status, 202, await unavailable.clone().text());
  assert.equal((await unavailable.json() as { reason?: string }).reason, "store_error");
  assert.equal(throwing.events.filter((event) => event.action === "committed").length, 0);
  assert.equal(throwing.breakers.get("p")?.failures, 1);

  const insertFailure = new MemoryEventStore();
  const { h: insertFailureHandler } = handler(insertFailure);
  await putPolicy(insertFailureHandler);
  insertFailure.insertPendingDelivery = async () => { throw new Error("durable insert failed"); };
  assert.equal((await postPush(insertFailureHandler, pushPayload(), "d-insert-error")).status, 500);
});

test("F16 HTTP: duplicate delivery ids cannot execute the same half-open probe", async () => {
  const { store, h } = handler();
  await putPolicy(h);
  const old = Date.now() - 10 * 60_000;
  let row = applyBreakerFailure(null, "p", new Date(old).toISOString(), old);
  row = applyBreakerFailure(row, "p", new Date(old + 1).toISOString(), old + 1);
  row = applyBreakerFailure(row, "p", new Date(old + 2).toISOString(), old + 2);
  store.breakers.set("p", row);
  const get = store.getPendingDelivery.bind(store);
  let entrants = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  store.getPendingDelivery = async (id) => {
    if (id === "d-duplicate" && entrants < 2) {
      entrants++;
      if (entrants === 2) release();
      else await barrier;
      return null;
    }
    return get(id);
  };
  let classifiers = 0;
  const query = store.eventsReferencingArtifacts!.bind(store);
  store.eventsReferencingArtifacts = async (...args) => {
    classifiers++;
    return query(...args);
  };
  const responses = await Promise.all([
    postPush(h, pushPayload(), "d-duplicate"),
    postPush(h, pushPayload(), "d-duplicate"),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 202]);
  assert.equal(classifiers, 1);
});
