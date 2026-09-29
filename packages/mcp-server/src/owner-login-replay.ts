/** Offline consistency replay; observed timings and allocation outcomes are explicitly preserved. */
import { Event, EventInput, ExportBundle, MemoryEventStore, OwnerLoginConsumption, OwnerLoginRecord, GENESIS_HASH,
  classifyOwnerLogin, ownerLoginRecord, ownerLoginAllocationFailed, OWNER_LOGIN_DECISION_PARAM, verifyPolicySelectionOffline,
  policyDigestOf, verifyChain, githubWebhookProduced } from "@retrace-dev/core";
export interface OwnerLoginReplay {
  ok: boolean;
  results: Array<{ id: string; result: string; received_at: string; preserved: string[]; replay_unavailable?: string }>;
  consumption: OwnerLoginConsumption[];
}
function different(a: unknown, b: unknown, path = "record"): string | undefined {
  if (Object.is(a, b)) return undefined;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return path;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const diff = different((a as any)[key], (b as any)[key], `${path}.${key}`);
    if (diff) return diff;
  }
  return undefined;
}
export async function recomputeOwnerLogin(bundle: ExportBundle, policyOverride?: string): Promise<OwnerLoginReplay> {
  const events = [...bundle.events].sort((a, b) => a.seq - b.seq), store = new MemoryEventStore();
  store.events = events;
  const out: OwnerLoginReplay = { ok: true, results: [], consumption: [] };
  const mismatch = (e: Event, field: string, preserved: string[] = [], replay_unavailable?: string) => {
    out.ok = false; out.results.push({ id: e.id, result: `mismatch ${field}`, received_at: e.received_at, preserved,
      ...(replay_unavailable ? { replay_unavailable } : {}) });
  };
  const chain = await verifyChain(events);
  if (!chain.ok || bundle.scope.artifact_id || bundle.scope.actor_id || bundle.scope.since || bundle.scope.until || bundle.chain.total_events !== events.length) {
    out.ok = false; out.results.push({ id: "bundle", result: "mismatch incomplete or invalid chain", received_at: "", preserved: [] }); return out;
  }
  for (const doc of bundle.policies ?? []) if (await policyDigestOf(doc.body, doc.envelope) !== doc.digest) {
    out.ok = false; out.results.push({ id: "bundle", result: "mismatch policy digest", received_at: "", preserved: [] }); return out;
  }
  // Rebuild once in seq order; reads remain bounded by each sealed U, never the current table head.
  for (const e of events) {
    const record = ownerLoginRecord(e);
    if (!record || e.method?.params?.sealed_by !== "webhook:github") continue;
    for (const id of record.decision.consumed) {
      const key = `${e.project}\u0000${id}`;
      if (store.ownerLoginConsumption.has(key)) { mismatch(e, "consumption duplicate"); continue; }
      const row: OwnerLoginConsumption = { project: e.project, declaration_event_id: id,
        consumed_by_delivery: typeof record.payload.delivery === "string" ? record.payload.delivery : null,
        consumed_by_event_id: e.id, consumed_by_seq: e.seq, consumed_at: e.received_at };
      store.ownerLoginConsumption.set(key, row); out.consumption.push(row);
    }
  }
  for (const e of events) {
    if (!githubWebhookProduced(e)) continue;
    const sealed = ownerLoginRecord(e);
    const u = sealed?.decision.context.read_head_seq ?? e.seq - 1;
    const head = u < 0 ? { seq: -1, hash: GENESIS_HASH } : events.find(row => row.seq === u);
    if (!head || u >= e.seq) { mismatch(e, "context.read_head_seq"); continue; }
    const digest = policyOverride ?? sealed?.decision.context.policy_digest;
    const selected = verifyPolicySelectionOffline({ project: e.project, claimedDigest: digest, readHeadSeq: u,
      events, policies: bundle.policies ?? [], coverageComplete: true });
    if (!selected.ok) { mismatch(e, "policy selection"); continue; }
    const policy = selected.selected?.status === "selected" ? selected.selected.document : undefined;
    if (!policy) { if (sealed) mismatch(e, "policy missing"); continue; }
    const input: EventInput = { ...e, method: { ...e.method, params: { ...e.method?.params } } };
    delete input.method!.params![OWNER_LOGIN_DECISION_PARAM];
    const pr = e.artifacts.map(a => /^pr:(.+)#\d+$/.exec(a.id)?.[1]).find(Boolean);
    const result = await classifyOwnerLogin({ store, input, policy, canonicalR: pr ?? "", readHead: head, deadline: Date.now()+60_000 });
    if (result.kind === "not_applicable") { if (sealed) mismatch(e, "applicability"); continue; }
    let replay = ownerLoginRecord(result.input)!;
    const replay_unavailable = replay.decision.status === "unavailable" ? replay.decision.reason ?? "unknown" : undefined;
    if (!sealed) { mismatch(e, "missing decision", [], replay_unavailable); continue; }
    const preserved = ["classification_ms", "timing", "received.declaration", "received.webhook"];
    let allocation = false;
    if (sealed.decision.reason === "allocation_failed") {
      preserved.push("allocation");
      const a = sealed.decision.allocation, id = replay.decision.consumed[0];
      const winner = id && events.find(w => w.seq > u && w.seq < e.seq && w.project === e.project &&
        w.method?.params?.sealed_by === "webhook:github" && ownerLoginRecord(w)?.decision.consumed.includes(id) &&
        (a?.consumed_by === null || a?.consumed_by === w.id));
      if (!a || a.attempts !== 2 || a.read_head_seq !== u || replay.decision.status !== "declared_by_seat" || !winner) {
        mismatch(e, "allocation", preserved, replay_unavailable); continue;
      }
      replay = ownerLoginRecord(ownerLoginAllocationFailed(result.input, a.consumed_by))!;
      replay.decision.allocation = structuredClone(a); allocation = true;
    }
    // These are observations, not independent replay evidence.
    replay.decision.classification_ms = sealed.decision.classification_ms;
    // Older seals predate timing; preserve their absence as well as measured values.
    if (sealed.decision.timing) replay.decision.timing = structuredClone(sealed.decision.timing);
    else delete (replay.decision as Partial<OwnerLoginRecord["decision"]>).timing;
    replay.decision.received = structuredClone(sealed.decision.received);
    const diff = different(replay, sealed);
    if (diff) mismatch(e, diff, preserved, replay_unavailable);
    else if (different(replay.decision.actor_written, e.actor)) mismatch(e, "actor_written", preserved, replay_unavailable);
    else out.results.push({ id: e.id, result: allocation ? "match (allocation, by rule)" : "match", received_at: e.received_at, preserved,
      ...(replay_unavailable ? { replay_unavailable } : {}) });
  }
  return out;
}
