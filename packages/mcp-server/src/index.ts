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
 *   RETRACE_SESSION  override location.session (default: CLAUDE_CODE_SESSION_ID or GROK_SESSION_ID, else a run id)
 *   RETRACE_DEVICE   override location.device (default: os.hostname() — an opt-out, since a hostname is sealed into
 *                    hash-covered bodies that share links serve pre-auth and no later redaction is possible)
 *   RETRACE_IDE / RETRACE_WORKSPACE  override location.ide / location.workspace (default: detected from the IDE's own
 *                    environment — Orca's ORCA_PANE_KEY / ORCA_WORKTREE_ID; nothing is guessed)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Actor, Action, ArtifactRef, Change, Location, Method, EventInput, applyDefaultRoles,
  appendEvent, CausedByError, causedByProblem, causedByErrorMessage,
  verifyProject, explainEvent, renderTimeline, renderWhyChain, describeEvent,
  buildExportBundle, verifyExportBundle, renderReportHtml, parseSigningKey, publicFromPrivate, newShareId,
  buildLineage, renderLineageDot, renderLineageMermaid, renderLineageText,
  buildProjectStatus, renderProjectStatus,
  AMENDMENT_ACTION_DETAIL, causalRootState, collectProvenanceAmendments,
} from "@retrace-dev/core";
import { writeFileSync } from "node:fs";
import { ensureSigningKey } from "./keys.js";
import { SqliteStore } from "./sqlite-store.js";
import { RemoteStore } from "./remote-store.js";
import { isMainModule } from "./is-main.js";

const env = process.env;
const DEFAULT_PROJECT = env.RETRACE_PROJECT ?? "default";
/** Read at buildServer() time (not module load) so tests and embedders can configure it via env before building. */
const readDefaultActor = () => ({
  type: "agent" as const,
  id: env.RETRACE_ACTOR ?? "mcp-agent",
  model: env.RETRACE_ACTOR_MODEL,
  on_behalf_of: env.RETRACE_ON_BEHALF_OF,
});

/** Location keys only the server may set. These are evidence ABOUT the writer — which session and machine produced
 *  the event, which client and IDE it came from, whether a human was at a keyboard — so a caller that could assert
 *  them could forge the very thing they exist to prove. Same reasoning that produced RETRACE_ACTOR_LOCK (security
 *  review 2026-08-21). The caller keeps `path`/`url`/`environment`, which it genuinely knows better than the server. */
const SERVER_ONLY: readonly string[] = ["session", "device", "client", "ide", "workspace", "surface"];

/** WHERE enrichment for the MCP write path (backlog #15): fill each location field from `defaults` ONLY where the
 *  caller supplied nothing — a caller value is never overwritten, except for SERVER_ONLY keys, which are dropped
 *  rather than merged. Exported for unit tests. */
export function enrichLocation(caller: Location | undefined, defaults: Location): Location {
  const merged: Location = { ...defaults };
  for (const [k, v] of Object.entries(caller ?? {}))
    if (v !== undefined && !SERVER_ONLY.includes(k)) (merged as any)[k] = v;
  return merged;
}

/** MCP client name (from the `initialize` handshake) → the `system` slug Retrace uses for it. An unmapped name is
 *  slugged rather than dropped: it is still better evidence than the hardcoded "claude-code" every client used to get. */
const CLIENT_SYSTEM = new Map<string, string>([
  ["claude-code", "claude-code"],
  ["claude-ai", "claude-desktop"],
  ["cursor-vscode", "cursor"],
  ["Visual Studio Code", "vscode"],
  ["grok-cli", "grok"],
  ["grok", "grok"],
  // Measured 2026-08-29 against Grok Build TUI 1.0.13: initialize.name is "grok-shell-retrace".
  ["grok-shell-retrace", "grok"],
  ["gemini-cli", "gemini-cli"],
]);
export function clientSystem(name: string): string {
  // A Map, not an object literal: the client picks this name in the handshake, and an object would resolve
  // "constructor"/"toString" through Object.prototype and return a function, which then fails Location's zod parse.
  return CLIENT_SYSTEM.get(name) ?? (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown");
}

/** IDE / agent-development environment hosting this agent, read from the environment that IDE injects into the pane it
 *  launches. Orca (onorca.dev) sets ORCA_PANE_KEY / ORCA_TAB_ID / ORCA_WORKTREE_ID / ORCA_TERMINAL_HANDLE on every
 *  agent pane; ORCA_WORKTREE_ID is the one that earns its place, because Orca's premise is N agents in N isolated
 *  worktrees and without it their event streams are indistinguishable. Nothing is guessed — an IDE that does not name
 *  itself in the environment gets no `ide`, and `location.client` already identifies VS Code / Cursor / Claude Desktop
 *  from the MCP handshake. Orca's bin directory being on PATH is NOT taken as evidence: that only means it is installed.
 *  WSL caveat: Orca sets these Windows-side and forwards only HISTFILE and the git-credential vars through WSLENV, so
 *  they do not reach a WSL pane unless WSLENV names them (see README). */
export function detectIde(env: NodeJS.ProcessEnv): Pick<Location, "ide" | "workspace"> {
  const orca = env.ORCA_PANE_KEY || env.ORCA_WORKTREE_ID || env.ORCA_TERMINAL_HANDLE;
  return {
    ide: env.RETRACE_IDE ?? (orca ? "orca" : undefined),
    workspace: env.RETRACE_WORKSPACE ?? env.ORCA_WORKTREE_ID,
  };
}

/** Harness session id when one is exposed. MCP and the live git hook must read the same keys so a commit joins the
 *  events that produced it. No fallback: absence is what makes the key discriminating (a human `git commit` has none). */
export function harnessSession(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.RETRACE_SESSION ?? env.CLAUDE_CODE_SESSION_ID ?? env.GROK_SESSION_ID;
}

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
  /** location.session: the harness's own session id when it exposes one, else a per-process run id (RETRACE_SESSION
   *  overrides both). Claude Code passes CLAUDE_CODE_SESSION_ID down to MCP subprocesses — verified 2026-08-27 against
   *  this server's own /proc/<pid>/environ under 2.1.250 — and Grok Build TUI exports GROK_SESSION_ID the same way.
   *  That shared env is what makes the id SHARED with the git hook: the same string lands on the agent's events and
   *  on the commits it drives, so `retrace_why` can walk between them. Two honest limits, both deliberate: a process
   *  environment is frozen at exec, so a session id re-minted mid-process is not seen until the server is respawned;
   *  and subagents inherit it, so this is a session key, not a per-run key. The random fallback stays for MCP clients
   *  that expose no session at all. */
  const sessionId = harnessSession(env) ?? "run_" + randomUUID().replace(/-/g, "").slice(0, 12);
  /** WHERE this server authoritatively knows (backlog #15). Evaluated per write rather than once, because the MCP
   *  client's identity only exists after the `initialize` handshake — which happens after buildServer() has returned.
   *  `url` is never stamped and no prod environment is synthesized — commit URLs and deploy environments belong to the
   *  git hook / Worker. `surface` is not stamped here either: an MCP subprocess is a harness child by construction, so
   *  the value would be the constant "agent" — hash bytes carrying no information. `system` follows the real client
   *  (a Cursor event used to be labelled "claude-code"); RETRACE_SYSTEM still overrides. */
  const locationDefaults = (): Location => {
    const ci = server.server.getClientVersion();
    return {
      system: env.RETRACE_SYSTEM ?? (ci ? clientSystem(ci.name) : "claude-code"),
      environment: env.RETRACE_ENVIRONMENT ?? env.RETRACE_ENV ?? "local",
      path: process.cwd(),
      device: env.RETRACE_DEVICE ?? hostname(),
      session: sessionId,
      client: ci ? `${ci.name}@${ci.version}` : undefined,
      ...detectIde(env),
    };
  };
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
      // A configured model stays authoritative. When it is deliberately unpinned, accept the runtime model reported
      // by the agent client; the credential and actor lock still control id/type/on_behalf_of. This lets clients such
      // as Gemini CLI switch models without sealing stale attribution into the ledger.
      ...(defaultActor.model === undefined && callerActor?.model !== undefined ? { model: callerActor.model } : {}),
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
        artifacts: z.array(ArtifactRef).min(1).describe(
          "Artifacts touched, e.g. {id:'repo:my-app#src/main.ts', kind:'file', role:'both'}. role (PROV) = 'used' (input), " +
          "'generated' (output) or 'both'. Omit it and the verb decides: read → used; created → generated; edited/moved/renamed → both; " +
          "executed/sent/received/approved/rejected → used; deleted/other → unspecified. Always set role explicitly for OUTPUTS of an " +
          "executed/sent action (a deployment, a report, a message) — the default treats those refs as inputs.",
        ),
        intent: z.string().optional().describe("WHY: the reason for this action, in one sentence"),
        caused_by: z.string().optional().describe("Event id of the instruction/action that caused this one. Must name an existing same-project event; a dangling or cross-project id is rejected so the agent can fix and retry. Adapters (git hook, Drive) keep the link and mark it unverified instead."),
        actor: Actor.partial().optional().describe("Override the default actor (defaults from env)"),
        change: Change.optional().describe("WHAT changed: summary, diff, before/after hashes"),
        location: Location.optional().describe("WHERE: path/url/environment/system. session/device/client/ide/workspace/surface are stamped by the server and ignored if you send them."),
        method: Method.optional().describe("HOW: tool, instruction ref, params, tokens/cost"),
        timestamp: z.string().optional().describe("ISO 8601; defaults to now"),
        idempotency_key: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      guardAction(args.action);
      const actor = resolveActor(args.actor); // actor lock first — a rejected write must not get this far
      // WHERE enrichment (backlog #15) and PROV role fill-absent: after the actor lock, before sealing (local appendEvent
      // or the Worker's POST /events). A caller-supplied role is never overwritten; refs whose verb has no default stay absent.
      const input = EventInput.parse({
        ...args,
        project: writeProject(args.project),
        actor,
        artifacts: applyDefaultRoles(args.action, args.artifacts),
        location: enrichLocation(args.location, locationDefaults()),
      });
      if (input.caused_by) {
        const parent = await store.get(input.caused_by);
        const problem = causedByProblem(parent, input);
        if (problem) throw new CausedByError(causedByErrorMessage(input.caused_by, problem, { parentProject: parent?.project, project: input.project }));
      }
      const { event, deduped } = remote ? await remote.append(input) : await appendEvent(store, input);
      return {
        content: [{ type: "text", text: `${deduped ? "(deduped) " : ""}logged ${event.id} seq=${event.seq}\n${describeEvent(event)}` }],
        structuredContent: { id: event.id, seq: event.seq, hash: event.hash, deduped },
      };
    },
  );

  server.registerTool(
    "retrace_amend",
    {
      title: "Append a provenance amendment",
      description: "Correct missing metadata without modifying a sealed event. The amendment must be rooted in a human instruction; status then reports the original gap as amended while chain history remains intact.",
      inputSchema: {
        project: z.string().optional(),
        target_event_id: z.string().describe("Existing sealed event being qualified"),
        artifact_roles: z.array(z.object({ index: z.number().int().nonnegative(), role: z.enum(["used", "generated", "both"]) })).optional().describe("Roles for zero-based artifact indexes whose original role is absent"),
        attest_causal_root: z.boolean().optional().describe("Attest that an otherwise unlinked historical event was performed under human direction"),
        reason: z.string().min(1).describe("Evidence-based explanation for the correction"),
        caused_by: z.string().describe("Human instruction (or rooted follow-up) authorizing this amendment"),
        actor: Actor.partial().optional().describe("Runtime model may be supplied when the configured actor has no pinned model"),
      },
    },
    async (args) => {
      const project = writeProject(args.project);
      const actor = resolveActor(args.actor);
      const target = await store.get(args.target_event_id);
      if (!target || target.project !== project) throw new Error(`target event "${args.target_event_id}" does not exist in project "${project}"`);
      const all = await store.all(project);
      const byId = new Map(all.map((e) => [e.id, e]));
      const cause = byId.get(args.caused_by);
      if (!cause || causalRootState(cause, byId) !== "rooted") throw new Error("caused_by must name an event rooted in a human instruction");
      const prior = collectProvenanceAmendments(all, (e) => causalRootState(e, byId) === "rooted").get(target.id) ?? [];
      const alreadyRole = new Set(prior.flatMap((a) => [...a.artifact_roles.keys()]));
      if (args.attest_causal_root === true && prior.some((a) => a.attest_causal_root)) throw new Error(`target event ${target.id} already has a rooted causal attestation`);
      const seen = new Set<number>();
      const roles = (args.artifact_roles ?? []).map(({ index, role }) => {
        if (seen.has(index)) throw new Error(`artifact index ${index} is repeated`);
        seen.add(index);
        const artifact = target.artifacts[index];
        if (!artifact) throw new Error(`artifact index ${index} is outside target event ${target.id}`);
        if (artifact.role !== undefined) throw new Error(`artifact index ${index} already has role "${artifact.role}"; amendments only supply absent metadata`);
        if (alreadyRole.has(index)) throw new Error(`artifact index ${index} already has a rooted role amendment`);
        return { index, role };
      });
      if (!roles.length && args.attest_causal_root !== true) throw new Error("amendment must supply at least one artifact role or attest_causal_root=true");
      const input = EventInput.parse({
        project,
        actor,
        action: "other",
        action_detail: AMENDMENT_ACTION_DETAIL,
        artifacts: [{ id: `event:${target.id}`, kind: "event", label: `amends event #${target.seq}`, role: "used" }],
        intent: args.reason,
        caused_by: args.caused_by,
        method: { tool: "retrace_amend", automated: false, params: { target_event_id: target.id, artifact_roles: roles, attest_causal_root: args.attest_causal_root === true } },
        location: enrichLocation(undefined, locationDefaults()),
        idempotency_key: `amend:${target.id}:${JSON.stringify(roles)}:${args.attest_causal_root === true}`,
        tags: ["amendment"],
      });
      const { event, deduped } = remote ? await remote.append(input) : await appendEvent(store, input);
      return { content: [{ type: "text", text: `${deduped ? "(deduped) " : ""}amended ${target.id} with ${event.id}` }], structuredContent: { id: event.id, target_event_id: target.id, deduped } };
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
        artifacts: z.array(ArtifactRef).optional().describe("What the instruction is about; defaults to a task artifact (role generated). Supplied refs keep whatever role you give them — an instruction is about a file, it does not generate it."),
        timestamp: z.string().optional().describe("ISO 8601; defaults to now"),
      },
    },
    async (args) => {
      const actor = resolveHuman(args.human_id); // actor lock first
      const input = EventInput.parse({
        project: writeProject(args.project),
        actor,
        action: "instructed",
        // PROV role: the instruction brings its task into being (generated). Caller-supplied refs are stored as given —
        // the instruction is ABOUT them, so no default is applied (absent = unspecified).
        artifacts: args.artifacts ?? [{ id: `task:${args.instruction.slice(0, 60)}`, kind: "task", label: args.instruction.slice(0, 60), role: "generated" as const }],
        intent: args.instruction,
        timestamp: args.timestamp,
        method: { tool: "chat", automated: false },
        // WHERE enrichment (backlog #15): env-only — retrace_instruct deliberately has no caller-facing location param.
        location: enrichLocation(undefined, locationDefaults()),
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
    "retrace_status",
    {
      title: "Project transparency status",
      description: "One canonical view of chain integrity, causal coverage, capture gaps, actors, and integration freshness for humans and agents.",
      inputSchema: { project: z.string().optional() },
    },
    async ({ project }) => {
      const p = project ?? DEFAULT_PROJECT;
      const status = remote ? await remote.status(p) : await buildProjectStatus(store, p);
      return { content: [{ type: "text", text: renderProjectStatus(status) }], structuredContent: { status } };
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
      // Verify against a trusted key, not the one the bundle carries: locally that is our own signing key; for a
      // remote server it is the key published at /.well-known/retrace-pubkey (https only). Otherwise "self_attested".
      let trustedKey: JsonWebKey | undefined;
      if (!remote) { const k = parseSigningKey(env.RETRACE_SIGNING_KEY) ?? (await ensureSigningKey()).privateKey; trustedKey = publicFromPrivate(k); }
      else if (/^https:/i.test(env.RETRACE_URL ?? "")) {
        try { const wk: any = await (await fetch(env.RETRACE_URL!.replace(/\/+$/, "") + "/.well-known/retrace-pubkey")).json(); if (wk?.public_key?.x) trustedKey = wk.public_key; } catch {}
      }
      const verdict = await verifyExportBundle(bundle, trustedKey);
      if (args.out_json) writeFileSync(args.out_json, JSON.stringify(bundle, null, 2));
      if (args.out_html) writeFileSync(args.out_html, renderReportHtml(bundle, verdict));
      const summary = `${bundle.events.length} events · chain ${bundle.chain.ok ? "intact" : "BROKEN"} · signature ${verdict.signature}${bundle.issuer ? " (kid " + bundle.issuer.kid + ")" : ""} · coverage ${verdict.coverage.scope === "full" ? (verdict.coverage.complete ? "complete" : "INCOMPLETE") : "scoped"} (${verdict.coverage.events}/${verdict.coverage.total_events})` +
        (args.out_json ? `\njson → ${args.out_json}` : "") + (args.out_html ? `\nreport → ${args.out_html}` : "");
      return { content: [{ type: "text", text: summary }], structuredContent: { events: bundle.events.length, chain_ok: bundle.chain.ok, signature: verdict.signature, coverage: verdict.coverage, kid: bundle.issuer?.kid, ...(args.out_json || args.out_html ? {} : { bundle }) } };
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

if (isMainModule(import.meta.url)) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
