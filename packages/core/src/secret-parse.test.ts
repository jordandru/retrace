// #232: no part of a secret's value may reach a log or an error that can reach one. V8's JSON.parse message quotes the
// start of its input and zod quotes the received value for some issue types, so each secret parse is tried here with a
// non-JSON value and with JSON that fails the schema in a way zod would quote. Every value below is made up.
import assert from "node:assert/strict";
import test from "node:test";
import {
  appendEvent, assertSigningJwk, assertSigningKeyPair, buildExportBundle, checkpointFromStore, createHandler, generateSigningKey,
  importSigningKey, keyId, MemoryEventStore, parseCredentials, parseSigningKey, publicFromPrivate, signCanonical, verifyCanonical,
  witnessCheckpointRekor,
} from "./index.js";

const NOT_JSON = "tok_FAKEqzwxVBNM7531";
/** Valid JSON, valid token length; `trust` and `actor.type` are invalid enum values, which zod's messages quote. */
const BAD_ENUMS = JSON.stringify([
  { token: "tok_FAKEplmoKIJN8642", actor: { type: "robot_FAKEuyhg", id: "seat_FAKEtrfd" }, trust: "tok_FAKEqwrtWSXE9753" },
]);

function stringLeaves(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(stringLeaves);
  if (v && typeof v === "object") return Object.values(v).flatMap(stringLeaves);
  return [];
}

/** The text carries no 4-character run of any input value. For a non-JSON input the value is the whole input; for JSON
 *  it is every string value — the keys are the schema's own names, which the issue paths name on purpose. */
function assertNoFragment(text: string, raw: string): void {
  let values: string[];
  try { values = stringLeaves(JSON.parse(raw)); } catch { values = [raw]; }
  for (const value of values) {
    for (let i = 0; i + 4 <= value.length; i++) {
      const gram = value.slice(i, i + 4);
      assert.ok(!text.includes(gram), `"${gram}" of an input value appears in: ${text}`);
    }
  }
}

function thrown(fn: () => unknown): Error {
  try { fn(); } catch (e) { return e as Error; }
  assert.fail("expected a throw");
}

test("#232 parseCredentials: a non-JSON secret throws a message that names no part of it", () => {
  const e = thrown(() => parseCredentials(NOT_JSON));
  assert.match(e.message, /^RETRACE_CREDENTIALS is malformed: not JSON$/);
  assertNoFragment(`${e.message}\n${e.stack}\n${String(e)}`, NOT_JSON);
  assert.equal((e as { cause?: unknown }).cause, undefined);
});

test("#232 parseCredentials: a schema failure names issue paths and codes, never a received value", () => {
  const e = thrown(() => parseCredentials(BAD_ENUMS));
  assert.match(e.message, /^RETRACE_CREDENTIALS is malformed: schema issues /);
  assert.match(e.message, /\[0\]\.actor\.type invalid_enum_value/);
  assert.match(e.message, /\[0\]\.trust invalid_enum_value/);
  assertNoFragment(`${e.message}\n${e.stack}\n${String(e)}`, BAD_ENUMS);
  assert.equal((e as { cause?: unknown }).cause, undefined);
});

test("#232 parseCredentials: the error names the secret it was given", () => {
  assert.match(thrown(() => parseCredentials(NOT_JSON, "RETRACE_CREDENTIALS_EXTRA")).message, /^RETRACE_CREDENTIALS_EXTRA is malformed: not JSON$/);
});

test("#232 parseSigningKey: a non-JSON secret throws the fixed message", () => {
  const e = thrown(() => parseSigningKey(NOT_JSON));
  assert.equal(e.message, "RETRACE_SIGNING_KEY is not a JWK (JSON or base64 JSON)");
  assertNoFragment(`${e.message}\n${e.stack}`, NOT_JSON);
});

test("#232 parseSigningKey: JSON that is not an Ed25519 JWK parses as before and fails at signing without quoting it", async () => {
  // parseSigningKey has no schema: it returns any JSON unchanged (behaviour kept). The bad key fails where it is used,
  // and since round 2 the shape check refuses it before any runtime import (workerd's own message is covered by
  // apps/worker/src/signing-key-leak.workerd.test.ts).
  const raw = JSON.stringify({ kty: "tok_FAKEktyQAZX4826", crv: "tok_FAKEcrvMNBV1593", d: "tok_FAKEdddPOIU1357", x: "tok_FAKExxxLKJH2468" });
  const key = parseSigningKey(raw);
  assert.deepEqual(key, JSON.parse(raw));
  const e = await signCanonical(key as JsonWebKey, { a: 1 }).then(() => assert.fail("expected a rejection"), (err: Error) => err);
  assert.equal(e.message, "signing key: JWK kty is missing or invalid");
  assertNoFragment(`${e.message}\n${e.stack}`, raw);
});

// Round 2 (Codex r1 Medium, evt_73cc3ae7): each field of the signing JWK is checked before the runtime import, and every
// runtime import of the key is wrapped so the runtime's own message cannot survive.
const fake43 = (seed: string) => seed.repeat(4).slice(0, 42) + "A";
const D = fake43("Fq3Rz8Wv2Kc6Jm9Xb4Nt");
const X = fake43("Hy1Gp5Ld0SaUe8QoTi2Y");
const MALFORMED: [field: string, jwk: Record<string, unknown>][] = [
  ["kty", { kty: "tok_FAKEktyQAZX4826", crv: "Ed25519", d: D, x: X }],
  ["crv", { kty: "OKP", crv: "tok_FAKEcrvMNBV1593", d: D, x: X }],
  ["d", { kty: "OKP", crv: "Ed25519", d: "tok_FAKEdddPOIU1357", x: X }],
  ["d", { kty: "OKP", crv: "Ed25519", x: X }],
  ["x", { kty: "OKP", crv: "Ed25519", d: D, x: X.slice(0, 42) + "B" }],
  ["x", { kty: "OKP", crv: "Ed25519", d: D, x: 7 }],
];
/** The algorithm's public names are not key material; every other value is checked. */
const material = (jwk: Record<string, unknown>) => JSON.stringify(Object.values(jwk).map(String).filter((v) => v !== "OKP" && v !== "Ed25519"));

test("#232 r2 signCanonical: each malformed field is refused before import with a fixed message naming only that field", async () => {
  for (const [field, jwk] of MALFORMED) {
    const e = await signCanonical(jwk as JsonWebKey, { a: 1 }).then(() => assert.fail(`expected a rejection for ${field}`), (err: Error) => err);
    assert.equal(e.message, `signing key: JWK ${field} is missing or invalid`);
    assert.equal((e as { cause?: unknown }).cause, undefined);
    assertNoFragment(`${e.message}\n${e.stack}`, material(jwk));
  }
  for (const notObject of [null, "tok_FAKEqzwxVBNM7531", ["tok_FAKEqzwxVBNM7531"]]) {
    const e = await signCanonical(notObject as unknown as JsonWebKey, {}).then(() => assert.fail("expected a rejection"), (err: Error) => err);
    assert.equal(e.message, "signing key: not a JWK object");
  }
});

test("#232 r2 importSigningKey: a runtime refusal becomes a fixed error with no runtime message or cause", async () => {
  // Well-shaped, but `key_ops` forbids signing, so the runtime refuses the import with its own message.
  const { privateKey } = await generateSigningKey();
  const jwk = { ...privateKey, key_ops: ["tok_FAKEopsZXCV2648"] } as JsonWebKey;
  const e = await importSigningKey(jwk).then(() => assert.fail("expected a rejection"), (err: Error) => err);
  assert.equal(e.message, "signing key: the runtime refused to import the JWK");
  assert.equal((e as { cause?: unknown }).cause, undefined);
  assertNoFragment(`${e.message}\n${e.stack}`, JSON.stringify(["tok_FAKEopsZXCV2648", privateKey.d, privateKey.x]));
});

test("#232 r2 a valid signing key signs and verifies exactly as before", async () => {
  const { privateKey, publicKey } = await generateSigningKey();
  assertSigningJwk(privateKey);
  const sig = await signCanonical(privateKey, { a: 1 });
  assert.equal(await verifyCanonical(publicKey, { a: 1 }, sig), true);
  const key = await importSigningKey({ ...privateKey, alg: "Ed25519" } as JsonWebKey);
  assert.equal(key.type, "private");
});

test("#232 r2 witnessCheckpointRekor: a malformed key is refused before its x is read, and nothing is sent", async () => {
  const { privateKey } = await generateSigningKey();
  const store = new MemoryEventStore();
  await appendEvent(store, { project: "p", actor: { type: "human", id: "owner@example.test" }, action: "created", artifacts: [{ id: "file:a.txt" }] });
  const cp = await checkpointFromStore(store, "p", { signingKey: privateKey });
  let fetched = 0;
  for (const [field, jwk] of MALFORMED) {
    const e = await witnessCheckpointRekor(cp, jwk as JsonWebKey, { fetchImpl: async () => { fetched++; throw new Error("no network in tests"); } })
      .then(() => assert.fail("expected a rejection"), (err: Error) => err);
    assert.equal(e.message, `signing key: JWK ${field} is missing or invalid`);
    assertNoFragment(`${e.message}\n${e.stack}`, material(jwk));
  }
  assert.equal(fetched, 0);
});

test("#232 r2 GET /.well-known/retrace-pubkey publishes no field of a malformed key; a valid key is served as before", async () => {
  for (const [, jwk] of MALFORMED) {
    const h = createHandler(new MemoryEventStore(), { token: "owner-token-for-the-pubkey-test", signingKey: jwk as JsonWebKey });
    const res = await h(new Request("http://retrace.test/.well-known/retrace-pubkey"));
    const body = await res.text();
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(body), { error: "signing key is not a valid Ed25519 JWK" });
    assertNoFragment(body, material(jwk));
  }
  const { privateKey, publicKey, kid } = await generateSigningKey();
  const h = createHandler(new MemoryEventStore(), { token: "owner-token-for-the-pubkey-test", signingKey: privateKey });
  const res = await h(new Request("http://retrace.test/.well-known/retrace-pubkey"));
  assert.equal(res.status, 200);
  const served = await res.json() as { kid: string; public_key: JsonWebKey };
  assert.equal(served.kid, kid);
  assert.equal(served.public_key.x, publicKey.x);
  assert.equal("d" in served.public_key, false);
});

// Round 3 (Codex r2 Medium, evt_21e24853): the public key route derives x from d before it serves anything, and every
// public JWK is built from an allowlist of public members, so neither a mismatched key nor an extension member of the
// configured secret is published.

/** main's publicFromPrivate before round 3, kept here only to show that a valid key serialises exactly as it did. */
function publicFromPrivateBeforeR3(priv: JsonWebKey): JsonWebKey {
  const { d: _d, key_ops: _k, ...pub } = priv as Record<string, unknown>;
  return { ...pub, key_ops: ["verify"] } as JsonWebKey;
}

const PUBKEY_TOKEN = "owner-token-for-the-pubkey-test";
const getPubkey = (signingKey: JsonWebKey) =>
  createHandler(new MemoryEventStore(), { token: PUBKEY_TOKEN, signingKey })(new Request("http://retrace.test/.well-known/retrace-pubkey"));

test("#232 r3 GET /.well-known/retrace-pubkey refuses a shape-valid key whose x is not d's public key", async () => {
  // Both values are made up and canonical 32-byte base64url: the round-2 shape check passes, which is what let it through.
  const mismatched = { kty: "OKP", crv: "Ed25519", d: D, x: X };
  assertSigningJwk(mismatched);
  const res = await getPubkey(mismatched as JsonWebKey);
  const body = await res.text();
  assert.equal(res.status, 503);
  assert.deepEqual(JSON.parse(body), { error: "signing key is not a valid Ed25519 JWK" });
  assertNoFragment(body, material(mismatched));
  const e = await assertSigningKeyPair(mismatched).then(() => assert.fail("expected a rejection"), (err: Error) => err);
  assert.equal(e.message, "signing key: JWK x is not the public key of d");
  assert.equal((e as { cause?: unknown }).cause, undefined);
  assertNoFragment(`${e.message}\n${e.stack}`, material(mismatched));
  // A real pair with its x swapped for another key's x is refused the same way; the pair itself passes.
  const a = await generateSigningKey();
  const b = await generateSigningKey();
  assert.equal((await getPubkey({ ...a.privateKey, x: b.publicKey.x })).status, 503);
  await assertSigningKeyPair(a.privateKey);
  // The malformed keys of round 2 still fail the shape check first, with its field-naming message.
  for (const [field, jwk] of MALFORMED) {
    const m = await assertSigningKeyPair(jwk).then(() => assert.fail(`expected a rejection for ${field}`), (err: Error) => err);
    assert.equal(m.message, `signing key: JWK ${field} is missing or invalid`);
  }
});

test("#232 r3 publicFromPrivate copies only allowlisted public members of the expected type", () => {
  const jwk = {
    private_note: "tok_FAKEnoteRFVB4739", kty: "OKP", crv: "Ed25519", d: D, x: X,
    kid: { nested: "tok_FAKEkidnUJMK2846" }, ext: "tok_FAKEextYHNM5173", key_ops: ["sign"], oth: [{ d: "tok_FAKEothhWSXC9517" }],
  };
  assert.equal(JSON.stringify(publicFromPrivate(jwk as unknown as JsonWebKey)), JSON.stringify({ kty: "OKP", crv: "Ed25519", x: X, key_ops: ["verify"] }));
});

test("#232 r3 an extension member of the signing key is published nowhere: public key route, signed head, checkpoint, export", async () => {
  const { privateKey } = await generateSigningKey();
  const extras = { private_note: "tok_FAKEnoteRFVB4739", retrace_meta: { token: "tok_FAKEmetaOLPK3591" } };
  const signingKey = { ...privateKey, ...extras } as JsonWebKey;
  const expected = JSON.stringify(publicFromPrivateBeforeR3(privateKey));
  const leaks = JSON.stringify(stringLeaves(extras));
  const check = (where: string, text: string, publicKey: unknown) => {
    assert.equal(JSON.stringify(publicKey), expected, `${where}: the public JWK is the valid key's, member for member`);
    assertNoFragment(text, leaks);
    assert.ok(!text.includes(privateKey.d!), `${where}: d is not published`);
  };

  const store = new MemoryEventStore();
  await appendEvent(store, { project: "p", actor: { type: "human", id: "owner@example.test" }, action: "created", artifacts: [{ id: "file:a.txt" }] });
  const h = createHandler(store, { token: PUBKEY_TOKEN, signingKey });

  const route = await h(new Request("http://retrace.test/.well-known/retrace-pubkey"));
  assert.equal(route.status, 200);
  const routeText = await route.text();
  check("public key route", routeText, JSON.parse(routeText).public_key);

  const head = await h(new Request("http://retrace.test/projects/p/head?signed=1", { headers: { authorization: `Bearer ${PUBKEY_TOKEN}` } }));
  assert.equal(head.status, 200);
  const headText = await head.text();
  check("signed head", headText, JSON.parse(headText).issuer.public_key);

  const cp = await checkpointFromStore(store, "p", { signingKey });
  check("checkpoint", JSON.stringify(cp), cp.signer!.public_key);

  const bundle = await buildExportBundle(store, { project: "p" }, { signingKey });
  check("export bundle", JSON.stringify(bundle), bundle.issuer!.public_key);
});

test("#232 r3 a valid key is served byte for byte as before round 3", async () => {
  const generated = (await generateSigningKey()).privateKey as Record<string, unknown>;
  // The deployed key's member order, read from the live route on 2026-10-15: ext, alg, crv, (d), x, kty, kid; no key_ops.
  const deployedShape = { ext: generated.ext, alg: generated.alg, crv: generated.crv, d: generated.d, x: generated.x, kty: generated.kty, kid: generated.kid };
  const bare = { kty: "OKP", crv: "Ed25519", d: generated.d, x: generated.x };
  for (const key of [generated, deployedShape, bare] as JsonWebKey[]) {
    const before = publicFromPrivateBeforeR3(key);
    assert.equal(JSON.stringify(publicFromPrivate(key)), JSON.stringify(before));
    const res = await getPubkey(key);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), JSON.stringify({ kid: await keyId(before), alg: "Ed25519", public_key: before }));
  }
});
