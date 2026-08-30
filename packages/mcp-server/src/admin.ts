#!/usr/bin/env node
/**
 * retrace-admin — provision a paying team on a hosted Retrace Worker.
 *
 *   retrace-admin new-team <project> --member a@x.com[,b@y.com] [--harness claude-code,codex,gemini,grok,github-copilot]
 *                          [--url https://retrace-api.<you>.workers.dev] [--credentials-file ~/.retrace/worker-credentials.json]
 *                          [--out onboarding-<project>.md] [--dry-run]
 *   retrace-admin list-teams [--credentials-file …]
 *
 * What new-team does (nothing touches the Worker by itself — secrets are pushed by the operator, see the printed step):
 *   1. Mints project-scoped credentials (Credential.projects = [<project>], so a leaked team token cannot read or write
 *      any other team's ledger): one PINNED agent credential per member × harness (actor.on_behalf_of = the member, so
 *      retrace_instruct can record that member's instructions and nobody else's), one ASSERT credential for the team's
 *      git hook (actor.id retrace-git-<project>, allowed_actors = the team's agents + members), and one pinned CI reader.
 *   2. Appends them to the operator's local mirror of RETRACE_CREDENTIALS (the file the git hook and doctor read),
 *      written atomically with mode 0600. Refuses if the project already has credentials there.
 *   3. Writes an onboarding document for the team (mode 0600 — it contains their tokens; send it over a channel you
 *      would send a password over, then delete it).
 *   4. Prints the one command that makes the Worker honour the new credentials.
 *
 * The project itself needs no creation step: a Retrace project exists from its first event.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Credential, parseCredentials } from "@retrace-dev/core";
import { isMainModule } from "./is-main.js";

export const HARNESSES = ["claude-code", "codex", "gemini", "grok", "github-copilot"] as const;
export type Harness = (typeof HARNESSES)[number];

/** Where each harness keeps its MCP server config, for the onboarding text. */
const HARNESS_CONFIG: Record<Harness, { label: string; file: string; instructions: string }> = {
  "claude-code": { label: "Claude Code", file: "~/.claude.json (or the repo's .mcp.json)", instructions: "CLAUDE.md" },
  codex: { label: "Codex", file: "Codex MCP settings", instructions: "AGENTS.md" },
  gemini: { label: "Gemini CLI", file: ".gemini/settings.json", instructions: "GEMINI.md" },
  grok: { label: "Grok", file: "~/.grok/config.toml", instructions: "GROK.md" },
  "github-copilot": { label: "GitHub Copilot CLI", file: "~/.copilot/mcp-config.json", instructions: ".github/copilot-instructions.md" },
};

export interface TeamSpec {
  project: string;
  members: string[];
  harnesses: Harness[];
  url: string;
}

export interface TeamPlan {
  spec: TeamSpec;
  credentials: Credential[];
  onboarding: string;
}

export function defaultCredentialsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.RETRACE_CREDENTIALS_FILE ?? join(homedir(), ".retrace", "worker-credentials.json");
}

const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateSpec(spec: TeamSpec): void {
  if (!PROJECT_RE.test(spec.project)) throw new Error(`project "${spec.project}" must be lowercase [a-z0-9._-], 1–64 chars`);
  if (!spec.members.length) throw new Error("at least one --member email is required");
  for (const m of spec.members) if (!EMAIL_RE.test(m)) throw new Error(`member "${m}" is not an email address`);
  if (new Set(spec.members).size !== spec.members.length) throw new Error("duplicate member");
  if (!spec.harnesses.length) throw new Error("at least one harness is required");
  for (const h of spec.harnesses) if (!(HARNESSES as readonly string[]).includes(h)) throw new Error(`unknown harness "${h}" (known: ${HARNESSES.join(", ")})`);
  if (!/^https:\/\//.test(spec.url)) throw new Error(`--url must be https (got ${spec.url})`);
}

/** 32 random bytes, base64url — 43 chars, comfortably above the 16-char minimum the Worker enforces. */
export function mintToken(rand: (n: number) => Buffer = randomBytes): string {
  return rand(32).toString("base64url");
}

export function gitHookActorId(project: string): string { return `retrace-git-${project}`; }
export function ciActorId(project: string): string { return `ci-${project}`; }

/** Pure: the credentials a team needs. Deterministic given `rand`, so it is testable. */
export function planCredentials(spec: TeamSpec, rand: (n: number) => Buffer = randomBytes): Credential[] {
  validateSpec(spec);
  const out: Credential[] = [];
  for (const member of spec.members) {
    for (const h of spec.harnesses) {
      out.push({
        token: mintToken(rand),
        name: `${spec.project} · ${h} for ${member}`,
        actor: { type: "agent", id: h, on_behalf_of: member },
        trust: "pinned",
        projects: [spec.project],
      });
    }
  }
  out.push({
    token: mintToken(rand),
    name: `${spec.project} · git hook`,
    actor: { type: "system", id: gitHookActorId(spec.project) },
    trust: "assert",
    projects: [spec.project],
    allowed_actors: [
      ...spec.harnesses.map((h) => ({ type: "agent" as const, id: h })),
      ...spec.members.map((m) => ({ type: "human" as const, id: m })),
    ],
  });
  out.push({
    token: mintToken(rand),
    name: `${spec.project} · CI gate reader`,
    actor: { type: "system", id: ciActorId(spec.project) },
    trust: "pinned",
    projects: [spec.project],
  });
  return out;
}

const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";

/** Pure: the onboarding document. Contains the tokens — the caller decides where it may go. */
export function renderOnboarding(spec: TeamSpec, credentials: Credential[]): string {
  const hook = credentials.find((c) => c.actor.id === gitHookActorId(spec.project))!;
  const ci = credentials.find((c) => c.actor.id === ciActorId(spec.project))!;
  const lines: string[] = [];
  lines.push(`# Retrace onboarding — team \`${spec.project}\``, "");
  lines.push(`Your ledger: ${spec.url}  ·  timeline: ${spec.url}/?project=${encodeURIComponent(spec.project)}`);
  lines.push(`Members: ${spec.members.join(", ")}  ·  agents: ${spec.harnesses.join(", ")}`, "");
  lines.push("**This document contains secrets.** Each person keeps their own tokens; nobody needs anyone else's. Delete it once everyone has copied theirs.", "");
  lines.push("## 1. Each member: give each agent its own identity", "");
  lines.push("Every agent you run gets its **own** token, pinned to your email. Never reuse another agent's token — the ledger would record the wrong agent. Leave `RETRACE_ACTOR_MODEL` unset so the agent reports the model it actually ran.", "");
  for (const member of spec.members) {
    lines.push(`### ${member}`, "");
    for (const h of spec.harnesses) {
      const cred = credentials.find((c) => c.actor.type === "agent" && c.actor.id === h && c.actor.on_behalf_of === member)!;
      const cfg = HARNESS_CONFIG[h];
      lines.push(`**${cfg.label}** — MCP server entry in \`${cfg.file}\`; repo instructions in \`${cfg.instructions}\`.`, "");
      lines.push(fence("json", JSON.stringify({
        retrace: {
          command: "npx",
          args: ["-y", "--package=@retrace-dev/cli", "retrace-mcp"],
          env: {
            RETRACE_URL: spec.url,
            RETRACE_TOKEN: cred.token,
            RETRACE_PROJECT: spec.project,
            RETRACE_ACTOR: h,
            RETRACE_ON_BEHALF_OF: member,
          },
        },
      }, null, 2)), "");
    }
  }
  lines.push("## 2. Once per repo: commits → ledger", "");
  lines.push("On the machine that commits (each developer, or a shared runner), keep the hook credential in `~/.retrace/worker-credentials.json` — the hook looks it up by name and the repo never carries a token:", "");
  lines.push(fence("json", JSON.stringify([{ token: hook.token, actor: hook.actor, trust: hook.trust, projects: hook.projects, allowed_actors: hook.allowed_actors }], null, 2)), "");
  lines.push("Then in the repo — `.retrace.json` names the project, the ledger URL and the credential's *name* (no token), so it is safe to commit:", "");
  lines.push(fence("bash", [
    `cat > .retrace.json <<'EOF'`,
    JSON.stringify({ project: spec.project, environment: "local", url: spec.url, credential: hook.actor.id }, null, 2),
    "EOF",
    `npx -y --package=@retrace-dev/cli retrace-git install --project ${spec.project}   # writes .git/hooks/post-commit; keeps your .retrace.json`,
    "git add .retrace.json && git commit -m \"Wire Retrace\"",
    "npx -y --package=@retrace-dev/cli retrace doctor            # expect READY",
  ].join("\n")), "");
  lines.push("Agent commits carry trailers `Retrace-Actor: <agent id>`, `Retrace-Model: <model>`, `Retrace-Caused-By: evt_…` — the per-harness instruction files above tell each agent to add them.", "");
  lines.push("## 3. CI gate (recommended)", "");
  lines.push(`Add repo secret \`RETRACE_CI_TOKEN\` = \`${ci.token}\` (read-only, scoped to \`${spec.project}\`) and a workflow step:`, "");
  lines.push(fence("yaml", [
    "- name: Retrace gate",
    "  env:",
    `    RETRACE_URL: ${spec.url}`,
    "    RETRACE_TOKEN: ${{ secrets.RETRACE_CI_TOKEN }}",
    "  run: npx -y --package=@retrace-dev/cli retrace doctor --gate",
  ].join("\n")), "");
  lines.push("A commit with no provenance behind it fails the check. Make `gate` a required status check on your default branch.", "");
  lines.push("## 4. Prove it to someone else", "");
  lines.push(fence("bash", [
    `npx -y --package=@retrace-dev/cli retrace-export export ${spec.project} --out ${spec.project}.json`,
    `RETRACE_URL=${spec.url} npx -y --package=@retrace-dev/cli retrace-export verify ${spec.project}.json   # VALID against the ledger's published key`,
  ].join("\n")), "");
  lines.push("Share links (`retrace_share` from any agent, or the UI) serve a read-only timeline, signed export and printable report without a token.", "");
  lines.push("## What Retrace does and does not prove", "");
  lines.push("Tamper-**evident**, not tamper-proof: edits to sealed events and removal after a checkpoint are detectable; history before a checkpoint could still be rewritten by whoever operates the database. Agent model names are what the agent reported. Line-level attribution is not a feature. The ledger holds what producers log — the CI gate makes commits complete; keystrokes are never captured.", "");
  return lines.join("\n");
}

export function planTeam(spec: TeamSpec, rand: (n: number) => Buffer = randomBytes): TeamPlan {
  const credentials = planCredentials(spec, rand);
  return { spec, credentials, onboarding: renderOnboarding(spec, credentials) };
}

/** Read the operator's credential mirror (parsed with the Worker's own schema so a bad file fails here, not at deploy). */
export function readCredentialsFile(path: string): Credential[] {
  if (!existsSync(path)) return [];
  return parseCredentials(readFileSync(path, "utf8"));
}

export function teamsIn(credentials: Credential[]): Record<string, Credential[]> {
  const out: Record<string, Credential[]> = {};
  for (const c of credentials) for (const p of c.projects ?? ["*"]) (out[p] ??= []).push(c);
  return out;
}

/** Append atomically, mode 0600, without ever leaving a partially written credentials file behind. */
export function appendCredentials(path: string, existing: Credential[], added: Credential[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify([...existing, ...added], null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {}; const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const n = argv[i + 1]; if (n && !n.startsWith("--")) { flags[a.slice(2)] = n; i++; } else flags[a.slice(2)] = true; } else pos.push(a); }
  return { flags, pos };
}

const list = (v: unknown) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export async function main(argv = process.argv.slice(2), env = process.env, out: (s: string) => void = console.log): Promise<number> {
  const { flags, pos } = parseArgs(argv);
  const cmd = pos[0];
  const credentialsFile = resolve(String(flags["credentials-file"] ?? defaultCredentialsFile(env)));
  if (cmd === "list-teams") {
    const teams = teamsIn(readCredentialsFile(credentialsFile));
    for (const [p, creds] of Object.entries(teams).sort()) {
      const members = [...new Set(creds.map((c) => c.actor.on_behalf_of).filter(Boolean))];
      out(`${p === "*" ? "(unscoped)" : p}: ${creds.length} credential${creds.length === 1 ? "" : "s"}${members.length ? ` · members ${members.join(", ")}` : ""}`);
    }
    return 0;
  }
  if (cmd === "new-team") {
    const project = pos[1]; if (!project) throw new Error("usage: retrace-admin new-team <project> --member a@x.com[,b@y.com] [--harness …] [--url https://…]");
    const spec: TeamSpec = {
      project,
      members: list(flags.member),
      harnesses: (flags.harness ? list(flags.harness) : [...HARNESSES]) as Harness[],
      url: String(flags.url ?? env.RETRACE_URL ?? "").replace(/\/+$/, ""),
    };
    validateSpec(spec);
    const existing = readCredentialsFile(credentialsFile);
    if (existing.some((c) => c.projects?.includes(project))) throw new Error(`${credentialsFile} already holds credentials scoped to "${project}" — refusing to mint a second set (remove them first, or pick another project name)`);
    const plan = planTeam(spec);
    const onboardingPath = resolve(String(flags.out ?? `onboarding-${project}.md`));
    if (flags["dry-run"]) {
      out(`dry run — would add ${plan.credentials.length} credentials for ${project} to ${credentialsFile} and write ${onboardingPath}`);
      for (const c of plan.credentials) out(`  ${c.trust.padEnd(7)} ${c.actor.type}/${c.actor.id}${c.actor.on_behalf_of ? " for " + c.actor.on_behalf_of : ""}`);
      return 0;
    }
    appendCredentials(credentialsFile, existing, plan.credentials);
    writeFileSync(onboardingPath, plan.onboarding, { mode: 0o600 });
    out(`added ${plan.credentials.length} credentials for ${project} to ${credentialsFile} (mode 0600)`);
    out(`wrote ${onboardingPath} (mode 0600) — it contains the team's tokens; send it over a channel you'd send a password over, then delete it`);
    out("");
    out("Make the Worker honour them (run from apps/worker; wrangler asks for confirmation):");
    out(`  npx wrangler secret put RETRACE_CREDENTIALS < ${credentialsFile}`);
    out("");
    out(`Then confirm: curl -s -o /dev/null -w '%{http_code}\\n' ${spec.url}/projects/${encodeURIComponent(project)}/head -H 'authorization: Bearer <the CI token from the onboarding doc>'   # 200 (empty project) — 401 means the secret is not live yet`);
    return 0;
  }
  out("retrace-admin <new-team <project> --member a@x.com[,…] [--harness …] [--url https://…] [--out file.md] [--dry-run] | list-teams> [--credentials-file ~/.retrace/worker-credentials.json]");
  return cmd ? 1 : 0;
}

if (isMainModule(import.meta.url)) main().then((code) => process.exit(code)).catch((e) => { console.error("retrace-admin:", e.message ?? e); process.exit(1); });
