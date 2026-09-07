/** Derived attribution only. Never mutate sealed event bodies or trust a stored effectiveness flag. */
import type { Actor, Event, EventInput } from "./schema.js";
import { actorKey, sameActor, sameArtifact, generatesArtifact } from "./capture.js";

import { isVerifiedAttributionSnapshot, type AttributionSnapshot, type AttributionCaptureContext } from "./attribution-context.js";

export type ActorRef = Pick<Actor, "type" | "id">;
export interface AttributionAmendment {
  amendment_id: string; seq: number; target_id: string;
  from: ActorRef; to: ActorRef; artifacts: string[]; whole_event: boolean;
  tier: "human"; evidence: string[]; reason: string;
  matches: Record<string, string[]>;
  flags: { human_corroborated?: boolean; trailer_corroborated?: boolean; content_bound?: boolean };
  supersedes?: string;
}
export type AttributionReason = "unrooted" | "missing_target" | "wrong_project" | "not_older" | "malformed" |
  "relay_disabled" | "human_beneficiary_unsupported" | "untrusted_authority" | "target_is_amendment" | "target_is_instruction" |
  "scope_invalid" | "no_op" | "unknown_actor" | "stale_from" | "no_supersede" | "uncorroborated" | "partial_coverage" | "evidence_amended";
export interface AttributionOptions {
  snapshot?: AttributionSnapshot;
  context?: AttributionCaptureContext;
  trailerCorroborated?: (target: Event, evidence: Event[], to: ActorRef) => boolean;
  contentBoundArtifacts?: (target: Event, evidence: Event[]) => string[];
}
export type AttributionCollection = { effective: Map<string, AttributionAmendment[]>; superseded: AttributionAmendment[]; rejected: { event: Event; reason: AttributionReason }[]; unavailable?: string; context?: AttributionCaptureContext };
type CheckResult = { ok: true; tier: "human"; flags: AttributionAmendment["flags"]; whole_event: boolean; amendment: AttributionAmendment } | { ok: false; reason: AttributionReason };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ref = (v: unknown): v is ActorRef => object(v) && ["agent", "human", "system"].includes(String(v.type)) && typeof v.id === "string" && !!v.id && Object.keys(v).every(k => k === "type" || k === "id");
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === "string" && !!x) && new Set(v).size === v.length;
export const isAttributionAmendment = (e: Event): boolean => e.action === "other" && e.action_detail === "amended" && (e.method?.params?.attribution !== undefined || e.tags?.includes("attribution") === true);

export function attributionRooted(e: Event, events: Event[]): boolean {
  const byId = new Map(events.map(x => [x.id, x])); const seen = new Set<string>(); let cur: Event | undefined = e;
  while (cur && !seen.has(cur.id)) {
    if (cur.project !== e.project) return false;
    if (cur.actor.type === "human" && cur.action === "instructed") return true;
    seen.add(cur.id); const next: Event | undefined = cur.caused_by ? byId.get(cur.caused_by) : undefined;
    if (next && next.seq >= cur.seq) return false;
    cur = next;
  }
  return false;
}

export interface AttributionRequest {
  project: string; target_event_id: string; to: ActorRef; from?: ActorRef;
  artifacts?: string[]; evidence: string[]; supersedes?: string; caused_by: string; reason: string;
}
interface Attempt {
  input: Pick<Event, "project" | "actor" | "action" | "action_detail" | "artifacts" | "intent" | "caused_by" | "method" | "tags">;
  key: string;
  position: { kind: "sealed"; seq: number } | { kind: "after_head"; seq: number; hash: string };
  authority?: string;
}
const beforeAttempt = (e: Event, a: Attempt) => a.position.kind === "sealed" ? e.seq < a.position.seq : e.seq <= a.position.seq;
const sealedAttempt = (e: Event): Attempt => ({input:e,key:e.id,position:{kind:"sealed",seq:e.seq},authority:typeof e.method?.params?.sealed_by === "string" ? e.method.params.sealed_by : undefined});

/** One private checker; callers cannot inject an effective-state map. */
function checkCandidate(attempt: Attempt, events: Event[], options: AttributionOptions, state: { effective: Map<string, AttributionAmendment[]> }): CheckResult {
  const candidate = attempt.input;
  const fail = (reason: AttributionReason): CheckResult => ({ ok: false, reason });
  const params = candidate.method?.params;
  const raw = params?.attribution;
  if (!(candidate.action === "other" && candidate.action_detail === "amended") || !object(raw) || !ref(raw.from) || !ref(raw.to) || !Array.isArray(raw.evidence) || !raw.evidence.every(x=>typeof x === "string" && !!x) ||
      Object.keys(raw).some(k => !["from", "to", "artifacts", "evidence", "supersedes"].includes(k)) ||
      (raw.supersedes !== undefined && typeof raw.supersedes !== "string") || params?.artifact_roles !== undefined || params?.attest_causal_root !== undefined) return fail("malformed");
  if (!candidate.intent?.trim() || !candidate.artifacts.some(a=>a.id===`event:${params?.target_event_id}`&&a.role==="used") ||
      raw.evidence.some(id=>!candidate.artifacts.some(a=>a.id===`event:${id}`&&a.role==="used"))) return fail("malformed");
  const cause = events.find(e => e.id === candidate.caused_by);
  if (!cause || cause.project !== candidate.project || !beforeAttempt(cause,attempt) || !attributionRooted(cause, events)) return fail("unrooted");
  const target = events.find(e => e.id === params?.target_event_id);
  if (!target) return fail("missing_target");
  if (target.project !== candidate.project) return fail("wrong_project");
  if (!beforeAttempt(target,attempt)) return fail("not_older");
  if (target.action_detail === "amended") return fail("target_is_amendment");
  if (target.action === "instructed") return fail("target_is_instruction");
  if (candidate.actor.type !== "human") return fail("relay_disabled");
  const authority = attempt.authority;
  if (!(authority === "owner" || typeof authority === "string" && /^(assert:|pinned:)/.test(authority))) return fail("untrusted_authority");
  if (raw.to.type === "human") return fail("human_beneficiary_unsupported");
  if (sameActor(raw.from, raw.to)) return fail("no_op");
  const domain = options.context!.domains.get(target.id)!;
  const canonical = options.context!.canonicalArtifact;
  const artifacts = raw.artifacts === undefined ? domain.units.map(u => u.id) :
    Array.isArray(raw.artifacts) && raw.artifacts.every(x => typeof x === "string") ? [...new Set(raw.artifacts.map(id => canonical(id, target.seq)))].sort() : [];
  if (!strings(artifacts) || artifacts.some(id => !domain.units.some(u => u.id === id))) return fail("scope_invalid");
  const project = events.filter(e => e.project === candidate.project && beforeAttempt(e,attempt));
  if (!project.some(e => sameActor(e.actor, raw.to as ActorRef) && /^(pinned:|assert:|webhook:)/.test(String(e.method?.params?.sealed_by ?? "")))) return fail("unknown_actor");
  const prior = state.effective.get(target.id) ?? [];
  const overlap = prior.filter(a => a.artifacts.some(id => artifacts.includes(id))).sort((a,b) => b.seq - a.seq);
  // Supersession must name the latest effective intersecting amendment, including after a retroactive cascade.
  if (overlap.length ? raw.supersedes !== overlap[0].amendment_id : raw.supersedes !== undefined) return fail("no_supersede");
  if (overlap.length > 1) return fail("no_supersede"); // one explicit successor cannot silently replace disjoint chains
  if (artifacts.some(id => !sameActor(prior.find(a => a.artifacts.includes(id))?.to ?? target.actor, raw.from as ActorRef))) return fail("stale_from");
  const evidence = raw.evidence.map(id => project.find(e => e.id === id));
  const refs = evidence.filter((e): e is Event => !!e);
  let covered = 0; let amendedEvidence = false; const covering: Event[] = [];
  const evidenceMatches: Record<string, string[]> = {};
  for (const id of artifacts) {
    const unit = domain.units.find(u => u.id === id)!;
    const { after, before } = unit;
    const matches = refs.filter(e => e.seq > after && e.seq < before && sameActor(e.actor, raw.to as ActorRef) &&
      /^(pinned:|assert:)/.test(String(e.method?.params?.sealed_by ?? "")) && e.artifacts.some(a => unit.names.includes(canonical(a.id, e.seq) ?? "") && generatesArtifact(e, a)));
    const valid = matches.filter(e => !state.effective.get(e.id)?.length);
    if (valid.length) { covered++; covering.push(...valid); evidenceMatches[id] = valid.map(e => e.id).sort(); }
    else if (matches.length) amendedEvidence = true;
  }
  if (covered !== artifacts.length) return fail(amendedEvidence ? "evidence_amended" : covered ? "partial_coverage" : "uncorroborated");
  const flags: AttributionAmendment["flags"] = {};
  const commits = target.artifacts.filter(a => a.id.startsWith("commit:")).map(a => a.id);
  if (refs.some(e => e.actor.type === "human" && e.tags?.includes("correction") && e.artifacts.some(a => commits.includes(a.id)) &&
      (e.method?.params?.attributed_to === (raw.to as ActorRef).id || e.artifacts.some(a => a.id === `actor:${(raw.to as ActorRef).id}`)))) flags.human_corroborated = true;
  if (options.trailerCorroborated?.(target,refs,raw.to)) flags.trailer_corroborated = true;
  const bound = options.contentBoundArtifacts?.(target, covering) ?? [];
  if (artifacts.every(id => bound.includes(id))) flags.content_bound = true;
  const whole_event = domain.complete && artifacts.length === domain.units.length;
  const amendment: AttributionAmendment = { amendment_id: attempt.key, seq: attempt.position.kind === "sealed" ? attempt.position.seq : -1, target_id: target.id, from: raw.from, to: raw.to, artifacts, whole_event, tier: "human", evidence: [...new Set(raw.evidence)].sort(), reason: candidate.intent ?? "", flags, matches: evidenceMatches, ...(typeof raw.supersedes === "string" ? { supersedes: raw.supersedes } : {}) };
  return { ok: true, tier: "human", flags, whole_event, amendment };
}

export function collectAttributionAmendments(events: Event[], isRooted: (e: Event) => boolean = e => attributionRooted(e, events), options: AttributionOptions = {}): AttributionCollection {
  const effective = new Map<string, AttributionAmendment[]>(); const superseded: AttributionAmendment[] = []; const rejected: AttributionCollection["rejected"] = [];
  const unavailable = (reason: string): AttributionCollection => ({ effective, superseded, rejected, unavailable: reason });
  if (!events.some(isAttributionAmendment)) return { effective, superseded, rejected };
  if (!isVerifiedAttributionSnapshot(options.snapshot)) return unavailable("untrusted_snapshot");
  const snapshot = options.snapshot;
  const suppliedIds=new Set(events.map(e=>e.id));
  if (suppliedIds.size !== snapshot.events.length || events.some(e => !snapshot.events.some(x => x.id === e.id && x.hash === e.hash))) return unavailable("incomplete_snapshot");
  const verifiedById=new Map(snapshot.events.map(e=>[e.id,e]));
  // Preserve caller permutation while evaluating immutable verified bodies; the replay sort must do real work.
  events = [...new Map(events.map(e=>[e.id,verifiedById.get(e.id)!])).values()];
  const context = options.context;
  if (!context) return unavailable("context_missing");
  if (context.project !== snapshot.project || context.head_seq !== snapshot.head.seq || context.head_hash !== snapshot.head.hash) return unavailable("context_conflict");
  const byId = new Map(events.map(e => [e.id, e]));
  for (const e of events.filter(isAttributionAmendment)) {
    const target = byId.get(String(e.method?.params?.target_event_id));
    if (target && !context.domains.has(target.id)) return unavailable("context_missing");
  }
  const targetSeq = (e: Event) => byId.get(String(e.method?.params?.target_event_id))?.seq ?? Infinity;
  const candidates = events.filter(isAttributionAmendment).sort((a,b) => targetSeq(a) - targetSeq(b) || a.seq - b.seq || a.id.localeCompare(b.id));
  for (const event of candidates) {
    const result = checkCandidate(sealedAttempt(event), events, options, { effective });
    if (!result.ok) { rejected.push({ event, reason: result.reason }); continue; }
    const a = result.amendment;
    superseded.push(...(effective.get(a.target_id) ?? []).filter(p => p.amendment_id === a.supersedes));
    effective.set(a.target_id, [...(effective.get(a.target_id) ?? []).filter(p => p.amendment_id !== a.supersedes), a]);
  }
  return { effective, superseded, rejected, context };
}

/** Check a sealed record through the identical final-snapshot replay. */
export function checkAttributionAmendment(candidate: Event, events: Event[], options: AttributionOptions): CheckResult {
  const result = collectAttributionAmendments(events, undefined, options);
  if (result.unavailable) throw new Error(`attribution evaluation unavailable: ${result.unavailable}`);
  const rejected = result.rejected.find(r => r.event.id === candidate.id);
  if (rejected) return {ok:false,reason:rejected.reason};
  const amendment = [...result.effective.values()].flat().concat(result.superseded).find(a => a.amendment_id === candidate.id);
  return amendment ? {ok:true,tier:"human",flags:amendment.flags,whole_event:amendment.whole_event,amendment} : {ok:false,reason:"malformed"};
}

/** Advisory after-head replay: no event ID, server timestamp, hash or seal is fabricated. */
export function preflightAttributionAmendment(request: AttributionRequest, authority: {actor: Actor; sealed_by: string}, options: AttributionOptions): {input: EventInput; result: CheckResult; affected: string[]} {
  if (!isVerifiedAttributionSnapshot(options.snapshot) || !options.context) throw new Error("attribution evaluation unavailable: context_missing");
  const snapshot = options.snapshot, events = snapshot.events;
  const current = collectAttributionAmendments(events, undefined, options);
  if (current.unavailable) throw new Error(`attribution evaluation unavailable: ${current.unavailable}`);
  const target = events.find(e => e.id === request.target_event_id);
  const domain = target ? options.context.domains.get(target.id) : undefined;
  const scope = request.artifacts ?? domain?.units.map(u => u.id);
  if (!scope) throw new Error("scope_invalid: explicit scope required for a missing target");
  const canonicalScope = scope.map(id => options.context!.canonicalArtifact(id,target?.seq ?? snapshot.head.seq) ?? id);
  const owners = target ? canonicalScope.map(id => current.effective.get(target.id)?.find(a => a.artifacts.includes(id))?.to ?? target.actor) : [];
  const from = request.from ?? (owners.length && owners.every(a => sameActor(a,owners[0])) ? {type:owners[0].type,id:owners[0].id} : undefined);
  if (!from) throw new Error("stale_from: supply an explicit from identity or narrow the scope");
  const payload = {from,to:request.to,artifacts:[...new Set(canonicalScope)].sort(),evidence:request.evidence,...(request.supersedes ? {supersedes:request.supersedes} : {})};
  const input: EventInput = {project:request.project,actor:authority.actor,action:"other",action_detail:"amended",artifacts:[{id:`event:${request.target_event_id}`,role:"used"},...request.evidence.map(id => ({id:`event:${id}`,role:"used" as const}))],intent:request.reason,caused_by:request.caused_by,tags:["amendment","attribution"],method:{tool:"retrace_amend",automated:false,params:{target_event_id:request.target_event_id,attribution:payload}}};
  const pending: Attempt = {input,key:"candidate",position:{kind:"after_head",...snapshot.head},authority:authority.sealed_by};
  // Earlier targets are finalized; same target uses the active prefix at the observed head.
  const effective = new Map(current.effective);
  const result = checkCandidate(pending,events,options,{effective});
  const affected: string[] = [];
  if (result.ok && target) {
    effective.set(target.id,[...(effective.get(target.id) ?? []).filter(a => a.amendment_id !== result.amendment.supersedes),result.amendment]);
    // Re-evaluate later targets to expose downstream witness withdrawal without appending a fake event.
    const later = events.filter(isAttributionAmendment).filter(e => (events.find(t => t.id === e.method?.params?.target_event_id)?.seq ?? -1) > target.seq)
      .sort((a,b) => events.find(t => t.id === a.method?.params?.target_event_id)!.seq - events.find(t => t.id === b.method?.params?.target_event_id)!.seq || a.seq-b.seq);
    for (const e of later) effective.delete(String(e.method?.params?.target_event_id));
    for (const e of later) {
      const checked = checkCandidate(sealedAttempt(e),events,options,{effective});
      if (checked.ok) { const a=checked.amendment; effective.set(a.target_id,[...(effective.get(a.target_id) ?? []).filter(p => p.amendment_id !== a.supersedes),a]); }
      const was = [...current.effective.values()].flat().some(a => a.amendment_id === e.id);
      if (was !== checked.ok) affected.push(e.id);
    }
  }
  return {input,result,affected};
}

export function effectiveActor(e: Event, amendments: Map<string, AttributionAmendment[]>) {
  const list = amendments.get(e.id) ?? [];
  const actorFor = (a: AttributionAmendment): Actor => ({ ...a.to, ...(e.actor.on_behalf_of ? { on_behalf_of: e.actor.on_behalf_of } : {}) });
  const amended = list.find(a => a.whole_event);
  const by_artifact = new Map<string, { actor: Actor; amended: AttributionAmendment }>();
  for (const a of list) for (const id of a.artifacts) by_artifact.set(id, { actor: actorFor(a), amended: a });
  return { actor: amended ? actorFor(amended) : e.actor, recorded: e.actor, amended, by_artifact };
}

export function attributionSummary(events: Event[], collection = collectAttributionAmendments(events)): string {
  if (collection.unavailable) return `attribution evaluation unavailable: ${collection.unavailable} (${events.filter(isAttributionAmendment).length} attempts present)`;
  return `attribution amendments: ${[...collection.effective.values()].flat().length} effective · ${collection.rejected.length} ineffective · ${collection.superseded.length} superseded`;
}
export { actorKey, sameActor, sameArtifact };
