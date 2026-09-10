import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

function fakeWrangler(dir: string) {
  const path = join(dir, "wrangler");
  writeFileSync(path, FAKE_WRANGLER, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function runMigrate(dir: string, fake: string, wranglerPath = fakeWrangler(dir)) {
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
  const commands = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { command: boolean; file: boolean; alter?: boolean });
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

test("resolveWrangler default finds stubbed repo-root node_modules/.bin/wrangler without RETRACE_WRANGLER", async () => {
  const { resolveWrangler } = await import("../migrate.mjs");
  const repo = mkdtempSync(join(tmpdir(), "retrace-migrate-resolve-"));
  const worker = join(repo, "apps", "worker");
  mkdirSync(worker, { recursive: true });
  const override = fakeWrangler(repo);
  assert.equal(resolveWrangler({ RETRACE_WRANGLER: override }, worker), override);

  const rootBin = join(repo, "node_modules", ".bin");
  mkdirSync(rootBin, { recursive: true });
  const rootWrangler = fakeWrangler(rootBin);
  const env = {};
  assert.equal(resolveWrangler(env, worker), rootWrangler, "repo-root .bin without RETRACE_WRANGLER");
  assert.equal("RETRACE_WRANGLER" in env, false);

  const pkgBin = join(worker, "node_modules", ".bin");
  mkdirSync(pkgBin, { recursive: true });
  fakeWrangler(pkgBin);
  assert.equal(resolveWrangler({}, worker), rootWrangler, "repo root wins over the package .bin");

  const pkgOnly = mkdtempSync(join(tmpdir(), "retrace-migrate-pkg-"));
  const pkgWorker = join(pkgOnly, "apps", "worker");
  const onlyPkgBin = join(pkgWorker, "node_modules", ".bin");
  mkdirSync(onlyPkgBin, { recursive: true });
  const pkgWrangler = fakeWrangler(onlyPkgBin);
  assert.equal(resolveWrangler({}, pkgWorker), pkgWrangler, "package .bin when the repo root has none");

  assert.equal(resolveWrangler({}, join(tmpdir(), "retrace-empty-wrangler-")), "wrangler");
});

test("migrate treats duplicate column name as success and continues", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-migrate-dupcol-"));
  const wranglerPath = join(dir, "wrangler");
  writeFileSync(wranglerPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const log = process.env.WRANGLER_LOG;
const cmd = process.argv[process.argv.indexOf("--command") + 1] ?? "";
if (log) appendFileSync(log, JSON.stringify({ command: true, file: false, alter: /ALTER TABLE/i.test(cmd) }) + "\\n");
if (/ALTER TABLE/i.test(cmd)) {
  console.error("duplicate column name: repo");
  process.exit(1);
}
process.exit(0);
`, { mode: 0o755 });
  chmodSync(wranglerPath, 0o755);
  const { result, commands } = runMigrate(dir, "ok", wranglerPath);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(commands.some((c) => c.alter === true) || commands.length >= 2);
});
