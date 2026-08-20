import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStore } from "./sqlite-store.js";
import { verifyProject } from "@retrace/core";

const bin = fileURLToPath(new URL("./git-hook.js", import.meta.url));
// Hermetic: drop inherited RETRACE_* (a dev shell exports RETRACE_URL/TOKEN, which would redirect the
// spawned hook's writes to the real cloud ledger — this happened; see dogfood log 2026-08-19).
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RETRACE_"))) as Record<string, string>;
const sh = (cwd: string, cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", env: { ...baseEnv, GIT_AUTHOR_NAME: "Jordan", GIT_AUTHOR_EMAIL: "jordan@slcwitit.com", GIT_COMMITTER_NAME: "Jordan", GIT_COMMITTER_EMAIL: "jordan@slcwitit.com", ...env } });

test("git adapter: install hook, human commit, agent commit with trailers, backfill idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-git-"));
  const db = join(dir, "ledger.db");
  const env = { RETRACE_DB: db, RETRACE_PROJECT: "rpg" };
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "initial"]);

  // install after first commit → hook fires on subsequent commits
  const out = sh(dir, "node", [bin, "install", "--repo", dir], env);
  assert.match(out, /installed post-commit hook/);
  assert.ok(existsSync(join(dir, ".git/hooks/post-commit")));
  assert.equal(JSON.parse(readFileSync(join(dir, ".retrace.json"), "utf8")).project, "rpg");

  writeFileSync(join(dir, "a.ts"), "export const a = 2;\nexport const b = 3;\n");
  sh(dir, "git", ["commit", "-qam", "bump a and add b"], env); // hook runs with env

  writeFileSync(join(dir, "fight.ts"), "export const jab = () => 1;\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "add jab\n\nRetrace-Actor: claude-code\nRetrace-Model: claude-fable-5\nRetrace-Caused-By: evt_root123\nCo-Authored-By: Claude <noreply@anthropic.com>"], env);

  const store = new SqliteStore(db);
  let events = await store.all("rpg");
  assert.equal(events.length, 2, "hook logged two commits");
  const human = events[0], agent = events[1];
  assert.equal(human.actor.type, "human");
  assert.equal(human.actor.id, "jordan@slcwitit.com");
  assert.equal(human.action, "committed");
  assert.equal(human.intent, "bump a and add b");
  assert.equal(human.change?.summary, "1 file, +2 −1");
  assert.ok(human.artifacts.some((a) => a.id.endsWith("#a.ts")));
  assert.equal(human.artifacts[0].kind, "commit");
  assert.equal(human.artifacts[0].derived_from?.length, 1, "commit derived_from parent commit");
  assert.equal(agent.actor.type, "agent");
  assert.equal(agent.actor.id, "claude-code");
  assert.equal(agent.actor.model, "claude-fable-5");
  assert.equal(agent.actor.on_behalf_of, "jordan@slcwitit.com");
  assert.equal(agent.caused_by, "evt_root123");
  assert.equal(agent.intent, "add jab");
  assert.equal(agent.method?.automated, true);

  // backfill picks up the initial commit only; re-running dedupes everything
  const bf = sh(dir, "node", [bin, "backfill", "--repo", dir], env);
  assert.match(bf, /1 logged, 2 already present/);
  const bf2 = sh(dir, "node", [bin, "backfill", "--repo", dir], env);
  assert.match(bf2, /0 logged, 3 already present/);
  events = await store.all("rpg");
  assert.equal(events.length, 3);
  assert.equal((await verifyProject(store, "rpg")).ok, true);
});
