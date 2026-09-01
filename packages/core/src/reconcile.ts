/**
 * Reconciliation — tamper-evident roadmap rung 4 (docs/reconciliation-plan.md).
 *
 * The gate proves a commit IS in the ledger; nothing proves the edits behind it were logged. Reconciliation takes the
 * commit list from git (never from the ledger — a commit the hook missed must stay visible) and, for every file a
 * commit changed, looks for edit events in that file's CAPTURE WINDOW: ledger events with seq strictly between the
 * `committed` event of the previous commit that touched the file and the `committed` event of this one. Server-assigned
 * seq orders the window; client timestamps are asserted and never used. Reaching back to the previous touch (not the
 * parent commit) is what makes uncommitted work reconcile: edits that sat in the tree for days still fall inside the
 * window of whichever commit finally carried them.
 *
 * Findings — see ReconcileFindingKind. A covering event proves an agent CLAIMED the edit, not that the diff matches what
 * it logged (edit events carry no per-file content hash yet); human edits are outside the ledger by design.
 *
 * Pure and portable: no git, no fetch. The CLI supplies CommitFacts from git and events from a full export.
 */
import { Event } from "./schema.js";

export type CommitFileStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X";
export interface CommitFile { path: string; status: CommitFileStatus; /** rename/copy source */ from?: string }
export interface CommitFacts {
  sha: string;
  parents: string[];
  files: CommitFile[];
  /** git author, used only to describe commits the ledger never sealed */
  author?: { name?: string; email?: string };
  /** author time, ISO */
  time?: string;
}

export type ReconcileFindingKind = "missing_commit" | "misattributed" | "uncovered" | "loose_match" | "orphan_edit" | "non_agent" | "producer_disagreement" | "unreachable_seal";
export type ReconcileLevel = "fail" | "warn" | "info";
export interface ReconcileFinding {
  kind: ReconcileFindingKind;
  level: ReconcileLevel;
  sha?: string;
  file?: string;
  detail: string;
  /** a `correction`-tagged event sealed AFTER this commit's seal, by an actor other than the accused committer (and in
   *  opts.ackActors when set), that references the commit; the finding then never counts as a failure. Unsealed
   *  commits cannot be acknowledged at all — a sha is computable before the commit exists, so a pre-logged
   *  "correction" would let anyone whitelist a commit in advance. */
  acknowledged?: { seq: number; id: string; actor: string };
}

export interface FileCoverage {
  /** distinct actor ids on matching edit events in the window */
  actors: string[];
  events: number;
  /** every matching event identified the file loosely (file:/bare path or a foreign repo alias) */
  loose: boolean;
  /** seq bounds of the window (exclusive) */
  window: { after: number; before: number | null };
}

export interface CommitVerdict {
  sha: string;
  short: string;
  sealed?: { seq: number; id: string; action: string; actor: Event["actor"]; /** which producer's event this is */ producer: "hook" | "webhook" };
  /** the GitHub push webhook's event for the same commit, when the server stamped it (phase B) */
  webhook?: { seq: number; id: string; actor: Event["actor"] };
  coverage: Record<string, FileCoverage>;
  findings: ReconcileFinding[];
}

export interface OrphanEdit { path: string; actors: string[]; events: number; last_seq: number }

export interface ReconcileReport {
  format: "retrace-reconcile/1";
  repo_name: string;
  range: { commits: number; first_seq: number | null; last_seq: number | null; head_seq: number | null };
  commits: CommitVerdict[];
  orphans: OrphanEdit[];
  /** edits sealed after the last commit in range: not yet committed, not a finding */
  pending: OrphanEdit[];
  /** every sealed sha the ledger knows in this export (hook, webhook or legacy) with its seq — the caller checks
   *  these against git REF REACHABILITY and passes the vanished ones back as opts.unreachableShas */
  seals: { sha12: string; seq: number }[];
  summary: Record<ReconcileFindingKind | "commits" | "sealed" | "acknowledged", number>;
  /** no unacknowledged fail-level finding */
  ok: boolean;
}

export interface ReconcileOptions {
  /** the name the git hook uses in artifact ids (`commit:<repoName>@…`, `repo:<repoName>#…`) */
  repoName: string;
  /** other names producers use for the same repo — `retrace` for `jordandru/retrace`; the basename is always accepted */
  aliases?: string[];
  /** absolute repo path, so `file:/abs/path` ids can be mapped to repo paths */
  repoPath?: string;
  /** gate level for a file with no covering event (default warn — silent producers exist; promote per repo) */
  uncovered?: ReconcileLevel;
  /** Agent actor ids allowed to acknowledge findings with a `correction` event. Humans always may; agents ONLY when
   *  listed here (default: none — event #1227 showed the same model and session re-pinned as another harness to
   *  acknowledge its own commit). Even a listed agent is refused when it shares the accused seal's model or session. */
  ackActors?: string[];
  /** The EXACT server stamps that identify this repo's git hook credential — `assert:<credential name>` as the Worker
   *  writes it (`.retrace.json` → `reconcile.hook_sealed_by`). Nothing is trusted by class: another assert credential
   *  (a Drive forwarder, a backfill token) can send a git-shaped payload and must not pass as the hook; a `pinned:`
   *  agent credential likewise makes a claim, never a seal. Unset → no hook seal is trusted (fail closed; the finding
   *  says what to configure). */
  hookSealedBy?: string[];
  /** Accept `sealed_by: owner` (the operator token) as a hook seal. Off by default: the owner is an operator override
   *  and not an independent machine witness — document it when you turn it on. */
  ownerSeals?: boolean;
  /** Accept committed events that carry no `sealed_by` stamp (sealed before the server stamped, or by a local store)
   *  as hook seals. Default false — fail closed; pass --allow-unstamped-seals for historical runs. */
  allowUnstampedSeals?: boolean;
  /** Shas (7–40 hex) the ledger sealed that the repository no longer contains — the caller checks git
   *  (`git cat-file --batch-check`). Their seals are reported as `unreachable_seal` (amended or rebased after the hook
   *  ran) and never bound a file's window, so the edits their replacement carried still reconcile. */
  unreachableShas?: string[];
  /** Once both producers are active, an AGENT commit sealed by only one of them: "fail" (default — dual witness is
   *  the point of phase B; an amend or rebase after the hook ran shows up exactly this way) or "warn" (local runs on
   *  unpushed work). Non-agent commits always warn. */
  dualWitness?: "fail" | "warn";
}

const EDIT_ACTIONS = new Set(["created", "edited", "deleted", "renamed", "moved"]);
const COMMIT_ACTIONS = new Set(["committed", "merged"]);

/** Map an artifact id to a repo-relative path, or undefined when it does not name a file in this repo. */
export function artifactPath(id: string, opts: { repoNames: Set<string>; repoPath?: string }): { path: string; loose: boolean } | undefined {
  const repo = /^repo:([^#]+)#(.+)$/.exec(id);
  if (repo) return { path: norm(repo[2]), loose: !opts.repoNames.has(repo[1]) };
  const file = /^file:(.+)$/.exec(id);
  if (file) {
    if (!opts.repoPath) return undefined;
    const root = opts.repoPath.replace(/\/+$/, "") + "/";
    const abs = norm(file[1]);
    return abs.startsWith(root) ? { path: abs.slice(root.length), loose: true } : undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(id)) return undefined; // commit:, pr:, https:, run:, …
  if (id.startsWith("/") || id.includes("..")) return undefined;
  return { path: norm(id), loose: true }; // bare relative path
}

interface Ack { seq: number; id: string; actor: string; actorType: string; model?: string; session?: string }

/** Correction events name commits at whatever length git printed them (7–40 hex); match on prefix. An ack counts only
 *  if sealed after the commit's own seal and by someone who is not the accused: a human, or an agent on the explicit
 *  ackActors list that does not share the accused seal's model or session — a different pinned identity driven by the
 *  same model/session (#1227: cursor-agent on grok-4.6 acknowledging grok) is the accused wearing another badge. */
function ackFor(acks: Map<string, Ack[]>, sha12: string, sealed: Event, ackActors: string[] | undefined): { seq: number; id: string; actor: string } | undefined {
  const candidates: Ack[] = [];
  for (const [k, list] of acks) if (k === sha12 || (k.length >= 7 && sha12.startsWith(k))) candidates.push(...list);
  const accused = sealed.actor.id, accusedModel = sealed.actor.model, accusedSession = sealed.location?.session;
  const ok = candidates.filter((a) => {
    if (a.seq <= sealed.seq || a.actor === accused) return false;
    if (a.actorType === "human") return true;
    if (a.actorType !== "agent" || !ackActors?.includes(a.actor)) return false;
    if (accusedModel && a.model && a.model === accusedModel) return false;
    if (accusedSession && a.session && a.session === accusedSession) return false;
    return true;
  });
  ok.sort((a, b) => a.seq - b.seq);
  return ok[0] ? { seq: ok[0].seq, id: ok[0].id, actor: ok[0].actor } : undefined;
}

function sealedByOf(e: Event): string | undefined {
  const v = (e.method?.params as Record<string, unknown> | undefined)?.sealed_by;
  return typeof v === "string" ? v : undefined;
}

function norm(p: string): string { return p.replace(/\\/g, "/").replace(/^\.\//, ""); }

function commitIdOf(e: Event): string | undefined {
  return e.artifacts.find((a) => a.kind === "commit" || a.id.startsWith("commit:"))?.id;
}
function commitSha12(id: string): string | undefined { return /^commit:[^@]+@([0-9a-f]{7,40})$/.exec(id)?.[1]?.slice(0, 12); }

export function reconcile(commits: CommitFacts[], events: Event[], opts: ReconcileOptions): ReconcileReport {
  const repoNames = new Set([opts.repoName, ...(opts.aliases ?? []), opts.repoName.split("/").pop()!]);
  const uncoveredLevel = opts.uncovered ?? "warn";
  const evs = [...events].sort((a, b) => a.seq - b.seq);
  const headSeq = evs.length ? evs[evs.length - 1].seq : null;

  // sealed commit events by sha12 and producer. hook = the git post-commit hook on the committing machine (key git:<sha>);
  // webhook = the GitHub push webhook (key gh:push:…, tag "push"), counted ONLY when the server stamped the seal as
  // webhook:github — a push-shaped event without that stamp is something a credentialed client sent, not GitHub.
  const hookBySha = new Map<string, Event>();
  const webhookBySha = new Map<string, Event>();
  // committed-shaped events that are neither: a client's claim (pinned credential, unauthenticated, unstamped) — reported
  const claimedBySha = new Map<string, Event>();
  let webhookSince: number | null = null; // the push webhook is known to be enabled from this seq on
  const hookStamps = new Set(opts.hookSealedBy ?? []);
  const isHookSeal = (e: Event): boolean => {
    const stamp = sealedByOf(e);
    const shape = e.method?.tool === "git" && (e.idempotency_key === undefined || e.idempotency_key.startsWith("git:"));
    if (!shape) return false;
    if (stamp === undefined) return opts.allowUnstampedSeals === true;
    if (stamp === "owner") return opts.ownerSeals === true;
    return hookStamps.has(stamp);
  };
  const seqTouches = new Map<string, { hook?: number; webhook?: number; legacy?: number; paths: Set<string> }>(); // per sha: one boundary
  // The server has stamped sealed_by on every write since this seq. An UNSTAMPED commit event before it is a legacy
  // seal: evidence a commit happened (a window boundary) but not a trusted seal of the commit under test — nothing can
  // produce unstamped events on the server any more, so an attacker cannot plant such a boundary. An unstamped commit
  // event after it is a client claim and bounds nothing (a planted "commit" could otherwise hide a swept edit).
  let firstStampedSeq = Infinity;
  for (const e of evs) if (sealedByOf(e) !== undefined) { firstStampedSeq = e.seq; break; }
  // every commit event's touched paths, in seq order — the "previous touch" index
  const commitTouches: { seq: number; paths: Set<string> }[] = [];
  // edit events with the repo paths they touch
  const edits: { e: Event; paths: { path: string; loose: boolean }[] }[] = [];
  // acknowledgements: correction events → the commit shas they reference (validated per commit in ackFor)
  const acks = new Map<string, Ack[]>();
  // heads of PRs whose merge was sealed by the HMAC-verified GitHub webhook (server-stamped; a credentialed agent
  // cannot produce that stamp). The one non-forgeable reason an unsealed commit is a warning instead of a failure.
  const webhookMergedHeads = new Map<string, number>();
  for (const e of evs) {
    if (COMMIT_ACTIONS.has(e.action)) {
      const id = commitIdOf(e); const sha = id && commitSha12(id);
      const isPush = e.tags?.includes("push") === true;
      let producer: "hook" | "webhook" | "legacy" | undefined;
      if (sha && !isPush && sealedByOf(e) === undefined && e.seq < firstStampedSeq && e.method?.tool === "git") {
        producer = "legacy";
        if (isHookSeal(e)) { if (!hookBySha.has(sha)) hookBySha.set(sha, e); }
        else if (!claimedBySha.has(sha)) claimedBySha.set(sha, e);
      } else if (sha && isPush) {
        if (sealedByOf(e)?.startsWith("webhook:")) { producer = "webhook"; if (!webhookBySha.has(sha)) webhookBySha.set(sha, e); if (webhookSince === null) webhookSince = e.seq; }
        else if (!claimedBySha.has(sha)) claimedBySha.set(sha, e); // push-shaped but not stamped by the server as GitHub's delivery
      } else if (sha) {
        if (isHookSeal(e)) { producer = "hook"; if (!hookBySha.has(sha)) hookBySha.set(sha, e); }
        else if (!claimedBySha.has(sha)) claimedBySha.set(sha, e);
      }
      // Window boundaries: one per sha, at the hook's seq when the hook sealed it (the webhook's copy lands later and
      // must not push a file's window past edits that preceded the real commit). Claims are not boundaries.
      if (sha && producer) {
        const t = seqTouches.get(sha) ?? { paths: new Set<string>() };
        for (const a of e.artifacts) { const p = artifactPath(a.id, { repoNames, repoPath: opts.repoPath }); if (p) t.paths.add(p.path); }
        t[producer] = e.seq; seqTouches.set(sha, t);
      }
      if (e.action === "merged" && sealedByOf(e)?.startsWith("webhook:")) {
        const head = (e.method?.params as Record<string, unknown> | undefined)?.head_sha;
        if (typeof head === "string" && /^[0-9a-f]{7,40}$/i.test(head)) webhookMergedHeads.set(head.slice(0, 12).toLowerCase(), e.seq);
        for (const a of e.artifacts) for (const d of a.derived_from ?? []) { const s = d.startsWith("commit:") ? commitSha12(d) : undefined; if (s && a.kind === "pr") webhookMergedHeads.set(s, e.seq); }
      }
      continue;
    }
    if (e.tags?.includes("correction")) {
      for (const a of e.artifacts) {
        const sha = a.id.startsWith("commit:") ? commitSha12(a.id) : undefined;
        if (!sha) continue;
        const list = acks.get(sha) ?? []; list.push({ seq: e.seq, id: e.id, actor: e.actor.id, actorType: e.actor.type, model: e.actor.model, session: e.location?.session }); acks.set(sha, list);
      }
    }
    // An agent event covers a file when the artifact ref's PROV role says the activity generated that file's state
    // (`generated`/`both`). An explicit role is authoritative — `edited` with role `used` is a declared input, not a
    // change. Only a ref with NO role falls back to the action verb. Commit events were handled above.
    if (e.actor.type === "agent") {
      const paths: { path: string; loose: boolean }[] = [];
      for (const a of e.artifacts) {
        const covers = a.role !== undefined ? a.role === "generated" || a.role === "both" : EDIT_ACTIONS.has(e.action);
        if (!covers) continue;
        const p = artifactPath(a.id, { repoNames, repoPath: opts.repoPath }); if (p) paths.push(p);
      }
      if (paths.length) edits.push({ e, paths });
    }
  }

  // Boundaries come from commits that still exist. A seal for a sha git no longer has (amended / rebased after the
  // hook ran) must not swallow the edits its replacement carried.
  const unreachable = new Set((opts.unreachableShas ?? []).map((x) => x.toLowerCase().slice(0, 12)));
  for (const [sha, t] of seqTouches) {
    if (unreachable.has(sha)) continue;
    commitTouches.push({ seq: t.hook ?? t.legacy ?? t.webhook!, paths: t.paths });
  }
  commitTouches.sort((a, b) => a.seq - b.seq);
  const prevTouchSeq = (path: string, beforeSeq: number | null): number => {
    let seq = -1;
    for (const t of commitTouches) { if (beforeSeq !== null && t.seq >= beforeSeq) break; if (t.paths.has(path)) seq = t.seq; }
    return seq;
  };

  const verdicts: CommitVerdict[] = [];
  const summary: ReconcileReport["summary"] = { commits: commits.length, sealed: 0, acknowledged: 0, missing_commit: 0, misattributed: 0, uncovered: 0, loose_match: 0, orphan_edit: 0, non_agent: 0, producer_disagreement: 0, unreachable_seal: 0 };
  const consumed = new Set<string>(); // "<seq>\u0000<path>" pairs covered by some commit — an event naming A+B where only A was committed still leaves B an orphan
  for (const c of commits) {
    const short = c.sha.slice(0, 12);
    const hookEvent = hookBySha.get(short);
    const webhookEvent = webhookBySha.get(short);
    const sealedEvent = hookEvent ?? webhookEvent;
    const v: CommitVerdict = { sha: c.sha, short, coverage: {}, findings: [] };
    // Acknowledgement is resolved only for sealed commits (see ReconcileFinding.acknowledged); git author fields are
    // never consulted for anything but the description — they are whatever the pusher typed.
    const ack = sealedEvent ? ackFor(acks, short, sealedEvent, opts.ackActors) : undefined;
    const add = (kind: ReconcileFindingKind, level: ReconcileLevel, detail: string, file?: string) => {
      const f: ReconcileFinding = { kind, level, sha: short, file, detail };
      if (ack && level !== "info") { f.acknowledged = ack; f.level = "info"; }
      v.findings.push(f);
    };
    if (!sealedEvent) {
      const mergedIn = webhookMergedHeads.get(short);
      const claim = claimedBySha.get(short);
      const who = `${c.author?.email ?? c.author?.name ?? "unknown author"}, ${c.time ?? "?"}`;
      if (claim) {
        const stamp = sealedByOf(claim);
        const hint = stamp === undefined && !claim.tags?.includes("push") ? " (pass --allow-unstamped-seals for pre-stamp history)" : stamp === "owner" ? " (owner seals are an operator override: reconcile.owner_seals)" : hookStamps.size === 0 ? ` (no hook credential is configured: set reconcile.hook_sealed_by to ["${stamp}"] in .retrace.json if that IS the git hook)` : "";
        add("missing_commit", "fail", `${short} (${who}) has a committed event #${claim.seq} sealed as ${stamp ?? "unstamped"} by ${claim.actor.type} ${claim.actor.id} — not this repo's git hook credential and not the GitHub webhook; nothing authenticated this commit${hint}`);
      }
      else if (mergedIn !== undefined) add("missing_commit", "warn", `${short} (${who}) has no committed event, but it is the head of a pull request whose merge #${mergedIn} was sealed by the GitHub webhook — made where no hook runs; enable the push webhook (RETRACE_GITHUB_PUSH=1) to seal it`);
      else add("missing_commit", "fail", `${short} (${who}) has no committed/merged event — the git hook or webhook missed it`);
      verdicts.push(v); continue;
    }
    summary.sealed++;
    v.sealed = { seq: sealedEvent.seq, id: sealedEvent.id, action: sealedEvent.action, actor: sealedEvent.actor, producer: hookEvent ? "hook" : "webhook" };
    if (webhookEvent) v.webhook = { seq: webhookEvent.seq, id: webhookEvent.id, actor: webhookEvent.actor };
    // Two producers for one fact (phase B). They resolve the actor from the same commit message with the same code, so
    // a difference means the commit was rewritten after the hook ran, or one of the events is not what it claims.
    const who = (a: Event["actor"]) => `${a.type} ${a.id}`;
    if (hookEvent && webhookEvent && who(hookEvent.actor) !== who(webhookEvent.actor)) {
      add("producer_disagreement", "fail", `git hook #${hookEvent.seq} sealed ${short} as ${who(hookEvent.actor)}; the GitHub push webhook #${webhookEvent.seq} resolved ${who(webhookEvent.actor)} from the pushed commit`);
    } else if (!hookEvent && webhookEvent) {
      // Dual witness policy: an agent commit only GitHub saw is what an amend or rebase after the hook ran looks like
      // (the hook's seal stays behind on the old sha — see sealed_not_in_range). Fail unless the run opts into warn.
      const lone = sealedEvent.actor.type === "agent" ? (opts.dualWitness ?? "fail") : "warn";
      add("producer_disagreement", lone, `${short} was sealed only by the GitHub push webhook #${webhookEvent.seq}; the git hook never sealed this sha — the hook did not run on the committing machine, or the commit was amended/rebased after it ran`);
    } else if (hookEvent && !webhookEvent && webhookSince !== null && hookEvent.seq > webhookSince) {
      const lone = sealedEvent.actor.type === "agent" ? (opts.dualWitness ?? "fail") : "warn";
      add("producer_disagreement", lone, `${short} was sealed by the git hook #${hookEvent.seq} but never seen by the GitHub push webhook (enabled since #${webhookSince}) — not pushed, or pushed outside the webhook`);
    }
    const isMerge = sealedEvent.action === "merged" || c.parents.length > 1;
    if (isMerge) { verdicts.push(v); continue; }
    if (sealedEvent.actor.type !== "agent") {
      add("non_agent", "info", `${short} was sealed as ${sealedEvent.actor.type} ${sealedEvent.actor.id}; coverage is not evaluated for non-agent commits`);
      verdicts.push(v); continue;
    }
    const actorId = sealedEvent.actor.id;
    const coveringActors = new Set<string>();
    for (const f of c.files) {
      const names = new Set([f.path, ...(f.from ? [f.from] : [])]);
      const after = Math.max(...[...names].map((n) => prevTouchSeq(n, sealedEvent.seq)));
      const actors = new Set<string>(); let n = 0; let allLoose = true;
      for (const ed of edits) {
        if (ed.e.seq <= after || ed.e.seq >= sealedEvent.seq) continue;
        const hit = ed.paths.filter((p) => names.has(p.path));
        if (!hit.length) continue;
        n++; actors.add(ed.e.actor.id); for (const p of hit) consumed.add(`${ed.e.seq}\u0000${p.path}`);
        if (hit.some((p) => !p.loose)) allLoose = false;
      }
      const cov: FileCoverage = { actors: [...actors], events: n, loose: n > 0 && allLoose, window: { after, before: sealedEvent.seq } };
      v.coverage[f.path] = cov;
      for (const a of actors) coveringActors.add(a);
      if (n === 0) add("uncovered", uncoveredLevel, `${f.path}: no edit event between #${after < 0 ? "start" : after} and #${sealedEvent.seq}`, f.path);
      else if (cov.loose) add("loose_match", "info", `${f.path}: covered only by loosely-identified refs (file:/bare path or another repo name)`, f.path);
    }
    const files = Object.entries(v.coverage);
    const allCovered = files.length > 0 && files.every(([, cov]) => cov.events > 0);
    if (allCovered && !coveringActors.has(actorId)) {
      // The ledger tells a COMPLETE, contradicting story: every file has logged edits and none are the committer's.
      // Either the committer carried another agent's work (bfe87c3) or it edited every file without logging; the
      // sealed commit claims files whose only logged edits belong to someone else either way.
      add("misattributed", "fail", `sealed as ${actorId}, but every logged edit to its files is by ${[...coveringActors].join(", ")} — ${actorId} committed their work, or edited without logging`);
    } else {
      // Partial story: some files carry only another agent's edits (a sweep of their uncommitted work, or the
      // committer's own unlogged change on a shared file). Per file, warn — the uncovered files say the rest.
      for (const [path, cov] of files) {
        if (cov.events && !cov.actors.includes(actorId)) add("misattributed", "warn", `${path}: edits logged only by ${cov.actors.join(", ")}, committed by ${actorId}`, path);
      }
    }
    verdicts.push(v);
  }

  for (const v of verdicts) for (const f of v.findings) { summary[f.kind]++; if (f.acknowledged) summary.acknowledged++; }

  // orphans: agent edits inside the range that no in-range commit consumed; pending: edits after the last sealed commit
  const sealedSeqs = verdicts.filter((v) => v.sealed).map((v) => v.sealed!.seq);
  const firstSeq = sealedSeqs.length ? Math.min(...sealedSeqs) : null;
  const lastSeq = sealedSeqs.length ? Math.max(...sealedSeqs) : null;
  const orphanMap = new Map<string, OrphanEdit>(); const pendingMap = new Map<string, OrphanEdit>();
  for (const ed of edits) {
    if (firstSeq === null) continue;
    const target = ed.e.seq > lastSeq! ? pendingMap : ed.e.seq > firstSeq ? orphanMap : undefined;
    if (!target) continue;
    for (const p of ed.paths) {
      if (consumed.has(`${ed.e.seq}\u0000${p.path}`)) continue;
      const o = target.get(p.path) ?? { path: p.path, actors: [], events: 0, last_seq: 0 };
      o.events++; o.last_seq = Math.max(o.last_seq, ed.e.seq);
      if (!o.actors.includes(ed.e.actor.id)) o.actors.push(ed.e.actor.id);
      target.set(p.path, o);
    }
  }
  const orphans = [...orphanMap.values()].sort((a, b) => a.last_seq - b.last_seq);
  summary.orphan_edit = orphans.length;
  // seals the repository no longer has: reported as their own verdicts (the replacement commit is what the
  // dual-witness policy judges)
  for (const sha of unreachable) {
    const e = hookBySha.get(sha) ?? webhookBySha.get(sha);
    if (!e) continue; // a legacy claim that vanished: nothing trusted was lost
    const producer = hookBySha.has(sha) ? "hook" : "webhook";
    verdicts.push({ sha, short: sha, sealed: { seq: e.seq, id: e.id, action: e.action, actor: e.actor, producer }, coverage: {}, findings: [{ kind: "unreachable_seal", level: "warn", sha, detail: `${sha} was sealed by the ${producer === "hook" ? "git hook" : "GitHub push webhook"} #${e.seq} as ${e.actor.type} ${e.actor.id} but no longer exists in this repository — amended or rebased after it was sealed; its replacement must be sealed by both producers` }] });
    summary.unreachable_seal++;
  }
  const seals = [...seqTouches.entries()].map(([sha12, t]) => ({ sha12, seq: t.hook ?? t.legacy ?? t.webhook! })).sort((a, b) => a.seq - b.seq);
  const ok = !verdicts.some((v) => v.findings.some((f) => f.level === "fail"));
  return { format: "retrace-reconcile/1", repo_name: opts.repoName, range: { commits: commits.length, first_seq: firstSeq, last_seq: lastSeq, head_seq: headSeq }, commits: verdicts, orphans, pending: [...pendingMap.values()], seals, summary, ok };
}

/** One-line-per-finding text rendering shared by the CLI and the workflow PR body. */
export function renderReconcileReport(r: ReconcileReport): string {
  const lines: string[] = [];
  const s = r.summary;
  lines.push(`reconcile ${r.repo_name}: ${s.commits} commit${s.commits === 1 ? "" : "s"}, ${s.sealed} sealed — ${s.missing_commit} missing, ${s.misattributed} misattributed, ${s.producer_disagreement} producer-disagreement, ${s.unreachable_seal} unreachable-seal, ${s.uncovered} uncovered, ${s.loose_match} loose, ${s.non_agent} non-agent, ${s.orphan_edit} orphan path${s.orphan_edit === 1 ? "" : "s"}, ${r.pending.length} pending${s.acknowledged ? `, ${s.acknowledged} acknowledged` : ""} → ${r.ok ? "OK" : "NOT OK"}`);
  for (const v of r.commits) for (const f of v.findings) {
    lines.push(`  ${f.acknowledged ? "ACK " : f.level.toUpperCase().padEnd(4)} ${f.kind.padEnd(14)} ${f.detail}${f.acknowledged ? ` (corrected by #${f.acknowledged.seq}, ${f.acknowledged.actor})` : ""}`);
  }
  for (const o of r.orphans) lines.push(`  INFO orphan_edit    ${o.path}: ${o.events} edit${o.events === 1 ? "" : "s"} by ${o.actors.join(", ")} (last #${o.last_seq}) not carried by any commit in range`);
  return lines.join("\n");
}
