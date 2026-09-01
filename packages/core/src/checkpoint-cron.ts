/**
 * Hourly checkpoint cadence — tamper-evident roadmap rung 2.
 *
 * The daily git-PR checkpoint bounds history rewrites to a 24-hour window. This module shrinks that to the cron
 * interval: a scheduled run (Cloudflare Worker cron, or any host) checkpoints every project's head straight from the
 * store, signs it, submits it to the Rekor transparency log, and records {checkpoint, witness} in a checkpoint log
 * (a D1 table on the Worker). The git-committed daily checkpoint remains the human-witnessed anchor; these hourly
 * ones are anchored by Rekor alone — still a log the operator does not run, findable by anyone from the checkpoint's
 * artifact hash, no repo access required.
 *
 * Everything here is PORTABLE: WebCrypto only, PEM/DER built by hand for Ed25519 (fixed prefixes — no node:crypto),
 * fetch injected. It runs identically in a Worker, Node tests, and the browser.
 */
import { Checkpoint, checkpointFromStore } from "./checkpoint.js";
import { canonicalize, sha256Hex } from "./chain.js";
import { EventStore } from "./store.js";

export const CRON_WITNESS_FORMAT = "retrace-witness/1";
export const CRON_DEFAULT_REKOR_URL = "https://rekor.sigstore.dev";

const subtle: SubtleCrypto = (globalThis as { crypto: Crypto }).crypto.subtle;

/* ---------- Ed25519 PEM without node:crypto ----------
 * SPKI  = 302a300506032b6570032100 || pub(32)
 * PKCS8 = 302e020100300506032b657004220420 || seed(32)
 * Fixed prefixes per RFC 8410; Ed25519 keys are always exactly 32 bytes, so the DER lengths never vary. */
const SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

function b64uToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function pemWrap(label: string, der: Uint8Array): string {
  const b64 = bytesToB64(der).replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** SPKI PEM for an Ed25519 public JWK — byte-identical to node:crypto's spki/pem export. */
export function ed25519SpkiPem(pub: JsonWebKey): string {
  if (pub.kty !== "OKP" || pub.crv !== "Ed25519" || typeof pub.x !== "string") throw new Error("not an Ed25519 public JWK");
  const x = b64uToBytes(pub.x);
  if (x.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  const der = new Uint8Array(SPKI_PREFIX.length + 32);
  der.set(SPKI_PREFIX);
  der.set(x, SPKI_PREFIX.length);
  return pemWrap("PUBLIC KEY", der);
}

function strip(jwk: JsonWebKey): JsonWebKey {
  const { alg: _a, ...rest } = jwk as JsonWebKey & { alg?: string };
  return rest;
}

async function signArtifact(privateJwk: JsonWebKey, artifact: Uint8Array): Promise<Uint8Array> {
  const key = await subtle.importKey("jwk", strip(privateJwk), { name: "Ed25519" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign({ name: "Ed25519" }, key, artifact as unknown as ArrayBuffer));
}

/** Same record shape the CLI's witness writes to .retrace/witnesses.jsonl. */
export interface CronWitnessRecord {
  format: typeof CRON_WITNESS_FORMAT;
  kind: "rekor";
  rekor_url: string;
  checkpoint: { project: string; seq: number; head_hash: string };
  checkpoint_sha256: string;
  signer_kid?: string;
  uuid: string;
  log_index: number;
  log_id: string;
  integrated_time: number;
  body: string;
  set: string;
}

export type PortableFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Submit a signed checkpoint to Rekor (kind "rekord": full checkpoint bytes + a fresh Ed25519 signature by the
 * checkpoint's signer, whose public key must equal `publicJwk`). Portable twin of the CLI's witnessCheckpoint.
 */
export async function witnessCheckpointRekor(
  cp: Checkpoint,
  privateJwk: JsonWebKey,
  opts: { rekorUrl?: string; fetchImpl?: PortableFetch } = {},
): Promise<CronWitnessRecord> {
  if (!cp.signature || !cp.signer) throw new Error("refusing to witness an unsigned checkpoint");
  const rekorUrl = (opts.rekorUrl ?? CRON_DEFAULT_REKOR_URL).replace(/\/+$/, "");
  const f: PortableFetch = opts.fetchImpl ?? (fetch as unknown as PortableFetch);
  const { d: _d, ...pub } = strip(privateJwk) as JsonWebKey & { d?: string };
  const pubPem = ed25519SpkiPem(pub);
  if (pubPem !== ed25519SpkiPem(cp.signer.public_key)) throw new Error("witness key does not match the checkpoint's signer");
  const artifactText = canonicalize(cp);
  const artifact = new TextEncoder().encode(artifactText);
  const sig = await signArtifact(privateJwk, artifact);
  const entry = {
    apiVersion: "0.0.1",
    kind: "rekord",
    spec: {
      data: { content: bytesToB64(artifact) },
      signature: { format: "x509", content: bytesToB64(sig), publicKey: { content: bytesToB64(new TextEncoder().encode(pubPem)) } },
    },
  };
  const res = await f(`${rekorUrl}/api/v1/log/entries`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(entry) });
  const text = await res.text();
  if (!res.ok && res.status !== 409) throw new Error(`Rekor ${res.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as Record<string, { body: string; integratedTime: number; logID: string; logIndex: number; verification?: { signedEntryTimestamp?: string } }>;
  const uuid = Object.keys(parsed)[0];
  const e = uuid ? parsed[uuid] : undefined;
  if (!uuid || !e?.verification?.signedEntryTimestamp) throw new Error(`Rekor response missing entry/SET: ${text.slice(0, 200)}`);
  return {
    format: CRON_WITNESS_FORMAT,
    kind: "rekor",
    rekor_url: rekorUrl,
    checkpoint: { project: cp.project, seq: cp.seq, head_hash: cp.head_hash },
    checkpoint_sha256: await sha256Hex(artifactText),
    signer_kid: cp.signer.kid,
    uuid,
    log_index: e.logIndex,
    log_id: e.logID,
    integrated_time: e.integratedTime,
    body: e.body,
    set: e.verification.signedEntryTimestamp,
  };
}

/** Where scheduled checkpoints are recorded (a D1 table on the Worker; anything with these two methods in tests). */
export interface CheckpointLogStore {
  latest(project: string): Promise<{ seq: number; head_hash: string; witnessed: boolean } | null>;
  save(row: CheckpointLogRow): Promise<void>;
}

export interface CheckpointLogRow {
  project: string;
  seq: number;
  head_hash: string;
  at: string;
  /** full signed checkpoint, JSON */
  checkpoint: string;
  /** full witness record, JSON — null when Rekor was unreachable (recorded in witness_error instead) */
  witness: string | null;
  witness_error?: string;
}

export interface CronResult {
  project: string;
  action: "unchanged" | "checkpointed" | "retried";
  seq?: number;
  witness?: "ok" | `failed: ${string}`;
}

/** Parse the Worker's explicit public-witness opt-in. Missing/blank means no projects; malformed values fail closed. */
export function parseCheckpointProjectAllowlist(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("RETRACE_CHECKPOINT_PROJECTS must be a JSON array of non-empty project names");
  }
  if (!Array.isArray(value) || value.some((project) => typeof project !== "string" || project.length === 0)) {
    throw new Error("RETRACE_CHECKPOINT_PROJECTS must be a JSON array of non-empty project names");
  }
  return [...new Set(value as string[])];
}

/**
 * One scheduled run: checkpoint every explicitly opted-in project whose head moved since its last logged checkpoint,
 * witness each in Rekor, and record the pair. The caller must supply the allowlist; an empty list publishes nothing.
 * A Rekor failure never discards the checkpoint: the row is saved with witness_error, then every later run retries
 * that same head until a witness succeeds. Store-derived checkpoints are signed by the host's signing key; refuses
 * to run unsigned (an unsigned scheduled checkpoint asserts nothing worth storing).
 */
export async function runCheckpointCron(
  store: EventStore,
  log: CheckpointLogStore,
  opts: { signingKey: JsonWebKey; projects: readonly string[]; signerName?: string; rekorUrl?: string; fetchImpl?: PortableFetch; now?: Date },
): Promise<CronResult[]> {
  if (!opts.signingKey) throw new Error("checkpoint cron needs the signing key");
  if (opts.projects.some((project) => typeof project !== "string" || project.length === 0)) throw new Error("checkpoint cron project names must be non-empty strings");
  const results: CronResult[] = [];
  for (const project of new Set(opts.projects)) {
    const head = await store.head(project);
    if (!head) continue;
    const last = await log.latest(project);
    const sameHead = !!last && last.seq === head.seq && last.head_hash === head.hash;
    if (sameHead && last.witnessed) {
      results.push({ project, action: "unchanged" });
      continue;
    }
    const cp = await checkpointFromStore(store, project, { signingKey: opts.signingKey, signerName: opts.signerName, now: opts.now });
    let witness: string | null = null;
    let witness_error: string | undefined;
    let verdict: CronResult["witness"];
    try {
      const rec = await witnessCheckpointRekor(cp, opts.signingKey, { rekorUrl: opts.rekorUrl, fetchImpl: opts.fetchImpl });
      witness = JSON.stringify(rec);
      verdict = "ok";
    } catch (e) {
      witness_error = String((e as Error).message ?? e).slice(0, 300);
      verdict = `failed: ${witness_error}` as CronResult["witness"];
    }
    await log.save({ project, seq: cp.seq, head_hash: cp.head_hash, at: cp.at, checkpoint: JSON.stringify(cp), witness, witness_error });
    results.push({ project, action: sameHead ? "retried" : "checkpointed", seq: cp.seq, witness: verdict });
  }
  return results;
}
