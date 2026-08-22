#!/usr/bin/env node
/**
 * Retrace MCP server — lets any MCP-capable agent (Claude Code, Claude Desktop, Cursor…)
 * log provenance events and retrace history.
 *
 * Config (env):
 *   RETRACE_DB       path to local SQLite file (default ~/.retrace/retrace.db)
 *   RETRACE_URL      if set, use the remote Worker instead of local SQLite
 *   RETRACE_TOKEN    bearer token for the remote Worker
 *   RETRACE_PROJECT  default project name; when set, WRITE tools (retrace_log/retrace_instruct) are pinned to it —
 *                    a different explicit project is rejected. Set RETRACE_PROJECT_LOCK=0 to allow any project.
 *   RETRACE_COMMIT_LOCK  action "committed" is reserved for the git hook; retrace_log rejects it. Set 0 to allow.
 *   RETRACE_ACTOR_LOCK   actor identity is authoritative from env: retrace_log rejects human/system actors and ignores
 *                    caller-supplied id/model/on_behalf_of; retrace_instruct only attributes to RETRACE_ON_BEHALF_OF.
 *                    Set 0 to allow caller overrides (backfill / trusted contexts only).
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
  buildExportBundle, verifyExportBundle, renderReportHtml, parseSigningKey, newShareId,
  buildLineage, renderLineageDot, renderLineageMermaid, renderLineageText,
} from "@retrace/core";
import { writeFileSync } from "node:fs";
import { ensureSigningKey } from "./keys.js";
import { SqliteStore } from "./sqlite-store.js";
import { RemoteStore } from "./remote-store.js";

const env = process.env;
const DEFAULT_PROJECT = env.RETRACE_PROJECT ?? "default";
/** Read at buildServer() time (not module load) so tests and embedders can configure it via env before building. */
const readDefaultActor = () => ({
  type: "agent" as const,
  id: env.RETRACE_ACTOR ?? "mcp-agent",
  model: env.RETRACE_ACTOR_MODEL,
  on_behalf_of: env.RETRACE_ON_BEHALF_OF,
});

export function makeStore() {
  if (env.RETRACE_URL) return new RemoteStore(env.RETRACE_URL, env.RETRACE_TOKEN);
  const path = env.RETRACE_DB ?? join(homedir(), ".retrace", "retrace.db");
  mkdirSync(join(path, ".."), { recursive: true });
  return new SqliteStore(path);
}

export function buildServer(store = makeStore(), opts: { pinnedProject?: string; lock?: boolean; commitLock?: boolean; actorLock?: boolean } = {}) {
  const server = new McpServer({ name: "retrace", version: "0.1.0" });
  const remote = store instanceof RemoteStore ? store : null;
  const pinned = opts.pinnedProject ?? env.RETRACE_PROJECT;
  const lock = opts.lock ?? env.RETRACE_PROJECT_LOCK !== "0";
  const commitLock = opts.commitLock ?? env.RETRACE_COMMIT_LOCK !== "0";
  const actorLock = opts.actorLock ?? env.RETRACE_ACTOR_LOCK !== "0";
  const defaultActor = readDefaultActor();
  /** Resolve the project for a WRITE. If RETRACE_PROJECT is set (and lock on), any other explicit project is rejected
   *  so agents can't create stray projects by guessing a name. Read tools are not pinned. */
  const writeProject = (requested?: string): string => {
    const p = requested ?? pinned ?? DEFAULT_PROJECT;
    if (lock && pinned && p !== pinned)
      throw new Error(`project "${p}" is not allowed: this Retrace MCP server is pinned to project "${pinned}" (RETRACE_PROJECT). Omit project or pass "${pinned}". Set RETRACE_PROJECT_LOCK=0 to disable pinning.`);
    return p;
  };
  /** "committed" events come only from the git post-commit hook — an agent logging one describes a commit it may not
   *  have made and misattributes it (this happened 2026-08-19). */
  const guardAction = (action: string): void => {
    if (commitLock && action === "committed")
      throw new Error(`action "committed" is reserved for the git hook, which already records every real commit with the correct actor. Log your work as "edited" or "decided" and reference the commit id in the artifact ids instead. Set RETRACE_COMMIT_LOCK=0 to override.`);
  };
  const ACTOR_LOCK_HINT = "Set RETRACE_ACTOR_LOCK=0 to override.";
  /** Actor for a retrace_log WRITE (security review 2026-08-21, findings A1 + B4). With the lock on, this server only
   *  ever logs as its configured agent: human/system actors are refused outright, and id/model/on_behalf_of come from
   *  env — the caller may only decorate with display_name/version. Known limitation: cross-actor assertion (e.g. a
   *  "claude-cowork" event from a server configured as "claude-code") now needs the escape hatch; the credentialed
   *  per-actor version is backlog #6. */
  const resolveActor = (callerActor?: Partial<Actor>): Actor => {
    if (!actorLock) {
      return (callerActor?.type && callerActor.type !== "agent" ? callerActor : { ...defaultActor, ...(callerActor ?? {}) }) as Actor;
    }
    if (callerActor?.type === "human" || callerActor?.type === "system")
      throw new Error(`actor.type "${callerActor.type}" is not allowed: this Retrace MCP server logs as its configured agent ("${defaultActor.id}"). Human instructions go through retrace_instruct; other human/system actors need the git hook or a credentialed context. ${ACTOR_LOCK_HINT}`);
    return {
      ...defaultActor,
      ...(callerActor?.display_name !== undefined ? { display_name: callerActor.display_name } : {}),
      ...(callerActor?.version !== undefined ? { version: callerActor.version } : {}),
    };
  };
  /** Human actor for retrace_instruct. With the lock on, this server may only speak for its configured human. */
  const resolveHuman = (humanId: string): Actor => {
    if (actorLock) {
      const configured = env.RETRACE_ON_BEHALF_OF;
      if (!configured)
        throw new Error(`retrace_instruct cannot attribute an instruction to "${humanId}": RETRACE_ON_BEHALF_OF is not configured for this Retrace MCP server. Set it to the human this agent works for. ${ACTOR_LOCK_HINT}`);
      if (humanId !== configured)
        throw new Error(`human_id "${humanId}" is not allowed: this Retrace MCP server can only record instructions from its configured human ("${configured}", RETRACE_ON_BEHALF_OF), not an arbitrary one. ${ACTOR_LOCK_HINT}`);
    }
    return { type: "human", id: humanId };
  };

  server.registerTool(
    "retrace_log",
    {
      title: "Log a provenance event",
      description:
        "Record WHO did WHAT to WHICH artifact(s), WHEN, WHERE, WHY and HOW. Call this after every meaningful action " +
        "(create/edit/delete/execute/approve/send). Returns the event id — pass it as caused_by on follow-up actions " +
        "so Retrace can reconstruct the causal chain back to the human instruction.",
      inputSchema: {
        project: z.string().optional().describe(`Project name (default: ${DEFAULT_PROJECT}). Omit it — the server pins writes to RETRACE_PROJECT and rejects other names.`),
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
      guardAction(args.action);
      const input = EventInput.parse({
        ...args,
        project: writeProject(args.project),
        actor: resolveActor(args.actor),
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
        timestamp: z.string().optional().describe("ISO 8601; defaults to now"),
      },
    },
    async (args) => {
      const input = EventInput.parse({
        project: writeProject(args.project),
        actor: resolveHuman(args.human_id),
        action: "instructed",
        artifacts: args.artifacts ?? [{ id: `task:${args.instruction.slice(0, 60)}`, kind: "task", label: args.instruction.slice(0, 60) }],
        intent: args.instruction,
        timestamp: args.timestamp,
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
    "retrace_export",
    {
      title: "Signed provenance export",
      description:
        "Build a signed (Ed25519) provenance bundle for a project or one artifact — the 'Prove' step. Optionally writes the JSON " +
        "and a printable HTML report to disk. Anyone can verify the bundle offline with `retrace-export verify`.",
      inputSchema: {
        project: z.string().optional(),
        artifact_id: z.string().optional().describe("Limit to one artifact (e.g. repo:rpg#src/fight.ts)"),
        out_json: z.string().optional().describe("Path to write the signed JSON bundle"),
        out_html: z.string().optional().describe("Path to write the printable HTML report (open → Print → Save as PDF)"),
      },
    },
    async (args) => {
      const project = args.project ?? DEFAULT_PROJECT;
      const bundle = remote
        ? await remote.export({ project, artifact_id: args.artifact_id })
        : await buildExportBundle(store, { project, artifact_id: args.artifact_id }, { signingKey: parseSigningKey(env.RETRACE_SIGNING_KEY) ?? (await ensureSigningKey()).privateKey, issuerName: env.RETRACE_ISSUER });
      const verdict = await verifyExportBundle(bundle);
      if (args.out_json) writeFileSync(args.out_json, JSON.stringify(bundle, null, 2));
      if (args.out_html) writeFileSync(args.out_html, renderReportHtml(bundle, verdict));
      const summary = `${bundle.events.length} events · chain ${bundle.chain.ok ? "intact" : "BROKEN"} · signature ${verdict.signature}${bundle.issuer ? " (kid " + bundle.issuer.kid + ")" : ""}` +
        (args.out_json ? `\njson → ${args.out_json}` : "") + (args.out_html ? `\nreport → ${args.out_html}` : "");
      return { content: [{ type: "text", text: summary }], structuredContent: { events: bundle.events.length, chain_ok: bundle.chain.ok, signature: verdict.signature, kid: bundle.issuer?.kid, ...(args.out_json || args.out_html ? {} : { bundle }) } };
    },
  );

  server.registerTool(
    "retrace_share",
    {
      title: "Create read-only share link",
      description: "Create a public, read-only share link (timeline + verify + signed export + printable report) scoped to a project or one artifact.",
      inputSchema: {
        project: z.string().optional(),
        artifact_id: z.string().optional(),
        label: z.string().optional().describe("Shown as the report title, e.g. 'Jab counter — client review'"),
        expires_in_days: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      const project = args.project ?? DEFAULT_PROJECT;
      if (remote) {
        const r = await remote.share({ project, artifact_id: args.artifact_id, label: args.label, expires_in_days: args.expires_in_days });
        return { content: [{ type: "text", text: `${r.url}\nreport: ${r.url}/report` }], structuredContent: { ...r } };
      }
      const id = newShareId(); const now = new Date();
      const share = { id, project, artifact_id: args.artifact_id, label: args.label, created_at: now.toISOString(), expires_at: args.expires_in_days ? new Date(now.getTime() + args.expires_in_days * 86400000).toISOString() : undefined };
      await store.createShare(share);
      const base = env.RETRACE_PUBLIC_URL ?? `http://localhost:${env.RETRACE_PORT ?? 7777}`;
      const url = `${base}/s/${id}`;
      return { content: [{ type: "text", text: `${url}\nreport: ${url}/report\n(local links resolve while \`retrace-serve\` is running)` }], structuredContent: { share, url, report_url: `${url}/report` } };
    },
  );

  server.registerTool(
    "retrace_lineage",
    {
      title: "Artifact lineage graph",
      description:
        "Which artifacts came from which: explicit derived_from links plus causal flow (instruction → files touched → PR …). " +
        "Returns text by default; format=dot (Graphviz) or mermaid for diagrams; format=json for nodes/edges.",
      inputSchema: {
        project: z.string().optional(),
        artifact_id: z.string().optional().describe("Focus on one artifact (its events + causal ancestors)"),
        format: z.enum(["text", "dot", "mermaid", "json"]).optional(),
        include_actors: z.boolean().optional().describe("Add human/agent nodes with 'touched' edges"),
      },
    },
    async (args) => {
      const project = args.project ?? DEFAULT_PROJECT;
      const events = args.artifact_id
        ? (remote ? await remote.export({ project, artifact_id: args.artifact_id }) : await buildExportBundle(store, { project, artifact_id: args.artifact_id })).events
        : await store.all(project);
      const l = buildLineage(events, { includeActors: !!args.include_actors });
      const fmt = args.format ?? "text";
      const text = fmt === "dot" ? renderLineageDot(l) : fmt === "mermaid" ? renderLineageMermaid(l) : fmt === "json" ? JSON.stringify(l, null, 2) : renderLineageText(l);
      return { content: [{ type: "text", text }], structuredContent: { nodes: l.nodes.length, edges: l.edges.length, ...(fmt === "json" ? { lineage: l } : {}) } };
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
