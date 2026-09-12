/**
 * Step 3 — classifyCommitClaim under RETRACE_TRAILER_POLICY=shadow.
 *
 * Design text (commit-trailer-consistency.md v2.5.1, project-policy-document.md v4.2) wins over
 * the builder brief. Shadow records `claim_decision` and leaves `actor` unchanged
 * (`actor_written: "claim"`, `shadow: true`). Nothing is withheld; 426 is not introduced here.
 */
import {
  collectAttributionAmendments, type AttributionAmendment, type AttributionCollection,
} from "./attribution.js";
import {
  isAttributionAmendment, verifiedAttributionSnapshot,
  type AttributionCaptureContext, type AttributionDomain, type AttributionSnapshot, type AttributionUnit,
} from "./attribution-context.js";
import { canonicalize, sha256Hex } from "./chain.js";
import {
  CommitActorResolution, resolveCommitActor, validCausedById,
} from "./commit-actor.js";
import { actorKey, captureSeals, generatesArtifact, previousCaptureTouch, sameArtifact } from "./capture.js";
import {
  ARTIFACT_INDEX_DEFAULT_ROW_CAP, ArtifactIndexResult, CausedByProblem, EventStore,
  SEALED_BY_GITHUB_WEBHOOK, SEALED_BY_PARAM, causedByProblem, eventsReferencingArtifactKeys,
} from "./store.js";
import { GENESIS_HASH } from "./schema.js";
import type { Actor, Event, EventInput } from "./schema.js";
import {
  canonicalGithubRepo, canonicalRepositoryR, contextKey, documentMapKey, selectPolicyForContext,
  type PolicyBody, type PolicyDocument, type PolicySnapshot,
} from "./policy.js";
import {
  CLAIM_DECISION_PARAM, TrailerPolicy,
  isGitCommitSeal, isLegacyClientCommitSeal, parseTrailerPolicy,
} from "./producer-sig.js";

export const CLASSIFIER_PROFILE = "trailer-consistency/1";
export const CLASSIFY_DEADLINE_MS = 500;
export const CLASSIFY_ROW_CAP = ARTIFACT_INDEX_DEFAULT_ROW_CAP;
export const BREAKER_CONSECUTIVE_FAILURES = 3;
export const BREAKER_WINDOW_MS = 5 * 60 * 1000;
export const BREAKER_OPEN_MS = 5 * 60 * 1000;
export const BREAKER_PROBE_LEASE_MS = 60_000;
export const PENDING_LEASE_MS = 60_000;
export const PENDING_BUDGET_ATTEMPTS = 3;

/** Fail closed: a store that cannot persist/serve classification context must not pretend there is none. */
export class ClassificationStoreError extends Error {
  readonly reason = "store_error" as const;
  constructor(message = "classification context store is not available") {
    super(message);
    this.name = "ClassificationStoreError";
  }
}

/** Hook-queued-loud: missing policy, over-budget read, or store error. Remote 503 already retries. */
export class ClassificationUnavailableError extends Error {
  readonly kind = "unavailable" as const;
  constructor(
    public readonly reason: "deadline" | "budget" | "store_error" | "policy_missing",
    message?: string,
  ) {
    super(message ?? `classification unavailable: ${reason}`);
    this.name = "ClassificationUnavailableError";
  }
}

export type ClaimSource = CommitActorResolution["claimSource"];
export type DecisionStatus =
  | "supported"
  | "conflicting"
  | "unresolved"
  | "human_claim_with_agent_evidence"
  | "no_agent_evidence"
  | "merge_unclassified";
export type DecisionReason =
  | "no_match"
  | "malformed_claim"
  | "loose_evidence_only"
  | "root_only"
  | "unrooted"
  | "no_authenticated_ingress";
export type ActorWritten = "claim" | "withheld";
export type ProducerKind = "git-hook" | "github-push";

export interface ClaimRecord {
  type: Actor["type"];
  id: string;
  source: ClaimSource;
  model?: string;
  raw_trailers: { "retrace-actor"?: string; "co-authored-by"?: string[] };
}

export interface CausedByRecord {
  id?: string;
  source: "trailer" | "env" | "file" | "none";
  root?: { id: string; action: string; actor: { type: string; id: string } };
  problem?: CausedByProblem | "cyclic";
}

export interface WitnessRecord {
  id: string;
  seq: number;
  actor: { type: string; id: string };
  paths: string[];
  sealed_by: string;
  producer_sig_verdict?: string;
  client?: string;
}

export interface WouldWrite {
  actor_written: ActorWritten;
  reason?: DecisionReason | "unresolved_policy";
}

export interface ClaimDecision {
  policy: typeof CLASSIFIER_PROFILE;
  observer: { producer: ProducerKind; sealed_by: string };
  claim: ClaimRecord;
  caused_by: CausedByRecord;
  signed_actor?: { type: Actor["type"]; id: string; on_behalf_of?: string };
  decision: {
    status: DecisionStatus;
    reason?: DecisionReason;
    actor_written: ActorWritten;
    unresolved_policy: "record" | "withhold";
    shadow: true;
    would_write: WouldWrite;
    context: {
      read_head_seq: number;
      read_head_hash: string;
      policy_digest: string;
      first_producer: ProducerKind;
      first_F_digest: string;
      first_claim_digest: string;
    };
    submitted: { F_digest: string; parents: string[]; raw_message_param: "method.params.raw_message" };
    window: { upper_seq: number; per_path_lower: Record<string, number> };
    witnesses: WitnessRecord[];
    witness_actors: { type: string; id: string }[];
    loose_hints: number;
    harness: { marker?: string; marker_actor?: string; witness_clients: string[]; mismatch: boolean };
    /** Server-derived elapsed ms. Informational; never a selector. */
    classification_ms: number;
  };
}

export interface ClassificationContextRow {
  project: string;
  canonical_repo: string;
  sha: string;
  read_head_seq: number;
  read_head_hash: string;
  policy_digest: string;
  first_producer: ProducerKind;
  first_F_digest: string;
  first_claim_digest: string;
  classifier_profile: string;
  rollout_mode: string;
  amendment_snapshot: string;
  per_path_lower: Record<string, number>;
  legacy_client_decision?: string | null;
  created_at: string;
}

export interface BreakerRow {
  project: string;
  state: "closed" | "open";
  failures: number;
  failure_window_start: string | null;
  last_failure_at: string | null;
  opened_at: string | null;
  probe_lease_until: string | null;
  probe_lease_owner: string | null;
}

export type ClassifyResult =
  | { kind: "decision"; record: ClaimDecision }
  | { kind: "legacy"; record: ClaimDecision }
  | { kind: "skip"; reason: "not_commit" | "policy_off" }
  | { kind: "unavailable"; reason: "deadline" | "budget" | "store_error" | "policy_missing" };

const REPO_ARTIFACT = /^repo:([^#]+)#(.+)$/;
const WRITING_ACTIONS = new Set(["created", "edited", "deleted", "renamed", "moved"]);
const NON_WITNESS_ACTIONS = new Set(["instructed", "committed", "merged"]);

export function contextKeyOf(project: string, canonicalR: string, sha: string): string {
  return contextKey(project, canonicalR, sha);
}

export function extractSha(input: Pick<EventInput, "method" | "change">): string | undefined {
  const sha = input.method?.params?.sha;
  if (typeof sha === "string" && sha.length > 0) return sha;
  const after = input.change?.after_hash;
  return typeof after === "string" && after.length > 0 ? after : undefined;
}

export function extractParents(input: Pick<EventInput, "method">): string[] {
  const p = input.method?.params?.parents;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
}

export function fileArtifacts(input: Pick<EventInput, "artifacts">): { id: string; path: string; repo: string }[] {
  const out: { id: string; path: string; repo: string }[] = [];
  for (const a of input.artifacts) {
    const m = REPO_ARTIFACT.exec(a.id);
    if (!m) continue;
    out.push({ id: a.id, repo: m[1], path: m[2] });
  }
  return out;
}

export function rawTrailersOf(trailers: Record<string, string[]>): ClaimRecord["raw_trailers"] {
  const out: ClaimRecord["raw_trailers"] = {};
  if (trailers["retrace-actor"]?.[0]) out["retrace-actor"] = trailers["retrace-actor"][0];
  if (trailers["co-authored-by"]?.length) out["co-authored-by"] = trailers["co-authored-by"];
  return out;
}

/**
 * Re-derive the claim from signed raw_message + author + parents. A submitted actor that disagrees
 * with the re-derived one is malformed (design §5.1).
 */
export function deriveCommitClaim(input: EventInput): {
  resolved: CommitActorResolution;
  claim: ClaimRecord;
  submittedDiffers: boolean;
} {
  const params = (input.method?.params ?? {}) as Record<string, unknown>;
  const author = params.author && typeof params.author === "object" && !Array.isArray(params.author)
    ? params.author as { name?: unknown; email?: unknown }
    : undefined;
  const raw = typeof params.raw_message === "string" ? params.raw_message : "";
  const resolved = resolveCommitActor({
    message: raw,
    authorName: typeof author?.name === "string" ? author.name : undefined,
    authorEmail: typeof author?.email === "string" ? author.email : undefined,
    parents: extractParents(input),
  });
  const submittedDiffers = input.actor.type !== resolved.actor.type || input.actor.id !== resolved.actor.id;
  const source: ClaimSource = submittedDiffers && resolved.claimSource !== "malformed" ? "malformed" : resolved.claimSource;
  const actor = source === "malformed" && submittedDiffers ? resolved.actor : resolved.actor;
  return {
    resolved: { ...resolved, claimSource: source },
    claim: {
      type: actor.type,
      id: actor.id,
      source,
      ...(actor.model ? { model: actor.model } : {}),
      raw_trailers: rawTrailersOf(resolved.trailers),
    },
    submittedDiffers,
  };
}

export function causedBySourceOf(input: EventInput, trailers: Record<string, string[]>): CausedByRecord["source"] {
  const param = input.method?.params?.caused_by_source;
  if (param === "trailer" || param === "env" || param === "file" || param === "none") return param;
  const trailerId = validCausedById(trailers["retrace-caused-by"]?.[0]);
  if (trailerId && trailerId === input.caused_by) return "trailer";
  if (input.caused_by) return "env";
  return "none";
}

export async function digestOf(value: unknown): Promise<string> {
  return sha256Hex(canonicalize(value));
}

/** Routed GitHub identity for the hook path (T11). One active route or one github_repos entry. */
export async function routedCanonicalRForHook(store: EventStore, project: string): Promise<string | undefined> {
  const routes = store.listPolicyRoutes ? await store.listPolicyRoutes(project) : [];
  const active = [...new Set(routes.filter((r) => r.state === "active").map((r) => r.repo))];
  if (active.length === 1) return active[0];
  const doc = store.getPolicy ? await store.getPolicy(project, { current: true }) : null;
  const repos = [...new Set(doc?.body.github_repos ?? [])];
  if (repos.length === 1) return repos[0];
  return undefined;
}

export type AmendmentSnapshotRecord =
  | { effective: { id: string; target: string; artifacts: string[]; whole_event: boolean }[] }
  | { unavailable: string };

export function amendmentSnapshotJson(record: AmendmentSnapshotRecord): string {
  return JSON.stringify(record);
}

function emptyAmendmentCollection(): AttributionCollection {
  return collectAttributionAmendments([]);
}

function effectiveAmendmentRecord(collection: AttributionCollection): AmendmentSnapshotRecord {
  if (collection.unavailable) return { unavailable: collection.unavailable };
  const effective = [...collection.effective.values()]
    .flat()
    .map((a) => ({ id: a.amendment_id, target: a.target_id, artifacts: a.artifacts, whole_event: a.whole_event }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.target.localeCompare(b.target));
  return { effective };
}

function classifierCanonicalArtifact(policy: PolicyBody, id: string): string | undefined {
  const match = /^repo:([^#]+)#(.+)$/.exec(id);
  if (match) {
    const name = canonicalRepositoryR(policy, match[1]) ?? match[1];
    return `repo:${name}#${match[2]}`;
  }
  if (/^(commit|event|actor|file):/.test(id) || !/^[a-z][a-z0-9+.-]*:/i.test(id)) return undefined;
  return id;
}

async function classifierLedgerAttributionContext(
  snapshot: AttributionSnapshot,
  policy: PolicyBody,
  policyDigest: string,
): Promise<AttributionCaptureContext> {
  const canonicalArtifact = (id: string, _seq: number) => classifierCanonicalArtifact(policy, id);
  const domains = new Map<string, AttributionDomain>();
  const byId = new Map(snapshot.events.map((e) => [e.id, e]));
  const seals = new Map<string, { key: string; seq: number; paths: Set<string> }>();
  for (const repository of policy.repositories) {
    for (const seal of captureSeals(snapshot.events, {
      repoName: repository.name,
      aliases: repository.aliases,
      hookSealedBy: policy.trusted_hook_stamps,
      ownerSeals: true,
    })) {
      const existing = seals.get(seal.key);
      const value = existing ?? { key: seal.key, seq: seal.seq, paths: new Set<string>() };
      value.seq = Math.min(value.seq, seal.seq);
      for (const artifact of seal.event.artifacts) {
        const id = canonicalArtifact(artifact.id, seal.event.seq);
        if (id) value.paths.add(id);
      }
      seals.set(seal.key, value);
    }
  }
  for (const e of snapshot.events.filter(isAttributionAmendment)) {
    const target = byId.get(String(e.method?.params?.target_event_id));
    if (!target || domains.has(target.id)) continue;
    const ownCommit = target.artifacts.find((a) => a.id.startsWith("commit:"))?.id;
    const ownKey = ownCommit ? /^commit:[^@]+@([0-9a-f]{7,40})$/i.exec(ownCommit)?.[1]?.slice(0, 12) : undefined;
    const before = Math.min(target.seq, ownKey ? seals.get(ownKey)?.seq ?? target.seq : target.seq);
    const units: AttributionUnit[] = [];
    target.artifacts.forEach((a, index) => {
      if (/^(commit|event|actor):/.test(a.id) || ["commit", "event", "actor"].includes(a.kind ?? "")) return;
      const output = a.role !== undefined
        ? a.role === "generated" || a.role === "both"
        : ["created", "edited", "deleted", "renamed", "moved", "committed", "merged"].includes(target.action);
      if (!output) return;
      const id = canonicalArtifact(a.id, target.seq);
      if (!id) return;
      const existing = units.find((u) => u.id === id);
      if (existing) existing.refs.push(index);
      else {
        const touches = [...seals.values()].filter((seal) => seal.key !== ownKey);
        units.push({ id, refs: [index], names: [id], after: previousCaptureTouch(touches, id, before), before });
      }
    });
    domains.set(target.id, { units: units.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), complete: true });
  }
  return {
    profile: "retrace-attribution/1",
    project: snapshot.project,
    head_seq: snapshot.head.seq,
    head_hash: snapshot.head.hash,
    policy_digest: policyDigest,
    git_facts_digest: await sha256Hex("classifier-ledger-only"),
    domains,
    diagnostics: [],
    canonicalArtifact,
  };
}

export type AmendmentEval =
  | { ok: true; collection: AttributionCollection; snapshotJson: string }
  | { ok: false; reason: "deadline" | "budget" | "store_error"; snapshotJson: string };

/** Complete prefix at U — never a single history page. Effectiveness via collectAttributionAmendments. */
export async function evaluateAmendmentsAtU(opts: {
  store: EventStore;
  project: string;
  U: number;
  policy: PolicyBody;
  policyDigest: string;
  deadline: number;
  now: () => number;
}): Promise<AmendmentEval> {
  const fail = (reason: "deadline" | "budget" | "store_error"): AmendmentEval => ({
    ok: false,
    reason,
    snapshotJson: amendmentSnapshotJson({ unavailable: reason }),
  });
  if (opts.now() >= opts.deadline) return fail("deadline");
  if (opts.U < 0) {
    const collection = emptyAmendmentCollection();
    return { ok: true, collection, snapshotJson: amendmentSnapshotJson({ effective: [] }) };
  }
  let events: Event[];
  try {
    events = await opts.store.all(opts.project);
  } catch {
    return fail("store_error");
  }
  if (opts.now() >= opts.deadline) return fail("deadline");
  const prefix = events.filter((e) => e.seq <= opts.U).sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  if (prefix.length > CLASSIFY_ROW_CAP) return fail("budget");
  if (!prefix.some(isAttributionAmendment)) {
    return { ok: true, collection: emptyAmendmentCollection(), snapshotJson: amendmentSnapshotJson({ effective: [] }) };
  }
  try {
    const head = prefix.at(-1)!;
    const snapshot = await verifiedAttributionSnapshot(prefix, opts.project, { seq: head.seq, hash: head.hash });
    if (opts.now() >= opts.deadline) return fail("deadline");
    const context = await classifierLedgerAttributionContext(snapshot, opts.policy, opts.policyDigest);
    const collection = collectAttributionAmendments(prefix, { snapshot, context });
    if (collection.unavailable) {
      return { ok: false, reason: "store_error", snapshotJson: amendmentSnapshotJson({ unavailable: collection.unavailable }) };
    }
    return { ok: true, collection, snapshotJson: amendmentSnapshotJson(effectiveAmendmentRecord(collection)) };
  } catch {
    return fail("store_error");
  }
}

function witnessAmendmentScope(eventId: string, collection: AttributionCollection): { excludeAll: boolean; artifacts: Set<string> } {
  const list: AttributionAmendment[] = collection.effective.get(eventId) ?? [];
  if (list.some((a) => a.whole_event)) return { excludeAll: true, artifacts: new Set() };
  return { excludeAll: false, artifacts: new Set(list.flatMap((a) => a.artifacts)) };
}

export function canonicalRForFacts(policy: PolicyBody, files: { repo: string }[], pinnedR?: string): string {
  if (pinnedR) {
    return canonicalRepositoryR(policy, pinnedR) ?? canonicalGithubRepo(pinnedR);
  }
  const mapped = files.map((f) => canonicalRepositoryR(policy, f.repo) ?? canonicalGithubRepo(f.repo));
  const unique = [...new Set(mapped)];
  return unique[0] ?? (policy.repositories[0]?.name ?? "unknown");
}

export function artifactIdsForRepo(canonicalR: string, files: { id: string; path: string; repo: string }[], policy: PolicyBody): string[] {
  const aliases = new Set<string>([canonicalR, canonicalGithubRepo(canonicalR)]);
  for (const r of policy.repositories) {
    if (r.name === canonicalR || canonicalGithubRepo(r.name) === canonicalGithubRepo(canonicalR)) {
      aliases.add(r.name);
      for (const a of r.aliases) aliases.add(a);
    }
  }
  const ids = new Set<string>();
  for (const f of files) {
    if (aliases.has(f.repo) || aliases.has(canonicalGithubRepo(f.repo)) || canonicalRepositoryR(policy, f.repo) === canonicalR) {
      ids.add(`repo:${canonicalR}#${f.path}`);
      ids.add(f.id);
    }
  }
  return [...ids];
}

function submittedPathsForRepo(
  canonicalR: string,
  files: { id: string; path: string; repo: string }[],
  policy: PolicyBody,
  routed: boolean,
): string[] {
  if (routed) return [...new Set(files.map((f) => f.path))];
  const ids = artifactIdsForRepo(canonicalR, files, policy);
  return [...new Set(files.filter((f) => ids.includes(f.id) || ids.includes(`repo:${canonicalR}#${f.path}`)).map((f) => f.path))];
}

function artifactKeysForPaths(canonicalR: string, paths: string[], policy: PolicyBody): string[] {
  const repos = new Set([canonicalR, canonicalGithubRepo(canonicalR)]);
  for (const repository of policy.repositories) {
    if (repository.name === canonicalR || canonicalGithubRepo(repository.name) === canonicalGithubRepo(canonicalR)) {
      repos.add(repository.name);
      for (const alias of repository.aliases) repos.add(alias);
    }
  }
  return [...new Set(paths.flatMap((path) => [...repos].map((repo) => `repo:${repo}#${path}`)))];
}

export function wouldWrite(status: DecisionStatus, unresolvedPolicy: "record" | "withhold", reason?: DecisionReason): WouldWrite {
  if (status === "conflicting") return { actor_written: "withheld", reason: reason ?? "no_match" };
  if (status === "unresolved") {
    return unresolvedPolicy === "withhold"
      ? { actor_written: "withheld", reason: reason ?? "unresolved_policy" }
      : { actor_written: "claim" };
  }
  return { actor_written: "claim" };
}

export function decideFromTable(opts: {
  claim: ClaimRecord;
  wall: { type: string; id: string }[];
  looseHints: number;
  root?: CausedByRecord["root"];
  authenticatedIngress: boolean;
  isMergeNoFiles: boolean;
}): { status: DecisionStatus; reason?: DecisionReason } {
  if (opts.isMergeNoFiles) return { status: "merge_unclassified" };
  const agentClaim = opts.claim.type === "agent" || opts.claim.source === "malformed";
  const humanOrBot = opts.claim.source === "human-author" || opts.claim.source === "bot-author";
  const inWall = opts.wall.some((w) => w.type === opts.claim.type && w.id === opts.claim.id);
  if (!opts.authenticatedIngress && agentClaim && opts.claim.source !== "human-author" && opts.claim.source !== "bot-author") {
    if (opts.claim.source === "malformed") {
      return opts.wall.length
        ? { status: "conflicting", reason: "malformed_claim" }
        : { status: "unresolved", reason: "malformed_claim" };
    }
    return { status: "unresolved", reason: "no_authenticated_ingress" };
  }
  if (opts.claim.source === "malformed") {
    return opts.wall.length
      ? { status: "conflicting", reason: "malformed_claim" }
      : { status: "unresolved", reason: "malformed_claim" };
  }
  if (humanOrBot) {
    return opts.wall.length ? { status: "human_claim_with_agent_evidence" } : { status: "no_agent_evidence" };
  }
  if (opts.claim.type === "agent") {
    if (inWall) return { status: "supported" };
    if (opts.wall.length) return { status: "conflicting", reason: "no_match" };
    if (opts.looseHints > 0) return { status: "unresolved", reason: "loose_evidence_only" };
    if (opts.root) return { status: "unresolved", reason: "root_only" };
    return { status: "unresolved", reason: "unrooted" };
  }
  return opts.wall.length ? { status: "human_claim_with_agent_evidence" } : { status: "no_agent_evidence" };
}

function isPinnedIngress(sealedBy: unknown): boolean {
  return typeof sealedBy === "string" && sealedBy.startsWith("pinned:");
}

function isCaptureStamp(sealedBy: unknown, trusted: readonly string[]): boolean {
  if (typeof sealedBy !== "string" || !sealedBy) return false;
  if (sealedBy === SEALED_BY_GITHUB_WEBHOOK) return true;
  if (trusted.includes(sealedBy)) return true;
  return false;
}

function outputClaimOnPath(e: Event, pathArtifact: string, policy: PolicyBody, canonicalR: string): boolean {
  const aliases = new Set<string>([canonicalR]);
  for (const r of policy.repositories) {
    if (r.name === canonicalR || canonicalGithubRepo(r.name) === canonicalGithubRepo(canonicalR)) {
      aliases.add(r.name);
      for (const a of r.aliases) aliases.add(a);
    }
  }
  for (const a of e.artifacts) {
    const m = REPO_ARTIFACT.exec(a.id);
    const canonical = classifierCanonicalArtifact(policy, a.id);
    if (m && aliases.has(m[1]) && canonical === pathArtifact) {
      if (generatesArtifact(e, a)) return true;
      if (a.role === undefined && WRITING_ACTIONS.has(e.action)) return true;
    }
    if (canonical === pathArtifact && (generatesArtifact(e, a) || (a.role === undefined && WRITING_ACTIONS.has(e.action)))) {
      const mm = REPO_ARTIFACT.exec(a.id);
      if (mm && aliases.has(mm[1])) return true;
    }
  }
  return false;
}

function isLooseRef(id: string): boolean {
  return id.startsWith("file:") || !id.includes(":");
}

export function countLooseHints(events: Event[], files: { path: string }[]): number {
  const wanted = new Set(files.map((f) => f.path));
  let n = 0;
  for (const e of events) {
    for (const a of e.artifacts) {
      if (!isLooseRef(a.id)) continue;
      const path = a.id.startsWith("file:") ? a.id.slice(a.id.lastIndexOf("/") + 1) : a.id.replace(/^\.\//, "");
      if (wanted.has(path) || [...wanted].some((p) => path === p || a.id.endsWith(p) || a.id === p)) n++;
    }
  }
  return n;
}

async function resolveCausedBy(store: EventStore, input: EventInput, trailers: Record<string, string[]>): Promise<CausedByRecord> {
  const source = causedBySourceOf(input, trailers);
  const id = validCausedById(input.caused_by) ?? validCausedById(trailers["retrace-caused-by"]?.[0]);
  if (!id) return { source: source === "none" ? "none" : source };
  const parent = await store.get(id);
  const problem = causedByProblem(parent, { caused_by: id, project: input.project, timestamp: input.timestamp });
  if (problem) return { id, source, problem };
  const seen = new Set<string>([id]);
  let cursor = parent!;
  while (cursor.caused_by) {
    if (seen.has(cursor.caused_by)) return { id, source, problem: "cyclic", root: { id: cursor.id, action: cursor.action, actor: { type: cursor.actor.type, id: cursor.actor.id } } };
    seen.add(cursor.caused_by);
    const next = await store.get(cursor.caused_by);
    const p = causedByProblem(next, { caused_by: cursor.caused_by, project: cursor.project, timestamp: cursor.timestamp });
    if (p || !next) break;
    cursor = next;
  }
  return { id, source, root: { id: cursor.id, action: cursor.action, actor: { type: cursor.actor.type, id: cursor.actor.id } } };
}

function requireContextStore(store: EventStore): asserts store is EventStore & {
  getClassificationContext: NonNullable<EventStore["getClassificationContext"]>;
  insertClassificationContextIfAbsent: NonNullable<EventStore["insertClassificationContextIfAbsent"]>;
  ensureClassificationPathLowers: NonNullable<EventStore["ensureClassificationPathLowers"]>;
} {
  if (!store.getClassificationContext || !store.insertClassificationContextIfAbsent || !store.ensureClassificationPathLowers) {
    throw new ClassificationStoreError();
  }
}

function authenticatedObserver(sealedBy: string): boolean {
  return sealedBy.startsWith("assert:") || sealedBy === SEALED_BY_GITHUB_WEBHOOK || sealedBy.startsWith("pinned:");
}

function harnessOf(input: EventInput, claimId: string): { marker?: string; marker_actor?: string } {
  const params = input.method?.params ?? {};
  const marker = typeof params.harness_marker === "string" ? params.harness_marker
    : typeof input.location?.client === "string" ? input.location.client
    : typeof input.location?.ide === "string" ? input.location.ide
    : undefined;
  return { ...(marker ? { marker } : {}), marker_actor: claimId };
}

function harnessMismatch(claimFamily: string, marker: string | undefined, witnessClients: string[]): boolean {
  if (!witnessClients.length) return false;
  const family = (marker ?? claimFamily).toLowerCase().split("@")[0]!.replace(/[^a-z0-9]+/g, "");
  if (!family) return false;
  const agrees = witnessClients.some((c) => {
    const cf = c.toLowerCase().split("@")[0]!.replace(/[^a-z0-9]+/g, "");
    return cf.includes(family) || family.includes(cf);
  });
  return !agrees;
}

export interface ClassifyOpts {
  store: EventStore;
  input: EventInput;
  producer: ProducerKind;
  sealedBy: string;
  trailerPolicy: TrailerPolicy;
  /** Canonical repository pinned on the delivery (webhook routing). */
  canonicalR?: string;
  now?: () => number;
  deadline?: number;
  signedActor?: { type: Actor["type"]; id: string; on_behalf_of?: string };
}

async function classifyCommitClaimInner(opts: ClassifyOpts): Promise<ClassifyResult> {
  const policyMode = parseTrailerPolicy(opts.trailerPolicy);
  if (policyMode === "off") return { kind: "skip", reason: "policy_off" };
  if (policyMode !== "shadow") return { kind: "skip", reason: "policy_off" };
  if (!isGitCommitSeal(opts.input)) return { kind: "skip", reason: "not_commit" };

  const now = opts.now ?? Date.now;
  const started = now();
  const deadline = opts.deadline ?? started + CLASSIFY_DEADLINE_MS;
  const legacy = isLegacyClientCommitSeal(opts.input);

  try {
    requireContextStore(opts.store);
  } catch {
    return { kind: "unavailable", reason: "store_error" };
  }

  const derived = deriveCommitClaim(opts.input);
  const sha = extractSha(opts.input);
  if (!sha) return { kind: "unavailable", reason: "store_error" };
  const files = fileArtifacts(opts.input);
  const parents = extractParents(opts.input);
  const caused = await resolveCausedBy(opts.store, opts.input, derived.resolved.trailers);
  if (now() >= deadline) return { kind: "unavailable", reason: "deadline" };

  const head = await opts.store.head(opts.input.project);
  const Utry = head?.seq ?? -1;
  const headHash = head?.hash ?? GENESIS_HASH;

  if (now() >= deadline) return { kind: "unavailable", reason: "deadline" };

  const snapshot: PolicySnapshot = opts.store.readPolicySnapshot
    ? await opts.store.readPolicySnapshot(opts.input.project, Utry, { deadline, now })
    : { U: Utry, events: [], activations: [], unavailable: "store_error" };
  if (snapshot.unavailable) return { kind: "unavailable", reason: snapshot.unavailable };

  let policyDoc: PolicyDocument | null = null;
  // New context: policy at Utry. Q4: context key is (project, canonical R, sha) — a later
  // delivery under a different R is a different key and a second context; no new recorded field.
  const selected = selectPolicyForContext(snapshot, snapshot.document
    ? new Map([[snapshot.document.digest, snapshot.document], [documentMapKey(opts.input.project, snapshot.document.digest), snapshot.document]])
    : new Map());
  if (selected.status === "selected") policyDoc = selected.document;
  else if (selected.status === "incomplete") return { kind: "unavailable", reason: "store_error" };

  if (!policyDoc) return { kind: "unavailable", reason: "policy_missing" };

  const pin = opts.canonicalR ?? (policyDoc.body.github_repos.length === 1 ? policyDoc.body.github_repos[0] : undefined);
  const canonicalR = canonicalRForFacts(policyDoc.body, files, pin);
  let paths = submittedPathsForRepo(canonicalR, files, policyDoc.body, pin !== undefined);
  let Fdigest = await digestOf([...paths].sort());
  const claimDigest = await digestOf({ type: derived.claim.type, id: derived.claim.id, source: derived.claim.source });

  const found = await opts.store.getClassificationContext(opts.input.project, canonicalR, sha);
  if (now() >= deadline) return { kind: "unavailable", reason: "deadline" };
  let amendEval: AmendmentEval | null = null;
  if (!found) {
    amendEval = await evaluateAmendmentsAtU({
      store: opts.store, project: opts.input.project, U: Utry, policy: policyDoc.body,
      policyDigest: policyDoc.digest, deadline, now,
    });
    if (!amendEval.ok) return { kind: "unavailable", reason: amendEval.reason };
  }
  const candidate: ClassificationContextRow = {
    project: opts.input.project,
    canonical_repo: canonicalR,
    sha,
    read_head_seq: Utry,
    read_head_hash: headHash,
    policy_digest: policyDoc.digest,
    first_producer: opts.producer,
    first_F_digest: Fdigest,
    first_claim_digest: claimDigest,
    classifier_profile: CLASSIFIER_PROFILE,
    rollout_mode: policyMode,
    amendment_snapshot: amendEval?.snapshotJson ?? amendmentSnapshotJson({ unavailable: "pending" }),
    per_path_lower: {},
    created_at: new Date(now()).toISOString(),
  };

  const inserted = found
    ? { inserted: false, context: found }
    : await opts.store.insertClassificationContextIfAbsent(candidate);
  if (now() >= deadline) return { kind: "unavailable", reason: "deadline" };
  const ctx = inserted.context;

  // Existing context: retrieve the *exact* policy named by the context, never latest (P4).
  if (!inserted.inserted) {
    const named = opts.store.getPolicy ? await opts.store.getPolicy(opts.input.project, { digest: ctx.policy_digest }) : null;
    if (!named) return { kind: "unavailable", reason: "store_error" };
    policyDoc = named;
    paths = submittedPathsForRepo(ctx.canonical_repo, files, policyDoc.body, opts.canonicalR !== undefined);
    Fdigest = await digestOf([...paths].sort());
  }

  const U = ctx.read_head_seq;
  const evaluated: AmendmentEval = (!amendEval || U !== Utry)
    ? await evaluateAmendmentsAtU({
      store: opts.store, project: opts.input.project, U, policy: policyDoc.body,
      policyDigest: policyDoc.digest, deadline, now,
    })
    : amendEval;
  if (!evaluated.ok) return { kind: "unavailable", reason: evaluated.reason };
  const amendmentCollection = evaluated.collection;
  const thisShaShort = sha.slice(0, 12);
  const canonicalKeys = artifactKeysForPaths(canonicalR, paths, policyDoc.body);
  const looseKeys = paths.flatMap((p) => [`file:${p}`, p]);
  const keys = [...new Set([...canonicalKeys, ...looseKeys])];

  if (now() >= deadline) return { kind: "unavailable", reason: "deadline" };

  // One bounded §3.5 read: events referencing F in (genesis, U]. Lowers and witnesses come from it.
  let index: ArtifactIndexResult;
  if (!keys.length) index = { ok: true, events: [] };
  else if (opts.store.eventsReferencingArtifacts) {
    index = await opts.store.eventsReferencingArtifacts({
      project: opts.input.project,
      artifact_keys: keys,
      after_seq: -1,
      through_seq: U,
      row_cap: CLASSIFY_ROW_CAP,
      deadline,
    }, now);
  } else {
    index = eventsReferencingArtifactKeys(await opts.store.all(opts.input.project), {
      project: opts.input.project,
      artifact_keys: keys,
      after_seq: -1,
      through_seq: U,
      row_cap: CLASSIFY_ROW_CAP,
      deadline,
    }, now());
  }
  if (!index.ok) return { kind: "unavailable", reason: index.reason };

  const seals = captureSeals(index.events, {
    repoName: canonicalR,
    aliases: policyDoc.body.repositories.find((r) => r.name === canonicalR)?.aliases,
    hookSealedBy: policyDoc.body.trusted_hook_stamps,
    ownerSeals: true,
  });
  const touches = seals
    .filter((s) => {
      const sealSha = extractSha(s.event);
      return sealSha?.toLowerCase() !== sha.toLowerCase()
        && s.key.toLowerCase() !== thisShaShort.toLowerCase()
        && s.key.toLowerCase() !== sha.toLowerCase()
        && !s.key.toLowerCase().endsWith(`@${thisShaShort.toLowerCase()}`)
        && !s.key.toLowerCase().endsWith(`@${sha.toLowerCase()}`);
    })
    .map((s) => ({
      seq: s.seq,
      paths: new Set([...s.paths].map((id) => {
        const m = REPO_ARTIFACT.exec(id);
        return m ? m[2] : id;
      })),
    }));

  const derivedLowers: Record<string, number> = { ...ctx.per_path_lower };
  for (const p of paths) {
    if (derivedLowers[p] === undefined) {
      const prev = previousCaptureTouch(touches, p, U);
      derivedLowers[p] = prev < 0 ? 0 : prev;
    }
  }
  const per_path_lower = await opts.store.ensureClassificationPathLowers(opts.input.project, canonicalR, sha, derivedLowers);
  if (now() >= deadline) return { kind: "unavailable", reason: "deadline" };

  const windowEvents = index.events.filter((e) => e.seq <= U);
  const loose_hints = countLooseHints(windowEvents, paths.map((p) => ({ path: p })));

  const witnesses: WitnessRecord[] = [];
  const wallMap = new Map<string, { type: string; id: string }>();
  const witnessClients: string[] = [];

  for (const e of windowEvents) {
    if (now() >= deadline) return { kind: "unavailable", reason: "deadline" };
    const sealedBy = e.method?.params?.[SEALED_BY_PARAM];
    if (!isPinnedIngress(sealedBy)) continue;
    if (e.actor.type !== "agent") continue;
    if (NON_WITNESS_ACTIONS.has(e.action) || e.action_detail === "amended") continue;
    const scope = witnessAmendmentScope(e.id, amendmentCollection);
    if (scope.excludeAll) continue;
    const hitPaths: string[] = [];
    for (const p of paths) {
      const lower = per_path_lower[p] ?? 0;
      if (!(lower < e.seq && e.seq <= U)) continue;
      const art = `repo:${canonicalR}#${p}`;
      if (scope.artifacts.has(art)) continue;
      if (outputClaimOnPath(e, art, policyDoc.body, canonicalR)) hitPaths.push(p);
    }
    if (!hitPaths.length) continue;
    const rec: WitnessRecord = {
      id: e.id,
      seq: e.seq,
      actor: { type: e.actor.type, id: e.actor.id },
      paths: hitPaths,
      sealed_by: String(sealedBy),
      ...(typeof e.method?.params?.producer_sig_verdict === "string" ? { producer_sig_verdict: e.method.params.producer_sig_verdict } : {}),
      ...(typeof e.location?.client === "string" ? { client: e.location.client } : {}),
    };
    witnesses.push(rec);
    wallMap.set(actorKey(e.actor), { type: e.actor.type, id: e.actor.id });
    if (rec.client && !witnessClients.includes(rec.client)) witnessClients.push(rec.client);
  }

  const wall = [...wallMap.values()];
  const parentFactsIncomplete = opts.input.method?.params?.parents_complete === false;
  const isMergeNoFiles = (opts.input.action === "merged" || derived.resolved.isMerge || parentFactsIncomplete) && paths.length === 0;
  const table = decideFromTable({
    claim: derived.claim,
    wall,
    looseHints: loose_hints,
    root: caused.root,
    authenticatedIngress: authenticatedObserver(opts.sealedBy),
    isMergeNoFiles,
  });

  const unresolved_policy = policyDoc.body.unresolved_claims;
  const ww = wouldWrite(table.status, unresolved_policy, table.reason);
  const harness = harnessOf(opts.input, derived.claim.id);
  const mismatch = harnessMismatch(derived.claim.id, harness.marker, witnessClients);
  if (now() >= deadline) return { kind: "unavailable", reason: "deadline" };

  const signed = opts.signedActor ?? (derived.claim.type && derived.claim.id
    ? { type: derived.claim.type, id: derived.claim.id, ...(derived.resolved.actor.on_behalf_of ? { on_behalf_of: derived.resolved.actor.on_behalf_of } : {}) }
    : undefined);

  const record: ClaimDecision = {
    policy: CLASSIFIER_PROFILE,
    observer: { producer: opts.producer, sealed_by: opts.sealedBy },
    claim: derived.claim,
    caused_by: caused,
    ...(signed ? { signed_actor: signed } : {}),
    decision: {
      status: table.status,
      ...(table.reason ? { reason: table.reason } : {}),
      actor_written: "claim",
      unresolved_policy,
      shadow: true,
      would_write: ww,
      context: {
        read_head_seq: ctx.read_head_seq,
        read_head_hash: ctx.read_head_hash,
        policy_digest: ctx.policy_digest,
        first_producer: ctx.first_producer,
        first_F_digest: ctx.first_F_digest,
        first_claim_digest: ctx.first_claim_digest,
      },
      submitted: { F_digest: Fdigest, parents, raw_message_param: "method.params.raw_message" },
      window: { upper_seq: U, per_path_lower },
      witnesses,
      witness_actors: wall,
      loose_hints,
      harness: { ...harness, witness_clients: witnessClients, mismatch },
      classification_ms: Math.max(0, now() - started),
    },
  };

  if (legacy) {
    if (opts.store.setClassificationLegacyDecision) {
      await opts.store.setClassificationLegacyDecision(opts.input.project, canonicalR, sha, record);
    }
    if (now() >= deadline) return { kind: "unavailable", reason: "deadline" };
    return { kind: "legacy", record };
  }
  if (now() >= deadline) return { kind: "unavailable", reason: "deadline" };
  return { kind: "decision", record };
}

export async function classifyCommitClaim(opts: ClassifyOpts): Promise<ClassifyResult> {
  try {
    return await classifyCommitClaimInner(opts);
  } catch {
    return { kind: "unavailable", reason: "store_error" };
  }
}

export function attachClaimDecision(input: EventInput, record: ClaimDecision): EventInput {
  return {
    ...input,
    method: {
      ...input.method,
      params: { ...input.method?.params, [CLAIM_DECISION_PARAM]: record },
    },
  };
}

/** Breaker (a): only synchronous webhook deadline/store_error count. Drain does not. */
export function breakerShouldOpen(row: BreakerRow, nowMs: number): boolean {
  if (row.failures < BREAKER_CONSECUTIVE_FAILURES) return false;
  if (!row.failure_window_start) return false;
  return nowMs - Date.parse(row.failure_window_start) <= BREAKER_WINDOW_MS;
}

export function breakerIsOpen(row: BreakerRow | null, nowMs: number): boolean {
  if (!row || row.state !== "open" || !row.opened_at) return false;
  return nowMs - Date.parse(row.opened_at) < BREAKER_OPEN_MS;
}

export function breakerProbeExpired(row: BreakerRow, nowMs: number): boolean {
  if (!row.probe_lease_until) return true;
  return Date.parse(row.probe_lease_until) <= nowMs;
}

export function applyBreakerFailure(row: BreakerRow | null, project: string, nowIso: string, nowMs: number): BreakerRow {
  const lastMs = row?.last_failure_at ? Date.parse(row.last_failure_at) : Number.NaN;
  const windowStartMs = row?.failure_window_start ? Date.parse(row.failure_window_start) : Number.NaN;
  const isolated = !row || !Number.isFinite(lastMs) || nowMs - lastMs > BREAKER_WINDOW_MS;
  const expiredWindow = !isolated && (!Number.isFinite(windowStartMs) || nowMs - windowStartMs > BREAKER_WINDOW_MS);
  // When the old window expires but its last failure is still recent, retain that last failure as
  // the first point in the restarted window. This lets a sparse failure followed by a burst open.
  const failures = isolated ? 1 : expiredWindow ? 2 : row.failures + 1;
  const failure_window_start = isolated ? nowIso : expiredWindow ? row!.last_failure_at : (row!.failure_window_start ?? nowIso);
  const next: BreakerRow = {
    project,
    state: "closed",
    failures,
    failure_window_start,
    last_failure_at: nowIso,
    opened_at: row?.opened_at ?? null,
    probe_lease_until: null,
    probe_lease_owner: null,
  };
  if (breakerShouldOpen(next, nowMs)) {
    next.state = "open";
    next.opened_at = nowIso;
  }
  return next;
}

export function applyBreakerSuccess(row: BreakerRow | null, project: string): BreakerRow {
  return {
    project,
    state: "closed",
    failures: 0,
    failure_window_start: null,
    last_failure_at: null,
    opened_at: null,
    probe_lease_until: null,
    probe_lease_owner: null,
  };
}

export function applyBreakerProbeOpen(row: BreakerRow, owner: string, untilIso: string): BreakerRow {
  return { ...row, probe_lease_owner: owner, probe_lease_until: untilIso };
}

export function applyBreakerProbeFailure(row: BreakerRow, nowIso: string): BreakerRow {
  return {
    ...row,
    state: "open",
    opened_at: nowIso,
    failures: BREAKER_CONSECUTIVE_FAILURES,
    failure_window_start: nowIso,
    last_failure_at: nowIso,
    probe_lease_until: null,
    probe_lease_owner: null,
  };
}

/**
 * Sync webhook admission. Drain is never short-circuited (brief §7(b)).
 * Returns `pending` (skip classify), `probe` (this delivery classifies as the probe), or `live`.
 */
export async function webhookBreakerAdmission(
  store: EventStore,
  project: string,
  nowMs: number,
  probeOwner: string,
): Promise<"live" | "pending" | "probe"> {
  if (!store.getBreaker || !store.casBreaker) return "live";
  const row = await store.getBreaker(project);
  if (!row || row.state !== "open") return "live";
  if (breakerIsOpen(row, nowMs)) return "pending";
  if (!breakerProbeExpired(row, nowMs) && row.probe_lease_owner) return "pending";
  const until = new Date(nowMs + BREAKER_PROBE_LEASE_MS).toISOString();
  const next = applyBreakerProbeOpen(row, probeOwner, until);
  const won = await store.casBreaker(row, next);
  return won ? "probe" : "pending";
}

export async function recordWebhookClassifyOutcome(
  store: EventStore,
  project: string,
  outcome: "ok" | "deadline" | "store_error" | "budget",
  nowMs: number,
  probe: boolean,
): Promise<void> {
  if (!store.getBreaker || !store.casBreaker) return;
  if (outcome === "budget") return; // budget is not a breaker failure (§2)
  const iso = new Date(nowMs).toISOString();
  for (let attempt = 0; attempt < 32; attempt++) {
    const row = await store.getBreaker(project);
    let next: BreakerRow;
    if (outcome === "ok") next = applyBreakerSuccess(row, project);
    else if (probe && (outcome === "deadline" || outcome === "store_error")) next = applyBreakerProbeFailure(row ?? {
      project, state: "open", failures: BREAKER_CONSECUTIVE_FAILURES, failure_window_start: iso, last_failure_at: iso,
      opened_at: iso, probe_lease_until: null, probe_lease_owner: null,
    }, iso);
    else next = applyBreakerFailure(row, project, iso, nowMs);
    if (await store.casBreaker(row, next)) return;
  }
  throw new ClassificationStoreError("breaker CAS remained contended");
}

export function emptyBreaker(project: string): BreakerRow {
  return {
    project, state: "closed", failures: 0, failure_window_start: null, last_failure_at: null,
    opened_at: null, probe_lease_until: null, probe_lease_owner: null,
  };
}

export function sameBreaker(a: BreakerRow | null, b: BreakerRow | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.project === b.project && a.state === b.state && a.failures === b.failures
    && a.opened_at === b.opened_at && a.probe_lease_until === b.probe_lease_until
    && a.probe_lease_owner === b.probe_lease_owner && a.failure_window_start === b.failure_window_start
    && a.last_failure_at === b.last_failure_at;
}
