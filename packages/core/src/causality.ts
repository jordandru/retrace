import type { Event } from "./schema.js";

export type RootState = "rooted" | "broken" | "unlinked";

/** Does this event's caused_by chain terminate at a human instruction root? */
export function causalRootState(event: Event, byId: Map<string, Event>, opts: { strictParents?: boolean } = {}): RootState {
  const seen = new Set<string>();
  let cur: Event | undefined = event;
  while (cur) {
    if (seen.has(cur.id)) return "broken";
    seen.add(cur.id);
    if (cur.actor.type === "human" && cur.action === "instructed") return "rooted";
    if (!cur.caused_by) return "unlinked";
    const parent: Event | undefined = byId.get(cur.caused_by);
    if (!parent || (opts.strictParents && (parent.project !== event.project || parent.seq >= cur.seq))) return "broken";
    cur = parent;
  }
  return "broken";
}

