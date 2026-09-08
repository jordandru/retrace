import type { Event } from "./schema.js";
import { GENESIS_HASH } from "./schema.js";
import { canonicalize, verifyChain, sha256Hex } from "./chain.js";
import { captureSeals, previousCaptureTouch } from "./capture.js";

export interface AttributionSnapshot { project: string; events: Event[]; head: { seq: number; hash: string } }
const verified = new WeakSet<AttributionSnapshot>();
/** Call only after authenticating the head (trusted export/head signature, or authoritative local storage).
 * Recheck raw bytes, exact duplicates, project membership and genesis completeness before issuing an in-process proof.
 */
export async function verifiedAttributionSnapshot(events: Event[], project: string, head: { seq: number; hash: string }): Promise<AttributionSnapshot> {
  const ids = new Map<string, Event>();
  for (const e of events) {
    if (e.project !== project || !Number.isSafeInteger(e.seq) || e.seq < 0) throw new Error("invalid_snapshot");
    const prior = ids.get(e.id);
    if (prior && canonicalize(prior) !== canonicalize(e)) throw new Error("invalid_snapshot: conflicting id");
    ids.set(e.id, e);
  }
  const sorted = [...ids.values()].sort((a,b) => a.seq - b.seq);
  if (new Set(sorted.map(e => e.seq)).size !== sorted.length) throw new Error("invalid_snapshot: conflicting sequence");
  if (head.seq !== sorted.length - 1 || head.hash !== (sorted.at(-1)?.hash ?? GENESIS_HASH)) throw new Error("incomplete_snapshot");
  const integrity = await verifyChain(sorted);
  if (!integrity.ok) throw new Error(`invalid_snapshot: ${integrity.reason}`);
  // Freeze a deep copy so a caller cannot change bytes after verification.
  const freeze = (o: any): any => { if (o && typeof o === "object") { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
  const snapshot: AttributionSnapshot = freeze(JSON.parse(JSON.stringify({ project, events: sorted, head })));
  verified.add(snapshot); return snapshot;
}
export const isVerifiedAttributionSnapshot = (snapshot?: AttributionSnapshot): snapshot is AttributionSnapshot => !!snapshot && verified.has(snapshot);

export interface AttributionUnit {
  id: string;
  refs: number[];
  /** Strict canonical evidence identities, including a verified rename/copy source. */
  names: string[];
  after: number; before: number;
}
export interface AttributionDomain { units: AttributionUnit[]; complete: boolean }
export interface AttributionCaptureContext {
  profile: "retrace-attribution/1";
  project: string; head_seq: number; head_hash: string;
  policy_digest: string; git_facts_digest: string;
  domains: Map<string, AttributionDomain>;
  canonicalArtifact: (id: string, seq: number) => string | undefined;
}

export interface AttributionPolicy {
  profile: "retrace-attribution/1";
  repositories: { name: string; aliases: string[]; from_seq: number; through_seq?: number; hook_sealed_by: string[]; owner_seals?: boolean; allow_unstamped_seals?: boolean }[];
  non_git: { scheme: string; from_seq: number; through_seq?: number; capture_stamps: string[] }[];
}
export interface AttributionGitFacts {
  /** Raw commit reference -> canonical repo and full OID. No implicit prefix resolution in core. */
  resolutions: Record<string, { repo: string; oid: string }>;
  commits: { repo: string; oid: string; parents: string[]; diff_profile: "first-parent-M-C/1"; files: { path: string; status: string; from?: string }[] }[];
  excluded: string[]; // canonical repo@full-OID; ref-reachability + checkout horizon decided by Git adapter
  refs: string[];
  object_format: "sha1" | "sha256";
}
const inInterval = (p: { from_seq: number; through_seq?: number }, seq: number) => seq >= p.from_seq && seq <= (p.through_seq ?? Infinity);
const safePath = (p: string) => !!p && !p.startsWith("/") && !p.split("/").some(x => x === ".." || x === "." || !x) && !/[\0\r\n\t]/.test(p);

/** Pure context preparation from explicit policy and verified Git observations. Missing required inputs fail closed. */
export async function prepareAttributionContext(snapshot: AttributionSnapshot, policy: AttributionPolicy, facts: AttributionGitFacts, extraTargets: string[] = []): Promise<AttributionCaptureContext> {
  if (!isVerifiedAttributionSnapshot(snapshot)) throw new Error("untrusted_snapshot");
  if (policy.profile !== "retrace-attribution/1" || !Array.isArray(policy.repositories) || !Array.isArray(policy.non_git)) throw new Error("context_missing: attribution policy");
  const canonicalArtifact = (id: string, seq: number): string | undefined => {
    const match = /^repo:([^#]+)#(.+)$/.exec(id);
    if (match) {
      if (!safePath(match[2])) throw new Error("context_conflict: invalid repository path");
      const mappings = policy.repositories.filter(p => inInterval(p,seq) && [p.name,...p.aliases].includes(match[1]));
      if (mappings.length > 1) throw new Error("context_conflict: overlapping repository mapping");
      return mappings[0] ? `repo:${mappings[0].name}#${match[2]}` : undefined;
    }
    if (/^(commit|event|actor|file):/.test(id) || !/^[a-z][a-z0-9+.-]*:/i.test(id)) return undefined;
    const scheme = id.split(":")[0];
    const mappings = policy.non_git.filter(p => p.scheme === scheme && inInterval(p,seq));
    if (mappings.length > 1) throw new Error("context_conflict: overlapping non-Git policy");
    return mappings.length === 1 ? id : undefined;
  };
  // Historical coverage is mandatory for every reference using a declared repository alias.
  for (const e of snapshot.events) for (const a of e.artifacts) {
    const repo=/^(?:repo:([^#]+)#|commit:([^@]+)@)/.exec(a.id)?.slice(1).find(Boolean);
    if (!repo) continue;
    const declared=policy.repositories.filter(p=>[p.name,...p.aliases].includes(repo));
    if (declared.length && !declared.some(p=>inInterval(p,e.seq))) throw new Error(`context_missing: historical mapping at #${e.seq}`);
    if((e.action === "committed" || e.action === "merged") && a.id.startsWith("commit:") && declared.length && !facts.resolutions[a.id])throw new Error(`context_missing: prior commit identity ${a.id}`);
  }
  const resolve = (id: string) => {
    const r = facts.resolutions[id];
    if (!r || !new RegExp(`^[0-9a-f]{${facts.object_format === "sha256" ? 64 : 40}}$`).test(r.oid)) throw new Error(`context_missing: full commit identity ${id}`);
    return `${r.repo}@${r.oid}`;
  };
  const seals = new Map<string, { key: string; seq: number; paths: Set<string> }>();
  for (const p of policy.repositories) {
    const events = snapshot.events.filter(e => inInterval(p,e.seq) && e.artifacts.some(a => a.id.startsWith("commit:") && facts.resolutions[a.id]?.repo === p.name));
    const index = captureSeals(events, { repoName:p.name, hookSealedBy:p.hook_sealed_by, ownerSeals:p.owner_seals, allowUnstampedSeals:p.allow_unstamped_seals, unreachableShas:facts.excluded,firstStampedSeq:snapshot.events.find(e=>typeof e.method?.params?.sealed_by==="string")?.seq ?? Infinity }, resolve);
    for (const t of index) {
      const old = seals.get(t.key);
      const value = old ?? { key:t.key, seq:t.seq, paths:new Set<string>() };
      value.seq = Math.min(value.seq,t.seq);
      // Preserve historical mappings on each raw reference rather than applying today's alias map.
      for (const e of events) if (e.artifacts.some(a => a.id.startsWith("commit:") && resolve(a.id) === t.key))
        for (const a of e.artifacts) { const id = canonicalArtifact(a.id,e.seq); if (id) value.paths.add(id); }
      seals.set(t.key,value);
    }
  }
  const targets = new Set([...extraTargets, ...snapshot.events.filter(e => e.action_detail === "amended").map(e => String(e.method?.params?.target_event_id))]);
  const domains = new Map<string, AttributionDomain>();
  for (const target of snapshot.events.filter(e => targets.has(e.id))) {
    const gitTarget = target.action === "committed" || target.action === "merged";
    const commitRef = gitTarget ? target.artifacts.find(a => a.id.startsWith("commit:"))?.id : undefined;
    const resolved = commitRef ? facts.resolutions[commitRef] : undefined;
    if (gitTarget && !resolved) throw new Error(`context_missing: target commit ${target.id}`);
    const diff = resolved ? facts.commits.find(c => c.repo === resolved.repo && c.oid === resolved.oid) : undefined;
    if (resolved && !diff) throw new Error(`context_missing: target diff ${target.id}`);
    if (diff && (diff.diff_profile !== "first-parent-M-C/1" || diff.files.some(f => !safePath(f.path) || f.from !== undefined && !safePath(f.from) || ["R","C"].includes(f.status) && !f.from))) throw new Error("context_conflict: diff profile or paths");
    const ownKey = commitRef ? resolve(commitRef) : undefined;
    const before = Math.min(target.seq, ownKey ? seals.get(ownKey)?.seq ?? target.seq : target.seq);
    const units = new Map<string, AttributionUnit>();
    target.artifacts.forEach((a,index) => {
      if (/^(commit|event|actor):/.test(a.id) || ["commit","event","actor"].includes(a.kind ?? "")) return;
      const output = a.role !== undefined ? a.role === "generated" || a.role === "both" : ["created","edited","deleted","renamed","moved","committed","merged"].includes(target.action);
      if (!output) return;
      const id = canonicalArtifact(a.id,target.seq);
      if (!id) throw new Error(`context_missing: strict artifact mapping ${a.id}`);
      const f = diff?.files.find(f => id === `repo:${diff.repo}#${f.path}`);
      if (diff && !f) return;
      const names = [id, ...(f?.from ? [`repo:${diff!.repo}#${f.from}`] : [])];
      let touches = [...seals.values()].filter(t => t.key !== ownKey);
      if (!id.startsWith("repo:")) {
        const configured = policy.non_git.filter(p => p.scheme === id.split(":")[0]);
        // Policy-designated commit/merge capture events only; ordinary edit claims never close a window.
        touches = snapshot.events.filter(e => (e.action === "committed" || e.action === "merged") && configured.some(p => inInterval(p,e.seq) && p.capture_stamps.includes(String(e.method?.params?.sealed_by))) && e.artifacts.some(a => a.id === id && a.role !== "used"))
          .map(e => ({ key:e.id,seq:e.seq,paths:new Set([id]) }));
      }
      const after = Math.max(...names.map(n => previousCaptureTouch(touches,n,before)));
      const unit = units.get(id) ?? { id,refs:[],names,after,before };
      unit.refs.push(index); units.set(id,unit);
    });
    domains.set(target.id, { units:[...units.values()].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), complete:!diff || diff.files.every(f => units.has(`repo:${diff.repo}#${f.path}`)) });
  }
  return { profile:policy.profile,project:snapshot.project,head_seq:snapshot.head.seq,head_hash:snapshot.head.hash,policy_digest:await sha256Hex(canonicalize(policy)),git_facts_digest:await sha256Hex(canonicalize(facts)),domains,canonicalArtifact };
}
