import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SqliteStore } from "./sqlite-store.js";
import { verifyProject } from "@retrace/core";
import { resolveHookToken } from "./git-hook.js";

const bin = fileURLToPath(new URL("./git-hook.js", import.meta.url));
// Hermetic: drop inherited RETRACE_* (a dev shell exports RETRACE_URL/TOKEN, which would redirect the
// spawned hook's writes to the real cloud ledger — this happened; see dogfood log 2026-08-19).
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RETRACE_"))) as Record<string, string>;
const sh = (cwd: string, cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", env: { ...baseEnv, GIT_AUTHOR_NAME: "Jordan", GIT_AUTHOR_EMAIL: "jordan@slcwitit.com", GIT_COMMITTER_NAME: "Jordan", GIT_COMMITTER_EMAIL: "jordan@slcwitit.com", ...env } });
// Async variant for tests that host an HTTP server in-process: execFileSync blocks the event loop, so that server could
// never answer the spawned hook and the test would hang.
const shAsync = (cwd: string, cmd: string, args: string[], env: Record<string, string> = {}) =>
  promisify(execFile)(cmd, args, { cwd, encoding: "utf8", env: { ...baseEnv, GIT_AUTHOR_NAME: "Jordan", GIT_AUTHOR_EMAIL: "jordan@slcwitit.com", GIT_COMMITTER_NAME: "Jordan", GIT_COMMITTER_EMAIL: "jordan@slcwitit.com", ...env } }).then((r) => r.stdout);

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
  // PROV role: the hook is authoritative — commit + every changed file are outputs
  for (const e of [human, agent]) {
    assert.ok(e.artifacts.length >= 2);
    assert.ok(e.artifacts.every((a) => a.role === "generated"), `all refs of #${e.seq} are generated: ${JSON.stringify(e.artifacts)}`);
  }
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

// Owner-token migration 2026-08-23: the retrace repo's hook names a scoped assert credential in .retrace.json; the
// boxing-rpg repo's hook (same dist/git-hook.js) has no "credential" field and must keep using RETRACE_TOKEN unchanged.
const CREDS = [
  { token: "tok-pinned-agent-00000000", name: "claude-code MCP (pinned)", actor: { type: "agent", id: "claude-code" } },
  { token: "tok-git-hook-assert-00000", name: "git hook (assert)", actor: { type: "system", id: "retrace-git" }, trust: "assert" },
];

test("hook token: .retrace.json \"credential\" resolves from the credentials file; no field = owner-token fallthrough unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-cred-"));
  const credFile = join(dir, "creds.json");
  writeFileSync(credFile, JSON.stringify(CREDS));
  const env = { RETRACE_TOKEN: "owner-token" };
  // credential path — beats the shell's owner token AND a file token; RETRACE_HOOK_TOKEN is the explicit override
  assert.equal(resolveHookToken({ credential: "retrace-git" }, env, credFile), "tok-git-hook-assert-00000");
  assert.equal(resolveHookToken({ credential: "retrace-git", token: "file-token" }, env, credFile), "tok-git-hook-assert-00000");
  assert.equal(resolveHookToken({ credential: "retrace-git" }, { ...env, RETRACE_HOOK_TOKEN: "hook-env" }, credFile), "hook-env");
  assert.equal(resolveHookToken({ credential: "retrace-git" }, { RETRACE_CREDENTIALS_FILE: credFile }), "tok-git-hook-assert-00000", "file path from env");
  // named but unresolvable → loud error, never a quiet fallback to the owner token
  assert.throws(() => resolveHookToken({ credential: "nope" }, env, credFile), /credential "nope" not found/);
  assert.throws(() => resolveHookToken({ credential: "retrace-git" }, env, join(dir, "missing.json")), /does not exist/);
  // fallthrough (no "credential") — exactly the pre-migration precedence: env RETRACE_TOKEN > .retrace.json token
  assert.equal(resolveHookToken({}, env, credFile), "owner-token");
  assert.equal(resolveHookToken({ token: "file-token" }, env, credFile), "owner-token");
  assert.equal(resolveHookToken({ token: "file-token" }, {}, credFile), "file-token");
  assert.equal(resolveHookToken({}, {}, credFile), undefined);
  assert.equal(resolveHookToken({}, {}, join(dir, "missing.json")), undefined, "no credential named → the file is never required");
});

test("hook end to end: the named credential is the bearer the server sees; a rejection is appended to .git/retrace-hook.log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-git-remote-"));
  const credFile = join(dir, "creds.json");
  writeFileSync(credFile, JSON.stringify(CREDS));
  const seen: string[] = [];
  let status = 201;
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? "");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
      if (status !== 201) return res.end(JSON.stringify({ error: "actor is not in this credential's allowed_actors" }));
      const input = JSON.parse(body);
      res.end(JSON.stringify({ event: { ...input, id: "evt_test", seq: 0, prev_hash: "0", hash: "0", received_at: new Date().toISOString() }, deduped: false }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // the dev-shell shape: owner token exported, plus the credentials file the hook may consult
    const env = { RETRACE_URL: url, RETRACE_TOKEN: "owner-token", RETRACE_CREDENTIALS_FILE: credFile };
    await shAsync(dir, "git", ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, "a.ts"), "1\n");
    await shAsync(dir, "git", ["add", "."]);
    await shAsync(dir, "git", ["commit", "-qm", "initial"]);
    await shAsync(dir, "node", [bin, "install", "--repo", dir, "--project", "rpg"], env);

    // 1) no "credential" field (boxing-rpg): the hook still sends the owner token
    writeFileSync(join(dir, "a.ts"), "2\n");
    await shAsync(dir, "git", ["commit", "-qam", "owner path"], env);
    assert.equal(seen.at(-1), "Bearer owner-token");

    // 2) "credential": "retrace-git" (retrace repo): the scoped token is sent even though RETRACE_TOKEN is in the env
    writeFileSync(join(dir, ".retrace.json"), JSON.stringify({ project: "rpg", credential: "retrace-git" }));
    writeFileSync(join(dir, "a.ts"), "3\n");
    await shAsync(dir, "git", ["commit", "-qam", "credential path"], env);
    assert.equal(seen.at(-1), "Bearer tok-git-hook-assert-00000");
    assert.ok(!existsSync(join(dir, ".git", "retrace-hook.log")), "no log line while everything lands");

    // 3) the server rejects (a fail-closed assert credential 403s an unlisted actor): git commit still succeeds, and the
    //    reason is visible in .git/retrace-hook.log — no token in it
    status = 403;
    writeFileSync(join(dir, "a.ts"), "4\n");
    await shAsync(dir, "git", ["commit", "-qam", "rejected path"], env);
    const log = readFileSync(join(dir, ".git", "retrace-hook.log"), "utf8");
    assert.match(log, /^\d{4}-\d\d-\d\dT\S+ commit [0-9a-f]{12} in \S+ NOT logged: Retrace API POST \/events → 403: .*allowed_actors/m);
    assert.doesNotMatch(log, /tok-git-hook-assert|owner-token/);
    // 4) a credential that cannot be resolved is a config error — also logged, still non-fatal to git
    writeFileSync(join(dir, ".retrace.json"), JSON.stringify({ project: "rpg", credential: "does-not-exist" }));
    writeFileSync(join(dir, "a.ts"), "5\n");
    await shAsync(dir, "git", ["commit", "-qam", "unresolvable credential"], env);
    assert.match(readFileSync(join(dir, ".git", "retrace-hook.log"), "utf8"), /NOT logged: credential "does-not-exist" not found/);
    assert.equal(seen.length, 3, "nothing was sent for the unresolvable credential");
  } finally {
    server.close();
  }
});
