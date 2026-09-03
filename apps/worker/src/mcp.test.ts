import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { appendEvent, createHandler, pageHistoryNewest, parseCredentials, type ChainHead, type Event, type EventStore, type Share } from "@retrace-dev/core";
import { authenticateRemoteMcp, buildRemoteMcpServer, handleRemoteMcp, RETRACE_MCP_MAX_BODY_BYTES } from "./mcp.js";

class MemStore implements EventStore {
  events: Event[] = [];
  shares = new Map<string, Share>();
  async head(project: string) { const event = this.events.filter((e) => e.project === project).at(-1); return event ? { seq: event.seq, hash: event.hash } : null; }
  async insert(event: Event) { this.events.push(event); }
  async byIdempotencyKey(project: string, key: string) { return this.events.find((e) => e.project === project && e.idempotency_key === key) ?? null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(project: string) { return this.events.filter((e) => e.project === project).sort((a, b) => a.seq - b.seq); }
  async projects() { return [...new Set(this.events.map((e) => e.project))]; }
  async history(query: any) { return pageHistoryNewest(this.events, query); }
  async createShare(share: Share) { this.shares.set(share.id, share); }
  async getShare(id: string) { return this.shares.get(id) ?? null; }
  async deleteShare(id: string) { return this.shares.delete(id); }
  async deleteProject(_project: string, _audit: Event, _head: ChainHead) { return {}; }
}

const TOKEN = "openclaw-test-token-000000000000";
const credential = (overrides: Record<string, unknown> = {}) => ({
  token: TOKEN,
  name: "OpenClaw pilot",
  actor: { type: "agent", id: "openclaw", on_behalf_of: "jordan@example.com" },
  trust: "pinned",
  projects: ["retrace"],
  ...overrides,
});
const raw = (value: unknown = [credential()]) => JSON.stringify(value);
const request = (token = TOKEN, extra: RequestInit = {}) => new Request("https://retrace.example/mcp", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(extra.headers ?? {}) },
  body: extra.body ?? "{}",
});

test("remote MCP authentication accepts only pinned, unsigned agent credentials scoped to one project", async () => {
  assert.equal((await authenticateRemoteMcp(request(), raw()))?.actor.id, "openclaw");
  assert.equal(await authenticateRemoteMcp(request("wrong"), raw()), null);
  assert.equal(await authenticateRemoteMcp(new Request("https://retrace.example/mcp?token=" + TOKEN), raw()), null, "query tokens are never accepted");
  assert.equal(await authenticateRemoteMcp(request(), raw([credential({ trust: "assert" })])), null);
  assert.equal(await authenticateRemoteMcp(request(), raw([credential({ actor: { type: "human", id: "jordan@example.com" } })])), null);
  assert.equal(await authenticateRemoteMcp(request(), raw([credential({ projects: ["retrace", "other"] })])), null);
  assert.equal(await authenticateRemoteMcp(request(), raw([credential({ require_signature: true })])), null);
});

test("remote MCP exposes exactly the audit tools and stamps OpenClaw identity and project", async () => {
  const store = new MemStore();
  const parsed = await authenticateRemoteMcp(request(), raw());
  assert.ok(parsed);
  const apiHandler = createHandler(store, { requireAuth: true, credentials: parseCredentials(raw()) });
  const server = buildRemoteMcpServer(store, parsed, { requestUrl: "https://retrace.example/mcp", apiHandler });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "nemoclaw", version: "0.1" });
  await client.connect(clientTransport);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    "retrace_export", "retrace_history", "retrace_instruct", "retrace_lineage", "retrace_log",
    "retrace_projects", "retrace_status", "retrace_verify", "retrace_why",
  ]);
  const exportTool = listed.tools.find((tool) => tool.name === "retrace_export")!;
  assert.equal("out_json" in (exportTool.inputSchema.properties ?? {}), false);
  assert.equal("out_html" in (exportTool.inputSchema.properties ?? {}), false);

  const instructed = await client.callTool({ name: "retrace_instruct", arguments: { human_id: "jordan@example.com", instruction: "audit the pilot" } }) as any;
  const logged = await client.callTool({ name: "retrace_log", arguments: {
    action: "read",
    duration_ms: 123,
    actor: { id: "forged", on_behalf_of: "mallory@example.com", model: "openclaw-model" },
    artifacts: [{ id: "repo:retrace#README.md" }],
    caused_by: instructed.structuredContent.id,
  } }) as any;
  assert.match(logged.structuredContent.id, /^evt_/);
  const [root, event] = store.events;
  assert.equal(root.actor.id, "jordan@example.com");
  assert.deepEqual(event.actor, { type: "agent", id: "openclaw", on_behalf_of: "jordan@example.com", model: "openclaw-model" });
  assert.equal(event.project, "retrace");
  assert.equal(event.location?.system, "openclaw");
  assert.equal(event.location?.environment, "remote-mcp");
  assert.equal(event.artifacts[0].role, "used");
  assert.equal(event.duration_ms, 123);
  assert.equal(event.producer_sig, undefined, "compatibility pilot does not assert producer signatures");
  assert.equal(event.method?.params?.sealed_by, "pinned:OpenClaw pilot");
  assert.equal(event.method?.params?.producer_sig_verdict, "none");
  assert.equal(root.method?.params?.relayed_by, "openclaw");

  const exported = await client.callTool({ name: "retrace_export", arguments: {} }) as any;
  assert.equal(exported.structuredContent.bundle.events.length, 2);
  assert.equal(exported.structuredContent.signature, "unsigned");

  const wrongProject = await client.callTool({ name: "retrace_status", arguments: { project: "other" } }) as any;
  assert.equal(wrongProject.isError, true);
  assert.match(wrongProject.content[0].text, /pinned to project "retrace"/);
  const committed = await client.callTool({ name: "retrace_log", arguments: { action: "committed", artifacts: [{ id: "commit:x" }] } }) as any;
  assert.equal(committed.isError, true);
  await client.close();
});

test("remote MCP rejects cross-project caused_by and never discloses a historical foreign ancestor", async () => {
  const store = new MemStore();
  const foreign = (await appendEvent(store, {
    project: "foreign",
    actor: { type: "human", id: "private@example.com" },
    action: "instructed",
    artifacts: [{ id: "private-task" }],
    intent: "foreign project secret",
  })).event;
  const parsed = await authenticateRemoteMcp(request(), raw());
  assert.ok(parsed);
  const apiHandler = createHandler(store, { requireAuth: true, credentials: parseCredentials(raw()) });
  const server = buildRemoteMcpServer(store, parsed, { requestUrl: "https://retrace.example/mcp", apiHandler });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "nemoclaw-boundary-test", version: "0.1" });
  await client.connect(clientTransport);

  const rejected = await client.callTool({ name: "retrace_log", arguments: {
    action: "edited",
    artifacts: [{ id: "target" }],
    caused_by: foreign.id,
  } }) as any;
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /another project|project/i);
  assert.equal(store.events.length, 1, "rejected remote log does not append");

  // Simulate a historical adapter event: adapters retain invalid claims but mark them unverified.
  const local = (await appendEvent(store, {
    project: "retrace",
    actor: { type: "agent", id: "adapter" },
    action: "edited",
    artifacts: [{ id: "target" }],
    caused_by: foreign.id,
  })).event;
  await appendEvent(store, {
    project: "retrace",
    actor: { type: "agent", id: "adapter" },
    action: "edited",
    artifacts: [{ id: "unrelated" }],
  });
  assert.ok(local.tags?.includes("caused_by:unverified"));

  const why = await client.callTool({ name: "retrace_why", arguments: { event_id: local.id } }) as any;
  assert.deepEqual(why.structuredContent.chain.map((event: Event) => event.id), [local.id]);
  const exported = await client.callTool({ name: "retrace_export", arguments: { artifact_id: "target" } }) as any;
  assert.deepEqual(exported.structuredContent.bundle.events.map((event: Event) => event.project), ["retrace"]);
  assert.equal(exported.structuredContent.bundle.context_events, 0);
  const lineage = await client.callTool({ name: "retrace_lineage", arguments: { artifact_id: "target", format: "json", include_actors: true } }) as any;
  assert.doesNotMatch(JSON.stringify(lineage.structuredContent), /foreign project secret|private@example\.com|private-task/);
  await client.close();
});

test("remote MCP HTTP gate is opt-in, bearer-only, same-origin, and body bounded", async () => {
  const store = new MemStore();
  const apiHandler = createHandler(store, { requireAuth: true, credentials: parseCredentials(raw()) });
  assert.equal((await handleRemoteMcp(request(), { RETRACE_CREDENTIALS: raw() }, store, apiHandler)).status, 404);
  assert.equal((await handleRemoteMcp(request("bad"), { RETRACE_MCP_ENABLED: "1", RETRACE_CREDENTIALS: raw() }, store, apiHandler)).status, 401);
  assert.equal((await handleRemoteMcp(request(TOKEN, { headers: { origin: "https://evil.example" } }), { RETRACE_MCP_ENABLED: "1", RETRACE_CREDENTIALS: raw(), RETRACE_PUBLIC_URL: "https://retrace.example" }, store, apiHandler)).status, 403);
  const oversized = request(TOKEN, { body: "x".repeat(RETRACE_MCP_MAX_BODY_BYTES + 1) });
  assert.equal((await handleRemoteMcp(oversized, { RETRACE_MCP_ENABLED: "1", RETRACE_CREDENTIALS: raw() }, store, apiHandler)).status, 413);
});

test("Streamable HTTP client negotiates with /mcp and lists the audit surface", async () => {
  const store = new MemStore();
  const env = { RETRACE_MCP_ENABLED: "1", RETRACE_CREDENTIALS: raw(), RETRACE_PUBLIC_URL: "https://retrace.example" };
  const apiHandler = createHandler(store, { requireAuth: true, credentials: parseCredentials(raw()), publicUrl: env.RETRACE_PUBLIC_URL });
  const transport = new StreamableHTTPClientTransport(new URL("https://retrace.example/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    fetch: async (input, init) => {
      const incoming = input instanceof Request ? input : new Request(input, init);
      return handleRemoteMcp(incoming, env, store, apiHandler);
    },
  });
  const client = new Client({ name: "nemoclaw-http-test", version: "0.1" });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 9);
  assert.equal(tools.tools.some((tool) => tool.name === "retrace_log"), true);
  await client.close();
});
