import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseCredentials } from "@retrace-dev/core";
import { DEFAULT_HARNESSES, planAgentCredential, renderAgentOnboarding, planTeam, planCredentials, validateSpec, teamsIn, appendCredentials, writeSecretFile, readCredentialsFile, gitHookActorId, ciActorId, containingGitTree, defaultOnboardingFile, main, mintProducerKeys, producerKeyFileName, shouldMintProducerKey, findLivePinned, retireLivePinned, duplicateLivePinnedError, TeamSpec } from "./admin.js";

/** deterministic "randomness": counter-filled buffers, distinct per call */
const fakeRand = () => { let n = 0; return (len: number) => Buffer.alloc(len, ++n); };

const spec: TeamSpec = { project: "acme-app", members: ["alice@acme.dev", "bob@acme.dev"], harnesses: ["claude-code", "codex"], url: "https://retrace-api.example.workers.dev" };

test("mintProducerKeys: agents + hook get public_key and require_signature; CI and OpenClaw do not; private d never on the credential", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-keys-"));
  const withClaw = { ...spec, harnesses: ["claude-code", "openclaw"] as TeamSpec["harnesses"] };
  const creds = planCredentials(withClaw, fakeRand());
  const minted = await mintProducerKeys(creds, dir);
  const parsed = parseCredentials(JSON.stringify(minted));
  assert.equal(parsed.length, minted.length, "Worker schema accepts minted credentials (producer_key_file stripped)");
  for (const c of minted) {
    if (shouldMintProducerKey(c)) {
      assert.equal(c.require_signature, true, c.name);
      assert.ok(c.public_key?.x, c.name);
      assert.equal("d" in (c.public_key ?? {}), false, "private half must not sit on the credential");
      assert.ok(c.producer_key_file && existsSync(c.producer_key_file));
      assert.equal(statSync(c.producer_key_file!).mode & 0o777, 0o600);
      const priv = JSON.parse(readFileSync(c.producer_key_file!, "utf8"));
      assert.ok(priv.d, "private file holds d");
    } else {
      assert.equal(c.public_key, undefined, c.name);
      assert.equal(c.require_signature, undefined, c.name);
      assert.equal(c.producer_key_file, undefined, c.name);
    }
  }
  assert.equal(minted.filter((c) => c.require_signature).length, 3, "alice+bob claude-code + hook; not openclaw, not CI");
  const ci = minted.find((c) => c.actor.id === ciActorId("acme-app"))!;
  const claw = minted.find((c) => c.actor.id === "openclaw")!;
  assert.equal(ci.require_signature, undefined);
  assert.equal(claw.require_signature, undefined);
});

test("producer keys are project-scoped and an existing private key is never overwritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-project-keys-"));
  const first = planAgentCredential({ project: "project-a", member: "alice@example.com", harness: "nooa", url: "https://retrace.example" }, fakeRand());
  const second = planAgentCredential({ project: "project-b", member: "alice@example.com", harness: "nooa", url: "https://retrace.example" }, fakeRand());
  assert.notEqual(producerKeyFileName(first), producerKeyFileName(second));
  assert.match(producerKeyFileName(first), /^project-a--nooa-alice-example\.com\.jwk$/);

  const [mintedFirst] = await mintProducerKeys([first], dir);
  const originalBytes = readFileSync(mintedFirst.producer_key_file!);
  const [mintedSecond] = await mintProducerKeys([second], dir);
  assert.notEqual(mintedFirst.producer_key_file, mintedSecond.producer_key_file);
  assert.deepEqual(readFileSync(mintedFirst.producer_key_file!), originalBytes);
  await assert.rejects(() => mintProducerKeys([first], dir), /refusing to overwrite existing producer key/);
});

test("planCredentials: one pinned credential per member×harness, scoped to the project; assert hook bounded to the team; CI reader", () => {
  const creds = planCredentials(spec, fakeRand());
  assert.equal(creds.length, 2 * 2 + 2);
  const pinned = creds.filter((c) => c.trust === "pinned" && c.actor.type === "agent");
  assert.equal(pinned.length, 4);
  for (const c of pinned) {
    assert.deepEqual(c.projects, ["acme-app"], "every team credential is project-scoped");
    assert.ok(spec.members.includes(c.actor.on_behalf_of!), "pinned to a member");
    assert.deepEqual(c.principal, { type: "human", id: c.actor.on_behalf_of });
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
  assert.deepEqual(hook.principal, { type: "team", id: "acme-app" });
  assert.deepEqual(ci.principal, { type: "team", id: "acme-app" });
  assert.deepEqual([ci.trust, ci.actor.type, ci.projects], ["assert", "system", ["acme-app"]]);
  assert.deepEqual(ci.allowed_actors, []);
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
  assert.match(doc, /trust `assert` and `allowed_actors: \[\]`/);
  assert.match(doc, /cannot POST `\/events`/);
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

test("writeSecretFile creates a missing private parent directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-secret-parent-"));
  const parent = join(dir, "private");
  const file = join(parent, "onboarding.md");

  writeSecretFile(file, "secret contents");

  assert.equal(readFileSync(file, "utf8"), "secret contents");
  assert.equal(statSync(parent).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("secret onboarding paths default to ~/.retrace and explicit Git-tree destinations are detectable", () => {
  assert.equal(defaultOnboardingFile("onboarding-acme.md"), join(homedir(), ".retrace", "onboarding-acme.md"));
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-git-tree-"));
  mkdirSync(join(dir, ".git"));
  assert.equal(containingGitTree(join(dir, "nested", "onboarding.md")), dir);
});

test("main new-team: dry run touches nothing; real run appends, writes onboarding 0600, and refuses a second set for the same project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-"));
  const file = join(dir, "creds.json");
  const onboarding = join(dir, "onboarding.md");
  const keysDir = join(dir, "producer-keys");
  const lines: string[] = [];
  const argv = ["new-team", "acme-app", "--member", "alice@acme.dev", "--harness", "claude-code", "--url", "https://retrace-api.example.workers.dev", "--credentials-file", file, "--out", onboarding, "--producer-keys-dir", keysDir];
  assert.equal(await main([...argv, "--dry-run"], {}, (s) => lines.push(s)), 0);
  assert.ok(!readCredentialsFile(file).length, "dry run wrote no credentials");
  assert.match(lines.join("\n"), /would add 3 credentials/);
  assert.equal(await main(argv, {}, (s) => lines.push(s)), 0);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw.length, 3);
  const agent = raw.find((c: { actor: { type: string } }) => c.actor.type === "agent");
  const hook = raw.find((c: { actor: { id: string } }) => String(c.actor.id).startsWith("retrace-git-"));
  const ci = raw.find((c: { actor: { id: string } }) => String(c.actor.id).startsWith("ci-"));
  assert.equal(agent.require_signature, true);
  assert.equal(hook.require_signature, true);
  assert.equal(ci.require_signature, undefined);
  assert.ok(agent.producer_key_file);
  assert.equal("d" in (agent.public_key ?? {}), false);
  assert.equal(parseCredentials(JSON.stringify(raw)).length, 3);
  assert.equal("producer_key_file" in parseCredentials(JSON.stringify(raw))[0], false, "Worker schema strips producer_key_file");
  const doc = readFileSync(onboarding, "utf8");
  assert.match(doc, /RETRACE_PRODUCER_KEY_FILE/);
  assert.doesNotMatch(doc, /"d":\s*"/, "onboarding never prints a private JWK");
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
  assert.match(output.join("\n"), new RegExp(defaultOnboardingFile("onboarding-default-team.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(output.join("\n"), /openclaw/);
});

test("an explicit --out inside a Git worktree emits a live-token warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-out-warning-"));
  mkdirSync(join(dir, ".git"));
  const output: string[] = [];
  await main([
    "new-team", "warn-team", "--member", "alice@acme.dev", "--harness", "codex",
    "--url", "https://retrace.example", "--credentials-file", join(dir, "creds.json"),
    "--out", join(dir, "private", "onboarding.md"), "--dry-run",
  ], {}, (line) => output.push(line));
  assert.match(output.join("\n"), /WARNING: .* is inside Git worktree .* contains live tokens/);
});

test("add-agent appends one pinned OpenClaw credential and emits NemoClaw managed HTTP setup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-agent-"));
  const file = join(dir, "creds.json");
  const onboarding = join(dir, "openclaw.md");
  const keysDir = join(dir, "producer-keys");
  const base = planCredentials(spec, fakeRand());
  appendCredentials(file, [], base);

  const lines: string[] = [];
  const baseArgv = ["add-agent", "acme-app", "--member", "alice@acme.dev", "--harness", "openclaw", "--url", "https://retrace.example", "--credentials-file", file, "--producer-keys-dir", keysDir];
  const argv = [...baseArgv, "--out", onboarding];
  const defaultLines: string[] = [];
  assert.equal(await main([...baseArgv, "--dry-run"], {}, (line) => defaultLines.push(line)), 0);
  assert.match(defaultLines.join("\n"), new RegExp(defaultOnboardingFile("onboarding-acme-app-openclaw.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(await main(argv, {}, (line) => lines.push(line)), 0);
  const credentials = readCredentialsFile(file);
  const added = credentials.at(-1)!;
  assert.equal(credentials.length, base.length + 1);
  assert.deepEqual(added.actor, { type: "agent", id: "openclaw", on_behalf_of: "alice@acme.dev" });
  assert.deepEqual([added.trust, added.projects], ["pinned", ["acme-app"]]);
  assert.equal(added.public_key, undefined);
  assert.equal(added.require_signature, undefined);
  assert.equal(added.producer_key_file, undefined);
  const doc = readFileSync(onboarding, "utf8");
  assert.equal(doc.split(added.token).length - 1, 1);
  assert.match(doc, /nemoclaw <sandbox-name> mcp add retrace --url https:\/\/retrace\.example\/mcp --env RETRACE_MCP_TOKEN/);
  assert.match(doc, /runtime or sandbox is not a separate actor/);
  assert.match(doc, /does not claim producer signatures/);
  assert.equal(statSync(onboarding).mode & 0o777, 0o600);
  assert.match(lines.join("\n"), /wrangler secret put RETRACE_CREDENTIALS/);
  await assert.rejects(() => main(argv, {}, () => {}), /refusing to mint a second live pinned agent\/openclaw/);
});

test("add-agent nooa: unlike openclaw, gets a producer key and a stdio retrace-mcp entry that signs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-nooa-"));
  const file = join(dir, "creds.json");
  const onboarding = join(dir, "nooa.md");
  const keysDir = join(dir, "producer-keys");
  appendCredentials(file, [], planCredentials(spec, fakeRand()));

  const lines: string[] = [];
  const argv = ["add-agent", "acme-app", "--member", "alice@acme.dev", "--harness", "nooa", "--url", "https://retrace.example", "--credentials-file", file, "--producer-keys-dir", keysDir, "--out", onboarding];
  assert.equal(await main(argv, {}, (line) => lines.push(line)), 0);
  const added = readCredentialsFile(file).at(-1)!;
  assert.deepEqual(added.actor, { type: "agent", id: "nooa", on_behalf_of: "alice@acme.dev" });
  assert.deepEqual([added.trust, added.projects], ["pinned", ["acme-app"]]);
  // nooa is a real producer: it signs, so it carries a public key + require_signature + a local private-key path
  assert.equal(added.require_signature, true);
  assert.ok(added.public_key?.x);
  assert.equal("d" in (added.public_key ?? {}), false, "private half must not sit on the credential");
  assert.ok(added.producer_key_file && existsSync(added.producer_key_file));
  const doc = readFileSync(onboarding, "utf8");
  assert.match(doc, /NVIDIA Labs Object-Oriented Agents, research preview/);
  assert.match(doc, /RETRACE_PRODUCER_KEY_FILE/);
  assert.match(doc, /retrace-mcp/);
  assert.doesNotMatch(doc, /does not claim producer signatures/);
});

test("add-agent validates a single member/harness and requires an existing project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-agent-invalid-"));
  const file = join(dir, "creds.json");
  await assert.rejects(() => main(["add-agent", "missing", "--member", "alice@acme.dev", "--harness", "openclaw", "--url", "https://retrace.example", "--credentials-file", file], {}, () => {}), /use new-team first/);
  await assert.rejects(() => main(["add-agent", "missing", "--member", "alice@acme.dev,bob@acme.dev", "--harness", "openclaw", "--url", "https://retrace.example", "--credentials-file", file], {}, () => {}), /usage/);
  assert.throws(() => planAgentCredential({ project: "acme-app", member: "alice@acme.dev", harness: "unknown" as any, url: "https://retrace.example" }), /unknown harness/);
  const cred = planAgentCredential({ project: "acme-app", member: "alice@acme.dev", harness: "openclaw", url: "https://retrace.example" }, fakeRand());
  assert.deepEqual(cred.principal, { type: "human", id: "alice@acme.dev" });
  assert.match(renderAgentOnboarding({ project: "acme-app", member: "alice@acme.dev", harness: "openclaw", url: "https://retrace.example" }, cred), /RETRACE_MCP_ENABLED=1/);
});

test("issuance guard: a second live pinned credential for the same {project, type, id} is refused even for another member", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-dup-pin-"));
  const file = join(dir, "creds.json");
  const keysDir = join(dir, "producer-keys");
  appendCredentials(file, [], planCredentials(spec, fakeRand()));
  const live = findLivePinned(readCredentialsFile(file), "acme-app", { type: "agent", id: "codex" });
  assert.ok(live);
  assert.match(duplicateLivePinnedError("acme-app", { type: "agent", id: "codex" }, live!), /second live pinned agent\/codex/);
  await assert.rejects(
    () => main(["add-agent", "acme-app", "--member", "carol@acme.dev", "--harness", "codex", "--url", "https://retrace.example", "--credentials-file", file, "--producer-keys-dir", keysDir], {}, () => {}),
    /refusing to mint a second live pinned agent\/codex/,
  );
  assert.equal(readCredentialsFile(file).filter((c) => c.actor.id === "codex" && !c.retired_at).length, 2, "alice+bob from new-team unchanged");
});

test("issuance guard: retire-agent then add-agent for a different principal is refused (T29); conflicting historical bindings fail closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-retire-"));
  const file = join(dir, "creds.json");
  const keysDir = join(dir, "producer-keys");
  appendCredentials(file, [], planCredentials(spec, fakeRand()));

  await assert.rejects(
    () => main(["add-agent", "acme-app", "--member", "alice@acme.dev", "--harness", "codex", "--url", "https://retrace.example", "--credentials-file", file, "--producer-keys-dir", keysDir], {}, () => {}),
    /refusing to mint a second live pinned agent\/codex/,
  );

  const dry: string[] = [];
  assert.equal(await main(["retire-agent", "acme-app", "--harness", "codex", "--credentials-file", file, "--dry-run"], {}, (s) => dry.push(s)), 0);
  assert.match(dry.join("\n"), /would retire/);
  assert.ok(findLivePinned(readCredentialsFile(file), "acme-app", { type: "agent", id: "codex" }), "dry-run does not retire");

  const lines: string[] = [];
  assert.equal(await main(["retire-agent", "acme-app", "--harness", "codex", "--credentials-file", file], {}, (s) => lines.push(s)), 0);
  assert.match(lines.join("\n"), /retired 2 live pinned agent\/codex/);
  assert.equal(findLivePinned(readCredentialsFile(file), "acme-app", { type: "agent", id: "codex" }), undefined);
  assert.ok(readCredentialsFile(file).some((c) => c.actor.id === "codex" && c.retired_at));

  await assert.rejects(
    () => main(["add-agent", "acme-app", "--member", "carol@acme.dev", "--harness", "codex", "--url", "https://retrace.example", "--credentials-file", file, "--producer-keys-dir", keysDir], {}, () => {}),
    /originally bound to human\/alice@acme\.dev, human\/bob@acme\.dev/,
  );
  await assert.rejects(
    () => main(["add-agent", "acme-app", "--member", "alice@acme.dev", "--harness", "codex", "--url", "https://retrace.example", "--credentials-file", file, "--producer-keys-dir", keysDir], {}, () => {}),
    /originally bound to human\/alice@acme\.dev, human\/bob@acme\.dev/,
    "alice+bob both bound agent/codex — reissue to either fails closed",
  );
});

test("T29: retire-agent then add-agent of the same principal is allowed; a different principal is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-t29-"));
  const file = join(dir, "creds.json");
  const keysDir = join(dir, "producer-keys");
  const one: TeamSpec = { project: "acme-app", members: ["alice@acme.dev"], harnesses: ["codex"], url: "https://retrace.example" };
  appendCredentials(file, [], planCredentials(one, fakeRand()));
  assert.equal(await main(["retire-agent", "acme-app", "--harness", "codex", "--credentials-file", file], {}, () => {}), 0);

  await assert.rejects(
    () => main(["add-agent", "acme-app", "--member", "bob@acme.dev", "--harness", "codex", "--url", "https://retrace.example", "--credentials-file", file, "--producer-keys-dir", keysDir], {}, () => {}),
    /originally bound to human\/alice@acme\.dev/,
  );
  assert.equal(findLivePinned(readCredentialsFile(file), "acme-app", { type: "agent", id: "codex" }), undefined);

  assert.equal(await main(["add-agent", "acme-app", "--member", "alice@acme.dev", "--harness", "codex", "--url", "https://retrace.example", "--credentials-file", file, "--producer-keys-dir", keysDir, "--out", join(dir, "alice.md")], {}, () => {}), 0);
  const added = readCredentialsFile(file).at(-1)!;
  assert.deepEqual(added.actor, { type: "agent", id: "codex", on_behalf_of: "alice@acme.dev" });
  assert.deepEqual(added.principal, { type: "human", id: "alice@acme.dev" });
  assert.equal(added.retired_at, undefined);
  assert.ok(findLivePinned(readCredentialsFile(file), "acme-app", { type: "agent", id: "codex" }));
});

test("set-principal fills a missing principal once and never overwrites; does not guess from on_behalf_of", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-set-principal-"));
  const file = join(dir, "creds.json");
  appendCredentials(file, [], [{
    token: "legacy-token-0123456789abcd",
    name: "legacy codex",
    actor: { type: "agent", id: "codex", on_behalf_of: "alice@acme.dev" },
    trust: "pinned",
    projects: ["acme-app"],
  }]);
  assert.equal(readCredentialsFile(file)[0]!.principal, undefined);

  const dry: string[] = [];
  assert.equal(await main(["set-principal", "acme-app", "--actor", "agent/codex", "--principal", "human/alice@acme.dev", "--credentials-file", file, "--dry-run"], {}, (s) => dry.push(s)), 0);
  assert.match(dry.join("\n"), /would set principal human\/alice@acme\.dev/);
  assert.equal(readCredentialsFile(file)[0]!.principal, undefined, "dry-run does not write");

  const lines: string[] = [];
  assert.equal(await main(["set-principal", "acme-app", "--actor", "agent/codex", "--principal", "human/alice@acme.dev", "--credentials-file", file], {}, (s) => lines.push(s)), 0);
  assert.deepEqual(readCredentialsFile(file)[0]!.principal, { type: "human", id: "alice@acme.dev" });

  const again: string[] = [];
  assert.equal(await main(["set-principal", "acme-app", "--actor", "agent/codex", "--principal", "human/alice@acme.dev", "--credentials-file", file], {}, (s) => again.push(s)), 0);
  assert.match(again.join("\n"), /already has principal/);

  await assert.rejects(
    () => main(["set-principal", "acme-app", "--actor", "agent/codex", "--principal", "human/bob@acme.dev", "--credentials-file", file], {}, () => {}),
    /already bound to human\/alice@acme\.dev/,
  );
});

test("retireLivePinned throws when nothing live covers the project", () => {
  assert.throws(() => retireLivePinned([], "acme-app", { type: "agent", id: "codex" }, "2026-09-08T00:00:00.000Z"), /no live pinned agent\/codex/);
});

test("new-team refuses a batch that would bind one actor id to two principals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-batch-"));
  const file = join(dir, "creds.json");
  await assert.rejects(
    () => main(["new-team", "acme-app", "--member", "alice@acme.dev,bob@acme.dev", "--harness", "codex", "--url", "https://retrace.example", "--credentials-file", file, "--dry-run"], {}, () => {}),
    /multiple principals in this batch/,
  );
  assert.equal(existsSync(file) ? readCredentialsFile(file).length : 0, 0);
});

test("add-agent refuses an unknown historical principal until set-principal; then Alice rotates and Bob is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-unknown-history-"));
  const file = join(dir, "creds.json");
  const keysDir = join(dir, "producer-keys");
  const one: TeamSpec = { project: "acme-app", members: ["alice@acme.dev"], harnesses: ["codex"], url: "https://retrace.example" };
  const minted = planCredentials(one, fakeRand());
  const stripped = minted.map((c) => c.actor.id === "codex" ? { ...c, principal: undefined } : c);
  appendCredentials(file, [], stripped);
  assert.equal(await main(["retire-agent", "acme-app", "--harness", "codex", "--credentials-file", file], {}, () => {}), 0);

  await assert.rejects(
    () => main(["add-agent", "acme-app", "--member", "bob@acme.dev", "--harness", "codex", "--url", "https://retrace.example", "--credentials-file", file, "--producer-keys-dir", keysDir], {}, () => {}),
    /have no principal/,
  );
  await assert.rejects(
    () => main(["add-agent", "acme-app", "--member", "alice@acme.dev", "--harness", "codex", "--url", "https://retrace.example", "--credentials-file", file, "--producer-keys-dir", keysDir], {}, () => {}),
    /set-principal/,
  );

  assert.equal(await main(["set-principal", "acme-app", "--actor", "agent/codex", "--principal", "human/alice@acme.dev", "--credentials-file", file], {}, () => {}), 0);
  await assert.rejects(
    () => main(["add-agent", "acme-app", "--member", "bob@acme.dev", "--harness", "codex", "--url", "https://retrace.example", "--credentials-file", file, "--producer-keys-dir", keysDir], {}, () => {}),
    /originally bound to human\/alice@acme\.dev/,
  );
  assert.equal(await main(["add-agent", "acme-app", "--member", "alice@acme.dev", "--harness", "codex", "--url", "https://retrace.example", "--credentials-file", file, "--producer-keys-dir", keysDir, "--out", join(dir, "alice.md")], {}, () => {}), 0);
  assert.deepEqual(readCredentialsFile(file).at(-1)!.principal, { type: "human", id: "alice@acme.dev" });
});

test("set-principal refuses an assignment that conflicts with established history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-admin-set-conflict-"));
  const file = join(dir, "creds.json");
  appendCredentials(file, [], [
    {
      token: "alice-token-0123456789abcd",
      name: "alice-codex",
      actor: { type: "agent", id: "codex", on_behalf_of: "alice@acme.dev" },
      trust: "pinned",
      projects: ["acme-app"],
      principal: { type: "human", id: "alice@acme.dev" },
      retired_at: "2026-09-01T00:00:00.000Z",
    },
    {
      token: "bob-token-0123456789abcdef",
      name: "bob-codex",
      actor: { type: "agent", id: "codex", on_behalf_of: "bob@acme.dev" },
      trust: "pinned",
      projects: ["acme-app"],
    },
  ]);
  await assert.rejects(
    () => main(["set-principal", "acme-app", "--actor", "agent/codex", "--principal", "human/bob@acme.dev", "--on-behalf-of", "bob@acme.dev", "--credentials-file", file], {}, () => {}),
    /already bound to human\/alice@acme\.dev/,
  );
  assert.equal(readCredentialsFile(file).find((c) => c.actor.on_behalf_of === "bob@acme.dev")!.principal, undefined);
});

test("P6: set-policy refuses declared-project mismatch; --cross-project-copy prints; preview ≠ digest; basename hint", async () => {
  const { proposeSetPolicy } = await import("./admin.js");
  const dir = mkdtempSync(join(tmpdir(), "retrace-set-policy-"));
  const cfg = join(dir, ".retrace.json");
  writeFileSync(cfg, JSON.stringify({
    project: "other",
    reconcile: { hook_sealed_by: ["assert:git hook (assert)"] },
    attribution: { repositories: [{ name: "acme/app", aliases: ["app"] }] },
  }));
  const refused = await proposeSetPolicy({ project: "demo", fromPath: cfg, ifMatch: "none" });
  assert.match(refused.printed, /refused/);
  assert.equal(refused.body, undefined);
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ routing: [{ repo: "acme/demo", source: "env_fallback" }] }), { status: 200 });
  const copied = await proposeSetPolicy({
    project: "demo", fromPath: cfg, ifMatch: "none", crossProjectCopy: true,
    url: "https://worker.example", token: "tok", fetchImpl,
  });
  assert.match(copied.printed, /--cross-project-copy/);
  assert.match(copied.printed, /body_preview_sha256/);
  assert.match(copied.printed, /settings-only preview, not the policy digest/);
  assert.equal(copied.body?.unresolved_claims, "record");
  assert.deepEqual(copied.body?.github_repos, ["acme/demo"]);
  const unnamed = join(dir, "repo", ".retrace.json");
  mkdirSync(join(dir, "repo"));
  writeFileSync(unnamed, JSON.stringify({ reconcile: { hook_sealed_by: ["assert:x"] } }));
  const hint = await proposeSetPolicy({
    project: "demo", fromPath: unnamed, ifMatch: "none",
    url: "https://worker.example", token: "tok", fetchImpl,
  });
  assert.match(hint.printed, /basename hint only/);
  assert.ok(copied.body);
  const { bodyPreviewSha256, policyDigestOf, validatePolicyEnvelope } = await import("@retrace-dev/core");
  const preview = await bodyPreviewSha256(copied.body!);
  const fakeEnv = validatePolicyEnvelope({
    version: 1, created_at: "2026-09-10T03:45:00.000Z", set_by: { type: "human", id: "o" },
    supersedes: null, activation: { event_id: "evt_x", seq: 0 },
  });
  const digest = await policyDigestOf(copied.body!, fakeEnv);
  assert.notEqual(preview, digest);
  const noUrl = await proposeSetPolicy({ project: "demo", fromPath: unnamed, ifMatch: "none" });
  assert.match(noUrl.printed, /Worker|url and a token/i);
  assert.equal(noUrl.refused, "worker mapping unavailable");
  const badFetch: typeof fetch = async () => new Response("nope", { status: 503 });
  const unavail = await proposeSetPolicy({
    project: "demo", fromPath: unnamed, ifMatch: "none",
    url: "https://worker.example", token: "tok", fetchImpl: badFetch,
  });
  assert.equal(unavail.refused, "worker mapping unavailable");
});
