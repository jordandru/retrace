/**
 * Retrace core schema — the six dimensions of provenance:
 * WHO (actor) · WHAT (action + artifacts + change) · WHEN (timestamp/seq)
 * WHERE (location) · WHY (intent + caused_by) · HOW (method)
 * plus integrity (hash chain).
 *
 * Deliberately close to W3C PROV (Agent / Activity / Entity) so we can export later.
 */
import { z } from "zod";

export const ActorType = z.enum(["human", "agent", "system"]);
export type ActorType = z.infer<typeof ActorType>;

export const Actor = z.object({
  type: ActorType,
  /** Stable identifier: email, agent name, service id */
  id: z.string().min(1),
  display_name: z.string().optional(),
  /** For agents: model + version that performed the action */
  model: z.string().optional(),
  version: z.string().optional(),
  /** Delegation: an agent acting for a human, or a sub-agent for a parent agent */
  on_behalf_of: z.string().optional(),
});
export type Actor = z.infer<typeof Actor>;

/** Small controlled verb vocabulary. `other` requires `action_detail`. */
export const Action = z.enum([
  "created",
  "edited",
  "deleted",
  "read",
  "executed",
  "approved",
  "rejected",
  "sent",
  "received",
  "moved",
  "renamed",
  "instructed",
  "committed",
  "merged",
  "other",
]);
export type Action = z.infer<typeof Action>;

/**
 * PROV role of an artifact within an event: was it an input the activity `used`, an output it `generated`, or `both`
 * (read then rewritten). Optional — absence means "unspecified" and is a legal, permanent state: events sealed before
 * this field existed are never backfilled or re-hashed (absence is information).
 *   Export mapping (for a future prov exporter): used → prov:used (Activity→Entity), generated → prov:wasGeneratedBy
 *   (Entity→Activity), both → both edges, absent → degrades to prov:wasInfluencedBy.
 *   Distinct from `derived_from`, which is Entity→Entity (prov:wasDerivedFrom) and unchanged. Invalidation (a deleted
 *   artifact, prov:wasInvalidatedBy) is deliberately NOT a role — a deleted ref stays absent until that is a first-class edge.
 */
export const ArtifactRole = z.enum(["used", "generated", "both"]);
export type ArtifactRole = z.infer<typeof ArtifactRole>;

export const ArtifactRef = z.object({
  /** Stable id for the thing being worked on, e.g. "repo:my-app#src/main.ts" or "doc:abc123" */
  id: z.string().min(1),
  kind: z.string().optional(), // file, doc, dataset, pr, message, decision, ...
  label: z.string().optional(),
  /** Lineage: this artifact was derived from these */
  derived_from: z.array(z.string()).optional(),
  /** PROV: input (used) / output (generated) / both. Body-only, hash-covered on new events; see ArtifactRole. */
  role: ArtifactRole.optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

/**
 * Default role of an artifact ref for an action verb, for when the caller says nothing. `undefined` = leave absent.
 *   read → used · created/committed/merged → generated · edited/moved/renamed → both (the prior state is read, the new
 *   one written) · executed/sent/received/approved/rejected → used (the thing run/sent/reviewed was an input; an OUTPUT
 *   such as a deployment or report must be said by the caller) · deleted/instructed/other → absent.
 * Adapters stamp what they authoritatively know and only fall back to this where the verb alone is the truth.
 */
export function defaultArtifactRole(action: Action): ArtifactRole | undefined {
  switch (action) {
    case "read": return "used";
    case "created": case "committed": case "merged": return "generated";
    case "edited": case "moved": case "renamed": return "both";
    case "executed": case "sent": case "received": case "approved": case "rejected": return "used";
    default: return undefined; // deleted, instructed, other
  }
}

/** Fill `role` from defaultArtifactRole ONLY where a ref has none — a caller-supplied role is never overwritten. Refs
 *  that get no default come back as they were (no `role` key, so hashes of role-less inputs are unaffected). */
export function applyDefaultRoles<T extends ArtifactRef>(action: Action, artifacts: T[]): T[] {
  const def = defaultArtifactRole(action);
  return artifacts.map((a) => (a.role !== undefined || def === undefined ? a : { ...a, role: def }));
}

export const Change = z.object({
  before_hash: z.string().optional(),
  after_hash: z.string().optional(),
  diff: z.string().optional(),
  summary: z.string().optional(),
});

export const Location = z.object({
  /** repo path, doc section, URL, table, etc. */
  path: z.string().optional(),
  url: z.string().optional(),
  environment: z.string().optional(), // prod, staging, local, ...
  device: z.string().optional(),
  system: z.string().optional(), // github, gdocs, cursor, claude-code, ...
  /** Run/session id of the producing process (backlog #15; body-only, like every location field). On the MCP path
   *  this is the harness's own session id when it exposes one (CLAUDE_CODE_SESSION_ID or GROK_SESSION_ID), so the same string appears on
   *  events from the agent AND on the commits it drives. It is a *session* key — subagents share it — not a per-run id. */
  session: z.string().optional(),
  /** The MCP client that drove the write, verbatim from the `initialize` handshake as "<name>@<version>" — e.g.
   *  "claude-code@2.1.250", "cursor-vscode@1.7.3". Server-stamped only: it is evidence ABOUT the writer, so the
   *  writer may not assert it (see SERVER_ONLY in the MCP server). */
  client: z.string().optional(),
  /** IDE / agent-development environment hosting the actor, e.g. "orca". Deliberately distinct from `system` (the tool
   *  that produced the event, "claude-code") and from `client` (which build of it): the IDE is the app AROUND both, and
   *  neither of the other two can express it. Only stamped when the IDE identifies itself in the environment. */
  ide: z.string().optional(),
  /** Isolated workspace within `ide` — an Orca worktree id, a codespace or devcontainer name. This is what tells two
   *  parallel agents apart when they run the same project, on the same host, as the same actor. */
  workspace: z.string().optional(),
  /** Whether the producing process had a controlling terminal: "tty" = a human at a keyboard, "agent" = spawned by a
   *  harness with none. Linux-only today (read from /proc/self/stat); absent everywhere else, and absence is a legal
   *  permanent state. EVIDENCE, never authority — it must not override the actor determination. */
  surface: z.enum(["tty", "agent"]).optional(),
});
export type Location = z.infer<typeof Location>;

export const Method = z.object({
  tool: z.string().optional(), // e.g. "Edit", "git commit", "gdocs-ui"
  /** Reference to instruction/prompt that drove this (id, hash, or short text) */
  instruction: z.string().optional(),
  params: z.record(z.unknown()).optional(),
  automated: z.boolean().optional(),
  tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
});

/** What a client submits. Server fills in id/seq/hash/prev_hash. */
export const EventInput = z.object({
  project: z.string().min(1),
  actor: Actor,
  action: Action,
  action_detail: z.string().optional(),
  artifacts: z.array(ArtifactRef).min(1),
  change: Change.optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  location: Location.optional(),
  /** WHY — free text reason */
  intent: z.string().optional(),
  /** WHY — causal parent (event id). The instruction that led to this action. */
  caused_by: z.string().optional(),
  method: Method.optional(),
  /** Client-provided idempotency key */
  idempotency_key: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** Rung 5: the producer's Ed25519 signature over an explicit payload (producer-sig.ts) made with a key the server
   *  never holds. A top-level field, so the v2 hash seals it — stripping it after the seal breaks the chain. */
  producer_sig: z.object({ kid: z.string().min(8), sig: z.string().min(40) }).optional(),
});
export type EventInput = z.infer<typeof EventInput>;

export const Event = EventInput.extend({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  timestamp: z.string().datetime({ offset: true }),
  prev_hash: z.string(),
  hash: z.string(),
  received_at: z.string().datetime({ offset: true }),
  /** Hash rule the seal used. 2 = the digest covers `received_at` and this field; absent = legacy seal (pre-2026-08-30),
   *  whose digest may or may not cover `received_at`. Covered by the hash, so it cannot be stripped to downgrade a verifier. */
  hash_v: z.literal(2).optional(),
});
export type Event = z.infer<typeof Event>;

/**
 * The schema surface a build understands, derived from the zod shapes themselves so it can never drift from the code.
 *
 * This exists because the failure it detects is SILENT: `POST /events` re-parses with `EventInput.safeParse`, and zod
 * strips keys it does not know, so a producer running newer code than the deployment loses those fields with no error
 * anywhere — the event is accepted, sealed and hashed without them. It has happened twice (`location.session`,
 * `bacabed`; `location.client`/`ide`/`workspace`/`surface`, 2026-08-28), both times found by eye.
 * `GET /api` publishes this, and `npm run check-deploy` diffs a deployment against the local build.
 */
export function schemaSurface(): { event: string[]; location: string[]; artifact: string[]; actions: string[] } {
  return {
    event: Object.keys(EventInput.shape).sort(),
    location: Object.keys(Location.shape).sort(),
    artifact: Object.keys(ArtifactRef.shape).sort(),
    actions: [...Action.options].sort(),
  };
}

export const GENESIS_HASH = "0".repeat(64);
