/**
 * External witness for head checkpoints — tamper-evident roadmap rung 1.
 *
 * A checkpoint committed to this repo is witnessed by git; but the repo and the ledger share an operator, so "the
 * head existed at time T" still rests on that operator. Submitting the signed checkpoint to the public Rekor
 * transparency log (rekor.sigstore.dev) adds a witness the operator does not control: Rekor verifies our Ed25519
 * signature over the checkpoint bytes, assigns an immutable log index, and returns a Signed Entry Timestamp (SET) —
 * Rekor's own ECDSA-P256 signature over {body, integratedTime, logID, logIndex} — which anyone can verify offline
 * against Rekor's published public key. Rewriting a witnessed head now requires rewriting a Merkle log operated by
 * the Linux Foundation, not just this repository.
 *
 * Entry type: kind "rekord" with the full checkpoint JSON as content (checkpoints are public already — they live in
 * a public repo) and an x509-format Ed25519 signature. hashedrekord is not used: Rekor rejects Ed25519 over a SHA-256
 * digest (pure Ed25519 cannot verify against a digest), and we prefer keeping the one checkpoint key over adding a
 * P-256 sidecar key.
 *
 * Node-only (PEM conversion via node:crypto); the browser/Worker never needs to *create* witnesses.
 */
import { createHash, createPublicKey, createPrivateKey, createVerify, sign as edSign } from "node:crypto";
import { canonicalize, Checkpoint } from "@retrace-dev/core";

export const WITNESS_FORMAT = "retrace-witness/1";
export const DEFAULT_REKOR_URL = "https://rekor.sigstore.dev";

export interface WitnessRecord {
  format: typeof WITNESS_FORMAT;
  kind: "rekor";
  rekor_url: string;
  /** which checkpoint this witnesses (convenience copy; the binding fact is checkpoint_sha256) */
  checkpoint: { project: string; seq: number; head_hash: string };
  /** sha256 over canonicalize(checkpoint) — the exact artifact Rekor's entry hashes and our signature covers */
  checkpoint_sha256: string;
  /** kid of the key that signed the Rekor entry (the checkpoint signer) */
  signer_kid?: string;
  uuid: string;
  log_index: number;
  log_id: string;
  integrated_time: number;
  /** base64 canonical entry body as stored in the log — part of what the SET signs */
  body: string;
  /** base64 Signed Entry Timestamp: Rekor's signature over {body, integratedTime, logID, logIndex} */
  set: string;
}

export interface WitnessVerdict {
  ok: boolean;
  problems: string[];
  /** human-readable summary when ok */
  note?: string;
}

/** The exact bytes we witness: the canonical JSON of the checkpoint, signature included. */
export function checkpointArtifact(cp: Checkpoint): Buffer {
  return Buffer.from(canonicalize(cp), "utf8");
}

export function sha256HexSync(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function jwkToPem(jwk: JsonWebKey, kind: "public" | "private"): string {
  const { alg: _drop, ...clean } = jwk as JsonWebKey & { alg?: string };
  const key = kind === "public" ? createPublicKey({ key: clean as never, format: "jwk" }) : createPrivateKey({ key: clean as never, format: "jwk" });
  return key.export({ type: kind === "public" ? "spki" : "pkcs8", format: "pem" }).toString();
}

/** Rekor canonical JSON (sorted keys) — matches the payload the SET signs. */
function canonJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonJson).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ":" + canonJson((v as any)[k])).join(",") + "}";
  return JSON.stringify(v);
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Submit a signed checkpoint to Rekor. Needs the checkpoint's PRIVATE key (the entry signature must be freshly made
 * over the artifact bytes; the checkpoint's own signature covers a different message). Refuses an unsigned checkpoint
 * or a key that does not match the checkpoint's signer — a witness for a checkpoint signed by someone else would
 * assert nothing.
 */
export async function witnessCheckpoint(
  cp: Checkpoint,
  privateJwk: JsonWebKey,
  opts: { rekorUrl?: string; fetchImpl?: FetchLike } = {},
): Promise<WitnessRecord> {
  if (!cp.signature || !cp.signer) throw new Error("refusing to witness an unsigned checkpoint");
  const rekorUrl = (opts.rekorUrl ?? DEFAULT_REKOR_URL).replace(/\/+$/, "");
  const f: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const artifact = checkpointArtifact(cp);
  const priv = createPrivateKey({ key: strip(privateJwk) as never, format: "jwk" });
  const pubPem = jwkToPem(publicJwkOf(privateJwk), "public");
  // the witness must be by the checkpoint's signer: compare SPKI PEMs
  const signerPem = jwkToPem(cp.signer.public_key, "public");
  if (pubPem !== signerPem) throw new Error("witness key does not match the checkpoint's signer");
  const sig = edSign(null, artifact, priv);
  const entry = {
    apiVersion: "0.0.1",
    kind: "rekord",
    spec: {
      data: { content: artifact.toString("base64") },
      signature: { format: "x509", content: sig.toString("base64"), publicKey: { content: Buffer.from(pubPem).toString("base64") } },
    },
  };
  const res = await f(`${rekorUrl}/api/v1/log/entries`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(entry) });
  const text = await res.text();
  if (!res.ok && res.status !== 409) throw new Error(`Rekor ${res.status}: ${text.slice(0, 200)}`);
  // 409 = entry already exists; Rekor sends the location header, but re-witnessing the same bytes is idempotent enough
  // that we just parse whichever body came back (409 responses also include the entry map on rekor.sigstore.dev).
  const parsed = JSON.parse(text) as Record<string, { body: string; integratedTime: number; logID: string; logIndex: number; verification?: { signedEntryTimestamp?: string } }>;
  const uuid = Object.keys(parsed)[0];
  const e = uuid ? parsed[uuid] : undefined;
  if (!uuid || !e?.verification?.signedEntryTimestamp) throw new Error(`Rekor response missing entry/SET: ${text.slice(0, 200)}`);
  return {
    format: WITNESS_FORMAT,
    kind: "rekor",
    rekor_url: rekorUrl,
    checkpoint: { project: cp.project, seq: cp.seq, head_hash: cp.head_hash },
    checkpoint_sha256: sha256HexSync(artifact),
    signer_kid: cp.signer.kid,
    uuid,
    log_index: e.logIndex,
    log_id: e.logID,
    integrated_time: e.integratedTime,
    body: e.body,
    set: e.verification.signedEntryTimestamp,
  };
}

function strip(jwk: JsonWebKey): JsonWebKey { const { alg: _a, ...rest } = jwk as JsonWebKey & { alg?: string }; return rest; }

function publicJwkOf(priv: JsonWebKey): JsonWebKey {
  const { d: _d, ...pub } = strip(priv) as JsonWebKey & { d?: string };
  return pub;
}

export async function fetchRekorPublicKey(rekorUrl: string = DEFAULT_REKOR_URL, fetchImpl?: FetchLike): Promise<string> {
  const f: FetchLike = fetchImpl ?? (fetch as unknown as FetchLike);
  const res = await f(`${rekorUrl.replace(/\/+$/, "")}/api/v1/log/publicKey`);
  if (!res.ok) throw new Error(`Rekor publicKey → ${res.status}`);
  const pem = await res.text();
  if (!/BEGIN PUBLIC KEY/.test(pem)) throw new Error("Rekor publicKey response is not a PEM public key");
  return pem;
}

/**
 * OFFLINE verification of a witness against its checkpoint and Rekor's public key:
 *  1. the record's checkpoint_sha256 equals sha256(canonical checkpoint) — the witness is about THIS checkpoint;
 *  2. the logged entry body embeds that same artifact and hash, signed by the checkpoint's signer key;
 *  3. the SET — Rekor's signature over {body, integratedTime, logID, logIndex} — verifies with rekorPublicKeyPem.
 * No network. Trust anchor: how you obtained rekorPublicKeyPem (commit it, or fetch over https and pin).
 */
export async function verifyWitness(record: WitnessRecord, cp: Checkpoint, rekorPublicKeyPem: string): Promise<WitnessVerdict> {
  const problems: string[] = [];
  if (record.format !== WITNESS_FORMAT) problems.push(`unknown witness format ${String(record.format)}`);
  if (record.kind !== "rekor") problems.push(`unknown witness kind ${String((record as { kind?: string }).kind)}`);
  const artifact = checkpointArtifact(cp);
  const digest = sha256HexSync(artifact);
  if (record.checkpoint_sha256 !== digest) problems.push(`witness is for checkpoint sha256 ${record.checkpoint_sha256.slice(0, 12)}…, this checkpoint is ${digest.slice(0, 12)}…`);
  // decode the logged body and tie it to the artifact + signer
  try {
    const body = JSON.parse(Buffer.from(record.body, "base64").toString("utf8")) as { kind?: string; spec?: { data?: { content?: string; hash?: { algorithm?: string; value?: string } }; signature?: { publicKey?: { content?: string } } } };
    if (body.kind !== "rekord") problems.push(`logged entry kind is ${String(body.kind)}, expected rekord`);
    const loggedHash = body.spec?.data?.hash?.value;
    const loggedContent = body.spec?.data?.content;
    if (loggedContent !== undefined && !Buffer.from(loggedContent, "base64").equals(artifact)) problems.push("logged entry content is not this checkpoint");
    if (loggedContent === undefined && loggedHash !== digest) problems.push(`logged entry hashes ${String(loggedHash).slice(0, 12)}…, not this checkpoint`);
    const loggedKey = body.spec?.signature?.publicKey?.content;
    if (cp.signer && loggedKey) {
      const signerPem = jwkToPem(cp.signer.public_key, "public");
      if (Buffer.from(loggedKey, "base64").toString("utf8") !== signerPem) problems.push("logged entry was signed by a different key than the checkpoint's signer");
    }
  } catch (e) {
    problems.push(`cannot decode logged entry body: ${(e as Error).message}`);
  }
  // SET
  try {
    const payload = { body: record.body, integratedTime: record.integrated_time, logID: record.log_id, logIndex: record.log_index };
    const v = createVerify("SHA256");
    v.update(Buffer.from(canonJson(payload), "utf8"));
    if (!v.verify(createPublicKey(rekorPublicKeyPem), Buffer.from(record.set, "base64"))) problems.push("SET does not verify — witness record altered or wrong Rekor key");
  } catch (e) {
    problems.push(`SET verification failed: ${(e as Error).message}`);
  }
  const ok = problems.length === 0;
  return {
    ok,
    problems,
    note: ok ? `witnessed by Rekor log index ${record.log_index} at ${new Date(record.integrated_time * 1000).toISOString()}` : undefined,
  };
}

/** JSON-lines helpers, mirroring parseCheckpointLog. */
export function parseWitnessLog(text: string): WitnessRecord[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as WitnessRecord).filter((w) => w.format === WITNESS_FORMAT);
}

export function witnessFor(witnesses: WitnessRecord[], cp: Checkpoint): WitnessRecord | undefined {
  const digest = sha256HexSync(checkpointArtifact(cp));
  return [...witnesses].reverse().find((w) => w.checkpoint_sha256 === digest);
}
