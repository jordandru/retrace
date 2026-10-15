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

export function publicFromPrivate(priv: JsonWebKey): JsonWebKey {
  const { d: _d, key_ops: _k, ...pub } = priv as any;
  return { ...pub, key_ops: ["verify"] };
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
