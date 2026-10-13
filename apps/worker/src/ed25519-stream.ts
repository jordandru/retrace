/**
 * Streaming Ed25519 for the cached export (export-cache handoff db4bb0d6 §4c): pure Ed25519 (RFC 8032 §5.1.6) over a
 * message M fed twice, so the signer never holds M.
 *   r = SHA-512(prefix ‖ M) mod L    pass 1
 *   R = [r]B
 *   k = SHA-512(R ‖ A ‖ M) mod L     pass 2
 *   S = (r + k·s) mod L              signature R ‖ S
 * Ed25519 is deterministic, so for the same key and M the signature is byte-identical to WebCrypto's, which is what
 * `signCanonical` uses. Point arithmetic is @noble/curves; incremental SHA-512 and SHA-256 are @noble/hashes.
 *
 * - A nonce from one message with a challenge from another leaks the key. Each signature keeps a SHA-256 and a byte
 *   count of each pass, and finish() refuses to compute S unless pass 2 fed exactly pass 1's bytes.
 * - The seed is the JWK `d` that `parseSigningKey` returns. The signer derives A from it and refuses to sign unless A
 *   equals the JWK `x`.
 * - The seed, the expanded key and the hash states live only in closures, never on an object a caller could log or
 *   serialise, and no error message carries key material. The byte buffers this file owns are zeroed after use and the
 *   hash states destroyed. JavaScript bigints (the scalar s, r and k) cannot be wiped; they are dropped when the
 *   signature or the signer ends.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToNumberLE, concatBytes, equalBytes } from "@noble/curves/utils.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { publicFromPrivate, type ExportSignature, type ExportSigner } from "@retrace-dev/core";

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const Fn = ed25519.Point.Fn;

/** 32 bytes from 43 characters of unpadded base64url. The last character carries 2 spare bits, which must be zero:
 *  only the canonical encoding is accepted. The error names the field, never its value. */
function decode32(value: unknown, field: "d" | "x"): Uint8Array {
  const refuse = () => new Error(`signing key: JWK ${field} is not 32 bytes of canonical unpadded base64url`);
  if (typeof value !== "string" || value.length !== 43) throw refuse();
  const out = new Uint8Array(32);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < 43; i++) {
    const v = BASE64URL.indexOf(value[i]!);
    if (v < 0) {
      out.fill(0);
      throw refuse();
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  if (o !== 32 || acc !== 0) {
    out.fill(0);
    throw refuse();
  }
  return out;
}

/** A running SHA-256 and byte count of one pass over M. */
function passDigest() {
  const hash = sha256.create();
  let bytes = 0;
  return {
    update(chunk: Uint8Array) {
      hash.update(chunk);
      bytes += chunk.length;
    },
    end(): { digest: Uint8Array; bytes: number } {
      return { digest: hash.digest(), bytes };
    },
    destroy() {
      hash.destroy();
    },
  };
}

/** One two-pass signature. `seed` is the caller's copy; it is read here and never kept. */
function beginSignature(seed: Uint8Array, A: Uint8Array): ExportSignature {
  const ext = ed25519.utils.getExtendedPublicKey(seed);
  let scalar: bigint | undefined = ext.scalar;
  let nonceHash: ReturnType<typeof sha512.create> | undefined;
  try {
    if (!equalBytes(ext.pointBytes, A)) throw new Error("signing key: the public key derived from d does not equal x");
    nonceHash = sha512.create().update(ext.prefix);
  } catch (error) {
    scalar = undefined;
    throw error;
  } finally {
    ext.head.fill(0);
    ext.prefix.fill(0);
  }
  let state: "nonce" | "challenge" | "ended" = "nonce";
  let r: bigint | undefined;
  let R: Uint8Array | undefined;
  let challengeHash: ReturnType<typeof sha512.create> | undefined;
  const pass1 = passDigest();
  const pass2 = passDigest();

  const dispose = () => {
    state = "ended";
    nonceHash?.destroy();
    challengeHash?.destroy();
    pass1.destroy();
    pass2.destroy();
    nonceHash = challengeHash = undefined;
    scalar = r = undefined;
  };
  // Pass 1 ends at the first challenge call, or at finish() for an empty M: r and R are fixed, and the challenge
  // hash starts with R ‖ A. A failure here ends the signature.
  const endNonce = () => {
    try {
      const h = nonceHash!.digest();
      nonceHash = undefined;
      r = Fn.create(bytesToNumberLE(h));
      h.fill(0);
      R = ed25519.Point.BASE.multiply(r).toBytes();
      challengeHash = sha512.create().update(R).update(A);
      state = "challenge";
    } catch (error) {
      dispose();
      throw error;
    }
  };
  return {
    nonce(chunk) {
      if (state !== "nonce") throw new Error("signature: pass 1 has ended");
      nonceHash!.update(chunk);
      pass1.update(chunk);
    },
    challenge(chunk) {
      if (state === "nonce") endNonce();
      if (state !== "challenge") throw new Error("signature: the signature has ended");
      challengeHash!.update(chunk);
      pass2.update(chunk);
    },
    finish() {
      if (state === "nonce") endNonce();
      if (state !== "challenge") throw new Error("signature: the signature has ended");
      try {
        const first = pass1.end();
        const second = pass2.end();
        if (first.bytes !== second.bytes || !equalBytes(first.digest, second.digest)) {
          throw new Error("signature refused: pass 2 did not feed the bytes pass 1 fed");
        }
        const h = challengeHash!.digest();
        challengeHash = undefined;
        const k = Fn.create(bytesToNumberLE(h));
        h.fill(0);
        const S = Fn.create(r! + k * scalar!);
        if (!Fn.isValid(S)) throw new Error("signature refused: invalid S");
        return concatBytes(R!, Fn.toBytes(S));
      } finally {
        dispose();
      }
    },
    dispose,
  };
}

/**
 * A two-pass Ed25519 signer for the private JWK that `parseSigningKey` returns. Throws, with a message that names no
 * key material, unless the JWK is an Ed25519 OKP key whose `d` derives its `x`.
 */
export function createStreamingEd25519Signer(privateJwk: JsonWebKey): ExportSigner {
  if (privateJwk?.kty !== "OKP" || privateJwk.crv !== "Ed25519") throw new Error("signing key: not an Ed25519 OKP JWK");
  const A = decode32(privateJwk.x, "x");
  let seed: Uint8Array | undefined = decode32(privateJwk.d, "d");
  try {
    beginSignature(seed, A).dispose();
  } catch (error) {
    seed.fill(0);
    seed = undefined;
    throw error;
  }
  return {
    publicKey: publicFromPrivate(privateJwk),
    begin() {
      if (!seed) throw new Error("signer: disposed");
      return beginSignature(seed, A);
    },
    dispose() {
      seed?.fill(0);
      seed = undefined;
    },
  };
}
