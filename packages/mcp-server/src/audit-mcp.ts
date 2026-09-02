/**
 * Transport-neutral Retrace audit tool surface.
 *
 * This module deliberately imports no Node-only APIs. The stdio CLI and the
 * Cloudflare Worker Streamable HTTP endpoint register the same schemas here,
 * while their handlers supply environment-specific storage and authorization.
 */
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

export const AuditActor = z.object({
  type: z.enum(["human", "agent", "system"]).optional(),
  id: z.string().min(1).optional(),
  display_name: z.string().optional(),
  model: z.string().optional(),
  version: z.string().optional(),
  on_behalf_of: z.string().optional(),
});

const Action = z.enum([
  "created", "edited", "deleted", "read", "executed", "approved", "rejected",
  "sent", "received", "moved", "renamed", "instructed", "committed", "merged", "other",
]);

const ArtifactRef = z.object({
  id: z.string().min(1),
  kind: z.string().optional(),
  label: z.string().optional(),
  derived_from: z.array(z.string()).optional(),
  role: z.enum(["used", "generated", "both"]).optional().describe("PROV role: used=input, generated=output, both=input and output."),
});

const Change = z.object({
  before_hash: z.string().optional(),
  after_hash: z.string().optional(),
  diff: z.string().optional(),
  summary: z.string().optional(),
});

const Location = z.object({
  path: z.string().optional(),
  url: z.string().optional(),
  environment: z.string().optional(),
  device: z.string().optional(),
  system: z.string().optional(),
  session: z.string().optional(),
  client: z.string().optional(),
  ide: z.string().optional(),
  workspace: z.string().optional(),
  surface: z.enum(["tty", "agent"]).optional(),
});

const Method = z.object({
  tool: z.string().optional(),
  instruction: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  automated: z.boolean().optional(),
  tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
});

export const LogArgs = z.object({
  project: z.string().optional(),
  action: Action,
  action_detail: z.string().optional(),
  artifacts: z.array(ArtifactRef).min(1).describe(
    "Artifacts touched. Always set role explicitly for OUTPUTS of an executed/sent action — the default treats those refs as inputs.",
  ),
  intent: z.string().optional(),
  caused_by: z.string().optional().describe(
    "Event id of the instruction/action that caused this one. It must name an existing same-project event; dangling or cross-project ids are rejected. Adapters keep the link and mark it unverified.",
  ),
  actor: AuditActor.optional(),
  change: Change.optional(),
  location: Location.optional(),
  method: Method.optional(),
  timestamp: z.string().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  idempotency_key: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const InstructArgs = z.object({
  project: z.string().optional(),
  human_id: z.string().min(1),
  instruction: z.string().min(1),
  artifacts: z.array(ArtifactRef).optional(),
  timestamp: z.string().optional(),
});

export const HistoryArgs = z.object({
  project: z.string().optional(),
  artifact_id: z.string().optional(),
  actor_id: z.string().optional(),
  actor_type: z.enum(["human", "agent", "system"]).optional(),
  action: Action.optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  text: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  before_seq: z.number().int().nonnegative().optional(),
});

export const ExportArgs = z.object({
  project: z.string().optional(),
  artifact_id: z.string().optional(),
  out_json: z.string().optional(),
  out_html: z.string().optional(),
});

export const LineageArgs = z.object({
  project: z.string().optional(),
  artifact_id: z.string().optional(),
  format: z.enum(["text", "dot", "mermaid", "json"]).optional(),
  include_actors: z.boolean().optional(),
});

export type AuditMcpHandlers = {
  log(args: z.infer<typeof LogArgs>): Promise<CallToolResult>;
  instruct(args: z.infer<typeof InstructArgs>): Promise<CallToolResult>;
  history(args: z.infer<typeof HistoryArgs>): Promise<CallToolResult>;
  why(args: { event_id: string }): Promise<CallToolResult>;
  status(args: { project?: string }): Promise<CallToolResult>;
  verify(args: { project?: string }): Promise<CallToolResult>;
  export(args: z.infer<typeof ExportArgs>): Promise<CallToolResult>;
  lineage(args: z.infer<typeof LineageArgs>): Promise<CallToolResult>;
  projects(): Promise<CallToolResult>;
};

export const AUDIT_MCP_TOOL_NAMES = [
  "retrace_log", "retrace_instruct", "retrace_history", "retrace_why", "retrace_status",
  "retrace_verify", "retrace_export", "retrace_lineage", "retrace_projects",
] as const;

export function registerAuditMcpTools(
  server: McpServer,
  handlers: AuditMcpHandlers,
  opts: { defaultProject?: string; allowFileOutputs?: boolean } = {},
): McpServer {
  const defaultProject = opts.defaultProject ?? "default";
  server.registerTool("retrace_log", {
    title: "Log a provenance event",
    description: "Record WHO did WHAT to WHICH artifact(s), WHEN, WHERE, WHY and HOW. Call this after every meaningful action and pass the returned id as caused_by on follow-up actions.",
    inputSchema: LogArgs,
  }, handlers.log);

  server.registerTool("retrace_instruct", {
    title: "Log a human instruction",
    description: "Record the human instruction at the root of a causal chain. Call this at the start of a task and use the returned event id as caused_by.",
    inputSchema: InstructArgs,
  }, handlers.instruct);

  server.registerTool("retrace_history", {
    title: "Retrace history",
    description: "Newest matching events for a project. Truncation is explicit: pass before_seq to walk older pages.",
    inputSchema: HistoryArgs,
  }, handlers.history);

  server.registerTool("retrace_why", {
    title: "Explain why an event happened",
    description: "Follow caused_by links from an event back to the originating human instruction.",
    inputSchema: z.object({ event_id: z.string().min(1) }),
  }, handlers.why);

  server.registerTool("retrace_status", {
    title: "Project transparency status",
    description: "Canonical chain integrity, causal coverage, capture gaps, actors, and integration freshness for a project.",
    inputSchema: z.object({ project: z.string().optional() }),
  }, handlers.status);

  server.registerTool("retrace_verify", {
    title: "Verify chain integrity",
    description: "Recompute the hash chain for a project and report whether history is intact.",
    inputSchema: z.object({ project: z.string().optional() }),
  }, handlers.verify);

  const exportSchema = opts.allowFileOutputs
    ? ExportArgs
    : ExportArgs.omit({ out_json: true, out_html: true });
  server.registerTool("retrace_export", {
    title: "Signed provenance export",
    description: opts.allowFileOutputs
      ? "Build a signed provenance bundle and optionally write JSON or a printable HTML report inside the process working directory."
      : "Return a signed provenance bundle in memory. Remote MCP never writes local files.",
    inputSchema: exportSchema,
  }, (args) => handlers.export(args));

  server.registerTool("retrace_lineage", {
    title: "Artifact lineage graph",
    description: "Build explicit derived_from links plus causal flow, optionally focused on one artifact.",
    inputSchema: LineageArgs,
  }, handlers.lineage);

  server.registerTool("retrace_projects", {
    title: "List projects",
    description: `List projects visible to this credential (write default: ${defaultProject}).`,
    inputSchema: z.object({}),
  }, handlers.projects);

  return server;
}
