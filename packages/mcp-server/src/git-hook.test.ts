import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SqliteStore } from "./sqlite-store.js";
import { hookScript, parseTrailers, resolveHookToken, resolveHookProducerKeyFile, retryableHookFailure, ttySurface, guardRemoteWrite, validCausedById, validActorId } from "./git-hook.js";
import { appendEvent, generateSigningKey, PRODUCER_SIG_FORMAT_V2, publicFromPrivate, verifyProducerSig, verifyProject, createHandler, MemoryEventStore } from "@retrace-dev/core";
import { RemoteApiError, RemoteCapabilityError } from "./remote-store.js";
import { writeProducerPrivateKey } from "./producer-key.js";

async function seedInstruct(db: string, project = "rpg"): Promise<string> {
  const { event } = await appendEvent(new SqliteStore(db), {
    project,
    actor: { type: "human", id: "jordan@slcwitit.com" },
    action: "instructed",
    artifacts: [{ id: "task:seed", role: "generated" }],
  });
  return event.id;
}

const bin = fileURLToPath(new URL("./git-hook.js", import.meta.url));
// Hermetic: drop inherited RETRACE_* (a dev shell exports RETRACE_URL/TOKEN, which would redirect the
// spawned hook's writes to the real cloud ledger — this happened; see dogfood log 2026-08-19). CLAUDE_CODE_SESSION_ID
// and ORCA_* go for the same reason: this suite runs inside Claude Code (and may run inside an Orca pane), so leaving
// them inherited would stamp a session/ide here and none in CI.
const HOST_VARS = /^(RETRACE_|ORCA_|CLAUDE_CODE_SESSION_ID$|GROK_SESSION_ID$)/;
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !HOST_VARS.test(k))) as Record<string, string>;
const sh = (cwd: string, cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", env: { ...baseEnv, GIT_AUTHOR_NAME: "Jordan", GIT_AUTHOR_EMAIL: "jordan@slcwitit.com", GIT_COMMITTER_NAME: "Jordan", GIT_COMMITTER_EMAIL: "jordan@slcwitit.com", ...env } });
// Async variant for tests that host an HTTP server in-process: execFileSync blocks the event loop, so that server could
// never answer the spawned hook and the test would hang.
const shAsync = (cwd: string, cmd: string, args: string[], env: Record<string, string> = {}) =>
  promisify(execFile)(cmd, args, { cwd, encoding: "utf8", env: { ...baseEnv, GIT_AUTHOR_NAME: "Jordan", GIT_AUTHOR_EMAIL: "jordan@slcwitit.com", GIT_COMMITTER_NAME: "Jordan", GIT_COMMITTER_EMAIL: "jordan@slcwitit.com", ...env } }).then((r) => r.stdout);

async function waitForFile(path: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

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
  const root = await seedInstruct(db);
  sh(dir, "git", ["commit", "-qm", `add jab\n\nRetrace-Actor: claude-code\nRetrace-Model: claude-fable-5\nRetrace-Caused-By: ${root}\nCo-Authored-By: Claude <noreply@anthropic.com>`], env);

  const store = new SqliteStore(db);
  let events = await store.all("rpg");
  const commits = events.filter((e) => e.action === "committed");
  assert.equal(commits.length, 2, "hook logged two commits");
  const human = commits[0], agent = commits[1];
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
  assert.equal(agent.caused_by, root);
  assert.equal(agent.intent, "add jab");
  assert.equal(agent.method?.automated, true);

  // backfill picks up the initial commit only; re-running dedupes everything
  const bf = sh(dir, "node", [bin, "backfill", "--repo", dir], env);
  assert.match(bf, /1 logged, 2 already present/);
  const bf2 = sh(dir, "node", [bin, "backfill", "--repo", dir], env);
  assert.match(bf2, /0 logged, 3 already present/);
  events = await store.all("rpg");
  assert.equal(events.length, 4, "3 commits + 1 seeded instruct");
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

test("hook producer key: RETRACE_HOOK_KEY_FILE beats producer_key_file; missing both means unsigned", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-hook-key-"));
  const credFile = join(dir, "creds.json");
  const pathOnCred = join(dir, "from-cred.jwk");
  const pathOnEnv = join(dir, "from-env.jwk");
  writeFileSync(credFile, JSON.stringify([{ ...CREDS[1], producer_key_file: pathOnCred }]));
  assert.equal(resolveHookProducerKeyFile({ credential: "retrace-git" }, {}, credFile), pathOnCred);
  assert.equal(resolveHookProducerKeyFile({ credential: "retrace-git" }, { RETRACE_HOOK_KEY_FILE: pathOnEnv }, credFile), pathOnEnv);
  assert.equal(resolveHookProducerKeyFile({}, {}, credFile), undefined);
  assert.equal(resolveHookProducerKeyFile({ credential: "retrace-git" }, {}, join(dir, "missing.json")), undefined);
});

test("hook signs committed events when RETRACE_HOOK_KEY_FILE is set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-git-sign-"));
  const db = join(dir, "ledger.db");
  const kp = await generateSigningKey();
  const keyFile = join(dir, "hook.jwk");
  writeProducerPrivateKey(keyFile, kp.privateKey);
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "initial"]);
  const env = { RETRACE_DB: db, RETRACE_PROJECT: "rpg", RETRACE_HOOK_KEY_FILE: keyFile };
  sh(dir, "node", [bin, "install", "--repo", dir], env);
  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
  sh(dir, "git", ["commit", "-qam", "signed bump"], env);
  const events = await new SqliteStore(db).all("rpg");
  const commit = events.find((e) => e.action === "committed");
  assert.ok(commit?.producer_sig, "hook write should be producer-signed");
  assert.equal(commit!.producer_sig!.format, PRODUCER_SIG_FORMAT_V2);
  assert.equal(typeof commit!.method?.params?.raw_message, "string");
  assert.deepEqual(commit!.method?.params?.author, { name: "Jordan", email: "jordan@slcwitit.com" });
  assert.ok(Array.isArray(commit!.method?.params?.parents));
  assert.equal(await verifyProducerSig(commit!, publicFromPrivate(kp.privateKey)), true);
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
    const logPath = join(dir, ".git", "retrace-hook.log");
    await waitForFile(logPath);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /^\d{4}-\d\d-\d\dT\S+ commit [0-9a-f]{12} in \S+ NOT logged: Retrace API POST \/events → 403: .*allowed_actors/m);
    assert.doesNotMatch(log, /tok-git-hook-assert|owner-token/);
    assert.ok(!existsSync(join(dir, ".git", "retrace-pending-seal")), "credential rejection is not retryable");
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

test("capability mismatches and HTTP 426 are retryable like 5xx; 403 is not", () => {
  assert.equal(retryableHookFailure(new RemoteCapabilityError("GET", "/api", 200, "schema lacks event.producer_sig")), true);
  assert.equal(retryableHookFailure(new RemoteApiError("POST", "/events", 426, new Headers(), "upgrade required")), true);
  assert.equal(retryableHookFailure(new RemoteApiError("POST", "/events", 403, new Headers(), "forbidden")), false);
  assert.equal(retryableHookFailure(new RemoteApiError("POST", "/events", 503, new Headers(), "unavailable")), true);
});

test("hook 426 queues the sha in retrace-pending-seal, prints stderr, and exits non-zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-git-426-"));
  const server = createServer((_req, res) => {
    res.writeHead(426, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upgrade required", min_cli_version: "0.1.8", format: "retrace-producer-sig/2" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const env = { RETRACE_URL: url, RETRACE_TOKEN: "owner-token" };
    sh(dir, "git", ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, ".retrace.json"), JSON.stringify({ project: "rpg", url }));
    writeFileSync(join(dir, "a.ts"), "1\n");
    sh(dir, "git", ["add", "."]);
    sh(dir, "git", ["commit", "-qm", "initial"]);
    const sha = sh(dir, "git", ["rev-parse", "HEAD"]).trim();
    await assert.rejects(
      promisify(execFile)("node", [bin, "commit", "--hook", "--repo", dir], {
        cwd: dir,
        encoding: "utf8",
        env: { ...baseEnv, ...env },
      }),
      (error: any) => {
        assert.equal(error.code, 1);
        const retraceLines = error.stderr.trim().split("\n").filter((line: string) => line.startsWith("retrace:"));
        assert.deepEqual(retraceLines, [`retrace: commit ${sha} pending seal; details: ${join(dir, ".git", "retrace-hook.log")}`]);
        return true;
      },
    );
    assert.equal(readFileSync(join(dir, ".git", "retrace-pending-seal"), "utf8"), `${sha}\n`);
  } finally {
    server.close();
  }
});

test("two hook commits during a 5xx are queued, then the next run drains them before the current sha", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-git-pending-"));
  let status = 503;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const input = JSON.parse(body);
      seen.push(input.change.after_hash);
      if (status === 503) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "temporarily unavailable" }));
        return;
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({
        event: { ...input, id: `evt_${seen.length}`, seq: seen.length, prev_hash: "0", hash: "0", received_at: new Date().toISOString() },
        deduped: seen.slice(0, -1).includes(input.change.after_hash),
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const env = { RETRACE_URL: url, RETRACE_TOKEN: "owner-token" };
    sh(dir, "git", ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, ".retrace.json"), JSON.stringify({ project: "rpg", url }));
    writeFileSync(join(dir, "a.ts"), "1\n");
    sh(dir, "git", ["add", "."]);
    sh(dir, "git", ["commit", "-qm", "initial"]);
    const sha = sh(dir, "git", ["rev-parse", "HEAD"]).trim();

    await assert.rejects(
      promisify(execFile)("node", [bin, "commit", "--hook", "--repo", dir], {
        cwd: dir,
        encoding: "utf8",
        env: { ...baseEnv, ...env },
      }),
      (error: any) => {
        assert.equal(error.code, 1);
        const retraceLines = error.stderr.trim().split("\n").filter((line: string) => line.startsWith("retrace:"));
        assert.deepEqual(retraceLines, [`retrace: commit ${sha} pending seal; details: ${join(dir, ".git", "retrace-hook.log")}`]);
        return true;
      },
    );
    assert.equal(readFileSync(join(dir, ".git", "retrace-pending-seal"), "utf8"), `${sha}\n`);

    writeFileSync(join(dir, "a.ts"), "2\n");
    sh(dir, "git", ["commit", "-qam", "second"]);
    const secondSha = sh(dir, "git", ["rev-parse", "HEAD"]).trim();
    await assert.rejects(
      promisify(execFile)("node", [bin, "commit", "--hook", "--repo", dir], {
        cwd: dir,
        encoding: "utf8",
        env: { ...baseEnv, ...env },
      }),
      (error: any) => {
        assert.equal(error.code, 1);
        return true;
      },
    );
    assert.equal(
      readFileSync(join(dir, ".git", "retrace-pending-seal"), "utf8"),
      `${sha}\n${secondSha}\n`,
      "the current commit is queued even when retrying the older pending seal fails first",
    );

    status = 201;
    await shAsync(dir, "node", [bin, "commit", "--hook", "--repo", dir], env);
    assert.equal(readFileSync(join(dir, ".git", "retrace-pending-seal"), "utf8"), "");
    assert.deepEqual(
      seen,
      [sha, sha, sha, secondSha, secondSha],
      "both pending commits are retried first, then the current sha dedupes",
    );
  } finally {
    server.close();
  }
});

test("hook script preserves retrace-git stderr but never propagates its failure to git", () => {
  const script = hookScript();
  assert.match(script, />\/dev\/null \|\| :/);
  assert.doesNotMatch(script, /2>&1/);
});

test("keyed hook 503 on GET /api queues pending-seal like POST 5xx", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-git-probe-503-"));
  const kp = await generateSigningKey();
  const keyFile = join(dir, "hook.jwk");
  writeProducerPrivateKey(keyFile, kp.privateKey);
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "temporarily unavailable" }));
      return;
    }
    res.writeHead(201, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    sh(dir, "git", ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, ".retrace.json"), JSON.stringify({ project: "rpg", url }));
    writeFileSync(join(dir, "a.ts"), "1\n");
    sh(dir, "git", ["add", "."]);
    sh(dir, "git", ["commit", "-qm", "initial"]);
    const sha = sh(dir, "git", ["rev-parse", "HEAD"]).trim();
    await assert.rejects(
      promisify(execFile)("node", [bin, "commit", "--hook", "--repo", dir], {
        cwd: dir,
        encoding: "utf8",
        env: { ...baseEnv, RETRACE_URL: url, RETRACE_TOKEN: "owner-token", RETRACE_HOOK_KEY_FILE: keyFile },
      }),
      (error: any) => {
        assert.equal(error.code, 1);
        const retraceLines = error.stderr.trim().split("\n").filter((line: string) => line.startsWith("retrace:"));
        assert.deepEqual(retraceLines, [`retrace: commit ${sha} pending seal; details: ${join(dir, ".git", "retrace-hook.log")}`]);
        return true;
      },
    );
    assert.equal(readFileSync(join(dir, ".git", "retrace-pending-seal"), "utf8"), `${sha}\n`);
  } finally {
    server.close();
  }
});

test("keyed hook against an old Worker queues pending-seal when GET /api lacks producer_sig", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-git-probe-old-worker-"));
  const kp = await generateSigningKey();
  const keyFile = join(dir, "hook.jwk");
  writeProducerPrivateKey(keyFile, kp.privateKey);
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schema: { event: ["id", "hash"] } }));
      return;
    }
    res.writeHead(201, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    sh(dir, "git", ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, ".retrace.json"), JSON.stringify({ project: "rpg", url }));
    writeFileSync(join(dir, "a.ts"), "1\n");
    sh(dir, "git", ["add", "."]);
    sh(dir, "git", ["commit", "-qm", "initial"]);
    const sha = sh(dir, "git", ["rev-parse", "HEAD"]).trim();
    await assert.rejects(
      promisify(execFile)("node", [bin, "commit", "--hook", "--repo", dir], {
        cwd: dir,
        encoding: "utf8",
        env: { ...baseEnv, RETRACE_URL: url, RETRACE_TOKEN: "owner-token", RETRACE_HOOK_KEY_FILE: keyFile },
      }),
      (error: any) => {
        assert.equal(error.code, 1);
        const retraceLines = error.stderr.trim().split("\n").filter((line: string) => line.startsWith("retrace:"));
        assert.deepEqual(retraceLines, [`retrace: commit ${sha} pending seal; details: ${join(dir, ".git", "retrace-hook.log")}`]);
        return true;
      },
    );
    assert.equal(readFileSync(join(dir, ".git", "retrace-pending-seal"), "utf8"), `${sha}\n`);
    const log = readFileSync(join(dir, ".git", "retrace-hook.log"), "utf8");
    assert.match(log, /GET \/api returned 200; schema lacks event\.producer_sig; client refuses to sign; deploy the Worker/);
    assert.doesNotMatch(log, /→ 426/);
  } finally {
    server.close();
  }
});

test("keyed hook GET /api stall past RETRACE_HOOK_DEADLINE_MS queues pending-seal", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-git-probe-stall-"));
  const kp = await generateSigningKey();
  const keyFile = join(dir, "hook.jwk");
  writeProducerPrivateKey(keyFile, kp.privateKey);
  const server = createServer((_req, _res) => { /* stall: never respond */ });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    sh(dir, "git", ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, ".retrace.json"), JSON.stringify({ project: "rpg", url }));
    writeFileSync(join(dir, "a.ts"), "1\n");
    sh(dir, "git", ["add", "."]);
    sh(dir, "git", ["commit", "-qm", "initial"]);
    const sha = sh(dir, "git", ["rev-parse", "HEAD"]).trim();
    await assert.rejects(
      promisify(execFile)("node", [bin, "commit", "--hook", "--repo", dir], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...baseEnv,
          RETRACE_URL: url,
          RETRACE_TOKEN: "owner-token",
          RETRACE_HOOK_KEY_FILE: keyFile,
          RETRACE_HOOK_DEADLINE_MS: "200",
        },
      }),
      (error: any) => {
        assert.equal(error.code, 1);
        const retraceLines = error.stderr.trim().split("\n").filter((line: string) => line.startsWith("retrace:"));
        assert.deepEqual(retraceLines, [`retrace: commit ${sha} pending seal; details: ${join(dir, ".git", "retrace-hook.log")}`]);
        return true;
      },
    );
    assert.equal(readFileSync(join(dir, ".git", "retrace-pending-seal"), "utf8"), `${sha}\n`);
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

  assert.equal(validCausedById("evt_deadbeefdeadbeefdeadbeefdeadbeef"), "evt_deadbeefdeadbeefdeadbeefdeadbeef");
  assert.equal(validCausedById("evt_abc123"), undefined);
  assert.equal(validCausedById("not-an-id"), undefined);
  assert.equal(validActorId("claude-code"), "claude-code");
  assert.equal(validActorId("grok"), "grok");
  assert.equal(validActorId("mallory@example.com"), undefined);
  assert.equal(validActorId("https://evil.example"), undefined);

  // end-to-end through the hook
  const dir = mkdtempSync(join(tmpdir(), "retrace-git12-"));
  const db = join(dir, "ledger.db");
  const env = { RETRACE_DB: db, RETRACE_PROJECT: "rpg" };
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "initial"]);
  sh(dir, "node", [bin, "install", "--repo", dir], env);
  writeFileSync(join(dir, "seed.ts"), "export const seed = 1;\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "seed db"], env);
  const root12 = await seedInstruct(db);

  // (b) the 68c343f layout: Retrace-* paragraph, then a Co-Authored-By paragraph; prose keeps its "Note:" line
  writeFileSync(join(dir, "hook.ts"), "export const hook = 1;\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", `add hook\n\nLonger text.\nNote: keep me\n\nRetrace-Actor: claude-code\nRetrace-Model: claude-fable-5\nRetrace-Caused-By: ${root12}\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`], env);
  // (c) Co-Authored-By only → family id + model from the full name
  writeFileSync(join(dir, "hook.ts"), "export const hook = 2;\n");
  sh(dir, "git", ["commit", "-qam", "bump hook\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"], env);
  // (d) human commit whose prose mentions a trailer-looking line
  writeFileSync(join(dir, "hook.ts"), "export const hook = 3;\n");
  sh(dir, "git", ["commit", "-qam", "human note\n\nThis paragraph mentions\nRetrace-Actor: claude-code\nin passing, as prose."], env);
  // (e) the 68c343f layout with CRLF endings kept verbatim (`-m` cleanup would strip the CRs; verbatim does not)
  writeFileSync(join(dir, "hook.ts"), "export const hook = 4;\n");
  sh(dir, "git", ["commit", "-qa", "--cleanup=verbatim", "-m", `crlf hook\r\n\r\nLonger text.\r\nNote: keep me\r\n\r\nRetrace-Actor: claude-code\r\nRetrace-Model: claude-fable-5\r\nRetrace-Caused-By: ${root12}\r\n\r\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\r\n`], env);
  // (f) `git commit-tree` runs no cleanup and no hook — logged explicitly, as backfill would
  const ct = sh(dir, "git", ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "ct\r\n\r\nRetrace-Actor: claude-code\r\nRetrace-Model: m\r\n"]).trim();
  sh(dir, "node", [bin, "commit", "--repo", dir, ct], env);

  const store = new SqliteStore(db);
  const events = (await store.all("rpg")).filter((e) => e.action === "committed");
  assert.equal(events.length, 6, "hook logged seed + four commits + one explicit commit-tree");
  const [, layout, coauthored, human, crlf, tree] = events;
  assert.deepEqual(layout.actor, { type: "agent", id: "claude-code", model: "claude-fable-5", on_behalf_of: "jordan@slcwitit.com" });
  assert.equal(layout.caused_by, root12);
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
  assert.equal(crlf.caused_by, root12);
  assert.equal(crlf.intent, "crlf hook\n\nLonger text.\nNote: keep me");
  assert.deepEqual(tree.actor, { type: "agent", id: "claude-code", model: "m", on_behalf_of: "jordan@slcwitit.com" });
  assert.equal(tree.intent, "ct");
  assert.equal((await verifyProject(store, "rpg")).ok, true);
});

test("git adapter: grok trailers and Co-Authored-By map to actor id grok, not claude-code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-git-grok-"));
  const db = join(dir, "ledger.db");
  const env = { RETRACE_DB: db, RETRACE_PROJECT: "rpg" };
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "initial"]);
  sh(dir, "node", [bin, "install", "--repo", dir], env);
  writeFileSync(join(dir, "a.ts"), "export const a = 1.5;\n");
  sh(dir, "git", ["commit", "-qam", "seed db"], env);
  const grokRoot = await seedInstruct(db);

  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
  sh(dir, "git", ["commit", "-qam", `grok trailers\n\nRetrace-Actor: grok\nRetrace-Model: grok-4.6\nRetrace-Caused-By: ${grokRoot}\nCo-Authored-By: Grok <noreply@x.ai>`], env);
  writeFileSync(join(dir, "a.ts"), "export const a = 3;\n");
  sh(dir, "git", ["commit", "-qam", "grok coauthor only\n\nCo-Authored-By: Grok 4.6 <noreply@x.ai>"], env);

  const [trailed, coauthored] = (await new SqliteStore(db).all("rpg")).filter((e) => e.action === "committed").slice(-2);
  assert.deepEqual(trailed.actor, { type: "agent", id: "grok", model: "grok-4.6", on_behalf_of: "jordan@slcwitit.com" });
  assert.equal(trailed.caused_by, grokRoot);
  assert.deepEqual(coauthored.actor, { type: "agent", id: "grok", model: "grok-4-6", display_name: "Grok 4.6", on_behalf_of: "jordan@slcwitit.com" });
});

test("git adapter: Copilot Co-Authored-By maps to github-copilot, matching the Worker pin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-git-copilot-"));
  const db = join(dir, "ledger.db");
  const env = { RETRACE_DB: db, RETRACE_PROJECT: "rpg" };
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "initial"]);
  sh(dir, "node", [bin, "install", "--repo", dir], env);
  writeFileSync(join(dir, "a.ts"), "export const a = 1.5;\n");
  sh(dir, "git", ["commit", "-qam", "seed db"], env);
  const copilotRoot = await seedInstruct(db);

  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
  sh(dir, "git", ["commit", "-qam", `copilot trailers\n\nRetrace-Actor: github-copilot\nRetrace-Model: gpt-4.1\nRetrace-Caused-By: ${copilotRoot}\nCo-Authored-By: Copilot <noreply@github.com>`], env);
  writeFileSync(join(dir, "a.ts"), "export const a = 3;\n");
  sh(dir, "git", ["commit", "-qam", "copilot coauthor only\n\nCo-Authored-By: GitHub Copilot <noreply@github.com>"], env);

  const [trailed, coauthored] = (await new SqliteStore(db).all("rpg")).filter((e) => e.action === "committed").slice(-2);
  assert.deepEqual(trailed.actor, { type: "agent", id: "github-copilot", model: "gpt-4.1", on_behalf_of: "jordan@slcwitit.com" });
  assert.equal(trailed.caused_by, copilotRoot);
  assert.deepEqual(coauthored.actor, { type: "agent", id: "github-copilot", display_name: "GitHub Copilot", on_behalf_of: "jordan@slcwitit.com" });
});

test("git adapter: a stale Retrace-Caused-By still logs the commit, marked unverified", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-git-stale-"));
  const db = join(dir, "ledger.db");
  const env = { RETRACE_DB: db, RETRACE_PROJECT: "rpg" };
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "initial"]);
  sh(dir, "node", [bin, "install", "--repo", dir], env);
  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
  sh(dir, "git", ["commit", "-qam", "bump"], env);
  writeFileSync(join(dir, "a.ts"), "export const a = 3;\n");
  sh(dir, "git", ["commit", "-qam", "stale trailer\n\nRetrace-Actor: grok\nRetrace-Model: grok-4.6\nRetrace-Caused-By: evt_deadbeefdeadbeefdeadbeefdeadbeef"], env);

  const commits = (await new SqliteStore(db).all("rpg")).filter((e) => e.action === "committed");
  assert.equal(commits.length, 2, "hook must not drop a commit because the trailer names a missing event");
  const stale = commits[1];
  assert.equal(stale.actor.id, "grok");
  assert.equal(stale.caused_by, "evt_deadbeefdeadbeefdeadbeefdeadbeef");
  assert.ok(stale.tags?.includes("caused_by:unverified"));
  assert.equal(stale.method?.params?.caused_by_problem, "missing");
});

// ---- WHERE: the shared session key, and tty vs agent (see ttySurface) ----

test("ttySurface: reads the controlling terminal from /proc/self/stat, surviving the hook's own output redirection", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-tty-"));
  // Real shapes. Field 2 (comm) is parenthesised and may contain spaces AND parens — parsing must start after the LAST ")".
  const agent = join(dir, "agent"); writeFileSync(agent, "4242 (node) S 4240 4242 4242 0 -1 4194304 1234 0 0 0 5 1 0 0 20 0 11 0 999\n");
  const human = join(dir, "human"); writeFileSync(human, "4243 (git) S 4240 4243 4243 34819 4243 4194304 1234 0 0 0 5 1 0 0 20 0 1 0 999\n");
  const weird = join(dir, "weird"); writeFileSync(weird, "4244 (my (odd) proc) S 4240 4244 4244 34819 4244 4194304 1 0 0 0 1 1 0 0 20 0 1 0 9\n");
  assert.equal(ttySurface(agent), "agent", "tty_nr 0 = spawned by a harness, no controlling terminal");
  assert.equal(ttySurface(human), "tty", "tty_nr 34819 = a human typed git commit");
  assert.equal(ttySurface(weird), "tty", "comm containing spaces and parens still parses");
  assert.equal(ttySurface(join(dir, "does-not-exist")), undefined, "no /proc (macOS, Windows) → absent, not a guess");
  writeFileSync(join(dir, "short"), "4245 (node) S\n");
  assert.equal(ttySurface(join(dir, "short")), undefined, "a truncated stat line is absent, never a false 'tty'");
});

test("git adapter: a commit driven by an agent shell carries that shell's session; a human's own commit carries none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-git-sess-"));
  const db = join(dir, "ledger.db");
  const env = { RETRACE_DB: db, RETRACE_PROJECT: "rpg" };
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "initial"]);
  sh(dir, "node", [bin, "install", "--repo", dir], env);

  // (a) the hook inherits the harness env, exactly as it does when Claude Code runs `git commit` in its Bash tool
  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
  sh(dir, "git", ["commit", "-qam", "agent-driven"], { ...env, CLAUDE_CODE_SESSION_ID: "sess-abc", ORCA_WORKTREE_ID: "wt_9" });
  // (b) a human at their own terminal: neither var is set
  writeFileSync(join(dir, "a.ts"), "export const a = 3;\n");
  sh(dir, "git", ["commit", "-qam", "human-driven"], env);
  // (c) Grok Build TUI exports GROK_SESSION_ID, not CLAUDE_CODE_SESSION_ID
  writeFileSync(join(dir, "a.ts"), "export const a = 4;\n");
  sh(dir, "git", ["commit", "-qam", "grok-driven"], { ...env, GROK_SESSION_ID: "grok-sess-1" });

  const store = new SqliteStore(db);
  const [agentCommit, humanCommit, grokCommit] = await store.all("rpg");
  assert.equal(agentCommit.location?.session, "sess-abc", "joins the MCP events of the same session");
  assert.equal(agentCommit.location?.ide, "orca");
  assert.equal(agentCommit.location?.workspace, "wt_9");
  assert.ok(!("session" in (humanCommit.location ?? {})), "no random fallback — absence is what makes the key discriminating");
  assert.ok(!("ide" in (humanCommit.location ?? {})));
  assert.equal(humanCommit.location?.system, "git");
  assert.equal(humanCommit.location?.device, hostname());
  assert.equal(grokCommit.location?.session, "grok-sess-1", "Grok commits join Grok MCP events on GROK_SESSION_ID");
  // Which value depends on whether this suite was started from a real terminal — that is the point of the field, so
  // assert it is PRESENT and one of the two legal values rather than pinning the ambient tty (which would fail for a
  // developer running `npm test` in their own shell, and pass vacuously if the wiring were deleted).
  for (const e of [agentCommit, humanCommit, grokCommit]) assert.ok(e.location?.surface === "tty" || e.location?.surface === "agent", `hook stamped surface, got ${e.location?.surface}`);
  assert.equal((await verifyProject(store, "rpg")).ok, true);
});

test("git adapter: RETRACE_DEVICE overrides the hostname stamped into every commit event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-git-dev-"));
  const db = join(dir, "ledger.db");
  const env = { RETRACE_DB: db, RETRACE_PROJECT: "rpg" };
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.ts"), "1\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "initial"]);
  sh(dir, "node", [bin, "install", "--repo", dir], env);
  writeFileSync(join(dir, "a.ts"), "2\n");
  sh(dir, "git", ["commit", "-qam", "second"], { ...env, RETRACE_DEVICE: "workstation-7" });
  const [evt] = await new SqliteStore(db).all("rpg");
  assert.equal(evt.location?.device, "workstation-7", "a hostname is sealed un-redactably into a shareable body — capture time is the only control point");
});

test("git adapter: replay paths (backfill, `commit <sha>`) never stamp the replaying process's session/ide/surface", async () => {
  // These three fields describe the process that PRODUCED the commit, and only the post-commit hook is that process.
  // Backfilling someone's 2024 commits from an agent shell must not seal "this agent's session, in Orca, at a
  // terminal" onto them — that is fabricated WHERE evidence in an append-only, hash-covered ledger.
  const dir = mkdtempSync(join(tmpdir(), "retrace-git-replay-"));
  const db = join(dir, "ledger.db");
  const env = { RETRACE_DB: db, RETRACE_PROJECT: "rpg" };
  const agentEnv = { ...env, CLAUDE_CODE_SESSION_ID: "sess-now", ORCA_WORKTREE_ID: "wt_now" };
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.ts"), "1\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "old work"], { GIT_AUTHOR_DATE: "2024-03-04T10:00:00Z", GIT_COMMITTER_DATE: "2024-03-04T10:00:00Z" });

  // (a) backfill: history this process did not produce
  sh(dir, "node", [bin, "backfill", "--repo", dir], agentEnv);
  // (b) `commit <sha>`: the documented recovery when a hook run was dropped — still a replay, not the producing process
  writeFileSync(join(dir, "a.ts"), "2\n");
  sh(dir, "git", ["commit", "-qam", "second"]); // no hook installed, so nothing logged yet
  const sha = sh(dir, "git", ["rev-parse", "HEAD"]).trim();
  sh(dir, "node", [bin, "commit", "--repo", dir, sha], agentEnv);

  const events = await new SqliteStore(db).all("rpg");
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal(e.location?.system, "git", "the fields the replay DOES know are still stamped");
    assert.equal(e.location?.path, dir);
    for (const k of ["session", "ide", "workspace", "surface"]) {
      assert.ok(!(k in (e.location ?? {})), `replay must not stamp location.${k} (got ${JSON.stringify(e.location?.[k as "session"])})`);
    }
  }

  // ...and the live hook path, which IS the producing process, does stamp them — the flag the installed hook passes.
  sh(dir, "node", [bin, "install", "--repo", dir], env);
  assert.match(readFileSync(join(dir, ".git/hooks/post-commit"), "utf8"), /commit --hook /, "install writes the --hook flag that marks the live path");
  writeFileSync(join(dir, "a.ts"), "3\n");
  sh(dir, "git", ["commit", "-qam", "third"], agentEnv);
  const live = (await new SqliteStore(db).all("rpg"))[2];
  assert.equal(live.location?.session, "sess-now");
  assert.equal(live.location?.workspace, "wt_now");
});

// ---- Remote-write guard (2026-08-28: six junk events reached the live Worker from /tmp scratch repos) ----

test("guardRemoteWrite: a repo with no .retrace.json may not write to a remote ledger", () => {
  const wired = mkdtempSync(join(tmpdir(), "retrace-guard-wired-"));
  const scratch = mkdtempSync(join(tmpdir(), "retrace-guard-scratch-"));
  writeFileSync(join(wired, ".retrace.json"), JSON.stringify({ project: "rpg" }));
  const remote = { url: "https://retrace-api.example.workers.dev", project: "scratch" };

  assert.throws(() => guardRemoteWrite(scratch, remote), /refusing to log to the remote ledger/);
  // The message has to be actionable: it names the ledger, the repo, the project it would have created, and both ways out.
  assert.throws(() => guardRemoteWrite(scratch, remote), (e: Error) => {
    assert.match(e.message, /retrace-api\.example\.workers\.dev/);
    assert.ok(e.message.includes(scratch));
    assert.match(e.message, /project "scratch" would be created/);
    assert.match(e.message, /retrace-git install/);
    assert.match(e.message, /RETRACE_DB=/);
    assert.match(e.message, /--allow-remote/);
    return true;
  });

  guardRemoteWrite(wired, remote);                              // the committed marker permits it
  guardRemoteWrite(scratch, { ...remote, allowRemote: true });  // explicit one-run override
  guardRemoteWrite(scratch, { project: "scratch", db: "/tmp/x.db" }); // local writes are not gated — cheap to discard
  guardRemoteWrite(scratch, {});
});

test("git adapter: a scratch repo with RETRACE_URL in the env refuses to write, until install or --allow-remote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-guard-e2e-"));
  // Unroutable on purpose: if the guard ever regresses, the write fails loudly here instead of reaching a real ledger.
  const env = { RETRACE_URL: "http://127.0.0.1:1", RETRACE_TOKEN: "owner-token" };
  const run = (args: string[], extra: Record<string, string> = {}) => {
    try { return { ok: true, out: sh(dir, "node", args, { ...env, ...extra }) }; }
    catch (e: any) { return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
  };
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.ts"), "1\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "initial"]);
  assert.ok(!existsSync(join(dir, ".retrace.json")), "the shape of the incident: a repo never wired to Retrace");

  const blocked = run([bin, "commit", "--repo", dir]);
  assert.equal(blocked.ok, false);
  assert.match(blocked.out, /refusing to log to the remote ledger http:\/\/127\.0\.0\.1:1/);
  // The commit path still records why in the hook log, since the real hook discards stdout/stderr.
  assert.match(readFileSync(join(dir, ".git", "retrace-hook.log"), "utf8"), /NOT logged: refusing to log to the remote ledger/);

  // backfill is guarded too — it was the command that created three of the four junk projects
  assert.match(run([bin, "backfill", "--repo", dir]).out, /refusing to log to the remote ledger/);

  // Both escape hatches get past the guard: the failure that remains is the connection, not the refusal.
  for (const attempt of [run([bin, "commit", "--repo", dir, "--allow-remote"]), run([bin, "commit", "--repo", dir], { RETRACE_ALLOW_REMOTE: "1" })]) {
    assert.equal(attempt.ok, false, "still fails — 127.0.0.1:1 is unroutable");
    assert.doesNotMatch(attempt.out, /refusing to log/, "but not because of the guard");
  }

  // ...and so does the documented remedy, which is what makes the error message honest.
  sh(dir, "node", [bin, "install", "--repo", dir, "--project", "rpg"], env);
  assert.ok(existsSync(join(dir, ".retrace.json")));
  assert.doesNotMatch(run([bin, "commit", "--repo", dir]).out, /refusing to log/);
});

test("git adapter: install writes post-merge too; a real merge is sealed live as `merged`, a fast-forward seals nothing", async () => {
  // 2026-09-05: four checkpoint-PR merges in the retrace repo were never sealed by the hook, because git fires
  // post-merge (not post-commit) for `git merge`. They had to be replayed by hand as #1913–#1916.
  const dir = mkdtempSync(join(tmpdir(), "retrace-git-merge-"));
  const db = join(dir, "ledger.db");
  const env = { RETRACE_DB: db, RETRACE_PROJECT: "rpg" };
  const agentEnv = { ...env, CLAUDE_CODE_SESSION_ID: "sess-merge" };
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.ts"), "1\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "initial"]);

  const out = sh(dir, "node", [bin, "install", "--repo", dir], env);
  assert.match(out, /installed post-commit hook/);
  assert.match(out, /installed post-merge hook/);
  const mergeHook = readFileSync(join(dir, ".git/hooks/post-merge"), "utf8");
  assert.match(mergeHook, /Merge made by/, "post-merge must seal only when git's reflog says this invocation made a merge");
  assert.doesNotMatch(mergeHook, /HEAD\^2/, "a second parent is not proof this invocation made the merge (fast-forward onto someone else's merge commit)");
  assert.match(mergeHook, /commit --hook /, "a merge commit IS produced by this process: live path");

  // a branch with one commit (sealed by post-commit), merged back with --no-ff → a merge commit only post-merge sees
  sh(dir, "git", ["checkout", "-qb", "feature"]);
  writeFileSync(join(dir, "b.ts"), "2\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "feature work"], env);
  sh(dir, "git", ["checkout", "-q", "main"]);
  sh(dir, "git", ["merge", "-q", "--no-ff", "-m", "Merge branch 'feature'", "feature"], agentEnv);
  const mergeSha = sh(dir, "git", ["rev-parse", "HEAD"]).trim();

  let events = await new SqliteStore(db).all("rpg");
  assert.equal(events.length, 2, "feature commit + merge commit");
  const merged = events[1];
  assert.equal(merged.action, "merged");
  assert.equal(merged.artifacts[0].kind, "commit");
  assert.ok(merged.artifacts[0].id.endsWith(`@${mergeSha.slice(0, 12)}`), merged.artifacts[0].id);
  assert.ok(merged.tags?.includes("merge"));
  assert.equal(merged.location?.session, "sess-merge", "post-merge is the producing process, so it stamps like post-commit");

  // a fast-forward: HEAD moves to a commit this merge did not create → post-merge exits, nothing new is sealed
  sh(dir, "git", ["checkout", "-qb", "ff"]);
  writeFileSync(join(dir, "c.ts"), "3\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "ff work"]); // no env → post-commit has no ledger and logs nothing (hook is non-fatal)
  sh(dir, "git", ["checkout", "-q", "main"]);
  sh(dir, "git", ["merge", "-q", "--ff-only", "ff"], agentEnv);
  events = await new SqliteStore(db).all("rpg");
  assert.equal(events.length, 2, "a fast-forward produced no commit here, so post-merge must not seal HEAD");

  // Grok's case (2026-09-06): a fast-forward onto a merge commit ANOTHER process made — HEAD gains a second parent,
  // yet nothing was produced here. Build the merge on a side branch with no ledger (so nothing is sealed there), then
  // fast-forward main onto it from an agent shell: post-merge must stay silent.
  sh(dir, "git", ["checkout", "-qb", "theirs"]);
  sh(dir, "git", ["checkout", "-qb", "theirs-topic"]);
  writeFileSync(join(dir, "d.ts"), "4\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "their topic"]);
  sh(dir, "git", ["checkout", "-q", "theirs"]);
  sh(dir, "git", ["merge", "-q", "--no-ff", "-m", "their merge", "theirs-topic"]); // no ledger env → nothing sealed
  const theirMerge = sh(dir, "git", ["rev-parse", "HEAD"]).trim();
  sh(dir, "git", ["checkout", "-q", "main"]);
  sh(dir, "git", ["merge", "-q", "--ff-only", "theirs"], agentEnv);
  assert.equal(sh(dir, "git", ["rev-parse", "HEAD"]).trim(), theirMerge, "main fast-forwarded onto their merge commit");
  assert.equal(sh(dir, "git", ["rev-list", "--parents", "-1", "HEAD"]).trim().split(" ").length, 3, "HEAD now has two parents");
  events = await new SqliteStore(db).all("rpg");
  assert.equal(events.length, 2, "fast-forward onto someone else's merge commit: post-merge must not stamp this shell onto it");

  // uninstall removes both
  const un = sh(dir, "node", [bin, "uninstall", "--repo", dir], env);
  assert.match(un, /removed post-commit hook/);
  assert.match(un, /removed post-merge hook/);
  assert.ok(!existsSync(join(dir, ".git/hooks/post-merge")));
});

test("F12: actual hook path — unbootstrapped project /2 seal queues under shadow/enforce and appends nothing", async () => {
  async function run(mode: "off" | "shadow" | "enforce") {
    const dir = mkdtempSync(join(tmpdir(), `retrace-git-f12-${mode}-`));
    const kp = await generateSigningKey();
    const keyFile = join(dir, "hook.jwk");
    writeProducerPrivateKey(keyFile, kp.privateKey);
    const store = new MemoryEventStore();
    const h = createHandler(store, {
      token: "owner-token-long-enough",
      ownerPrincipal: { type: "human", id: "o" },
      trailerPolicy: mode,
      credentials: [{
        token: "tok-git-hook-assert-00000",
        name: "git hook (assert)",
        trust: "assert",
        actor: { type: "system", id: "retrace-git" },
        projects: ["rpg"],
        allowed_actors: [{ type: "human", id: "jordan@slcwitit.com" }],
        public_key: publicFromPrivate(kp.privateKey),
        require_signature: true,
      }],
    });
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        void (async () => {
          const url = `http://127.0.0.1${req.url}`;
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === "string") headers.set(k, v);
            else if (Array.isArray(v)) for (const item of v) headers.append(k, item);
          }
          const method = req.method ?? "GET";
          const r = await h(new Request(url, {
            method,
            headers,
            body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
          }));
          const outHeaders: Record<string, string> = {};
          r.headers.forEach((val, key) => { outHeaders[key] = val; });
          res.writeHead(r.status, outHeaders);
          res.end(Buffer.from(await r.arrayBuffer()));
        })();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const credFile = join(dir, "creds.json");
      writeFileSync(credFile, JSON.stringify([{ token: "tok-git-hook-assert-00000", actor: { type: "system", id: "retrace-git" }, trust: "assert" }]));
      sh(dir, "git", ["init", "-q", "-b", "main"]);
      writeFileSync(join(dir, ".retrace.json"), JSON.stringify({ project: "rpg", url, credential: "retrace-git" }));
      writeFileSync(join(dir, "a.ts"), "1\n");
      sh(dir, "git", ["add", "."]);
      sh(dir, "git", ["commit", "-qm", "initial"]);
      const sha = sh(dir, "git", ["rev-parse", "HEAD"]).trim();
      const env = {
        RETRACE_URL: url,
        RETRACE_CREDENTIALS_FILE: credFile,
        RETRACE_HOOK_KEY_FILE: keyFile,
      };
      if (mode === "off") {
        await shAsync(dir, "node", [bin, "commit", "--hook", "--repo", dir], env);
        assert.equal(store.events.filter((e) => e.action === "committed").length, 1);
        assert.ok(!existsSync(join(dir, ".git", "retrace-pending-seal")));
      } else {
        await assert.rejects(
          promisify(execFile)("node", [bin, "commit", "--hook", "--repo", dir], {
            cwd: dir,
            encoding: "utf8",
            env: { ...baseEnv, ...env },
          }),
          (error: any) => {
            assert.equal(error.code, 1);
            return true;
          },
        );
        assert.equal(store.events.length, 0, mode);
        assert.equal(readFileSync(join(dir, ".git", "retrace-pending-seal"), "utf8").trim(), sha);
      }
    } finally {
      server.close();
    }
  }
  await run("off");
  await run("shadow");
  await run("enforce");
});
