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
 *
 * Mapping a commit → event
 *   WHO    author (human) — or an AGENT if the commit has a trailer `Retrace-Actor: <id>` (optionally
 *          `Retrace-Model: <model>`), or a `Co-Authored-By:` naming Claude/Copilot/Codex/… or a "[bot]" author;
 *          in that case the human author becomes `on_behalf_of`.
 *   WHAT   action=committed (or merged for merge commits); artifacts = commit:<sha> + repo:<name>#<path> per file
 *   WHEN   author date
 *   WHERE  system=git, path=repo root, environment=local (override RETRACE_ENV), device=hostname
 *   WHY    intent = commit subject (+ body); caused_by = trailer `Retrace-Caused-By: evt_…`, else env RETRACE_CAUSED_BY,
 *          else contents of .git/retrace-caused-by (a scratch file agents/MCP can write)
 *   HOW    tool=git, params { branch, parents, files, insertions, deletions }, automated = agent commit
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { EventInput, appendEvent, describeEvent, Event } from "@retrace/core";
import { makeStore } from "./index.js";
import { RemoteStore } from "./remote-store.js";

type Cfg = { project?: string; db?: string; url?: string; token?: string; environment?: string; repoName?: string };

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
    token: process.env.RETRACE_TOKEN ?? file.token,
    environment: process.env.RETRACE_ENV ?? file.environment ?? "local",
    repoName: file.repoName,
  };
  // makeStore reads env — propagate file config into env when unset
  if (cfg.db && !process.env.RETRACE_DB) process.env.RETRACE_DB = cfg.db;
  if (cfg.url && !process.env.RETRACE_URL) process.env.RETRACE_URL = cfg.url;
  if (cfg.token && !process.env.RETRACE_TOKEN) process.env.RETRACE_TOKEN = cfg.token;
  return cfg;
}

const AGENT_COAUTHOR = /claude|copilot|codex|cursor|devin|aider|gpt|gemini|\[bot\]/i;

export function commitToEvent(repo: string, sha: string, cfg: Cfg): EventInput {
  const fmt = ["%H", "%P", "%an", "%ae", "%aI", "%s", "%b"].join("%x1f");
  const raw = git(repo, ["show", "-s", `--format=${fmt}`, sha]);
  const [fullSha, parents, an, ae, aI, subject, body] = raw.split("\x1f");
  const parentList = parents ? parents.split(" ") : [];
  const trailersRaw = git(repo, ["show", "-s", "--format=%(trailers:only,unfold)", sha]);
  const trailers: Record<string, string[]> = {};
  for (const line of trailersRaw.split("\n")) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) (trailers[m[1].toLowerCase()] ??= []).push(m[2].trim());
  }
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
  const agentId = trailers["retrace-actor"]?.[0];
  const agentCo = coauthors.find((c) => AGENT_COAUTHOR.test(c));
  const isBot = /\[bot\]/i.test(an);
  let actor: EventInput["actor"];
  if (agentId) actor = { type: "agent", id: agentId, model: trailers["retrace-model"]?.[0], on_behalf_of: ae };
  else if (agentCo) actor = { type: "agent", id: agentCo.replace(/<.*>/, "").trim().toLowerCase().replace(/\s+/g, "-"), on_behalf_of: ae, display_name: agentCo.replace(/<.*>/, "").trim() };
  else if (isBot) actor = { type: "system", id: ae || an, display_name: an };
  else actor = { type: "human", id: ae || an, display_name: an };

  let causedBy: string | undefined = trailers["retrace-caused-by"]?.[0] ?? process.env.RETRACE_CAUSED_BY;
  if (!causedBy) {
    const f = join(git(repo, ["rev-parse", "--git-dir"]), "retrace-caused-by");
    const fp = resolve(repo, f);
    if (existsSync(fp)) causedBy = readFileSync(fp, "utf8").trim() || undefined;
  }
  const isMerge = parentList.length > 1;
  const cleanBody = body.replace(/^([\w-]+):\s.*$/gm, "").trim(); // strip trailers from body

  return {
    project: cfg.project ?? basename(repo),
    actor,
    action: isMerge ? "merged" : "committed",
    artifacts: [
      { id: `commit:${repoName}@${fullSha.slice(0, 12)}`, kind: "commit", label: `${repoName}@${fullSha.slice(0, 7)}` },
      ...files.map((f) => ({ id: `repo:${repoName}#${f}`, kind: "file", label: f })),
    ],
    change: { before_hash: parentList[0], after_hash: fullSha, summary: `${files.length} file${files.length === 1 ? "" : "s"}, +${ins} −${del}` },
    timestamp: new Date(aI).toISOString(),
    location: { system: "git", path: repo, environment: cfg.environment, device: hostname() },
    intent: cleanBody ? `${subject}\n\n${cleanBody}` : subject,
    caused_by: causedBy,
    method: { tool: "git", automated: actor.type !== "human", params: { branch, parents: parentList, files: files.length, insertions: ins, deletions: del, sha: fullSha } },
    idempotency_key: `git:${fullSha}`,
    tags: ["git", ...(isMerge ? ["merge"] : [])],
  };
}

function remoteName(repo: string): string | undefined {
  try {
    const url = git(repo, ["remote", "get-url", "origin"]);
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(\.git)?$/);
    return m?.[1];
  } catch { return undefined; }
}

async function logCommit(repo: string, sha: string, cfg: Cfg): Promise<{ event: Event; deduped: boolean }> {
  const input = commitToEvent(repo, sha, cfg);
  const store = makeStore();
  return store instanceof RemoteStore ? store.append(input) : appendEvent(store, input);
}

const HOOK_MARK = "# retrace-git hook";
function hookScript(): string {
  const self = new URL(import.meta.url).pathname;
  return `#!/bin/sh\n${HOOK_MARK}\nnode "${self}" commit --repo "$(git rev-parse --show-toplevel)" >/dev/null 2>&1 || echo "retrace: failed to log commit (non-fatal)" >&2\n`;
}

async function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const cmd = pos[0] ?? "help";
  const repo = resolve((flags.repo as string) ?? git(process.cwd(), ["rev-parse", "--show-toplevel"]));
  const cfg = loadCfg(repo, flags);
  const gitDir = resolve(repo, git(repo, ["rev-parse", "--git-dir"]));

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
  if (cmd === "commit") {
    const sha = pos[1] ?? "HEAD";
    const r = await logCommit(repo, sha, cfg);
    console.log(`${r.deduped ? "(already logged) " : "logged "}${r.event.id}\n${describeEvent(r.event)}`);
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
  console.log(`retrace-git <install|uninstall|commit [sha]|backfill [--since ref] [--max n]> [--repo path] [--project name]`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) main().catch((e) => { console.error("retrace-git:", e.message ?? e); process.exit(1); });
