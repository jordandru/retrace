/**
 * Signed provenance export ("Prove").
 * A bundle = the events in scope + full-project chain verdict at export time + issuer public key + Ed25519 signature
 * over the canonical bundle. Anyone can verify offline with verifyExportBundle() — no server needed.
 */
import { Event } from "./schema.js";
import { EventStore, verifyProject } from "./store.js";
import { verifyChain, VerifyResult, computeHash } from "./chain.js";
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
  issuer?: { kid: string; alg: "Ed25519"; public_key: JsonWebKey; name?: string };
  signature?: string; // base64url Ed25519 over canonical(bundle without signature)
}

export interface ExportOptions { signingKey?: JsonWebKey | null; issuerName?: string; now?: Date }

export async function buildExportBundle(store: EventStore, scope: ExportScope, opts: ExportOptions = {}): Promise<ExportBundle> {
  const all = await store.all(scope.project);
  const chain = await verifyChain(all);
  const events = scope.artifact_id || scope.actor_id || scope.since || scope.until
    ? await store.history({ project: scope.project, artifact_id: scope.artifact_id, actor_id: scope.actor_id, since: scope.since, until: scope.until, limit: 100000 })
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
  if (opts.signingKey) {
    const pub = publicFromPrivate(opts.signingKey);
    bundle.issuer = { kid: await keyId(pub), alg: "Ed25519", public_key: pub, name: opts.issuerName };
    bundle.signature = await signCanonical(opts.signingKey, { ...bundle, signature: undefined });
  }
  return bundle;
}

export interface ExportVerdict {
  signature: "valid" | "invalid" | "unsigned";
  events_intact: boolean;        // every event's own hash recomputes
  links_consistent: boolean;     // consecutive events in the bundle that are adjacent by seq link prev_hash→hash
  chain_ok_at_export: boolean;   // server's full-chain verdict at export time
  kid?: string;
  problems: string[];
}

/** Offline verification: signature + per-event content hashes + adjacency links. */
export async function verifyExportBundle(bundle: ExportBundle, trustedPublicKey?: JsonWebKey): Promise<ExportVerdict> {
  const problems: string[] = [];
  let signature: ExportVerdict["signature"] = "unsigned";
  if (bundle.signature && bundle.issuer) {
    const pub = trustedPublicKey ?? bundle.issuer.public_key;
    if (trustedPublicKey && (await keyId(trustedPublicKey)) !== bundle.issuer.kid) problems.push("issuer kid does not match trusted key");
    const ok = await verifyCanonical(pub, { ...bundle, signature: undefined }, bundle.signature);
    signature = ok ? "valid" : "invalid";
    if (!ok) problems.push("signature does not verify — bundle altered or wrong key");
  } else problems.push("bundle is unsigned");

  let events_intact = true;
  for (const e of bundle.events) {
    if ((await computeHash(e)) !== e.hash) { events_intact = false; problems.push(`event #${e.seq} content hash mismatch`); }
  }
  let links_consistent = true;
  const sorted = [...bundle.events].sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (b.seq === a.seq + 1 && b.prev_hash !== a.hash) { links_consistent = false; problems.push(`event #${b.seq} prev_hash does not link to #${a.seq}`); }
  }
  if (sorted[0]?.seq === 0 && sorted[0].prev_hash !== GENESIS_HASH) { links_consistent = false; problems.push("event #0 is not anchored to genesis"); }
  return { signature, events_intact, links_consistent, chain_ok_at_export: !!bundle.chain?.ok, kid: bundle.issuer?.kid, problems };
}

export { verifyProject };
