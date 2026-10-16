/**
 * #232 round 2 (Codex r1 Medium, evt_73cc3ae7): a malformed RETRACE_SIGNING_KEY must not reach Workers Logs, a response,
 * or a stored refresh error through workerd's own WebCrypto messages, which quote a bad `kty` or `crv` value. The real
 * Worker, bundled from src/index.ts, runs in workerd through Miniflare with a made-up malformed key. A test-only entry
 * captures every console line inside the isolate. The test drives the production router to a fresh export and to the
 * public key route, then runs the scheduled handler (checkpoint cron and export-cache refresh), and asserts that no
 * 4-character run of any made-up key value appears in a logged line, a response body, or a stored refresh row.
 * Every value is made up; outbound fetches get a 503.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateSigningKey, keyId } from "@retrace-dev/core";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const schemaSql = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const TOKEN = "owner-token-for-the-workerd-signing-key-test";

const ENTRY = `
import worker from "./index.ts";
const logs = [];
for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = (...args) => { logs.push(args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(" ")); };
}
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/__test/logs") return Response.json(logs);
    return worker.fetch(request, env, ctx);
  },
  scheduled: (controller, env, ctx) => worker.scheduled(controller, env, ctx),
};
`;

/** 43 characters of canonical unpadded base64url (the last one carries zero spare bits), made up. */
const fake43 = (seed: string) => seed.repeat(4).slice(0, 42) + "A";
const D = fake43("Fq3Rz8Wv2Kc6Jm9Xb4Nt");
const X = fake43("Hy1Gp5Ld0SaUe8QoTi2Y");
const CASES: { field: string; jwk: Record<string, string> }[] = [
  { field: "kty", jwk: { kty: "tok_FAKEktyQAZX4826", crv: "Ed25519", d: D, x: X } },
  { field: "crv", jwk: { kty: "OKP", crv: "tok_FAKEcrvMNBV1593", d: D, x: X } },
  { field: "d", jwk: { kty: "OKP", crv: "Ed25519", d: "tok_FAKEdddPOIU1357", x: X } },
  { field: "x", jwk: { kty: "OKP", crv: "Ed25519", d: D, x: X.slice(0, 42) + "B" } },
];

/** The algorithm's public names are not key material; every other value of the made-up key is checked. */
function assertNoFragment(text: string, jwk: Record<string, string>, where: string): void {
  for (const value of Object.values(jwk).filter((v) => v !== "OKP" && v !== "Ed25519")) {
    for (let i = 0; i + 4 <= value.length; i++) {
      const gram = value.slice(i, i + 4);
      assert.ok(!text.includes(gram), `${where}: "${gram}" of a made-up key value appears in: ${text.slice(0, 2000)}`);
    }
  }
}

let bundling: Promise<string> | undefined;
/** The real Worker behind the log-capturing entry, bundled once for both tests. */
function bundleWorker(): Promise<string> {
  return bundling ??= build({
    stdin: { contents: ENTRY, resolveDir: SRC, sourcefile: "signing-key-test-entry.js", loader: "js" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022",
    conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], external: ["node:*", "cloudflare:*"], logLevel: "silent",
  }).then((bundled) => bundled.outputFiles[0]!.text);
}

test("#232 workerd: a malformed RETRACE_SIGNING_KEY leaks no fragment through a fresh export, the public key route, or the scheduled run", { timeout: 300_000 }, async () => {
  const script = await bundleWorker();
  for (const { field, jwk } of CASES) {
    const mf = new Miniflare(convertV4MiniflareOptions({
      workers: [{
        name: "retrace", modules: true, script,
        compatibilityDate: "2025-06-01", compatibilityFlags: ["nodejs_compat"],
        d1Databases: { DB: `signing-key-${field}` }, r2Buckets: { EXPORT_CACHE: `signing-key-${field}` },
        bindings: { RETRACE_TOKEN: TOKEN, RETRACE_SIGNING_KEY: JSON.stringify(jwk), RETRACE_CHECKPOINT_PROJECTS: JSON.stringify(["p"]) },
        outboundService: () => new Response("no network in tests", { status: 503 }),
      }],
    }));
    try {
      const db = await mf.getD1Database("DB") as unknown as D1Database;
      for (const statement of schemaSql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean)) {
        if (/^INSERT OR IGNORE INTO event_artifact_index/.test(statement)) continue;
        try { await db.prepare(statement).run(); } catch (e) { if (!/duplicate column name/i.test(String((e as Error).message))) throw e; }
      }
      const auth = { authorization: `Bearer ${TOKEN}` };
      const seeded = await mf.dispatchFetch("http://retrace.test/events", {
        method: "POST", headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ project: "p", actor: { type: "human", id: "owner@example.test" }, action: "created", artifacts: [{ id: "file:a.txt", role: "generated" }] }),
      });
      assert.equal(seeded.status, 201, await seeded.text());

      const exported = await mf.dispatchFetch("http://retrace.test/projects/p/export?fresh=1", { headers: auth });
      const exportBody = await exported.text();
      assert.equal(exported.status, 500, `${field}: a fresh export with a malformed key still fails`);
      assertNoFragment(exportBody, jwk, `${field} export response`);

      const pubkey = await mf.dispatchFetch("http://retrace.test/.well-known/retrace-pubkey");
      const pubkeyBody = await pubkey.text();
      assert.notEqual(pubkey.status, 200, `${field}: the public key route publishes no malformed key`);
      assertNoFragment(pubkeyBody, jwk, `${field} public key response`);

      const worker = await mf.getWorker();
      assert.equal((await worker.scheduled({ cron: "7 * * * *" })).outcome, "ok");
      const refresh = await db.prepare("SELECT * FROM export_cache_refresh").all();
      assertNoFragment(JSON.stringify(refresh.results), jwk, `${field} export_cache_refresh rows`);

      const logs = await (await mf.dispatchFetch("http://retrace.test/__test/logs")).json() as string[];
      const all = logs.join("\n");
      assert.match(all, new RegExp(`retrace-api: request failed \\[[0-9a-f]{8}\\] GET /projects/p/export: Error: signing key: JWK ${field} is missing or invalid`), `${field}: the export failure is still logged`);
      assert.match(all, /checkpoint cron failed: signing key: /, `${field}: the cron failure is still logged`);
      assertNoFragment(all, jwk, `${field} logs`);
    } finally {
      await mf.dispose();
    }
  }
});

/** main's publicFromPrivate before round 3, kept here only to show that a valid key is served exactly as it was. */
function publicFromPrivateBeforeR3(priv: JsonWebKey): JsonWebKey {
  const { d: _d, key_ops: _k, ...pub } = priv as unknown as Record<string, unknown>;
  return { ...pub, key_ops: ["verify"] } as JsonWebKey;
}

// Round 3 (Codex r2 Medium, evt_21e24853): in workerd too, the public key route derives x from d (d imported alone, as
// PKCS #8) and refuses a mismatch, and it builds the public JWK from an allowlist of public members.
test("#232 r3 workerd: the public key route refuses a d/x mismatch, publishes no extension member, and serves a valid key as before", { timeout: 300_000 }, async () => {
  const script = await bundleWorker();
  const { privateKey } = await generateSigningKey();
  const NOTE = "tok_FAKEnoteRFVB4739";
  const validBody = JSON.stringify({ kid: await keyId(publicFromPrivateBeforeR3(privateKey)), alg: "Ed25519", public_key: publicFromPrivateBeforeR3(privateKey) });
  const cases: { name: string; key: object; status: number; body: string; secrets: Record<string, string> }[] = [
    { name: "mismatch", key: { kty: "OKP", crv: "Ed25519", d: D, x: X }, status: 503, body: JSON.stringify({ error: "signing key is not a valid Ed25519 JWK" }), secrets: { d: D, x: X } },
    { name: "extension member", key: { ...privateKey, private_note: NOTE }, status: 200, body: validBody, secrets: { note: NOTE } },
    { name: "valid", key: privateKey, status: 200, body: validBody, secrets: {} },
  ];
  for (const { name, key, status, body, secrets } of cases) {
    const mf = new Miniflare(convertV4MiniflareOptions({
      workers: [{
        name: "retrace", modules: true, script,
        compatibilityDate: "2025-06-01", compatibilityFlags: ["nodejs_compat"],
        d1Databases: { DB: `pubkey-r3-${name}` }, r2Buckets: { EXPORT_CACHE: `pubkey-r3-${name}` },
        bindings: { RETRACE_TOKEN: TOKEN, RETRACE_SIGNING_KEY: JSON.stringify(key) },
        outboundService: () => new Response("no network in tests", { status: 503 }),
      }],
    }));
    try {
      const res = await mf.dispatchFetch("http://retrace.test/.well-known/retrace-pubkey");
      const text = await res.text();
      assert.equal(res.status, status, `${name}: ${text}`);
      assert.equal(text, body, `${name}: the exact response body`);
      assertNoFragment(text, secrets, `${name} public key response`);
      assert.ok(!text.includes(privateKey.d!), `${name}: d is not published`);
      const logs = await (await mf.dispatchFetch("http://retrace.test/__test/logs")).json() as string[];
      assertNoFragment(logs.join("\n"), { ...secrets, d: (key as { d?: string }).d ?? "" }, `${name} logs`);
    } finally {
      await mf.dispose();
    }
  }
});
