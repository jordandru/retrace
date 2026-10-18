// #232: no part of a secret's value may reach a log or an error that can reach one. V8's JSON.parse message quotes the
// start of its input and zod quotes the received value for some issue types, so each secret parse is tried here with a
// non-JSON value and with JSON that fails the schema in a way zod would quote. Every value below is made up.
import assert from "node:assert/strict";
import test from "node:test";
import {
  appendEvent, assertSigningJwk, assertSigningKeyPair, buildExportBundle, checkpointFromStore, createHandler, generateSigningKey,
  importSigningKey, keyId, MemoryEventStore, parseCredentials, parseSigningKey, publicFromPrivate, signCanonical, signProducer, snapshotSigningKey,
  verifyCanonical, verifyProducerSig, witnessCheckpointRekor,
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

// Round 4 (Codex r3 Medium, evt_b320ac71): every signing import runs the d↔x pair check, not only the public key route.
// workerd signs with d alone, so there a mismatched key signed artifacts its published x cannot verify; Node refuses the
// mismatched JWK at import, so here the change shows as the pair check's own message in place of the import refusal.
// The workerd regressions are in apps/worker/src/signing-key-leak.workerd.test.ts.
const MISMATCH_MESSAGE = "signing key: JWK x is not the public key of d";

test("#232 r4 every signing path refuses a shape-valid d/x mismatch with the pair check's fixed message", async () => {
  const mismatched = { kty: "OKP", crv: "Ed25519", d: D, x: X } as JsonWebKey; // made up, shape-valid
  const store = new MemoryEventStore();
  await appendEvent(store, { project: "p", actor: { type: "human", id: "owner@example.test" }, action: "created", artifacts: [{ id: "file:a.txt" }] });
  const input = { project: "p", actor: { type: "agent" as const, id: "seat_FAKE" }, action: "created" as const, artifacts: [{ id: "file:b.txt" }], timestamp: "2026-10-16T00:00:00.000Z", idempotency_key: "idem-r4" };
  const paths: [string, () => Promise<unknown>][] = [
    ["importSigningKey", () => importSigningKey(mismatched)],
    ["signCanonical", () => signCanonical(mismatched, { a: 1 })],
    ["signProducer", () => signProducer(input, mismatched)],
    ["checkpointFromStore", () => checkpointFromStore(store, "p", { signingKey: mismatched })],
    ["buildExportBundle", () => buildExportBundle(store, { project: "p" }, { signingKey: mismatched })],
  ];
  for (const [name, run] of paths) {
    const e = await run().then(() => assert.fail(`${name}: expected a rejection`), (err: Error) => err);
    assert.equal(e.message, MISMATCH_MESSAGE, name);
    assert.equal((e as { cause?: unknown }).cause, undefined, name);
    assertNoFragment(`${e.message}\n${e.stack}`, material(mismatched as Record<string, unknown>));
  }
  // The signed head answers no signature; its failure goes to the router's log with the same fixed message.
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const h = createHandler(store, { token: PUBKEY_TOKEN, signingKey: mismatched });
    const head = await h(new Request("http://retrace.test/projects/p/head?signed=1", { headers: { authorization: `Bearer ${PUBKEY_TOKEN}` } }));
    const body = await head.text();
    assert.equal(head.status, 500);
    assert.ok(!body.includes("signature"), body);
    assertNoFragment(body, material(mismatched as Record<string, unknown>));
  } finally {
    console.error = original;
  }
  assert.match(logged.join("\n"), new RegExp(MISMATCH_MESSAGE));
  assertNoFragment(logged.join("\n"), material(mismatched as Record<string, unknown>));
});

// Round 5 replaced the round-4 test "the pair check runs once per key object, and again when its d or x changes": that
// test asserted the per-object cache, which round 5 removes (Codex r4 Medium, Jordan's go evt_63b2c171).
test("#232 r5 every signing import derives the public key again; nothing is cached", async () => {
  const subtle = globalThis.crypto.subtle as SubtleCrypto & { importKey: SubtleCrypto["importKey"] };
  const original = subtle.importKey;
  let derivations = 0;
  subtle.importKey = (async (...args: Parameters<SubtleCrypto["importKey"]>) => {
    if (args[0] === "pkcs8") derivations++;
    return (original as (...a: unknown[]) => Promise<CryptoKey>).apply(subtle, args);
  }) as SubtleCrypto["importKey"];
  try {
    const a = await generateSigningKey();
    const b = await generateSigningKey();
    const key = { ...a.privateKey } as JsonWebKey;
    await signCanonical(key, { n: 1 });
    await signCanonical(key, { n: 2 });
    await importSigningKey(key);
    assert.equal(derivations, 3, "one derivation for each of three signing imports of one key object");
    (key as { x?: string }).x = b.publicKey.x;
    const e = await signCanonical(key, { n: 3 }).then(() => assert.fail("expected a rejection"), (err: Error) => err);
    assert.equal(e.message, MISMATCH_MESSAGE);
    assert.equal(derivations, 4);
  } finally {
    subtle.importKey = original;
  }
});

test("#232 r4 a valid key's signatures are byte for byte those of a direct WebCrypto signature", async () => {
  const { privateKey, publicKey } = await generateSigningKey();
  const { alg: _alg, ...importable } = privateKey as Record<string, unknown>;
  const direct = await crypto.subtle.importKey("jwk", importable as JsonWebKey, { name: "Ed25519" }, false, ["sign"]);
  const value = { hash: "h", project: "p", seq: 3 }; // keys already in canonical (sorted) order
  const expected = Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, direct, new TextEncoder().encode(JSON.stringify(value))))
    .toString("base64url");
  assert.equal(await signCanonical(privateKey, value), expected);
  const input = { project: "p", actor: { type: "agent" as const, id: "seat_FAKE" }, action: "created" as const, artifacts: [{ id: "file:b.txt" }], timestamp: "2026-10-16T00:00:00.000Z", idempotency_key: "idem-r4" };
  assert.equal(await verifyProducerSig(await signProducer(input, privateKey), publicKey), true);
});

// Round 5 (Codex r4 Medium, evt_5c175362; Jordan's go evt_63b2c171, "drop the cache"): the key's members are read once,
// synchronously, before any await, and the check, the import and every publisher's embedded key use that snapshot. Codex
// changed `d` in a queued microtask while the pair check was pending; the round-4 code then cached and signed with it.

/** Run `fn` with one method of the shared SubtleCrypto replaced, then put it back. */
async function withSubtle<R>(name: "exportKey" | "importKey" | "digest", replace: (original: (...a: unknown[]) => Promise<unknown>) => (...a: unknown[]) => Promise<unknown>, fn: () => Promise<R>): Promise<R> {
  const subtle = globalThis.crypto.subtle as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const original = subtle[name]!;
  subtle[name] = replace((...a: unknown[]) => original.apply(globalThis.crypto.subtle, a));
  try {
    return await fn();
  } finally {
    subtle[name] = original;
  }
}

test("#232 r5 a d changed while the pair check is pending never signs, and the next call checks again", async () => {
  const a = await generateSigningKey();
  const b = await generateSigningKey();
  const value = { n: 1 };
  const key = { ...a.privateKey } as JsonWebKey;
  let settled = false;
  let pendingWhenChanged = false;
  const pending = signCanonical(key, value);
  pending.then(() => { settled = true; }, () => { settled = true; });
  queueMicrotask(() => { pendingWhenChanged = !settled; (key as { d?: string }).d = b.privateKey.d; });
  const result = await pending.then((sig) => sig, (err: Error) => err);
  assert.equal(pendingWhenChanged, true, "the change landed while the first call was pending");
  if (result instanceof Error) {
    assert.equal(result.message, MISMATCH_MESSAGE);
  } else {
    assert.equal(await verifyCanonical(a.publicKey, value, result), true, "the signature verifies against the advertised x");
    assert.equal(await verifyCanonical(b.publicKey, value, result), false, "the changed d did not sign");
  }
  const again = await signCanonical(key, value).then(() => assert.fail("expected a rejection"), (err: Error) => err);
  assert.equal(again.message, MISMATCH_MESSAGE, "the second call checks the changed object again");
  // The pair check alone: the pending call checked the snapshot it took; the next call refuses the changed object.
  const key2 = { ...a.privateKey } as JsonWebKey;
  const check = assertSigningKeyPair(key2);
  queueMicrotask(() => { (key2 as { d?: string }).d = b.privateKey.d; });
  await check;
  const refused = await assertSigningKeyPair(key2).then(() => assert.fail("expected a rejection"), (err: Error) => err);
  assert.equal(refused.message, MISMATCH_MESSAGE);
  assert.ok(![a.privateKey.d, b.privateKey.d].some((d) => `${again.stack}\n${refused.stack}`.includes(d!)), "no d in either error");
});

test("#232 r5 a d changed between the pair check and the import is not the key imported", async () => {
  const a = await generateSigningKey();
  const b = await generateSigningKey();
  const value = { n: 2 };
  const key = { ...a.privateKey } as JsonWebKey;
  const imported: unknown[] = [];
  const sig = await withSubtle("exportKey", (original) => async (...args) => {
    const out = await original(...args);
    (key as { d?: string }).d = b.privateKey.d; // the derivation is done; the import has not started
    return out;
  }, () => withSubtle("importKey", (original) => async (...args) => {
    if (args[0] === "jwk") imported.push((args[1] as JsonWebKey).d);
    return original(...args);
  }, () => signCanonical(key, value)));
  assert.equal(key.d, b.privateKey.d, "the change landed");
  assert.deepEqual(imported, [a.privateKey.d], "the import used the checked snapshot's d");
  assert.equal(await verifyCanonical(a.publicKey, value, sig), true);
  assert.equal(await verifyCanonical(b.publicKey, value, sig), false);
});

test("#232 r5 each publisher signs with the key it embeds, even when the configured key changes mid-call", async () => {
  const a = await generateSigningKey();
  const b = await generateSigningKey();
  const keyIdInput = JSON.stringify({ crv: "Ed25519", kty: "OKP", x: a.publicKey.x }); // keyId's canonical {crv,kty,x}
  /** Swap the whole key to b (a consistent pair) as soon as the publisher hashes a's public key for its kid. */
  const swapAtKid = <R>(key: JsonWebKey, fn: () => Promise<R>) => withSubtle("digest", (original) => async (...args) => {
    const out = await original(...args);
    if (new TextDecoder().decode(args[1] as Uint8Array) === keyIdInput) Object.assign(key, { d: b.privateKey.d, x: b.publicKey.x });
    return out;
  }, fn);
  const store = new MemoryEventStore();
  await appendEvent(store, { project: "p", actor: { type: "human", id: "owner@example.test" }, action: "created", artifacts: [{ id: "file:a.txt" }] });

  let key = { ...a.privateKey } as JsonWebKey;
  const bundle = await swapAtKid(key, () => buildExportBundle(store, { project: "p" }, { signingKey: key }));
  assert.equal(key.x, b.publicKey.x, "export: the swap landed");
  assert.equal(bundle.issuer!.public_key.x, a.publicKey.x);
  assert.equal(await verifyCanonical(bundle.issuer!.public_key, { ...bundle, signature: undefined }, bundle.signature!), true, "export: the signature verifies against the embedded key");

  key = { ...a.privateKey } as JsonWebKey;
  const cp = await swapAtKid(key, () => checkpointFromStore(store, "p", { signingKey: key }));
  assert.equal(key.x, b.publicKey.x, "checkpoint: the swap landed");
  assert.equal(cp.signer!.public_key.x, a.publicKey.x);
  assert.equal(await verifyCanonical(cp.signer!.public_key, { ...cp, signature: undefined }, cp.signature!), true, "checkpoint: the signature verifies against the embedded key");

  key = { ...a.privateKey } as JsonWebKey;
  const h = createHandler(store, { token: PUBKEY_TOKEN, signingKey: key });
  const head = await swapAtKid(key, () => h(new Request("http://retrace.test/projects/p/head?signed=1", { headers: { authorization: `Bearer ${PUBKEY_TOKEN}` } })));
  assert.equal(key.x, b.publicKey.x, "signed head: the swap landed");
  const { signature, issuer, ...payload } = await head.json() as { signature: string; issuer: { public_key: JsonWebKey } } & Record<string, unknown>;
  assert.equal(issuer.public_key.x, a.publicKey.x);
  assert.equal(await verifyCanonical(issuer.public_key, payload, signature), true, "signed head: the signature verifies against the embedded key");

  key = { ...a.privateKey } as JsonWebKey;
  const input = { project: "p", actor: { type: "agent" as const, id: "seat_FAKE" }, action: "created" as const, artifacts: [{ id: "file:b.txt" }], timestamp: "2026-10-16T00:00:00.000Z", idempotency_key: "idem-r5" };
  const signed = await swapAtKid(key, () => signProducer(input, key));
  assert.equal(key.x, b.publicKey.x, "producer: the swap landed");
  assert.equal(signed.producer_sig.kid, await keyId(a.publicKey));
  assert.equal(await verifyProducerSig(signed, a.publicKey), true, "producer: the signature verifies against the key its kid names");

  // The public key route publishes the snapshot it checked, even if the key is swapped once the check has derived.
  key = { ...a.privateKey } as JsonWebKey;
  const route = await withSubtle("exportKey", (original) => async (...args) => {
    const out = await original(...args);
    Object.assign(key, { d: b.privateKey.d, x: b.publicKey.x });
    return out;
  }, () => getPubkey(key));
  assert.equal(route.status, 200);
  assert.equal((await route.json() as { public_key: JsonWebKey }).public_key.x, a.publicKey.x, "route: the published x is the checked one");
});

/** A known answer, computed with WebCrypto directly from the made-up seed D, independent of this module. */
const KAT = {
  jwk: { kty: "OKP", crv: "Ed25519", d: D, x: "yBHdHjNm5Hc0I5Oq3_KUZdY2WJ3h2bKPtJChR93BmKc" },
  value: { hash: "h", project: "p", seq: 3 },
  sig: "Yr70t_wi9PNqN1Arm62gq_aBvs_NsEJI53cbEm8EJ_ImSA_TQiSRZ_yYzQmfyWpd6QbMDB1PB_rL9-FDYtaxCw",
};

test("#232 r5 a valid key's signature over a fixed payload is the known answer", async () => {
  assert.equal(await signCanonical(KAT.jwk as JsonWebKey, KAT.value), KAT.sig);
  assert.equal(await verifyCanonical({ kty: "OKP", crv: "Ed25519", x: KAT.jwk.x }, KAT.value, KAT.sig), true);
});

test("#232 r5 witnessCheckpointRekor refuses a key whose x is the signer's but whose d is not, before anything is sent", async () => {
  const a = await generateSigningKey();
  const b = await generateSigningKey();
  const store = new MemoryEventStore();
  await appendEvent(store, { project: "p", actor: { type: "human", id: "owner@example.test" }, action: "created", artifacts: [{ id: "file:a.txt" }] });
  const cp = await checkpointFromStore(store, "p", { signingKey: a.privateKey });
  let fetched = 0;
  // x matches the checkpoint's signer, so the signer comparison passes; only the pair check can refuse it.
  const e = await witnessCheckpointRekor(cp, { ...a.privateKey, d: b.privateKey.d } as JsonWebKey, { fetchImpl: async () => { fetched++; throw new Error("no network in tests"); } })
    .then(() => assert.fail("expected a rejection"), (err: Error) => err);
  assert.equal(e.message, MISMATCH_MESSAGE);
  assert.equal(fetched, 0, "nothing is sent to Rekor");
  assert.ok(![a.privateKey.d, b.privateKey.d].some((d) => `${e.stack}`.includes(d!)), "no d in the error");
});

// Round 6 (Codex r5 Medium, evt_8ebc5f95; Jordan's go evt_ac3679c8): the snapshot spread the caller's object outside
// any error boundary, so a getter or a Proxy trap that threw an error carrying key text propagated it through signing
// and the public key route. Every read is now inside one boundary that throws a fixed error, and only the members used
// afterwards are read.
const UNREADABLE_MESSAGE = "signing key: the JWK could not be read";
const FRAGMENT = "tok_FAKEgetrWSXZ7391";

/** A generated key made hostile one of four ways; `reads` counts calls of the throwing accessor or trap. */
function hostileKeys(privateKey: JsonWebKey) {
  const reads = { note: 0 };
  const noteGetter = { ...privateKey } as Record<string, unknown>;
  Object.defineProperty(noteGetter, "private_note", { enumerable: true, get() { reads.note++; throw new Error(`leak ${FRAGMENT}`); } });
  const dGetter = { ...privateKey } as Record<string, unknown>;
  Object.defineProperty(dGetter, "d", { enumerable: true, get() { throw new Error(`leak ${FRAGMENT}`); } });
  const proxyGet = new Proxy({ ...privateKey }, { get() { throw new Error(`leak ${FRAGMENT}`); } });
  const proxyOwnKeys = new Proxy({ ...privateKey }, { ownKeys() { throw new Error(`leak ${FRAGMENT}`); } });
  return { reads, noteGetter: noteGetter as JsonWebKey, refused: { dGetter: dGetter as JsonWebKey, proxyGet: proxyGet as JsonWebKey, proxyOwnKeys: proxyOwnKeys as JsonWebKey } };
}

test("#232 r6 a throwing getter or Proxy trap on the signing key gives only fixed messages, on every snapshot path", async () => {
  const { privateKey, publicKey } = await generateSigningKey();
  const { reads, noteGetter, refused } = hostileKeys(privateKey);
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map((a) => (a instanceof Error ? `${a.stack}` : String(a))).join(" ")); };
  try {
    // An accessor on a member the snapshot does not copy is never called: the key signs and is published as itself.
    const sig = await signCanonical(noteGetter, { n: 1 });
    assert.equal(await verifyCanonical(publicKey, { n: 1 }, sig), true);
    const published = await getPubkey(noteGetter);
    assert.equal(published.status, 200);
    assert.equal((await published.json() as { public_key: JsonWebKey }).public_key.x, publicKey.x);
    assert.equal(reads.note, 0, "private_note was never read");

    const store = new MemoryEventStore();
    await appendEvent(store, { project: "p", actor: { type: "human", id: "owner@example.test" }, action: "created", artifacts: [{ id: "file:a.txt" }] });
    const cp = await checkpointFromStore(store, "p", { signingKey: privateKey });
    const input = { project: "p", actor: { type: "agent" as const, id: "seat_FAKE" }, action: "created" as const, artifacts: [{ id: "file:b.txt" }], timestamp: "2026-10-16T00:00:00.000Z", idempotency_key: "idem-r6" };
    for (const [name, key] of Object.entries(refused)) {
      const paths: [string, () => Promise<unknown>][] = [
        ["signCanonical", () => signCanonical(key, { n: 1 })],
        ["importSigningKey", () => importSigningKey(key)],
        ["assertSigningKeyPair", () => assertSigningKeyPair(key)],
        ["checkpointFromStore", () => checkpointFromStore(store, "p", { signingKey: key })],
        ["buildExportBundle", () => buildExportBundle(store, { project: "p" }, { signingKey: key })],
        ["signProducer", () => signProducer(input, key)],
        ["witnessCheckpointRekor", () => witnessCheckpointRekor(cp, key, { fetchImpl: async () => { throw new Error("no network in tests"); } })],
      ];
      for (const [path, run] of paths) {
        const e = await run().then(() => assert.fail(`${name} ${path}: expected a rejection`), (err: Error) => err);
        assert.equal(e.message, UNREADABLE_MESSAGE, `${name} ${path}`);
        assert.equal((e as { cause?: unknown }).cause, undefined, `${name} ${path}: no cause`);
        assert.ok(!`${e.message}\n${e.stack}`.includes(FRAGMENT.slice(4)), `${name} ${path}: no fragment`);
      }
      const route = await getPubkey(key);
      const routeBody = await route.text();
      assert.equal(route.status, 503, `${name} route`);
      assert.deepEqual(JSON.parse(routeBody), { error: "signing key is not a valid Ed25519 JWK" });
      const h = createHandler(store, { token: PUBKEY_TOKEN, signingKey: key });
      const head = await h(new Request("http://retrace.test/projects/p/head?signed=1", { headers: { authorization: `Bearer ${PUBKEY_TOKEN}` } }));
      assert.equal(head.status, 500, `${name} signed head`);
      assert.ok(!(await head.text()).includes(FRAGMENT.slice(4)));
    }
  } finally {
    console.error = original;
  }
  const logs = logged.join("\n");
  assert.match(logs, new RegExp(`GET /projects/p/head: Error: ${UNREADABLE_MESSAGE}`), "the signed head's failure is logged with the fixed message");
  const unique = FRAGMENT.slice(4); // the made-up part after "tok_"
  for (let i = 0; i + 4 <= unique.length; i++) assert.ok(!logs.includes(unique.slice(i, i + 4)), `"${unique.slice(i, i + 4)}" of the made-up fragment in a log`);
});

test("#232 r6 the snapshot copies only the members used afterwards, in the caller's order, with key_ops as a new array", () => {
  const keyOps = ["sign"];
  const jwk = { private_note: "tok_FAKEnoteRFVB4739", ext: true, alg: "Ed25519", crv: "Ed25519", use: "sig", d: D, x: X, oth: { d: "tok_FAKEothhWSXC9517" }, kty: "OKP", kid: "kid-r6", key_ops: keyOps, kid_obj: { a: 1 } };
  const snap = snapshotSigningKey(jwk);
  // Round 7 (Codex r6 Medium): `use` is kept, in its place in the caller's order.
  assert.equal(JSON.stringify(snap), JSON.stringify({ ext: true, alg: "Ed25519", crv: "Ed25519", use: "sig", d: D, x: X, kty: "OKP", kid: "kid-r6", key_ops: ["sign"] }));
  assert.notEqual(snap.key_ops, keyOps, "key_ops is a new array");
  keyOps.push("verify");
  assert.deepEqual(snap.key_ops, ["sign"], "a later change to the caller's key_ops does not reach the snapshot");
  assert.equal((snapshotSigningKey({ ...jwk, kid: { nested: "tok_FAKEkidnUJMK2846" } }) as Record<string, unknown>).kid, undefined, "an object-valued member is dropped");
  for (const bad of [{ ...jwk, key_ops: "sign" }, { ...jwk, key_ops: [{ toString: () => "sign" }] }]) {
    assert.throws(() => snapshotSigningKey(bad), { message: "signing key: JWK key_ops is missing or invalid" });
  }
  for (const bad of [{ ...jwk, use: 1 }, { ...jwk, use: { toString: () => "sig" } }]) {
    assert.throws(() => snapshotSigningKey(bad), { message: "signing key: JWK use is missing or invalid" });
  }
  for (const notObject of [null, "tok_FAKEqzwxVBNM7531", ["tok_FAKEqzwxVBNM7531"]]) assert.equal(snapshotSigningKey(notObject), notObject);
});

test("#232 r6 the Rekor signature is made with the key compared with the checkpoint signer, even if the configured key changes after the comparison", async () => {
  const a = await generateSigningKey();
  const b = await generateSigningKey();
  const store = new MemoryEventStore();
  await appendEvent(store, { project: "p", actor: { type: "human", id: "owner@example.test" }, action: "created", artifacts: [{ id: "file:a.txt" }] });
  const cp = await checkpointFromStore(store, "p", { signingKey: a.privateKey });
  const key = { ...a.privateKey } as JsonWebKey;
  // canonicalize(cp) runs after the signer comparison and before the signature: an enumerable getter on the checkpoint
  // swaps the configured key to b, a consistent pair, at exactly that point.
  let swapped = false;
  Object.defineProperty(cp, "zz_swap", { enumerable: true, get() { if (!swapped) { Object.assign(key, { d: b.privateKey.d, x: b.publicKey.x }); swapped = true; } return "swap"; } });
  let body: string | undefined;
  await witnessCheckpointRekor(cp, key, { fetchImpl: async (_url, init) => { body = init?.body; throw new Error("no network in tests"); } })
    .then(() => assert.fail("expected the fake network to refuse"), (err: Error) => assert.equal(err.message, "no network in tests"));
  assert.equal(swapped, true, "the swap landed after the comparison");
  const entry = JSON.parse(body!) as { spec: { data: { content: string }; signature: { content: string } } };
  const artifact = Buffer.from(entry.spec.data.content, "base64");
  const sig = Buffer.from(entry.spec.signature.content, "base64");
  const verifyWith = async (x: string) => crypto.subtle.verify({ name: "Ed25519" }, await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x }, { name: "Ed25519" }, false, ["verify"]), sig, artifact);
  assert.equal(await verifyWith(a.publicKey.x!), true, "the Rekor signature verifies against the key compared with the signer");
  assert.equal(await verifyWith(b.publicKey.x!), false, "the swapped key did not sign");
});

// Round 7 (Codex r6 Medium, evt_26e80427): round 6's snapshot dropped the standard JWK member `use`, so a key marked
// `use: "enc"` signed, where round 5 and main refuse it (WebCrypto enforces `use` on import). `use` is kept now.
test("#232 r7 a key marked use sig signs; the same key marked use enc is refused with the fixed message and signs nothing", async () => {
  const { privateKey, publicKey } = await generateSigningKey();
  const value = { n: 7 };
  const sig = await signCanonical({ ...privateKey, use: "sig" } as JsonWebKey, value);
  assert.equal(await verifyCanonical(publicKey, value, sig), true, "use sig signs, and the signature verifies against x");
  const enc = { ...privateKey, use: "enc" } as JsonWebKey;
  const store = new MemoryEventStore();
  await appendEvent(store, { project: "p", actor: { type: "human", id: "owner@example.test" }, action: "created", artifacts: [{ id: "file:a.txt" }] });
  const input = { project: "p", actor: { type: "agent" as const, id: "seat_FAKE" }, action: "created" as const, artifacts: [{ id: "file:b.txt" }], timestamp: "2026-10-16T00:00:00.000Z", idempotency_key: "idem-r7" };
  for (const [name, run] of [
    ["signCanonical", () => signCanonical(enc, value)],
    ["checkpointFromStore", () => checkpointFromStore(store, "p", { signingKey: enc })],
    ["buildExportBundle", () => buildExportBundle(store, { project: "p" }, { signingKey: enc })],
    ["signProducer", () => signProducer(input, enc)],
  ] as [string, () => Promise<unknown>][]) {
    const e = await run().then(() => assert.fail(`${name}: use enc must not sign`), (err: Error) => err);
    assert.equal(e.message, "signing key: the runtime refused to import the JWK", name);
    assert.equal((e as { cause?: unknown }).cause, undefined, name);
  }
});
