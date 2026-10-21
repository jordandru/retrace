import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, drainPendingGithubDeliveries } from "./router.js";
import { MemoryEventStore } from "./mem-store.js";
import type { TrailerPolicy } from "./producer-sig.js";

const repo = "acme/options", project = "delivery-options", sha = "a".repeat(40);
const timestamp = "2026-10-20T12:00:00.000Z";
const payload = { repository: { full_name: repo }, ref: "refs/heads/main", pusher: { name: "owner" },
  commits: [{ id: sha, message: "work", timestamp, author: { name: "Owner", email: "owner@example.com" }, added: ["a.ts"] }] };
const raw = JSON.stringify(payload);

test("receipt uses its initial push admission but reads mapping inclusion after retention", async () => {
  const store = new MemoryEventStore();
  const opts = { githubSecret: "option-test", githubRepoProjects: { [repo]: project }, githubIncludePush: true, trailerPolicy: "off" as TrailerPolicy };
  const retain = store.insertPendingDelivery.bind(store);
  store.insertPendingDelivery = async (row) => {
    await retain(row);
    opts.githubIncludePush = false;
  };
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(opts.githubSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = "sha256=" + [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const response = await createHandler(store, opts)(new Request("http://test/hooks/github", {
    method: "POST", body: raw, headers: { "x-hub-signature-256": signature, "x-github-event": "push", "x-github-delivery": "inclusion-change" },
  }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, event: "push", project, logged: [] });
  assert.equal(store.events.length, 0);
  assert.equal(store.pending.length, 0, "the originally retained receipt still receives cleanup");
});

test("retry reads trailer policy after its idempotency lookup", async () => {
  const store = new MemoryEventStore();
  await store.insertPendingDelivery({ delivery_id: "policy-change", project, repo, gh_event: "push", raw_body: raw, received_at: timestamp, routing_state: "received" });
  const opts = { trailerPolicy: "shadow" as TrailerPolicy };
  const lookup = store.byIdempotencyKey.bind(store);
  store.byIdempotencyKey = async (...args) => {
    const prior = await lookup(...args);
    opts.trailerPolicy = "off";
    return prior;
  };
  assert.deepEqual(await drainPendingGithubDeliveries(store, opts), { drained: 1, failed: 0 });
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0]!.method?.params?.producer_sig_verdict, "none");
  assert.equal(Object.hasOwn(store.events[0]!.method?.params ?? {}, "claim_decision"), false);
  assert.equal(store.pending.length, 0);
});

test("malformed retry input is retained as terminal without reading trailer policy", async () => {
  const store = new MemoryEventStore();
  await store.insertPendingDelivery({ delivery_id: "malformed", project, repo, gh_event: "push", raw_body: "{", received_at: timestamp, routing_state: "received" });
  let reads = 0;
  const opts = { get trailerPolicy(): TrailerPolicy { reads++; throw new Error("policy must not be read"); } };
  assert.deepEqual(await drainPendingGithubDeliveries(store, opts), { drained: 0, failed: 1 });
  assert.equal(reads, 0);
  assert.equal((await store.getPendingDelivery("malformed"))?.state, "terminal_failure");
  assert.equal(store.events.length, 0);
});
