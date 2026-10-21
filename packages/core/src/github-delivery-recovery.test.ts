import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryEventStore, createHandler, drainPendingGithubDeliveries, verifyProject,
  type PendingDelivery,
} from "./index.js";

const PROJECT = "delivery-recovery";
const REPO = "acme/app";
const RECEIVED = "2026-10-20T12:00:00.000Z";
const SHAS = ["a".repeat(40), "b".repeat(40)];

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function pushPayload(shas = SHAS) {
  return {
    ref: "refs/heads/main", before: "d".repeat(40),
    repository: { full_name: REPO }, pusher: { name: "owner" },
    commits: shas.map((id) => ({
      id, message: "work\n\nRetrace-Actor: codex\n", timestamp: RECEIVED,
      author: { name: "Owner", email: "owner@example.com" },
      added: ["a.ts"], modified: [], removed: [],
    })),
  };
}

function pending(deliveryId: string, over: Partial<PendingDelivery> = {}): PendingDelivery {
  return {
    delivery_id: deliveryId, project: PROJECT, repo: REPO, gh_event: "push",
    raw_body: JSON.stringify(pushPayload()), received_at: RECEIVED,
    routing_state: "received", routing_source: "env", state: "received", ...over,
  };
}

test("active drain losing its lease keeps the retained row; the next owner deduplicates prior appends before cleanup", { timeout: 5_000 }, async () => {
  const store = new MemoryEventStore();
  const receipt = pending("lease-loss");
  await store.insertPendingDelivery(receipt);
  let clock = Date.parse(RECEIVED);
  const firstSealed = gate(), continueFirst = gate(), secondClaimed = gate(), continueSecond = gate();
  const insert = store.insert.bind(store), claim = store.claimPendingDeliveryLease.bind(store);
  const save = store.updatePendingDeliveryIfLeaseOwner.bind(store), remove = store.deletePendingDelivery.bind(store);
  let inserts = 0, claims = 0, removals = 0;
  const owners: string[] = [];
  const saves: { owner: string; accepted: boolean; outcomes: string | undefined }[] = [];
  store.insert = async (event, extras) => {
    await insert(event, extras);
    inserts++;
    if (inserts === 1) { firstSealed.release(); await continueFirst.promise; }
  };
  store.claimPendingDeliveryLease = async (...args) => {
    const row = await claim(...args);
    if (row) {
      owners.push(row.lease_owner!);
      if (++claims === 2) { secondClaimed.release(); await continueSecond.promise; }
    }
    return row;
  };
  store.updatePendingDeliveryIfLeaseOwner = async (row, owner) => {
    const accepted = await save(row, owner);
    saves.push({ owner, accepted, outcomes: row.outcomes });
    return accepted;
  };
  store.deletePendingDelivery = async (id) => { removals++; return remove(id); };

  const first = drainPendingGithubDeliveries(store, { trailerPolicy: "off", now: () => clock });
  let second: ReturnType<typeof drainPendingGithubDeliveries> | undefined;
  try {
    await firstSealed.promise;
    const originalLease = (await store.getPendingDelivery(receipt.delivery_id))!;
    assert.equal(store.events.length, 1);
    clock = Date.parse(originalLease.lease_until!) + 1;
    second = drainPendingGithubDeliveries(store, { trailerPolicy: "off", now: () => clock });
    await secondClaimed.promise;
    assert.notEqual(owners[0], owners[1]);

    continueFirst.release();
    assert.deepEqual(await first, { drained: 0, failed: 1 });
    assert.equal(inserts, 2, "the old attempt can finish appends before its ownership save is refused");
    assert.equal(removals, 0, "a rejected aggregate save must not authorize deletion");
    assert.equal(saves.length, 1);
    assert.equal(saves[0]!.owner, owners[0]);
    assert.equal(saves[0]!.accepted, false);
    assert.deepEqual(JSON.parse(saves[0]!.outcomes!), Object.fromEntries(SHAS.map((sha) => [sha, { status: "sealed", attempt_count: 0 }])));
    const retained = (await store.getPendingDelivery(receipt.delivery_id))!;
    assert.equal(retained.lease_owner, owners[1]);
    assert.equal(retained.raw_body, receipt.raw_body);
    assert.equal(retained.received_at, receipt.received_at);
    assert.equal(retained.state, "received");
    assert.equal(retained.outcomes, undefined, "the stale attempt must not publish its progress");

    continueSecond.release();
    assert.deepEqual(await second, { drained: 1, failed: 0 });
    assert.equal(inserts, 2, "the next owner must reuse both existing seals");
    assert.equal(saves.length, 2);
    assert.equal(saves[1]!.owner, owners[1]);
    assert.equal(saves[1]!.accepted, true);
    assert.equal(removals, 1);
    assert.equal(await store.getPendingDelivery(receipt.delivery_id), null);
    assert.deepEqual(store.events.map((event) => event.idempotency_key), SHAS.map((sha) => `gh:push:${REPO}:${sha}`));
    assert.equal((await verifyProject(store, PROJECT)).ok, true);
  } finally {
    continueFirst.release(); continueSecond.release();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
});

test("drain completion checks owner equality: an expired lease with no takeover still saves and cleans up", async () => {
  const store = new MemoryEventStore();
  const receipt = pending("expired-owner", { raw_body: JSON.stringify(pushPayload([SHAS[0]!])) });
  await store.insertPendingDelivery(receipt);
  let clock = Date.parse(RECEIVED);
  const insert = store.insert.bind(store);
  store.insert = async (event, extras) => {
    await insert(event, extras);
    const row = (await store.getPendingDelivery(receipt.delivery_id))!;
    clock = Date.parse(row.lease_until!) + 1;
  };
  assert.deepEqual(await drainPendingGithubDeliveries(store, { trailerPolicy: "off", now: () => clock }), { drained: 1, failed: 0 });
  assert.equal(store.events.length, 1);
  assert.equal(await store.getPendingDelivery(receipt.delivery_id), null);
});

test("an empty mapping completes receipt cleanup but remains pending when retried", async () => {
  const store = new MemoryEventStore();
  const payload = {
    repository: { full_name: REPO }, sender: { login: "owner" }, action: "labeled",
    pull_request: { number: 7, title: "label only", updated_at: RECEIVED, head: { ref: "feature" }, base: { ref: "main" } },
  };
  const raw = JSON.stringify(payload), secret = "delivery-recovery-secret";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = "sha256=" + [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const insert = store.insertPendingDelivery.bind(store), remove = store.deletePendingDelivery.bind(store);
  let retainedReceipts = 0, removals = 0;
  store.insertPendingDelivery = async (row) => { retainedReceipts++; return insert(row); };
  store.deletePendingDelivery = async (id) => { removals++; return remove(id); };
  const handle = createHandler(store, { githubSecret: secret, githubRepoProjects: { [REPO]: PROJECT }, trailerPolicy: "off" });
  const response = await handle(new Request("http://test/hooks/github", {
    method: "POST", body: raw,
    headers: { "x-hub-signature-256": signature, "x-github-event": "pull_request", "x-github-delivery": "empty-receipt" },
  }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, event: "pull_request", project: PROJECT, logged: [] });
  assert.equal(retainedReceipts, 1);
  assert.equal(removals, 1);
  assert.equal(await store.getPendingDelivery("empty-receipt"), null);

  const receipt = pending("empty-retry", { gh_event: "pull_request", raw_body: raw });
  await insert(receipt);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await drainPendingGithubDeliveries(store, { trailerPolicy: "off" }), { drained: 0, failed: 1 });
    const row = (await store.getPendingDelivery(receipt.delivery_id))!;
    assert.equal(row.raw_body, raw);
    assert.equal(row.received_at, RECEIVED);
    assert.equal(row.state, "received");
    assert.equal(row.outcomes, "{}");
    assert.equal(row.lease_owner, undefined);
    assert.equal(row.lease_until, undefined);
  }
  assert.equal(removals, 1, "empty retry must not be mistaken for all-sealed completion");
  assert.equal(store.events.length, 0);
});

test("legacy NULL event kind and string outcomes preserve terminal audit state while remaining push work seals", async () => {
  const store = new MemoryEventStore();
  const receipt = pending("legacy-outcomes", {
    gh_event: null, outcomes: JSON.stringify({ [SHAS[0]!]: "budget_failed", [SHAS[1]!]: "pending" }),
  });
  await store.insertPendingDelivery(receipt);
  assert.deepEqual(await drainPendingGithubDeliveries(store, { trailerPolicy: "off" }), { drained: 0, failed: 1 });
  assert.deepEqual(store.events.map((event) => event.idempotency_key), [`gh:push:${REPO}:${SHAS[1]}`]);
  const row = (await store.getPendingDelivery(receipt.delivery_id))!;
  assert.equal(row.gh_event, null);
  assert.equal(row.raw_body, receipt.raw_body);
  assert.equal(row.received_at, RECEIVED);
  assert.equal(row.state, "terminal_failure");
  assert.deepEqual(JSON.parse(row.outcomes!), {
    [SHAS[0]!]: { status: "budget_failed", attempt_count: 3 },
    [SHAS[1]!]: { status: "sealed", attempt_count: 0 },
  });
  assert.deepEqual(await drainPendingGithubDeliveries(store, { trailerPolicy: "off" }), { drained: 0, failed: 0 });
  assert.equal((await store.getPendingDelivery(receipt.delivery_id))!.outcomes, row.outcomes);
  assert.equal(store.events.length, 1);
});
