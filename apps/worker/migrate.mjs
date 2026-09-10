#!/usr/bin/env node
/**
 * Apply schema.sql through wrangler d1 execute --command (D1 query API).
 *
 * `wrangler d1 execute --file` uses the D1 import API, which requires an OAuth
 * login the Wrangler API-token CLI session does not have (handoff 2026-09-09).
 * --command hits the query endpoint instead. Each statement is applied
 * separately because that endpoint takes one command string.
 *
 * Schema statements are idempotent (CREATE … IF NOT EXISTS, INSERT OR IGNORE).
 * Re-running this script is safe. ALTER TABLE … ADD COLUMN is treated as
 * success when the column already exists (half-A pending_deliveries).
 *
 * Failure: any spawn result other than status === 0 stops the script before the
 * next statement (exit code, killed-by-signal, or spawn error).
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveWrangler(env = process.env, fromDir = dirname(fileURLToPath(import.meta.url))) {
  if (env.RETRACE_WRANGLER) return env.RETRACE_WRANGLER;
  const candidates = [
    join(fromDir, "node_modules", ".bin", "wrangler"),
    join(fromDir, "..", "..", "node_modules", ".bin", "wrangler"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return "wrangler";
}

function splitSqlStatements(sql) {
  const withoutLineComments = sql.replace(/--[^\n]*/g, "");
  return withoutLineComments
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `${s};`);
}

function wranglerFailure(result) {
  if (result.status === 0) return undefined;
  if (result.error) return result.error.message;
  if (result.status === null) return `killed by ${result.signal ?? "unknown signal"}`;
  return `exit ${result.status}`;
}

const root = dirname(fileURLToPath(import.meta.url));

export function runMigrate(env = process.env, argv = process.argv.slice(2)) {
  const schemaPath = join(root, "schema.sql");
  const statements = splitSqlStatements(readFileSync(schemaPath, "utf8"));
  if (!statements.length) {
    console.error(`migrate: ${schemaPath} produced no SQL statements`);
    return 1;
  }

  const db = env.RETRACE_D1_DATABASE ?? "retrace-db";
  const wrangler = resolveWrangler(env, root);
  const extra = [];
  if (argv.includes("--local")) extra.push("--local");
  else extra.push("--remote");

  for (const statement of statements) {
    const result = spawnSync(
      wrangler,
      ["d1", "execute", db, ...extra, "--yes", "--command", statement],
      { cwd: root, encoding: "utf8", env },
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (/duplicate column name/i.test(`${result.stderr ?? ""}\n${result.stdout ?? ""}`)) continue;
    const failure = wranglerFailure(result);
    if (failure) {
      console.error(`migrate: wrangler failed (${failure}); stopping before the next statement`);
      return result.status === null || result.status === undefined ? 1 : result.status;
    }
  }
  return 0;
}

// Compare the module path, not argv: esbuild inlines this file into worker tests,
// where import.meta.url === the test entry and the old argv check would run migrate.
if (/[/\\]migrate\.mjs$/.test(fileURLToPath(import.meta.url))) process.exit(runMigrate());
