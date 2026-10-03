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
  try {
    assert.equal(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo }).status, 0);
    for (const command of [
      "git push origin main",
      "git push origin HEAD:main",
      "git push origin refs/heads/main",
      "git push",
    ]) {
      const result = runGuard(repo, command);
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /refused: a cloud session never pushes main/);
    }

    assert.equal(runGuard(repo, "git push origin feature/cloud").status, 0);
    assert.equal(runGuard(repo, "git push origin main", false).status, 0);
    assert.equal(spawnSync("git", ["checkout", "-q", "-b", "feature/cloud"], { cwd: repo }).status, 0);
    assert.equal(runGuard(repo, "git push").status, 0);
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
  assert.match(wrapper, /unset RETRACE_TOKEN RETRACE_HOOK_TOKEN RETRACE_PRODUCER_KEY_FILE RETRACE_CREDENTIALS_FILE/);
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
    writeFileSync(fake, "#!/bin/sh\nprintf '%s|%s|%s|%s|%s\\n' \"$RETRACE_URL\" \"${RETRACE_TOKEN-unset}\" \"${RETRACE_HOOK_TOKEN-unset}\" \"${RETRACE_PRODUCER_KEY_FILE-unset}\" \"${RETRACE_CREDENTIALS_FILE-unset}\"\n");
    chmodSync(fake, 0o755);
    const remote = spawnSync(wrapper, [], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CLAUDE_CODE_REMOTE: "true",
        RETRACE_URL: "https://example.test",
        RETRACE_TOKEN: "secret",
        RETRACE_HOOK_TOKEN: "secret",
        RETRACE_PRODUCER_KEY_FILE: "/secret/key",
        RETRACE_CREDENTIALS_FILE: "/secret/credentials",
      },
      encoding: "utf8",
    });
    assert.equal(remote.status, 0);
    assert.equal(remote.stdout.trim(), "https://example.test|unset|unset|unset|unset");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
