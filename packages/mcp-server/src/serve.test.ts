import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveServeConfig, startServer, isLoopbackHost, DEFAULT_HOST } from "./serve.js";

/** Env for a hermetic local server: a fresh SQLite file, no remote Worker, and none of the dev shell's tokens. */
const baseEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, HOME: process.env.HOME,
  RETRACE_DB: join(mkdtempSync(join(tmpdir(), "retrace-serve-")), "ledger.db"),
});

/** makeStore() reads process.env, so swap the relevant keys for the duration of a server's life. */
const withProcessEnv = async (vars: NodeJS.ProcessEnv, fn: () => Promise<void>) => {
  const keys = ["RETRACE_DB", "RETRACE_URL", "RETRACE_TOKEN", "RETRACE_CREDENTIALS", "RETRACE_HOST", "RETRACE_PORT", "RETRACE_OPEN", "RETRACE_SIGNING_KEY"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try { await fn(); } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};

const listen = (s: ReturnType<typeof startServer>) => new Promise<string>((resolve) => s.server.on("listening", () => {
  const a = s.server.address(); resolve(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`);
}));
const close = (s: ReturnType<typeof startServer>) => new Promise<void>((r) => s.server.close(() => r()));

test("resolveServeConfig: loopback + generated token by default; RETRACE_OPEN only on loopback; explicit token or credentials suppress generation", () => {
  const d = resolveServeConfig({});
  assert.equal(d.host, DEFAULT_HOST);
  assert.equal(d.open, false);
  assert.equal(d.generated, true);
  assert.ok(d.token && d.token.length >= 32, "a per-run token is generated when nothing is configured");

  const t = resolveServeConfig({ RETRACE_TOKEN: "abc" });
  assert.deepEqual([t.token, t.generated, t.open], ["abc", false, false]);

  const c = resolveServeConfig({ RETRACE_CREDENTIALS: JSON.stringify([{ token: "0123456789abcdef", actor: { type: "agent", id: "x" } }]) });
  assert.equal(c.token, undefined, "credentials alone are enough — no owner token is invented");
  assert.equal(c.generated, false);

  const o = resolveServeConfig({ RETRACE_OPEN: "1" });
  assert.deepEqual([o.open, o.token, o.generated], [true, undefined, false]);
  assert.equal(resolveServeConfig({ RETRACE_OPEN: "1", RETRACE_HOST: "localhost" }).open, true);
  assert.equal(resolveServeConfig({ RETRACE_OPEN: "1", RETRACE_HOST: "::1" }).open, true);
  assert.throws(() => resolveServeConfig({ RETRACE_OPEN: "1", RETRACE_HOST: "0.0.0.0" }), /loopback/);
  assert.throws(() => resolveServeConfig({ RETRACE_OPEN: "1", RETRACE_HOST: "192.168.1.5" }), /loopback/);

  const wide = resolveServeConfig({ RETRACE_HOST: "0.0.0.0" });
  assert.equal(wide.generated, true, "a wide bind without a token is still closed: a token is generated");

  for (const h of ["127.0.0.1", "127.9.9.9", "localhost", "::1", "[::1]"]) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ["0.0.0.0", "::", "10.0.0.2", "example.com"]) assert.equal(isLoopbackHost(h), false, h);
});

test("startServer: default binds 127.0.0.1 and refuses unauthenticated reads; the generated token works; RETRACE_OPEN=1 serves openly on loopback", async () => {
  await withProcessEnv(baseEnv(), async () => {
    const s = startServer({ port: 0 });
    const base = await listen(s);
    try {
      const addr = s.server.address();
      assert.equal(typeof addr === "object" && addr ? addr.address : "", "127.0.0.1");
      assert.equal(s.config.generated, true);
      assert.equal((await fetch(`${base}/projects`)).status, 401, "no token → 401");
      assert.equal((await fetch(`${base}/projects?token=wrong`)).status, 401);
      const ok = await fetch(`${base}/projects`, { headers: { authorization: `Bearer ${s.config.token}` } });
      assert.equal(ok.status, 200);
      assert.equal((await fetch(`${base}/projects?token=${s.config.token}`)).status, 200, "query token for the UI");
      assert.equal((await fetch(`${base}/api`)).status, 200, "the schema probe stays public");
    } finally { await close(s); }
  });

  await withProcessEnv({ ...baseEnv(), RETRACE_OPEN: "1" }, async () => {
    const s = startServer({ port: 0 });
    const base = await listen(s);
    try {
      assert.equal(s.config.open, true);
      assert.equal((await fetch(`${base}/projects`)).status, 200, "RETRACE_OPEN=1 → unauthenticated reads on loopback");
    } finally { await close(s); }
  });

  await withProcessEnv({ ...baseEnv(), RETRACE_OPEN: "1", RETRACE_HOST: "0.0.0.0" }, async () => {
    assert.throws(() => startServer({ port: 0 }), /loopback/);
  });
});
