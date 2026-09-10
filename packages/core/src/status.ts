import { collectAttributionAmendments, effectiveActor, isAttributionAmendment, type AttributionOptions } from "./attribution.js";
import { Event } from "./schema.js";
import { VerifyResult } from "./chain.js";
import { EventStore, verifyProject } from "./store.js";
import { collectProvenanceAmendments, collectRejectedAmendments } from "./amendment.js";
import { isLegacyClientCommitSeal } from "./producer-sig.js";
import { CAUSED_BY_UNVERIFIED_TAG, SEALED_BY_PARAM, sealedByKind } from "./store.js";
import { markUntrustedText } from "./explain.js";
import { causalRootState, type RootState } from "./causality.js";
import { projectIssuanceStatus, type IssuanceCredential, type ProjectIssuanceStatus } from "./credential-status.js";
export { causalRootState } from "./causality.js";

export type StatusActor = { type: Event["actor"]["type"]; id: string; events: number; last_seen: string; models: string[]; amended_from?: {type: Event["actor"]["type"]; id: string}[] };
export type StatusIntegration = { system: string; events: number; last_seen: string };
export type ProjectStatus = {
  project: string;
  generated_at: string;
  integrity: VerifyResult;
  events: { total: number; last_event_at?: string };
  capture: {
    attribution: "available" | `unavailable: ${string}`;
    attribution_attempts: number;
    attribution_amendments?: number; attribution_amended_events?: number; partially_amended_events?: number; superseded_attribution_amendments?: number; attribution_unavailable?: string; ineffective_amendment_reasons?: {id:string; reason:string}[];
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
    unverified_links: number;
    /** who sealed each event (Worker stamp): pinned/assert credential, owner token, webhook, unauthenticated, or unstamped (local / pre-stamp) */
    sealed_by: { pinned: number; assert: number; webhook: number; owner: number; unauthenticated: number; unstamped: number };
    /** agent events whose actor was NOT fixed by a pinned credential (owner-asserted, unauthenticated, or unstamped): WHO is producer testimony there */
    agent_events_not_pinned: number;
    /** /1-signed git commit seals (absent format = /1). Unsigned commit seals are not counted. */
    legacy_client: number;
  };
  causality: { eligible_events: number; rooted_in_human_instruction: number; attested_events: number; broken_links: number; unlinked: number; coverage_pct: number };
  actors: StatusActor[];
  integrations: StatusIntegration[];
  /** Credential issuance for this project (from RETRACE_CREDENTIALS). Absent when the handler has no credential list. */
  issuance?: ProjectIssuanceStatus;
};

export async function buildProjectStatus(store: EventStore, project: string, now = new Date(), attributionOptions?: AttributionOptions, credentials?: IssuanceCredential[]): Promise<ProjectStatus> {
  const events = await store.all(project);
  const integrity = await verifyProject(store, project);
  const byId = new Map(events.map((e) => [e.id, e]));
  const caused = new Set(events.map((e) => e.caused_by).filter((x): x is string => !!x));
  const eligible = events.filter((e) => e.actor.type === "agent" || e.action === "committed" || e.action === "merged");
  const roots = eligible.map((e) => causalRootState(e, byId));
  const count = (s: RootState) => roots.filter((x) => x === s).length;

  const attribution=collectAttributionAmendments(events, attributionOptions);
  // The Worker has no local Git context. An empty effective map there is not an evaluation.
  const attributionUnavailable = !attributionOptions?.context ? "no_git_context" : attribution.unavailable;
  const actors = new Map<string, StatusActor>();
  const integrations = new Map<string, StatusIntegration>();
  for (const e of events) {
    const view=effectiveActor(e,attribution.effective);
    const a=view.actor;
    const ak = `${a.type}:${a.id}`;
    const actor = actors.get(ak) ?? { type: a.type, id: a.id, events: 0, last_seen: e.timestamp, models: [] };
    actor.events++; if (e.timestamp > actor.last_seen) actor.last_seen = e.timestamp;
    if (a.model && !actor.models.includes(a.model)) actor.models.push(a.model);
    if(view.amended) { actor.amended_from ??= []; if(!actor.amended_from.some(a=>a.type===e.actor.type&&a.id===e.actor.id))actor.amended_from.push({type:e.actor.type,id:e.actor.id}); }
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
  const sealedBy = { pinned: 0, assert: 0, webhook: 0, owner: 0, unauthenticated: 0, unstamped: 0 };
  for (const e of events) sealedBy[sealedByKind(e.method?.params?.[SEALED_BY_PARAM])]++;
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
      ineffective_amendments: rejectedAmendments.length + attribution.rejected.length,
      attribution_attempts: events.filter(isAttributionAmendment).length,
      attribution: attributionUnavailable ? `unavailable: ${attributionUnavailable}` : "available",
      ...(attributionUnavailable ? {attribution_unavailable:attributionUnavailable} : {attribution_amendments:[...attribution.effective.values()].flat().length,attribution_amended_events:[...attribution.effective.values()].filter(a=>a.some(x=>x.whole_event)).length,partially_amended_events:[...attribution.effective.values()].filter(a=>!a.some(x=>x.whole_event)).length,superseded_attribution_amendments:attribution.superseded.length}),
      ineffective_amendment_reasons:[...rejectedAmendments,...attribution.rejected].map(r=>({id:r.event.id,reason:r.reason})),
      unverified_links: events.filter((e) => e.tags?.includes(CAUSED_BY_UNVERIFIED_TAG)).length,
      sealed_by: sealedBy,
      agent_events_not_pinned: events.filter((e) => e.actor.type === "agent" && sealedByKind(e.method?.params?.[SEALED_BY_PARAM]) !== "pinned").length,
      legacy_client: commits.filter(isLegacyClientCommitSeal).length,
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
    ...(credentials !== undefined ? { issuance: projectIssuanceStatus(credentials, project) } : {}),
  };
}

export function projectStatusForModel(status: ProjectStatus): ProjectStatus {
  return {
    ...status,
    project: markUntrustedText(status.project),
    actors: status.actors.map((actor) => ({
      ...actor,
      id: markUntrustedText(actor.id),
      models: actor.models.map(markUntrustedText),
    ...(actor.amended_from ? {amended_from:actor.amended_from.map(a=>({...a,id:markUntrustedText(a.id)}))} : {}),
    })),
    integrations: status.integrations.map((integration) => ({
      ...integration,
      system: markUntrustedText(integration.system),
    })),
    issuance: status.issuance && {
      shared_actor_id: status.issuance.shared_actor_id.map((row) => ({ ...row, id: markUntrustedText(row.id) })),
      principals: status.issuance.principals.map((row) => ({
        ...row,
        actor: { ...row.actor, id: markUntrustedText(row.actor.id) },
        principal: row.principal === "missing" ? "missing" : { ...row.principal, id: markUntrustedText(row.principal.id) },
      })),
      principal_conflicts: status.issuance.principal_conflicts.map((row) => ({
        ...row,
        project: markUntrustedText(row.project),
        actor: { ...row.actor, id: markUntrustedText(row.actor.id) },
        principals: row.principals.map((p) => ({ ...p, id: markUntrustedText(p.id) })),
        live: row.live.map((item) => ({
          ...item,
          principal: item.principal === "missing" ? "missing" : { ...item.principal, id: markUntrustedText(item.principal.id) },
        })),
      })),
    },
  };
}

export function renderProjectStatus(s: ProjectStatus): string {
  const health = s.integrity.ok ? "VERIFIED" : "BROKEN";
  return `${markUntrustedText(s.project)} — ${health}\n` +
    `${s.events.total} events · ${s.causality.coverage_pct}% causal coverage · ${s.capture.unlinked_commits}/${s.capture.commits} unlinked commits · ${s.capture.unverified_links} unverified links · ${s.capture.legacy_client} legacy-client seals\n` +
    `${s.capture.agent_events_without_model}/${s.capture.agent_events} agent events missing model · ${s.capture.instructions_without_followup}/${s.capture.instructions} instructions without follow-up · ${s.capture.artifact_refs_without_role}/${s.capture.artifact_refs} artifact refs missing role\n` +
    `append-only amendments: ${s.capture.amended_unlinked_commits} commits attested · ${s.capture.amended_artifact_refs} artifact roles supplied · ${s.capture.ineffective_amendments} rejected links\n` +
    `sealed by: ${s.capture.sealed_by.pinned} pinned · ${s.capture.sealed_by.assert} assert · ${s.capture.sealed_by.webhook} webhook · ${s.capture.sealed_by.owner} owner-asserted · ${s.capture.sealed_by.unauthenticated} unauthenticated · ${s.capture.sealed_by.unstamped} unstamped; ${s.capture.agent_events_not_pinned}/${s.capture.agent_events} agent events not pinned\n` +
    (s.capture.attribution_unavailable ? `attribution evaluation unavailable: ${s.capture.attribution_unavailable} (${s.capture.attribution_attempts ?? 0} attempts)\n` : `attribution amendments: ${s.capture.attribution_amendments ?? 0} effective · ${s.capture.superseded_attribution_amendments ?? 0} superseded · ${s.capture.partially_amended_events ?? 0} partially amended events\n`) +
    `actors: ${s.actors.map((a) => `${a.type}/${markUntrustedText(a.id)} (${a.events})`).join(", ") || "none"}\n` +
    (s.issuance?.shared_actor_id.length
      ? `shared_actor_id: ${s.issuance.shared_actor_id.map((r) => `${r.type}/${markUntrustedText(r.id)} ×${r.count}`).join(", ")}\n`
      : "") +
    (s.issuance?.principals.length
      ? `principals: ${s.issuance.principals.map((r) => `${r.actor.type}/${markUntrustedText(r.actor.id)} → ${r.principal === "missing" ? "missing" : `${r.principal.type}/${markUntrustedText(r.principal.id)}`}`).join(", ")}\n`
      : "") +
    (s.issuance?.principal_conflicts.length
      ? `principal_conflicts: ${s.issuance.principal_conflicts.map((r) => `${r.actor.type}/${markUntrustedText(r.actor.id)} [${r.principals.map((p) => `${p.type}/${markUntrustedText(p.id)}`).join(", ")}] live ${r.live.length}`).join("; ")}\n`
      : "") +
    `integrations: ${s.integrations.map((i) => `${markUntrustedText(i.system)} (${i.events}, last ${i.last_seen})`).join(", ") || "none"}`;
}
