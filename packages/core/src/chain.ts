/**
 * Hash chain: each event's hash covers its canonical content + prev_hash.
 * Uses WebCrypto so it runs in Node 20+, Cloudflare Workers and browsers.
 */
import { Event, EventInput, GENESIS_HASH } from "./schema.js";

const cryptoImpl: Crypto = (globalThis as any).crypto;

/** Deterministic JSON: sorted keys, no undefined. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as any)[k];
      if (val !== undefined) out[k] = sortKeys(val);
    }
    return out;
  }
  return v;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The fields that are covered by the hash.
 * `received_at` is included for events sealed after this change (the server's arrival time, not the caller's
 * `timestamp`). Pass `includeReceivedAt: false` to recompute a pre-change digest.
 */
export function hashPayload(e: object, opts?: { includeReceivedAt?: boolean }): string {
  const { hash: _h, received_at, ...rest } = e as any;
  const include = opts?.includeReceivedAt !== false && received_at !== undefined;
  return canonicalize(include ? { ...rest, received_at } : rest);
}

/**
 * Hash of an event's canonical content.
 * New seals cover `received_at`. When `e.hash` is already set and does not match that digest, recompute
 * without `received_at` so events sealed before this change still verify. A later `received_at` edit on
 * those legacy events is not detectable — they were never covered.
 */
export async function computeHash(e: object): Promise<string> {
  const covered = await sha256Hex(hashPayload(e));
  const stored = (e as { hash?: string }).hash;
  if (!stored || stored === covered) return covered;
  return sha256Hex(hashPayload(e, { includeReceivedAt: false }));
}

export function newId(): string {
  return "evt_" + cryptoImpl.randomUUID().replace(/-/g, "");
}

/** Build a full Event from input + previous chain head. */
export async function sealEvent(
  input: EventInput,
  prev: { seq: number; hash: string } | null,
  now: Date = new Date(),
): Promise<Event> {
  const seq = prev ? prev.seq + 1 : 0;
  const prev_hash = prev ? prev.hash : GENESIS_HASH;
  const received_at = now.toISOString();
  const base = {
    ...input,
    id: newId(),
    seq,
    timestamp: input.timestamp ?? received_at,
    prev_hash,
    received_at,
  };
  const hash = await computeHash(base);
  return Event.parse({ ...base, hash });
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  first_bad_seq?: number;
  reason?: string;
}

/** Verify a project's chain, given events sorted by seq ascending. */
export async function verifyChain(events: Event[]): Promise<VerifyResult> {
  let prevHash = GENESIS_HASH;
  let expectedSeq = 0;
  for (const e of events) {
    if (e.seq !== expectedSeq) return { ok: false, checked: expectedSeq, first_bad_seq: e.seq, reason: `sequence gap: expected ${expectedSeq}, got ${e.seq}` };
    if (e.prev_hash !== prevHash) return { ok: false, checked: expectedSeq, first_bad_seq: e.seq, reason: "prev_hash mismatch (chain broken)" };
    const recomputed = await computeHash(e);
    if (recomputed !== e.hash) return { ok: false, checked: expectedSeq, first_bad_seq: e.seq, reason: "content hash mismatch (event tampered)" };
    prevHash = e.hash;
    expectedSeq++;
  }
  return { ok: true, checked: expectedSeq };
}
