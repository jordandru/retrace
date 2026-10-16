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

/** The shape check, then the public key derived from `d` compared with `x` (#232 round 3, Codex r2 Medium). A
 *  shape-valid key whose `x` is not `d`'s public key would otherwise be published as a key that cannot verify `d`'s
 *  signatures. `d` is imported alone, as PKCS #8, so no runtime compares it with `x` on our behalf; the runtime's own
 *  error is dropped, as in importSigningKey. Every message is fixed and names no value. */
export async function assertSigningKeyPair(jwk: unknown): Promise<void> {
  assertSigningJwk(jwk);
  let derived: unknown;
  try {
    const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
    der.set(PKCS8_ED25519_PREFIX);
    der.set(b64u.dec(jwk.d!), PKCS8_ED25519_PREFIX.length);
    const key = await subtle.importKey("pkcs8", der, ALG, true, ["sign"]);
    derived = ((await subtle.exportKey("jwk", key)) as JsonWebKey).x;
  } catch {
    throw new Error("signing key: the runtime could not derive the public key");
  }
  if (derived !== jwk.x) throw new Error("signing key: JWK x is not the public key of d");
}

/** Import a private signing JWK: its shape first, then the runtime import. The runtime's own error is dropped, never
 *  kept as message, stack or cause, because it can quote the key. */
export async function importSigningKey(priv: JsonWebKey): Promise<CryptoKey> {
  assertSigningJwk(priv);
  try {
    return await subtle.importKey("jwk", importable(priv), ALG, false, ["sign"]);
  } catch {
    throw new Error("signing key: the runtime refused to import the JWK");
  }
}

export async function signCanonical(priv: JsonWebKey, value: unknown): Promise<string> {
  const key = await importSigningKey(priv);
  const bytes = new TextEncoder().encode(canonicalize(value));
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
