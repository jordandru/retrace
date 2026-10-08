import type { Event } from "./schema.js";

export type RestrictedStamp = { stamp: string; actor: { type: string; id: string } };
export type WebhookSeal = { sha: string; actor: { type: string; id: string }; files: string[] };
export type RestrictedTouch = { seq: number; paths: Set<string>; event?: Event; dropped?: string[] };
export type CaptureTouch = { seq: number; paths: Set<string>; restricted?: RestrictedTouch[] };
/** One effective boundary per commit and path. Genuine witnesses keep their shared earliest boundary; restricted
 * witnesses may only lower the boundary of the intersected paths they name. */
export function effectiveBoundary(touch: CaptureTouch, path: string): number | undefined {
  const candidates: number[] = [];
  if (touch.paths.has(path)) candidates.push(touch.seq);
  for (const restricted of touch.restricted ?? []) if (restricted.paths.has(path)) candidates.push(restricted.seq);
  return candidates.length ? Math.min(...candidates) : undefined;
}
/** Shared exclusive lower bound for reconciliation and attribution evidence. */
export function previousCaptureTouch(touches: CaptureTouch[], path: string, before: number | null): number {
  let seq = -1;
  for (const t of touches) {
    const boundary = effectiveBoundary(t, path);
    if (boundary !== undefined && (before === null || boundary < before)) seq = Math.max(seq, boundary);
  }
  return seq;
}

export function generatesArtifact(e: Event, a: Event["artifacts"][number]): boolean {
  if (e.action === "committed" || e.action === "merged" || e.action_detail === "amended" || e.action === "instructed") return false;
  return a.role !== undefined ? a.role === "generated" || a.role === "both" : ["created", "edited", "deleted", "renamed", "moved"].includes(e.action);
}

export function actorKey(a: { type: string; id: string }): string { return JSON.stringify([a.type, a.id]); }
export function sameActor(a: { type: string; id: string }, b: { type: string; id: string }): boolean { return a.type === b.type && a.id === b.id; }

const REPO_ARTIFACT = /^repo:([^#]+)#(.+)$/;

/** Canonical comparison key for an artifact id — the identity `sameArtifact` compares.
 *  Attribution's `canonicalArtifact` may further map aliases via policy at evidence time; the
 *  store index records *this* key so SQL lookups reuse the same rule instead of a second normalizer. */
export function artifactKey(id: string): string {
  return id;
}

/** Exact ids, plus the project's conventional owner/repo and basename aliases. Foreign repos never match. */
export function sameArtifact(a: string, b: string): boolean {
  if (artifactKey(a) === artifactKey(b)) return true;
  const x = REPO_ARTIFACT.exec(artifactKey(a)), y = REPO_ARTIFACT.exec(artifactKey(b));
  return !!(x && y && x[2] === y[2] && (x[1] === y[1] || (!x[1].includes("/") && y[1].endsWith("/" + x[1])) || (!y[1].includes("/") && x[1].endsWith("/" + y[1]))));
}

/** Escape a literal for SQLite/D1 GLOB (no ESCAPE clause). */
export function escapeGlobLiteral(s: string): string {
  return s.replace(/[*?[\]]/g, (ch) => `[${ch}]`);
}

/** SQL lookup for a query key so the artifact index hits every row `sameArtifact` would accept.
 *  Rows store the exact `artifactKey`; owner/repo ↔ basename expansion lives here, next to `sameArtifact`.
 *  An owner-less alias used to bind `GLOB repo:*\/<alias>#<path>`. That pattern's only wildcard is the owner
 *  segment, so it is equivalent to "key starts with `repo:` and ends with `/<alias>#<path>`" (`*` already
 *  matches `/` and `#`). D1 rejects LIKE/GLOB patterns over 50 bytes; suffix equality has no such limit,
 *  and because it is a literal compare it does not need `escapeGlobLiteral` (`*`, `?`, `[`). */
export function artifactLookup(queryKey: string): { equals: string[]; suffix?: string } {
  const id = artifactKey(queryKey);
  const m = REPO_ARTIFACT.exec(id);
  if (!m) return { equals: [id] };
  const repo = m[1], path = m[2];
  if (repo.includes("/")) {
    const base = repo.slice(repo.lastIndexOf("/") + 1);
    return { equals: [id, `repo:${base}#${path}`] };
  }
  return { equals: [id], suffix: `/${repo}#${path}` };
}

export interface CapturePolicy {
  repoName: string; aliases?: string[]; repoPath?: string;
  hookSealedBy?: string[]; ownerSeals?: boolean; allowUnstampedSeals?: boolean;
  unreachableShas?: string[]; firstStampedSeq?: number;
  restrictedStamps?: RestrictedStamp[];
  webhookSeals?: Map<string, WebhookSeal>;
}
export interface CaptureSeal extends CaptureTouch {
  key: string;
  event: Event;
  pathSources: { id: string; seq: number }[];
  restricted: RestrictedTouch[];
}
export type RestrictedSealEligibility =
  | { eligible: true; paths: string[]; dropped: string[]; sha12: string; fullSha: string }
  | { eligible: false; reason: "not_restricted" | "wrong_action" | "wrong_tool" | "no_key" | "key_mismatch" | "commit_mismatch" | "no_webhook" | "ambiguous_commit" | "actor_mismatch" };

function sealedByOf(e: Event): string | undefined {
  const stamp = e.method?.params?.sealed_by;
  return typeof stamp === "string" ? stamp : undefined;
}

export function validateCapturePolicy(policy: CapturePolicy): void {
  const general = new Set(policy.hookSealedBy ?? []);
  const duplicate = (policy.restrictedStamps ?? []).find((entry) => general.has(entry.stamp));
  if (duplicate) throw new Error("context_conflict: stamp is both general and restricted");
}

/** Eligibility for a restricted hook witness. It contributes only paths independently present in the authenticated
 * GitHub push seal for the same full commit and actor. */
export function restrictedSealEligibility(
  e: Event,
  policy: CapturePolicy,
  webhookSeals: Map<string, WebhookSeal> = policy.webhookSeals ?? new Map(),
): RestrictedSealEligibility {
  const entry = (policy.restrictedStamps ?? []).find((candidate) => candidate.stamp === sealedByOf(e));
  if (!entry) return { eligible: false, reason: "not_restricted" };
  if (e.action !== "committed") return { eligible: false, reason: "wrong_action" };
  if (e.method?.tool !== "git") return { eligible: false, reason: "wrong_tool" };
  const key = e.idempotency_key;
  if (typeof key !== "string" || !/^git:[0-9a-f]{40,64}$/i.test(key)) return { eligible: false, reason: "no_key" };
  const fullSha = key.slice(4).toLowerCase();
  const methodSha = e.method?.params?.sha;
  if (typeof methodSha !== "string" || methodSha.toLowerCase() !== fullSha) return { eligible: false, reason: "key_mismatch" };
  const commitArtifacts = e.artifacts.filter((artifact) => artifact.id.startsWith("commit:"));
  const commitMatch = commitArtifacts.length === 1
    ? /^commit:[^@]+@([0-9a-f]{7,64})$/i.exec(commitArtifacts[0].id)
    : null;
  if (!commitMatch || !fullSha.startsWith(commitMatch[1].toLowerCase())) return { eligible: false, reason: "commit_mismatch" };
  const sha12 = fullSha.slice(0, 12);
  const webhook = webhookSeals.get(fullSha);
  if (!webhook) return { eligible: false, reason: "no_webhook" };
  if ([...webhookSeals.keys()].filter((sha) => sha.startsWith(sha12)).length !== 1) return { eligible: false, reason: "ambiguous_commit" };
  if (!sameActor(webhook.actor, entry.actor)) return { eligible: false, reason: "actor_mismatch" };
  const named = e.artifacts.filter((artifact) => REPO_ARTIFACT.test(artifact.id)).map((artifact) => artifact.id);
  const paths = named.filter((id) => webhook.files.some((file) => sameArtifact(id, file)));
  const dropped = named.filter((id) => !paths.includes(id));
  return { eligible: true, paths, dropped, sha12, fullSha };
}

/** Authenticated GitHub push seals indexed by exact full SHA. Prefixes are presentation only and never identity. */
export function webhookSealsFromEvents(events: Event[]): Map<string, WebhookSeal> {
  const seals = new Map<string, WebhookSeal>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!event.tags?.includes("push") || sealedByOf(event) !== "webhook:github") continue;
    const sha = event.method?.params?.sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40,64}$/i.test(sha)) continue;
    const fullSha = sha.toLowerCase();
    if (!seals.has(fullSha)) {
      seals.set(fullSha, {
        sha: fullSha,
        actor: { type: event.actor.type, id: event.actor.id },
        files: event.artifacts.filter((artifact) => REPO_ARTIFACT.test(artifact.id)).map((artifact) => artifact.id),
      });
    }
  }
  return seals;
}
/** Shared commit boundary classification. The adapter supplies full OID resolution for authoritative attribution. */
/** The seq before which an unstamped git seal counts as legacy: the first stamped seal in `events`, unless the policy pins it. */
export function firstStampedSeq(events: Event[], policy: CapturePolicy): number {
  if (policy.firstStampedSeq !== undefined) return policy.firstStampedSeq;
  let first = Infinity;
  for (const event of events) {
    if (typeof event.method?.params?.sealed_by === "string") first = Math.min(first,event.seq);
  }
  return first;
}

/** Whether `e` is a capture seal this policy trusts: a legacy unstamped git seal, a git seal stamped by a trusted hook
 *  (or the owner when `ownerSeals`), or a GitHub push seal. Anything else naming a commit — an MCP-logged correction,
 *  a read, a note — is not a seal and can never become one, whatever reference it carries. */
export function captureSealEligible(e: Event, policy: CapturePolicy, firstStamped: number): boolean {
  if (e.action !== "committed" && e.action !== "merged") return false;
  const stamp = e.method?.params?.sealed_by;
  if (typeof stamp === "string" && (policy.restrictedStamps ?? []).some((entry) => entry.stamp === stamp)) return false;
  const shape = e.method?.tool === "git" && (e.idempotency_key === undefined || e.idempotency_key.startsWith("git:"));
  const legacy = stamp === undefined && e.seq < firstStamped && e.method?.tool === "git" && !e.tags?.includes("push");
  const stamps = policy.hookSealedBy ?? [];
  const hook = shape && (typeof stamp === "string" && (stamps.includes(stamp) || stamp === "owner" && policy.ownerSeals === true) || stamp === undefined && policy.allowUnstampedSeals === true);
  const webhook = e.tags?.includes("push") && stamp === "webhook:github";
  return Boolean(legacy || hook || webhook);
}

export function captureSeals(events: Event[], policy: CapturePolicy, resolve: (id: string) => string | undefined = id => /^commit:[^@]+@([0-9a-f]{7,40})$/.exec(id)?.[1].slice(0,12)): CaptureSeal[] {
  validateCapturePolicy(policy);
  const sorted = [...events].sort((a,b) => a.seq - b.seq);
  const firstStamped = firstStampedSeq(sorted, policy);
  const excluded = new Set((policy.unreachableShas ?? []).map(s=>s.includes("@")?s:s.slice(0,12)));
  const grouped = new Map<string, CaptureSeal>();
  for (const e of sorted) {
    if (!captureSealEligible(e, policy, firstStamped)) continue;
    const id = e.artifacts.find(a => a.id.startsWith("commit:"))?.id;
    const key = id ? resolve(id) : undefined;
    if (!key || excluded.has(key) || excluded.has(key.slice(0,12))) continue;
    const item = grouped.get(key) ?? { key, seq: e.seq, event: e, paths: new Set<string>(), pathSources: [], restricted: [] };
    for (const a of e.artifacts) {
      item.paths.add(a.id);
      item.pathSources.push({ id: a.id, seq: e.seq });
    }
    grouped.set(key, item);
  }
  const webhookSeals = policy.webhookSeals ?? webhookSealsFromEvents(sorted);
  for (const e of sorted) {
    const eligibility = restrictedSealEligibility(e, policy, webhookSeals);
    if (!eligibility.eligible) continue;
    const id = e.artifacts.find((artifact) => artifact.id.startsWith("commit:"))?.id;
    const key = id ? resolve(id) : undefined;
    const item = key ? grouped.get(key) : undefined;
    if (!item || excluded.has(key!) || excluded.has(key!.slice(0, 12))) continue;
    item.restricted.push({
      seq: e.seq,
      event: e,
      paths: new Set(eligibility.paths),
      dropped: eligibility.dropped,
    });
  }
  return [...grouped.values()].sort((a,b) => a.seq - b.seq);
}
