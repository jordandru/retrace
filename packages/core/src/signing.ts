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
  enc: (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0)),
};

export async function signCanonical(priv: JsonWebKey, value: unknown): Promise<string> {
  const key = await subtle.importKey("jwk", priv, ALG, false, ["sign"]);
  const sig = await subtle.sign(ALG, key, new TextEncoder().encode(canonicalize(value)));
  return b64u.enc(sig);
}

export async function verifyCanonical(pub: JsonWebKey, value: unknown, signature: string): Promise<boolean> {
  try {
    const key = await subtle.importKey("jwk", { ...pub, key_ops: ["verify"] }, ALG, false, ["verify"]);
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
