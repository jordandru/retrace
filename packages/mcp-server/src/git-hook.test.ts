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
import { parseTrailers, resolveHookToken } from "./git-hook.js";

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

// Backlog #12 (dogfood log 2026-08-20): 68c343f carried `Retrace-*` in one paragraph and `Co-Authored-By` in the next;
// git's %(trailers) only reads the last paragraph, so the hook minted actor "claude-fable-5" from the co-author name.
test("git adapter: trailers from all trailing paragraphs; consistent Co-Authored-By actor (backlog #12)", async () => {
  // pure parser: the 68c343f layout → both paragraphs are trailers
  const t1 = parseTrailers("subject\n\nWhy this change.\n\nRetrace-Actor: claude-code\nRetrace-Model: claude-fable-5\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n");
  assert.deepEqual(t1.trailers, { "retrace-actor": ["claude-code"], "retrace-model": ["claude-fable-5"], "co-authored-by": ["Claude Fable 5 <noreply@anthropic.com>"] });
  assert.deepEqual(t1.trailerText, ["Retrace-Actor: claude-code", "Retrace-Model: claude-fable-5", "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"]);
  // a "Key: value" line inside prose is not a trailer; the final trailer paragraph still is
  const t2 = parseTrailers("subject\n\nThe hook should read\nRetrace-Actor: claude-code\nfrom every trailing paragraph.\n\nSigned-off-by: X <x@example.com>");
  assert.equal(t2.trailers["retrace-actor"], undefined);
  assert.deepEqual(t2.trailers["signed-off-by"], ["X <x@example.com>"]);
  assert.deepEqual(t2.trailerText, ["Signed-off-by: X <x@example.com>"]);
  // no trailers at all; the subject is never a trailer paragraph
  assert.deepEqual(parseTrailers("just a subject\n\nand some prose"), { trailers: {}, trailerText: [] });
  assert.deepEqual(parseTrailers("Fix: the subject"), { trailers: {}, trailerText: [] });
  assert.deepEqual(parseTrailers(""), { trailers: {}, trailerText: [] });
  // case-insensitive keys, repeated keys keep every value, continuation lines unfold
  const t4 = parseTrailers("s\n\nCo-Authored-By: A <a@example.com>\nco-authored-by: B <b@example.com>\nSigned-Off-By: C\n  <c@example.com>");
  assert.deepEqual(t4.trailers["co-authored-by"], ["A <a@example.com>", "B <b@example.com>"]);
  assert.deepEqual(t4.trailers["signed-off-by"], ["C <c@example.com>"]);
  // CRLF survives `--cleanup=verbatim`, `git commit-tree` and API-made commits; `.`/`$` stop at \r, so the first #12 fix
  // classified these lines as trailers yet extracted none — the Retrace-* block vanished (review). U+2028 is the same class.
  const t5 = parseTrailers("s\r\n\r\nRetrace-Actor: claude-code\r\nRetrace-Model: m\r\n\r\nCo-Authored-By: Claude <n@a>\r\n");
  assert.deepEqual(t5.trailers, { "retrace-actor": ["claude-code"], "retrace-model": ["m"], "co-authored-by": ["Claude <n@a>"] });
  assert.deepEqual(t5.trailerText, ["Retrace-Actor: claude-code", "Retrace-Model: m", "Co-Authored-By: Claude <n@a>"]);
  assert.deepEqual(parseTrailers("s\n\nCo-Authored-By: A\u2028B <a@b>").trailers, { "co-authored-by": ["A\u2028B <a@b>"] });

  // end-to-end through the hook
  const dir = mkdtempSync(join(tmpdir(), "retrace-git12-"));
  const db = join(dir, "ledger.db");
  const env = { RETRACE_DB: db, RETRACE_PROJECT: "rpg" };
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "initial"]);
  sh(dir, "node", [bin, "install", "--repo", dir], env);

  // (b) the 68c343f layout: Retrace-* paragraph, then a Co-Authored-By paragraph; prose keeps its "Note:" line
  writeFileSync(join(dir, "hook.ts"), "export const hook = 1;\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "add hook\n\nLonger text.\nNote: keep me\n\nRetrace-Actor: claude-code\nRetrace-Model: claude-fable-5\nRetrace-Caused-By: evt_root456\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"], env);
  // (c) Co-Authored-By only → family id + model from the full name
  writeFileSync(join(dir, "hook.ts"), "export const hook = 2;\n");
  sh(dir, "git", ["commit", "-qam", "bump hook\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"], env);
  // (d) human commit whose prose mentions a trailer-looking line
  writeFileSync(join(dir, "hook.ts"), "export const hook = 3;\n");
  sh(dir, "git", ["commit", "-qam", "human note\n\nThis paragraph mentions\nRetrace-Actor: claude-code\nin passing, as prose."], env);
  // (e) the 68c343f layout with CRLF endings kept verbatim (`-m` cleanup would strip the CRs; verbatim does not)
  writeFileSync(join(dir, "hook.ts"), "export const hook = 4;\n");
  sh(dir, "git", ["commit", "-qa", "--cleanup=verbatim", "-m", "crlf hook\r\n\r\nLonger text.\r\nNote: keep me\r\n\r\nRetrace-Actor: claude-code\r\nRetrace-Model: claude-fable-5\r\nRetrace-Caused-By: evt_root789\r\n\r\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\r\n"], env);
  // (f) `git commit-tree` runs no cleanup and no hook — logged explicitly, as backfill would
  const ct = sh(dir, "git", ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "ct\r\n\r\nRetrace-Actor: claude-code\r\nRetrace-Model: m\r\n"]).trim();
  sh(dir, "node", [bin, "commit", "--repo", dir, ct], env);

  const store = new SqliteStore(db);
  const events = await store.all("rpg");
  assert.equal(events.length, 5, "hook logged four commits + one explicit commit-tree");
  const [layout, coauthored, human, crlf, tree] = events;
  assert.deepEqual(layout.actor, { type: "agent", id: "claude-code", model: "claude-fable-5", on_behalf_of: "jordan@slcwitit.com" });
  assert.equal(layout.caused_by, "evt_root456");
  assert.equal(layout.intent, "add hook\n\nLonger text.\nNote: keep me");
  assert.equal(layout.method?.automated, true);
  assert.deepEqual(coauthored.actor, { type: "agent", id: "claude", model: "claude-fable-5", display_name: "Claude Fable 5", on_behalf_of: "jordan@slcwitit.com" });
  assert.equal(coauthored.intent, "bump hook");
  assert.equal(coauthored.method?.automated, true);
  assert.equal(human.actor.type, "human");
  assert.equal(human.actor.id, "jordan@slcwitit.com");
  assert.equal(human.intent, "human note\n\nThis paragraph mentions\nRetrace-Actor: claude-code\nin passing, as prose.");
  assert.equal(human.method?.automated, false);
  assert.ok(sh(dir, "git", ["log", "-1", "--format=%B"]).includes("\r"), "CRLF commit stored verbatim");
  assert.deepEqual(crlf.actor, { type: "agent", id: "claude-code", model: "claude-fable-5", on_behalf_of: "jordan@slcwitit.com" });
  assert.equal(crlf.caused_by, "evt_root789");
  assert.equal(crlf.intent, "crlf hook\n\nLonger text.\nNote: keep me");
  assert.deepEqual(tree.actor, { type: "agent", id: "claude-code", model: "m", on_behalf_of: "jordan@slcwitit.com" });
  assert.equal(tree.intent, "ct");
  assert.equal((await verifyProject(store, "rpg")).ok, true);
});
