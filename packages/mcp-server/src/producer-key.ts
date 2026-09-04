/**
 * Producer private keys — Ed25519 JWKs the Worker never holds (docs/producer-signing-plan.md Phase B).
 *
 * Distinct from `keys.ts` / `~/.retrace/signing-key.json`, which is the export-issuer role. A producer key signs
 * events at the MCP server and git hook; the matching public JWK is registered on the credential (`public_key`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { EventInput, generateSigningKey, publicFromPrivate, keyId, signProducer, schemaSurface } from "@retrace-dev/core";
import { keyPath } from "./keys.js";

export function defaultProducerKeysDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.RETRACE_PRODUCER_KEYS_DIR ?? join(homedir(), ".retrace", "producer-keys");
}

export function defaultProducerKeyPath(actor = "producer", env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultProducerKeysDir(env), `${producerKeySlug(actor)}.jwk`);
}

/** Filesystem-safe slug for a credential name or actor id (emails become hyphens). */
export function producerKeySlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "producer";
}

export function isExportIssuerKeyPath(p: string): boolean {
  return resolve(p) === resolve(keyPath());
}

function refuseIssuerPath(p: string): void {
  if (isExportIssuerKeyPath(p)) {
    throw new Error(`refusing to use the export issuer key (${p}) as a producer key; mint a separate key with retrace-export producer-keygen`);
  }
}

export function writeProducerPrivateKey(path: string, privateJwk: JsonWebKey): void {
  refuseIssuerPath(path);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}
  writeFileSync(path, JSON.stringify(privateJwk, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch (e: any) { console.error(`warning: could not restrict permissions on ${path}: ${e?.message ?? e}`); }
}

export function loadProducerPrivateKeyFromFile(path: string): JsonWebKey {
  refuseIssuerPath(path);
  if (!existsSync(path)) throw new Error(`producer key file not found: ${path}`);
  const jwk = JSON.parse(readFileSync(path, "utf8")) as JsonWebKey;
  if (jwk?.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof (jwk as { d?: unknown }).d !== "string") {
    throw new Error(`producer key file ${path} is not an Ed25519 private JWK`);
  }
  return jwk;
}

/** RETRACE_PRODUCER_KEY_FILE (path) else RETRACE_PRODUCER_KEY (inline JWK JSON). Missing both → null (do not sign). */
export function loadProducerPrivateKey(env: NodeJS.ProcessEnv = process.env): JsonWebKey | null {
  if (env.RETRACE_PRODUCER_KEY_FILE) return loadProducerPrivateKeyFromFile(env.RETRACE_PRODUCER_KEY_FILE);
  if (env.RETRACE_PRODUCER_KEY) {
    const jwk = JSON.parse(env.RETRACE_PRODUCER_KEY) as JsonWebKey;
    if (jwk?.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof (jwk as { d?: unknown }).d !== "string") {
      throw new Error("RETRACE_PRODUCER_KEY is not an Ed25519 private JWK");
    }
    return jwk;
  }
  return null;
}

export async function ensureProducerKey(path: string): Promise<{ privateKey: JsonWebKey; publicKey: JsonWebKey; kid: string; path: string; created: boolean }> {
  refuseIssuerPath(path);
  if (existsSync(path)) {
    const privateKey = loadProducerPrivateKeyFromFile(path);
    const publicKey = publicFromPrivate(privateKey);
    return { privateKey, publicKey, kid: await keyId(publicKey), path, created: false };
  }
  const kp = await generateSigningKey();
  writeProducerPrivateKey(path, kp.privateKey);
  return { ...kp, publicKey: publicFromPrivate(kp.privateKey), path, created: true };
}

const checkedRemotes = new Set<string>();

/** Tests reset the lazy GET /api cache so a second case can fetch again. */
export function resetProducerSigSchemaCheck(): void {
  checkedRemotes.clear();
}

/**
 * An old Worker silently strips `producer_sig` (zod). Refuse to sign against a remote whose GET /api schema
 * lacks the field. Local SQLite needs no check. Lazy so MCP tests that never sign never fetch.
 */
export async function assertRemoteAcceptsProducerSig(url: string, fetchApi: typeof fetch = fetch): Promise<void> {
  const base = url.replace(/\/+$/, "");
  if (checkedRemotes.has(base)) return;
  const res = await fetchApi(base + "/api");
  if (!res.ok) throw new Error(`refusing to sign: GET ${base}/api returned ${res.status}`);
  const api = await res.json() as { schema?: Record<string, unknown> };
  const eventKeys = Array.isArray(api.schema?.event) ? api.schema!.event as unknown[] : [];
  if (!eventKeys.includes("producer_sig") && schemaSurface().event.includes("producer_sig")) {
    throw new Error(`refusing to sign against ${base}: GET /api schema lacks event.producer_sig — deploy the Worker before any producer signs (an old Worker silently strips the signature)`);
  }
  checkedRemotes.add(base);
}

export type SealOpts = {
  privateKey?: JsonWebKey | null;
  remoteUrl?: string | null;
  fetchApi?: typeof fetch;
};

/**
 * Sign an event about to be appended. No key → input unchanged. When signing, fills `timestamp` and
 * `idempotency_key` if the caller omitted them (required by signProducer). Remote URL triggers the schema gate.
 */
export async function sealForAppend<T extends EventInput>(input: T, opts: SealOpts = {}): Promise<T> {
  const key = opts.privateKey !== undefined ? opts.privateKey : loadProducerPrivateKey();
  if (!key) return input;
  if (opts.remoteUrl) await assertRemoteAcceptsProducerSig(opts.remoteUrl, opts.fetchApi ?? fetch);
  const ready = {
    ...input,
    timestamp: input.timestamp ?? new Date().toISOString(),
    idempotency_key: input.idempotency_key ?? randomUUID(),
  };
  return signProducer(ready, key);
}
