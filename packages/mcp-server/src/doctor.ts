#!/usr/bin/env node
/** retrace doctor — read-only preflight for the Git → Worker developer workflow. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Actor, Credential, Event, ProjectStatus, causalRootState, renderProjectStatus, schemaSurface } from "@retrace-dev/core";
import { Cfg, commitToEvent, resolveHookToken } from "./git-hook.js";
import { retraceHeaders } from "./remote-store.js";
import { isMainModule } from "./is-main.js";

type Level = "pass" | "warn" | "fail";
export type Finding = { level: Level; label: string; detail: string };
export type DoctorArgs = { command: "doctor" | "status"; gate: boolean; json: boolean; repo?: string; statusProject?: string };
type RepoConfig = Cfg & { credential?: string };

const git = (repo: string, args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const result = (level: Level, label: string, detail: string): Finding => ({ level, label, detail });

export function parseDoctorArgs(argv: string[]): DoctorArgs {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const pos = argv.filter((a) => !a.startsWith("--"));
  const gate = flags.has("--gate");
  const json = flags.has("--json");
  if (pos[0] === "status") return { command: "status", gate: false, json, statusProject: pos[1] };
  const rest = pos[0] === "doctor" ? pos.slice(1) : pos;
  return { command: "doctor", gate, json, repo: rest[0] };
}

/** Missing HEAD is a warning for local preflight and a failure for CI (`--gate`). */
export function headDelivery(gate: boolean, commitId: string | undefined, found: boolean): Finding {
  if (!commitId) return result("fail", "HEAD delivery", "HEAD has no commit artifact");
  if (found) return result("pass", "HEAD delivery", commitId);
  const hint = `${commitId} is not in the ledger; run retrace-git commit HEAD`;
  return result(gate ? "fail" : "warn", "HEAD delivery", hint);
}

/** Agent commits must walk caused_by to a human instructed event. Human commits are not gated. */
export function instructRootFinding(actorType: string, why: Event[]): Finding {
  if (actorType !== "agent") return result("pass", "instruct root", "not required for a human commit");
  if (!why.length) return result("fail", "instruct root", "agent commit has no why-chain");
  const byId = new Map(why.map((e) => [e.id, e]));
  const head = why[0];
  const state = causalRootState(head, byId);
  if (state === "rooted") {
    const root = why.find((e) => e.actor.type === "human" && e.action === "instructed");
    return result("pass", "instruct root", `${head.id} ← ${root?.id ?? "human instruction"}`);
  }
  if (state === "broken") return result("fail", "instruct root", `${head.id} has a broken caused_by chain`);
  return result("fail", "instruct root", `${head.id} is not rooted in a human instruction; add Retrace-Caused-By: evt_…`);
}

/**
 * Trailer-omit: an agent shell with no Retrace-Actor is stored as human, so instruct-root is skipped.
 * Evidence is the sealed ledger event only: actor.type=agent, or location.surface=agent from the live hook.
 * Never doctor's process env / session. Later events that mention the same commit artifact must not win.
 */
export function sealedCommitEvent(events: Event[]): Event | undefined {
  return events.filter((e) => e.action === "committed" || e.action === "merged").sort((a, b) => a.seq - b.seq)[0];
}

export function sealedLooksAgent(event: { actor: { type: string }; location?: { surface?: string } }): boolean {
  return event.actor.type === "agent" || event.location?.surface === "agent";
}

export function agentEvidenceOnHuman(event: { actor: { type: string; id?: string }; location?: { surface?: string } }): string[] {
  if (event.actor.type !== "human") return [];
  return event.location?.surface === "agent" ? ["location.surface=agent"] : [];
}

export function attributionFinding(
  gate: boolean,
  event: { actor: { type: string; id?: string }; location?: { surface?: string } },
): Finding {
  const clues = agentEvidenceOnHuman(event);
  if (!clues.length) return result("pass", "attribution", `${event.actor.type}${event.actor.id ? "/" + event.actor.id : ""} has no agent-evidence mismatch`);
  const who = event.actor.id ? `human/${event.actor.id}` : "human";
  const detail = `${who} but carries ${clues.join(" · ")}; trailer-omit looks human and bypasses the instruct-root gate — add Retrace-Actor and Retrace-Caused-By`;
  return result(gate ? "fail" : "warn", "attribution", detail);
}

/** Agent (or surface=agent) events on the why-chain that are not the commit and not the instruct root. */
export function mcpPeers(commit: Event, why: Event[]): Event[] {
  return why.filter((e) => e.id !== commit.id && e.action !== "instructed" && (e.actor.type === "agent" || e.location?.surface === "agent"));
}

/**
 * Pin: commit actor.id must be among sealed MCP peers. Session: if the live hook stamped
 * location.session, it must appear on those peers. Replay (no commit session) is not a miss.
 * Never reads process env.
 */
export function pinSessionFinding(gate: boolean, commit: Event, why: Event[]): Finding {
  const peers = mcpPeers(commit, why);
  if (!peers.length) return result("pass", "pin/session", "no MCP peers in the why-chain to compare");
  const problems: string[] = [];
  if (commit.actor.type === "agent") {
    const peerIds = [...new Set(peers.filter((p) => p.actor.type === "agent").map((p) => p.actor.id))];
    if (peerIds.length && !peerIds.includes(commit.actor.id))
      problems.push(`commit actor agent/${commit.actor.id} is not among MCP peers ${peerIds.map((id) => "agent/" + id).join(", ")}`);
  }
  const commitSession = commit.location?.session;
  if (commitSession) {
    const peerSessions = [...new Set(peers.map((p) => p.location?.session).filter((s): s is string => !!s))];
    if (peerSessions.length && !peerSessions.includes(commitSession))
      problems.push(`commit session ${commitSession} does not match MCP session ${peerSessions.join(", ")}`);
  }
  if (!problems.length) return result("pass", "pin/session", "commit actor and session match MCP peers in the why-chain");
  return result(gate ? "fail" : "warn", "pin/session", problems.join("; "));
}

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

function loadCredential(cfg: RepoConfig, env: NodeJS.ProcessEnv, gate = false): { credential?: Credential; token?: string; finding: Finding } {
  const envToken = env.RETRACE_HOOK_TOKEN ?? env.RETRACE_TOKEN;
  if (gate) {
    return envToken
      ? { token: envToken, finding: result("pass", "credential", "RETRACE_TOKEN from environment") }
      : { finding: result("fail", "credential", "RETRACE_TOKEN is required for --gate") };
  }
  if (!cfg.credential) {
    const token = envToken ?? cfg.token;
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
  const argv = process.argv.slice(2);
  const args = parseDoctorArgs(argv);
  const first = argv.filter((a) => !a.startsWith("--"))[0];
  if (first && first !== "doctor" && first !== "status" && !first.startsWith(".") && !first.startsWith("/") && !existsSync(resolve(first))) {
    console.error("usage: retrace <doctor [--gate] [repo] | status [project] [--json]>"); process.exit(2); return;
  }
  const { command, gate } = args;
  let repo: string;
  try { repo = resolve(git(resolve(args.repo ?? process.cwd()), ["rev-parse", "--show-toplevel"])); }
  catch { console.error("FAIL  repository — not inside a Git repository (or pass its path)"); process.exit(1); return; }
  const findings: Finding[] = [];
  const cfgPath = join(repo, ".retrace.json");
  let cfg: RepoConfig = {};
  if (!existsSync(cfgPath)) findings.push(result("fail", "repository wiring", `${cfgPath} is missing; run retrace-git install --repo ${repo}`));
  else try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); findings.push(result("pass", "repository wiring", cfgPath)); }
  catch (e: any) { findings.push(result("fail", "repository wiring", `${cfgPath} is invalid JSON: ${e.message}`)); }

  if (!gate) {
    const gitDir = resolve(repo, git(repo, ["rev-parse", "--git-dir"]));
    const hook = join(gitDir, "hooks", "post-commit");
    const hookOk = existsSync(hook) && readFileSync(hook, "utf8").includes("# retrace-git hook");
    findings.push(hookOk ? result("pass", "post-commit hook", hook) : result("fail", "post-commit hook", `not installed at ${hook}; run retrace-git install --repo ${repo}`));
  }

  const project = process.env.RETRACE_PROJECT ?? cfg.project ?? basename(repo);
  const url = (process.env.RETRACE_URL ?? cfg.url ?? "").replace(/\/$/, "");
  const auth = loadCredential(cfg, process.env, gate); findings.push(auth.finding);
  if (command === "status") {
    const selected = args.statusProject ?? project;
    if (!url) { console.error("retrace status: RETRACE_URL or .retrace.json url is required"); process.exit(1); return; }
    const res = await fetch(`${url}/projects/${encodeURIComponent(selected)}/status`, { headers: retraceHeaders(auth.token) });
    if (!res.ok) { console.error(`retrace status: HTTP ${res.status}: ${await res.text()}`); process.exit(1); return; }
    const status = await res.json() as ProjectStatus;
    console.log(args.json ? JSON.stringify(status, null, 2) : renderProjectStatus(status));
    return;
  }
  let headEvent: ReturnType<typeof commitToEvent> | undefined;
  try {
    headEvent = commitToEvent(repo, "HEAD", { ...cfg, project, repoName: cfg.repoName });
    if (!gate && auth.credential) findings.push(credentialAuthorization(auth.credential, headEvent.actor));
  } catch (e: any) { findings.push(result("fail", "HEAD", `could not inspect the current commit: ${e.message}`)); }

  if (!url) findings.push(result(gate ? "fail" : "warn", "deployment", gate ? "RETRACE_URL is required for --gate" : "no RETRACE_URL or .retrace.json url; remote checks skipped"));
  else {
    const headers = retraceHeaders(auth.token);
    try {
      const res = await fetch(`${url}/api`, { headers: retraceHeaders() }); if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
        const action = headEvent.action === "merged" ? "merged" : "committed";
        const res = await fetch(`${url}/projects/${encodeURIComponent(project)}/events?artifact_id=${encodeURIComponent(commit ?? "")}&action=${action}`, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        const events: Event[] = await res.json();
        const sealed = sealedCommitEvent(events);
        const delivery = headDelivery(gate, commit, !!sealed);
        findings.push(sealed ? result("pass", "HEAD delivery", `${commit} is event #${sealed.seq}`) : delivery);
        if (sealed) findings.push(attributionFinding(gate, sealed));
        if (sealed && sealedLooksAgent(sealed)) {
          try {
            const whyRes = await fetch(`${url}/events/${encodeURIComponent(sealed.id)}/why`, { headers });
            if (!whyRes.ok) throw new Error(`HTTP ${whyRes.status}: ${await whyRes.text()}`);
            const why = await whyRes.json() as Event[];
            findings.push(pinSessionFinding(gate, sealed, why));
            if (gate) findings.push(instructRootFinding("agent", why));
          } catch (e: any) { findings.push(result("fail", "instruct root", e.message)); }
        } else if (gate && sealed) {
          findings.push(instructRootFinding(sealed.actor.type, []));
        }
      } catch (e: any) { findings.push(result("fail", "HEAD delivery", e.message)); }
    }
  }

  for (const f of findings) console.log(`${f.level.toUpperCase()}  ${f.label} — ${f.detail}`);
  const failed = findings.filter((f) => f.level === "fail").length, warned = findings.filter((f) => f.level === "warn").length;
  console.log(`\n${failed ? "NOT READY" : "READY"} — ${findings.length - failed - warned} passed, ${warned} warnings, ${failed} failures`);
  process.exit(failed ? 1 : 0);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error("retrace doctor:", e.message ?? e); process.exit(1); });
