import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { generateSigningKey, publicFromPrivate, verifyProducerSig } from "@retrace-dev/core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./index.js";
import { SqliteStore } from "./sqlite-store.js";

test("stdio MCP signs instruct, log, and amend with RETRACE_PRODUCER_KEY_FILE", async () => {
  const keys = [
    "RETRACE_ACTOR", "RETRACE_ACTOR_MODEL", "RETRACE_ON_BEHALF_OF", "RETRACE_ACTOR_LOCK",
    "RETRACE_PROJECT", "RETRACE_PRODUCER_KEY", "RETRACE_PRODUCER_KEY_FILE",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const dir = mkdtempSync(join(tmpdir(), "retrace-producer-mcp-"));
  let client: Client | undefined;
  try {
    for (const key of keys) delete process.env[key];
    const pair = await generateSigningKey();
    const keyFile = join(dir, "agent.jwk");
    writeFileSync(keyFile, JSON.stringify(pair.privateKey), { mode: 0o600, flag: "wx" });
    Object.assign(process.env, {
      RETRACE_ACTOR: "nooa",
      RETRACE_ON_BEHALF_OF: "alice@example.com",
      RETRACE_PROJECT: "pilot",
      RETRACE_PRODUCER_KEY_FILE: keyFile,
    });

    const store = new SqliteStore(":memory:");
    const server = buildServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "producer-signing-test", version: "1.0.0" });
    await client.connect(clientTransport);

    const instructed = await client.callTool({
      name: "retrace_instruct",
      arguments: { human_id: "alice@example.com", instruction: "sign every write" },
    }) as any;
    const logged = await client.callTool({
      name: "retrace_log",
      arguments: {
        action: "edited",
        artifacts: [{ id: "repo:pilot#answer.md", role: "generated" }],
        caused_by: instructed.structuredContent.id,
      },
    }) as any;
    const amended = await client.callTool({
      name: "retrace_amend",
      arguments: {
        target_event_id: logged.structuredContent.id,
        attest_causal_root: true,
        reason: "confirm root",
        caused_by: instructed.structuredContent.id,
      },
    }) as any;

    const publicKey = publicFromPrivate(pair.privateKey);
    for (const id of [instructed, logged, amended].map((result) => result.structuredContent.id)) {
      const event = await store.get(id);
      assert.ok(event?.producer_sig, `missing producer signature on ${id}`);
      assert.equal(await verifyProducerSig(event!, publicKey), true);
    }
  } finally {
    await client?.close();
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
