/**
 * Ed25519 signing via WebCrypto (Node 22+, Cloudflare Workers, modern browsers).
 * Keys are JWKs. Private key is passed as JSON in RETRACE_SIGNING_KEY; the public JWK is published at /.well-known/retrace-pubkey.
 */
import { canonicalize, sha256Hex } from "./chain.js";

const subtle: SubtleCrypto = (globalThis as any).crypto.subtle;
const ALG = { name: "Ed25519" } as any;

export interface KeyPairJwk { privateKey: JsonWebKey; publicKey: JsonWebKey; kid: string }

export async function generateSigningKey(): Promise<KeyPairJwk> {
  const kp = (await subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const privateKey = await subtle.exportKey("jwk", kp.privateKey);
  const publicKey = await subtle.exportKey("jwk", kp.publicKey);
  const kid = await keyId(publicKey);
  return { privateKey: { ...privateKey, kid } as JsonWebKey, publicKey: { ...publicKey, kid } as JsonWebKey, kid };
}

/** kid = first 16 hex of sha256(canonical public jwk {crv,kty,x}) */
export async function keyId(pub: JsonWebKey): Promise<string> {
  return (await sha256Hex(canonicalize({ crv: pub.crv, kty: pub.kty, x: pub.x }))).slice(0, 16);
}

/** The members a public JWK built from the signing key may carry, with the type each must have: the Ed25519 public key
 *  (`kty`, `crv`, `x`, RFC 8037 §2) and the public metadata a configured key already carries (`kid` and `alg`, RFC 7517
 *  §4; WebCrypto's `ext`). Nothing else is copied: not `d`, not `key_ops`, not any extension member (#232 round 3). */
const PUBLIC_JWK_MEMBERS: Readonly<Record<string, "string" | "boolean">> = {
  kty: "string", crv: "string", x: "string", kid: "string", alg: "string", ext: "boolean",
};

/** The public JWK for a private one, from the allowlist above, in the private key's own member order, so a valid key
 *  serialises exactly as it did when every member but `d` and `key_ops` was copied. */
export function publicFromPrivate(priv: JsonWebKey): JsonWebKey {
  const pub: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(priv)) {
    if (Object.hasOwn(PUBLIC_JWK_MEMBERS, name) && typeof value === PUBLIC_JWK_MEMBERS[name]) pub[name] = value;
  }
  return { ...pub, key_ops: ["verify"] } as JsonWebKey;
}

const b64u = {
  enc: (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0)),
};

/** Drop the JWK `alg` member before import. Node exports Ed25519 keys with alg "Ed25519"; Cloudflare's runtime
 *  rejects anything but "EdDSA" for that member and fails the import ("does not match requested Ed25519 curve"),
 *  which took the Worker's export/report/share-report routes down. Both runtimes accept a JWK without `alg`. */
function importable(jwk: JsonWebKey): JsonWebKey {
  const { alg: _alg, ...rest } = jwk as any;
  return rest;
}

/** A signature as bundles carry it: unpadded base64url, the encoding signCanonical returns. */
export function encodeSignature(sig: Uint8Array): string {
  return b64u.enc(sig);
}

/** 32 bytes as 43 characters of unpadded base64url; the last character's 2 spare bits are zero (canonical only). */
const B64U_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** The shape a private Ed25519 signing JWK must have before any runtime import (#232 round 2). workerd's JWK import
 *  error quotes a malformed `kty` or `crv` value, and an error's stack reaches the router's log, so a key that is not
 *  this shape is refused here with a fixed message that names only the failing field. */
export function assertSigningJwk(jwk: unknown): asserts jwk is JsonWebKey {
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) throw new Error("signing key: not a JWK object");
  const k = jwk as Record<string, unknown>;
  for (const [field, ok] of [
    ["kty", k.kty === "OKP"],
    ["crv", k.crv === "Ed25519"],
    ["d", typeof k.d === "string" && B64U_32.test(k.d)],
    ["x", typeof k.x === "string" && B64U_32.test(k.x)],
  ] as const) {
    if (!ok) throw new Error(`signing key: JWK ${field} is missing or invalid`);
  }
}

/** PKCS #8 DER prefix of an Ed25519 private key (RFC 8410 §7); the 32 bytes of `d` follow it. */
const PKCS8_ED25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/** The members a snapshot copies: what is read after it. The shape check reads `kty`, `crv`, `d` and `x`;
 *  publicFromPrivate copies PUBLIC_JWK_MEMBERS (`kty`, `crv`, `x`, `kid`, `alg`, `ext`); the signing import gets every
 *  copied member but `alg` (importable), which leaves `key_ops` as the one member that changes what the import allows.
 *  Every other member is dropped (#232 round 6). */
const SNAPSHOT_MEMBERS: ReadonlySet<string> = new Set(["kty", "crv", "d", "x", "kid", "alg", "ext", "key_ops"]);

/** A private copy of a signing JWK, taken synchronously (#232 round 5, Codex r4 Medium; CODING_STANDARDS CS-5). The
 *  key's owner may change the object while a check is pending, so every check, and every use after the first `await`,
 *  reads this copy and never the caller's object.
 *
 *  Every read of the caller's object happens inside one `try` (round 6, Codex r5 Medium): its own enumerable keys,
 *  once, for their order, then each member in SNAPSHOT_MEMBERS, once. A getter or a Proxy trap that throws, whatever
 *  its error says, becomes a fixed error; the caught error is dropped, not kept as message, stack or cause. Members
 *  outside SNAPSHOT_MEMBERS are never read. A member whose value is an object is dropped, so nothing the caller can
 *  still change is shared, except `key_ops`, which must be an array of strings and is copied as a new array. The
 *  copied members keep the caller's order, so a valid key's public JWK serialises as it did. Anything that is not a
 *  JWK object is returned as it is, for the shape check to refuse. */
export function snapshotSigningKey(jwk: unknown): JsonWebKey {
  const copy: Record<string, unknown> = {};
  let badKeyOps = false;
  try {
    if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) return jwk as JsonWebKey;
    for (const name of Object.keys(jwk)) {
      if (!SNAPSHOT_MEMBERS.has(name)) continue;
      const value: unknown = (jwk as Record<string, unknown>)[name];
      if (name === "key_ops") {
        const ops: unknown[] = Array.isArray(value) ? Array.from(value as unknown[]) : [];
        if (!Array.isArray(value) || ops.some((op) => typeof op !== "string")) badKeyOps = true;
        else copy.key_ops = ops;
      } else if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        copy[name] = value;
      }
    }
  } catch {
    throw new Error("signing key: the JWK could not be read");
  }
  if (badKeyOps) throw new Error("signing key: JWK key_ops is missing or invalid");
  return copy as JsonWebKey;
}

/** The shape check, then the public key derived from `d` compared with `x`, both on one snapshot, which it returns. A
 *  shape-valid key whose `x` is not `d`'s public key would otherwise be published as a key that cannot verify `d`'s
 *  signatures (round 3, Codex r2 Medium), and workerd would sign with it, because it signs with `d` alone (round 4,
 *  Codex r3 Medium). `d` is imported alone, as PKCS #8, so no runtime compares it with `x` on our behalf. Nothing is
 *  cached: every call derives (round 5, Jordan's choice over a snapshot cache). The runtime's own error is dropped and
 *  every message is fixed and names no value. */
async function checkedSigningKey(jwk: unknown): Promise<JsonWebKey> {
  const key = snapshotSigningKey(jwk);
  assertSigningJwk(key);
  let derived: unknown;
  try {
    const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
    der.set(PKCS8_ED25519_PREFIX);
    der.set(b64u.dec(key.d!), PKCS8_ED25519_PREFIX.length);
    const derivedKey = await subtle.importKey("pkcs8", der, ALG, true, ["sign"]);
    derived = ((await subtle.exportKey("jwk", derivedKey)) as JsonWebKey).x;
  } catch {
    throw new Error("signing key: the runtime could not derive the public key");
  }
  if (derived !== key.x) throw new Error("signing key: JWK x is not the public key of d");
  return key;
}

/** The pair check on a snapshot of `jwk`. A caller that goes on to publish or sign takes its own snapshot first
 *  (snapshotSigningKey) and passes that, so what it uses afterwards is what was checked. */
export async function assertSigningKeyPair(jwk: unknown): Promise<void> {
  await checkedSigningKey(jwk);
}

/** Import a private signing JWK from the snapshot its shape and pair were checked on; the caller's object is not read
 *  again after the first `await`. The runtime's own error is dropped, never kept as message, stack or cause, because it
 *  can quote the key. */
export async function importSigningKey(priv: JsonWebKey): Promise<CryptoKey> {
  const key = await checkedSigningKey(priv);
  try {
    return await subtle.importKey("jwk", importable(key), ALG, false, ["sign"]);
  } catch {
    throw new Error("signing key: the runtime refused to import the JWK");
  }
}

/** Sign the canonical bytes of `value`, taken before the first `await`, with the key imported from the checked
 *  snapshot. */
export async function signCanonical(priv: JsonWebKey, value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(value));
  const key = await importSigningKey(priv);
  let sig: ArrayBuffer;
  try {
    sig = await subtle.sign(ALG, key, bytes);
  } catch {
    throw new Error("signing key: the runtime refused to sign");
  }
  return b64u.enc(sig);
}

export async function verifyCanonical(pub: JsonWebKey, value: unknown, signature: string): Promise<boolean> {
  try {
    const key = await subtle.importKey("jwk", importable({ ...pub, key_ops: ["verify"] }), ALG, false, ["verify"]);
    return await subtle.verify(ALG, key, b64u.dec(signature), new TextEncoder().encode(canonicalize(value)));
  } catch {
    return false;
  }
}

/** Parse RETRACE_SIGNING_KEY (JSON JWK, or base64 of it). Returns null when unset. */
export function parseSigningKey(raw?: string | null): JsonWebKey | null {
  if (!raw) return null;
  const s = raw.trim();
  try { return JSON.parse(s); } catch {}
  try { return JSON.parse(atob(s)); } catch {}
  throw new Error("RETRACE_SIGNING_KEY is not a JWK (JSON or base64 JSON)");
}
