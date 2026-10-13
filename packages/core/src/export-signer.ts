/**
 * The signer the streaming export builder takes (export-cache handoff db4bb0d6 §4c). Core holds only these types, so
 * `@retrace-dev/core` gains no dependency; the Worker supplies the Ed25519 implementation.
 *
 * A deterministic signature over a message M that the caller feeds twice, once for the nonce and once for the
 * challenge, so the signer never holds M (pure Ed25519, RFC 8032 §5.1.6: r = SHA-512(prefix ‖ M), k = SHA-512(R ‖ A ‖ M)).
 * A nonce taken from one message and a challenge taken from another leaks the key (two such signatures give
 * s = (S1 − S2) / (k1 − k2)), so an implementation must refuse to finish unless pass 2 fed exactly pass 1's bytes.
 */
export interface ExportSignature {
  /** Pass 1: the next bytes of M, in any chunking. */
  nonce(chunk: Uint8Array): void;
  /** Pass 2: the next bytes of M again, in any chunking. The first call ends pass 1. */
  challenge(chunk: Uint8Array): void;
  /** The signature bytes. Throws, and releases nothing, unless pass 2 fed exactly pass 1's bytes. Ends the signature. */
  finish(): Uint8Array;
  /** Wipes the signature's secret state. Idempotent, and safe after finish(); later calls throw. */
  dispose(): void;
}

export interface ExportSigner {
  /** The issuer's public JWK exactly as `publicFromPrivate` gives it for the private key: the bundle embeds it. */
  readonly publicKey: JsonWebKey;
  /** Starts one signature. */
  begin(): ExportSignature;
  /** Wipes the key material the signer holds. Idempotent; later begin() calls throw. */
  dispose(): void;
}
