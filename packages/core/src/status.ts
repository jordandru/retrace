import { Event } from "./schema.js";
import { VerifyResult } from "./chain.js";
import { EventStore, verifyProject } from "./store.js";
import { collectProvenanceAmendments, collectRejectedAmendments } from "./amendment.js";

export type StatusActor = { type: Event["actor"]["type"]; id: string; events: number; last_seen: string; models: string[] };
export type StatusIntegration = { system: string; events: number; last_seen: string };
export type ProjectStatus = {
  project: string;
  generated_at: string;
  integrity: VerifyResult;
  events: { total: number; last_event_at?: string };
  capture: {
    artifact_refs: number;
    artifact_refs_without_role: number;
    agent_events: number;
    agent_events_without_model: number;
    instructions: number;
    instructions_without_followup: number;
    commits: number;
    unlinked_commits: number;
    amended_unlinked_commits: number;
    amended_artifact_refs: number;
    ineffective_amendments: number;
  };
  causality: { eligible_events: number; rooted_in_human_instruction: number; attested_events: number; broken_links: number; unlinked: number; coverage_pct: number };
  actors: StatusActor[];
  integrations: StatusIntegration[];
};

type RootState = "rooted" | "broken" | "unlinked";

/** Does this event's caused_by chain terminate at a human instruction root? */
export function causalRootState(event: Event, byId: Map<string, Event>): RootState {
  const seen = new Set<string>();
  let cur: Event | undefined = event;
  while (cur) {
    if (seen.has(cur.id)) return "broken";
    seen.add(cur.id);
    if (cur.actor.type === "human" && cur.action === "instructed") return "rooted";
    if (!cur.caused_by) return "unlinked";
    cur = byId.get(cur.caused_by);
    if (!cur) return "broken";
  }
  return "broken";
}

export async function buildProjectStatus(store: EventStore, project: string, now = new Date()): Promise<ProjectStatus> {
  const events = await store.all(project);
  const integrity = await verifyProject(store, project);
  const byId = new Map(events.map((e) => [e.id, e]));
  const caused = new Set(events.map((e) => e.caused_by).filter((x): x is string => !!x));
  const eligible = events.filter((e) => e.actor.type === "agent" || e.action === "committed" || e.action === "merged");
  const roots = eligible.map((e) => causalRootState(e, byId));
  const count = (s: RootState) => roots.filter((x) => x === s).length;

  const actors = new Map<string, StatusActor>();
  const integrations = new Map<string, StatusIntegration>();
  for (const e of events) {
    const ak = `${e.actor.type}:${e.actor.id}`;
    const actor = actors.get(ak) ?? { type: e.actor.type, id: e.actor.id, events: 0, last_seen: e.timestamp, models: [] };
    actor.events++; if (e.timestamp > actor.last_seen) actor.last_seen = e.timestamp;
    if (e.actor.model && !actor.models.includes(e.actor.model)) actor.models.push(e.actor.model);
    actors.set(ak, actor);
    const system = e.location?.system;
    if (system) {
      const integration = integrations.get(system) ?? { system, events: 0, last_seen: e.timestamp };
      integration.events++; if (e.timestamp > integration.last_seen) integration.last_seen = e.timestamp;
      integrations.set(system, integration);
    }
  }
  const isRooted = (e: Event) => causalRootState(e, byId) === "rooted";
  const amendments = collectProvenanceAmendments(events, isRooted);
  const rejectedAmendments = collectRejectedAmendments(events, isRooted);
  const attested = new Set(eligible.filter((e) => causalRootState(e, byId) !== "rooted" && amendments.get(e.id)?.some((a) => a.attest_causal_root)).map((e) => e.id));
  const amendedRoles = new Set<string>();
  for (const [targetId, list] of amendments) for (const amendment of list) for (const index of amendment.artifact_roles.keys()) amendedRoles.add(`${targetId}:${index}`);
  const artifactRefs = events.flatMap((e) => e.artifacts.map((a, index) => ({ event: e, artifact: a, index })));
  const instructions = events.filter((e) => e.actor.type === "human" && e.action === "instructed");
  const commits = events.filter((e) => e.action === "committed" || e.action === "merged");
  const rooted = count("rooted");
  return {
    project,
    generated_at: now.toISOString(),
    integrity,
    events: { total: events.length, last_event_at: events.at(-1)?.timestamp },
    capture: {
      artifact_refs: artifactRefs.length,
      artifact_refs_without_role: artifactRefs.filter(({ event, artifact, index }) => artifact.role === undefined && !amendedRoles.has(`${event.id}:${index}`)).length,
      amended_artifact_refs: amendedRoles.size,
      agent_events: events.filter((e) => e.actor.type === "agent").length,
      agent_events_without_model: events.filter((e) => e.actor.type === "agent" && !e.actor.model).length,
      instructions: instructions.length,
      instructions_without_followup: instructions.filter((e) => !caused.has(e.id)).length,
      commits: commits.length,
      unlinked_commits: commits.filter((e) => causalRootState(e, byId) !== "rooted" && !attested.has(e.id)).length,
      amended_unlinked_commits: commits.filter((e) => attested.has(e.id)).length,
      ineffective_amendments: rejectedAmendments.length,
    },
    causality: {
      eligible_events: eligible.length,
      rooted_in_human_instruction: rooted,
      attested_events: attested.size,
      broken_links: eligible.filter((e) => causalRootState(e, byId) === "broken" && !attested.has(e.id)).length,
      unlinked: eligible.filter((e) => causalRootState(e, byId) === "unlinked" && !attested.has(e.id)).length,
      coverage_pct: eligible.length ? Math.round((rooted + attested.size) * 1000 / eligible.length) / 10 : 100,
    },
    actors: [...actors.values()].map((a) => ({ ...a, models: a.models.sort() })).sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id)),
    integrations: [...integrations.values()].sort((a, b) => a.system.localeCompare(b.system)),
  };
}

export function renderProjectStatus(s: ProjectStatus): string {
  const health = s.integrity.ok ? "VERIFIED" : "BROKEN";
  return `${s.project} — ${health}\n` +
    `${s.events.total} events · ${s.causality.coverage_pct}% causal coverage · ${s.capture.unlinked_commits}/${s.capture.commits} unlinked commits\n` +
    `${s.capture.agent_events_without_model}/${s.capture.agent_events} agent events missing model · ${s.capture.instructions_without_followup}/${s.capture.instructions} instructions without follow-up · ${s.capture.artifact_refs_without_role}/${s.capture.artifact_refs} artifact refs missing role\n` +
    `append-only amendments: ${s.capture.amended_unlinked_commits} commits attested · ${s.capture.amended_artifact_refs} artifact roles supplied · ${s.capture.ineffective_amendments} rejected links\n` +
    `actors: ${s.actors.map((a) => `${a.type}/${a.id} (${a.events})`).join(", ") || "none"}\n` +
    `integrations: ${s.integrations.map((i) => `${i.system} (${i.events}, last ${i.last_seen})`).join(", ") || "none"}`;
}
