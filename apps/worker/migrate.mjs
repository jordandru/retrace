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
 * Re-running this script is safe. Step 2 half B adds project_policies; this
 * half does not.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function splitSqlStatements(sql) {
  const withoutLineComments = sql.replace(/--[^\n]*/g, "");
  return withoutLineComments
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `${s};`);
}

const root = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(root, "schema.sql");
const statements = splitSqlStatements(readFileSync(schemaPath, "utf8"));
if (!statements.length) {
  console.error(`migrate: ${schemaPath} produced no SQL statements`);
  process.exit(1);
}

const db = process.env.RETRACE_D1_DATABASE ?? "retrace-db";
const extra = [];
if (process.argv.includes("--local")) extra.push("--local");
else extra.push("--remote");

for (const statement of statements) {
  const result = spawnSync(
    "wrangler",
    ["d1", "execute", db, ...extra, "--yes", "--command", statement],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  if (result.status) process.exit(result.status ?? 1);
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
}
