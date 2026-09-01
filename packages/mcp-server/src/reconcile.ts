/**
 * retrace-export reconcile — git history vs the ledger (roadmap rung 4; core logic in @retrace-dev/core reconcile.ts).
 *   retrace-export reconcile [--repo .] [--since <ref>] [--limit N] [--uncovered warn|fail|info] [--pubkey jwk|https-url] [--json] [--gate]
 * Commit facts come from git (`rev-list` + `show --name-status -M`); events from one full export of the project.
 * --gate exits 1 when any unacknowledged fail-level finding exists (missing commit, mis-attributed commit, or an
 * uncovered file when the repo's .retrace.json sets "reconcile": {"uncovered": "fail"}).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CommitFacts, CommitFile, CommitFileStatus, Event, ExportBundle, ReconcileLevel, ReconcileReport, exportVerdictOk, reconcile, renderReconcileReport, verifyExportBundle } from "@retrace-dev/core";
import { resolveTrustedKey } from "./trusted-key.js";
import { Cfg, remoteName } from "./git-hook.js";
import { makeStore } from "./index.js";
import { RemoteStore } from "./remote-store.js";

export type ReconcileCfg = Cfg & { reconcile?: { uncovered?: ReconcileLevel; ack_actors?: string[] } };

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
  const files = parseNameStatus(git(repo, ["show", "--name-status", "-M", "--format=", sha]));
  return { sha, parents: parents ? parents.split(" ") : [], files, author: { name, email }, time: new Date(time).toISOString() };
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

export async function reconcileRepo(repo: string, opts: { since?: string; limit?: number; uncovered?: ReconcileLevel; refs?: string[]; pubkey?: unknown }): Promise<{ report: ReconcileReport; note: string }> {
  const cfg = readRepoConfig(repo);
  const project = process.env.RETRACE_PROJECT ?? cfg.project ?? basename(repo);
  const shas = opts.refs ?? listCommits(repo, { since: opts.since, limit: opts.since ? opts.limit : opts.limit ?? 50 });
  const commits = shas.map((s) => commitFacts(repo, s));
  const { events, note } = await fetchEvents(project, opts.pubkey);
  const report = reconcile(commits, events, { ...repoNamesFor(repo, cfg), repoPath: repo, uncovered: opts.uncovered ?? cfg.reconcile?.uncovered, ackActors: cfg.reconcile?.ack_actors });
  return { report, note };
}

export async function reconcileMain(flags: Record<string, string | boolean>, _pos: string[]): Promise<number> {
  const repo = resolve(git(resolve(String(flags.repo ?? process.cwd())), ["rev-parse", "--show-toplevel"]));
  const uncovered = flags.uncovered ? (String(flags.uncovered) as ReconcileLevel) : undefined;
  if (uncovered && !["warn", "fail", "info"].includes(uncovered)) throw new Error("--uncovered must be warn, fail or info");
  const { report, note } = await reconcileRepo(repo, { since: flags.since ? String(flags.since) : undefined, limit: flags.limit ? Number(flags.limit) : undefined, uncovered, pubkey: flags.pubkey });
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else { console.log(renderReconcileReport(report)); console.log(`  (${note})`); }
  return flags.gate && !report.ok ? 1 : 0;
}
