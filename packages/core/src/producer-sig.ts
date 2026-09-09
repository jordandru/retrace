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
 * producer must sign `actor.{type, id, on_behalf_of}` exactly as the event records it. The signature identifies the
 * producer process/key, while the event actor may be a relayed or on-behalf-of principal resolved by the adapter.
 * The Worker verifies the signed, post-resolution event against the credential that presented the key.
 */
import { resolveCommitActor } from "./commit-actor.js";
import { Actor, Event, EventInput } from "./schema.js";
import { keyId, publicFromPrivate, signCanonical, verifyCanonical } from "./signing.js";

export const PRODUCER_SIG_FORMAT = "retrace-producer-sig/1";
export const PRODUCER_SIG_FORMAT_V2 = "retrace-producer-sig/2";
export type ProducerSigFormat = typeof PRODUCER_SIG_FORMAT | typeof PRODUCER_SIG_FORMAT_V2;
/** CLI that signs git commit seals as /2. Worker 426 / doctor min_cli_version name this string. */
export const PRODUCER_SIG_V2_MIN_CLI_VERSION = "0.1.8";
/** method.params key for the server's verdict — the `sealed_by` precedent: server wins, hash-covered. */
export const PRODUCER_SIG_VERDICT_PARAM = "producer_sig_verdict";
/** /2 server annotation: the actor the verifier actually checked, never a client-supplied echo. */
export const PRODUCER_SIGNED_ACTOR_PARAM = "producer_signed_actor";
/** Classifier observation (hash-covered, not producer-authenticated). Reserved on /2; not written in this step.
 *  Rule 3 will reconstruct the payload from `claim_decision.signed_actor: { type, id, on_behalf_of? }` — that
 *  field is not in §6's claim_decision block listing; the PR flags the documented shape rather than silently
 *  rewriting the design note. Distinct from `producer_signed_actor` (a derived method.params annotation). */
export const CLAIM_DECISION_PARAM = "claim_decision";

export type TrailerPolicy = "off" | "shadow" | "enforce";
/** RETRACE_TRAILER_POLICY. Unknown / unset → off (safe default; no 426, no classifier). */
export function parseTrailerPolicy(raw?: string | null): TrailerPolicy {
  if (raw === "shadow" || raw === "enforce") return raw;
  return "off";
}

export interface ProducerSig { kid: string; sig: string; format?: string }
export type ProducerSigVerdict = "verified" | "invalid" | "unknown_kid" | "none";
/** A registered producer public key — lives on the credential (server) and in export bundles (offline verify). */
export interface ProducerKey { kid: string; public_key: JsonWebKey; actor_id?: string; name?: string }
/** Actor {type, id, on_behalf_of} derived from verified bytes — never read from a stored annotation. */
export type ProducerSignedActor = Pick<Actor, "type" | "id"> & { on_behalf_of?: string };

/** The server's annotation surface — everything a seal may add that the signature therefore cannot cover. */
export const RESERVED_TAG_PREFIX = "caused_by:";
export const RESERVED_METHOD_PARAMS = ["sealed_by", "producer_sig_verdict", "relayed_by", "caused_by_problem"] as const;
/**
 * Complete /2 server-annotation surface: /1's four stamps plus `claim_decision` and
 * `producer_signed_actor`. `caused_by_problem` is still stamped by appendEvent (store.ts) and MUST stay
 * unsigned or every /2 event with a caused_by problem verifies invalid. §6 rule 1 omitted it — flagged
 * in the PR for design-text correction; this constant is the superset, not a silent rewrite of the note.
 * Adding a name later is retrace-producer-sig/3.
 */
export const RESERVED_METHOD_PARAMS_V2 = [
  ...RESERVED_METHOD_PARAMS,
  "claim_decision",
  "producer_signed_actor",
] as const;

// TODO(T32): §6 rule 3 withheld-verification substitution is not in this step. A hostile store that
// rewrites a /2 commit actor is verified against the stored actor and lands `invalid` until the
// classifier lands the strict reconstruct-with-signed_actor path
// (docs/design/commit-trailer-consistency.md §6 rule 3, T32).

type Signable = EventInput | Event;

export function reservedMethodParams(format: ProducerSigFormat): readonly string[] {
  return format === PRODUCER_SIG_FORMAT_V2 ? RESERVED_METHOD_PARAMS_V2 : RESERVED_METHOD_PARAMS;
}

/** Absent producer_sig.format means /1. Unknown format fails closed as invalid — never a /1 fallback. */
export function producerSigFormatOf(e: { producer_sig?: ProducerSig | null }): ProducerSigFormat | "unknown" | undefined {
  if (!e.producer_sig) return undefined;
  const f = e.producer_sig.format;
  if (f === undefined || f === PRODUCER_SIG_FORMAT) return PRODUCER_SIG_FORMAT;
  if (f === PRODUCER_SIG_FORMAT_V2) return PRODUCER_SIG_FORMAT_V2;
  return "unknown";
}

export function isGitCommitSeal(e: { action: string; method?: { tool?: string } }): boolean {
  return (e.action === "committed" || e.action === "merged") && e.method?.tool === "git";
}

/** /1-signed git commit seal (absent format = /1). Unsigned seals are not legacy-client. */
export function isLegacyClientCommitSeal(e: { action: string; method?: { tool?: string }; producer_sig?: ProducerSig | null }): boolean {
  if (!e.producer_sig || !isGitCommitSeal(e)) return false;
  const f = producerSigFormatOf(e);
  return f === PRODUCER_SIG_FORMAT;
}

function signableTags(tags: string[] | undefined): string[] | undefined {
  const t = tags?.filter((x) => !x.startsWith(RESERVED_TAG_PREFIX));
  return t && t.length ? t : undefined;
}
function signableMethod(m: EventInput["method"], format: ProducerSigFormat): EventInput["method"] {
  if (!m) return undefined;
  const reserved = reservedMethodParams(format);
  const params = m.params ? Object.fromEntries(Object.entries(m.params).filter(([k]) => !reserved.includes(k))) : undefined;
  const out: NonNullable<EventInput["method"]> = { ...m, ...(params && Object.keys(params).length ? { params } : {}) };
  if (params !== undefined && Object.keys(params).length === 0) delete (out as { params?: unknown }).params;
  return Object.keys(out).length ? out : undefined;
}
function signableLocation(l: EventInput["location"]): EventInput["location"] {
  if (!l) return undefined;
  const { client: _c, ...rest } = l;
  return Object.keys(rest).length ? rest : undefined;
}

/** The exact bytes-source both sides sign/verify: built the same way from a submitted input or a stored event.
 *  `format` selects the signed `v` field and the reserved method.params list. Omit it to dispatch from
 *  `producer_sig.format` (absent = /1). */
export function producerSignedPayload(e: Signable, format?: ProducerSigFormat): Record<string, unknown> {
  const fmt = format ?? (producerSigFormatOf(e) === PRODUCER_SIG_FORMAT_V2 ? PRODUCER_SIG_FORMAT_V2 : PRODUCER_SIG_FORMAT);
  const p: Record<string, unknown> = {
    v: fmt,
    project: e.project,
    actor: { type: e.actor.type, id: e.actor.id, ...(e.actor.on_behalf_of !== undefined ? { on_behalf_of: e.actor.on_behalf_of } : {}) },
    action: e.action,
  };
  for (const k of ["action_detail", "artifacts", "change", "timestamp", "duration_ms", "intent", "caused_by", "idempotency_key"] as const) {
    const v = e[k];
    if (v !== undefined) p[k] = v;
  }
  const tags = signableTags(e.tags); if (tags) p.tags = tags;
  const method = signableMethod(e.method, fmt); if (method) p.method = method;
  const location = signableLocation(e.location); if (location) p.location = location;
  return p;
}

function parseSignedAuthor(params: Record<string, unknown> | undefined): { name: string; email: string } | undefined {
  const a = params?.author;
  if (!a || typeof a !== "object" || Array.isArray(a)) return undefined;
  const name = (a as { name?: unknown }).name;
  const email = (a as { email?: unknown }).email;
  if (typeof name !== "string" || typeof email !== "string") return undefined;
  return { name, email };
}

/**
 * Actor the verifier actually checked, from verified bytes. /2 git commit seals re-derive from signed
 * `raw_message` + `author` (and parents). Missing those inputs → undefined (caller treats as invalid).
 * Stored `method.params.producer_signed_actor` is never read.
 */
export function deriveProducerSignedActor(e: Signable, format: ProducerSigFormat): ProducerSignedActor | undefined {
  if (format === PRODUCER_SIG_FORMAT_V2 && isGitCommitSeal(e)) {
    const params = (signableMethod(e.method, format)?.params ?? {}) as Record<string, unknown>;
    const author = parseSignedAuthor(params);
    const raw = params.raw_message;
    if (!author || typeof raw !== "string") return undefined;
    const parents = Array.isArray(params.parents) ? params.parents.filter((p): p is string => typeof p === "string") : [];
    const resolved = resolveCommitActor({ message: raw, authorName: author.name, authorEmail: author.email, parents });
    const signed: ProducerSignedActor = { type: resolved.actor.type, id: resolved.actor.id };
    let obo = resolved.actor.on_behalf_of;
    if (resolved.actor.type === "agent" && !obo && author.email) obo = author.email;
    if (obo) signed.on_behalf_of = obo;
    return signed;
  }
  return {
    type: e.actor.type,
    id: e.actor.id,
    ...(e.actor.on_behalf_of !== undefined ? { on_behalf_of: e.actor.on_behalf_of } : {}),
  };
}

export type ProducerVerifyResult = {
  ok: boolean;
  format?: ProducerSigFormat | "unknown";
  signed_actor?: ProducerSignedActor;
};

/** Does this event's signature verify with this public key? Pure; no registry. */
export async function verifyProducerSig(e: Signable, publicJwk: JsonWebKey): Promise<boolean> {
  return (await verifyProducerSigResult(e, publicJwk)).ok;
}

/**
 * Offline / Worker verification. Unknown `producer_sig.format` fails closed. A /2 git commit seal whose
 * signed params omit `author` or `raw_message` is `invalid` even if the Ed25519 bytes check (T39).
 * `signed_actor` is recomputed from verified bytes; a stored `producer_signed_actor` annotation is ignored.
 */
export async function verifyProducerSigResult(e: Signable, publicJwk: JsonWebKey): Promise<ProducerVerifyResult> {
  if (!e.producer_sig || !e.timestamp) return { ok: false };
  const format = producerSigFormatOf(e);
  if (format === "unknown") return { ok: false, format: "unknown" };
  const fmt = format ?? PRODUCER_SIG_FORMAT;
  const bytesOk = await verifyCanonical(publicJwk, producerSignedPayload(e, fmt), e.producer_sig.sig);
  if (!bytesOk) return { ok: false, format: fmt };
  const signed_actor = deriveProducerSignedActor(e, fmt);
  if (fmt === PRODUCER_SIG_FORMAT_V2 && isGitCommitSeal(e) && !signed_actor) return { ok: false, format: fmt };
  return { ok: true, format: fmt, signed_actor };
}

export type ProducerSigCheck = {
  verdict: ProducerSigVerdict;
  format?: ProducerSigFormat | "unknown";
  signed_actor?: ProducerSignedActor;
};

/**
 * The server-side rule, pure so the POST /events hunk stays three lines. Called AFTER actor resolution — the payload
 * is rebuilt from the resolved input, which is what gets sealed and what offline verify will see. A producer that
 * signed a different actor than the credential resolves to therefore lands `invalid`: signing as yourself and
 * submitting on someone else's credential is not a verified event.
 *   none         no signature presented
 *   unknown_kid  a signature, but no key registered on the credential, or a kid that is not that key's
 *   invalid      the signature does not verify over the resolved payload (or timestamp is missing, or format unknown)
 *   verified     everything checks
 */
export async function producerSigCheck(input: Signable, registered?: JsonWebKey | null): Promise<ProducerSigCheck> {
  if (!input.producer_sig) return { verdict: "none" };
  const format = producerSigFormatOf(input);
  if (format === "unknown") return { verdict: "invalid", format: "unknown" };
  if (!registered) return { verdict: "unknown_kid", format: format ?? PRODUCER_SIG_FORMAT };
  if (input.producer_sig.kid !== (await keyId(registered))) return { verdict: "unknown_kid", format: format ?? PRODUCER_SIG_FORMAT };
  if (!input.timestamp) return { verdict: "invalid", format: format ?? PRODUCER_SIG_FORMAT };
  const result = await verifyProducerSigResult(input, registered);
  if (!result.ok) return { verdict: "invalid", format: result.format ?? format ?? PRODUCER_SIG_FORMAT };
  return { verdict: "verified", format: result.format, signed_actor: result.signed_actor };
}

export async function producerSigVerdict(input: Signable, registered?: JsonWebKey | null): Promise<ProducerSigVerdict> {
  return (await producerSigCheck(input, registered)).verdict;
}

/** Attach a signature to an input about to be submitted. Throws without `timestamp` or `idempotency_key`, and when
 *  the input carries server stamps (reserved tags / method params). `location.client` is fine to send — it is merely
 *  unsigned. See the module doc. Default format is /1 so MCP and existing tests stay byte-compatible; the git hook
 *  opts into /2. */
export async function signProducer<T extends EventInput>(
  input: T,
  privateJwk: JsonWebKey,
  opts?: { format?: ProducerSigFormat },
): Promise<T & { producer_sig: ProducerSig }> {
  const format = opts?.format ?? PRODUCER_SIG_FORMAT;
  if (!input.timestamp) throw new Error("a signing producer must set timestamp itself; the server would fill it and the signature could never be re-verified");
  if (!input.idempotency_key) throw new Error("a signing producer must set idempotency_key: it makes the signed bytes unique, which is what lets offline verification catch a store sealing one signed event twice");
  if (input.tags?.some((t) => t.startsWith(RESERVED_TAG_PREFIX))) throw new Error(`tags starting "${RESERVED_TAG_PREFIX}" are the server's annotation surface; a producer must not set them`);
  const trespass = input.method?.params ? reservedMethodParams(format).filter((k) => input.method!.params![k] !== undefined) : [];
  if (trespass.length) throw new Error(`method.params ${trespass.join(", ")} are server stamps; a producer must not set them`);
  const pub = publicFromPrivate(privateJwk);
  const producer_sig: ProducerSig = { kid: await keyId(pub), sig: await signCanonical(privateJwk, producerSignedPayload(input, format)) };
  if (format !== PRODUCER_SIG_FORMAT) producer_sig.format = format;
  return { ...input, producer_sig };
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
 * Offline re-check for export verification: recompute each signed event's payload against the supplied producer keys.
 * The kid identifies the registered producer credential/key; `actor_id` is descriptive credential metadata, not an
 * event-actor binding, because adapters may legitimately record a relayed or on-behalf-of principal. An EMPTY key list means the
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
    if (!key) {
      c.producer_invalid++;
      c.problems.push(`event #${e.seq}: producer_sig kid ${e.producer_sig.kid.slice(0, 12)} is not a registered producer key`);
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
