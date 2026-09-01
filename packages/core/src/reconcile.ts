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

export type ReconcileFindingKind = "missing_commit" | "misattributed" | "uncovered" | "loose_match" | "orphan_edit" | "non_agent";
export type ReconcileLevel = "fail" | "warn" | "info";
export interface ReconcileFinding {
  kind: ReconcileFindingKind;
  level: ReconcileLevel;
  sha?: string;
  file?: string;
  detail: string;
  /** a later ledger event tagged `correction` that references this commit; the finding then never counts as a failure */
  acknowledged?: { seq: number; id: string };
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
  sealed?: { seq: number; id: string; action: string; actor: Event["actor"] };
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

/** Correction events name commits at whatever length git printed them (7–40 hex); match on prefix. */
function ackFor(acks: Map<string, { seq: number; id: string }>, sha12: string): { seq: number; id: string } | undefined {
  const exact = acks.get(sha12); if (exact) return exact;
  for (const [k, v] of acks) if (k.length >= 7 && sha12.startsWith(k)) return v;
  return undefined;
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

  // sealed commit events by sha12 (first seal wins — a replay is deduped by idempotency key anyway)
  const sealedBySha = new Map<string, Event>();
  // every commit event's touched paths, in seq order — the "previous touch" index
  const commitTouches: { seq: number; paths: Set<string> }[] = [];
  // edit events with the repo paths they touch
  const edits: { e: Event; paths: { path: string; loose: boolean }[] }[] = [];
  // acknowledgements: correction events → the commit sha12s they reference
  const acks = new Map<string, { seq: number; id: string }>();
  for (const e of evs) {
    if (COMMIT_ACTIONS.has(e.action)) {
      const id = commitIdOf(e); const sha = id && commitSha12(id);
      if (sha && !sealedBySha.has(sha)) sealedBySha.set(sha, e);
      const paths = new Set<string>();
      for (const a of e.artifacts) { const p = artifactPath(a.id, { repoNames, repoPath: opts.repoPath }); if (p) paths.add(p.path); }
      commitTouches.push({ seq: e.seq, paths });
      continue;
    }
    if (e.tags?.includes("correction")) {
      for (const a of e.artifacts) { const sha = a.id.startsWith("commit:") ? commitSha12(a.id) : undefined; if (sha && !acks.has(sha)) acks.set(sha, { seq: e.seq, id: e.id }); }
    }
    if (EDIT_ACTIONS.has(e.action) && e.actor.type === "agent") {
      const paths: { path: string; loose: boolean }[] = [];
      for (const a of e.artifacts) { const p = artifactPath(a.id, { repoNames, repoPath: opts.repoPath }); if (p) paths.push(p); }
      if (paths.length) edits.push({ e, paths });
    }
  }

  const prevTouchSeq = (path: string, beforeSeq: number | null): number => {
    let seq = -1;
    for (const t of commitTouches) { if (beforeSeq !== null && t.seq >= beforeSeq) break; if (t.paths.has(path)) seq = t.seq; }
    return seq;
  };

  const verdicts: CommitVerdict[] = [];
  const summary: ReconcileReport["summary"] = { commits: commits.length, sealed: 0, acknowledged: 0, missing_commit: 0, misattributed: 0, uncovered: 0, loose_match: 0, orphan_edit: 0, non_agent: 0 };
  const consumed = new Set<number>(); // seqs of edit events covered by some commit
  for (const c of commits) {
    const short = c.sha.slice(0, 12);
    const sealedEvent = sealedBySha.get(short);
    const v: CommitVerdict = { sha: c.sha, short, coverage: {}, findings: [] };
    const ack = ackFor(acks, short);
    const add = (kind: ReconcileFindingKind, level: ReconcileLevel, detail: string, file?: string) => {
      const f: ReconcileFinding = { kind, level, sha: short, file, detail };
      if (ack && level !== "info") { f.acknowledged = ack; f.level = "info"; }
      v.findings.push(f);
    };
    if (!sealedEvent) {
      // A bot's commit (a CI checkpoint branch, dependabot) is made where no hook runs; its PR merge is sealed by the
      // webhook, so the gap is a known producer limit (enable RETRACE_GITHUB_PUSH), not a silent human or agent.
      const who = `${c.author?.name ?? ""} <${c.author?.email ?? ""}>`;
      const bot = /\[bot\]|noreply\.github\.com/i.test(who);
      add("missing_commit", bot ? "warn" : "fail", `${short} (${c.author?.email ?? c.author?.name ?? "unknown author"}, ${c.time ?? "?"}) has no committed/merged event — ${bot ? "a bot commit made where no hook runs; enable the GitHub push webhook (RETRACE_GITHUB_PUSH=1) to seal it" : "the git hook or webhook missed it"}`);
      verdicts.push(v); continue;
    }
    summary.sealed++;
    v.sealed = { seq: sealedEvent.seq, id: sealedEvent.id, action: sealedEvent.action, actor: sealedEvent.actor };
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
        n++; actors.add(ed.e.actor.id); consumed.add(ed.e.seq);
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
    if (consumed.has(ed.e.seq) || firstSeq === null) continue;
    const target = ed.e.seq > lastSeq! ? pendingMap : ed.e.seq > firstSeq ? orphanMap : undefined;
    if (!target) continue;
    for (const p of ed.paths) {
      const o = target.get(p.path) ?? { path: p.path, actors: [], events: 0, last_seq: 0 };
      o.events++; o.last_seq = Math.max(o.last_seq, ed.e.seq);
      if (!o.actors.includes(ed.e.actor.id)) o.actors.push(ed.e.actor.id);
      target.set(p.path, o);
    }
  }
  const orphans = [...orphanMap.values()].sort((a, b) => a.last_seq - b.last_seq);
  summary.orphan_edit = orphans.length;
  const ok = !verdicts.some((v) => v.findings.some((f) => f.level === "fail"));
  return { format: "retrace-reconcile/1", repo_name: opts.repoName, range: { commits: commits.length, first_seq: firstSeq, last_seq: lastSeq, head_seq: headSeq }, commits: verdicts, orphans, pending: [...pendingMap.values()], summary, ok };
}

/** One-line-per-finding text rendering shared by the CLI and the workflow PR body. */
export function renderReconcileReport(r: ReconcileReport): string {
  const lines: string[] = [];
  const s = r.summary;
  lines.push(`reconcile ${r.repo_name}: ${s.commits} commit${s.commits === 1 ? "" : "s"}, ${s.sealed} sealed — ${s.missing_commit} missing, ${s.misattributed} misattributed, ${s.uncovered} uncovered, ${s.loose_match} loose, ${s.non_agent} non-agent, ${s.orphan_edit} orphan path${s.orphan_edit === 1 ? "" : "s"}, ${r.pending.length} pending${s.acknowledged ? `, ${s.acknowledged} acknowledged` : ""} → ${r.ok ? "OK" : "NOT OK"}`);
  for (const v of r.commits) for (const f of v.findings) {
    lines.push(`  ${f.acknowledged ? "ACK " : f.level.toUpperCase().padEnd(4)} ${f.kind.padEnd(14)} ${f.detail}${f.acknowledged ? ` (corrected by #${f.acknowledged.seq})` : ""}`);
  }
  for (const o of r.orphans) lines.push(`  INFO orphan_edit    ${o.path}: ${o.events} edit${o.events === 1 ? "" : "s"} by ${o.actors.join(", ")} (last #${o.last_seq}) not carried by any commit in range`);
  return lines.join("\n");
}
