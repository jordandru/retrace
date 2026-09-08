#!/usr/bin/env node
/** retrace doctor — read-only preflight for the Git → Worker developer workflow. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isAttributionAmendment, Actor, Credential, Event, ProjectStatus, ReconcileReport, asHistoryPage, causalRootState, renderProjectStatus, schemaSurface } from "@retrace-dev/core";
import { Cfg, commitToEvent, resolveHookToken } from "./git-hook.js";
import { ReconcileCfg, commitFacts, reconcileOptionsFrom, reconcileWithGit, repoNamesFor } from "./reconcile.js";
import { RemoteStore, retraceHeaders } from "./remote-store.js";
import { fetchVerifiedRemoteEvents } from "./verified-events.js";
import { isMainModule } from "./is-main.js";

type Level = "pass" | "warn" | "fail";
export type Finding = { level: Level; label: string; detail: string };
export type DoctorArgs = { command: "doctor" | "status"; gate: boolean; json: boolean; local: boolean; repo?: string; statusProject?: string };
type RepoConfig = ReconcileCfg & { credential?: string };

const git = (repo: string, args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const result = (level: Level, label: string, detail: string): Finding => ({ level, label, detail });

function gitOutput(repo: string, args: string[]): string | undefined {
  try { return git(repo, args); }
  catch { return undefined; }
}

/** Read-only object database preflight. Ref resolution alone does not prove the referenced object is readable. */
export function objectStoreFinding(repo: string): Finding {
  const objectsDirRaw = gitOutput(repo, ["rev-parse", "--git-path", "objects"]);
  if (!objectsDirRaw) return result("fail", "object store", "could not locate the Git object store");
  const objectsDir = resolve(repo, objectsDirRaw);
  const emptyObjectIds: string[] = [];
  try {
    for (const fanout of readdirSync(objectsDir, { withFileTypes: true })) {
      if (!fanout.isDirectory() || !/^[0-9a-f]{2}$/i.test(fanout.name)) continue;
      const dir = join(objectsDir, fanout.name);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && statSync(join(dir, entry.name)).size === 0) emptyObjectIds.push(fanout.name + entry.name);
      }
    }
  } catch (error: any) {
    return result("fail", "object store", `could not scan ${objectsDir}: ${error?.message ?? error}`);
  }

  const empty = new Set(emptyObjectIds);
  const headSha = gitOutput(repo, ["rev-parse", "HEAD"]);
  const headType = gitOutput(repo, ["cat-file", "-t", "HEAD"]);
  const originRef = "refs/remotes/origin/main";
  const originLookup = spawnSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", originRef], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const originRefPathRaw = gitOutput(repo, ["rev-parse", "--git-path", originRef]);
  let looseOriginMain: boolean | undefined;
  if (originRefPathRaw) {
    try {
      lstatSync(resolve(repo, originRefPathRaw));
      looseOriginMain = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") looseOriginMain = false;
    }
  }
  const originAbsent = originLookup.status === 1 && looseOriginMain === false;
  const originLookupFailed = originLookup.error !== undefined || originLookup.status === null || (originLookup.status !== 0 && !originAbsent);
  const hasOriginMain = !originAbsent;
  const originSha = hasOriginMain ? gitOutput(repo, ["rev-parse", "--verify", originRef]) : undefined;
  const originType = hasOriginMain ? gitOutput(repo, ["cat-file", "-t", "origin/main"]) : undefined;

  const problems: string[] = [];
  if (emptyObjectIds.length) problems.push(`${emptyObjectIds.length} empty loose object file${emptyObjectIds.length === 1 ? "" : "s"}`);
  if (headType !== "commit") problems.push(`HEAD is not a readable commit${headSha && empty.has(headSha) ? " and points to an empty loose object" : ""}`);
  if (originLookupFailed) problems.push(`origin/main ref lookup failed${originLookup.stderr.trim() ? `: ${originLookup.stderr.trim()}` : ""}`);
  if (hasOriginMain && originType !== "commit") problems.push(`origin/main is not a readable commit${originSha && empty.has(originSha) ? " and points to an empty loose object" : ""}`);

  if (!problems.length) {
    return result("pass", "object store", `no empty loose objects; HEAD is a readable commit; origin/main is ${hasOriginMain ? "a readable commit" : "not configured"}`);
  }
  return result(
    "fail",
    "object store",
    `git rev-parse printing a SHA is not proof the object exists; ${problems.join("; ")}. Delete the empty files, run git fetch origin (or fetch from a healthy clone), then git cat-file -t origin/main must return commit. Do not reset/pull until then.`,
  );
}

export function hookFindings(repo: string): Finding[] {
  const hooksDir = resolve(repo, git(repo, ["rev-parse", "--git-path", "hooks"]));
  const hook = join(hooksDir, "post-commit");
  const hookOk = existsSync(hook) && readFileSync(hook, "utf8").includes("# retrace-git hook");
  const mergeHook = join(hooksDir, "post-merge");
  const mergeHookOk = existsSync(mergeHook) && readFileSync(mergeHook, "utf8").includes("# retrace-git hook");
  return [
    hookOk ? result("pass", "post-commit hook", hook) : result("fail", "post-commit hook", `not installed at ${hook}; run retrace-git install --repo ${repo}`),
    // git runs post-merge, not post-commit, for `git merge`; an install from before 2026-09-06 wrote only post-commit,
    // so its merge commits were never sealed by the hook. A warning, not a failure: commits still seal, merges don't.
    mergeHookOk ? result("pass", "post-merge hook", mergeHook) : result("warn", "post-merge hook", `not installed at ${mergeHook}; merge commits are not sealed by the hook — re-run retrace-git install --repo ${repo}`),
  ];
}

export function parseDoctorArgs(argv: string[]): DoctorArgs {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const pos = argv.filter((a) => !a.startsWith("--"));
  const gate = flags.has("--gate");
  const json = flags.has("--json");
  const local = flags.has("--local");
  if (pos[0] === "status") return { command: "status", gate: false, json, local: false, statusProject: pos[1] };
  const rest = pos[0] === "doctor" ? pos.slice(1) : pos;
  return { command: "doctor", gate, json, local, repo: rest[0] };
}

/**
 * Dual-witness level for the gate's capture-coverage check. A security gate never infers leniency from the local ref
 * layout (Codex review of 5f951c6: a pull_request checkout of an explicit head sha is detached, and no refs/remotes
 * branch need contain HEAD — a genuinely pushed commit looked "unpushed" and a lone producer became a warning).
 * `--gate` fails on a lone producer, full stop. `--local` is the explicit opt-in for unpushed work on a developer
 * machine and is REFUSED under CI (GITHUB_ACTIONS / CI set): the flag cannot be smuggled into a workflow.
 */
export function gateDualWitness(args: { gate: boolean; local: boolean }, env: NodeJS.ProcessEnv = process.env): { dualWitness?: "warn" } {
  if (!args.local) return {};
  if (env.GITHUB_ACTIONS || env.CI) throw new Error("--local is not allowed under CI (GITHUB_ACTIONS/CI is set): the gate must fail on a commit only one producer sealed");
  return { dualWitness: "warn" };
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

/** Normalize both legacy array history and the current newest-window page before doctor filters HEAD seals. */
export function doctorHistoryEvents(body: unknown): Event[] {
  return asHistoryPage(body).events;
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

export function captureCoverageFinding(report: ReconcileReport): Finding {
  const v = report.commits[0];
  if (!v) return result("fail", "capture coverage", "no commit in the reconcile report");
  const live = v.findings.filter((f) => !f.acknowledged);
  const worst: Level = live.some((f) => f.level === "fail") ? "fail" : live.some((f) => f.level === "warn") ? "warn" : "pass";
  if (worst === "pass") {
    const files = Object.keys(v.coverage);
    const actors = [...new Set(files.flatMap((f) => v.coverage[f].actors))];
    const note = v.findings.filter((f) => f.kind === "non_agent").length ? v.findings[0].detail
      : files.length ? `${files.length} file${files.length === 1 ? "" : "s"} covered by ${actors.join(", ") || "no one"}${v.findings.some((f) => f.kind === "loose_match") ? " (some via loosely-identified refs)" : ""}${v.findings.some((f) => f.acknowledged) ? "; earlier finding acknowledged by a correction event" : ""}`
      : "no files changed";
    return result("pass", "capture coverage", note);
  }
  const top = live.filter((f) => f.level === worst);
  return result(worst, "capture coverage", top.map((f) => `${f.kind}: ${f.detail}`).join("; "));
}

/** Walk caused_by inside an already-verified event set. Same project + depth bound as explainEvent. */
export function whyChainFromVerified(events: Event[], start: Event, maxDepth = 25): Event[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const chain: Event[] = [];
  const seen = new Set<string>();
  let cur: Event | undefined = start;
  const project = start.project;
  while (cur && chain.length < maxDepth && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    const parent: Event | undefined = cur.caused_by ? byId.get(cur.caused_by) : undefined;
    cur = parent?.project === project ? parent : undefined;
  }
  return chain;
}

export function sealedCommitForArtifact(events: Event[], commitId: string | undefined): Event | undefined {
  if (!commitId) return undefined;
  return sealedCommitEvent(events.filter((e) =>
    (e.action === "committed" || e.action === "merged") && e.artifacts.some((a) => a.id === commitId),
  ));
}

export function verifiedLedgerHeads(events: Event[]): string {
  if (!events.length) return "verified set is empty";
  const last = events[events.length - 1]!;
  return `verified set through #${last.seq}`;
}

/**
 * Gate authorization from a verified event set only. Unsigned /events and /why must not decide
 * delivery, actor, pin/session, or instruct-root.
 */
export function verifiedHeadFindings(
  gate: boolean,
  commitId: string | undefined,
  verified: { events: Event[]; note: string },
): Finding[] {
  const sealed = sealedCommitForArtifact(verified.events, commitId);
  if (!sealed) {
    return [result(
      "fail",
      "HEAD delivery",
      `${commitId ?? "HEAD"} is not in the verified ledger (${verifiedLedgerHeads(verified.events)}; ${verified.note})`,
    )];
  }
  const findings: Finding[] = [
    result("pass", "HEAD delivery", `${commitId} is event #${sealed.seq}`),
    attributionFinding(gate, sealed),
  ];
  if (sealedLooksAgent(sealed)) {
    const why = whyChainFromVerified(verified.events, sealed);
    findings.push(pinSessionFinding(gate, sealed, why));
    if (gate) findings.push(instructRootFinding("agent", why));
  } else if (gate) {
    findings.push(instructRootFinding(sealed.actor.type, []));
  }
  return findings;
}

/** Fetch the verified ledger once, then derive HEAD delivery + authorization from that set. */
export async function gateRemoteAuthorization(
  commitId: string | undefined,
  store: RemoteStore,
  project: string,
  pubkeyFlag?: unknown,
  baseUrl?: string,
): Promise<{ findings: Finding[]; verified: { events: Event[]; note: string } }> {
  const verified = await fetchVerifiedRemoteEvents(store, project, pubkeyFlag, baseUrl);
  return { findings: verifiedHeadFindings(true, commitId, verified), verified };
}

export async function remoteCaptureCoverage(
  repo: string,
  project: string,
  store: RemoteStore,
  cfg: ReconcileCfg,
  args: { gate: boolean; local: boolean },
  pubkeyFlag?: unknown,
  baseUrl?: string,
  prefetched?: { events: Event[]; note: string },
): Promise<Finding> {
  const { events, note } = prefetched ?? await fetchVerifiedRemoteEvents(store, project, pubkeyFlag, baseUrl);
  let attribution: import("@retrace-dev/core").AttributionOptions | undefined;
  let attributionNote = "";
  if (events.some(isAttributionAmendment)) {
    try {
      const { attributionOptionsForRepo } = await import("./attribution.js");
      attribution = await attributionOptionsForRepo(repo, events, project);
    } catch (error) {
      attributionNote = `; attribution evaluation unavailable: ${error instanceof Error ? error.message : error}`;
    }
  }
  const report = reconcileWithGit(repo, [commitFacts(repo, "HEAD")], events, {
    attribution,
    ...repoNamesFor(repo, cfg),
    repoPath: repo,
    ...reconcileOptionsFrom(cfg, gateDualWitness(args)),
  });
  const finding = captureCoverageFinding(report);
  return { ...finding, detail: `${finding.detail}; ${note}${attributionNote}` };
}

export function attributionDeployment(api: { capabilities?: unknown }, gate: boolean): Finding {
  return Array.isArray(api.capabilities) && api.capabilities.includes("attribution-v7")
    ? result("pass", "attribution deployment", "Worker advertises attribution-v7")
    : result(gate ? "fail" : "warn", "attribution deployment", "Worker predates this build's attribution profile (attribution-v7); deploy the Worker from this build first");
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
    console.error("usage: retrace <doctor [--gate [--local]] [repo] | status [project] [--json]>"); process.exit(2); return;
  }
  const { command, gate } = args;
  let repo: string;
  try { repo = resolve(git(resolve(args.repo ?? process.cwd()), ["rev-parse", "--show-toplevel"])); }
  catch { console.error("FAIL  repository — not inside a Git repository (or pass its path)"); process.exit(1); return; }
  const findings: Finding[] = [];
  if (command === "doctor") findings.push(objectStoreFinding(repo));
  const cfgPath = join(repo, ".retrace.json");
  let cfg: RepoConfig = {};
  if (!existsSync(cfgPath)) findings.push(result("fail", "repository wiring", `${cfgPath} is missing; run retrace-git install --repo ${repo}`));
  else try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); findings.push(result("pass", "repository wiring", cfgPath)); }
  catch (e: any) { findings.push(result("fail", "repository wiring", `${cfgPath} is invalid JSON: ${e.message}`)); }

  if (!gate) {
    findings.push(...hookFindings(repo));
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
      findings.push(attributionDeployment(api, gate));
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
      if (gate) {
        // Gate authorization reads the verified signed export + chain-verified tail only. Unsigned
        // /events and /why must not decide delivery, actor, pin/session, or instruct-root.
        try {
          const remote = new RemoteStore(url, auth.token);
          const { findings: authFindings, verified } = await gateRemoteAuthorization(commit, remote, project, undefined, url);
          findings.push(...authFindings);
          try {
            findings.push(await remoteCaptureCoverage(repo, project, remote, cfg, args, undefined, url, verified));
          } catch (e: any) { findings.push(result("fail", "capture coverage", e.message)); }
        } catch (e: any) { findings.push(result("fail", "HEAD delivery", e.message)); }
      } else {
        try {
          const action = headEvent.action === "merged" ? "merged" : "committed";
          const res = await fetch(`${url}/projects/${encodeURIComponent(project)}/events?artifact_id=${encodeURIComponent(commit ?? "")}&action=${action}`, { headers });
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
          const events = doctorHistoryEvents(await res.json());
          const sealed = sealedCommitEvent(events);
          const delivery = headDelivery(false, commit, !!sealed);
          findings.push(sealed
            ? result("pass", "HEAD delivery", `${commit} is event #${sealed.seq} (unsigned /events; --gate uses the verified ledger)`)
            : { ...delivery, detail: `${delivery.detail} (unsigned /events; --gate uses the verified ledger)` });
          if (sealed) findings.push(attributionFinding(false, sealed));
          if (sealed && sealedLooksAgent(sealed)) {
            try {
              const whyRes = await fetch(`${url}/events/${encodeURIComponent(sealed.id)}/why`, { headers });
              if (!whyRes.ok) throw new Error(`HTTP ${whyRes.status}: ${await whyRes.text()}`);
              const why = await whyRes.json() as Event[];
              const pin = pinSessionFinding(false, sealed, why);
              findings.push({ ...pin, detail: `${pin.detail} (unsigned /why; --gate walks caused_by in the verified ledger)` });
            } catch (e: any) { findings.push(result("fail", "instruct root", `${e.message} (unsigned /why)`)); }
          }
        } catch (e: any) { findings.push(result("fail", "HEAD delivery", `${e.message} (unsigned /events)`)); }
      }
    }
  }

  for (const f of findings) console.log(`${f.level.toUpperCase()}  ${f.label} — ${f.detail}`);
  const failed = findings.filter((f) => f.level === "fail").length, warned = findings.filter((f) => f.level === "warn").length;
  console.log(`\n${failed ? "NOT READY" : "READY"} — ${findings.length - failed - warned} passed, ${warned} warnings, ${failed} failures`);
  process.exit(failed ? 1 : 0);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error("retrace doctor:", e.message ?? e); process.exit(1); });
