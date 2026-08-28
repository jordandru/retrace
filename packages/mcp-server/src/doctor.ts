#!/usr/bin/env node
/** retrace doctor — read-only preflight for the Git → Worker developer workflow. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Actor, Credential, schemaSurface } from "@retrace/core";
import { Cfg, commitToEvent, resolveHookToken } from "./git-hook.js";

type Level = "pass" | "warn" | "fail";
export type Finding = { level: Level; label: string; detail: string };
type RepoConfig = Cfg & { credential?: string };

const git = (repo: string, args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const result = (level: Level, label: string, detail: string): Finding => ({ level, label, detail });

export function missingSchema(remote: Record<string, unknown>, local = schemaSurface()): string[] {
  return Object.entries(local).flatMap(([group, keys]) => {
    const seen = Array.isArray(remote[group]) ? remote[group] as unknown[] : [];
    return keys.filter((key) => !seen.includes(key)).map((key) => `${group}.${key}`);
  });
}

export function credentialAuthorization(credential: Credential, actor: Actor): Finding {
  if (credential.trust === "assert") {
    const allowed = credential.allowed_actors ?? [];
    return allowed.some((a) => a.type === actor.type && a.id === actor.id)
      ? result("pass", "actor authorization", `${actor.type}/${actor.id} is allowed by ${credential.actor.id}`)
      : result("fail", "actor authorization", `${actor.type}/${actor.id} is not in ${credential.actor.id}.allowed_actors; update RETRACE_CREDENTIALS before committing`);
  }
  return credential.actor.type === actor.type && credential.actor.id === actor.id
    ? result("pass", "actor authorization", `${actor.type}/${actor.id} matches the pinned credential`)
    : result("fail", "actor authorization", `HEAD is ${actor.type}/${actor.id}, but credential ${credential.actor.id} is pinned to ${credential.actor.type}/${credential.actor.id}`);
}

function loadCredential(cfg: RepoConfig, env: NodeJS.ProcessEnv): { credential?: Credential; token?: string; finding: Finding } {
  if (!cfg.credential) {
    const token = env.RETRACE_HOOK_TOKEN ?? env.RETRACE_TOKEN ?? cfg.token;
    return { token, finding: token ? result("warn", "credential", "using an owner/file token; prefer a named scoped credential") : result("fail", "credential", "no hook token is configured") };
  }
  const file = env.RETRACE_CREDENTIALS_FILE ?? join(homedir(), ".retrace", "worker-credentials.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
    const raw = parsed.find((c: any) => c?.actor?.id === cfg.credential);
    if (!raw) throw new Error(`credential ${cfg.credential} was not found`);
    const credential = Credential.parse(raw);
    return { credential, token: resolveHookToken(cfg, env, file), finding: result("pass", "credential", `${cfg.credential} resolved from ${file}`) };
  } catch (e: any) {
    return { finding: result("fail", "credential", `${e?.message ?? e}; check RETRACE_CREDENTIALS_FILE`) };
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] && args[0] !== "doctor" && !args[0].startsWith(".") && !args[0].startsWith("/") && !existsSync(resolve(args[0]))) {
    console.error("usage: retrace doctor [repo]"); process.exit(2); return;
  }
  const arg = args[0] === "doctor" ? args[1] : args[0];
  let repo: string;
  try { repo = resolve(git(resolve(arg ?? process.cwd()), ["rev-parse", "--show-toplevel"])); }
  catch { console.error("FAIL  repository — not inside a Git repository (or pass its path)"); process.exit(1); return; }
  const findings: Finding[] = [];
  const cfgPath = join(repo, ".retrace.json");
  let cfg: RepoConfig = {};
  if (!existsSync(cfgPath)) findings.push(result("fail", "repository wiring", `${cfgPath} is missing; run retrace-git install --repo ${repo}`));
  else try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); findings.push(result("pass", "repository wiring", cfgPath)); }
  catch (e: any) { findings.push(result("fail", "repository wiring", `${cfgPath} is invalid JSON: ${e.message}`)); }

  const gitDir = resolve(repo, git(repo, ["rev-parse", "--git-dir"]));
  const hook = join(gitDir, "hooks", "post-commit");
  const hookOk = existsSync(hook) && readFileSync(hook, "utf8").includes("# retrace-git hook");
  findings.push(hookOk ? result("pass", "post-commit hook", hook) : result("fail", "post-commit hook", `not installed at ${hook}; run retrace-git install --repo ${repo}`));

  const project = process.env.RETRACE_PROJECT ?? cfg.project ?? basename(repo);
  const url = (process.env.RETRACE_URL ?? cfg.url ?? "").replace(/\/$/, "");
  const auth = loadCredential(cfg, process.env); findings.push(auth.finding);
  let headEvent: ReturnType<typeof commitToEvent> | undefined;
  try {
    headEvent = commitToEvent(repo, "HEAD", { ...cfg, project, repoName: cfg.repoName });
    if (auth.credential) findings.push(credentialAuthorization(auth.credential, headEvent.actor));
  } catch (e: any) { findings.push(result("fail", "HEAD", `could not inspect the current commit: ${e.message}`)); }

  if (!url) findings.push(result("warn", "deployment", "no RETRACE_URL or .retrace.json url; remote checks skipped"));
  else {
    const headers = auth.token ? { authorization: `Bearer ${auth.token}` } : undefined;
    try {
      const res = await fetch(`${url}/api`); if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const api: any = await res.json(); const missing = missingSchema(api.schema ?? {});
      findings.push(missing.length ? result("fail", "deployment schema", `would drop: ${missing.join(", ")}; deploy this build first`) : result("pass", "deployment schema", `${url} understands this build`));
    } catch (e: any) { findings.push(result("fail", "deployment", `${url}/api is unreachable: ${e.message}`)); }
    try {
      const res = await fetch(`${url}/projects/${encodeURIComponent(project)}/verify`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const v: any = await res.json();
      findings.push(v.ok ? result("pass", "ledger integrity", `${project}: ${v.checked} events verified`) : result("fail", "ledger integrity", `${project}: ${v.reason ?? "verification failed"}`));
    } catch (e: any) { findings.push(result("fail", "ledger access", `${e.message}; check URL and credential`)); }
    if (headEvent) {
      const commit = headEvent.artifacts.find((a) => a.kind === "commit")?.id;
      try {
        const res = await fetch(`${url}/projects/${encodeURIComponent(project)}/events?artifact_id=${encodeURIComponent(commit ?? "")}`, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        const events: any[] = await res.json();
        findings.push(events.length ? result("pass", "HEAD delivery", `${commit} is event #${events.at(-1)?.seq}`) : result("warn", "HEAD delivery", `${commit} is not in the ledger; run retrace-git commit --repo ${repo} HEAD`));
      } catch (e: any) { findings.push(result("fail", "HEAD delivery", e.message)); }
    }
  }

  for (const f of findings) console.log(`${f.level.toUpperCase()}  ${f.label} — ${f.detail}`);
  const failed = findings.filter((f) => f.level === "fail").length, warned = findings.filter((f) => f.level === "warn").length;
  console.log(`\n${failed ? "NOT READY" : "READY"} — ${findings.length - failed - warned} passed, ${warned} warnings, ${failed} failures`);
  process.exit(failed ? 1 : 0);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) main().catch((e) => { console.error("retrace doctor:", e.message ?? e); process.exit(1); });
