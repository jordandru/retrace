#!/usr/bin/env node
/**
 * retrace-git — Git adapter. Turns commits into Retrace events.
 *
 *   retrace-git install [--project <name>] [--repo <path>]   write .git/hooks/post-commit + .retrace.json
 *   retrace-git commit [--repo <path>] [<sha>]                log one commit (default HEAD) — what the hook runs
 *   retrace-git backfill [--repo <path>] [--since <ref>] [--max <n>]   log history oldest→newest (idempotent by sha)
 *   retrace-git uninstall [--repo <path>]
 *
 * Config precedence: CLI flags > env (RETRACE_PROJECT/RETRACE_DB/RETRACE_URL/RETRACE_TOKEN) > .retrace.json in repo root.
 * Remote-write guard: writing to a REMOTE ledger requires a .retrace.json in the repo root — see guardRemoteWrite.
 * Token precedence (resolveHookToken): env RETRACE_HOOK_TOKEN > the credential named by .retrace.json "credential"
 *   (looked up by actor.id in RETRACE_CREDENTIALS_FILE, default ~/.retrace/worker-credentials.json — a scoped assert
 *   credential, so the hook need not carry the owner token) > env RETRACE_TOKEN > .retrace.json "token". No "credential"
 *   field = the owner-token behaviour, unchanged. A named-but-missing credential is an error, never a silent fallback.
 * Failures of `commit` (the hook path) are appended to <git-dir>/retrace-hook.log: the post-commit script discards
 *   stdout/stderr, and with a fail-closed assert credential a 401/403 would otherwise be an invisible drop (owner-token
 *   migration 2026-08-23). Re-log a dropped commit with `retrace-git commit <sha>` or `backfill`.
 *
 * Mapping a commit → event
 *   WHO    author (human) — or an AGENT if the commit has a trailer `Retrace-Actor: <id>` (optionally
 *          `Retrace-Model: <model>`), or a `Co-Authored-By:` naming Claude/Copilot/Codex/Grok/… or a "[bot]" author;
 *          in that case the human author becomes `on_behalf_of`. Trailers are read from ALL trailing trailer-only
 *          paragraphs (not just git's last one — backlog #12, dogfood log 2026-08-20: a `Retrace-*` paragraph
 *          followed by a separate `Co-Authored-By` paragraph lost the Retrace-* lines); a Co-Authored-By agent gets
 *          id = family ("claude", "copilot", …) and model = slug of the full name ("Claude Fable 5" → "claude-fable-5").
 *   WHAT   action=committed (or merged for merge commits); artifacts = commit:<sha> + repo:<name>#<path> per file, all role=generated
 *   WHEN   author date
 *   WHERE  system=git, path=repo root, environment=local (override RETRACE_ENV), device=hostname (override
 *          RETRACE_DEVICE), session=CLAUDE_CODE_SESSION_ID or GROK_SESSION_ID when an agent's shell drove the commit (absent for a
 *          human's own `git commit` — see below), ide/workspace when an IDE names itself (Orca), surface=tty|agent
 *   WHY    intent = commit subject (+ body); caused_by = trailer `Retrace-Caused-By: evt_…`, else env RETRACE_CAUSED_BY,
 *          else contents of .git/retrace-caused-by (a scratch file agents/MCP can write)
 *   HOW    tool=git, params { branch, parents, files, insertions, deletions }, automated = agent commit
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync, chmodSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { EventInput, appendEvent, describeEvent, Event } from "@retrace-dev/core";
import { makeStore, detectIde, harnessSession } from "./index.js";
import { RemoteStore } from "./remote-store.js";
import { isMainModule } from "./is-main.js";

export type Cfg = { project?: string; db?: string; url?: string; token?: string; credential?: string; environment?: string; repoName?: string;
  /** Resolved from --allow-remote / RETRACE_ALLOW_REMOTE, not from .retrace.json — a repo that HAS the file is already
   *  permitted, so setting it there would be a no-op. See guardRemoteWrite. */
  allowRemote?: boolean };

/** The operator's local mirror of the Worker's RETRACE_CREDENTIALS (JSON array of {token, actor, …}); only token + actor.id are read. */
const DEFAULT_CREDENTIALS_FILE = join(homedir(), ".retrace", "worker-credentials.json");

/**
 * Which bearer token the hook sends. `file` is the repo's .retrace.json. Precedence: RETRACE_HOOK_TOKEN (explicit
 * override) > the credential entry named by `credential` (matched on actor.id in the credentials file) > RETRACE_TOKEN >
 * .retrace.json `token`. Without a `credential` field this is exactly the old behaviour, so repos that still run on the
 * owner token (boxing-rpg) are untouched. Naming a credential that cannot be found throws rather than quietly falling
 * back to the owner token — the point of the field is that the owner token stops being what this repo uses.
 */
export function resolveHookToken(
  file: Pick<Cfg, "token" | "credential">,
  env: NodeJS.ProcessEnv = process.env,
  credentialsFile: string = env.RETRACE_CREDENTIALS_FILE ?? DEFAULT_CREDENTIALS_FILE,
): string | undefined {
  if (env.RETRACE_HOOK_TOKEN) return env.RETRACE_HOOK_TOKEN;
  if (file.credential) {
    if (!existsSync(credentialsFile))
      throw new Error(`.retrace.json names credential "${file.credential}" but ${credentialsFile} does not exist (set RETRACE_CREDENTIALS_FILE, or remove "credential" to fall back to RETRACE_TOKEN)`);
    const entries: unknown = JSON.parse(readFileSync(credentialsFile, "utf8"));
    const hit = Array.isArray(entries) ? entries.find((c) => c?.actor?.id === file.credential) : undefined;
    if (typeof hit?.token !== "string" || !hit.token) throw new Error(`credential "${file.credential}" not found in ${credentialsFile} (matched on actor.id)`);
    return hit.token;
  }
  return env.RETRACE_TOKEN ?? file.token;
}

/** One line per failed hook run, appended to <git-dir>/retrace-hook.log. Never throws (the hook is non-fatal by design); the
 *  messages that reach it (HTTP status + body, config errors) carry no token. */
export function appendHookLog(gitDir: string, line: string): void {
  try { appendFileSync(join(gitDir, "retrace-hook.log"), `${new Date().toISOString()} ${line}\n`); } catch {}
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt && !nxt.startsWith("--")) { flags[k] = nxt; i++; } else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

function loadCfg(repo: string, flags: Record<string, string | boolean>): Cfg {
  let file: Cfg = {};
  const p = join(repo, ".retrace.json");
  if (existsSync(p)) file = JSON.parse(readFileSync(p, "utf8"));
  const cfg: Cfg = {
    project: (flags.project as string) ?? process.env.RETRACE_PROJECT ?? file.project ?? basename(repo),
    db: process.env.RETRACE_DB ?? file.db,
    url: process.env.RETRACE_URL ?? file.url,
    credential: file.credential,
    token: resolveHookToken(file),
    environment: process.env.RETRACE_ENV ?? file.environment ?? "local",
    repoName: file.repoName,
    allowRemote: flags["allow-remote"] !== undefined || process.env.RETRACE_ALLOW_REMOTE === "1",
  };
  // The local store is built by makeStore (reads env) — propagate the file's db path when unset. The remote store is built
  // from cfg directly (logCommit) so the resolved token, not whatever RETRACE_TOKEN the shell exports, is what is sent.
  if (cfg.db && !process.env.RETRACE_DB) process.env.RETRACE_DB = cfg.db;
  return cfg;
}

const AGENT_COAUTHOR = /claude|copilot|codex|cursor|devin|aider|gpt|gemini|grok|\[bot\]/i;
/** Agent families a Co-Authored-By name is mapped onto (first match wins) — the actor id (backlog #12). */
const AGENT_FAMILIES = ["claude", "copilot", "codex", "cursor", "devin", "aider", "gemini", "grok", "gpt"];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
/** Retrace-Caused-By must be a real event id; junk trailers are dropped rather than sealed (audit 2026-08-30). */
export const CAUSED_BY_RE = /^evt_[0-9a-f]{32}$/i;
/** Retrace-Actor trailer: agent slug only (not an email, URL, or free text). */
export const ACTOR_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/i;
export function validCausedById(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t && CAUSED_BY_RE.test(t) ? t : undefined;
}
export function validActorId(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t && ACTOR_ID_RE.test(t) ? t : undefined;
}

/** A trailer line, per git: token, colon, whitespace, non-blank value. */
const TRAILER_LINE = /^[A-Za-z][\w-]*:\s+\S/;

/**
 * Trailers from EVERY trailing trailer-only paragraph of a commit message, walking back from the last paragraph
 * and stopping at the first paragraph with prose (the subject never counts). Git's own `%(trailers)` reads only
 * the LAST paragraph, so 68c343f's `Retrace-*` block + separate `Co-Authored-By` block lost the Retrace-* lines and
 * the hook minted actor "claude-fable-5" (backlog #12, dogfood log 2026-08-20). A `Key: value` line inside prose is
 * NOT a trailer. Keys are lowercased; continuation lines (leading whitespace) are unfolded into the previous value.
 * `trailerText` = the collected paragraphs' lines (CRLF → LF), so the caller can strip exactly those from the body.
 * Line endings are normalised first and the value capture avoids `.`/`$` (both stop at \r and U+2028): a CRLF
 * message (kept verbatim by `--cleanup=verbatim`, `git commit-tree`, API-made commits) otherwise had its lines
 * classified as trailers yet none extracted — the Retrace-* block vanished from the ledger (review of the #12 fix).
 */
export function parseTrailers(message: string): { trailers: Record<string, string[]>; trailerText: string[] } {
  const paras = message.replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/).map((p) => p.split("\n"));
  const isTrailerPara = (p: string[]) => TRAILER_LINE.test(p[0]) && p.every((l) => TRAILER_LINE.test(l) || /^\s/.test(l));
  let k = paras.length;
  while (k > 1 && isTrailerPara(paras[k - 1])) k--;
  const trailerText = paras.slice(k).flat();
  const trailers: Record<string, string[]> = {};
  let last: string[] | undefined;
  for (const line of trailerText) {
    const m = line.match(/^([A-Za-z][\w-]*):\s+([\s\S]*)$/);
    if (m) (last = trailers[m[1].toLowerCase()] ??= []).push(m[2].trim());
    else if (last) last[last.length - 1] += " " + line.trim();
  }
  return { trailers, trailerText };
}

/** Body minus its last `n` non-blank lines (the trailer paragraphs, which are always a suffix of the body). CRLF → LF
 *  as in parseTrailers, so `intent` never carries a stray \r next to git's already CR-free `%s` subject. */
function stripTrailers(body: string, n: number): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let i = lines.length;
  while (n > 0 && i > 0) if (lines[--i].trim()) n--;
  return lines.slice(0, i).join("\n").trim().replace(/\n{3,}/g, "\n\n");
}

/** Co-Authored-By agent → { id: family, model: slug of the full name when it says more than the family, display_name:
 *  name as written }. Keeps "Claude Fable 5" from minting actor id "claude-fable-5" (backlog #12). */
function coauthorActor(coauthor: string, ae: string): EventInput["actor"] {
  const name = coauthor.replace(/<.*>/, "").trim();
  const family = AGENT_FAMILIES.find((f) => name.toLowerCase().includes(f));
  const full = slug(name);
  return { type: "agent", id: family ?? full, model: family && full !== family ? full : undefined, on_behalf_of: ae, display_name: name };
}

export function commitToEvent(repo: string, sha: string, cfg: Cfg, live = false): EventInput {
  const fmt = ["%H", "%P", "%an", "%ae", "%aI", "%s", "%b", "%B"].join("%x1f");
  const raw = git(repo, ["show", "-s", `--format=${fmt}`, sha]);
  const [fullSha, parents, an, ae, aI, subject, body, message] = raw.split("\x1f");
  const parentList = parents ? parents.split(" ") : [];
  const { trailers, trailerText } = parseTrailers(message);
  const numstat = git(repo, ["show", "--numstat", "--format=", sha]).split("\n").filter(Boolean);
  let ins = 0, del = 0;
  const files = numstat.map((l) => {
    const [a, d, path] = l.split("\t");
    if (a !== "-") ins += Number(a);
    if (d !== "-") del += Number(d);
    return path;
  });
  let branch = "";
  try { branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]); } catch {}
  const repoName = cfg.repoName ?? remoteName(repo) ?? basename(repo);

  const coauthors = trailers["co-authored-by"] ?? [];
  const agentId = validActorId(trailers["retrace-actor"]?.[0]);
  const agentCo = coauthors.find((c) => AGENT_COAUTHOR.test(c));
  const isBot = /\[bot\]/i.test(an);
  let actor: EventInput["actor"];
  if (agentId) actor = { type: "agent", id: agentId, model: trailers["retrace-model"]?.[0], on_behalf_of: ae };
  else if (agentCo) actor = coauthorActor(agentCo, ae);
  else if (isBot) actor = { type: "system", id: ae || an, display_name: an };
  else actor = { type: "human", id: ae || an, display_name: an };

  let causedBy: string | undefined = validCausedById(trailers["retrace-caused-by"]?.[0] ?? process.env.RETRACE_CAUSED_BY);
  if (!causedBy) {
    const f = join(git(repo, ["rev-parse", "--git-dir"]), "retrace-caused-by");
    const fp = resolve(repo, f);
    if (existsSync(fp)) causedBy = validCausedById(readFileSync(fp, "utf8"));
  }
  const isMerge = parentList.length > 1;
  const cleanBody = stripTrailers(body, trailerText.length); // prose "Key: value" lines survive (backlog #12)

  return {
    project: cfg.project ?? basename(repo),
    actor,
    action: isMerge ? "merged" : "committed",
    // PROV role: a commit generates the commit object and the new state of every changed file (a deletion included —
    // the commit's diff generates that state; invalidation is not a role). Parents are inputs via derived_from, not refs.
    artifacts: [
      { id: `commit:${repoName}@${fullSha.slice(0, 12)}`, kind: "commit", label: `${repoName}@${fullSha.slice(0, 7)}`, derived_from: parentList.length ? parentList.map((p) => `commit:${repoName}@${p.slice(0, 12)}`) : undefined, role: "generated" as const },
      ...files.map((f) => ({ id: `repo:${repoName}#${f}`, kind: "file", label: f, role: "generated" as const })),
    ],
    change: { before_hash: parentList[0], after_hash: fullSha, summary: `${files.length} file${files.length === 1 ? "" : "s"}, +${ins} −${del}` },
    timestamp: new Date(aI).toISOString(),
    location: {
      system: "git", path: repo, environment: cfg.environment, device: process.env.RETRACE_DEVICE ?? hostname(),
      // `live` = the post-commit hook, the ONLY caller whose own process context is the commit's context. backfill and
      // `commit <sha>` replay commits this process did not produce, so stamping them would seal fabricated evidence.
      ...(live ? { session: harnessSession(process.env), ...detectIde(process.env), surface: ttySurface() } : {}),
    },
    intent: cleanBody ? `${subject}\n\n${cleanBody}` : subject,
    caused_by: causedBy,
    method: { tool: "git", automated: actor.type !== "human", params: { branch, parents: parentList, files: files.length, insertions: ins, deletions: del, sha: fullSha } },
    idempotency_key: `git:${fullSha}`,
    tags: ["git", ...(isMerge ? ["merge"] : [])],
  };
}

/** Did this hook run under a controlling terminal? "tty" = a human typed `git commit`; "agent" = a harness ran it.
 *  Read from /proc/self/stat field 7 (tty_nr), NOT from tty.isatty(): the installed post-commit script redirects its
 *  own stdout AND stderr to /dev/null (see hookScript), which destroys every file-descriptor signal while leaving the
 *  controlling terminal itself intact. Measured 2026-08-27: agent-spawned tty_nr=0, real pty tty_nr=34819.
 *  Linux-only by construction — with no /proc the field is simply absent, which is a legal permanent state
 *  ("absence is information", schema.ts). It is EVIDENCE only and never decides WHO: authorship does that. */
export function ttySurface(procStat = "/proc/self/stat"): "tty" | "agent" | undefined {
  try {
    const stat = readFileSync(procStat, "utf8");
    // Parse after the last ")": field 2 (comm) is parenthesised and may itself contain spaces and parens.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // [state, ppid, pgrp, session, tty_nr, ...]
    const ttyNr = Number(fields[4]);
    return Number.isFinite(ttyNr) && fields.length > 4 ? (ttyNr === 0 ? "agent" : "tty") : undefined;
  } catch { return undefined; }
}

function remoteName(repo: string): string | undefined {
  try {
    const url = git(repo, ["remote", "get-url", "origin"]);
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(\.git)?$/);
    return m?.[1];
  } catch { return undefined; }
}

/** A repo that was never wired to Retrace must not write to a REMOTE ledger just because the shell happens to export
 *  RETRACE_URL. `.retrace.json` is the committed marker that says "this repo logs to a ledger" — `install` writes it —
 *  so its absence, combined with an ambient RETRACE_URL, means a scratch repo has picked up someone else's production
 *  credentials. That is not hypothetical: on 2026-08-28 six events in four junk projects (bf, p, demo, reprotest)
 *  reached the live Worker exactly this way, from temp repos under /tmp, and had to be deleted project-by-project
 *  because the ledger is append-only. The repo's own test harness already strips RETRACE_* for this reason
 *  (git-hook.test.ts baseEnv, after the 2026-08-19 dogfood incident); this is the same defence for anyone driving the
 *  CLI by hand.
 *  Local writes are deliberately NOT gated — a stray row in a SQLite file is cheap to discard, a sealed event in a
 *  shared append-only ledger is not. The real hook never trips this: `install` writes .retrace.json before the hook
 *  can ever run. Escape hatch for env-only setups (CI backfilling a repo that does not carry the file):
 *  `--allow-remote`, or RETRACE_ALLOW_REMOTE=1. */
export function guardRemoteWrite(repo: string, cfg: Cfg): void {
  if (!cfg.url || cfg.allowRemote || existsSync(join(repo, ".retrace.json"))) return;
  throw new Error(
    `refusing to log to the remote ledger ${cfg.url} from ${repo}: this repo has no .retrace.json, so RETRACE_URL came ` +
    `from the environment rather than from the repo, and project "${cfg.project}" would be created there. ` +
    `If this repo really should log to that ledger, run \`retrace-git install --project <name>\` (writes .retrace.json). ` +
    `If it is a scratch or test repo, write locally with RETRACE_DB=<path>, or unset RETRACE_URL. ` +
    `To override for one run: --allow-remote (or RETRACE_ALLOW_REMOTE=1).`,
  );
}

async function logCommit(repo: string, sha: string, cfg: Cfg, live = false): Promise<{ event: Event; deduped: boolean }> {
  // The single choke point for every write path (hook, `commit <sha>`, backfill) — so a new caller cannot forget it.
  guardRemoteWrite(repo, cfg);
  const input = commitToEvent(repo, sha, cfg, live);
  const store = cfg.url ? new RemoteStore(cfg.url, cfg.token) : makeStore();
  return store instanceof RemoteStore ? store.append(input) : appendEvent(store, input);
}

const HOOK_MARK = "# retrace-git hook";
function hookScript(): string {
  const self = new URL(import.meta.url).pathname;
  return `#!/bin/sh\n${HOOK_MARK}\nnode "${self}" commit --hook --repo "$(git rev-parse --show-toplevel)" >/dev/null 2>&1 || echo "retrace: failed to log commit (non-fatal; reason appended to $(git rev-parse --git-dir)/retrace-hook.log)" >&2\n`;
}

async function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const cmd = pos[0] ?? "help";
  const repo = resolve((flags.repo as string) ?? git(process.cwd(), ["rev-parse", "--show-toplevel"]));
  const gitDir = resolve(repo, git(repo, ["rev-parse", "--git-dir"]));

  if (cmd === "commit") {
    // The hook path. Config errors (a credential that can't be resolved) and server rejections (401/403 from a
    // fail-closed assert credential, 5xx) both land in retrace-hook.log, because the hook script discards our output.
    const sha = pos[1] ?? "HEAD";
    try {
      const r = await logCommit(repo, sha, loadCfg(repo, flags), flags.hook === true);
      console.log(`${r.deduped ? "(already logged) " : "logged "}${r.event.id}\n${describeEvent(r.event)}`);
    } catch (e: any) {
      let id = sha;
      try { id = git(repo, ["rev-parse", "--short=12", sha]); } catch {}
      appendHookLog(gitDir, `commit ${id} in ${repo} NOT logged: ${e?.message ?? e}`);
      throw e;
    }
    return;
  }
  const cfg = loadCfg(repo, flags);

  if (cmd === "install") {
    mkdirSync(join(gitDir, "hooks"), { recursive: true });
    const hookPath = join(gitDir, "hooks", "post-commit");
    if (existsSync(hookPath) && !readFileSync(hookPath, "utf8").includes(HOOK_MARK)) {
      console.error(`A post-commit hook already exists at ${hookPath}. Append this line to it manually:\n  ${hookScript().split("\n")[2]}`);
      process.exit(1);
    }
    writeFileSync(hookPath, hookScript());
    chmodSync(hookPath, 0o755);
    const cfgPath = join(repo, ".retrace.json");
    if (!existsSync(cfgPath)) writeFileSync(cfgPath, JSON.stringify({ project: cfg.project, environment: cfg.environment }, null, 2) + "\n");
    console.log(`installed post-commit hook → ${hookPath}\nproject: ${cfg.project}\nconfig: ${cfgPath} (commit it; add db/url/token there or via env)`);
    return;
  }
  if (cmd === "uninstall") {
    const hookPath = join(gitDir, "hooks", "post-commit");
    if (existsSync(hookPath) && readFileSync(hookPath, "utf8").includes(HOOK_MARK)) { unlinkSync(hookPath); console.log("removed hook"); }
    return;
  }
  if (cmd === "backfill") {
    const range = flags.since ? `${flags.since}..HEAD` : "HEAD";
    const max = flags.max ? ["-n", String(flags.max)] : [];
    const shas = git(repo, ["rev-list", "--reverse", ...max, range]).split("\n").filter(Boolean);
    let n = 0, d = 0;
    for (const sha of shas) {
      const r = await logCommit(repo, sha, cfg);
      r.deduped ? d++ : n++;
    }
    console.log(`backfill: ${n} logged, ${d} already present, project '${cfg.project}'`);
    return;
  }
  console.log(`retrace-git <install|uninstall|commit [sha]|backfill [--since ref] [--max n]> [--repo path] [--project name] [--allow-remote]`);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error("retrace-git:", e.message ?? e); process.exit(1); });
