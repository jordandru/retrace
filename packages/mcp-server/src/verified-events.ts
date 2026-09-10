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

export type TrustedIssuer = { key: JsonWebKey; from: string };

const NO_TRUSTED_KEY = "no trusted issuer key: pass --pubkey <jwk.json|https-url>, set RETRACE_PUBKEY, or set RETRACE_URL to an https Retrace server (its /.well-known/retrace-pubkey is used)";

/**
 * Use remote export events only after the signed full bundle verifies against a trusted issuer key.
 * Tail events are deliberately not inserted into the bundle: its signature and coverage claim remain unchanged.
 */
export async function verifiedExportEvents(
  bundle: ExportBundle,
  pubkeyFlag?: unknown,
  baseUrl?: string,
  trustedKey?: TrustedIssuer,
  opts?: { trustedHookStamps?: readonly string[]; project?: string },
): Promise<{ events: Event[]; note: string }> {
  const trusted = trustedKey ?? await resolveTrustedKey(pubkeyFlag, baseUrl);
  if (!trusted) throw new Error(NO_TRUSTED_KEY);
  const verdict = await verifyExportBundle(bundle, trusted.key, {
    project: opts?.project ?? bundle.scope.project,
  });
  if (!exportVerdictOk(verdict)) {
    throw new Error(`refusing to reconcile against an export that does not verify (signature ${verdict.signature}, events intact ${verdict.events_intact}, chain ${verdict.chain_ok_at_export}, coverage ${verdict.coverage.complete})${verdict.problems.length ? ": " + verdict.problems.join("; ") : ""}`);
  }
  if (verdict.coverage.scope !== "full" || verdict.coverage.complete !== true) {
    const scope = bundle.scope ?? {};
    const named = [
      scope.artifact_id && `artifact_id=${scope.artifact_id}`,
      scope.actor_id && `actor_id=${scope.actor_id}`,
      scope.since && `since=${scope.since}`,
      scope.until && `until=${scope.until}`,
    ].filter(Boolean).join(", ") || "unspecified filters";
    throw new Error(`refusing to reconcile against a ${verdict.coverage.scope} export (scope ${named}); need a full export with complete coverage`);
  }
  return { events: bundle.events, note: `${bundle.events.length} events from a full export verified against ${trusted.from} (kid ${verdict.kid})` };
}

const HISTORY_TAIL_PAGE_MAX = 500;
const SIGNED_HEAD_MAX_AGE_MS = 10 * 60 * 1000;
/** A signed head dated in the future is not "fresh", it is wrong: the age check alone would accept any future stamp
 *  because the age comes out negative (Codex follow-up on PR 12). Allow only ordinary clock skew. */
const SIGNED_HEAD_MAX_SKEW_MS = 2 * 60 * 1000;

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

function confirmedCacheMiss(error: unknown): boolean {
  return error instanceof RemoteApiError
    && error.status === 404
    && error.headers.get("x-retrace-export-cache") === "miss";
}

/** A valid signature on another project's full export must not authorize this project. */
export function assertExportMatchesProject(bundle: ExportBundle, project: string): void {
  const scoped = bundle.scope?.project;
  if (scoped !== project) {
    throw new Error(`refusing export scoped to project "${scoped ?? ""}" when "${project}" was requested`);
  }
  const foreign = bundle.events.find((event) => event.project !== project);
  if (foreign) {
    throw new Error(`refusing export containing event #${foreign.seq} from project "${foreign.project}" when "${project}" was requested`);
  }
}

type SignedLiveHead = {
  project: string;
  seq: number;
  hash: string;
  signed_at: string;
  issuer: { kid: string; alg: string; public_key?: JsonWebKey };
  signature: string;
};

async function authenticatedLiveHead(
  store: RemoteStore,
  project: string,
  trusted: TrustedIssuer,
): Promise<SignedLiveHead> {
  const liveHead = await store.signedHead(project);
  if (!liveHead) {
    throw new Error("signed live head is missing or unsigned; an empty ledger must still return a signed empty head");
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
  const age = Date.now() - signedAt;
  if (!Number.isFinite(signedAt) || age > SIGNED_HEAD_MAX_AGE_MS) {
    throw new Error(`signed live head is stale or has an invalid signed_at: ${liveHead.signed_at}`);
  }
  if (age < -SIGNED_HEAD_MAX_SKEW_MS) {
    throw new Error(`signed live head is dated in the future beyond clock skew: ${liveHead.signed_at}`);
  }
  const headPayload = { project: liveHead.project, seq: liveHead.seq, hash: liveHead.hash, signed_at: liveHead.signed_at };
  if (liveHead.project !== project || !(await verifyCanonical(trusted.key, headPayload, liveHead.signature))) {
    throw new Error("signed live head does not verify against the trusted issuer key");
  }
  return liveHead;
}

/** Bind a verified full export to the live signed head, then extend with a chain-verified tail if needed. */
async function extendVerifiedExportToLiveHead(
  store: RemoteStore,
  project: string,
  bundle: ExportBundle,
  verified: { events: Event[]; note: string },
  trusted: TrustedIssuer,
  origin: "cache" | "fresh",
): Promise<{ events: Event[]; note: string }> {
  assertExportMatchesProject(bundle, project);
  const total = bundle.chain.total_events;
  const bundleHead = total > 0
    ? { seq: total - 1, hash: bundle.chain.head_hash! }
    : { seq: -1, hash: GENESIS_HASH };
  const liveHead = await authenticatedLiveHead(store, project, trusted);
  const originNote = origin === "fresh"
    ? `${verified.note}; no signed export cache, verified live full export`
    : verified.note;
  if (liveHead.seq < bundleHead.seq) {
    throw new Error(`live head #${liveHead.seq} is behind signed cache head #${bundleHead.seq}`);
  }
  if (liveHead.seq === bundleHead.seq) {
    if (liveHead.hash !== bundleHead.hash) throw new Error(`live head hash disagrees with signed cache head #${bundleHead.seq}`);
    return { events: verified.events, note: `${originNote}; signed live head confirms cache through #${bundleHead.seq}; no tail` };
  }

  const tail = await historyTail(store, project, bundleHead.seq, liveHead.seq);
  const foreign = tail.find((event) => event.project !== project);
  if (foreign) {
    throw new Error(`refusing export tail containing event #${foreign.seq} from project "${foreign.project}" when "${project}" was requested`);
  }
  const tailVerdict = await verifyChainTail(bundleHead, tail);
  if (!tailVerdict.ok) throw new Error(`refusing unverified export tail: ${tailVerdict.reason}`);
  const tailHead = tail.at(-1);
  if (!tailHead || tailHead.seq !== liveHead.seq) {
    throw new Error(`export tail is incomplete: expected through #${liveHead.seq}, got ${tailHead ? `#${tailHead.seq}` : "no events"}`);
  }
  if (tailHead.hash !== liveHead.hash) throw new Error(`chain-verified tail head #${liveHead.seq} disagrees with live head hash`);
  const tailNote = origin === "fresh"
    ? `${originNote}; signed live head through #${liveHead.seq}; chain-verified tail #${bundleHead.seq + 1}..#${liveHead.seq}`
    : `${originNote}; signed cache through #${bundleHead.seq}; chain-verified tail #${bundleHead.seq + 1}..#${liveHead.seq} verified against signed live head`;
  return { events: [...verified.events, ...tail], note: tailNote };
}

/** Load a verified signed cache (or a confirmed-miss live full export) and extend it to the live head. */
export async function fetchVerifiedRemoteEvents(
  store: RemoteStore,
  project: string,
  pubkeyFlag?: unknown,
  baseUrl?: string,
  opts?: { trustedHookStamps?: readonly string[]; project?: string },
): Promise<{ events: Event[]; note: string }> {
  let resolved: TrustedIssuer | undefined;
  const issuer = async (): Promise<TrustedIssuer> => {
    if (resolved) return resolved;
    resolved = await resolveTrustedKey(pubkeyFlag, baseUrl);
    if (!resolved) throw new Error(NO_TRUSTED_KEY);
    return resolved;
  };
  let bundle: ExportBundle;
  let origin: "cache" | "fresh" = "cache";
  try {
    bundle = await store.export({ project }, { cached: true });
  } catch (error) {
    if (!confirmedCacheMiss(error)) throw error;
    bundle = await store.export({ project }, { fresh: true });
    origin = "fresh";
  }

  const trusted = await issuer();
  const verified = await verifiedExportEvents(bundle, pubkeyFlag, baseUrl, trusted, opts);
  return extendVerifiedExportToLiveHead(store, project, bundle, verified, trusted, origin);
}
