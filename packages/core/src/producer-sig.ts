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
 * sealing. Signed: project, actor {type, id, on_behalf_of}, action, action_detail, artifacts, change, timestamp,
 * duration_ms, intent, caused_by, idempotency_key — AND tags, method and location minus exactly the server's
 * annotation surface (Codex review of 34e4871: leaving those out let a compromised server rewrite WHERE/HOW and inject
 * semantic tags like `correction` while the event stayed "producer_signed"). The reserved, unsigned remainder is:
 * tags starting `caused_by:` (markCausedByUnverified), method.params sealed_by / producer_sig_verdict / relayed_by /
 * caused_by_problem (server stamps), and location.client. The first two are REFUSED on input (signProducer throws —
 * a producer has no business writing server stamps); location.client is different: producers legitimately send it
 * (the MCP server sets it from the handshake) and the router then drops or keeps it, so it is allowed on input but
 * simply unsigned — like the rest of the reserved surface it remains server-writable, and the never-claim list says so.
 * Deliberately NOT signed: actor.model (the model stays asserted — never claim it), display_name/version.
 *
 * A signing producer MUST set `timestamp` (the server fills a missing one — the signature could never be re-verified)
 * and `idempotency_key`: Ed25519 is deterministic, so the key is what makes every signed event's bytes unique, which
 * is what lets offline verification flag a hostile store sealing one signed event twice (replay detection). And because verification recomputes the payload from the STORED event, a
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

/** The server's annotation surface — everything a seal may add that the signature therefore cannot cover. */
export const RESERVED_TAG_PREFIX = "caused_by:";
export const RESERVED_METHOD_PARAMS = ["sealed_by", "producer_sig_verdict", "relayed_by", "caused_by_problem"] as const;

type Signable = EventInput | Event;

function signableTags(tags: string[] | undefined): string[] | undefined {
  const t = tags?.filter((x) => !x.startsWith(RESERVED_TAG_PREFIX));
  return t && t.length ? t : undefined;
}
function signableMethod(m: EventInput["method"]): EventInput["method"] {
  if (!m) return undefined;
  const params = m.params ? Object.fromEntries(Object.entries(m.params).filter(([k]) => !(RESERVED_METHOD_PARAMS as readonly string[]).includes(k))) : undefined;
  const out: NonNullable<EventInput["method"]> = { ...m, ...(params && Object.keys(params).length ? { params } : {}) };
  if (params !== undefined && Object.keys(params).length === 0) delete (out as { params?: unknown }).params;
  return Object.keys(out).length ? out : undefined;
}
function signableLocation(l: EventInput["location"]): EventInput["location"] {
  if (!l) return undefined;
  const { client: _c, ...rest } = l;
  return Object.keys(rest).length ? rest : undefined;
}

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
  const tags = signableTags(e.tags); if (tags) p.tags = tags;
  const method = signableMethod(e.method); if (method) p.method = method;
  const location = signableLocation(e.location); if (location) p.location = location;
  return p;
}

/** Attach a signature to an input about to be submitted. Throws without `timestamp` or `idempotency_key`, and when
 *  the input carries server stamps (reserved tags / method params). `location.client` is fine to send — it is merely
 *  unsigned. See the module doc. */
export async function signProducer<T extends EventInput>(input: T, privateJwk: JsonWebKey): Promise<T & { producer_sig: ProducerSig }> {
  if (!input.timestamp) throw new Error("a signing producer must set timestamp itself; the server would fill it and the signature could never be re-verified");
  if (!input.idempotency_key) throw new Error("a signing producer must set idempotency_key: it makes the signed bytes unique, which is what lets offline verification catch a store sealing one signed event twice");
  if (input.tags?.some((t) => t.startsWith(RESERVED_TAG_PREFIX))) throw new Error(`tags starting "${RESERVED_TAG_PREFIX}" are the server's annotation surface; a producer must not set them`);
  const trespass = input.method?.params ? (RESERVED_METHOD_PARAMS as readonly string[]).filter((k) => input.method!.params![k] !== undefined) : [];
  if (trespass.length) throw new Error(`method.params ${trespass.join(", ")} are server stamps; a producer must not set them`);
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
  const seenSigs = new Map<string, number>();
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
    if (!(await verifyProducerSig(e, key.public_key))) {
      c.producer_invalid++; c.problems.push(`event #${e.seq}: producer signature does not verify — signed fields altered, or the wrong key`);
      continue;
    }
    // Replay detection: Ed25519 is deterministic and every signed event carries a unique idempotency_key, so one
    // signature can only legitimately seal once. A hostile store replaying a captured signed event at a second seq
    // (an honest appendEvent dedupes; the threat model is precisely a store that does not) is named here.
    const prior = seenSigs.get(e.producer_sig.sig);
    if (prior !== undefined) {
      c.producer_invalid++; c.problems.push(`event #${e.seq}: the same producer signature already sealed event #${prior} — a replayed seal, not a second act`);
      continue;
    }
    seenSigs.set(e.producer_sig.sig, e.seq);
    c.producer_signed++;
  }
  return c;
}
