import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workerRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrateJs = join(workerRoot, "migrate.mjs");

const FAKE_WRANGLER = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const log = process.env.WRANGLER_LOG;
if (log) {
  appendFileSync(log, JSON.stringify({
    command: process.argv.includes("--command"),
    file: process.argv.includes("--file"),
  }) + "\\n");
}
const mode = process.env.WRANGLER_FAKE ?? "ok";
if (mode === "sigterm") {
  process.kill(process.pid, "SIGTERM");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (mode === "exit9") process.exit(9);
process.exit(0);
`;

function fakeWrangler(dir) {
  const path = join(dir, "wrangler");
  writeFileSync(path, FAKE_WRANGLER, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function runMigrate(dir, fake, wranglerPath = fakeWrangler(dir)) {
  const log = join(dir, "wrangler.log");
  writeFileSync(log, "");
  const result = spawnSync(process.execPath, [migrateJs], {
    cwd: workerRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      RETRACE_WRANGLER: wranglerPath,
      WRANGLER_LOG: log,
      WRANGLER_FAKE: fake,
    },
  });
  const commands = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { command: boolean; file: boolean });
  return { result, commands };
}

test("migrate --command succeeds through a fake wrangler and never passes --file", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-migrate-ok-"));
  const { result, commands } = runMigrate(dir, "ok");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(commands.length >= 2, "schema applies more than one statement");
  for (const line of commands) {
    assert.equal(line.command, true);
    assert.equal(line.file, false);
  }
  const pkg = JSON.parse(readFileSync(join(workerRoot, "package.json"), "utf8")) as { scripts: { migrate: string } };
  assert.equal(pkg.scripts.migrate, "node ./migrate.mjs");
});

test("migrate treats wrangler exit 9 as failure and stops before the next statement", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-migrate-exit9-"));
  const { result, commands } = runMigrate(dir, "exit9");
  assert.equal(result.status, 9);
  assert.match(result.stderr, /exit 9/);
  assert.match(result.stderr, /stopping before the next statement/);
  assert.equal(commands.length, 1);
});

test("migrate treats a SIGTERM-killed wrangler as failure and stops before the next statement", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-migrate-sigterm-"));
  const { result, commands } = runMigrate(dir, "sigterm");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /killed by SIGTERM/);
  assert.match(result.stderr, /stopping before the next statement/);
  assert.equal(commands.length, 1);
});

test("migrate treats a missing wrangler binary as failure (spawn error)", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-migrate-enoent-"));
  const { result, commands } = runMigrate(dir, "ok", join(dir, "no-such-wrangler"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /migrate: wrangler failed/);
  assert.equal(commands.length, 0);
});
