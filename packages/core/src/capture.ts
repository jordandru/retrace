import type { Event } from "./schema.js";

export type CaptureTouch = { seq: number; paths: Set<string> };
/** Shared exclusive lower bound for reconciliation and attribution evidence. */
export function previousCaptureTouch(touches: CaptureTouch[], path: string, before: number | null): number {
  let seq = -1;
  for (const t of touches) if ((before === null || t.seq < before) && t.paths.has(path)) seq = Math.max(seq, t.seq);
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
 *  Rows store the exact `artifactKey`; owner/repo ↔ basename expansion lives here, next to `sameArtifact`. */
export function artifactLookup(queryKey: string): { equals: string[]; glob?: string } {
  const id = artifactKey(queryKey);
  const m = REPO_ARTIFACT.exec(id);
  if (!m) return { equals: [id] };
  const repo = m[1], path = m[2];
  if (repo.includes("/")) {
    const base = repo.slice(repo.lastIndexOf("/") + 1);
    return { equals: [id, `repo:${base}#${path}`] };
  }
  return { equals: [id], glob: `repo:*/${escapeGlobLiteral(repo)}#${escapeGlobLiteral(path)}` };
}

export interface CapturePolicy {
  repoName: string; aliases?: string[]; repoPath?: string;
  hookSealedBy?: string[]; ownerSeals?: boolean; allowUnstampedSeals?: boolean;
  unreachableShas?: string[]; firstStampedSeq?: number;
}
export interface CaptureSeal { key: string; seq: number; event: Event; paths: Set<string> }
/** Shared commit boundary classification. The adapter supplies full OID resolution for authoritative attribution. */
export function captureSeals(events: Event[], policy: CapturePolicy, resolve: (id: string) => string | undefined = id => /^commit:[^@]+@([0-9a-f]{7,40})$/.exec(id)?.[1].slice(0,12)): CaptureSeal[] {
  const sorted = [...events].sort((a,b) => a.seq - b.seq);
  const firstStamped = policy.firstStampedSeq ?? sorted.find(e => typeof e.method?.params?.sealed_by === "string")?.seq ?? Infinity;
  const stamps = new Set(policy.hookSealedBy ?? []);
  const excluded = new Set((policy.unreachableShas ?? []).map(s=>s.includes("@")?s:s.slice(0,12)));
  const grouped = new Map<string, CaptureSeal>();
  for (const e of sorted) {
    if (e.action !== "committed" && e.action !== "merged") continue;
    const stamp = e.method?.params?.sealed_by;
    const shape = e.method?.tool === "git" && (e.idempotency_key === undefined || e.idempotency_key.startsWith("git:"));
    const legacy = stamp === undefined && e.seq < firstStamped && e.method?.tool === "git" && !e.tags?.includes("push");
    const hook = shape && (typeof stamp === "string" && (stamps.has(stamp) || stamp === "owner" && policy.ownerSeals === true) || stamp === undefined && policy.allowUnstampedSeals === true);
    const webhook = e.tags?.includes("push") && stamp === "webhook:github";
    if (!legacy && !hook && !webhook) continue;
    const id = e.artifacts.find(a => a.id.startsWith("commit:"))?.id;
    const key = id ? resolve(id) : undefined;
    if (!key || excluded.has(key) || excluded.has(key.slice(0,12))) continue;
    const item = grouped.get(key) ?? { key, seq: e.seq, event: e, paths: new Set<string>() };
    for (const a of e.artifacts) item.paths.add(a.id);
    grouped.set(key, item);
  }
  return [...grouped.values()].sort((a,b) => a.seq - b.seq);
}
