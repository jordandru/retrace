/**
 * Signed provenance export ("Prove").
 * A bundle = the events in scope + full-project chain verdict at export time + issuer public key + Ed25519 signature
 * over the canonical bundle. Anyone can verify offline with verifyExportBundle() — no server needed.
 */
import { Event } from "./schema.js";
import { EventStore, collectHistory, verifyProject } from "./store.js";
import { verifyChain, VerifyResult, computeHash, hashRule } from "./chain.js";
import { ProducerKey, countProducerSigs } from "./producer-sig.js";
import { GENESIS_HASH } from "./schema.js";
import { keyId, publicFromPrivate, signCanonical, verifyCanonical } from "./signing.js";

export const EXPORT_FORMAT = "retrace-export/1";

export interface ExportScope { project: string; artifact_id?: string; actor_id?: string; since?: string; until?: string }

export interface ExportBundle {
  format: typeof EXPORT_FORMAT;
  generated_at: string;
  scope: ExportScope;
  /** Chain verdict for the WHOLE project at export time (scoped subsets can't be chain-verified alone). */
  chain: VerifyResult & { head_hash?: string; total_events: number };
  events: Event[];
  /** number of events included only as causal context (ancestors of in-scope events) */
  context_events?: number;
  /** Registered producer public keys (rung 5) — the public halves of credential keys, so offline verification can
   *  re-check producer signatures. Set BEFORE signing, so a swapped list invalidates the bundle signature. Bundle-
   *  carried keys are self-attested like the issuer key; the trusted path is a --producers file you hold. */
  producers?: ProducerKey[];
  issuer?: { kid: string; alg: "Ed25519"; public_key: JsonWebKey; name?: string };
  signature?: string; // base64url Ed25519 over canonical(bundle without signature)
}

export interface ExportOptions { signingKey?: JsonWebKey | null; issuerName?: string; now?: Date; producers?: ProducerKey[] }

export async function buildExportBundle(store: EventStore, scope: ExportScope, opts: ExportOptions = {}): Promise<ExportBundle> {
  const all = await store.all(scope.project);
  const chain = await verifyChain(all);
  const events = scope.artifact_id || scope.actor_id || scope.since || scope.until
    ? await collectHistory(store, { project: scope.project, artifact_id: scope.artifact_id, actor_id: scope.actor_id, since: scope.since, until: scope.until })
    : all;
  // Scoped exports pull in causal ancestors (the instructions/actions that led to in-scope events) so WHY is answerable offline.
  let context_events = 0;
  if (events.length !== all.length) {
    const have = new Set(events.map((e) => e.id));
    const byId = new Map(all.map((e) => [e.id, e]));
    const queue = events.map((e) => e.caused_by).filter((x): x is string => !!x);
    while (queue.length) {
      const id = queue.shift()!;
      if (have.has(id)) continue;
      const anc = byId.get(id) ?? (await store.get(id));
      if (!anc) continue;
      have.add(id); events.push(anc); context_events++;
      if (anc.caused_by) queue.push(anc.caused_by);
    }
    events.sort((a, b) => a.seq - b.seq);
  }
  const bundle: ExportBundle = {
    format: EXPORT_FORMAT,
    generated_at: (opts.now ?? new Date()).toISOString(),
    scope,
    chain: { ...chain, head_hash: all.at(-1)?.hash, total_events: all.length },
    events,
    context_events,
  };
  if (opts.producers?.length) bundle.producers = opts.producers;
  if (opts.signingKey) {
    const pub = publicFromPrivate(opts.signingKey);
    bundle.issuer = { kid: await keyId(pub), alg: "Ed25519", public_key: pub, name: opts.issuerName };
    bundle.signature = await signCanonical(opts.signingKey, { ...bundle, signature: undefined });
  }
  return bundle;
}

/**
 * What the bundle covers, and whether omission can be ruled out offline.
 * A hash chain only proves the events that are present were not altered; it says nothing about events that were left out.
 * For a FULL export (no scope filters) the bundle must carry every event the issuer claims the project had at export time —
 * contiguous seq from 0, exactly total_events of them, ending at head_hash — so a truncated tail or a dropped middle event
 * is reported as a problem, not silently accepted. A SCOPED export cannot be checked for omission offline; `complete` is
 * left undefined and the note says what would settle it (a full export or a head checkpoint).
 */
export interface ExportCoverage {
  scope: "full" | "scoped";
  events: number;            // events in the bundle, including causal context
  total_events: number;      // project size the issuer claimed at export time
  complete?: boolean;        // full scope only: every claimed event is present, contiguous, and ends at head_hash
  head_hash_matches?: boolean;
  missing_seqs?: number[];   // full scope only; capped at 50 entries
  note: string;
}

export interface ExportVerdict {
  /** "valid" only against a trusted key; "self_attested" = verifies against the key the bundle carries (proves nothing about who issued it) */
  signature: "valid" | "self_attested" | "invalid" | "unsigned";
  events_intact: boolean;        // every event's own hash recomputes
  links_consistent: boolean;     // consecutive events in the bundle that are adjacent by seq link prev_hash→hash
  chain_ok_at_export: boolean;   // server's full-chain verdict at export time
  coverage: ExportCoverage;      // omission check (see ExportCoverage)
  /** events sealed under the legacy hash rule (no hash_v): their received_at is not provably covered */
  legacy_hash_events: number;
  /** producer-signature re-check (rung 5), mirroring legacy_hash_events: signed-and-verified, wrong/replayed, and
   *  agent events with no signature at all (pre-rollout producers) */
  producer_signed: number;
  producer_invalid: number;
  producer_unsigned_agent_events: number;
  kid?: string;
  problems: string[];
}

const MISSING_SEQ_CAP = 50;

/** Omission check over a bundle whose events are sorted by seq. Pushes problems; returns the coverage record. */
function checkCoverage(bundle: ExportBundle, sorted: Event[], problems: string[]): ExportCoverage {
  const s = bundle.scope ?? ({} as ExportScope);
  const scoped = !!(s.artifact_id || s.actor_id || s.since || s.until);
  const total = bundle.chain?.total_events;
  const n = sorted.length;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) {
    problems.push("bundle does not state chain.total_events — omission cannot be checked");
    return { scope: scoped ? "scoped" : "full", events: n, total_events: -1, complete: scoped ? undefined : false, note: "issuer did not declare the project size at export time" };
  }
  // Checks that hold for every bundle: no seq outside the claimed range, no duplicate seq.
  const seen = new Set<number>();
  for (const e of sorted) {
    if (e.seq < 0 || e.seq >= total) problems.push(`event #${e.seq} lies outside the ${total} events claimed at export`);
    if (seen.has(e.seq)) problems.push(`event #${e.seq} appears more than once`);
    seen.add(e.seq);
  }
  if (scoped) {
    return {
      scope: "scoped", events: n, total_events: total,
      note: `scoped bundle: ${n} of ${total} project events (${bundle.context_events ?? 0} causal context); omission within the scope cannot be verified offline — compare against a full export or a published head checkpoint`,
    };
  }
  // Full export: every claimed event must be present, contiguous from 0, and end at the claimed head.
  const missing: number[] = [];
  for (let i = 0; i < total; i++) if (!seen.has(i)) { if (missing.length < MISSING_SEQ_CAP) missing.push(i); }
  const missingCount = total - seen.size + [...seen].filter((x) => x < 0 || x >= total).length;
  let complete = true;
  if (n !== total || missingCount > 0) {
    complete = false;
    const tail = missing.length && missing[0] === n && missing.at(-1) === total - 1 && missingCount === total - n;
    problems.push(
      tail
        ? `bundle ends at #${n - 1} but ${total} events were claimed at export — the tail (${missingCount} event${missingCount === 1 ? "" : "s"}) is missing`
        : `bundle holds ${n} of ${total} claimed events — missing seq ${missing.slice(0, 10).join(", ")}${missingCount > 10 ? ` … (${missingCount} total)` : ""}`,
    );
  }
  const last = sorted.at(-1);
  let head_hash_matches: boolean | undefined;
  if (!bundle.chain.head_hash) {
    if (total > 0) { complete = false; problems.push("bundle does not state chain.head_hash — the export cannot be anchored to a chain head"); }
  } else if (last) {
    head_hash_matches = last.hash === bundle.chain.head_hash;
    if (!head_hash_matches && complete) { complete = false; problems.push(`last event #${last.seq} hash does not match the head_hash claimed at export — tail truncated or altered`); }
    else if (!head_hash_matches) problems.push("last event hash does not match the claimed head_hash");
  } else if (total > 0) { complete = false; head_hash_matches = false; }
  return {
    scope: "full", events: n, total_events: total, complete, head_hash_matches, missing_seqs: missing.length ? missing : undefined,
    note: complete
      ? `full export: all ${total} events present, contiguous from #0, ending at the claimed head — no omission since export time (the head itself is the issuer's claim; pin it with a checkpoint)`
      : `full export is incomplete: ${n} of ${total} claimed events`,
  };
}

/** Offline verification: signature + per-event content hashes + adjacency links + omission (coverage). */
export async function verifyExportBundle(bundle: ExportBundle, trustedPublicKey?: JsonWebKey, vopts?: { producers?: ProducerKey[] }): Promise<ExportVerdict> {
  const problems: string[] = [];
  let signature: ExportVerdict["signature"] = "unsigned";
  if (bundle.signature && bundle.issuer) {
    const pub = trustedPublicKey ?? bundle.issuer.public_key;
    if (trustedPublicKey && (await keyId(trustedPublicKey)) !== bundle.issuer.kid) problems.push("issuer kid does not match trusted key");
    const ok = await verifyCanonical(pub, { ...bundle, signature: undefined }, bundle.signature);
    if (!ok) { signature = "invalid"; problems.push("signature does not verify — bundle altered or wrong key"); }
    else if (trustedPublicKey) signature = "valid";
    else {
      // The bundle carries its own public key, so a verifier that trusts it only learns that the bundle is internally
      // consistent — anyone can re-sign an altered bundle with a fresh key. That is not "valid"; it is self-attested.
      signature = "self_attested";
      problems.push(`signature verifies against the key embedded in the bundle (kid ${bundle.issuer.kid}) — not against a trusted key; confirm the kid with the issuer's /.well-known/retrace-pubkey or pass the issuer's public key`);
    }
  } else problems.push("bundle is unsigned");

  let events_intact = true;
  let legacy_hash_events = 0;
  for (const e of bundle.events) {
    if (hashRule(e) === "legacy") legacy_hash_events++;
    if ((await computeHash(e)) !== e.hash) { events_intact = false; problems.push(`event #${e.seq} content hash mismatch`); }
  }
  let links_consistent = true;
  const sorted = [...bundle.events].sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (b.seq === a.seq + 1 && b.prev_hash !== a.hash) { links_consistent = false; problems.push(`event #${b.seq} prev_hash does not link to #${a.seq}`); }
  }
  if (sorted[0]?.seq === 0 && sorted[0].prev_hash !== GENESIS_HASH) { links_consistent = false; problems.push("event #0 is not anchored to genesis"); }
  const coverage = checkCoverage(bundle, sorted, problems);
  // Producer signatures (rung 5): a supplied trusted list REPLACES the bundle's own (which is self-attested, like the
  // issuer key); with neither, signed events are uncheckable and only the unsigned-agent count is meaningful.
  const producerKeys = vopts?.producers ?? bundle.producers ?? [];
  const ps = await countProducerSigs(sorted, producerKeys);
  problems.push(...ps.problems);
  return { signature, events_intact, links_consistent, chain_ok_at_export: !!bundle.chain?.ok, coverage, legacy_hash_events, producer_signed: ps.producer_signed, producer_invalid: ps.producer_invalid, producer_unsigned_agent_events: ps.producer_unsigned_agent_events, kid: bundle.issuer?.kid, problems };
}

/**
 * One boolean for callers that gate on a bundle: signed by a TRUSTED key, intact, linked, chain ok at export, and (for
 * full exports) complete. A self-attested signature does not pass — pass the issuer's public key to verifyExportBundle.
 */
export function exportVerdictOk(v: ExportVerdict): boolean {
  return v.signature === "valid" && v.events_intact && v.links_consistent && v.chain_ok_at_export && v.coverage.complete !== false;
}

export { verifyProject };
