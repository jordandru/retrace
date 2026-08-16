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

/** The fields that are covered by the hash. */
export function hashPayload(e: Omit<Event, "hash" | "received_at">): string {
  const { hash: _h, received_at: _r, ...rest } = e as any;
  return canonicalize(rest);
}

export async function computeHash(e: Omit<Event, "hash" | "received_at">): Promise<string> {
  return sha256Hex(hashPayload(e));
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
  const base = {
    ...input,
    id: newId(),
    seq,
    timestamp: input.timestamp ?? now.toISOString(),
    prev_hash,
  };
  const hash = await computeHash(base as any);
  return Event.parse({ ...base, hash, received_at: now.toISOString() });
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
