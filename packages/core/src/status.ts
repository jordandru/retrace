import { ownerLoginStats, OwnerLoginStats } from "./owner-login-status.js";
import { collectAttributionAmendments, effectiveActor, isAttributionAmendment, type AttributionOptions } from "./attribution.js";
import { Event, ModelSource } from "./schema.js";
import { VerifyResult } from "./chain.js";
import { EventStore, instantOrder, verifyProject } from "./store.js";
import { collectProvenanceAmendments, collectRejectedAmendments } from "./amendment.js";
import { isLegacyClientCommitSeal } from "./producer-sig.js";
import { CAUSED_BY_UNVERIFIED_TAG, SEALED_BY_PARAM, sealedByKind } from "./store.js";
import { markUntrustedText } from "./explain.js";
import { causalRootState, type RootState } from "./causality.js";
import { projectIssuanceStatus, type IssuanceCredential, type ProjectIssuanceStatus } from "./credential-status.js";
import { canonicalGithubRepo, canonicalRepositoryR, routeGithubDelivery } from "./policy.js";
import type { ExportCacheStatus } from "./export-cache.js";
export { causalRootState } from "./causality.js";

/** Empty-string `model` is absent, matching the schema pairing rule. */
function actorModelPresent(model: string | undefined): boolean {
  return model !== undefined && model !== "";
}

export const NO_SOURCE_RECORDED = "no source recorded" as const;
export type ModelSourceBucket = ModelSource | typeof NO_SOURCE_RECORDED;
const MODEL_SOURCE_ORDER: ModelSourceBucket[] = [
  "harness-runtime",
  "harness-config",
  "harness-display",
  "credential-pinned",
  "operator-stated",
  "self-report",
  "none",
  NO_SOURCE_RECORDED,
];

function emptySourceCounts(): Record<ModelSourceBucket, number> {
  return Object.fromEntries(MODEL_SOURCE_ORDER.map((key) => [key, 0])) as Record<ModelSourceBucket, number>;
}

const COMMIT_SHA = /^(?:[0-9a-f]{7}|[0-9a-f]{12}|[0-9a-f]{40})$/;

/**
 * `commit:<repo>@<sha>` with a non-empty repository and a hexadecimal sha of 7, 12, or 40
 * characters. The sha is lower-cased. The repository string is taken as written: it is not
 * trimmed, lower-cased, or passed through policy aliases. Anything else is not a sha.
 */
function parseCommitRef(id: string): { repo: string; sha: string } | undefined {
  if (!id.startsWith("commit:")) return undefined;
  const at = id.lastIndexOf("@");
  if (at < "commit:".length) return undefined;
  const repo = id.slice("commit:".length, at);
  if (repo.length === 0) return undefined;
  const sha = id.slice(at + 1).toLowerCase();
  if (!COMMIT_SHA.test(sha)) return undefined;
  return { repo, sha };
}

/** Distinct commit shas named by seal records, counted per repo. A count of claimed shas — records are claims; it roots nothing and links nothing. A sha is maximal when no other sha of the same repository extends it. Each maximal sha is one group. A shorter id joins the single maximal sha it prefixes; if it prefixes two or more maximal shas it stays its own group. A ref the parser rejects is not counted. The same sha in two repositories counts once per repository. */
function commitShaCount(events: Event[]): number {
  const byRepo = new Map<string, Set<string>>();
  for (const event of events) {
    for (const artifact of event.artifacts) {
      const ref = parseCommitRef(artifact.id);
      if (!ref) continue;
      const set = byRepo.get(ref.repo) ?? new Set<string>();
      set.add(ref.sha);
      byRepo.set(ref.repo, set);
    }
  }
  let count = 0;
  for (const shas of byRepo.values()) {
    const list = [...shas];
    const maximal = list.filter((sha) => !list.some((other) => other.length > sha.length && other.startsWith(sha)));
    const groups = new Set(maximal);
    for (const sha of list) {
      if (maximal.includes(sha)) continue;
      const matches = maximal.filter((other) => other.startsWith(sha));
      if (matches.length !== 1) groups.add(sha);
    }
    count += groups.size;
  }
  return count;
}

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
    /** Count of agent events per `actor.model_source`; legacy events with no field sit under "no source recorded". */
    agent_events_by_model_source: Record<ModelSourceBucket, number>;
    /**
     * Split of `agent_events_without_model`. An event with no model and a source other than `none`
     * cannot exist under the schema's refine; if one is found in old data, count it under
     * `no_source_recorded`.
     */
    agent_events_without_model_by_cause: { source_none: number; no_source_recorded: number };
    instructions: number;
    instructions_without_followup: number;
    /** Seal records: one per `committed` or `merged` event, not distinct commits. */
    commits: number;
    /** A count of claimed shas — records are claims; it roots nothing and links nothing. Only `commit:<repo>@<sha>` with a non-empty repository and a 7-, 12-, or 40-character hexadecimal sha counts; the sha is lower-cased and the repository string is taken as written. A sha is maximal when no other sha of that repository extends it, and each maximal sha is one group. A shorter id joins the single maximal sha it prefixes; if it prefixes two or more maximal shas it stays its own group. Anything the parser rejects is not a sha. */
    commit_shas: number;
    /** commit seals that are neither rooted nor attested (true count; sibling corroboration does not reduce it) */
    unlinked_commits: number;
    amended_unlinked_commits: number;
    /**
     * Read-time evidence, not a root: commit seals whose own chain is `unlinked` (never `broken`) and whose commit, by
     * canonical repository (policy name/aliases, case-insensitive) and full 40-hex `change.after_hash`, was also sealed by
     * the OTHER authenticated capture producer the current policy recognises (the exact trusted hook stamp vs
     * `webhook:github`) with a rooted or attested chain. Pinned-agent, owner, forwarder, unauthenticated and unstamped
     * records are claims and never corroborate; with no policy nothing corroborates. Counted in `unlinked_commits` and
     * `causality.unlinked` as before; outside `coverage_pct`; roots and attests nothing.
     */
    sibling_corroborated: number;
    amended_artifact_refs: number;
    ineffective_amendments: number;
    unverified_links: number;
    /** who sealed each event (Worker stamp): pinned/assert credential, owner token, webhook, unauthenticated, or unstamped (local / pre-stamp) */
    sealed_by: { pinned: number; assert: number; webhook: number; owner: number; unauthenticated: number; unstamped: number };
    /** agent events whose actor was NOT fixed by a pinned credential (owner-asserted, unauthenticated, or unstamped): WHO is producer testimony there */
    agent_events_not_pinned: number;
    /** /1-signed git commit seals (absent format = /1). Unsigned commit seals are not counted. */
    legacy_client: number;
    owner_login_events: OwnerLoginStats;
  };
  causality: { eligible_events: number; rooted_in_human_instruction: number; attested_events: number; sibling_corroborated: number; broken_links: number; unlinked: number; coverage_pct: number };
  actors: StatusActor[];
  integrations: StatusIntegration[];
  /** Credential issuance for this project (from RETRACE_CREDENTIALS). Absent when the handler has no credential list. */
  issuance?: ProjectIssuanceStatus;
  /** §8: none | env_fallback when the project has no document; document + digest when it does. */
  policy?: { mode: "none" | "env_fallback" | "document"; digest?: string; version?: number };
  routing?: { repo: string; source: "policy" | "env_fallback" | "revoked" | "unresolved" }[];
  export_cache?: ExportCacheStatus;
};

export async function buildProjectStatus(
  store: EventStore,
  project: string,
  now = new Date(),
  attributionOptions?: AttributionOptions,
  credentials?: IssuanceCredential[],
  extras?: { githubRepoProjects?: Record<string, string> },
): Promise<ProjectStatus> {
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
    // The later instant, not the later string (issue #227); the stored last_seen stays as written. A timestamp outside the
    // grammar never replaces it: the schema refuses those at append (none in the ledger, measured 2026-10-12).
    actor.events++; if ((instantOrder(e.timestamp, actor.last_seen) ?? 0) > 0) actor.last_seen = e.timestamp;
    if (a.model && !actor.models.includes(a.model)) actor.models.push(a.model);
    if(view.amended) { actor.amended_from ??= []; if(!actor.amended_from.some(a=>a.type===e.actor.type&&a.id===e.actor.id))actor.amended_from.push({type:e.actor.type,id:e.actor.id}); }
    actors.set(ak, actor);
    const system = e.location?.system;
    if (system) {
      const integration = integrations.get(system) ?? { system, events: 0, last_seen: e.timestamp };
      integration.events++; if ((instantOrder(e.timestamp, integration.last_seen) ?? 0) > 0) integration.last_seen = e.timestamp;
      integrations.set(system, integration);
    }
  }
  // read ONCE: corroboration, owner-login labels and the reported policy digest/version all use this document
  const policy = store.getPolicy ? await store.getPolicy(project, { current: true }) : null;
  const isRooted = (e: Event) => causalRootState(e, byId) === "rooted";
  const amendments = collectProvenanceAmendments(events, isRooted);
  const rejectedAmendments = collectRejectedAmendments(events, isRooted);
  const attested = new Set(eligible.filter((e) => causalRootState(e, byId) !== "rooted" && amendments.get(e.id)?.some((a) => a.attest_causal_root)).map((e) => e.id));
  const commitSeals = events.filter((e) => e.action === "committed" || e.action === "merged");
  // Sibling corroboration (see the field comment on `sibling_corroborated`). Producer eligibility comes from the current
  // project policy, the same boundary reconcile.ts draws: the exact trusted hook stamp, or the HMAC-verified GitHub
  // webhook. Everything else is a claim. Without a policy no record corroborates another.
  const trustedHookStamps = new Set(policy?.body.trusted_hook_stamps ?? []);
  const producerOf = (e: Event): "hook" | "webhook" | undefined => {
    const stamp = e.method?.params?.[SEALED_BY_PARAM];
    if (typeof stamp !== "string") return undefined;
    if (stamp === "webhook:github") return "webhook";
    if (trustedHookStamps.has(stamp)) return "hook";
    return undefined;
  };
  const fullSha = (e: Event) => { const h = e.change?.after_hash; return typeof h === "string" && /^[0-9a-f]{40}$/i.test(h) ? h.toLowerCase() : undefined; };
  const canonicalRepo = (name: string): string | undefined => policy ? canonicalRepositoryR(policy.body, name) ?? canonicalGithubRepo(name) : undefined;
  const commitKey = (e: Event): string | undefined => {
    const sha = fullSha(e);
    if (!sha) return undefined;
    for (const a of e.artifacts) {
      const m = /^commit:([^@\s]+)@([0-9a-f]{7,40})$/i.exec(a.id);
      if (!m || !sha.startsWith(m[2].toLowerCase())) continue;
      const repo = canonicalRepo(m[1]);
      if (repo) return `${repo}@${sha}`;
    }
    return undefined;
  };
  const corroboratingProducers = new Map<string, Set<"hook" | "webhook">>();
  for (const e of commitSeals) {
    if (!(causalRootState(e, byId) === "rooted" || attested.has(e.id))) continue;
    const producer = producerOf(e);
    const key = commitKey(e);
    if (!producer || !key) continue;
    if (!corroboratingProducers.has(key)) corroboratingProducers.set(key, new Set());
    corroboratingProducers.get(key)!.add(producer);
  }
  const siblingCorroborated = commitSeals.filter((e) => {
    if (causalRootState(e, byId) !== "unlinked" || attested.has(e.id)) return false;
    const producer = producerOf(e);
    const key = commitKey(e);
    const others = key ? corroboratingProducers.get(key) : undefined;
    return !!producer && !!others && [...others].some((p) => p !== producer);
  }).length;
  const amendedRoles = new Set<string>();
  for (const [targetId, list] of amendments) for (const amendment of list) for (const index of amendment.artifact_roles.keys()) amendedRoles.add(`${targetId}:${index}`);
  const artifactRefs = events.flatMap((e) => e.artifacts.map((a, index) => ({ event: e, artifact: a, index })));
  const instructions = events.filter((e) => e.actor.type === "human" && e.action === "instructed");
  const commits = events.filter((e) => e.action === "committed" || e.action === "merged");
  const rooted = count("rooted");
  const sealedBy = { pinned: 0, assert: 0, webhook: 0, owner: 0, unauthenticated: 0, unstamped: 0 };
  for (const e of events) sealedBy[sealedByKind(e.method?.params?.[SEALED_BY_PARAM])]++;
  const agentEvents = events.filter((e) => e.actor.type === "agent");
  const agent_events_by_model_source = emptySourceCounts();
  const agent_events_without_model_by_cause = { source_none: 0, no_source_recorded: 0 };
  for (const e of agentEvents) {
    const source = e.actor.model_source;
    agent_events_by_model_source[source === undefined ? NO_SOURCE_RECORDED : source]++;
    if (!actorModelPresent(e.actor.model)) {
      if (source === "none") agent_events_without_model_by_cause.source_none++;
      else agent_events_without_model_by_cause.no_source_recorded++;
    }
  }
  return {
    project,
    generated_at: now.toISOString(),
    integrity,
    events: { total: events.length, last_event_at: events.at(-1)?.timestamp },
    capture: {
      owner_login_events: await ownerLoginStats(store, events, policy),
      artifact_refs: artifactRefs.length,
      artifact_refs_without_role: artifactRefs.filter(({ event, artifact, index }) => artifact.role === undefined && !amendedRoles.has(`${event.id}:${index}`)).length,
      amended_artifact_refs: amendedRoles.size,
      agent_events: agentEvents.length,
      agent_events_without_model: agentEvents.filter((e) => !actorModelPresent(e.actor.model)).length,
      agent_events_by_model_source,
      agent_events_without_model_by_cause,
      instructions: instructions.length,
      instructions_without_followup: instructions.filter((e) => !caused.has(e.id)).length,
      commits: commits.length,
      commit_shas: commitShaCount(commits),
      unlinked_commits: commits.filter((e) => causalRootState(e, byId) !== "rooted" && !attested.has(e.id)).length,
      amended_unlinked_commits: commits.filter((e) => attested.has(e.id)).length,
      sibling_corroborated: siblingCorroborated,
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
      sibling_corroborated: siblingCorroborated,
      broken_links: eligible.filter((e) => causalRootState(e, byId) === "broken" && !attested.has(e.id)).length,
      unlinked: eligible.filter((e) => causalRootState(e, byId) === "unlinked" && !attested.has(e.id)).length,
      coverage_pct: eligible.length ? Math.round((rooted + attested.size) * 1000 / eligible.length) / 10 : 100,
    },
    actors: [...actors.values()].map((a) => ({ ...a, models: a.models.sort() })).sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id)),
    integrations: [...integrations.values()].sort((a, b) => a.system.localeCompare(b.system)),
    ...(credentials !== undefined ? { issuance: projectIssuanceStatus(credentials, project) } : {}),
    ...(await projectPolicyStatus(store, project, policy, extras?.githubRepoProjects)),
  };
}

/** `doc` is the ONE policy document this status was computed under (sibling corroboration, owner-login labels): the
 *  reported digest/version must be that document, never a second read that a rotation could have moved. */
async function projectPolicyStatus(
  store: EventStore,
  project: string,
  doc: Awaited<ReturnType<NonNullable<EventStore["getPolicy"]>>>,
  githubRepoProjects?: Record<string, string>,
): Promise<Pick<ProjectStatus, "policy" | "routing">> {
  const envRepos = Object.entries(githubRepoProjects ?? {})
    .filter(([, p]) => p === project)
    .map(([repo]) => canonicalGithubRepo(repo));
  const routing: NonNullable<ProjectStatus["routing"]> = [];
  const seen = new Set<string>();
  for (const repo of envRepos) {
    const route = store.getPolicyRoute ? await store.getPolicyRoute(repo) : null;
    const decision = routeGithubDelivery({
      fullName: repo,
      route,
      envProject: project,
      envProjectHasDocument: !!doc,
    });
    if (decision.kind === "routed" && decision.project !== project) continue;
    seen.add(repo);
    if (decision.kind === "routed")
      routing.push({ repo, source: decision.source === "policy" ? "policy" : "env_fallback" });
    else
      routing.push({ repo, source: decision.reason === "revoked" ? "revoked" : "unresolved" });
  }
  const ownRoutes = store.listPolicyRoutes ? await store.listPolicyRoutes(project) : [];
  for (const r of ownRoutes) {
    if (seen.has(r.repo)) continue;
    seen.add(r.repo);
    routing.push({ repo: r.repo, source: r.state === "revoked" ? "revoked" : "policy" });
  }
  const hasEnvFallback = routing.some((r) => r.source === "env_fallback");
  const policy = doc
    ? { mode: "document" as const, digest: doc.digest, version: doc.envelope.version }
    : hasEnvFallback
      ? { mode: "env_fallback" as const }
      : { mode: "none" as const };
  return { policy, routing };
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
    export_cache: status.export_cache && {
      ...status.export_cache,
      last_refresh: status.export_cache.last_refresh && {
        ...status.export_cache.last_refresh,
        ...(status.export_cache.last_refresh.error !== undefined
          ? { error: markUntrustedText(status.export_cache.last_refresh.error) }
          : {}),
      },
    },
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

function siblingCorroborationLine(s: ProjectStatus): string {
  if (s.policy?.mode === "none") {
    return "sibling corroboration: disabled, no policy (read-time, roots nothing; a project policy names the trusted hook stamp)\n";
  }
  if (s.policy?.mode === "env_fallback") {
    return "sibling corroboration: disabled, environment fallback routes only (read-time, roots nothing; no trusted stamps, no policy document)\n";
  }
  return `sibling corroboration (read-time, roots nothing): ${s.capture.sibling_corroborated ?? 0} unlinked commit seals whose commit the other authenticated producer sealed with a rooted chain; still counted in unlinked\n`;
}

export function renderProjectStatus(s: ProjectStatus): string {
  const health = s.integrity.ok ? "VERIFIED" : "BROKEN";
  const byCause = s.capture.agent_events_without_model_by_cause;
  const sourceParts = MODEL_SOURCE_ORDER
    .filter((key) => (s.capture.agent_events_by_model_source[key] ?? 0) > 0)
    .map((key) => `${key} ${s.capture.agent_events_by_model_source[key]}`);
  const exportCache = s.export_cache
    ? `export cache: ${[
      s.export_cache.state,
      ...(s.export_cache.cached_head_seq === undefined ? [] : [`cached head ${s.export_cache.cached_head_seq}`]),
      ...(s.export_cache.age_seconds === undefined ? [] : [`age ${s.export_cache.age_seconds}s`]),
      ...(s.export_cache.live_head_seq === undefined ? [] : [`live head ${s.export_cache.live_head_seq}`]),
      ...(s.export_cache.last_refresh
        ? [`last refresh ${s.export_cache.last_refresh.result} at ${s.export_cache.last_refresh.attempted_at}`]
        : []),
    ].join(" · ")}\n`
    : "";
  return `${markUntrustedText(s.project)} — ${health}\n` +
    `${s.events.total} events · ${s.causality.coverage_pct}% causal coverage · ${s.capture.unlinked_commits}/${s.capture.commits} unlinked commit seals · ${s.capture.commit_shas} distinct commit shas · ${s.capture.unverified_links} unverified links · ${s.capture.legacy_client} legacy-client seals\n` +
    `${s.capture.agent_events_without_model}/${s.capture.agent_events} agent events missing model (${byCause.source_none} declared none · ${byCause.no_source_recorded} no source recorded) · ${s.capture.instructions_without_followup}/${s.capture.instructions} instructions without follow-up · ${s.capture.artifact_refs_without_role}/${s.capture.artifact_refs} artifact refs missing role\n` +
    (sourceParts.length ? `model sources: ${sourceParts.join(" · ")}\n` : "") +
    `append-only amendments: ${s.capture.amended_unlinked_commits} commits attested · ${s.capture.amended_artifact_refs} artifact roles supplied · ${s.capture.ineffective_amendments} rejected links\n` +
    siblingCorroborationLine(s) +
    (s.capture.owner_login_events ? `GitHub owner-login events: ${s.capture.owner_login_events.sealed_as_human} sealed human · read-time: ${s.capture.owner_login_events.read_time_labels.declared_by_seat} declared-by-seat · ${s.capture.owner_login_events.read_time_labels.conflicting} conflicting · ${s.capture.owner_login_events.read_time_labels.unresolved} unresolved (computed at read, not sealed) · ${s.capture.owner_login_events.legacy_unknown_login} legacy unknown login · identity-mapped ${s.capture.owner_login_events.by_status.identity_mapped} (current policy identities, separate scope)\n` : "") +
    `sealed by: ${s.capture.sealed_by.pinned} pinned · ${s.capture.sealed_by.assert} assert · ${s.capture.sealed_by.webhook} webhook · ${s.capture.sealed_by.owner} owner-asserted · ${s.capture.sealed_by.unauthenticated} unauthenticated · ${s.capture.sealed_by.unstamped} unstamped; ${s.capture.agent_events_not_pinned}/${s.capture.agent_events} agent events not pinned\n` +
    (s.capture.attribution_unavailable ? `attribution evaluation unavailable: ${s.capture.attribution_unavailable} (${s.capture.attribution_attempts ?? 0} attempts)\n` : `attribution amendments: ${s.capture.attribution_amendments ?? 0} effective · ${s.capture.superseded_attribution_amendments ?? 0} superseded · ${s.capture.partially_amended_events ?? 0} partially amended events\n`) +
    exportCache +
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
