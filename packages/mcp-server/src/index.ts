#!/usr/bin/env node
/**
 * Retrace MCP server — lets any MCP-capable agent (Claude Code, Claude Desktop, Cursor…)
 * log provenance events and retrace history.
 *
 * Config (env):
 *   RETRACE_DB       path to local SQLite file (default ~/.retrace/retrace.db)
 *   RETRACE_URL      if set, use the remote Worker instead of local SQLite
 *   RETRACE_TOKEN    bearer token for the remote Worker
 *   RETRACE_PROJECT  default project name
 *   RETRACE_ACTOR    default actor id for this agent (e.g. "claude-code")
 *   RETRACE_ACTOR_MODEL default model string
 *   RETRACE_ON_BEHALF_OF the human this agent works for (e.g. jordan@...)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Actor, Action, ArtifactRef, Change, Location, Method, EventInput,
  appendEvent, verifyProject, explainEvent, renderTimeline, renderWhyChain, describeEvent,
} from "@retrace/core";
import { SqliteStore } from "./sqlite-store.js";
import { RemoteStore } from "./remote-store.js";

const env = process.env;
const DEFAULT_PROJECT = env.RETRACE_PROJECT ?? "default";
const defaultActor = {
  type: "agent" as const,
  id: env.RETRACE_ACTOR ?? "mcp-agent",
  model: env.RETRACE_ACTOR_MODEL,
  on_behalf_of: env.RETRACE_ON_BEHALF_OF,
};

export function makeStore() {
  if (env.RETRACE_URL) return new RemoteStore(env.RETRACE_URL, env.RETRACE_TOKEN);
  const path = env.RETRACE_DB ?? join(homedir(), ".retrace", "retrace.db");
  mkdirSync(join(path, ".."), { recursive: true });
  return new SqliteStore(path);
}

export function buildServer(store = makeStore()) {
  const server = new McpServer({ name: "retrace", version: "0.1.0" });
  const remote = store instanceof RemoteStore ? store : null;

  server.registerTool(
    "retrace_log",
    {
      title: "Log a provenance event",
      description:
        "Record WHO did WHAT to WHICH artifact(s), WHEN, WHERE, WHY and HOW. Call this after every meaningful action " +
        "(create/edit/delete/execute/approve/send). Returns the event id — pass it as caused_by on follow-up actions " +
        "so Retrace can reconstruct the causal chain back to the human instruction.",
      inputSchema: {
        project: z.string().optional().describe(`Project name (default: ${DEFAULT_PROJECT})`),
        action: Action.describe("Verb from the controlled vocabulary"),
        action_detail: z.string().optional().describe("Required when action=other; free-text verb"),
        artifacts: z.array(ArtifactRef).min(1).describe("Artifacts touched, e.g. {id:'repo:slcwitit/rpg#src/fight.ts', kind:'file'}"),
        intent: z.string().optional().describe("WHY: the reason for this action, in one sentence"),
        caused_by: z.string().optional().describe("Event id of the instruction/action that caused this one"),
        actor: Actor.partial().optional().describe("Override the default actor (defaults from env)"),
        change: Change.optional().describe("WHAT changed: summary, diff, before/after hashes"),
        location: Location.optional().describe("WHERE: path/url/environment/system"),
        method: Method.optional().describe("HOW: tool, instruction ref, params, tokens/cost"),
        timestamp: z.string().optional().describe("ISO 8601; defaults to now"),
        idempotency_key: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const input = EventInput.parse({
        ...args,
        project: args.project ?? DEFAULT_PROJECT,
        actor: { ...defaultActor, ...(args.actor ?? {}) },
      });
      const { event, deduped } = remote ? await remote.append(input) : await appendEvent(store, input);
      return {
        content: [{ type: "text", text: `${deduped ? "(deduped) " : ""}logged ${event.id} seq=${event.seq}\n${describeEvent(event)}` }],
        structuredContent: { id: event.id, seq: event.seq, hash: event.hash, deduped },
      };
    },
  );

  server.registerTool(
    "retrace_instruct",
    {
      title: "Log a human instruction",
      description:
        "Shortcut to record that a human gave an instruction (the root of a causal chain). Use at the start of a task " +
        "with the user's request. Returns an event id to use as caused_by for the work that follows.",
      inputSchema: {
        project: z.string().optional(),
        human_id: z.string().describe("Who gave the instruction (email or name)"),
        instruction: z.string().describe("The instruction text (or a faithful summary)"),
        artifacts: z.array(ArtifactRef).optional().describe("What the instruction is about; defaults to a task artifact"),
      },
    },
    async (args) => {
      const input = EventInput.parse({
        project: args.project ?? DEFAULT_PROJECT,
        actor: { type: "human", id: args.human_id },
        action: "instructed",
        artifacts: args.artifacts ?? [{ id: `task:${args.instruction.slice(0, 60)}`, kind: "task", label: args.instruction.slice(0, 60) }],
        intent: args.instruction,
        method: { tool: "chat", automated: false },
      });
      const { event } = remote ? await remote.append(input) : await appendEvent(store, input);
      return { content: [{ type: "text", text: `instruction logged ${event.id}` }], structuredContent: { id: event.id } };
    },
  );

  server.registerTool(
    "retrace_history",
    {
      title: "Retrace history",
      description: "Timeline of events for a project, optionally filtered by artifact, actor, action, time range or text.",
      inputSchema: {
        project: z.string().optional(),
        artifact_id: z.string().optional(),
        actor_id: z.string().optional(),
        actor_type: z.enum(["human", "agent", "system"]).optional(),
        action: Action.optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        text: z.string().optional().describe("substring match across the event"),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async (args) => {
      const events = await store.history({ ...args, project: args.project ?? DEFAULT_PROJECT });
      return { content: [{ type: "text", text: renderTimeline(events) }], structuredContent: { count: events.length, events } };
    },
  );

  server.registerTool(
    "retrace_why",
    {
      title: "Explain why an event happened",
      description: "Follow caused_by links from an event back to the originating human instruction.",
      inputSchema: { event_id: z.string() },
    },
    async ({ event_id }) => {
      const chain = await explainEvent(store, event_id);
      if (!chain.length) return { content: [{ type: "text", text: `no event ${event_id}` }], isError: true };
      return { content: [{ type: "text", text: renderWhyChain(chain) }], structuredContent: { chain } };
    },
  );

  server.registerTool(
    "retrace_verify",
    {
      title: "Verify chain integrity",
      description: "Recompute the hash chain for a project and report whether history is intact.",
      inputSchema: { project: z.string().optional() },
    },
    async ({ project }) => {
      const p = project ?? DEFAULT_PROJECT;
      const r = remote ? await remote.verify(p) : await verifyProject(store, p);
      return {
        content: [{ type: "text", text: r.ok ? `OK — ${r.checked} events verified for '${p}'` : `BROKEN at seq ${r.first_bad_seq}: ${r.reason}` }],
        structuredContent: { ...r },
      };
    },
  );

  server.registerTool(
    "retrace_projects",
    { title: "List projects", description: "List projects that have events.", inputSchema: {} },
    async () => {
      const ps = await store.projects();
      return { content: [{ type: "text", text: ps.join("\n") || "(none)" }], structuredContent: { projects: ps } };
    },
  );

  return server;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
