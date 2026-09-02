import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, enrichLocation, clientSystem, detectIde, harnessSession, confinedWritePath } from "./index.js";
import { appendEvent } from "@retrace-dev/core";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteStore } from "./sqlite-store.js";

/** Hermetic actor env: the dev shell may export RETRACE_ACTOR/ON_BEHALF_OF/ACTOR_LOCK (see 3c4b3e5). The harness and
 *  IDE vars matter for the same reason: this suite runs INSIDE Claude Code, which exports CLAUDE_CODE_SESSION_ID, and
 *  may run inside an Orca pane, which exports ORCA_*. Left inherited, the session/ide assertions would pass on this
 *  machine and fail in CI (or vice versa). */
const withActorEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const keys = ["RETRACE_ACTOR", "RETRACE_ACTOR_MODEL", "RETRACE_ON_BEHALF_OF", "RETRACE_ACTOR_LOCK", "RETRACE_SYSTEM", "RETRACE_ENVIRONMENT", "RETRACE_ENV", "RETRACE_SESSION",
    "RETRACE_DEVICE", "RETRACE_IDE", "RETRACE_WORKSPACE", "CLAUDE_CODE_SESSION_ID", "GROK_SESSION_ID", "ORCA_PANE_KEY", "ORCA_TAB_ID", "ORCA_WORKTREE_ID", "ORCA_TERMINAL_HANDLE"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try { await fn(); } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};
/** The client identity matters now: `location.system`/`location.client` come from the `initialize` handshake, so the
 *  default here is the client Retrace is actually driven by rather than a placeholder name. */
const connect = async (store: SqliteStore, opts?: Parameters<typeof buildServer>[1], info = { name: "claude-code", version: "2.1.250" }) => {
  const server = buildServer(store, opts);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client(info);
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
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["retrace_amend", "retrace_export", "retrace_history", "retrace_instruct", "retrace_lineage", "retrace_log", "retrace_projects", "retrace_share", "retrace_status", "retrace_verify", "retrace_why"]);

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
  const status = (await client.callTool({ name: "retrace_status", arguments: { project: "rpg" } })) as any;
  assert.equal(status.structuredContent.status.integrity.ok, true);
  assert.equal(status.structuredContent.status.causality.coverage_pct, 100);
  assert.match(status.content[0].text, /100% causal coverage/);

  const legacy = (await client.callTool({ name: "retrace_log", arguments: { project: "rpg", action: "other", action_detail: "legacy", artifacts: [{ id: "legacy:no-role" }] } })) as any;
  const amended = (await client.callTool({ name: "retrace_amend", arguments: { project: "rpg", target_event_id: legacy.structuredContent.id, artifact_roles: [{ index: 0, role: "used" }], reason: "The legacy record identifies an input", caused_by: insId } })) as any;
  assert.match(amended.structuredContent.id, /^evt_/);
  const amendedStatus = (await client.callTool({ name: "retrace_status", arguments: { project: "rpg" } })) as any;
  assert.equal(amendedStatus.structuredContent.status.capture.amended_artifact_refs, 1);
  assert.equal(amendedStatus.structuredContent.status.capture.artifact_refs_without_role, 0);

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

test("retrace_log rejects a dangling or cross-project caused_by and writes nothing", async () => withActorEnv({ RETRACE_ON_BEHALF_OF: "jordan" }, async () => {
  const store = new SqliteStore(":memory:");
  const client = await connect(store);
  await client.callTool({ name: "retrace_instruct", arguments: { project: "rpg", human_id: "jordan", instruction: "add a jab" } });
  const dangling = (await client.callTool({
    name: "retrace_log",
    arguments: { project: "rpg", action: "edited", artifacts: [{ id: "repo:rpg#a.ts" }], caused_by: "evt_deadbeefdeadbeefdeadbeefdeadbeef" },
  })) as any;
  assert.equal(dangling.isError, true);
  assert.match(dangling.content[0].text, /does not name an event/);
  assert.equal((await store.all("rpg")).length, 1, "instruct only — agent can fix and retry");

  const other = (await appendEvent(store, {
    project: "other", actor: { type: "human", id: "jordan" }, action: "instructed", artifacts: [{ id: "task:other", role: "generated" }],
  })).event;
  const cross = (await client.callTool({
    name: "retrace_log",
    arguments: { project: "rpg", action: "edited", artifacts: [{ id: "repo:rpg#b.ts" }], caused_by: other.id },
  })) as any;
  assert.equal(cross.isError, true);
  assert.match(cross.content[0].text, /project "other"/);
  assert.equal((await store.all("rpg")).length, 1);
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

test("actor lock: an unpinned agent may report its runtime model without overriding identity", async () => withActorEnv({ RETRACE_ACTOR: "gemini", RETRACE_ON_BEHALF_OF: "jordan@example.com" }, async () => {
  const store = new SqliteStore(":memory:");
  const client = await connect(store);
  const ok = (await client.callTool({
    name: "retrace_log",
    arguments: { action: "edited", actor: { id: "not-gemini", on_behalf_of: "mallory@example.com", model: "gemini-2.5-pro" }, artifacts: [{ id: "repo:rpg#a.ts", kind: "file" }] },
  })) as any;
  assert.notEqual(ok.isError, true);
  const [evt] = await store.all("default");
  assert.deepEqual(evt.actor, { type: "agent", id: "gemini", model: "gemini-2.5-pro", on_behalf_of: "jordan@example.com" });
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

// ---- PROV artifact role (used / generated) on the MCP write path ----

test("artifact role: retrace_log fills the verb default only where the caller said nothing", async () => withActorEnv(ENV, async () => {
  const store = new SqliteStore(":memory:");
  const client = await connect(store);
  const log = (action: string, artifacts: any[]) => client.callTool({ name: "retrace_log", arguments: { action, artifacts } });
  await log("read", [{ id: "repo:rpg#a.ts", kind: "file" }]);
  await log("edited", [{ id: "repo:rpg#a.ts", kind: "file" }]);
  await log("created", [{ id: "repo:rpg#b.ts", kind: "file" }]);
  await log("executed", [{ id: "cmd:npm test" }, { id: "deployment:prod", kind: "deployment", role: "generated" }]);
  await log("deleted", [{ id: "repo:rpg#old.ts" }]);
  await log("read", [{ id: "repo:rpg#c.ts", role: "both" }]); // caller override survives even against a verb default
  const [rd, ed, cr, ex, del, ov] = await store.all("default");
  assert.equal(rd.artifacts[0].role, "used");
  assert.equal(ed.artifacts[0].role, "both");
  assert.equal(cr.artifacts[0].role, "generated");
  assert.deepEqual(ex.artifacts.map((a) => a.role), ["used", "generated"], "executed: refs default to inputs, the caller-marked output wins");
  assert.ok(!("role" in del.artifacts[0]), "deleted has no default — invalidation is not a role");
  assert.equal(ov.artifacts[0].role, "both");
  // and the roles are inside the sealed content
  assert.equal((await client.callTool({ name: "retrace_verify", arguments: {} }) as any).structuredContent.ok, true);
  const hist = (await client.callTool({ name: "retrace_history", arguments: { artifact_id: "repo:rpg#a.ts" } })) as any;
  assert.deepEqual(hist.structuredContent.events.map((e: any) => e.artifacts[0].role), ["used", "both"]);
}));

test("artifact role: retrace_instruct's default task is generated; caller-supplied refs are stored as given", async () => withActorEnv(ENV, async () => {
  const store = new SqliteStore(":memory:");
  const client = await connect(store);
  await client.callTool({ name: "retrace_instruct", arguments: { human_id: "jordan@example.com", instruction: "add a jab counter" } });
  await client.callTool({ name: "retrace_instruct", arguments: { human_id: "jordan@example.com", instruction: "review this", artifacts: [{ id: "repo:rpg#a.ts", kind: "file" }, { id: "task:review", kind: "task", role: "generated" }] } });
  const [def, given] = await store.all("default");
  assert.deepEqual(def.artifacts, [{ id: "task:add a jab counter", kind: "task", label: "add a jab counter", role: "generated" }]);
  assert.deepEqual(given.artifacts, [{ id: "repo:rpg#a.ts", kind: "file" }, { id: "task:review", kind: "task", role: "generated" }]);
}));

// ---- WHERE enrichment (backlog #15) ----

test("enrichLocation: fills absent fields only, never overwrites caller values", () => {
  const defaults = { system: "claude-code", environment: "local", path: "/srv", device: "box", session: "run_1" };
  assert.deepEqual(enrichLocation(undefined, defaults), defaults);
  const caller = { system: "claude-code", environment: "staging", url: "https://example.com/pr/1" };
  assert.deepEqual(enrichLocation(caller, defaults), {
    system: "claude-code", environment: "staging", url: "https://example.com/pr/1", path: "/srv", device: "box", session: "run_1",
  });
  assert.equal(enrichLocation({ path: undefined }, defaults).path, "/srv"); // explicit undefined = not supplied
});

test("location enrichment: retrace_log without location gets the server WHERE; session stable per server", async () => withActorEnv(ENV, async () => {
  const store = new SqliteStore(":memory:");
  const client = await connect(store);
  await client.callTool({ name: "retrace_log", arguments: { action: "edited", artifacts: [{ id: "repo:rpg#a.ts", kind: "file" }] } });
  await client.callTool({ name: "retrace_log", arguments: { action: "executed", artifacts: [{ id: "cmd:test" }] } });
  const [a, b] = await store.all("default");
  assert.equal(a.location?.system, "claude-code");
  assert.equal(a.location?.environment, "local");
  assert.equal(a.location?.path, process.cwd());
  assert.equal(a.location?.device, hostname());
  assert.match(a.location?.session ?? "", /^run_[0-9a-f]{12}$/);
  assert.ok(!("url" in (a.location ?? {})), "url must never be stamped");
  assert.equal(a.location?.session, b.location?.session);
}));

test("location enrichment: caller-supplied fields are preserved verbatim, missing ones filled", async () => withActorEnv(ENV, async () => {
  const store = new SqliteStore(":memory:");
  const client = await connect(store);
  await client.callTool({ name: "retrace_log", arguments: {
    action: "edited", artifacts: [{ id: "repo:rpg#a.ts", kind: "file" }],
    location: { system: "claude-code", environment: "staging", path: "src/x.ts" },
  } });
  const [evt] = await store.all("default");
  assert.equal(evt.location?.system, "claude-code");
  assert.equal(evt.location?.environment, "staging"); // caller wins over default "local"
  assert.equal(evt.location?.path, "src/x.ts");
  assert.equal(evt.location?.device, hostname());
  assert.match(evt.location?.session ?? "", /^run_/);
}));

test("location enrichment: retrace_instruct events carry a location (env-only)", async () => withActorEnv(ENV, async () => {
  const store = new SqliteStore(":memory:");
  const client = await connect(store);
  await client.callTool({ name: "retrace_instruct", arguments: { human_id: "jordan@example.com", instruction: "x" } });
  const [evt] = await store.all("default");
  assert.equal(evt.location?.system, "claude-code");
  assert.equal(evt.location?.environment, "local");
  assert.equal(evt.location?.path, process.cwd());
  assert.equal(evt.location?.device, hostname());
  assert.match(evt.location?.session ?? "", /^run_/);
}));

test("location enrichment: RETRACE_SYSTEM/RETRACE_ENVIRONMENT/RETRACE_SESSION override; RETRACE_ENV honored as fallback", async () => withActorEnv({ ...ENV, RETRACE_SYSTEM: "cursor", RETRACE_ENVIRONMENT: "ci", RETRACE_SESSION: "sess-42" }, async () => {
  const store = new SqliteStore(":memory:");
  const client = await connect(store);
  await client.callTool({ name: "retrace_log", arguments: { action: "edited", artifacts: [{ id: "repo:rpg#a.ts" }] } });
  const [evt] = await store.all("default");
  assert.equal(evt.location?.system, "cursor");
  assert.equal(evt.location?.environment, "ci");
  assert.equal(evt.location?.session, "sess-42");
  await withActorEnv({ ...ENV, RETRACE_ENV: "staging" }, async () => {
    const store2 = new SqliteStore(":memory:");
    const c2 = await connect(store2);
    await c2.callTool({ name: "retrace_log", arguments: { action: "edited", artifacts: [{ id: "repo:rpg#b.ts" }] } });
    const [e2] = await store2.all("default");
    assert.equal(e2.location?.environment, "staging");
  });
}));

// ---- WHERE: harness session, MCP client identity, IDE, server-only keys ----

test("clientSystem: known MCP client names map to a Retrace system slug; unknown names are slugged, never dropped", () => {
  assert.equal(clientSystem("claude-code"), "claude-code");
  assert.equal(clientSystem("claude-ai"), "claude-desktop");
  assert.equal(clientSystem("cursor-vscode"), "cursor");
  assert.equal(clientSystem("Visual Studio Code"), "vscode");
  assert.equal(clientSystem("grok-cli"), "grok");
  assert.equal(clientSystem("grok"), "grok");
  assert.equal(clientSystem("grok-shell-retrace"), "grok");
  assert.equal(clientSystem("gemini-cli"), "gemini-cli");
  assert.equal(clientSystem("copilot-cli"), "github-copilot");
  assert.equal(clientSystem("Some New Client 2.0"), "some-new-client-2-0");
  assert.equal(clientSystem("***"), "unknown", "a name with nothing sluggable still yields a value");
});

test("harnessSession: Claude and Grok session ids are both first-class; RETRACE_SESSION wins", () => {
  assert.equal(harnessSession({}), undefined);
  assert.equal(harnessSession({ CLAUDE_CODE_SESSION_ID: "c" }), "c");
  assert.equal(harnessSession({ GROK_SESSION_ID: "g" }), "g");
  assert.equal(harnessSession({ CLAUDE_CODE_SESSION_ID: "c", GROK_SESSION_ID: "g" }), "c", "Claude var is older and stays first when both are set");
  assert.equal(harnessSession({ RETRACE_SESSION: "pin", CLAUDE_CODE_SESSION_ID: "c", GROK_SESSION_ID: "g" }), "pin");
  assert.equal(harnessSession({ COPILOT_HOME: "/tmp" }), undefined, "Copilot CLI has no session env; do not treat COPILOT_* as a session id");
});

test("detectIde: Orca's own pane env identifies the IDE and the isolated worktree; nothing set stamps nothing", () => {
  assert.deepEqual(detectIde({}), { ide: undefined, workspace: undefined });
  // Orca's bin dir on PATH means only that it is INSTALLED — never taken as evidence that we are running in it.
  assert.deepEqual(detectIde({ PATH: "/c/Users/x/AppData/Local/Programs/orca/resources/bin" }), { ide: undefined, workspace: undefined });
  assert.deepEqual(detectIde({ ORCA_WORKTREE_ID: "wt_7" }), { ide: "orca", workspace: "wt_7" });
  assert.deepEqual(detectIde({ ORCA_PANE_KEY: "pane:1" }), { ide: "orca", workspace: undefined }, "a pane with no worktree still names the IDE");
  assert.deepEqual(detectIde({ ORCA_TERMINAL_HANDLE: "h1" }), { ide: "orca", workspace: undefined });
  assert.deepEqual(detectIde({ RETRACE_IDE: "vscode", RETRACE_WORKSPACE: "ws" }), { ide: "vscode", workspace: "ws" }, "explicit override for an IDE we cannot detect");
  assert.deepEqual(detectIde({ ORCA_WORKTREE_ID: "wt_7", RETRACE_IDE: "orca-fork" }), { ide: "orca-fork", workspace: "wt_7" }, "override wins over detection");
});

test("location.session: the harness session id is used when present, so MCP events and git commits share one key", async () => {
  await withActorEnv({ ...ENV, CLAUDE_CODE_SESSION_ID: "e09a0ccf-5eef-4c17-bc88-284d03d778e2" }, async () => {
    const store = new SqliteStore(":memory:");
    const client = await connect(store);
    await client.callTool({ name: "retrace_log", arguments: { action: "edited", artifacts: [{ id: "repo:rpg#a.ts" }] } });
    const [evt] = await store.all("default");
    assert.equal(evt.location?.session, "e09a0ccf-5eef-4c17-bc88-284d03d778e2", "not a run_ proxy any more");
  });
  // RETRACE_SESSION stays the explicit override, above the harness id.
  await withActorEnv({ ...ENV, CLAUDE_CODE_SESSION_ID: "from-harness", RETRACE_SESSION: "pinned" }, async () => {
    const store = new SqliteStore(":memory:");
    const client = await connect(store);
    await client.callTool({ name: "retrace_log", arguments: { action: "edited", artifacts: [{ id: "repo:rpg#a.ts" }] } });
    assert.equal((await store.all("default"))[0].location?.session, "pinned");
  });
  await withActorEnv({ ...ENV, GROK_SESSION_ID: "01a04b0f-20cc-7d83-b5fd-68a865a989fe" }, async () => {
    const store = new SqliteStore(":memory:");
    const client = await connect(store, undefined, { name: "grok-cli", version: "1.0.13" });
    await client.callTool({ name: "retrace_log", arguments: { action: "edited", artifacts: [{ id: "repo:rpg#a.ts" }] } });
    const [evt] = await store.all("default");
    assert.equal(evt.location?.session, "01a04b0f-20cc-7d83-b5fd-68a865a989fe");
    assert.equal(evt.location?.client, "grok-cli@1.0.13");
    assert.equal(evt.location?.system, "grok");
  });
});

test("location.client/system: taken from the MCP initialize handshake, not hardcoded", async () => {
  await withActorEnv(ENV, async () => {
    const store = new SqliteStore(":memory:");
    const client = await connect(store);
    await client.callTool({ name: "retrace_log", arguments: { action: "edited", artifacts: [{ id: "repo:rpg#a.ts" }] } });
    const [evt] = await store.all("default");
    assert.equal(evt.location?.client, "claude-code@2.1.250");
    assert.equal(evt.location?.system, "claude-code");
  });
  // The bug this fixes: every client used to be labelled "claude-code" regardless of who was actually connected.
  await withActorEnv(ENV, async () => {
    const store = new SqliteStore(":memory:");
    const client = await connect(store, undefined, { name: "cursor-vscode", version: "1.7.3" });
    await client.callTool({ name: "retrace_log", arguments: { action: "edited", artifacts: [{ id: "repo:rpg#a.ts" }] } });
    const [evt] = await store.all("default");
    assert.equal(evt.location?.client, "cursor-vscode@1.7.3");
    assert.equal(evt.location?.system, "cursor");
  });
  await withActorEnv(ENV, async () => {
    const store = new SqliteStore(":memory:");
    const client = await connect(store, undefined, { name: "grok-shell-retrace", version: "1.0.13" });
    await client.callTool({ name: "retrace_log", arguments: { action: "edited", artifacts: [{ id: "repo:rpg#a.ts" }] } });
    const [evt] = await store.all("default");
    assert.equal(evt.location?.client, "grok-shell-retrace@1.0.13", "handshake name stays verbatim");
    assert.equal(evt.location?.system, "grok");
  });
});

test("location: an Orca pane stamps ide + workspace on every event", async () => withActorEnv({ ...ENV, ORCA_PANE_KEY: "pane:abc", ORCA_WORKTREE_ID: "wt_feature_x" }, async () => {
  const store = new SqliteStore(":memory:");
  const client = await connect(store);
  await client.callTool({ name: "retrace_log", arguments: { action: "edited", artifacts: [{ id: "repo:rpg#a.ts" }] } });
  await client.callTool({ name: "retrace_instruct", arguments: { human_id: "jordan@example.com", instruction: "x" } });
  for (const evt of await store.all("default")) {
    assert.equal(evt.location?.ide, "orca");
    assert.equal(evt.location?.workspace, "wt_feature_x");
  }
}));

test("location: server-only fields are dropped from caller input — an agent cannot assert where it ran", async () => withActorEnv({ ...ENV, CLAUDE_CODE_SESSION_ID: "real-session", ORCA_WORKTREE_ID: "wt_real" }, async () => {
  const store = new SqliteStore(":memory:");
  const client = await connect(store);
  await client.callTool({ name: "retrace_log", arguments: {
    action: "edited", artifacts: [{ id: "repo:rpg#a.ts" }],
    location: { path: "src/x.ts", environment: "staging", session: "forged", device: "someone-elses-box", client: "totally-a-human@1", ide: "emacs", workspace: "wt_fake", surface: "tty" },
  } });
  const [evt] = await store.all("default");
  assert.equal(evt.location?.path, "src/x.ts", "path is still caller-wins — the caller knows the file, the server only knows cwd");
  assert.equal(evt.location?.environment, "staging");
  assert.equal(evt.location?.session, "real-session");
  assert.equal(evt.location?.device, hostname());
  assert.equal(evt.location?.client, "claude-code@2.1.250");
  assert.equal(evt.location?.ide, "orca");
  assert.equal(evt.location?.workspace, "wt_real");
  assert.ok(!("surface" in (evt.location ?? {})), "the MCP path never stamps surface, and the caller may not either");
  // enrichLocation is the single choke point, so assert it directly too.
  assert.deepEqual(enrichLocation({ session: "x", device: "y", client: "z", ide: "i", workspace: "w", surface: "tty", path: "p" }, { session: "s" }),
    { session: "s", path: "p" });
}));

test("retrace_history: newest window with a before_seq cursor, never a genesis prefix", async () => withActorEnv({}, async () => {
  const store = new SqliteStore(":memory:");
  const input = { project: "rpg", actor: { type: "agent" as const, id: "claude-code" }, action: "edited" as const, artifacts: [{ id: "a" }] };
  for (let i = 0; i < 5; i++) await appendEvent(store, input);
  const server = buildServer(store);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  const hist = (await client.callTool({ name: "retrace_history", arguments: { project: "rpg", limit: 2 } })) as any;
  assert.equal(hist.structuredContent.truncated, true);
  assert.deepEqual(hist.structuredContent.events.map((e: { seq: number }) => e.seq), [3, 4]);
  assert.equal(hist.structuredContent.next_before_seq, 3);
  assert.match(hist.content[0].text, /truncated/);
  const older = (await client.callTool({ name: "retrace_history", arguments: { project: "rpg", limit: 2, before_seq: 3 } })) as any;
  assert.deepEqual(older.structuredContent.events.map((e: { seq: number }) => e.seq), [1, 2]);
  const rest = (await client.callTool({ name: "retrace_history", arguments: { project: "rpg", limit: 2, before_seq: 1 } })) as any;
  assert.deepEqual(rest.structuredContent.events.map((e: { seq: number }) => e.seq), [0]);
  assert.equal(rest.structuredContent.truncated, false);
}));

test("confinedWritePath refuses absolute paths outside cwd", () => {
  const cwd = "/home/jordandrumiler/provenance/retrace";
  assert.equal(confinedWritePath("out/bundle.json", cwd), resolve(cwd, "out/bundle.json"));
  assert.throws(() => confinedWritePath("/tmp/evil.json", cwd), /working directory/);
  assert.throws(() => confinedWritePath("../../etc/passwd", cwd), /working directory/);
});
