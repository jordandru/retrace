/** Human-readable rendering of events — used by the MCP server and CLI. */
import { ArtifactRole, Event } from "./schema.js";

/** Short PROV role marker for an artifact ref: "in" (used) · "out" (generated) · "in/out" (both) · "" when unspecified. */
export function roleMark(role?: ArtifactRole): string {
  return role === "used" ? "in" : role === "generated" ? "out" : role === "both" ? "in/out" : "";
}

export const UNTRUSTED_TEXT_OPEN = "«";
export const UNTRUSTED_TEXT_CLOSE = "»";

/** Collapse characters that can create hidden or extra display lines while preserving readable text. */
export function singleLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ")
    .replace(/[\u{e0000}-\u{e007f}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Collapse control characters and visually delimit caller-supplied ledger text.
 * This is a trust label, not a guarantee that a model will ignore the content.
 * Delimiter characters inside the payload are stripped to keep the label intact.
 */
export function markUntrustedText(value: string): string {
  const stripped = singleLine(value).replace(/[«»]/g, "");
  return `${UNTRUSTED_TEXT_OPEN}${stripped}${UNTRUSTED_TEXT_CLOSE}`;
}

export function eventReferenceForModel(value: string): string {
  return /^evt_[0-9a-f]{32}$/i.test(value) ? value : markUntrustedText(value);
}

export type ModelEventView = {
  id: string;
  seq: number;
  timestamp: string;
  received_at: string;
  action: Event["action"];
  caused_by?: string;
  duration_ms?: number;
  project_display: string;
  actor: {
    type: Event["actor"]["type"];
    identity_display: string;
    model_display?: string;
    on_behalf_of_display?: string;
  };
  artifacts: Array<{
    identity_display: string;
    label_display?: string;
    kind_display?: string;
    role?: Event["artifacts"][number]["role"];
  }>;
  action_detail_display?: string;
  intent_display?: string;
  location_display?: string;
  tool_display?: string;
};

/**
 * Allowlisted presentation of an event for model-facing structured results.
 * It deliberately omits hashes, signatures, diffs, arbitrary maps and exact
 * caller-controlled identifiers; those remain available through non-MCP APIs.
 */
export function eventForModel(event: Event): ModelEventView {
  const location = [
    event.location?.path,
    event.location?.url,
    event.location?.system,
    event.location?.environment,
  ].filter((value): value is string => value !== undefined).join(" · ");
  return {
    id: eventReferenceForModel(event.id),
    seq: event.seq,
    timestamp: event.timestamp,
    received_at: event.received_at,
    action: event.action,
    ...(event.caused_by === undefined ? {} : { caused_by: eventReferenceForModel(event.caused_by) }),
    ...(event.duration_ms === undefined ? {} : { duration_ms: event.duration_ms }),
    project_display: markUntrustedText(event.project),
    actor: {
      type: event.actor.type,
      identity_display: markUntrustedText(event.actor.display_name ?? event.actor.id),
      ...(event.actor.model === undefined ? {} : { model_display: markUntrustedText(event.actor.model) }),
      ...(event.actor.on_behalf_of === undefined ? {} : { on_behalf_of_display: markUntrustedText(event.actor.on_behalf_of) }),
    },
    artifacts: event.artifacts.map((artifact) => ({
      identity_display: markUntrustedText(artifact.id),
      ...(artifact.label === undefined ? {} : { label_display: markUntrustedText(artifact.label) }),
      ...(artifact.kind === undefined ? {} : { kind_display: markUntrustedText(artifact.kind) }),
      ...(artifact.role === undefined ? {} : { role: artifact.role }),
    })),
    ...(event.action_detail === undefined ? {} : { action_detail_display: markUntrustedText(event.action_detail) }),
    ...(event.intent === undefined ? {} : { intent_display: markUntrustedText(event.intent) }),
    ...(location ? { location_display: markUntrustedText(location) } : {}),
    ...(event.method?.tool === undefined ? {} : { tool_display: markUntrustedText(event.method.tool) }),
  };
}

export function describeActor(e: Event): string {
  const a = e.actor;
  const displayName = a.display_name === undefined ? "" : singleLine(a.display_name);
  const name = markUntrustedText(displayName || a.id);
  const model = a.model === undefined ? "" : singleLine(a.model);
  const tag = a.type === "agent" ? ` [agent${model ? ": " + markUntrustedText(model) : ""}]` : a.type === "system" ? " [system]" : "";
  const onBehalfOf = a.on_behalf_of === undefined ? "" : singleLine(a.on_behalf_of);
  const obo = onBehalfOf ? ` on behalf of ${markUntrustedText(onBehalfOf)}` : "";
  return `${name}${tag}${obo}`;
}

export function describeEvent(e: Event): string {
  const arts = e.artifacts.map((a) => {
    const m = roleMark(a.role);
    const label = a.label === undefined ? "" : singleLine(a.label);
    return markUntrustedText(label || a.id) + (m ? ` (${m})` : "");
  }).join(", ");
  const actionDetail = e.action_detail === undefined ? "" : singleLine(e.action_detail);
  const verb = e.action === "other" ? (actionDetail ? markUntrustedText(actionDetail) : "did something to") : e.action;
  const whereRaw = [e.location?.path, e.location?.url, e.location?.system]
    .map((value) => value === undefined ? "" : singleLine(value))
    .find(Boolean) ?? "";
  const where = whereRaw ? markUntrustedText(whereRaw) : "";
  const tool = e.method?.tool === undefined ? "" : singleLine(e.method.tool);
  const how = tool ? ` via ${markUntrustedText(tool)}` : "";
  const intent = e.intent === undefined ? "" : singleLine(e.intent);
  const why = intent ? ` — why: ${markUntrustedText(intent)}` : "";
  return `#${e.seq} ${e.timestamp}  ${describeActor(e)} ${verb} ${arts}${where ? " @ " + where : ""}${how}${why}`;
}

export function renderTimeline(events: Event[]): string {
  if (!events.length) return "(no events)";
  return events.map(describeEvent).join("\n");
}

export function renderWhyChain(chain: Event[]): string {
  // chain[0] is the event, last is the root cause
  return chain
    .map((e, i) => `${"  ".repeat(i)}${i === 0 ? "" : "↳ because "}${describeEvent(e)}`)
    .join("\n");
}
