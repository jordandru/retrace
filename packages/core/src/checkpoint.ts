/**
 * Head checkpoints — the external witness a hash chain lacks.
 *
 * verifyExportBundle can prove a full export carries every event the issuer *claimed* at export time, but the claim
 * (chain.total_events, chain.head_hash) is the issuer's own. An operator with database access can drop the newest
 * events and re-export; every hash still verifies. A checkpoint records {seq, head_hash} at a moment in time somewhere
 * the operator cannot quietly rewrite — a file committed to git and pushed, a public share, a transparency log — so a
 * later bundle can be compared against it: the checkpointed event must still be there, at the same seq, with the same
 * hash. If it is not, the tail was removed or history was rewritten after the checkpoint.
 *
 * A checkpoint is derived from a verified full export (so it inherits the issuer's signature via bundle_sha256) or read
 * straight from a store, and is itself Ed25519-signed by whoever produced it. Its authority comes from where it is
 * kept and when, not from the signature alone.
 */
import { Event } from "./schema.js";
import { EventStore } from "./store.js";
import { canonicalize, sha256Hex } from "./chain.js";
import { ExportBundle, ExportScope } from "./export.js";
import { keyId, publicFromPrivate, signCanonical, verifyCanonical } from "./signing.js";

export const CHECKPOINT_FORMAT = "retrace-checkpoint/1";

export interface Checkpoint {
  format: typeof CHECKPOINT_FORMAT;
  project: string;
  /** seq of the head event at checkpoint time (total_events - 1) */
  seq: number;
  head_hash: string;
  total_events: number;
  /** when the head was observed (bundle.generated_at for export-derived checkpoints) */
  at: string;
  source:
    | { kind: "export"; issuer_kid?: string; bundle_sha256: string; bundle_generated_at: string }
    | { kind: "store" };
  signer?: { kid: string; alg: "Ed25519"; public_key: JsonWebKey; name?: string };
  signature?: string; // base64url Ed25519 over canonical(checkpoint without signature)
}

export interface CheckpointOptions { signingKey?: JsonWebKey | null; signerName?: string; now?: Date }

function isFullScope(scope: ExportScope | undefined): boolean {
  return !(scope?.artifact_id || scope?.actor_id || scope?.since || scope?.until);
}

async function sign(cp: Checkpoint, opts: CheckpointOptions): Promise<Checkpoint> {
  if (!opts.signingKey) return cp;
  const pub = publicFromPrivate(opts.signingKey);
  cp.signer = { kid: await keyId(pub), alg: "Ed25519", public_key: pub, name: opts.signerName };
  cp.signature = await signCanonical(opts.signingKey, { ...cp, signature: undefined });
  return cp;
}

/**
 * Derive a checkpoint from a FULL export bundle. The caller should have run verifyExportBundle first and only proceed
 * when exportVerdictOk(); this function refuses scoped bundles and bundles without a head, but does not re-verify.
 */
export async function checkpointFromBundle(bundle: ExportBundle, opts: CheckpointOptions = {}): Promise<Checkpoint> {
  if (!isFullScope(bundle.scope)) throw new Error("a checkpoint needs a full export (no artifact/actor/time scope)");
  const total = bundle.chain?.total_events;
  if (typeof total !== "number" || total < 1 || !bundle.chain.head_hash) throw new Error("bundle has no head to checkpoint (empty project or missing chain.head_hash)");
  const last = [...bundle.events].sort((a, b) => a.seq - b.seq).at(-1);
  if (!last || last.seq !== total - 1 || last.hash !== bundle.chain.head_hash) throw new Error("bundle's last event does not match its claimed head — verify the bundle first");
  const cp: Checkpoint = {
    format: CHECKPOINT_FORMAT,
    project: bundle.scope.project,
    seq: total - 1,
    head_hash: bundle.chain.head_hash,
    total_events: total,
    at: bundle.generated_at,
    source: { kind: "export", issuer_kid: bundle.issuer?.kid, bundle_sha256: await sha256Hex(canonicalize(bundle)), bundle_generated_at: bundle.generated_at },
  };
  return sign(cp, opts);
}

/** Checkpoint the current head of a project straight from a store (local mode, or a server checkpointing itself). */
export async function checkpointFromStore(store: EventStore, project: string, opts: CheckpointOptions = {}): Promise<Checkpoint> {
  const head = await store.head(project);
  if (!head) throw new Error(`project ${project} has no events to checkpoint`);
  const cp: Checkpoint = {
    format: CHECKPOINT_FORMAT, project, seq: head.seq, head_hash: head.hash, total_events: head.seq + 1,
    at: (opts.now ?? new Date()).toISOString(), source: { kind: "store" },
  };
  return sign(cp, opts);
}

export interface CheckpointVerdict { signature: "valid" | "self_attested" | "invalid" | "unsigned"; kid?: string; problems: string[] }

/** Check a checkpoint's own signature (and, if given, that it was signed by a trusted key). */
export async function verifyCheckpoint(cp: Checkpoint, trustedPublicKey?: JsonWebKey): Promise<CheckpointVerdict> {
  const problems: string[] = [];
  if (cp.format !== CHECKPOINT_FORMAT) problems.push(`unknown checkpoint format ${String(cp.format)}`);
  if (!cp.signature || !cp.signer) { problems.push("checkpoint is unsigned"); return { signature: "unsigned", problems }; }
  const pub = trustedPublicKey ?? cp.signer.public_key;
  if (trustedPublicKey && (await keyId(trustedPublicKey)) !== cp.signer.kid) problems.push("checkpoint signer kid does not match trusted key");
  const ok = await verifyCanonical(pub, { ...cp, signature: undefined }, cp.signature);
  if (!ok) { problems.push("checkpoint signature does not verify — altered or wrong key"); return { signature: "invalid", kid: cp.signer.kid, problems }; }
  if (!trustedPublicKey) problems.push(`checkpoint signature verifies against its own embedded key (kid ${cp.signer.kid}) — trust comes from where the checkpoint is committed, not from the signature`);
  return { signature: trustedPublicKey ? "valid" : "self_attested", kid: cp.signer.kid, problems };
}

export type CheckpointRelation =
  | "matches"        // bundle head is exactly the checkpointed head
  | "extends"        // bundle contains the checkpointed head and continues past it
  | "predates"       // SCOPED bundle generated before the checkpoint; cannot be compared (not a failure). A full bundle never predates: see below.
  | "unverifiable"   // scoped bundle without the checkpointed seq; only the size claim could be compared
  | "conflict"       // the checkpointed event is missing or different: tail removed or history rewritten
  | "other_project";

export interface CheckpointComparison { relation: CheckpointRelation; problems: string[]; note: string; checkpoint: { seq: number; head_hash: string; at: string } }

/**
 * Compare a bundle against a checkpoint taken earlier. For a full bundle generated after the checkpoint, the event at
 * checkpoint.seq must be present with checkpoint.head_hash — otherwise something after the checkpoint removed or
 * rewrote history, which no amount of hash verification on the bundle alone can show.
 */
export function compareBundleToCheckpoint(bundle: ExportBundle, cp: Checkpoint): CheckpointComparison {
  const ref = { seq: cp.seq, head_hash: cp.head_hash, at: cp.at };
  const problems: string[] = [];
  if (bundle.scope?.project !== cp.project) {
    problems.push(`checkpoint is for project ${cp.project}, bundle is for ${bundle.scope?.project}`);
    return { relation: "other_project", problems, note: "checkpoint and bundle are for different projects", checkpoint: ref };
  }
  const sorted = [...bundle.events].sort((a, b) => a.seq - b.seq);
  const atSeq: Event | undefined = sorted.find((e) => e.seq === cp.seq);
  const full = isFullScope(bundle.scope);
  const total = bundle.chain?.total_events ?? -1;
  const bundleOlder = bundle.generated_at < cp.at;

  if (atSeq) {
    if (atSeq.hash !== cp.head_hash) {
      problems.push(`event #${cp.seq} hash ${atSeq.hash.slice(0, 12)}… differs from the checkpoint taken ${cp.at} (${cp.head_hash.slice(0, 12)}…) — history was rewritten after the checkpoint`);
      return { relation: "conflict", problems, note: "checkpointed head has a different hash in this bundle", checkpoint: ref };
    }
    const isHead = sorted.at(-1)?.seq === cp.seq && total === cp.total_events;
    return {
      relation: isHead ? "matches" : "extends", problems,
      note: isHead ? `bundle head is the checkpointed head #${cp.seq}` : `bundle contains the checkpointed head #${cp.seq} unchanged and continues to #${sorted.at(-1)?.seq}`,
      checkpoint: ref,
    };
  }
  // `generated_at` is written by the issuer, so it cannot excuse a full bundle from carrying the checkpointed event:
  // truncate the tail, re-export with a backdated timestamp, and "predates" would pass. A full bundle that lacks the
  // checkpointed seq is a conflict whatever it says about its age; only scoped bundles get the benefit of the doubt.
  if (bundleOlder && !full) {
    return { relation: "predates", problems, note: `scoped bundle was generated ${bundle.generated_at}, before the checkpoint at ${cp.at}; it cannot be checked against it`, checkpoint: ref };
  }
  if (bundleOlder && full) problems.push(`bundle claims generated_at ${bundle.generated_at}, before the checkpoint at ${cp.at}; that timestamp is the issuer's own and does not excuse a full export from containing #${cp.seq}`);
  if (full) {
    problems.push(
      total <= cp.seq
        ? `bundle claims ${total} events but a checkpoint taken ${cp.at} recorded ${cp.total_events} — ${cp.total_events - Math.max(total, 0)} event${cp.total_events - Math.max(total, 0) === 1 ? "" : "s"} removed after the checkpoint`
        : `bundle claims ${total} events yet does not contain checkpointed event #${cp.seq}`,
    );
    return { relation: "conflict", problems, note: "checkpointed head is missing from a full bundle generated after the checkpoint", checkpoint: ref };
  }
  if (total <= cp.seq) {
    problems.push(`scoped bundle claims a project size of ${total} but a checkpoint taken ${cp.at} recorded ${cp.total_events} events`);
    return { relation: "conflict", problems, note: "project size claim contradicts the checkpoint", checkpoint: ref };
  }
  return { relation: "unverifiable", problems, note: `scoped bundle does not include event #${cp.seq}; only the project size claim (${total} ≥ ${cp.total_events}) could be compared`, checkpoint: ref };
}

/** Parse a JSON-lines checkpoint file (one checkpoint per line; later lines are newer). */
export function parseCheckpointLog(text: string): Checkpoint[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as Checkpoint);
}

/** The newest checkpoint for a project in a log: highest seq, then latest `at`. */
export function latestCheckpoint(cps: Checkpoint[], project: string): Checkpoint | undefined {
  return cps.filter((c) => c.project === project).sort((a, b) => a.seq - b.seq || a.at.localeCompare(b.at)).at(-1);
}
