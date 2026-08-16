import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "./sqlite-store.js";

test("MCP round trip: instruct → log → why → history → verify", async () => {
  const store = new SqliteStore(":memory:");
  const server = buildServer(store);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["retrace_export", "retrace_history", "retrace_instruct", "retrace_log", "retrace_projects", "retrace_share", "retrace_verify", "retrace_why"]);

  const ins = (await client.callTool({ name: "retrace_instruct", arguments: { project: "rpg", human_id: "jordan", instruction: "add a jab counter" } })) as any;
  const insId = ins.structuredContent.id;

  const log = (await client.callTool({
    name: "retrace_log",
    arguments: {
      project: "rpg", action: "edited", caused_by: insId,
      artifacts: [{ id: "repo:rpg#src/fight.ts", kind: "file" }],
      intent: "implement jab counter", location: { path: "src/fight.ts", system: "claude-code" }, method: { tool: "Edit", automated: true },
    },
  })) as any;
  assert.equal(log.structuredContent.seq, 1);

  const why = (await client.callTool({ name: "retrace_why", arguments: { event_id: log.structuredContent.id } })) as any;
  assert.equal(why.structuredContent.chain.length, 2);
  assert.match(why.content[0].text, /because .*jordan.*instructed/);

  const hist = (await client.callTool({ name: "retrace_history", arguments: { project: "rpg", artifact_id: "repo:rpg#src/fight.ts" } })) as any;
  assert.equal(hist.structuredContent.count, 1);

  const ver = (await client.callTool({ name: "retrace_verify", arguments: { project: "rpg" } })) as any;
  assert.equal(ver.structuredContent.ok, true);
  assert.equal(ver.structuredContent.checked, 2);

  // idempotency
  const a = (await client.callTool({ name: "retrace_log", arguments: { project: "rpg", action: "created", artifacts: [{ id: "x" }], idempotency_key: "k1" } })) as any;
  const b = (await client.callTool({ name: "retrace_log", arguments: { project: "rpg", action: "created", artifacts: [{ id: "x" }], idempotency_key: "k1" } })) as any;
  assert.equal(a.structuredContent.id, b.structuredContent.id);
  assert.equal(b.structuredContent.deduped, true);

  // export (signed with a temp key) + share
  process.env.RETRACE_SIGNING_KEY_FILE = join(mkdtempSync(join(tmpdir(), "retrace-key-")), "k.json");
  const ex = (await client.callTool({ name: "retrace_export", arguments: { project: "rpg", artifact_id: "repo:rpg#src/fight.ts" } })) as any;
  assert.equal(ex.structuredContent.signature, "valid");
  assert.equal(ex.structuredContent.events, 2); // 1 in scope + 1 causal ancestor (the instruction)
  assert.equal(ex.structuredContent.chain_ok, true);
  const sh = (await client.callTool({ name: "retrace_share", arguments: { project: "rpg", label: "test share", expires_in_days: 7 } })) as any;
  assert.match(sh.structuredContent.url, /\/s\/sh_[0-9a-f]{24}$/);
  const got = await store.getShare(sh.structuredContent.share.id);
  assert.equal(got?.label, "test share");
});
