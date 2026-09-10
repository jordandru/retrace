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
  const hookCd = hookEv?.method?.params?.[CLAIM_DECISION_PARAM] as { decision?: { context?: { read_head_seq?: number }; window?: { upper_seq?: number } } };
  const pushCd = pushEv?.method?.params?.[CLAIM_DECISION_PARAM] as { decision?: { context?: { read_head_seq?: number }; window?: { upper_seq?: number } } };
  assert.equal(hookCd?.decision?.context?.read_head_seq, pushCd?.decision?.context?.read_head_seq);
  assert.equal(hookCd?.decision?.window?.upper_seq, pushCd?.decision?.window?.upper_seq);
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
