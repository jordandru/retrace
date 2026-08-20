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
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["retrace_export", "retrace_history", "retrace_instruct", "retrace_lineage", "retrace_log", "retrace_projects", "retrace_share", "retrace_verify", "retrace_why"]);

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
  const ln = (await client.callTool({ name: "retrace_lineage", arguments: { project: "rpg", format: "mermaid" } })) as any;
  assert.match(ln.content[0].text, /graph LR/);
  assert.ok(ln.structuredContent.edges >= 1);
});

test("project pin: writes to a non-pinned project are rejected, reads are not", async () => {
  const store = new SqliteStore(":memory:");
  const server = buildServer(store, { pinnedProject: "rpg", lock: true });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  const bad = (await client.callTool({ name: "retrace_log", arguments: { project: "slc-wit-it", action: "edited", artifacts: [{ id: "repo:rpg#a.ts", kind: "file" }] } })) as any;
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /pinned to project "rpg"/);
  const badIns = (await client.callTool({ name: "retrace_instruct", arguments: { project: "slc-wit-it", human_id: "jordan", instruction: "x" } })) as any;
  assert.equal(badIns.isError, true);
  const ok = (await client.callTool({ name: "retrace_log", arguments: { action: "edited", artifacts: [{ id: "repo:rpg#a.ts", kind: "file" }] } })) as any;
  assert.notEqual(ok.isError, true);
  const okExplicit = (await client.callTool({ name: "retrace_log", arguments: { project: "rpg", action: "edited", artifacts: [{ id: "repo:rpg#b.ts", kind: "file" }] } })) as any;
  assert.notEqual(okExplicit.isError, true);
  const projects = (await client.callTool({ name: "retrace_projects", arguments: {} })) as any;
  assert.deepEqual(projects.structuredContent.projects, ["rpg"]);
  const hist = (await client.callTool({ name: "retrace_history", arguments: { project: "some-other-project" } })) as any;
  assert.notEqual(hist.isError, true);
  const unlocked = buildServer(new SqliteStore(":memory:"), { pinnedProject: "rpg", lock: false });
  const [ct2, st2] = InMemoryTransport.createLinkedPair();
  await unlocked.connect(st2);
  const c2 = new Client({ name: "t2", version: "0" });
  await c2.connect(ct2);
  const free = (await c2.callTool({ name: "retrace_log", arguments: { project: "anything", action: "edited", artifacts: [{ id: "repo:x#a", kind: "file" }] } })) as any;
  assert.notEqual(free.isError, true);
});

test('commit guard: retrace_log rejects action "committed" and writes nothing', async () => {
  // Hermetic: injected in-memory store (RETRACE_URL is never consulted — see 3c4b3e5) and no
  // inherited RETRACE_COMMIT_LOCK from the dev shell.
  delete process.env.RETRACE_COMMIT_LOCK;
  const store = new SqliteStore(":memory:");
  const server = buildServer(store);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  const bad = (await client.callTool({ name: "retrace_log", arguments: { action: "committed", artifacts: [{ id: "commit:rpg@abcdef123456", kind: "commit" }] } })) as any;
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /reserved for the git hook/);
  assert.match(bad.content[0].text, /RETRACE_COMMIT_LOCK=0/);
  assert.deepEqual(await store.projects(), []);
});

test("commit guard: RETRACE_COMMIT_LOCK=0 allows a committed event", async () => {
  process.env.RETRACE_COMMIT_LOCK = "0";
  try {
    const store = new SqliteStore(":memory:");
    const server = buildServer(store);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const ok = (await client.callTool({ name: "retrace_log", arguments: { action: "committed", artifacts: [{ id: "commit:rpg@abcdef123456", kind: "commit" }] } })) as any;
    assert.notEqual(ok.isError, true);
    assert.match(ok.structuredContent.id, /^evt_/);
    assert.equal((await store.projects()).length, 1);
  } finally {
    delete process.env.RETRACE_COMMIT_LOCK;
  }
});
