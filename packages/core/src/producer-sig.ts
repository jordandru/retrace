/**
 * Producer-side signing — tamper-evident roadmap rung 5 (docs/producer-signing-plan.md).
 *
 * WHO in the ledger is otherwise exactly as strong as the server's credential store: `sealed_by` is the server's own
 * stamp, so a compromised server can seal any actor onto any event. Here every client-side producer signs its events
 * with an Ed25519 key the server NEVER holds; `producer_sig` is a top-level event field, so the v2 hash seals it
 * (chain.ts hashPayload covers every key but `hash`) and stripping it later breaks the chain. The server verifies at
 * write time against the public key registered on the credential and stamps a verdict; offline verify re-checks.
 *
 * The signature covers an EXPLICIT payload, never "the whole body": the server legitimately annotates events before
 * sealing (tags via markCausedByUnverified, method.params stamps like sealed_by, location.client, and on pinned
 * credentials parts of actor). Signed: project, actor {type, id, on_behalf_of}, action, action_detail, artifacts,
 * change, timestamp, duration_ms, intent, caused_by, idempotency_key. Deliberately NOT signed: actor.model (the model
 * stays asserted — never claim it), display_name/version, tags, method, location. A signing producer MUST set
 * `timestamp` itself: the server fills a missing one, and a signature over an absent timestamp could never be
 * re-verified from the stored event. And because verification recomputes the payload from the STORED event, a
 * producer must sign `actor.{type, id, on_behalf_of}` exactly as its credential resolves them — same on_behalf_of, or
 * omitted when the credential omits it. Divergence lands `invalid`, by design: that IS the actor-mismatch defense
 * (signing as yourself and submitting on someone else's credential changes the recomputed payload).
 */
import { Event, EventInput } from "./schema.js";
import { keyId, publicFromPrivate, signCanonical, verifyCanonical } from "./signing.js";

export const PRODUCER_SIG_FORMAT = "retrace-producer-sig/1";
/** method.params key for the server's verdict — the `sealed_by` precedent: server wins, hash-covered. */
export const PRODUCER_SIG_VERDICT_PARAM = "producer_sig_verdict";

export interface ProducerSig { kid: string; sig: string }
export type ProducerSigVerdict = "verified" | "invalid" | "unknown_kid" | "none";
/** A registered producer public key — lives on the credential (server) and in export bundles (offline verify). */
export interface ProducerKey { kid: string; public_key: JsonWebKey; actor_id?: string; name?: string }

type Signable = EventInput | Event;

/** The exact bytes-source both sides sign/verify: built the same way from a submitted input or a stored event. */
export function producerSignedPayload(e: Signable): Record<string, unknown> {
  const p: Record<string, unknown> = {
    v: PRODUCER_SIG_FORMAT,
    project: e.project,
    actor: { type: e.actor.type, id: e.actor.id, ...(e.actor.on_behalf_of !== undefined ? { on_behalf_of: e.actor.on_behalf_of } : {}) },
    action: e.action,
  };
  for (const k of ["action_detail", "artifacts", "change", "timestamp", "duration_ms", "intent", "caused_by", "idempotency_key"] as const) {
    const v = e[k];
    if (v !== undefined) p[k] = v;
  }
  return p;
}

/** Attach a signature to an input about to be submitted. Throws without `timestamp` — see the module doc. */
export async function signProducer<T extends EventInput>(input: T, privateJwk: JsonWebKey): Promise<T & { producer_sig: ProducerSig }> {
  if (!input.timestamp) throw new Error("a signing producer must set timestamp itself; the server would fill it and the signature could never be re-verified");
  const pub = publicFromPrivate(privateJwk);
  return { ...input, producer_sig: { kid: await keyId(pub), sig: await signCanonical(privateJwk, producerSignedPayload(input)) } };
}

/** Does this event's signature verify with this public key? Pure; no registry. */
export async function verifyProducerSig(e: Signable, publicJwk: JsonWebKey): Promise<boolean> {
  if (!e.producer_sig || !e.timestamp) return false;
  return verifyCanonical(publicJwk, producerSignedPayload(e), e.producer_sig.sig);
}

/**
 * The server-side rule, pure so the POST /events hunk stays three lines. Called AFTER actor resolution — the payload
 * is rebuilt from the resolved input, which is what gets sealed and what offline verify will see. A producer that
 * signed a different actor than the credential resolves to therefore lands `invalid`: signing as yourself and
 * submitting on someone else's credential is not a verified event.
 *   none         no signature presented
 *   unknown_kid  a signature, but no key registered on the credential, or a kid that is not that key's
 *   invalid      the signature does not verify over the resolved payload (or timestamp is missing)
 *   verified     everything checks
 */
export async function producerSigVerdict(input: Signable, registered?: JsonWebKey | null): Promise<ProducerSigVerdict> {
  if (!input.producer_sig) return "none";
  if (!registered) return "unknown_kid";
  if (input.producer_sig.kid !== (await keyId(registered))) return "unknown_kid";
  if (!input.timestamp) return "invalid";
  return (await verifyProducerSig(input, registered)) ? "verified" : "invalid";
}

export interface ProducerSigCounts {
  /** events whose signature verified against a known producer key */
  producer_signed: number;
  /** events with a signature that is wrong or unmatchable — each one is a problem */
  producer_invalid: number;
  /** agent events with no signature at all (pre-rollout, or a producer without a key) — informational, like legacy_hash_events */
  producer_unsigned_agent_events: number;
  problems: string[];
}

/**
 * Offline re-check for export verification: recompute each signed event's payload against the supplied keys.
 * A key validates only events sealed as ITS actor (`actor_id` binding — reused key material registered to actor A must
 * not validate an event sealed as actor B, mirroring the server's per-credential check). An EMPTY key list means the
 * signatures are uncheckable (an old bundle with no producers and no --producers file): signed events are neither
 * counted nor flagged; only the unsigned-agent count is meaningful then.
 */
export async function countProducerSigs(events: Event[], keys: ProducerKey[]): Promise<ProducerSigCounts> {
  const byKid = new Map(keys.map((k) => [k.kid, k]));
  const c: ProducerSigCounts = { producer_signed: 0, producer_invalid: 0, producer_unsigned_agent_events: 0, problems: [] };
  for (const e of events) {
    if (!e.producer_sig) {
      if (e.actor.type === "agent") c.producer_unsigned_agent_events++;
      continue;
    }
    if (keys.length === 0) continue; // uncheckable, not invalid
    const key = byKid.get(e.producer_sig.kid);
    if (!key || (key.actor_id !== undefined && key.actor_id !== e.actor.id)) {
      c.producer_invalid++;
      c.problems.push(`event #${e.seq}: producer_sig kid ${e.producer_sig.kid.slice(0, 12)} is not a registered key for actor ${e.actor.id}`);
      continue;
    }
    if (await verifyProducerSig(e, key.public_key)) c.producer_signed++;
    else { c.producer_invalid++; c.problems.push(`event #${e.seq}: producer signature does not verify — signed fields altered, or the wrong key`); }
  }
  return c;
}
