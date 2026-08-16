/** Human-readable rendering of events — used by the MCP server and CLI. */
import { Event } from "./schema.js";

export function describeActor(e: Event): string {
  const a = e.actor;
  const name = a.display_name ?? a.id;
  const tag = a.type === "agent" ? ` [agent${a.model ? ": " + a.model : ""}]` : a.type === "system" ? " [system]" : "";
  const obo = a.on_behalf_of ? ` on behalf of ${a.on_behalf_of}` : "";
  return `${name}${tag}${obo}`;
}

export function describeEvent(e: Event): string {
  const arts = e.artifacts.map((a) => a.label ?? a.id).join(", ");
  const verb = e.action === "other" ? e.action_detail ?? "did something to" : e.action;
  const where = e.location?.path ?? e.location?.url ?? e.location?.system ?? "";
  const how = e.method?.tool ? ` via ${e.method.tool}` : "";
  const why = e.intent ? ` — why: ${e.intent}` : "";
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
