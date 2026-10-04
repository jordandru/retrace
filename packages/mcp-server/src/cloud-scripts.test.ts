import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

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
  const fallbackRepo = mkdtempSync(resolve(tmpdir(), "retrace-cloud-guard-cwd-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", [
      "-c", "user.name=Cloud Guard Test",
      "-c", "user.email=cloud-guard@example.test",
      "commit", "--allow-empty", "-q", "-m", "initial",
    ], { cwd: repo }).status, 0);

    for (const command of [
      "git push origin main",
      "git push origin HEAD:main",
      "git push origin refs/heads/main",
      "git push --force origin main",
      "git push -u origin main",
      "git push origin +main",
      "git push origin HEAD:refs/heads/main",
      "git push origin :main",
      "git push origin",
      "git push",
    ]) {
      const result = runGuard(repo, command);
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /refused: a cloud session never pushes main/, command);
    }

    assert.equal(runGuard(repo, "gh pr merge").status, 0);
    assert.equal(runGuard(repo, "git push origin feature/cloud").status, 0);
    assert.equal(runGuard(repo, "git push origin main", false).status, 0);
    assert.equal(spawnSync("git", ["checkout", "-q", "-b", "feature-cloud"], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", ["config", "branch.feature-cloud.remote", "origin"], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", ["config", "branch.feature-cloud.merge", "refs/heads/main"], { cwd: repo }).status, 0);
    for (const mode of ["upstream", "simple"]) {
      assert.equal(spawnSync("git", ["config", "push.default", mode], { cwd: repo }).status, 0);
      const result = runGuard(repo, "git push");
      assert.equal(result.status, 2, `push.default=${mode}`);
      assert.match(result.stderr, /refused: a cloud session never pushes main/, `push.default=${mode}`);
    }

    assert.equal(spawnSync("git", ["config", "push.default", "current"], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", ["config", "branch.feature-cloud.merge", "refs/heads/feature-cloud"], { cwd: repo }).status, 0);

    for (const command of [
      "git push --repo origin HEAD:main",
      "git push --repo=origin HEAD:main",
      "git push origin \"HEAD:main\"",
      "git push origin 'main'",
      "git push origin \"refs/heads/main\"",
      "git push origin HEAD\\:main",
      "git -C . push origin HEAD:main",
      `git -C ${repo} push origin main`,
      "env git push origin HEAD:main",
      "env FOO=1 git push origin main",
      "FOO=1 git push origin main",
      "git -c push.default=current push origin main",
      "git --no-pager push origin main",
      "echo start && git push origin main",
      "git fetch origin; git push origin HEAD:main",
      "git push origin feature/x && git push origin main",
    ]) {
      const result = runGuard(repo, command);
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /refused: a cloud session never pushes main/, command);
    }

    for (const command of [
      "git push origin \"HEAD:main",
      "git push origin $DEST",
      "git push origin HEAD:$(cat x)",
      "git push origin HEAD:`cat x`",
      "git push origin ~DEST",
      "git push origin HEAD:*",
      "git push \"$R\" main",
    ]) {
      const result = runGuard(repo, command);
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /refused: cannot resolve the push destination without evaluating the command/, command);
    }

    for (const command of [
      "git push --repo origin HEAD:feature/x",
      "git push --repo=origin feature/x",
      "git push origin \"feature/x\"",
      "git -C . push origin feature/x",
      "env git push origin feature/x",
      "echo main && git push origin feature/x",
      "git push",
    ]) {
      assert.equal(runGuard(repo, command).status, 0, command);
    }

    assert.equal(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: fallbackRepo }).status, 0);
    assert.equal(spawnSync("git", [
      "-c", "user.name=Cloud Guard Test",
      "-c", "user.email=cloud-guard@example.test",
      "commit", "--allow-empty", "-q", "-m", "initial",
    ], { cwd: fallbackRepo }).status, 0);
    assert.equal(spawnSync("git", ["config", "push.default", "simple"], { cwd: fallbackRepo }).status, 0);

    const fallbackCommand = `git -C ${fallbackRepo} push`;
    const fallbackResult = runGuard(repo, fallbackCommand);
    assert.equal(fallbackResult.status, 2, fallbackCommand);
    assert.match(fallbackResult.stderr, /refused: a cloud session never pushes main/, fallbackCommand);

    const allowedFallbackCommand = `git -C ${fallbackRepo} push origin feature/x`;
    assert.equal(runGuard(repo, allowedFallbackCommand).status, 0, allowedFallbackCommand);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(fallbackRepo, { recursive: true, force: true });
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
