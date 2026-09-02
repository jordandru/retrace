import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCredentials } from "@retrace-dev/core";
import { DEFAULT_HARNESSES, planAgentCredential, renderAgentOnboarding, planTeam, planCredentials, validateSpec, teamsIn, appendCredentials, writeSecretFile, readCredentialsFile, gitHookActorId, ciActorId, main, TeamSpec } from "./admin.js";

/** deterministic "randomness": counter-filled buffers, distinct per call */
const fakeRand = () => { let n = 0; return (len: number) => Buffer.alloc(len, ++n); };

const spec: TeamSpec = { project: "acme-app", members: ["alice@acme.dev", "bob@acme.dev"], harnesses: ["claude-code", "codex"], url: "https://retrace-api.example.workers.dev" };

test("planCredentials: one pinned credential per member×harness, scoped to the project; assert hook bounded to the team; CI reader", () => {
  const creds = planCredentials(spec, fakeRand());
  assert.equal(creds.length, 2 * 2 + 2);
  const pinned = creds.filter((c) => c.trust === "pinned" && c.actor.type === "agent");
  assert.equal(pinned.length, 4);
  for (const c of pinned) {
    assert.deepEqual(c.projects, ["acme-app"], "every team credential is project-scoped");
    assert.ok(spec.members.includes(c.actor.on_behalf_of!), "pinned to a member");
    assert.ok(c.token.length >= 32);
  }
  assert.equal(new Set(creds.map((c) => c.token)).size, creds.length, "tokens are unique");
  const hook = creds.find((c) => c.actor.id === gitHookActorId("acme-app"))!;
  assert.equal(hook.trust, "assert");
  assert.deepEqual(hook.projects, ["acme-app"]);
  assert.deepEqual(hook.allowed_actors, [
    { type: "agent", id: "claude-code" }, { type: "agent", id: "codex" },
    { type: "human", id: "alice@acme.dev" }, { type: "human", id: "bob@acme.dev" },
  ]);
  const ci = creds.find((c) => c.actor.id === ciActorId("acme-app"))!;
  assert.deepEqual([ci.trust, ci.actor.type, ci.projects], ["pinned", "system", ["acme-app"]]);
  // The Worker's own schema accepts what we minted.
  assert.equal(parseCredentials(JSON.stringify(creds)).length, creds.length);
});

test("validateSpec rejects bad projects, emails, harnesses and non-https urls", () => {
  assert.throws(() => validateSpec({ ...spec, project: "Acme App" }), /lowercase/);
  assert.throws(() => validateSpec({ ...spec, members: ["not-an-email"] }), /email/);
  assert.throws(() => validateSpec({ ...spec, members: ["a@b.co", "a@b.co"] }), /duplicate/);
  assert.throws(() => validateSpec({ ...spec, harnesses: ["cursor" as any] }), /unknown harness/);
  assert.throws(() => validateSpec({ ...spec, url: "http://plain.example" }), /https/);
  assert.throws(() => validateSpec({ ...spec, members: [] }), /at least one/);
});

test("renderOnboarding: every member's tokens appear once each, under their own heading; hook and CI tokens included; honesty section present", () => {
  const plan = planTeam(spec, fakeRand());
  const doc = plan.onboarding;
  for (const c of plan.credentials) assert.equal(doc.split(c.token).length - 1, 1, `token for ${c.name} appears exactly once`);
  assert.ok(doc.indexOf("### alice@acme.dev") < doc.indexOf("### bob@acme.dev"));
  assert.match(doc, /RETRACE_ON_BEHALF_OF": "alice@acme.dev"/);
  assert.match(doc, /"credential": "retrace-git-acme-app"/);
  assert.match(doc, /retrace-git install --project acme-app/);
  assert.match(doc, /RETRACE_CI_TOKEN/);
  assert.match(doc, /Tamper-\*\*evident\*\*, not tamper-proof/);
  assert.doesNotMatch(doc, /RETRACE_ACTOR_MODEL": /, "the onboarding never pins a model");
});

test("appendCredentials writes atomically with mode 0600 and keeps existing entries; teamsIn groups by project", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-"));
  const file = join(dir, "worker-credentials.json");
  const existing = parseCredentials(JSON.stringify([{ token: "0123456789abcdef0123456789abcdef", actor: { type: "agent", id: "claude-code", on_behalf_of: "jordan@example.com" } }]));
  const added = planCredentials(spec, fakeRand());
  appendCredentials(file, existing, added);
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
  const back = readCredentialsFile(file);
  assert.equal(back.length, existing.length + added.length);
  assert.equal(back[0].token, existing[0].token, "existing credential preserved first");
  const teams = teamsIn(back);
  assert.deepEqual(Object.keys(teams).sort(), ["*", "acme-app"]);
  assert.equal(teams["acme-app"].length, added.length);
});

test("writeSecretFile atomically replaces an existing file and enforces mode 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-secret-"));
  const file = join(dir, "onboarding.md");
  writeFileSync(file, "old contents");
  chmodSync(file, 0o644);

  writeSecretFile(file, "new secret contents");

  assert.equal(readFileSync(file, "utf8"), "new secret contents");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("main new-team: dry run touches nothing; real run appends, writes onboarding 0600, and refuses a second set for the same project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-"));
  const file = join(dir, "creds.json");
  const onboarding = join(dir, "onboarding.md");
  const lines: string[] = [];
  const argv = ["new-team", "acme-app", "--member", "alice@acme.dev", "--harness", "claude-code", "--url", "https://retrace-api.example.workers.dev", "--credentials-file", file, "--out", onboarding];
  assert.equal(await main([...argv, "--dry-run"], {}, (s) => lines.push(s)), 0);
  assert.ok(!readCredentialsFile(file).length, "dry run wrote no credentials");
  assert.match(lines.join("\n"), /would add 3 credentials/);
  assert.equal(await main(argv, {}, (s) => lines.push(s)), 0);
  assert.equal(readCredentialsFile(file).length, 3);
  assert.equal(statSync(onboarding).mode & 0o777, 0o600);
  assert.match(readFileSync(onboarding, "utf8"), /# Retrace onboarding — team `acme-app`/);
  assert.match(lines.join("\n"), /wrangler secret put RETRACE_CREDENTIALS/);
  await assert.rejects(() => main(argv, {}, () => {}), /already holds credentials scoped to "acme-app"/);
  // list-teams reads the same file
  const listed: string[] = [];
  await main(["list-teams", "--credentials-file", file], {}, (s) => listed.push(s));
  assert.match(listed.join("\n"), /acme-app: 3 credentials · members alice@acme.dev/);
  // a malformed credentials file fails before anything is written
  writeFileSync(file, "[{\"token\":\"short\"}]");
  await assert.rejects(() => main(argv, {}, () => {}));
});

test("new-team defaults stay stable while OpenClaw is opt-in", async () => {
  assert.deepEqual(DEFAULT_HARNESSES, ["claude-code", "codex", "gemini", "grok", "github-copilot"]);
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-default-"));
  const file = join(dir, "creds.json");
  const output: string[] = [];
  await main(["new-team", "default-team", "--member", "alice@acme.dev", "--url", "https://retrace.example", "--credentials-file", file, "--dry-run"], {}, (line) => output.push(line));
  assert.match(output.join("\n"), /would add 7 credentials/);
  assert.doesNotMatch(output.join("\n"), /openclaw/);
});

test("add-agent appends one pinned OpenClaw credential and emits NemoClaw managed HTTP setup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-agent-"));
  const file = join(dir, "creds.json");
  const onboarding = join(dir, "openclaw.md");
  const base = planCredentials(spec, fakeRand());
  appendCredentials(file, [], base);

  const lines: string[] = [];
  const argv = ["add-agent", "acme-app", "--member", "alice@acme.dev", "--harness", "openclaw", "--url", "https://retrace.example", "--credentials-file", file, "--out", onboarding];
  assert.equal(await main(argv, {}, (line) => lines.push(line)), 0);
  const credentials = readCredentialsFile(file);
  const added = credentials.at(-1)!;
  assert.equal(credentials.length, base.length + 1);
  assert.deepEqual(added.actor, { type: "agent", id: "openclaw", on_behalf_of: "alice@acme.dev" });
  assert.deepEqual([added.trust, added.projects], ["pinned", ["acme-app"]]);
  const doc = readFileSync(onboarding, "utf8");
  assert.equal(doc.split(added.token).length - 1, 1);
  assert.match(doc, /nemoclaw <sandbox-name> mcp add retrace --url https:\/\/retrace\.example\/mcp --env RETRACE_MCP_TOKEN/);
  assert.match(doc, /runtime or sandbox is not a separate actor/);
  assert.match(doc, /does not claim producer signatures/);
  assert.equal(statSync(onboarding).mode & 0o777, 0o600);
  assert.match(lines.join("\n"), /wrangler secret put RETRACE_CREDENTIALS/);
  await assert.rejects(() => main(argv, {}, () => {}), /already holds an agent\/openclaw credential/);
});

test("add-agent validates a single member/harness and requires an existing project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-agent-invalid-"));
  const file = join(dir, "creds.json");
  await assert.rejects(() => main(["add-agent", "missing", "--member", "alice@acme.dev", "--harness", "openclaw", "--url", "https://retrace.example", "--credentials-file", file], {}, () => {}), /use new-team first/);
  await assert.rejects(() => main(["add-agent", "missing", "--member", "alice@acme.dev,bob@acme.dev", "--harness", "openclaw", "--url", "https://retrace.example", "--credentials-file", file], {}, () => {}), /usage/);
  assert.throws(() => planAgentCredential({ project: "acme-app", member: "alice@acme.dev", harness: "unknown" as any, url: "https://retrace.example" }), /unknown harness/);
  const cred = planAgentCredential({ project: "acme-app", member: "alice@acme.dev", harness: "openclaw", url: "https://retrace.example" }, fakeRand());
  assert.match(renderAgentOnboarding({ project: "acme-app", member: "alice@acme.dev", harness: "openclaw", url: "https://retrace.example" }, cred), /RETRACE_MCP_ENABLED=1/);
});
