import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workerRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("migrate script uses wrangler --command (query API), not --file (import API)", () => {
  const pkg = JSON.parse(readFileSync(join(workerRoot, "package.json"), "utf8")) as { scripts: { migrate: string } };
  assert.equal(pkg.scripts.migrate, "node ./migrate.mjs");
  const script = readFileSync(join(workerRoot, "migrate.mjs"), "utf8");
  assert.match(script, /"--command"/);
  assert.doesNotMatch(script, /"--file"/);
  assert.match(script, /import API/);
  assert.match(script, /query endpoint|query API/i);
  const schema = readFileSync(join(workerRoot, "schema.sql"), "utf8");
  assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS project_policies/i);
  assert.match(schema, /half B/);
  for (const line of schema.split("\n")) {
    const trimmed = line.trim();
    if (/^CREATE (TABLE|INDEX)/i.test(trimmed)) {
      assert.match(trimmed, /IF NOT EXISTS/i, trimmed);
    }
  }
  assert.match(schema, /INSERT OR IGNORE/);
});
