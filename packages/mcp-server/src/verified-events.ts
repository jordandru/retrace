import {
  Event,
  ExportBundle,
  GENESIS_HASH,
  exportVerdictOk,
  keyId,
  verifyChainTail,
  verifyCanonical,
  verifyExportBundle,
} from "@retrace-dev/core";
import { RemoteApiError, RemoteStore } from "./remote-store.js";
import { resolveTrustedKey } from "./trusted-key.js";

/**
 * Use remote export events only after the signed full bundle verifies against a trusted issuer key.
 * Tail events are deliberately not inserted into the bundle: its signature and coverage claim remain unchanged.
 */
export async function verifiedExportEvents(bundle: ExportBundle, pubkeyFlag?: unknown, baseUrl?: string): Promise<{ events: Event[]; note: string }> {
  const trusted = await resolveTrustedKey(pubkeyFlag, baseUrl);
  if (!trusted) throw new Error("no trusted issuer key: pass --pubkey <jwk.json|https-url>, set RETRACE_PUBKEY, or set RETRACE_URL to an https Retrace server (its /.well-known/retrace-pubkey is used)");
  const verdict = await verifyExportBundle(bundle, trusted.key);
  if (!exportVerdictOk(verdict)) {
    throw new Error(`refusing to reconcile against an export that does not verify (signature ${verdict.signature}, events intact ${verdict.events_intact}, chain ${verdict.chain_ok_at_export}, coverage ${verdict.coverage.complete})${verdict.problems.length ? ": " + verdict.problems.join("; ") : ""}`);
  }
  return { events: bundle.events, note: `${bundle.events.length} events from a full export verified against ${trusted.from} (kid ${verdict.kid})` };
}

const HISTORY_TAIL_PAGE_MAX = 500;
const SIGNED_HEAD_MAX_AGE_MS = 10 * 60 * 1000;

export async function historyTail(store: RemoteStore, project: string, afterSeq: number, throughSeq: number): Promise<Event[]> {
  const bySeq = new Map<number, Event>();
  let before_seq: number | undefined;
  for (let pages = 0; pages < 10_000; pages++) {
    const upperExclusive = before_seq ?? throughSeq + 1;
    const remaining = upperExclusive - (afterSeq + 1);
    if (remaining <= 0) break;
    const page = await store.history({ project, before_seq, limit: Math.min(remaining, HISTORY_TAIL_PAGE_MAX) });
    for (const event of page.events) {
      if (event.seq > afterSeq && event.seq <= throughSeq) bySeq.set(event.seq, event);
    }
    if (page.events.some((event) => event.seq <= afterSeq + 1) || !page.truncated || page.next_before_seq === undefined) break;
    if (before_seq !== undefined && page.next_before_seq >= before_seq) throw new Error("history pagination did not move toward the cached head");
    before_seq = page.next_before_seq;
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Load a verified signed cache and extend it to the live head with a separately verified v2 hash-chain tail. */
export async function fetchVerifiedRemoteEvents(
  store: RemoteStore,
  project: string,
  pubkeyFlag?: unknown,
  baseUrl?: string,
): Promise<{ events: Event[]; note: string }> {
  let bundle: ExportBundle;
  try {
    bundle = await store.export({ project }, { cached: true });
  } catch (error) {
    if (
      !(error instanceof RemoteApiError)
      || error.status !== 404
      || error.headers.get("x-retrace-export-cache") !== "miss"
    ) throw error;
    const liveBundle = await store.export({ project }, { fresh: true });
    const verified = await verifiedExportEvents(liveBundle, pubkeyFlag, baseUrl);
    return { events: verified.events, note: `${verified.note}; no signed export cache, verified live full export` };
  }

  const verified = await verifiedExportEvents(bundle, pubkeyFlag, baseUrl);
  const total = bundle.chain.total_events;
  const cachedHead = total > 0
    ? { seq: total - 1, hash: bundle.chain.head_hash! }
    : { seq: -1, hash: GENESIS_HASH };
  const trusted = await resolveTrustedKey(pubkeyFlag, baseUrl);
  if (!trusted) throw new Error("no trusted issuer key for signed live head");
  const liveHead = await store.signedHead(project);

  if (!liveHead) {
    if (total === 0) return { events: verified.events, note: `${verified.note}; signed cache is empty; no tail` };
    throw new Error(`live ledger has no head but the signed cache claims through #${cachedHead.seq}`);
  }
  if (
    typeof liveHead.project !== "string"
    || !Number.isInteger(liveHead.seq)
    || typeof liveHead.hash !== "string"
    || typeof liveHead.signed_at !== "string"
    || typeof liveHead.signature !== "string"
    || !liveHead.issuer
    || typeof liveHead.issuer.kid !== "string"
    || liveHead.issuer.alg !== "Ed25519"
  ) {
    throw new Error("signed live head response is malformed or unsigned");
  }
  const trustedKid = await keyId(trusted.key);
  if (liveHead.issuer.kid !== trustedKid) {
    throw new Error(`signed live head issuer kid ${liveHead.issuer.kid} does not match trusted key kid ${trustedKid}`);
  }
  const signedAt = Date.parse(liveHead.signed_at);
  if (!Number.isFinite(signedAt) || Date.now() - signedAt > SIGNED_HEAD_MAX_AGE_MS) {
    throw new Error(`signed live head is stale or has an invalid signed_at: ${liveHead.signed_at}`);
  }
  const headPayload = { project: liveHead.project, seq: liveHead.seq, hash: liveHead.hash, signed_at: liveHead.signed_at };
  if (liveHead.project !== project || !(await verifyCanonical(trusted.key, headPayload, liveHead.signature))) {
    throw new Error("signed live head does not verify against the trusted issuer key");
  }
  if (liveHead.seq < cachedHead.seq) {
    throw new Error(`live head #${liveHead.seq} is behind signed cache head #${cachedHead.seq}`);
  }
  if (liveHead.seq === cachedHead.seq) {
    if (liveHead.hash !== cachedHead.hash) throw new Error(`live head hash disagrees with signed cache head #${cachedHead.seq}`);
    return { events: verified.events, note: `${verified.note}; signed live head confirms cache through #${cachedHead.seq}; no tail` };
  }

  const tail = await historyTail(store, project, cachedHead.seq, liveHead.seq);
  const tailVerdict = await verifyChainTail(cachedHead, tail);
  if (!tailVerdict.ok) throw new Error(`refusing unverified export tail: ${tailVerdict.reason}`);
  const tailHead = tail.at(-1);
  if (!tailHead || tailHead.seq !== liveHead.seq) {
    throw new Error(`export tail is incomplete: expected through #${liveHead.seq}, got ${tailHead ? `#${tailHead.seq}` : "no events"}`);
  }
  if (tailHead.hash !== liveHead.hash) throw new Error(`chain-verified tail head #${liveHead.seq} disagrees with live head hash`);
  return {
    events: [...verified.events, ...tail],
    note: `${verified.note}; signed cache through #${cachedHead.seq}; chain-verified tail #${cachedHead.seq + 1}..#${liveHead.seq} verified against signed live head`,
  };
}
