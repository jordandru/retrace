#!/usr/bin/env node
/**
 * retrace-admin — provision a paying team on a hosted Retrace Worker.
 *
 *   retrace-admin new-team <project> --member a@x.com[,b@y.com] [--harness claude-code,codex,gemini,grok,github-copilot]
 *                          [--url https://retrace-api.<you>.workers.dev] [--credentials-file ~/.retrace/worker-credentials.json]
 *                          [--out ~/.retrace/onboarding-<project>.md] [--producer-keys-dir ~/.retrace/producer-keys] [--dry-run]
 *   retrace-admin add-agent <project> --member a@x.com --harness openclaw [--url https://…] [--out ~/.retrace/onboarding-…md]
 *   retrace-admin retire-agent <project> --harness codex
 *   retrace-admin set-principal <project> --actor agent/codex --principal human/a@x.com [--on-behalf-of a@x.com]
 *   retrace-admin list-teams [--credentials-file …]
 *
 * What new-team does (nothing touches the Worker by itself — secrets are pushed by the operator, see the printed step):
 *   1. Mints project-scoped credentials (Credential.projects = [<project>], so a leaked team token cannot read or write
 *      any other team's ledger): one PINNED agent credential per member × harness (actor.on_behalf_of = the member, so
 *      retrace_instruct can record that member's instructions and nobody else's), one ASSERT credential for the team's
 *      git hook (actor.id retrace-git-<project>, allowed_actors = the team's agents + members), and one assert-trust CI
 *      reader with allowed_actors: [] so it can GET the gate routes but cannot POST /events.
 *   2. Mints an Ed25519 producer keypair per pinned agent (except OpenClaw) and the git hook: `public_key` +
 *      `require_signature: true` go on the credential (Worker-uploadable); the private JWK is a separate 0600 file
 *      under producer-keys/. The CI reader and OpenClaw get neither — OpenClaw is remote HTTP MCP and the Worker must
 *      not hold the private key. `producer_key_file` is a local path on the mirror only (zod strips it on the Worker).
 *   3. Appends them to the operator's local mirror of RETRACE_CREDENTIALS (the file the git hook and doctor read),
 *      written atomically with mode 0600. Refuses if the project already has credentials there.
 *   4. Writes an onboarding document for the team (mode 0600 — it contains their tokens; send it over a channel you
 *      would send a password over, then delete it). Never prints a private JWK.
 *   5. Prints the one command that makes the Worker honour the new credentials.
 *
 * The project itself needs no creation step: a Retrace project exists from its first event.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Credential, generateSigningKey, parseCredentials, publicFromPrivate, batchPrincipalConflicts, bodyPreviewSha256, formatPrincipal, parseActorRef, parsePrincipalRef, proposedPolicyBody, refuseReissueIfBound, refuseSetPrincipalIfConflict, samePrincipal } from "@retrace-dev/core";
import { isMainModule } from "./is-main.js";
import { defaultProducerKeysDir, producerKeySlug, writeProducerPrivateKey } from "./producer-key.js";

/** Kept stable so `new-team` does not silently provision an experimental integration. */
export const DEFAULT_HARNESSES = ["claude-code", "codex", "gemini", "grok", "github-copilot"] as const;
export const HARNESSES = [...DEFAULT_HARNESSES, "openclaw", "nooa"] as const;
export type Harness = (typeof HARNESSES)[number];

/** Where each harness keeps its MCP server config, for the onboarding text. */
const HARNESS_CONFIG: Record<Harness, { label: string; file: string; instructions: string }> = {
  "claude-code": { label: "Claude Code", file: "~/.claude.json (or the repo's .mcp.json)", instructions: "CLAUDE.md" },
  codex: { label: "Codex", file: "Codex MCP settings", instructions: "AGENTS.md" },
  gemini: { label: "Gemini CLI", file: ".gemini/settings.json", instructions: "GEMINI.md" },
  grok: { label: "Grok", file: "~/.grok/config.toml", instructions: "GROK.md" },
  "github-copilot": { label: "GitHub Copilot CLI", file: "~/.copilot/mcp-config.json", instructions: ".github/copilot-instructions.md" },
  openclaw: { label: "OpenClaw in NemoClaw", file: "NemoClaw's managed MCP provider store", instructions: "OpenClaw workspace instructions" },
  nooa: { label: "NOOA (NVIDIA Labs Object-Oriented Agents, research preview)", file: "the agent's .mcp.json (loaded via MCPManager.create_from_server)", instructions: "the agent's method docstrings / system prompt" },
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

export interface AgentSpec {
  project: string;
  member: string;
  harness: Harness;
  url: string;
}

/** Local mirror may carry `producer_key_file` (a path). The Worker Credential schema must not grow this field. */
export type LocalCredential = Credential & { producer_key_file?: string; retired_at?: string };

/** OpenClaw is remote HTTP MCP (Worker must not hold the private key). CI is a read-only assert credential. Everyone else who writes, signs. */
export function shouldMintProducerKey(c: Credential): boolean {
  if (c.actor.id === "openclaw") return false;
  if (c.actor.id.startsWith("ci-")) return false;
  if (c.trust === "assert") return true;
  return c.trust === "pinned" && c.actor.type === "agent";
}

export function producerKeyFileName(c: Credential): string {
  const scope = c.projects?.length
    ? [...c.projects].sort().map((project) => project === "*" ? "all-projects" : project).join("+")
    : "all-projects";
  const who = c.actor.on_behalf_of ? `${c.actor.id}-${c.actor.on_behalf_of}` : (c.actor.id || c.name || "producer");
  return `${producerKeySlug(scope)}--${producerKeySlug(who)}.jwk`;
}

export async function mintProducerKeys(
  credentials: Credential[],
  keysDir: string,
  generate: () => Promise<{ privateKey: JsonWebKey; publicKey: JsonWebKey }> = generateSigningKey,
): Promise<LocalCredential[]> {
  const out: LocalCredential[] = [];
  for (const c of credentials) {
    if (!shouldMintProducerKey(c)) { out.push(c); continue; }
    const kp = await generate();
    const path = join(keysDir, producerKeyFileName(c));
    writeProducerPrivateKey(path, kp.privateKey);
    out.push({
      ...c,
      public_key: publicFromPrivate(kp.privateKey),
      require_signature: true,
      producer_key_file: path,
    });
  }
  return out;
}

export function defaultCredentialsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.RETRACE_CREDENTIALS_FILE ?? join(homedir(), ".retrace", "worker-credentials.json");
}

/** Secret-bearing onboarding files default outside the current checkout. */
export function defaultOnboardingFile(name: string): string {
  return join(homedir(), ".retrace", name);
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
        principal: { type: "human", id: member },
      });
    }
  }
  out.push({
    token: mintToken(rand),
    name: `${spec.project} · git hook`,
    actor: { type: "system", id: gitHookActorId(spec.project) },
    trust: "assert",
    projects: [spec.project],
    principal: { type: "team", id: spec.project },
    allowed_actors: [
      ...spec.harnesses.map((h) => ({ type: "agent" as const, id: h })),
      ...spec.members.map((m) => ({ type: "human" as const, id: m })),
    ],
  });
  out.push({
    token: mintToken(rand),
    name: `${spec.project} · CI gate reader`,
    actor: { type: "system", id: ciActorId(spec.project) },
    trust: "assert",
    allowed_actors: [],
    projects: [spec.project],
    principal: { type: "team", id: spec.project },
  });
  return out;
}

const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";

/** Pure: the onboarding document. Contains the tokens — the caller decides where it may go. Never a private JWK. */
export function renderOnboarding(spec: TeamSpec, credentials: LocalCredential[]): string {
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
      if (h === "openclaw") {
        lines.push("NemoClaw is the sandbox runtime, not the ledger actor. Configure the managed Streamable HTTP provider from the host; the secret stays in NemoClaw's provider store:", "");
        lines.push(fence("bash", [
          `export RETRACE_MCP_TOKEN='${cred.token}'`,
          `nemoclaw <sandbox-name> mcp add retrace --url ${spec.url}/mcp --env RETRACE_MCP_TOKEN`,
          "unset RETRACE_MCP_TOKEN",
          "nemoclaw <sandbox-name> mcp list",
        ].join("\n")), "");
        continue;
      }
      lines.push(fence("json", JSON.stringify({
        retrace: {
          command: "npx",
          args: ["-y", "--package=@retrace-dev/cli", "retrace-mcp"],
          env: mcpEnv(spec, h, member, cred),
        },
      }, null, 2)), "");
    }
  }
  lines.push("## 2. Once per repo: commits → ledger", "");
  lines.push("On the machine that commits (each developer, or a shared runner), keep the hook credential in `~/.retrace/worker-credentials.json` — the hook looks it up by name and the repo never carries a token. `producer_key_file` is a local path (not uploaded as the Worker secret); or set `RETRACE_HOOK_KEY_FILE`:", "");
  lines.push(fence("json", JSON.stringify([hookDump(hook)], null, 2)), "");
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
  lines.push("A commit with no provenance behind it fails the check. Make `gate` a required status check on your default branch. The CI reader is minted with trust `assert` and `allowed_actors: []`, so it can GET `/export`, `/head?signed=1` and `/events` but cannot POST `/events` (or any other write). It has no producer key. Re-mint after this Worker/admin change deploys; an older pinned CI token can still write as its pinned actor.", "");
  lines.push("## 4. Prove it to someone else", "");
  lines.push(fence("bash", [
    `npx -y --package=@retrace-dev/cli retrace-export export ${spec.project} --out ${spec.project}.json`,
    `RETRACE_URL=${spec.url} npx -y --package=@retrace-dev/cli retrace-export verify ${spec.project}.json   # VALID against the ledger's published key`,
  ].join("\n")), "");
  lines.push("Share links (`retrace_share` from any agent, or the UI) serve a read-only timeline, signed export and printable report without a token.", "");
  lines.push("## What Retrace does and does not prove", "");
  lines.push("Tamper-**evident**, not tamper-proof: edits to sealed events and removal after a checkpoint are detectable; history before a checkpoint could still be rewritten by whoever operates the database. Agent model names are what the agent reported. Line-level attribution is not a feature. The ledger holds what producers log — the CI gate makes commits complete; keystrokes are never captured. Producer signatures (when `RETRACE_PRODUCER_KEY_FILE` / `RETRACE_HOOK_KEY_FILE` is set) attest the producer process; the Worker never holds the private key. The ledger records the human instruction (`retrace_instruct`) and the agent's logged actions — not the harness's system prompt or the model's reasoning; what a vendor told the agent is out of scope by design.", "");
  return lines.join("\n");
}

function mcpEnv(spec: TeamSpec | AgentSpec, actor: string, member: string, cred: LocalCredential): Record<string, string> {
  return {
    RETRACE_URL: spec.url,
    RETRACE_TOKEN: cred.token,
    RETRACE_PROJECT: spec.project,
    RETRACE_ACTOR: actor,
    RETRACE_ON_BEHALF_OF: member,
    ...(cred.producer_key_file ? { RETRACE_PRODUCER_KEY_FILE: cred.producer_key_file } : {}),
  };
}

function hookDump(hook: LocalCredential): Record<string, unknown> {
  return {
    token: hook.token,
    actor: hook.actor,
    trust: hook.trust,
    projects: hook.projects,
    allowed_actors: hook.allowed_actors,
    ...(hook.public_key ? { public_key: hook.public_key, require_signature: hook.require_signature } : {}),
    ...(hook.producer_key_file ? { producer_key_file: hook.producer_key_file } : {}),
    ...(hook.principal ? { principal: hook.principal } : {}),
  };
}

export function planTeam(spec: TeamSpec, rand: (n: number) => Buffer = randomBytes): TeamPlan {
  const credentials = planCredentials(spec, rand);
  return { spec, credentials, onboarding: renderOnboarding(spec, credentials) };
}

export function planAgentCredential(spec: AgentSpec, rand: (n: number) => Buffer = randomBytes): Credential {
  validateSpec({ project: spec.project, members: [spec.member], harnesses: [spec.harness], url: spec.url });
  return {
    token: mintToken(rand),
    name: `${spec.project} · ${spec.harness} for ${spec.member}`,
    actor: { type: "agent", id: spec.harness, on_behalf_of: spec.member },
    trust: "pinned",
    projects: [spec.project],
    principal: { type: "human", id: spec.member },
  };
}

/** Single-token onboarding for adding one agent without redistributing an existing team's secrets. */
export function renderAgentOnboarding(spec: AgentSpec, credential: LocalCredential): string {
  const cfg = HARNESS_CONFIG[spec.harness];
  const lines = [
    `# Retrace agent onboarding — \`${spec.harness}\` for \`${spec.project}\``, "",
    "**This document contains one secret.** Send it like a password and delete it after setup.", "",
    `Ledger actor: \`${spec.harness}\` on behalf of \`${spec.member}\`. The runtime or sandbox is not a separate actor.`, "",
  ];
  if (spec.harness === "openclaw") {
    lines.push(
      "## OpenClaw via NemoClaw", "",
      "Run this on the NemoClaw host. `--env` places the bearer credential in the managed provider store rather than OpenClaw's sandbox:", "",
      fence("bash", [
        `export RETRACE_MCP_TOKEN='${credential.token}'`,
        `nemoclaw <sandbox-name> mcp add retrace --url ${spec.url}/mcp --env RETRACE_MCP_TOKEN`,
        "unset RETRACE_MCP_TOKEN",
        "nemoclaw <sandbox-name> mcp list",
      ].join("\n")), "",
      "The Worker must have `RETRACE_MCP_ENABLED=1`. This compatibility pilot uses server-stamped pinned identity and does not claim producer signatures.", "",
    );
  } else {
    lines.push(
      `## ${cfg.label}`, "",
      `Add this entry in \`${cfg.file}\` and keep the provenance instructions in \`${cfg.instructions}\`:`, "",
      fence("json", JSON.stringify({ retrace: { command: "npx", args: ["-y", "--package=@retrace-dev/cli", "retrace-mcp"], env: mcpEnv(spec, spec.harness, spec.member, credential) } }, null, 2)), "",
    );
  }
  return lines.join("\n");
}

/** Read the operator's credential mirror (Worker schema must accept it; extra `producer_key_file` paths are kept locally). */
export function readCredentialsFile(path: string): LocalCredential[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8"));
  parseCredentials(JSON.stringify(raw));
  return raw as LocalCredential[];
}

export function teamsIn(credentials: Credential[]): Record<string, Credential[]> {
  const out: Record<string, Credential[]> = {};
  for (const c of credentials) for (const p of c.projects ?? ["*"]) (out[p] ??= []).push(c);
  return out;
}

/** Append atomically, mode 0600, without ever leaving a partially written credentials file behind. Extra local fields such as `producer_key_file` are preserved; the Worker schema strips unknown keys on upload. */
export function appendCredentials(path: string, existing: LocalCredential[], added: LocalCredential[]): void {
  writeCredentialsFile(path, [...existing, ...added]);
}

/** Atomically replace the credentials mirror (mode 0600). */
export function writeCredentialsFile(path: string, credentials: LocalCredential[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export function credentialCoversProject(c: { projects?: string[] }, project: string): boolean {
  if (!c.projects || c.projects.includes("*")) return true;
  return c.projects.includes(project);
}

export function isLivePinned(c: LocalCredential): boolean {
  return (c.trust ?? "pinned") === "pinned" && !c.retired_at;
}

/** A live pinned credential for the same {project, actor type, actor id} — the §10 issuance guard. */
export function findLivePinned(
  credentials: LocalCredential[],
  project: string,
  actor: { type: string; id: string },
): LocalCredential | undefined {
  return credentials.find(
    (c) => isLivePinned(c) && c.actor.type === actor.type && c.actor.id === actor.id && credentialCoversProject(c, project),
  );
}

export function duplicateLivePinnedError(project: string, actor: { type: string; id: string }, existing: LocalCredential): string {
  const who = existing.name ?? `${existing.actor.type}/${existing.actor.id}`;
  return `refusing to mint a second live pinned ${actor.type}/${actor.id} credential for project "${project}" — ${who} is still live. Retire it first (retrace-admin retire-agent ${project} --harness ${actor.id}).`;
}

/** PR 27 vs prior rows, then the planned batch against itself, then never-reissue / unknown history vs prior rows. */
export function assertMintBatch(existing: LocalCredential[], planned: Credential[], project: string): void {
  for (const c of planned.filter((x) => (x.trust ?? "pinned") === "pinned")) {
    const live = findLivePinned(existing, project, c.actor);
    if (live) throw new Error(duplicateLivePinnedError(project, c.actor, live));
  }
  const batch = batchPrincipalConflicts(planned, project);
  if (batch) throw new Error(batch);
  for (const c of planned) {
    if (!c.principal) continue;
    const reissue = refuseReissueIfBound(existing, project, c.actor, c.principal);
    if (reissue) throw new Error(reissue);
  }
}

export function retireLivePinned(
  credentials: LocalCredential[],
  project: string,
  actor: { type: string; id: string },
  at: string,
): { credentials: LocalCredential[]; retired: LocalCredential[] } {
  const retired: LocalCredential[] = [];
  const next = credentials.map((c) => {
    if (!isLivePinned(c) || c.actor.type !== actor.type || c.actor.id !== actor.id || !credentialCoversProject(c, project)) return c;
    const updated = { ...c, retired_at: at };
    retired.push(updated);
    return updated;
  });
  if (!retired.length) throw new Error(`no live pinned ${actor.type}/${actor.id} credential covers project "${project}"`);
  return { credentials: next, retired };
}

/** Atomically replace a secret-bearing file with a freshly created 0600 inode, even when the destination exists. */
export function writeSecretFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600, flag: "wx" });
  try {
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

/** Return the containing Git worktree, including linked worktrees whose `.git` is a file. */
export function containingGitTree(path: string): string | undefined {
  let dir = dirname(resolve(path));
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function warnIfOnboardingInGitTree(path: string, out: (s: string) => void): void {
  const root = containingGitTree(path);
  if (!root) return;
  out(`WARNING: ${path} is inside Git worktree ${root}. This onboarding file contains live tokens; keep it untracked, move it to ~/.retrace, and delete it after setup.`);
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
      harnesses: (flags.harness ? list(flags.harness) : [...DEFAULT_HARNESSES]) as Harness[],
      url: String(flags.url ?? env.RETRACE_URL ?? "").replace(/\/+$/, ""),
    };
    validateSpec(spec);
    const existing = readCredentialsFile(credentialsFile);
    if (existing.some((c) => c.projects?.includes(project))) throw new Error(`${credentialsFile} already holds credentials scoped to "${project}" — refusing to mint a second set (remove them first, or pick another project name)`);
    const plan = planTeam(spec);
    assertMintBatch(existing, plan.credentials, spec.project);
    const onboardingPath = resolve(String(flags.out ?? defaultOnboardingFile(`onboarding-${project}.md`)));
    const keysDir = resolve(String(flags["producer-keys-dir"] ?? env.RETRACE_PRODUCER_KEYS_DIR ?? defaultProducerKeysDir(env)));
    warnIfOnboardingInGitTree(onboardingPath, out);
    if (flags["dry-run"]) {
      out(`dry run — would add ${plan.credentials.length} credentials for ${project} to ${credentialsFile} and write ${onboardingPath}`);
      for (const c of plan.credentials) out(`  ${c.trust.padEnd(7)} ${c.actor.type}/${c.actor.id}${c.actor.on_behalf_of ? " for " + c.actor.on_behalf_of : ""}`);
      return 0;
    }
    const credentials = await mintProducerKeys(plan.credentials, keysDir);
    appendCredentials(credentialsFile, existing, credentials);
    writeSecretFile(onboardingPath, renderOnboarding(spec, credentials));
    out(`added ${credentials.length} credentials for ${project} to ${credentialsFile} (mode 0600)`);
    out(`wrote ${onboardingPath} (mode 0600) — it contains the team's tokens; send it over a channel you'd send a password over, then delete it`);
    out(`producer private keys (mode 0600) under ${keysDir} — never upload those files as RETRACE_CREDENTIALS`);
    out("");
    out("Make the Worker honour them (run from apps/worker; wrangler asks for confirmation):");
    out(`  npx wrangler secret put RETRACE_CREDENTIALS < ${credentialsFile}`);
    out("");
    out(`Then confirm: curl -s -o /dev/null -w '%{http_code}\\n' ${spec.url}/projects/${encodeURIComponent(project)}/head -H 'authorization: Bearer <the CI token from the onboarding doc>'   # 200 (empty project) — 401 means the secret is not live yet`);
    return 0;
  }
  if (cmd === "add-agent") {
    const project = pos[1];
    const members = list(flags.member);
    const harnesses = list(flags.harness);
    if (!project || members.length !== 1 || harnesses.length !== 1)
      throw new Error("usage: retrace-admin add-agent <project> --member a@x.com --harness openclaw [--url https://…] [--out onboarding.md]");
    const spec: AgentSpec = {
      project,
      member: members[0],
      harness: harnesses[0] as Harness,
      url: String(flags.url ?? env.RETRACE_URL ?? "").replace(/\/+$/, ""),
    };
    const credential = planAgentCredential(spec);
    const existing = readCredentialsFile(credentialsFile);
    if (!existing.some((c) => c.projects?.includes(project)))
      throw new Error(`${credentialsFile} has no credentials scoped to "${project}" — use new-team first`);
    assertMintBatch(existing, [credential], spec.project);
    const onboardingPath = resolve(String(flags.out ?? defaultOnboardingFile(`onboarding-${project}-${spec.harness}.md`)));
    const keysDir = resolve(String(flags["producer-keys-dir"] ?? env.RETRACE_PRODUCER_KEYS_DIR ?? defaultProducerKeysDir(env)));
    warnIfOnboardingInGitTree(onboardingPath, out);
    if (flags["dry-run"]) {
      out(`dry run — would add pinned agent/${spec.harness} for ${spec.member} to ${credentialsFile} and write ${onboardingPath}`);
      return 0;
    }
    const [minted] = await mintProducerKeys([credential], keysDir);
    appendCredentials(credentialsFile, existing, [minted]);
    writeSecretFile(onboardingPath, renderAgentOnboarding(spec, minted));
    out(`added pinned agent/${spec.harness} for ${spec.member} in ${project} to ${credentialsFile} (mode 0600)`);
    out(`wrote ${onboardingPath} (mode 0600) — it contains one token; send it securely, then delete it`);
    out(`upload the updated secret: npx wrangler secret put RETRACE_CREDENTIALS < ${credentialsFile}`);
    return 0;
  }
  if (cmd === "retire-agent") {
    const project = pos[1];
    const harnesses = list(flags.harness);
    if (!project || harnesses.length !== 1)
      throw new Error("usage: retrace-admin retire-agent <project> --harness codex [--credentials-file …]");
    const actor = { type: "agent" as const, id: harnesses[0] };
    const existing = readCredentialsFile(credentialsFile);
    const { credentials, retired } = retireLivePinned(existing, project, actor, new Date().toISOString());
    if (flags["dry-run"]) {
      out(`dry run — would retire ${retired.length} live pinned ${actor.type}/${actor.id} credential(s) covering "${project}" in ${credentialsFile}`);
      return 0;
    }
    writeCredentialsFile(credentialsFile, credentials);
    out(`retired ${retired.length} live pinned ${actor.type}/${actor.id} credential(s) covering "${project}" in ${credentialsFile}`);
    out(`upload the updated secret: npx wrangler secret put RETRACE_CREDENTIALS < ${credentialsFile}`);
    return 0;
  }
  if (cmd === "set-principal") {
    const project = pos[1];
    const actorRaw = String(flags.actor ?? "");
    const principalRaw = String(flags.principal ?? "");
    if (!project || !actorRaw || !principalRaw)
      throw new Error("usage: retrace-admin set-principal <project> --actor agent/codex --principal human/a@x.com [--on-behalf-of a@x.com]");
    const actor = parseActorRef(actorRaw);
    const principal = parsePrincipalRef(principalRaw);
    const onBehalf = flags["on-behalf-of"] === undefined ? undefined : String(flags["on-behalf-of"]);
    const existing = readCredentialsFile(credentialsFile);
    const matches = existing.filter((c) =>
      c.actor.type === actor.type &&
      c.actor.id === actor.id &&
      credentialCoversProject(c, project) &&
      (onBehalf === undefined || c.actor.on_behalf_of === onBehalf)
    );
    if (!matches.length) {
      throw new Error(`no credential ${actor.type}/${actor.id} covers project "${project}"${onBehalf ? ` for ${onBehalf}` : ""}`);
    }
    if (matches.length > 1) {
      throw new Error(`ambiguous: ${matches.length} credentials match ${actor.type}/${actor.id} in "${project}" — pass --on-behalf-of <member email>`);
    }
    const target = matches[0]!;
    if (target.principal) {
      if (samePrincipal(target.principal, principal)) {
        out(`${target.name ?? `${actor.type}/${actor.id}`} already has principal ${formatPrincipal(principal)}`);
        return 0;
      }
      throw new Error(`principal is immutable — ${target.name ?? `${actor.type}/${actor.id}`} is already bound to ${formatPrincipal(target.principal)}`);
    }
    const others = existing.filter((c) => c !== target);
    const conflict = refuseSetPrincipalIfConflict(others, project, actor, principal);
    if (conflict) throw new Error(conflict);
    if (flags["dry-run"]) {
      out(`dry run — would set principal ${formatPrincipal(principal)} on ${target.name ?? `${actor.type}/${actor.id}`} in ${credentialsFile}`);
      return 0;
    }
    writeCredentialsFile(credentialsFile, existing.map((c) => c === target ? { ...c, principal } : c));
    out(`set principal ${formatPrincipal(principal)} on ${target.name ?? `${actor.type}/${actor.id}`} in ${credentialsFile}`);
    out(`upload the updated secret: npx wrangler secret put RETRACE_CREDENTIALS < ${credentialsFile}`);
    return 0;
  }
  if (cmd === "set-policy") {
    const project = pos[1];
    const from = String(flags.from ?? "");
    const ifMatch = String(flags["if-match"] ?? "");
    if (!project || !from || !ifMatch)
      throw new Error("usage: retrace-admin set-policy <project> --from <repo>/.retrace.json --if-match <digest>|none [--url] [--cross-project-copy] [--yes]");
    const proposal = await proposeSetPolicy({
      project,
      fromPath: resolve(from),
      ifMatch,
      url: String(flags.url ?? env.RETRACE_URL ?? "").replace(/\/+$/, ""),
      token: env.RETRACE_TOKEN,
      crossProjectCopy: flags["cross-project-copy"] === true,
    });
    out(proposal.printed);
    if (flags.yes && proposal.body) {
      const url = String(flags.url ?? env.RETRACE_URL ?? "").replace(/\/+$/, "");
      const token = env.RETRACE_TOKEN;
      if (!url || !token) throw new Error("PUT requires --url / RETRACE_URL and RETRACE_TOKEN");
      const res = await fetch(`${url}/projects/${encodeURIComponent(project)}/policy`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "if-match": ifMatch },
        body: JSON.stringify(proposal.body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`PUT /policy ${res.status}: ${text}`);
      const doc = JSON.parse(text) as { digest: string; envelope: { version: number; activation: { event_id: string } } };
      out(`authoritative policy_digest ${doc.digest} version ${doc.envelope.version} activation ${doc.envelope.activation.event_id}`);
    }
    return 0;
  }
  out("retrace-admin <new-team <project> --member a@x.com[,…] [--harness …] | add-agent <project> --member a@x.com --harness openclaw | retire-agent <project> --harness codex | set-principal <project> --actor agent/codex --principal human/a@x.com | set-policy <project> --from <repo>/.retrace.json --if-match <digest>|none | list-teams> [--url https://…] [--credentials-file …] [--out file.md (default: ~/.retrace/onboarding-*.md)] [--producer-keys-dir ~/.retrace/producer-keys] [--dry-run]");
  return cmd ? 1 : 0;
}

export async function proposeSetPolicy(opts: {
  project: string;
  fromPath: string;
  ifMatch: string;
  url?: string;
  token?: string;
  crossProjectCopy?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{ printed: string; body?: ReturnType<typeof proposedPolicyBody>; refused?: string }> {
  const cfg = JSON.parse(readFileSync(opts.fromPath, "utf8")) as {
    project?: string;
    reconcile?: { hook_sealed_by?: string[] };
    attribution?: { repositories?: { name: string; aliases?: string[] }[] };
  };
  const declared = typeof cfg.project === "string" && cfg.project ? cfg.project : undefined;
  const hint = basename(dirname(opts.fromPath));
  const lines: string[] = [];
  if (declared && declared !== opts.project && !opts.crossProjectCopy) {
    return { printed: `refused: .retrace.json declares project ${JSON.stringify(declared)}, not ${JSON.stringify(opts.project)} (pass --cross-project-copy to copy)`, refused: "declared-project mismatch" };
  }
  if (declared && declared !== opts.project && opts.crossProjectCopy) {
    lines.push(`--cross-project-copy: copying settings declared for ${declared} onto ${opts.project}`);
  }
  if (!declared) lines.push(`no declared project in ${opts.fromPath}; directory basename hint only: ${hint}`);
  const stamps = cfg.reconcile?.hook_sealed_by ?? [];
  const repositories = (cfg.attribution?.repositories ?? []).map((r) => ({ name: r.name, aliases: r.aliases ?? [] }));
  const url = (opts.url ?? "").replace(/\/+$/, "");
  const token = opts.token ?? "";
  if (!url || !token) {
    return { printed: "refused: set-policy needs --url and a token to read the Worker's github mapping", refused: "worker mapping unavailable" };
  }
  let github_repos: string[] = [];
  try {
    const fetchFn = opts.fetchImpl ?? fetch;
    const res = await fetchFn(`${url}/projects/${encodeURIComponent(opts.project)}/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return { printed: `refused: Worker github mapping unavailable (GET /projects/${opts.project}/status ${res.status})`, refused: "worker mapping unavailable" };
    }
    const status = await res.json() as { routing?: { repo?: string; source?: string }[] };
    github_repos = (status.routing ?? [])
      .filter((r) => r.source === "env_fallback" && typeof r.repo === "string")
      .map((r) => r.repo as string);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { printed: `refused: Worker github mapping unavailable (${msg})`, refused: "worker mapping unavailable" };
  }
  const body = proposedPolicyBody({ project: opts.project, stamps, repositories, github_repos });
  const preview = await bodyPreviewSha256(body);
  lines.push("proposed policy body:");
  lines.push(JSON.stringify(body, null, 2));
  lines.push(`body_preview_sha256 ${preview}  (settings-only preview, not the policy digest)`);
  lines.push(`If-Match: ${opts.ifMatch}`);
  return { printed: lines.join("\n"), body };
}

if (isMainModule(import.meta.url)) main().then((code) => process.exit(code)).catch((e) => { console.error("retrace-admin:", e.message ?? e); process.exit(1); });
