import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHandler, drainPendingGithubDeliveries } from "./router.js";
import { receive, resume, WEBHOOK_DELIVERY_DEADLINE_MS } from "./github-delivery.js";
import { PENDING_LEASE_MS } from "./classify.js";
import { MemoryEventStore } from "./mem-store.js";
import { verifyProject } from "./store.js";
import type { Event } from "./schema.js";
import type { TrailerPolicy } from "./producer-sig.js";
import type { PolicyDocument } from "./policy.js";

const project = "delivery-characterization", repo = "acme/delivery", secret = "fixture-webhook-secret";
const timestamp = "2026-10-01T12:00:00.000Z", sha = "a".repeat(40), parent = "b".repeat(40);
const sender = { login: "owner", type: "User" };
const pr = { number: 7, title: "Preserve delivery records", body: "A fixed pull request body.",
  html_url: `https://github.com/${repo}/pull/7`, updated_at: timestamp,
  head: { ref: "feature/delivery", sha, repo: { full_name: repo } }, base: { ref: "main" },
  additions: 4, deletions: 1, changed_files: 1 };

const cases: Array<{ name: string; event: string; mode: TrailerPolicy; payload: object }> = [
  ...(["off", "shadow"] as const).map(mode => ({ name: `push-${mode}`, event: "push", mode,
    payload: { repository: { full_name: repo }, sender, ref: "refs/heads/main", pusher: { name: "owner" },
      commits: [{ id: sha, message: "Preserve records\n\nRetrace-Actor: codex\nRetrace-Model: fixture-model\nRetrace-Model-Source: harness-runtime\n",
        timestamp, url: `https://github.com/${repo}/commit/${sha}`, author: { name: "Fixture Owner", email: "owner@example.com" },
        parents: [parent], added: ["src/new.ts"], modified: [], removed: [] }] } })),
  { name: "pull-request", event: "pull_request", mode: "shadow", payload: { repository: { full_name: repo }, sender, action: "opened", pull_request: pr } },
  { name: "review", event: "pull_request_review", mode: "shadow", payload: { repository: { full_name: repo }, sender, action: "submitted", pull_request: pr,
    review: { id: 17, user: sender, state: "commented", body: "A fixed review body.", commit_id: sha, submitted_at: timestamp,
      html_url: `https://github.com/${repo}/pull/7#pullrequestreview-17` } } },
  { name: "comment", event: "issue_comment", mode: "shadow", payload: { repository: { full_name: repo }, sender, action: "created",
    issue: { number: 7, title: pr.title, pull_request: {} }, comment: { id: 23, user: sender, body: "A fixed comment body.", created_at: timestamp,
      html_url: `https://github.com/${repo}/pull/7#issuecomment-23` } } },
];

async function signature(raw: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "sha256=" + [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(raw)))].map(v => v.toString(16).padStart(2, "0")).join("");
}

/** Normalize only generated identity/time/hash references and measured elapsed time.
 * Every other sealed field, including complete method metadata and absent fields, remains in the comparison. */
function normalize(event: Event, policyDigest: string, readHeadHash: string): unknown {
  assert.match(event.id, /^evt_[0-9a-f]{32}$/);
  assert.equal(event.prev_hash, readHeadHash);
  assert.match(event.hash, /^[0-9a-f]{64}$/);
  assert.ok(Number.isFinite(Date.parse(event.received_at!)));
  const record = JSON.parse(JSON.stringify(event));
  record.id = "<event-id>";
  record.hash = "<event-hash>";
  record.prev_hash = "<read-head-hash>";
  record.received_at = "<seal-received-at>";
  const params = record.method.params;
  const claim = params.claim_decision?.decision;
  const owner = params.owner_login_decision?.decision;
  for (const decision of [claim, owner]) {
    if (!decision) continue;
    assert.equal(decision.context.policy_digest, policyDigest);
    assert.equal(decision.context.read_head_hash, readHeadHash);
    decision.context.policy_digest = "<policy-digest>";
    decision.context.read_head_hash = "<read-head-hash>";
    assert.equal(typeof decision.classification_ms, "number");
    assert.ok(decision.classification_ms >= 0);
    decision.classification_ms = "<elapsed-ms>";
  }
  if (owner) {
    const ingress = params.github_payload.ingress_at;
    assert.ok(Number.isFinite(Date.parse(ingress)));
    assert.equal(params.owner_login_decision.payload.ingress_at, ingress);
    assert.equal(owner.ingress_at, ingress);
    assert.equal(owner.window.to, ingress);
    assert.equal(Date.parse(owner.window.from), Date.parse(ingress) - 30 * 60_000);
    params.github_payload.ingress_at = "<original-ingress>";
    params.owner_login_decision.payload.ingress_at = "<original-ingress>";
    owner.ingress_at = "<original-ingress>";
    owner.window.to = "<original-ingress>";
    owner.window.from = "<original-ingress-minus-30m>";
  }
  return record;
}

async function characterize(scenario: typeof cases[number], path: "receipt" | "retry", surface: "module" | "caller" = "module"): Promise<unknown> {
  const store = new MemoryEventStore();
  const now = () => 1_000_000;
  const h = createHandler(store, { token: "fixture-owner-token-long-enough", ownerPrincipal: { type: "human", id: "owner@example.com" },
    githubSecret: secret, githubIncludePush: true, trailerPolicy: scenario.mode, now });
  const response = await h(new Request(`http://test/projects/${project}/policy`, { method: "PUT",
    headers: { authorization: "Bearer fixture-owner-token-long-enough", "content-type": "application/json", "if-match": "none" },
    body: JSON.stringify({ profile: "retrace-project-policy/2", project, trusted_hook_stamps: [], unresolved_claims: "record",
      repositories: [{ name: repo, aliases: [] }], github_repos: [repo], github: { shared_logins: [], identities: { owner: "codex" } } }) }));
  assert.equal(response.status, 201, await response.clone().text());
  const policy = await response.json() as PolicyDocument;
  const before = (await store.head(project))!;
  const raw = JSON.stringify(scenario.payload), deliveryId = `fixture-${scenario.name}`;
  if (path === "receipt") {
    if (surface === "module") {
      const outcome = await receive(store, { event: scenario.event, rawBody: raw, payload: scenario.payload,
        deliveryId, retainedDeliveryId: deliveryId, ingressAt: timestamp, project, canonicalRepo: repo,
        routingSource: "policy", routingDigest: policy.digest, currentPolicy: policy },
      { trailerPolicy: scenario.mode, pushEnabledAtReceipt: scenario.event === "push", includePush: true, deadline: now() + WEBHOOK_DELIVERY_DEADLINE_MS, now });
      assert.deepEqual(outcome, { kind: "complete", logged: [{ id: store.events.at(-1)!.id, seq: before.seq + 1, deduped: false }] });
    } else {
      const received = await h(new Request("http://test/hooks/github", { method: "POST", body: raw,
        headers: { "x-github-event": scenario.event, "x-github-delivery": deliveryId, "x-hub-signature-256": await signature(raw) } }));
      assert.equal(received.status, 201, await received.clone().text());
      const body = await received.json() as { logged: Array<{ id: string; seq: number; deduped: boolean }> };
      assert.deepEqual(body.logged, [{ id: store.events.at(-1)!.id, seq: before.seq + 1, deduped: false }]);
    }
  } else {
    await store.insertPendingDelivery({ delivery_id: deliveryId, project, repo, gh_event: scenario.event, raw_body: raw,
      received_at: timestamp, routing_source: "policy", routing_digest: policy.digest, routing_state: "received" });
    if (surface === "module") {
      const owner = "fixture-drainer", until = new Date(now() + PENDING_LEASE_MS).toISOString();
      const row = await store.claimPendingDeliveryLease(deliveryId, owner, new Date(now()).toISOString(), until);
      assert.ok(row, "the retry caller acquires the lease before invoking the module");
      assert.equal(await resume(store, { row, owner, until }, { trailerPolicy: scenario.mode, now }), "drained");
    } else {
      assert.deepEqual(await drainPendingGithubDeliveries(store, { trailerPolicy: scenario.mode, now }), { drained: 1, failed: 0 });
    }
  }
  assert.equal(store.events.length, 2, "one policy activation and one delivery event");
  assert.equal(store.pending.length, 0);
  assert.equal(store.ownerLoginConsumption.size, 0, "identity mapping consumes no declaration");
  assert.deepEqual(await verifyProject(store, project), { ok: true, checked: 2, legacy_events: 0 });
  const sealed = store.events.at(-1)!;
  const params = sealed.method!.params!;
  assert.equal(Object.hasOwn(params, "producer_sig_verdict"), !(scenario.name === "push-shadow" && path === "retry"), "preserve the original shadow retry's absent signature-verdict field");
  assert.equal(Object.hasOwn(params, "claim_decision"), scenario.name === "push-shadow");
  assert.equal(Object.hasOwn(params, "owner_login_decision"), scenario.event !== "push");
  assert.equal(Object.hasOwn(sealed, "producer_sig"), false);
  if (scenario.event !== "push" && (surface === "module" || path === "retry"))
    assert.equal((params.github_payload as { ingress_at: string }).ingress_at, timestamp, "retain the caller's original ingress");
  return normalize(sealed, policy.digest, before.hash);
}

// Captured from both original router paths at a02f27483c509d3ff5822cb689600b765c98427c,
// before extraction. The fixture is complete sealed-record data, not mapper-derived expectations.
const records = JSON.parse(readFileSync(new URL("./fixtures/github-delivery-records.json", import.meta.url), "utf8")) as Record<string, any>;
for (const scenario of cases) for (const path of ["receipt", "retry"] as const) {
  test(`GitHub delivery module preserves the full ${scenario.name} record through ${path}`, async () => {
    const expected = structuredClone(records[scenario.name]);
    // This is an intentional preservation of observed metadata absence, not a normalization.
    if (scenario.name === "push-shadow" && path === "retry") delete expected.method.params.producer_sig_verdict;
    assert.deepEqual(await characterize(scenario, path), expected);
  });
}

// Representative caller coverage for a family previously absent from receipt/retry integration tests.
// The full family matrix above belongs at the module's interface, rather than duplicated at both levels.
for (const path of ["receipt", "retry"] as const) {
  test(`GitHub review caller preserves the full record through ${path}`, async () => {
    const scenario = cases.find(candidate => candidate.name === "review")!;
    assert.deepEqual(await characterize(scenario, path, "caller"), records.review);
  });
}
