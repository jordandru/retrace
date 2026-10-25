import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, createHandler, generateSigningKey, MemoryEventStore, publicFromPrivate } from "@retrace-dev/core";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "./index.js";
import { RemoteStore } from "./remote-store.js";
import { logReceipt } from "./log-receipt.js";

test("receipt projects appended fields and never upgrades a local seal claim", async () => {
  const { event } = await appendEvent(new MemoryEventStore(), {
    project: "retrace", actor: { type: "agent", id: "hermes", model: "test", model_source: "harness-config" },
    action: "edited", caused_by: "evt_" + "1".repeat(32),
    artifacts: [{ id: "repo:jordandru/retrace#a.md", role: "generated" }],
    intent: "untrusted prose must not enter the receipt",
    method: { params: { sealed_by: "pinned:hermes", producer_sig_verdict: "verified", token: "dummy-secret" } },
  });
  const local = logReceipt(event, false);
  assert.equal(local.id, event.id);
  assert.equal(local.hash, event.hash);
  assert.equal(local.storage, "local");
  assert.deepEqual(local.artifacts, event.artifacts);
  assert.equal("sealed_by" in local, false);
  assert.equal("producer_sig_verdict" in local, false);
  assert.doesNotMatch(JSON.stringify(local), /dummy-secret|untrusted prose/);
  const remote = logReceipt(event, true);
  assert.equal(remote.storage, "remote");
  assert.equal(remote.sealed_by, "pinned:hermes");
  assert.equal(remote.producer_sig_verdict, "verified");
  assert.equal(logReceipt({ ...event, method: undefined }, true).sealed_by, null);
});

test("MCP receipt carries the Worker's actual pinned seal and signature result, including deduplication", async () => {
  const savedEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("RETRACE_")));
  const savedFetch = globalThis.fetch;
  let client: Client | undefined;
  try {
    for (const k of Object.keys(savedEnv)) delete process.env[k];
    const keys = await generateSigningKey();
    Object.assign(process.env, {
      RETRACE_ACTOR: "hermes", RETRACE_PROJECT: "retrace", RETRACE_ON_BEHALF_OF: "owner@example.invalid",
      RETRACE_ACTOR_MODEL: "fixture-model", RETRACE_ACTOR_MODEL_SOURCE: "harness-config",
      RETRACE_PRODUCER_KEY: JSON.stringify(keys.privateKey), RETRACE_URL: "https://receipt.invalid",
    });
    const store = new MemoryEventStore();
    const handle = createHandler(store, { credentials: [{
      name: "test · hermes for owner", token: "fixture-token", trust: "pinned", projects: ["retrace"],
      actor: { type: "agent", id: "hermes", on_behalf_of: "owner@example.invalid" },
      principal: { type: "human", id: "owner@example.invalid" },
      public_key: publicFromPrivate(keys.privateKey), require_signature: true,
    }] });
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(new URL(request.url).origin, "https://receipt.invalid", "no network destination is permitted");
      return handle(request);
    };
    const server = buildServer(new RemoteStore("https://receipt.invalid", "fixture-token"));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: "receipt-fixture", version: "1" }); await client.connect(ct);
    const ins = await client.callTool({ name: "retrace_instruct", arguments: {
      human_id: "owner@example.invalid", instruction: "fixture root",
    } }) as any;
    assert.equal(ins.isError, undefined, JSON.stringify(ins));
    const args = { action: "edited", caused_by: ins.structuredContent.id,
      artifacts: [{ id: "repo:jordandru/retrace#a.md", role: "both" }], idempotency_key: "receipt-fixture" };
    const forged = await client.callTool({ name: "retrace_log", arguments: {
      ...args, method: { params: { sealed_by: "owner", producer_sig_verdict: "none" } },
    } }) as any;
    assert.equal(forged.isError, true, "producer-authored seal fields are refused before append");
    assert.equal(forged.structuredContent, undefined);
    const logged = await client.callTool({ name: "retrace_log", arguments: args }) as any;
    assert.equal(logged.isError, undefined, JSON.stringify(logged));
    const receipt = logged.structuredContent.receipt;
    assert.equal(receipt.storage, "remote");
    assert.equal(receipt.sealed_by, "pinned:test · hermes for owner");
    assert.equal(receipt.producer_sig_verdict, "verified");
    assert.equal(receipt.hash, (await store.get(receipt.id))!.hash);
    assert.equal(receipt.actor.model, "fixture-model");
    assert.equal(receipt.caused_by, ins.structuredContent.id);
    const again = await client.callTool({ name: "retrace_log", arguments: args }) as any;
    assert.equal(again.structuredContent.deduped, true);
    assert.deepEqual(again.structuredContent.receipt, receipt);
  } finally {
    await client?.close(); globalThis.fetch = savedFetch;
    for (const k of Object.keys(process.env)) if (k.startsWith("RETRACE_")) delete process.env[k];
    Object.assign(process.env, savedEnv);
  }
});
