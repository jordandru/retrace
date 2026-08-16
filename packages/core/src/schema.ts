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
  "instructed",
  "committed",
  "merged",
  "other",
]);
export type Action = z.infer<typeof Action>;

export const ArtifactRef = z.object({
  /** Stable id for the thing being worked on, e.g. "repo:slcwitit/rpg#src/fight.ts" or "doc:abc123" */
  id: z.string().min(1),
  kind: z.string().optional(), // file, doc, dataset, pr, message, decision, ...
  label: z.string().optional(),
  /** Lineage: this artifact was derived from these */
  derived_from: z.array(z.string()).optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

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
});

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
});
export type EventInput = z.infer<typeof EventInput>;

export const Event = EventInput.extend({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  timestamp: z.string().datetime({ offset: true }),
  prev_hash: z.string(),
  hash: z.string(),
  received_at: z.string().datetime({ offset: true }),
});
export type Event = z.infer<typeof Event>;

export const GENESIS_HASH = "0".repeat(64);
