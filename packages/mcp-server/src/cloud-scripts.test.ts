import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const guard = resolve(root, "scripts/cloud/guard-push-main.sh");
const setup = resolve(root, "scripts/cloud/setup.sh");

function runGuard(cwd: string, command: string, cloud = true) {
  return spawnSync(guard, {
    cwd,
    env: { ...process.env, ...(cloud ? { CLAUDE_CODE_REMOTE: "true" } : { CLAUDE_CODE_REMOTE: "" }) },
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
  });
}

test("T11 push guard refuses main forms only in cloud sessions", () => {
  chmodSync(guard, 0o755);
  const repo = mkdtempSync(resolve(tmpdir(), "retrace-cloud-guard-"));
  const shapeMessage = "refused: a cloud session pushes only 'git push [-u] [--force-with-lease] <remote> <branch>:refs/heads/<branch>' to a non-main branch (docs/design/cloud-seat.md §6)";
  const unresolvedMessage = "refused: cannot resolve the push destination without evaluating the command";
  const assertAllowed = (command: string, cloud = true) => {
    const result = runGuard(repo, command, cloud);
    assert.equal(result.status, 0, command);
    assert.equal(result.stderr, "", command);
  };
  const assertRefused = (command: string, message = shapeMessage) => {
    const result = runGuard(repo, command);
    assert.equal(result.status, 2, command);
    assert.equal(result.stderr.trim(), message, command);
  };
  try {
    const allowedPushCommands = [
      "git push origin feature/x:refs/heads/feature/x",
      "git push -u origin feature/x:refs/heads/feature/x",
      "git push --set-upstream origin feature/x:refs/heads/feature/x",
      "git push --force-with-lease origin feature/x:refs/heads/feature/x",
      "git push --force-with-lease=feature/x:0123abc origin feature/x:refs/heads/feature/x",
      "git push --force-with-lease=refs/heads/feature/x:0123abc origin feature/x:refs/heads/feature/x",
      "git push -u --force-with-lease origin feature/x:refs/heads/feature/x",
      "git push --force-with-lease --set-upstream origin feature/x:refs/heads/feature/x",
      "git push origin \"feature/x:refs/heads/feature/x\"",
      "git push upstream topic:refs/heads/topic",
    ];
    const startedAt = performance.now();
    assertAllowed(allowedPushCommands[0]);
    assert.ok(performance.now() - startedAt < 500, allowedPushCommands[0]);

    for (const command of allowedPushCommands.slice(1)) assertAllowed(command);
    for (const command of ["echo hello", "gh pr merge"]) assertAllowed(command);
    assertAllowed("git push origin main", false);

    for (const command of [
      "git push",
      "git push origin",
      "git push origin main",
      "git push origin HEAD:main",
      "git push origin HEAD:feature/x",
      "git push origin HEAD",
      "git push origin HEAD:refs/heads/HEAD",
      "git push origin refs/heads/main",
      "git push origin refs/heads/feature/x",
      "git push origin heads/main",
      "git push origin +feature/x",
      "git push origin +main",
      "git push origin :main",
      "git push origin :",
      "git push origin +:",
      "git push origin HEAD:refs/heads/main",
      "git push --all origin",
      "git push --mirror origin",
      "git push --tags origin",
      "git push origin HEAD:heads/main",
      "git push origin feature/main",
      "git push origin feature/x",
      "git push -u origin feature/x",
      "git push --set-upstream origin feature/x",
      "git push --force-with-lease origin feature/x",
      "git push --force-with-lease=feature/x:0123abc origin feature/x",
      "git push -u --force-with-lease origin feature/x",
      "git push --force-with-lease --set-upstream origin feature/x",
      "git push origin feature.x-1",
      "git push origin \"feature/x\"",
      "git push upstream topic",
      "git push origin feature/cloud",
      "git push origin feature/x:refs/heads/feature/y",
      "git push origin feature/x:feature/x",
      "git push origin feature/x:refs/heads/main",
      "git push origin main:refs/heads/main",
      "git push origin Main:refs/heads/Main",
      "git push origin MAIN:refs/heads/MAIN",
      "git push origin x/Main:refs/heads/x/Main",
      "git push origin refs/heads/feature/x:refs/heads/feature/x",
      "git push origin +feature/x:refs/heads/feature/x",
      "git push --force-with-lease=main:0123abc origin feature/x:refs/heads/feature/x",
      "git push --repo origin HEAD:main",
      "git push --repo=origin HEAD:main",
      "git push --repo origin feature/x",
      "git push --repo=origin feature/x",
      "git push --force origin feature/x",
      "git push -f origin feature/x",
      "git push -o x origin feature/x",
      "git push origin feature/x main",
      "git push origin main feature/x",
      "git push -u origin main",
      "git push --force-with-lease origin main",
      "git push -u --set-upstream origin feature/x",
      "git push --force-with-lease --force-with-lease origin feature/x",
      "git push --force-with-lease= origin feature/x",
      "git push /tmp/origin feature/x",
      "git push origin \"HEAD:main\"",
      "git push origin 'main'",
      "git push origin \"refs/heads/main\"",
      "git push origin HEAD\\:main",
      "git -C . push origin HEAD:main",
      "git -C . push origin feature/x",
      `git -C ${repo} push origin main`,
      `git -C ${repo} push`,
      "env git push origin HEAD:main",
      "env git push origin feature/x",
      "env FOO=1 git push origin main",
      "env FOO=1 git push origin feature/x",
      "FOO=1 git push origin main",
      "FOO=1 git push origin feature/x",
      "git -c push.default=current push origin main",
      "git -c push.default=current push origin feature/x",
      "git -P push origin feature/x",
      "git --paginate push origin feature/x",
      "git --no-optional-locks push origin feature/x",
      "git --no-pager push origin main",
      "git --no-pager push origin feature/x",
      "time git push origin feature/x",
      "command git push origin feature/x",
      "exec git push origin feature/x",
      "nice git push origin feature/x",
      "nohup git push origin feature/x",
      "(git push origin feature/x)",
      "{ git push origin feature/x; }",
      "/usr/bin/git push origin feature/x",
      "echo start && git push origin main",
      "echo start && git push origin feature/x",
      "echo start & git push origin main",
      "echo start & git push origin feature/x",
      "echo start |& git push origin main",
      "echo start |& git push origin feature/x",
      "git fetch origin; git push origin HEAD:main",
      "git fetch origin; git push origin feature/x",
      "git push origin feature/x && git push origin main",
      "git push origin feature/x && echo done",
      "git push origin feature/x >/dev/null",
      "git push origin feature/x 2>&1",
      ">/dev/null git push origin feature/x",
      "git push origin HEAD:main>/dev/null",
      "echo main && git push origin feature/x",
    ]) assertRefused(command);

    for (const command of [
      "git push origin \"feature/x",
      "git push origin feature\\",
    ]) assertRefused(command, unresolvedMessage);

    for (const command of [
      "git push origin $BRANCH",
      "git push origin $(cat x)",
      "git push origin ~x",
      "git push origin feature/*",
      "git push origin HEAD:`cat x`",
      "git push \"$R\" main",
    ]) assertRefused(command);

    const bare = resolve(repo, "remote.git");
    const clone = resolve(repo, "clone");
    const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(git(repo, ["init", "--bare", "-q", bare]).status, 0, "init bare remote");
    assert.equal(git(repo, ["init", "-q", "-b", "main", clone]).status, 0, "init clone");
    assert.equal(git(clone, [
      "-c", "user.name=Cloud Guard Test",
      "-c", "user.email=cloud-guard@example.test",
      "commit", "--allow-empty", "-q", "-m", "initial",
    ]).status, 0, "initial commit");
    assert.equal(git(clone, ["remote", "add", "origin", bare]).status, 0, "add origin");
    assert.equal(git(clone, ["remote", "add", "upstream", bare]).status, 0, "add upstream");
    assert.equal(git(clone, ["push", "-q", "origin", "main"]).status, 0, "seed remote main");
    for (const branch of ["feature/x", "topic"]) {
      assert.equal(git(clone, ["branch", branch]).status, 0, branch);
    }
    const remoteRef = (ref: string) => {
      const result = git(repo, ["--git-dir", bare, "rev-parse", ref]);
      assert.equal(result.status, 0, ref);
      return result.stdout.trim();
    };

    for (const command of allowedPushCommands) {
      assert.equal(runGuard(clone, command).status, 0, command);
      const mainBefore = remoteRef("refs/heads/main");
      const pushed = spawnSync("sh", ["-c", command], { cwd: clone, encoding: "utf8" });
      if (command.includes(":0123abc")) assert.notEqual(pushed.status, 0, command);
      else assert.equal(pushed.status, 0, `${command}: ${pushed.stderr}`);
      assert.equal(remoteRef("refs/heads/main"), mainBefore, command);
    }

    assert.equal(git(clone, ["config", "remote.origin.push", "refs/heads/feature/x:refs/heads/main"]).status, 0, "configured push refspec");
    assert.equal(git(clone, ["checkout", "-q", "feature/x"]).status, 0, "checkout feature/x");
    assert.equal(git(clone, [
      "-c", "user.name=Cloud Guard Test",
      "-c", "user.email=cloud-guard@example.test",
      "commit", "--allow-empty", "-q", "-m", "feature update",
    ]).status, 0, "feature commit");
    const configuredCommand = "git push origin feature/x:refs/heads/feature/x";
    assert.equal(runGuard(clone, configuredCommand).status, 0, configuredCommand);
    const configuredMainBefore = remoteRef("refs/heads/main");
    const configuredFeatureBefore = remoteRef("refs/heads/feature/x");
    const configuredPush = spawnSync("sh", ["-c", configuredCommand], { cwd: clone, encoding: "utf8" });
    assert.equal(configuredPush.status, 0, `${configuredCommand}: ${configuredPush.stderr}`);
    assert.equal(remoteRef("refs/heads/main"), configuredMainBefore, configuredCommand);
    assert.notEqual(remoteRef("refs/heads/feature/x"), configuredFeatureBefore, configuredCommand);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("T13 setup script reports its own sha256 and contains no token-shaped run", () => {
  chmodSync(setup, 0o755);
  const bytes = readFileSync(setup);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const result = spawnSync(setup, ["--print-sha256"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), `setup_sha256=${expected}`);
  assert.doesNotMatch(bytes.toString("utf8"), /[A-Za-z0-9_-]{43}/);
});

test("cloud MCP configuration and wrapper carry no credential material", () => {
  const config = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8"));
  assert.deepEqual(config, {
    mcpServers: {
      "retrace-cloud": {
        type: "http",
        url: "https://retrace-api.slcwitit.workers.dev/mcp",
      },
    },
  });

  const wrapper = readFileSync(resolve(root, "scripts/cloud/retrace-mcp-cloud.sh"), "utf8");
  assert.match(wrapper, /KEY\\\|TOKEN\\\|SECRET/);
  assert.match(wrapper, /unset RETRACE_CREDENTIALS RETRACE_CREDENTIALS_EXTRA RETRACE_CREDENTIALS_FILE/);
  assert.doesNotMatch(wrapper, /Authorization|Bearer/);

  const settings = JSON.parse(readFileSync(resolve(root, ".claude/settings.json"), "utf8"));
  assert.deepEqual(settings.hooks.PreToolUse, [{
    matcher: "Bash",
    hooks: [{
      type: "command",
      command: "\"$CLAUDE_PROJECT_DIR\"/scripts/cloud/guard-push-main.sh",
    }],
  }]);
});

test("cloud MCP wrapper is inert locally and strips ambient credentials remotely", () => {
  const wrapper = resolve(root, "scripts/cloud/retrace-mcp-cloud.sh");
  chmodSync(wrapper, 0o755);
  const local = spawnSync(wrapper, [], {
    env: { ...process.env, CLAUDE_CODE_REMOTE: "" },
    encoding: "utf8",
  });
  assert.equal(local.status, 0);
  assert.equal(local.stdout, "");
  assert.equal(local.stderr, "");

  const bin = mkdtempSync(resolve(tmpdir(), "retrace-cloud-mcp-"));
  try {
    const fake = resolve(bin, "retrace-mcp");
    writeFileSync(fake, "#!/bin/sh\nenv\n");
    chmodSync(fake, 0o755);
    const remote = spawnSync(wrapper, [], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CLAUDE_CODE_REMOTE: "true",
        RETRACE_URL: "https://example.test",
        RETRACE_TOKEN: "secret",
        RETRACE_HOOK_TOKEN: "secret",
        RETRACE_PRODUCER_KEY: "secret",
        RETRACE_PRODUCER_KEY_FILE: "/secret/key",
        RETRACE_HOOK_KEY_FILE: "/secret/hook-key",
        RETRACE_SIGNING_KEY: "secret",
        RETRACE_SIGNING_KEY_FILE: "/secret/signing-key",
        RETRACE_PUBKEY: "secret",
        RETRACE_CHECKPOINT_PUBKEY: "secret",
        RETRACE_FUTURE_TOKEN_INPUT: "secret",
        RETRACE_GITHUB_SECRET: "secret",
        RETRACE_CREDENTIALS: "secret",
        RETRACE_CREDENTIALS_EXTRA: "secret",
        RETRACE_CREDENTIALS_FILE: "/secret/credentials",
      },
      encoding: "utf8",
    });
    assert.equal(remote.status, 0);
    const childEnv = new Map(remote.stdout.trim().split("\n").map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    assert.equal(childEnv.get("RETRACE_URL"), "https://example.test");
    for (const name of childEnv.keys()) {
      assert.doesNotMatch(name, /^RETRACE_.*(?:KEY|TOKEN|SECRET)/, name);
    }
    for (const name of ["RETRACE_CREDENTIALS", "RETRACE_CREDENTIALS_EXTRA", "RETRACE_CREDENTIALS_FILE"]) {
      assert.equal(childEnv.has(name), false, name);
    }
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
