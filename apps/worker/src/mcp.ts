import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { registerAuditMcpTools, type AuditMcpHandlers } from "@retrace-dev/cli/audit-mcp";
import {
  applyDefaultRoles,
  buildExportBundle,
  buildLineage,
  buildProjectStatus,
  describeEvent,
  explainEvent,
  parseCredentials,
  parseSigningKey,
  publicFromPrivate,
  renderLineageDot,
  renderLineageMermaid,
  renderLineageText,
  renderProjectStatus,
  renderTimeline,
  renderWhyChain,
  tokenEquals,
  verifyExportBundle,
  verifyProject,
  type Actor,
  type Credential,
  type Event,
  type EventInput as EventInputType,
  type EventStore,
  type Location,
} from "@retrace-dev/core";

export const RETRACE_MCP_MAX_BODY_BYTES = 128 * 1024;

export interface RemoteMcpEnv {
  RETRACE_MCP_ENABLED?: string;
  RETRACE_CREDENTIALS?: string;
  RETRACE_SIGNING_KEY?: string;
  RETRACE_ISSUER?: string;
  RETRACE_PUBLIC_URL?: string;
}

type RemoteMcpCredential = Credential & {
  trust: "pinned";
  actor: Actor & { type: "agent" };
  projects: [string];
};

const jsonError = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Remote MCP deliberately accepts fewer credentials than the REST API: bearer-only, pinned agent, one project. */
export async function authenticateRemoteMcp(req: Request, rawCredentials?: string): Promise<RemoteMcpCredential | null> {
  const match = /^Bearer ([^\s]+)$/.exec(req.headers.get("authorization") ?? "");
  if (!match) return null;
  for (const credential of parseCredentials(rawCredentials)) {
    if (
      credential.trust === "pinned" &&
      credential.actor.type === "agent" &&
      credential.projects?.length === 1 &&
      credential.require_signature !== true &&
      await tokenEquals(match[1], credential.token)
    ) return credential as RemoteMcpCredential;
  }
  return null;
}

function requirePinnedProject(requested: string | undefined, credential: RemoteMcpCredential): string {
  const project = credential.projects[0];
  if (requested !== undefined && requested !== project)
    throw new Error(`project "${requested}" is not allowed: this MCP credential is pinned to project "${project}". Omit project or pass "${project}".`);
  return project;
}

function pinnedActor(caller: Partial<Actor> | undefined, credential: RemoteMcpCredential): Actor {
  if (caller?.type === "human" || caller?.type === "system")
    throw new Error(`actor.type "${caller.type}" is not allowed: this MCP credential records agent "${credential.actor.id}"`);
  return {
    ...credential.actor,
    ...(credential.actor.model === undefined && caller?.model !== undefined ? { model: caller.model } : {}),
    ...(caller?.display_name !== undefined ? { display_name: caller.display_name } : {}),
    ...(caller?.version !== undefined ? { version: caller.version } : {}),
  };
}

function remoteLocation(caller: Location | undefined, credential: RemoteMcpCredential, requestUrl: string): Location {
  return {
    path: caller?.path,
    environment: "remote-mcp",
    system: credential.actor.id,
    url: requestUrl,
    surface: "agent",
  };
}

function textResult(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], ...(structuredContent ? { structuredContent } : {}) };
}

export function buildRemoteMcpServer(
  store: EventStore,
  credential: RemoteMcpCredential,
  opts: { requestUrl: string; signingKey?: JsonWebKey | null; issuerName?: string; apiHandler: (request: Request) => Promise<Response> },
): McpServer {
  const project = credential.projects[0];
  const apiJson = async (path: string, init?: RequestInit) => {
    const response = await opts.apiHandler(new Request(new URL(path, opts.requestUrl), {
      ...init,
      headers: { authorization: `Bearer ${credential.token}`, ...(init?.body ? { "content-type": "application/json" } : {}) },
    }));
    const body = await response.json() as any;
    if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `Retrace API request failed (${response.status})`);
    return body;
  };
  const appendThroughApi = async (input: EventInputType) =>
    await apiJson("/events", { method: "POST", body: JSON.stringify(input) }) as { event: Event; deduped: boolean };
  const handlers: AuditMcpHandlers = {
    async log(args) {
      if (args.action === "committed") throw new Error('action "committed" is reserved for the git hook');
      const input: EventInputType = {
        ...args,
        project: requirePinnedProject(args.project, credential),
        actor: pinnedActor(args.actor, credential),
        artifacts: applyDefaultRoles(args.action, args.artifacts),
        location: remoteLocation(args.location, credential, opts.requestUrl),
      };
      const { event, deduped } = await appendThroughApi(input);
      return textResult(`${deduped ? "(deduped) " : ""}logged ${event.id} seq=${event.seq}\n${describeEvent(event)}`, {
        id: event.id, seq: event.seq, hash: event.hash, deduped,
      });
    },

    async instruct(args) {
      requirePinnedProject(args.project, credential);
      const human = credential.actor.on_behalf_of;
      if (!human || args.human_id !== human)
        throw new Error(`human_id "${args.human_id}" is not allowed: this MCP credential may only attribute instructions to its configured on_behalf_of identity`);
      const input: EventInputType = {
        project,
        actor: { type: "human", id: human },
        action: "instructed",
        artifacts: args.artifacts ?? [{ id: `task:${args.instruction.slice(0, 60)}`, kind: "task", label: args.instruction.slice(0, 60), role: "generated" }],
        intent: args.instruction,
        timestamp: args.timestamp,
        method: { tool: "chat", automated: false },
        location: remoteLocation(undefined, credential, opts.requestUrl),
      };
      const { event } = await appendThroughApi(input);
      return textResult(`instruction logged ${event.id}`, { id: event.id });
    },

    async history(args) {
      const p = requirePinnedProject(args.project, credential);
      const page = await store.history({ ...args, project: p });
      const note = page.truncated ? `\n\ntruncated — ${page.events.length} newest matching events; pass before_seq ${page.next_before_seq} for the previous page` : "";
      return textResult(renderTimeline(page.events) + note, { count: page.events.length, events: page.events, truncated: page.truncated, next_before_seq: page.next_before_seq });
    },

    async why({ event_id }) {
      const first = await store.get(event_id);
      if (!first || first.project !== project) return { ...textResult(`no event ${event_id}`), isError: true };
      const chain = await explainEvent(store, event_id);
      return textResult(renderWhyChain(chain), { chain });
    },

    async status(args) {
      const p = requirePinnedProject(args.project, credential);
      const status = await buildProjectStatus(store, p);
      return textResult(renderProjectStatus(status), { status });
    },

    async verify(args) {
      const p = requirePinnedProject(args.project, credential);
      const result = await verifyProject(store, p);
      return textResult(result.ok ? `OK — ${result.checked} events verified for '${p}'` : `BROKEN at seq ${result.first_bad_seq}: ${result.reason}`, { ...result });
    },

    async export(args) {
      const p = requirePinnedProject(args.project, credential);
      const query = args.artifact_id ? `?artifact_id=${encodeURIComponent(args.artifact_id)}` : "";
      const bundle = await apiJson(`/projects/${encodeURIComponent(p)}/export${query}`);
      const verdict = await verifyExportBundle(bundle, opts.signingKey ? publicFromPrivate(opts.signingKey) : undefined);
      const summary = `${bundle.events.length} events · chain ${bundle.chain.ok ? "intact" : "BROKEN"} · signature ${verdict.signature} · coverage ${verdict.coverage.scope === "full" ? (verdict.coverage.complete ? "complete" : "INCOMPLETE") : "scoped"} (${verdict.coverage.events}/${verdict.coverage.total_events})`;
      return textResult(summary, { events: bundle.events.length, chain_ok: bundle.chain.ok, signature: verdict.signature, coverage: verdict.coverage, kid: bundle.issuer?.kid, bundle });
    },

    async lineage(args) {
      const p = requirePinnedProject(args.project, credential);
      const events = args.artifact_id
        ? (await buildExportBundle(store, { project: p, artifact_id: args.artifact_id })).events
        : await store.all(p);
      const lineage = buildLineage(events, { includeActors: !!args.include_actors });
      const format = args.format ?? "text";
      const text = format === "dot" ? renderLineageDot(lineage) : format === "mermaid" ? renderLineageMermaid(lineage) : format === "json" ? JSON.stringify(lineage, null, 2) : renderLineageText(lineage);
      return textResult(text, { nodes: lineage.nodes.length, edges: lineage.edges.length, ...(format === "json" ? { lineage } : {}) });
    },

    async projects() {
      const visible = (await store.projects()).includes(project) ? [project] : [];
      return textResult(visible.join("\n") || "(none)", { projects: visible });
    },
  };

  const server = new McpServer({ name: "retrace-audit", version: "0.1.0" });
  registerAuditMcpTools(server, handlers, { defaultProject: project, allowFileOutputs: false });
  return server;
}

async function boundedRequest(req: Request): Promise<Request | Response> {
  if (req.method !== "POST") return req;
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RETRACE_MCP_MAX_BODY_BYTES) return jsonError(413, "MCP request body too large");
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > RETRACE_MCP_MAX_BODY_BYTES) return jsonError(413, "MCP request body too large");
  return new Request(req.url, { method: req.method, headers: req.headers, body: bytes });
}

export async function handleRemoteMcp(
  req: Request,
  env: RemoteMcpEnv,
  store: EventStore,
  apiHandler: (request: Request) => Promise<Response>,
): Promise<Response> {
  if (env.RETRACE_MCP_ENABLED !== "1") return jsonError(404, "not found");
  const expectedOrigin = new URL(env.RETRACE_PUBLIC_URL ?? req.url).origin;
  if (env.RETRACE_PUBLIC_URL && new URL(req.url).origin !== expectedOrigin) return jsonError(400, "invalid host");
  const origin = req.headers.get("origin");
  if (origin && origin !== expectedOrigin) return jsonError(403, "invalid origin");
  const credential = await authenticateRemoteMcp(req, env.RETRACE_CREDENTIALS);
  if (!credential) return jsonError(401, "invalid bearer credential");
  const bounded = await boundedRequest(req);
  if (bounded instanceof Response) return bounded;
  const signingKey = parseSigningKey(env.RETRACE_SIGNING_KEY) ?? undefined;
  const handler = createMcpHandler(
    () => buildRemoteMcpServer(store, credential, { requestUrl: req.url, signingKey, issuerName: env.RETRACE_ISSUER, apiHandler }),
    { legacy: "stateless" },
  );
  return handler.fetch(bounded);
}
