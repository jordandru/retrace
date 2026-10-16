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
import {
  canonicalize, generateSigningKey, keyId, publicFromPrivate, signProducer, verifyCanonical, verifyCheckpoint, verifyExportBundle, verifyProducerSig,
  type Checkpoint, type ExportBundle,
} from "@retrace-dev/core";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const schemaSql = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const TOKEN = "owner-token-for-the-workerd-signing-key-test";

// The test-only route /__test/produce (round 4) runs core's signProducer inside workerd with the configured key: the Worker has no
// producer-signing route of its own, and producer signing is one of the paths Codex r3 probed in workerd. /__test/race
// (round 5) runs Codex r4's probe inside workerd: it starts signCanonical with key a, changes the object's d to b's d either
// in a queued microtask while the pair check is pending or right after the check's derivation, then signs again with the
// same object. /__test/sign signs a given payload with a given key. /__test/hostile (round 6) builds a key whose reads
// throw, by a getter or a Proxy trap, and runs signCanonical and the public key route on it inside workerd.
const ENTRY = `
import worker from "./index.ts";
import { createHandler, MemoryEventStore, parseSigningKey, signCanonical, signProducer } from "@retrace-dev/core";
const logs = [];
for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = (...args) => { logs.push(args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(" ")); };
}
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/__test/logs") return Response.json(logs);
    if (path === "/__test/race") {
      const { a, bD, value, window } = await request.json();
      const key = { ...a };
      const subtle = crypto.subtle;
      const originalExport = subtle.exportKey;
      let first;
      if (window === "pending") {
        const pending = signCanonical(key, value);
        queueMicrotask(() => { key.d = bD; });
        first = await pending.then((sig) => ({ sig }), (e) => ({ error: String(e?.message ?? e) }));
      } else {
        subtle.exportKey = async (...args) => {
          const out = await originalExport.apply(subtle, args);
          key.d = bD;
          return out;
        };
        try {
          first = await signCanonical(key, value).then((sig) => ({ sig }), (e) => ({ error: String(e?.message ?? e) }));
        } finally {
          subtle.exportKey = originalExport;
        }
      }
      const second = await signCanonical(key, value).then((sig) => ({ sig }), (e) => ({ error: String(e?.message ?? e) }));
      return Response.json({ first, second, changed: key.d === bD });
    }
    if (path === "/__test/hostile") {
      const { jwk, mode, value, fragment } = await request.json();
      const leak = () => { throw new Error("leak " + fragment); };
      const reads = { note: 0 };
      let key = { ...jwk };
      if (mode === "note-getter") Object.defineProperty(key, "private_note", { enumerable: true, get() { reads.note++; leak(); } });
      else if (mode === "d-getter") Object.defineProperty(key, "d", { enumerable: true, get: leak });
      else if (mode === "proxy-get") key = new Proxy(key, { get: leak });
      else key = new Proxy(key, { ownKeys: leak });
      const signed = await signCanonical(key, value).then(
        (sig) => ({ sig }),
        (e) => ({ error: String(e?.message ?? e), stack: String(e?.stack ?? ""), hasCause: e?.cause !== undefined }),
      );
      const route = await createHandler(new MemoryEventStore(), { token: "t", signingKey: key })(new Request("http://retrace.test/.well-known/retrace-pubkey"));
      return Response.json({ signed, route: { status: route.status, body: await route.text() }, noteReads: reads.note });
    }
    if (path === "/__test/sign") {
      const { jwk, value } = await request.json();
      return Response.json(await signCanonical(jwk, value).then((sig) => ({ sig }), (e) => ({ error: String(e?.message ?? e) })));
    }
    if (path === "/__test/produce") {
      try {
        return Response.json(await signProducer(await request.json(), parseSigningKey(env.RETRACE_SIGNING_KEY)));
      } catch (e) {
        return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
      }
    }
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

const MISMATCH_MESSAGE = "signing key: JWK x is not the public key of d";
const PRODUCER_INPUT = {
  project: "p", actor: { type: "agent", id: "seat_FAKE" }, action: "created", artifacts: [{ id: "file:b.txt" }],
  timestamp: "2026-10-16T00:00:00.000Z", idempotency_key: "idem-r4-workerd",
};

/** A Worker in workerd with `key` as RETRACE_SIGNING_KEY, its schema applied and one event seeded in project p. */
async function workerWithKey(name: string, key: object): Promise<{ mf: Miniflare; db: D1Database }> {
  const script = await bundleWorker();
  const mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "retrace", modules: true, script,
      compatibilityDate: "2025-06-01", compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: `signing-r4-${name}` }, r2Buckets: { EXPORT_CACHE: `signing-r4-${name}` },
      bindings: { RETRACE_TOKEN: TOKEN, RETRACE_SIGNING_KEY: JSON.stringify(key), RETRACE_CHECKPOINT_PROJECTS: JSON.stringify(["p"]) },
      outboundService: () => new Response("no network in tests", { status: 503 }),
    }],
  }));
  const db = await mf.getD1Database("DB") as unknown as D1Database;
  for (const statement of schemaSql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean)) {
    if (/^INSERT OR IGNORE INTO event_artifact_index/.test(statement)) continue;
    try { await db.prepare(statement).run(); } catch (e) { if (!/duplicate column name/i.test(String((e as Error).message))) throw e; }
  }
  const seeded = await mf.dispatchFetch("http://retrace.test/events", {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ project: "p", actor: { type: "human", id: "owner@example.test" }, action: "created", artifacts: [{ id: "file:a.txt", role: "generated" }] }),
  });
  assert.equal(seeded.status, 201, await seeded.text());
  return { mf, db };
}

// Round 4 (Codex r3 Medium, evt_b320ac71): workerd signs with d alone, so before this round a shape-valid key whose x is
// not d's public key signed the head, a fresh export, a producer signature and the scheduled checkpoint, and none of
// those signatures verified against the published x. Every signing import now runs the pair check.
test("#232 r4 workerd: a d/x-mismatched key signs nothing on the signed head, a fresh export, producer signing or the scheduled checkpoint", { timeout: 300_000 }, async () => {
  const mismatched = { kty: "OKP", crv: "Ed25519", d: D, x: X }; // made up, shape-valid
  const { mf, db } = await workerWithKey("mismatch", mismatched);
  try {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const head = await mf.dispatchFetch("http://retrace.test/projects/p/head?signed=1", { headers: auth });
    const headText = await head.text();
    assert.equal(head.status, 500, `signed head: ${headText}`);
    assert.ok(!headText.includes("signature"), `signed head carries no signature: ${headText}`);
    assertNoFragment(headText, mismatched, "signed head response");

    const exported = await mf.dispatchFetch("http://retrace.test/projects/p/export?fresh=1", { headers: auth });
    const exportText = await exported.text();
    assert.equal(exported.status, 500, `fresh export: ${exportText.slice(0, 500)}`);
    assert.ok(!exportText.includes("signature"), "fresh export carries no signature");
    assertNoFragment(exportText, mismatched, "fresh export response");

    const produced = await mf.dispatchFetch("http://retrace.test/__test/produce", { method: "POST", body: JSON.stringify(PRODUCER_INPUT) });
    const producedText = await produced.text();
    assert.equal(produced.status, 500, `producer signing: ${producedText}`);
    assert.deepEqual(JSON.parse(producedText), { error: MISMATCH_MESSAGE });

    const worker = await mf.getWorker();
    assert.equal((await worker.scheduled({ cron: "7 * * * *" })).outcome, "ok");
    const checkpoints = await db.prepare("SELECT * FROM checkpoints").all();
    assert.equal(checkpoints.results.length, 0, "no checkpoint is stored");
    const refresh = await db.prepare("SELECT * FROM export_cache_refresh").all();
    assert.deepEqual(refresh.results.map((row) => (row as { result: string }).result), ["failed"], "the export cache refresh fails");
    assertNoFragment(JSON.stringify(refresh.results), mismatched, "export_cache_refresh rows");
    const cached = await (await mf.getR2Bucket("EXPORT_CACHE")).list();
    assert.equal(cached.objects.length, 0, "no cached export is stored");

    const logs = (await (await mf.dispatchFetch("http://retrace.test/__test/logs")).json() as string[]).join("\n");
    assert.match(logs, new RegExp(`retrace-api: request failed \\[[0-9a-f]{8}\\] GET /projects/p/head: Error: ${MISMATCH_MESSAGE}`), "the signed head's failure is logged");
    assert.match(logs, new RegExp(`retrace-api: request failed \\[[0-9a-f]{8}\\] GET /projects/p/export: Error: ${MISMATCH_MESSAGE}`), "the fresh export's failure is logged");
    assert.match(logs, new RegExp(`checkpoint cron failed: ${MISMATCH_MESSAGE}`), "the checkpoint's failure is logged");
    assertNoFragment(logs, mismatched, "logs");
  } finally {
    await mf.dispose();
  }
});

test("#232 r4 workerd: a valid key still signs the head, a fresh export, a producer signature and the checkpoint, each verifying against its x", { timeout: 300_000 }, async () => {
  const { privateKey } = await generateSigningKey();
  const publicKey = publicFromPrivate(privateKey);
  const { mf, db } = await workerWithKey("valid", privateKey);
  try {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const head = await mf.dispatchFetch("http://retrace.test/projects/p/head?signed=1", { headers: auth });
    assert.equal(head.status, 200);
    const { signature, issuer, ...payload } = await head.json() as { signature: string; issuer: { public_key: JsonWebKey } } & Record<string, unknown>;
    assert.equal(canonicalize(issuer.public_key), canonicalize(publicKey));
    assert.equal(await verifyCanonical(publicKey, payload, signature), true, "signed head verifies");

    const exported = await mf.dispatchFetch("http://retrace.test/projects/p/export?fresh=1", { headers: auth });
    assert.equal(exported.status, 200);
    const bundle = await exported.json() as ExportBundle;
    assert.equal((await verifyExportBundle(bundle, publicKey)).signature, "valid", "fresh export verifies");

    const produced = await mf.dispatchFetch("http://retrace.test/__test/produce", { method: "POST", body: JSON.stringify(PRODUCER_INPUT) });
    assert.equal(produced.status, 200);
    const signed = await produced.json() as Awaited<ReturnType<typeof signProducer>>;
    assert.equal(await verifyProducerSig(signed, publicKey), true, "producer signature verifies");
    const inNode = await signProducer(PRODUCER_INPUT as Parameters<typeof signProducer>[0], privateKey);
    assert.equal(signed.producer_sig.sig, inNode.producer_sig.sig, "workerd and Node sign the same bytes identically");

    const worker = await mf.getWorker();
    assert.equal((await worker.scheduled({ cron: "7 * * * *" })).outcome, "ok");
    const rows = (await db.prepare("SELECT checkpoint FROM checkpoints").all()).results as { checkpoint: string }[];
    assert.equal(rows.length, 1, "the checkpoint is stored");
    const cp = JSON.parse(rows[0]!.checkpoint) as Checkpoint;
    assert.equal((await verifyCheckpoint(cp, publicKey)).signature, "valid", "the stored checkpoint verifies");
  } finally {
    await mf.dispose();
  }
});

/** The round-5 known answer, computed with WebCrypto directly from the made-up seed D (see secret-parse.test.ts). */
const KAT = {
  jwk: { kty: "OKP", crv: "Ed25519", d: D, x: "yBHdHjNm5Hc0I5Oq3_KUZdY2WJ3h2bKPtJChR93BmKc" },
  value: { hash: "h", project: "p", seq: 3 },
  sig: "Yr70t_wi9PNqN1Arm62gq_aBvs_NsEJI53cbEm8EJ_ImSA_TQiSRZ_yYzQmfyWpd6QbMDB1PB_rL9-FDYtaxCw",
};

// Round 5 (Codex r4 Medium, evt_5c175362): Codex's probe changed d in a queued microtask while the pair check was pending;
// in workerd the round-4 code cached the changed pair and signCanonical signed with the changed d. Now the check and the
// import both use one snapshot taken before the first await, and nothing is cached.
test("#232 r5 workerd: a d changed during the pair check or before the import never signs; the next call checks again; a valid key gives the known answer", { timeout: 300_000 }, async () => {
  const a = await generateSigningKey();
  const b = await generateSigningKey();
  const { mf } = await workerWithKey("race", a.privateKey);
  try {
    const value = { n: 5 };
    for (const window of ["pending", "before-import"]) {
      const res = await mf.dispatchFetch("http://retrace.test/__test/race", { method: "POST", body: JSON.stringify({ a: a.privateKey, bD: b.privateKey.d, value, window }) });
      assert.equal(res.status, 200);
      const { first, second, changed } = await res.json() as { first: { sig?: string; error?: string }; second: { sig?: string; error?: string }; changed: boolean };
      assert.equal(changed, true, `${window}: the change landed`);
      if (first.error !== undefined) {
        assert.equal(first.error, MISMATCH_MESSAGE, `${window}: a refusal carries the fixed message`);
      } else {
        assert.equal(await verifyCanonical(publicFromPrivate(a.privateKey), value, first.sig!), true, `${window}: the signature verifies against the advertised x`);
        assert.equal(await verifyCanonical(publicFromPrivate(b.privateKey), value, first.sig!), false, `${window}: the changed d did not sign`);
      }
      assert.deepEqual(second, { error: MISMATCH_MESSAGE }, `${window}: the next call checks the changed object again; nothing was cached`);
    }
    const kat = await mf.dispatchFetch("http://retrace.test/__test/sign", { method: "POST", body: JSON.stringify({ jwk: KAT.jwk, value: KAT.value }) });
    assert.deepEqual(await kat.json(), { sig: KAT.sig }, "a valid key's signature in workerd is the known answer");
    const logs = (await (await mf.dispatchFetch("http://retrace.test/__test/logs")).json() as string[]).join("\n");
    assert.ok(![a.privateKey.d, b.privateKey.d].some((d) => logs.includes(d!)), "no d is logged");
  } finally {
    await mf.dispose();
  }
});

// Round 6 (Codex r5 Medium, evt_8ebc5f95): a getter or a Proxy trap on the signing key that throws an error carrying key
// text reached signCanonical's and the public key route's callers. The snapshot now reads only the members it copies,
// inside one boundary that throws a fixed error.
test("#232 r6 workerd: a throwing getter or Proxy trap on the signing key gives only fixed messages in signing and the public key route", { timeout: 300_000 }, async () => {
  const a = await generateSigningKey();
  const fragment = "tok_FAKEgetrWSXZ7391";
  const { mf } = await workerWithKey("hostile", a.privateKey);
  try {
    const value = { n: 6 };
    for (const mode of ["note-getter", "d-getter", "proxy-get", "proxy-ownkeys"]) {
      const res = await mf.dispatchFetch("http://retrace.test/__test/hostile", { method: "POST", body: JSON.stringify({ jwk: a.privateKey, mode, value, fragment }) });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes(fragment.slice(4)), `${mode}: no fragment in any result: ${text}`);
      const { signed, route, noteReads } = JSON.parse(text) as { signed: { sig?: string; error?: string; stack?: string; hasCause?: boolean }; route: { status: number; body: string }; noteReads: number };
      if (mode === "note-getter") {
        assert.equal(noteReads, 0, "private_note is never read");
        assert.equal(await verifyCanonical(publicFromPrivate(a.privateKey), value, signed.sig!), true, "the key signs as itself");
        assert.equal(route.status, 200);
        assert.equal((JSON.parse(route.body) as { public_key: JsonWebKey }).public_key.x, a.privateKey.x);
      } else {
        assert.equal(signed.error, "signing key: the JWK could not be read", `${mode}: the fixed message`);
        assert.equal(signed.hasCause, false, `${mode}: no cause`);
        assert.equal(route.status, 503, `${mode}: the route answers 503`);
        assert.deepEqual(JSON.parse(route.body), { error: "signing key is not a valid Ed25519 JWK" });
      }
    }
    const logs = (await (await mf.dispatchFetch("http://retrace.test/__test/logs")).json() as string[]).join("\n");
    assert.ok(!logs.includes(fragment.slice(4)), "no fragment is logged");
  } finally {
    await mf.dispose();
  }
});
