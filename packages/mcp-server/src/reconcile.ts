/**
 * retrace-export reconcile — git history vs the ledger (roadmap rung 4; core logic in @retrace-dev/core reconcile.ts).
 *   retrace-export reconcile [--repo .] [--since <ref>] [--limit N] [--uncovered warn|fail|info] [--dual-witness fail|warn] [--allow-unstamped-seals] [--hook-sealed-by "assert:<credential name>"] [--pubkey jwk|https-url] [--json] [--gate]
 * Commit facts come from git (`rev-list` + `show --name-status -M`); events from one full export of the project.
 * --gate exits 1 when any unacknowledged fail-level finding exists (missing commit, mis-attributed commit, or an
 * uncovered file when the repo's .retrace.json sets "reconcile": {"uncovered": "fail"}).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CommitFacts, CommitFile, CommitFileStatus, Event, ExportBundle, ReconcileLevel, ReconcileOptions, ReconcileReport, exportVerdictOk, reconcile, renderReconcileReport, verifyExportBundle } from "@retrace-dev/core";
import { resolveTrustedKey } from "./trusted-key.js";
import { Cfg, remoteName } from "./git-hook.js";
import { makeStore } from "./index.js";
import { RemoteStore } from "./remote-store.js";

export type ReconcileCfg = Cfg & { reconcile?: { uncovered?: ReconcileLevel; ack_actors?: string[]; /** exact `assert:<credential name>` stamps of this repo's git hook credential */ hook_sealed_by?: string[]; owner_seals?: boolean; dual_witness?: "fail" | "warn" } };

/**
 * Events from a remote export are used only after the bundle verifies as a complete full export signed by the TRUSTED
 * issuer key (never the key the bundle carries). A broken chain, an unsigned or self-attested bundle, or an incomplete
 * export throws — reconcile must not say OK on data it cannot vouch for (Codex review of 48d7914, P1).
 */
export async function verifiedExportEvents(bundle: ExportBundle, pubkeyFlag?: unknown, baseUrl?: string): Promise<{ events: Event[]; note: string }> {
  const trusted = await resolveTrustedKey(pubkeyFlag, baseUrl);
  if (!trusted) throw new Error("no trusted issuer key: pass --pubkey <jwk.json|https-url>, set RETRACE_PUBKEY, or set RETRACE_URL to an https Retrace server (its /.well-known/retrace-pubkey is used)");
  const v = await verifyExportBundle(bundle, trusted.key);
  if (!exportVerdictOk(v)) throw new Error(`refusing to reconcile against an export that does not verify (signature ${v.signature}, events intact ${v.events_intact}, chain ${v.chain_ok_at_export}, coverage ${v.coverage.complete})${v.problems.length ? ": " + v.problems.join("; ") : ""}`);
  return { events: bundle.events, note: `${bundle.events.length} events from a full export verified against ${trusted.from} (kid ${v.kid})` };
}

const git = (repo: string, args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Parse one `--name-status -M` line: "M\tpath", "R095\told\tnew", "C100\tsrc\tdst". */
export function parseNameStatus(text: string): CommitFile[] {
  return text.split("\n").filter(Boolean).map((l) => {
    const [st, a, b] = l.split("\t");
    const status = st[0] as CommitFileStatus;
    return status === "R" || status === "C" ? { path: b, status, from: a } : { path: a, status };
  });
}

export function commitFacts(repo: string, ref: string): CommitFacts {
  const [sha, parents, name, email, time] = git(repo, ["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI", ref]).split("\x1f");
  const parentList = parents ? parents.split(" ") : [];
  // A shallow checkout keeps the parent shas but not the parent objects; `git show` then diffs against the empty tree
  // and every file in the repo looks changed (retrace-gate run 33474388261). Fail closed rather than report that.
  for (const p of parentList) {
    try { git(repo, ["cat-file", "-e", `${p}^{commit}`]); }
    catch { throw new Error(`cannot compute the diff of ${sha.slice(0, 12)}: parent ${p.slice(0, 12)} is not in this checkout (shallow clone — fetch with depth ≥ 2, or fetch-depth: 0)`); }
  }
  const files = parseNameStatus(git(repo, ["show", "--name-status", "-M", "--format=", sha]));
  return { sha, parents: parentList, files, author: { name, email }, time: new Date(time).toISOString() };
}

/** Oldest → newest. `since` is exclusive (a ref); without it the last `limit` commits. */
export function listCommits(repo: string, opts: { since?: string; limit?: number }): string[] {
  const range = opts.since ? `${opts.since}..HEAD` : "HEAD";
  const args = ["rev-list", "--reverse", ...(opts.limit ? [`--max-count=${opts.limit}`] : []), range];
  const out = git(repo, args);
  return out ? out.split("\n") : [];
}

/** Same naming as the git hook, plus the aliases MCP producers use (`retrace` for `jordandru/retrace`, the project id). */
export function repoNamesFor(repo: string, cfg: ReconcileCfg): { repoName: string; aliases: string[] } {
  const repoName = cfg.repoName ?? remoteName(repo) ?? basename(repo);
  const aliases = [...new Set([basename(repo), cfg.project, repoName.split("/").pop()!].filter((x): x is string => !!x))];
  return { repoName, aliases };
}

/**
 * Which sealed commits have VANISHED from history: not reachable from any ref (`git rev-list --all`, or the given
 * refs) — object existence is not the test, since an amended original lingers as a loose object until gc — AND not
 * older than the checkout's horizon. The horizon is the seq of the oldest seal that IS reachable: in a shallow clone
 * everything before it is simply unfetched history, not evidence of a rewrite, and must keep bounding windows
 * (Codex review of 05c61f9: excluding it let a stale edit cover an unlogged HEAD change). If nothing sealed is
 * reachable at all the checkout tells us nothing, and nothing is excluded.
 */
export function unreachableSeals(repo: string, seals: { sha12: string; seq: number }[], refs: string[] = ["--all"]): string[] {
  if (!seals.length) return [];
  const listed = execFileSync("git", ["-C", repo, "rev-list", ...refs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const reachable = new Set(listed.split("\n").filter(Boolean).map((s) => s.slice(0, 12).toLowerCase()));
  const sorted = [...seals].sort((a, b) => a.seq - b.seq);
  const horizon = sorted.find((s) => reachable.has(s.sha12.toLowerCase()))?.seq;
  if (horizon === undefined) return [];
  return sorted.filter((s) => s.seq >= horizon && !reachable.has(s.sha12.toLowerCase())).map((s) => s.sha12);
}

/** Run reconcile twice at most: once to learn the seals, then — if any vanished from history — with those excluded
 *  from window boundaries and reported as unreachable seals. */
export function reconcileWithGit(repo: string, commits: CommitFacts[], events: Event[], options: Omit<ReconcileOptions, "unreachableShas">, refs?: string[]): ReconcileReport {
  const first = reconcile(commits, events, options);
  const gone = unreachableSeals(repo, first.seals, refs);
  return gone.length ? reconcile(commits, events, { ...options, unreachableShas: gone }) : first;
}

/** Options from .retrace.json `reconcile` plus CLI flags; flags win. */
export function reconcileOptionsFrom(cfg: ReconcileCfg, flags: { uncovered?: ReconcileLevel; dualWitness?: "fail" | "warn"; allowUnstampedSeals?: boolean; hookSealedBy?: string[] } = {}): Pick<ReconcileOptions, "uncovered" | "ackActors" | "hookSealedBy" | "ownerSeals" | "dualWitness" | "allowUnstampedSeals"> {
  return { uncovered: flags.uncovered ?? cfg.reconcile?.uncovered, ackActors: cfg.reconcile?.ack_actors, hookSealedBy: flags.hookSealedBy ?? cfg.reconcile?.hook_sealed_by, ownerSeals: cfg.reconcile?.owner_seals === true, dualWitness: flags.dualWitness ?? cfg.reconcile?.dual_witness, allowUnstampedSeals: flags.allowUnstampedSeals };
}

export function readRepoConfig(repo: string): ReconcileCfg {
  const p = join(repo, ".retrace.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as ReconcileCfg) : {};
}

async function fetchEvents(project: string, pubkeyFlag?: unknown): Promise<{ events: Event[]; note: string }> {
  const store = makeStore();
  if (store instanceof RemoteStore) return verifiedExportEvents(await store.export({ project }), pubkeyFlag);
  const events = await store.all(project);
  return { events, note: `${events.length} events from the local store` };
}

export async function reconcileRepo(repo: string, opts: { since?: string; limit?: number; uncovered?: ReconcileLevel; refs?: string[]; pubkey?: unknown; dualWitness?: "fail" | "warn"; allowUnstampedSeals?: boolean; hookSealedBy?: string[] }): Promise<{ report: ReconcileReport; note: string }> {
  const cfg = readRepoConfig(repo);
  const project = process.env.RETRACE_PROJECT ?? cfg.project ?? basename(repo);
  const shas = opts.refs ?? listCommits(repo, { since: opts.since, limit: opts.since ? opts.limit : opts.limit ?? 50 });
  const commits = shas.map((s) => commitFacts(repo, s));
  const { events, note } = await fetchEvents(project, opts.pubkey);
  const report = reconcileWithGit(repo, commits, events, { ...repoNamesFor(repo, cfg), repoPath: repo, ...reconcileOptionsFrom(cfg, opts) });
  return { report, note };
}

export async function reconcileMain(flags: Record<string, string | boolean>, _pos: string[]): Promise<number> {
  const repo = resolve(git(resolve(String(flags.repo ?? process.cwd())), ["rev-parse", "--show-toplevel"]));
  const uncovered = flags.uncovered ? (String(flags.uncovered) as ReconcileLevel) : undefined;
  if (uncovered && !["warn", "fail", "info"].includes(uncovered)) throw new Error("--uncovered must be warn, fail or info");
  const dualWitness = flags["dual-witness"] ? (String(flags["dual-witness"]) as "fail" | "warn") : undefined;
  if (dualWitness && !["fail", "warn"].includes(dualWitness)) throw new Error("--dual-witness must be fail or warn");
  const { report, note } = await reconcileRepo(repo, { since: flags.since ? String(flags.since) : undefined, limit: flags.limit ? Number(flags.limit) : undefined, uncovered, pubkey: flags.pubkey, dualWitness, allowUnstampedSeals: flags["allow-unstamped-seals"] === true, hookSealedBy: flags["hook-sealed-by"] ? [String(flags["hook-sealed-by"])] : undefined });
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else { console.log(renderReconcileReport(report)); console.log(`  (${note})`); }
  return flags.gate && !report.ok ? 1 : 0;
}
