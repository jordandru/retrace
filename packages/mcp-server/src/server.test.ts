import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "./sqlite-store.js";

/** Hermetic actor env: the dev shell may export RETRACE_ACTOR/ON_BEHALF_OF/ACTOR_LOCK (see 3c4b3e5). */
const withActorEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const keys = ["RETRACE_ACTOR", "RETRACE_ACTOR_MODEL", "RETRACE_ON_BEHALF_OF", "RETRACE_ACTOR_LOCK"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try { await fn(); } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};
const connect = async (store: SqliteStore, opts?: Parameters<typeof buildServer>[1]) => {
  const server = buildServer(store, opts);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return client;
};

test("MCP round trip: instruct → log → why → history → verify", async () => withActorEnv({ RETRACE_ON_BEHALF_OF: "jordan" }, async () => {
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
}));

test("project pin: writes to a non-pinned project are rejected, reads are not", async () => withActorEnv({ RETRACE_ON_BEHALF_OF: "jordan" }, async () => {
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
}));

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

const ENV = { RETRACE_ACTOR: "claude-code", RETRACE_ACTOR_MODEL: "claude-fable-5", RETRACE_ON_BEHALF_OF: "jordan@example.com" };

test("actor lock: retrace_log with actor.type human/system is rejected and writes nothing", async () => withActorEnv(ENV, async () => {
  const store = new SqliteStore(":memory:");
  const client = await connect(store);
  for (const type of ["human", "system"] as const) {
    const bad = (await client.callTool({ name: "retrace_log", arguments: { action: "approved", actor: { type, id: "jordan@example.com" }, artifacts: [{ id: "pr:rpg#1", kind: "pr" }] } })) as any;
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, new RegExp(`actor.type "${type}" is not allowed`));
    assert.match(bad.content[0].text, /RETRACE_ACTOR_LOCK=0/);
  }
  assert.deepEqual(await store.projects(), []);
}));

test("actor lock: agent-branch id/on_behalf_of/model come from env, not the caller", async () => withActorEnv(ENV, async () => {
  const store = new SqliteStore(":memory:");
  const client = await connect(store);
  const ok = (await client.callTool({
    name: "retrace_log",
    arguments: { action: "edited", actor: { id: "claude-cowork", on_behalf_of: "mallory@example.com", model: "gpt-x", display_name: "Cowork", version: "1.2" }, artifacts: [{ id: "repo:rpg#a.ts", kind: "file" }] },
  })) as any;
  assert.notEqual(ok.isError, true);
  const [evt] = await store.all("default");
  assert.deepEqual(evt.actor, { type: "agent", id: "claude-code", model: "claude-fable-5", on_behalf_of: "jordan@example.com", display_name: "Cowork", version: "1.2" });
}));

test("actor lock: retrace_instruct only attributes to RETRACE_ON_BEHALF_OF", async () => withActorEnv(ENV, async () => {
  const store = new SqliteStore(":memory:");
  const client = await connect(store);
  const bad = (await client.callTool({ name: "retrace_instruct", arguments: { human_id: "mallory@example.com", instruction: "x" } })) as any;
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /human_id "mallory@example.com" is not allowed/);
  assert.match(bad.content[0].text, /RETRACE_ACTOR_LOCK=0/);
  assert.deepEqual(await store.projects(), []);
  const ok = (await client.callTool({ name: "retrace_instruct", arguments: { human_id: "jordan@example.com", instruction: "x" } })) as any;
  assert.notEqual(ok.isError, true);
  const [evt] = await store.all("default");
  assert.deepEqual(evt.actor, { type: "human", id: "jordan@example.com" });
}));

test("actor lock: retrace_instruct rejects when RETRACE_ON_BEHALF_OF is unset", async () => withActorEnv({ RETRACE_ACTOR: "claude-code" }, async () => {
  const store = new SqliteStore(":memory:");
  const client = await connect(store);
  const bad = (await client.callTool({ name: "retrace_instruct", arguments: { human_id: "jordan@example.com", instruction: "x" } })) as any;
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /RETRACE_ON_BEHALF_OF is not configured/);
  assert.deepEqual(await store.projects(), []);
}));

test("actor lock: RETRACE_ACTOR_LOCK=0 restores caller overrides for both tools", async () => withActorEnv({ ...ENV, RETRACE_ACTOR_LOCK: "0" }, async () => {
  const store = new SqliteStore(":memory:");
  const client = await connect(store);
  const human = (await client.callTool({ name: "retrace_log", arguments: { action: "approved", actor: { type: "human", id: "someone@example.com" }, artifacts: [{ id: "pr:rpg#1", kind: "pr" }] } })) as any;
  assert.notEqual(human.isError, true);
  const agent = (await client.callTool({ name: "retrace_log", arguments: { action: "edited", actor: { id: "claude-cowork", on_behalf_of: "other@example.com" }, artifacts: [{ id: "repo:rpg#a.ts", kind: "file" }] } })) as any;
  assert.notEqual(agent.isError, true);
  const ins = (await client.callTool({ name: "retrace_instruct", arguments: { human_id: "other@example.com", instruction: "x" } })) as any;
  assert.notEqual(ins.isError, true);
  const evts = await store.all("default");
  assert.deepEqual(evts.map((e) => e.actor), [
    { type: "human", id: "someone@example.com" },
    { type: "agent", id: "claude-cowork", model: "claude-fable-5", on_behalf_of: "other@example.com" },
    { type: "human", id: "other@example.com" },
  ]);
}));
