import { ArtifactRole, Event } from "./schema.js";

export const AMENDMENT_ACTION_DETAIL = "amended";

export type ProvenanceAmendment = {
  event: Event;
  target: Event;
  artifact_roles: Map<number, ArtifactRole>;
  attest_causal_root: boolean;
};

/**
 * Read append-only corrections without changing the sealed event they qualify.
 * An amendment is effective only when it is causally rooted in a human instruction,
 * names an older event in the same project, and corrects fields that were absent.
 */
export function collectProvenanceAmendments(
  events: Event[],
  isRooted: (event: Event) => boolean,
): Map<string, ProvenanceAmendment[]> {
  const byId = new Map(events.map((e) => [e.id, e]));
  const out = new Map<string, ProvenanceAmendment[]>();
  for (const event of events) {
    if (event.action !== "other" || event.action_detail !== AMENDMENT_ACTION_DETAIL || !isRooted(event)) continue;
    const params = event.method?.params;
    const targetId = typeof params?.target_event_id === "string" ? params.target_event_id : undefined;
    const target = targetId ? byId.get(targetId) : undefined;
    if (!target || target.project !== event.project || target.seq >= event.seq) continue;
    const roles = new Map<number, ArtifactRole>();
    if (Array.isArray(params?.artifact_roles)) {
      for (const item of params.artifact_roles) {
        if (!item || typeof item !== "object") continue;
        const index = (item as any).index;
        const role = (item as any).role;
        if (Number.isInteger(index) && index >= 0 && index < target.artifacts.length && target.artifacts[index].role === undefined && ["used", "generated", "both"].includes(role))
          roles.set(index, role as ArtifactRole);
      }
    }
    const amendment: ProvenanceAmendment = { event, target, artifact_roles: roles, attest_causal_root: params?.attest_causal_root === true };
    const list = out.get(target.id) ?? [];
    list.push(amendment);
    out.set(target.id, list);
  }
  return out;
}
