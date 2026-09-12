/**
 * Phase A / step 5 measuring instrument.
 *
 * Reads a retrace-export bundle (never the live API in a loop) and prints every
 * table in docs/design/step5-phase-a-measurement-brief.md §1 except the by-hand
 * conflicting review. Every number is labelled census, proxy, bench, missing,
 * or per-machine. A proxy must never be published as a measurement.
 *
 *   node scripts/phase-a-measure.mjs <bundle.json> [--since ISO] [--until ISO]
 *     [--hook-log path] [--pending-seal path] [--json] [--no-handshake]
 */
import { readFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  canonicalize,
  isGitCommitSeal,
  isLegacyClientCommitSeal,
  parseExportBundle,
  producerSignedPayload,
  producerSigFormatOf,
  sealedByKind,
  PRODUCER_SIG_FORMAT,
  PRODUCER_SIG_FORMAT_V2,
  type Event,
  type ExportBundle,
} from "@retrace-dev/core";
import { AUDIT_MCP_TOOL_NAMES } from "./audit-mcp.js";

export const CLASSIFIER_STATUSES = [
  "supported",
  "conflicting",
  "unresolved",
  "human_claim_with_agent_evidence",
  "no_agent_evidence",
  "merge_unclassified",
] as const;

export type Kind = "census" | "proxy" | "bench" | "missing" | "per-machine";

export type Labeled<T> = { value: T; kind: Kind; note?: string };

/** Seal receipt times, not Git author dates: shadow measures newly received seals. */
export type MeasureWindow = { since?: string; until?: string };

export type HandshakeTool = { name: string; bytes: number; description_bytes: number; schema_bytes: number };

export type HandshakeMeasure = {
  kind: "census";
  tool_count: number;
  total_bytes: number;
  tools: HandshakeTool[];
  worker_audit_subset_bytes: number;
  worker_audit_tool_count: number;
  note: string;
};

export type ClaimDecisionView = {
  status?: string;
  reason?: string;
  classification_ms?: number;
  actor_written?: string;
  would_write?: { actor_written?: string };
  shadow?: boolean;
};

export type IntervalRow = {
  commit_id: string;
  commit_seq: number;
  sha?: string;
  timestamp: string;
  actor: string;
  agent_events: number;
  by_actor: Record<string, number>;
};

export type MeasureReport = {
  generated_at: string;
  bundle: {
    project?: string;
    generated_at?: string;
    events: number;
    head_seq: number | null;
    format?: string;
  };
  window: MeasureWindow;
  histogram: {
    kind: Kind;
    note: string;
    by_status: Record<string, number>;
    by_reason: Record<string, number>;
    seals: number;
    with_claim_decision: number;
    absent_claim_decision: number;
  };
  hook_producer_sig: {
    kind: Kind;
    unsigned: number;
    v1_legacy_client: number;
    v2: number;
    other: number;
  };
  legacy_client: { kind: Kind; count: number; note: string };
  logs_per_commit: {
    kind: Kind;
    note: string;
    intervals: number;
    unique_shas: number;
    first_commit_dropped: true;
    p50: number | null;
    p95: number | null;
    mean: number | null;
    max: number | null;
    zero_share: number | null;
    by_actor: Record<string, number>;
  };
  tokens: {
    method_tokens: { kind: Kind; present: number; p50: number | null; p95: number | null; note: string };
    stored_canonical_bytes: { kind: Kind; n: number; p50: number | null; p95: number | null; mean: number | null; note: string };
    producer_signed_bytes: { kind: Kind; n: number; p50: number | null; p95: number | null; note: string };
  };
  handshake?: HandshakeMeasure;
  hook_wall_clock: {
    kind: Kind;
    present: number;
    seals: number;
    p50: number | null;
    p95: number | null;
    note: string;
  };
  classification_ms: {
    kind: Kind;
    present: number;
    seals_with_decision: number;
    p50: number | null;
    p95: number | null;
    over_500ms: number;
    note: string;
  };
  pending_seals: {
    kind: Kind;
    queued_shas: string[];
    hook_log_failures: number | null;
    note: string;
  };
  recorded_commit_actors: {
    kind: Kind;
    note: string;
    by_type: Record<string, number>;
    by_actor: Record<string, number>;
  };
};

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

export function inWindow(timestamp: string, window: MeasureWindow): boolean {
  if (!window.since && !window.until) return true;
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t)) return false;
  if (window.since) {
    const s = Date.parse(window.since);
    if (Number.isFinite(s) && t < s) return false;
  }
  if (window.until) {
    const u = Date.parse(window.until);
    if (Number.isFinite(u) && t > u) return false;
  }
  return true;
}

function validateWindow(window: MeasureWindow): void {
  for (const [name, value] of Object.entries(window)) {
    if (value !== undefined && !Number.isFinite(Date.parse(value))) {
      throw new Error(`--${name} must be a valid date/time, got ${JSON.stringify(value)}`);
    }
  }
  if (window.since && window.until && Date.parse(window.since) > Date.parse(window.until)) {
    throw new Error("--since must not be later than --until");
  }
}

export function claimDecisionOf(event: Event): ClaimDecisionView | undefined {
  // Design §6 rule 5: a /1-signed event stores a caller-supplied claim_decision byte-for-byte.
  // That block is never a server decision and must not enter the histogram.
  if (isLegacyClientCommitSeal(event)) return undefined;
  const params = event.method?.params as Record<string, unknown> | undefined;
  const raw = params?.claim_decision;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const decision = rec.decision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return undefined;
  const d = decision as Record<string, unknown>;
  if (typeof d.status !== "string") return undefined;
  const would = d.would_write && typeof d.would_write === "object" && !Array.isArray(d.would_write)
    ? d.would_write as Record<string, unknown>
    : undefined;
  return {
    status: d.status,
    reason: typeof d.reason === "string" ? d.reason : undefined,
    classification_ms: typeof d.classification_ms === "number" ? d.classification_ms : undefined,
    actor_written: typeof d.actor_written === "string" ? d.actor_written : undefined,
    would_write: would && typeof would.actor_written === "string" ? { actor_written: would.actor_written } : undefined,
    shadow: d.shadow === true,
  };
}

export function commitShaOf(event: Event): string | undefined {
  const fromParams = event.method?.params && typeof event.method.params.sha === "string" ? event.method.params.sha : undefined;
  if (fromParams) return fromParams;
  const commit = event.artifacts?.find((a) => a.kind === "commit" || a.id.startsWith("commit:"));
  return commit?.id;
}

/** Grouping key for one git COMMIT (hook+webhook seals of the same sha). Prefers method.params.sha. */
export function commitShaKey(event: Event): string {
  const raw = event.method?.params && typeof event.method.params.sha === "string" ? event.method.params.sha : undefined;
  if (raw && /^[0-9a-f]{7,40}$/i.test(raw)) return raw.toLowerCase();
  const commit = event.artifacts?.find((a) => a.kind === "commit" || a.id.startsWith("commit:"));
  const m = commit?.id.match(/@([0-9a-f]{7,40})$/i);
  if (m) return m[1].toLowerCase();
  return `event:${event.id}`;
}

/** assert: hook stamps and webhook:github are trusted producers; pinned client commit claims are not. */
export function isTrustedCommitSeal(event: Event): boolean {
  const kind = sealedByKind(event.method?.params?.sealed_by);
  return kind === "assert" || kind === "webhook";
}

function canonicalSha(sha: string, all: string[]): string {
  if (sha.startsWith("event:")) return sha;
  let best = sha;
  for (const other of all) {
    if (other.startsWith("event:")) continue;
    if ((other.startsWith(sha) || sha.startsWith(other)) && other.length > best.length) best = other;
  }
  return best;
}

function earliestBoundSeal(seals: Event[]): Event {
  const trusted = seals.filter(isTrustedCommitSeal).sort((a, b) => a.seq - b.seq);
  return trusted[0] ?? [...seals].sort((a, b) => a.seq - b.seq)[0];
}

function bump(map: Record<string, number>, key: string, n = 1): void {
  map[key] = (map[key] ?? 0) + n;
}

function stats(values: number[]): { p50: number | null; p95: number | null; mean: number | null; max: number | null } {
  if (!values.length) return { p50: null, p95: null, mean: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), mean, max: sorted[sorted.length - 1] };
}

export function measureEvents(events: Event[], window: MeasureWindow = {}): Omit<MeasureReport, "generated_at" | "bundle" | "window" | "handshake" | "pending_seals"> {
  validateWindow(window);
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const seals = ordered.filter(isGitCommitSeal);
  const scopedSeals = seals.filter((e) => inWindow(e.received_at, window));

  const by_status: Record<string, number> = { absent: 0 };
  for (const s of CLASSIFIER_STATUSES) by_status[s] = 0;
  const by_reason: Record<string, number> = {};
  let withDecision = 0;
  const classMs: number[] = [];
  const durationMs: number[] = [];
  let durationPresent = 0;
  const hookSig = { unsigned: 0, v1_legacy_client: 0, v2: 0, other: 0 };
  const recordedByType: Record<string, number> = {};
  const recordedByActor: Record<string, number> = {};

  for (const seal of scopedSeals) {
    bump(recordedByType, seal.actor.type);
    bump(recordedByActor, `${seal.actor.type}:${seal.actor.id}`);
    const cd = claimDecisionOf(seal);
    if (!cd?.status) {
      by_status.absent++;
    } else {
      withDecision++;
      bump(by_status, cd.status);
      if (cd.reason) bump(by_reason, cd.reason);
      if (typeof cd.classification_ms === "number") classMs.push(cd.classification_ms);
    }
    if (typeof seal.duration_ms === "number") {
      durationPresent++;
      durationMs.push(seal.duration_ms);
    }
    if (!seal.producer_sig) hookSig.unsigned++;
    else if (isLegacyClientCommitSeal(seal)) hookSig.v1_legacy_client++;
    else if (producerSigFormatOf(seal) === PRODUCER_SIG_FORMAT_V2) hookSig.v2++;
    else hookSig.other++;
  }

  const legacy = scopedSeals.filter(isLegacyClientCommitSeal).length;

  const intervals: IntervalRow[] = [];
  const byActorTotals: Record<string, number> = {};
  const counts: number[] = [];
  const proxyBytes: number[] = [];
  const signedBytes: number[] = [];
  const methodTokens: number[] = [];

  const rawKeys = seals.map(commitShaKey);
  const groups = new Map<string, Event[]>();
  for (const s of seals) {
    const key = canonicalSha(commitShaKey(s), rawKeys);
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  const commits = [...groups.entries()].map(([sha, list]) => ({
    sha,
    seals: [...list].sort((a, b) => a.seq - b.seq),
    bound: earliestBoundSeal(list),
  })).sort((a, b) => a.bound.seq - b.bound.seq || a.seals[0].seq - b.seals[0].seq);

  // One interval per unique SHA. The first commit has no previous commit — drop it
  // rather than invent a pair bounded by ledger start (lo = -1). Previous-commit
  // bound may sit outside the window (kept).
  for (let i = 1; i < commits.length; i++) {
    const curr = commits[i];
    if (!curr.seals.some((s) => inWindow(s.received_at, window))) continue;
    const prev = commits[i - 1];
    const lo = prev.bound.seq;
    const hi = curr.bound.seq;
    const between = ordered.filter((e) => e.seq > lo && e.seq < hi && e.actor.type === "agent" && !isGitCommitSeal(e));
    const by_actor: Record<string, number> = {};
    for (const e of between) {
      bump(by_actor, e.actor.id);
      bump(byActorTotals, e.actor.id);
      proxyBytes.push(utf8Bytes(canonicalize(e)));
      try {
        signedBytes.push(utf8Bytes(canonicalize(producerSignedPayload(e))));
      } catch {
        // Unsigned or unverifiable producer payload: skip the tighter proxy.
      }
      if (typeof e.method?.tokens === "number") methodTokens.push(e.method.tokens);
    }
    const end = curr.bound;
    intervals.push({
      commit_id: end.id,
      commit_seq: end.seq,
      sha: curr.sha.startsWith("event:") ? commitShaOf(end) : curr.sha,
      timestamp: end.timestamp,
      actor: `${end.actor.type}:${end.actor.id}`,
      agent_events: between.length,
      by_actor,
    });
    counts.push(between.length);
  }
  const countStats = stats(counts);
  const byteStats = stats(proxyBytes);
  const signedStats = stats(signedBytes);
  const tokenStats = stats(methodTokens);

  const histogramNote = withDecision === 0
    ? "census of recorded claim_decision.decision.status: none present. /1-signed seals are always absent (§6 rule 5: a client-supplied claim_decision is not a server decision). Pre-shadow unsigned//2 seals have no classifier output."
    : "census of claim_decision.decision.status on unsigned and /2 git commit seals in scope. /1-signed seals are always absent (§6 rule 5). Top-level claim_decision.status without .decision is ignored.";

  return {
    histogram: {
      kind: "census",
      note: histogramNote,
      by_status,
      by_reason,
      seals: scopedSeals.length,
      with_claim_decision: withDecision,
      absent_claim_decision: scopedSeals.length - withDecision,
    },
    hook_producer_sig: { kind: "census", ...hookSig },
    legacy_client: {
      kind: "census",
      count: legacy,
      note: "/1-signed git commit seals (absent format = /1). Unsigned seals are not legacy_client. Must be zero for NEW seals before step 6.",
    },
    logs_per_commit: {
      kind: "census",
      note: "agent events strictly between consecutive COMMITS (unique full sha), by actor.id. Dual-producer hook+webhook seals of one sha are one commit. Each interval is bounded by the earliest trusted seal of the previous commit (assert: or webhook:github; else earliest git seal). The first commit in the chain is dropped — it has no previous commit. Includes NOOA audits and every other agent; do not filter them out — the by_actor split is the measurement.",
      intervals: intervals.length,
      unique_shas: commits.length,
      first_commit_dropped: true,
      p50: countStats.p50,
      p95: countStats.p95,
      mean: countStats.mean,
      max: countStats.max,
      zero_share: counts.length ? counts.filter((n) => n === 0).length / counts.length : null,
      by_actor: byActorTotals,
    },
    tokens: {
      method_tokens: {
        kind: methodTokens.length ? "census" : "missing",
        present: methodTokens.length,
        p50: tokenStats.p50,
        p95: tokenStats.p95,
        note: methodTokens.length
          ? "census of method.tokens on agent events between seals. This is the stored field, not an MCP-boundary counter."
          : "method.tokens is absent on these agent events. No MCP-boundary byte counter exists; do not invent a token count.",
      },
      stored_canonical_bytes: {
        kind: "proxy",
        n: proxyBytes.length,
        p50: byteStats.p50,
        p95: byteStats.p95,
        mean: byteStats.mean,
        note: "PROXY: UTF-8 bytes of canonicalize(stored event). That is the sealed record, minus transport framing, not the MCP tool-call bytes. Labelled proxy on purpose.",
      },
      producer_signed_bytes: {
        kind: "proxy",
        n: signedBytes.length,
        p50: signedStats.p50,
        p95: signedStats.p95,
        note: "PROXY: UTF-8 bytes of the producer-signed payload (closer to what the client attested). Still not MCP framing or tool-schema bytes.",
      },
    },
    hook_wall_clock: {
      kind: durationPresent ? "census" : "missing",
      present: durationPresent,
      seals: scopedSeals.length,
      p50: stats(durationMs).p50,
      p95: stats(durationMs).p95,
      note: durationPresent
        ? "census of duration_ms on git commit seals. Because duration_ms is producer-signed, this can only be hook-local elapsed (pre-POST), never commit-to-sealed-response. See D1."
        : "missing: nothing sets duration_ms on hook seals today. p50/p95 of commit-to-sealed-response is not in the ledger. A one-machine timed bench is the fallback, and must be labelled bench.",
    },
    classification_ms: {
      kind: classMs.length ? "census" : "missing",
      present: classMs.length,
      seals_with_decision: withDecision,
      p50: stats(classMs).p50,
      p95: stats(classMs).p95,
      over_500ms: classMs.filter((n) => n > 500).length,
      note: classMs.length
        ? "census of claim_decision.decision.classification_ms (D2, server-derived, informational, never a selector). Budget is 500 ms per seal."
        : "missing on this bundle: classification_ms is recorded only after step 3 merges and shadow writes claim_decision. Once shadow runs this row is a census, not a log sample.",
    },
    recorded_commit_actors: {
      kind: "census",
      note: "WHO currently written on the seal (actor.type/id), not claim_decision.status. Useful as evidence-density input; it is not the histogram.",
      by_type: recordedByType,
      by_actor: recordedByActor,
    },
  };
}

export function parsePendingSealFile(path: string): string[] {
  if (!existsSync(path)) return [];
  return [...new Set(readFileSync(path, "utf8").split(/\s+/).filter(Boolean))];
}

export function countHookLogFailures(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter((line) => /NOT logged/i.test(line)).length;
}

export function measureBundle(
  bundle: ExportBundle,
  opts: MeasureWindow & { hookLog?: string; pendingSeal?: string } = {},
): Omit<MeasureReport, "handshake" | "generated_at"> & { generated_at?: undefined } {
  const window = { since: opts.since, until: opts.until };
  const body = measureEvents(bundle.events, window);
  const queued = opts.pendingSeal ? parsePendingSealFile(opts.pendingSeal) : [];
  const failures = opts.hookLog ? countHookLogFailures(opts.hookLog) : null;
  return {
    bundle: {
      project: bundle.scope?.project,
      generated_at: bundle.generated_at,
      events: bundle.events.length,
      head_seq: bundle.events.length ? bundle.events[bundle.events.length - 1].seq : null,
      format: bundle.format,
    },
    window,
    ...body,
    pending_seals: {
      kind: "per-machine",
      queued_shas: queued,
      hook_log_failures: failures,
      note: opts.pendingSeal || opts.hookLog
        ? "per-machine: current .git/retrace-pending-seal queue and retrace-hook.log 'NOT logged' lines. Not fleet-wide; state the machine."
        : "per-machine, not in the export. Pass --pending-seal and --hook-log to count this machine's queue. A number from one laptop is not the fleet.",
    },
  };
}

export async function measureHandshakeSchemas(): Promise<HandshakeMeasure> {
  const { buildServer } = await import("./index.js");
  const { SqliteStore } = await import("./sqlite-store.js");
  const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
  const store = new SqliteStore(":memory:");
  const server = buildServer(store, { actorLock: false, commitLock: false, lock: false });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "phase-a-measure", version: "0" });
  await client.connect(ct);
  const listed = await client.listTools();
  const tools: HandshakeTool[] = listed.tools.map((t) => {
    const schema = t.inputSchema ?? {};
    const schema_bytes = utf8Bytes(schema);
    const description_bytes = utf8Bytes(t.description ?? "");
    const bytes = utf8Bytes({ name: t.name, description: t.description, inputSchema: schema });
    return { name: t.name, bytes, description_bytes, schema_bytes };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const total_bytes = tools.reduce((a, t) => a + t.bytes, 0);
  const audit = new Set<string>(AUDIT_MCP_TOOL_NAMES);
  const worker_audit_subset_bytes = tools.filter((t) => audit.has(t.name)).reduce((a, t) => a + t.bytes, 0);
  try { await client.close(); } catch { /* ignore */ }
  return {
    kind: "census",
    tool_count: tools.length,
    total_bytes,
    tools,
    worker_audit_subset_bytes,
    worker_audit_tool_count: tools.filter((t) => audit.has(t.name)).length,
    note: "census: UTF-8 bytes of this checkout's MCP tools/list payload (name + description + inputSchema) after handshake. Fixed per harness version. Local CLI MCP is 11 tools; the Worker remote MCP is the 9-tool audit subset (no retrace_amend, no retrace_share).",
  };
}

export function renderMarkdown(report: MeasureReport): string {
  const lines: string[] = [];
  const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
  lines.push(`# Phase A measurement`);
  lines.push("");
  lines.push(`Bundle project: \`${report.bundle.project ?? "?"}\` · events: ${report.bundle.events} · head seq: ${report.bundle.head_seq ?? "∅"} · bundle generated: ${report.bundle.generated_at ?? "?"}`);
  if (report.window.since || report.window.until) {
    lines.push(`Window (seal received_at, not Git author date): ${report.window.since ?? "…"} → ${report.window.until ?? "…"}`);
  } else {
    lines.push("Window: all seals in the bundle (no --since/--until).");
  }
  lines.push("");
  lines.push("Every number is labelled **census**, **proxy**, **bench**, **missing**, or **per-machine**. A proxy published as a measurement is a defect in this report.");
  lines.push("");
  lines.push("## 1. Status histogram");
  lines.push("");
  lines.push(`Kind: **${report.histogram.kind}**. ${report.histogram.note}`);
  lines.push("");
  lines.push(row(["status", "n", "kind"]));
  lines.push(row(["---", "---:", "---"]));
  const statuses = [...CLASSIFIER_STATUSES, "absent", ...Object.keys(report.histogram.by_status).filter((k) => !(CLASSIFIER_STATUSES as readonly string[]).includes(k) && k !== "absent")];
  for (const s of statuses) {
    lines.push(row([s, String(report.histogram.by_status[s] ?? 0), report.histogram.kind]));
  }
  lines.push("");
  lines.push(`Seals in scope: ${report.histogram.seals}. With claim_decision: ${report.histogram.with_claim_decision}. Absent: ${report.histogram.absent_claim_decision}.`);
  if (Object.keys(report.histogram.by_reason).length) {
    lines.push("");
    lines.push(row(["reason", "n", "kind"]));
    lines.push(row(["---", "---:", "---"]));
    for (const [r, n] of Object.entries(report.histogram.by_reason).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      lines.push(row([r, String(n), "census"]));
    }
  }
  lines.push("");
  lines.push("Conflicting cases are **not** printed here. Brief §1 item 2 is by-hand review in Phase 1.");
  lines.push("");
  lines.push("## Hook producer-sig split (design §6)");
  lines.push("");
  lines.push(`Kind: **${report.hook_producer_sig.kind}**.`);
  lines.push("");
  lines.push(row(["format", "n", "kind"]));
  lines.push(row(["---", "---:", "---"]));
  lines.push(row(["unsigned", String(report.hook_producer_sig.unsigned), "census"]));
  lines.push(row([`${PRODUCER_SIG_FORMAT} (legacy_client)`, String(report.hook_producer_sig.v1_legacy_client), "census"]));
  lines.push(row([PRODUCER_SIG_FORMAT_V2, String(report.hook_producer_sig.v2), "census"]));
  lines.push(row(["other", String(report.hook_producer_sig.other), "census"]));
  lines.push("");
  lines.push("## 3. legacy_client");
  lines.push("");
  lines.push(`Kind: **${report.legacy_client.kind}**. Count: **${report.legacy_client.count}**. ${report.legacy_client.note}`);
  lines.push("");
  lines.push("## 4. Cost profile");
  lines.push("");
  lines.push("### retrace_log calls per commit, by actor");
  lines.push("");
  lines.push(`Kind: **${report.logs_per_commit.kind}**. ${report.logs_per_commit.note}`);
  lines.push("");
  lines.push(row(["metric", "value", "kind"]));
  lines.push(row(["---", "---:", "---"]));
  lines.push(row(["unique SHAs (git commit seals grouped)", String(report.logs_per_commit.unique_shas), "census"]));
  lines.push(row(["intervals (unique SHA with a previous commit, in scope)", String(report.logs_per_commit.intervals), "census"]));
  lines.push(row(["p50 agent events / commit", fmt(report.logs_per_commit.p50), "census"]));
  lines.push(row(["p95 agent events / commit", fmt(report.logs_per_commit.p95), "census"]));
  lines.push(row(["mean", fmt(report.logs_per_commit.mean), "census"]));
  lines.push(row(["max", fmt(report.logs_per_commit.max), "census"]));
  lines.push(row(["share of commits with 0 agent events", fmtShare(report.logs_per_commit.zero_share), "census"]));
  lines.push("");
  lines.push(row(["actor.id", "agent events in intervals", "kind"]));
  lines.push(row(["---", "---:", "---"]));
  const actors = Object.entries(report.logs_per_commit.by_actor).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [id, n] of actors) lines.push(row([id, String(n), "census"]));
  if (!actors.length) lines.push(row(["(none)", "0", "census"]));
  lines.push("");
  lines.push("### tokens / bytes per call");
  lines.push("");
  lines.push(row(["metric", "n", "p50", "p95", "kind", "note"]));
  lines.push(row(["---", "---:", "---:", "---:", "---", "---"]));
  const mt = report.tokens.method_tokens;
  const sc = report.tokens.stored_canonical_bytes;
  const ps = report.tokens.producer_signed_bytes;
  lines.push(row(["method.tokens", String(mt.present), fmt(mt.p50), fmt(mt.p95), mt.kind, mt.note]));
  lines.push(row(["stored canonical bytes", String(sc.n), fmt(sc.p50), fmt(sc.p95), sc.kind, sc.note]));
  lines.push(row(["producer-signed payload bytes", String(ps.n), fmt(ps.p50), fmt(ps.p95), ps.kind, ps.note]));
  lines.push("");
  if (report.handshake) {
    lines.push("### tool-schema bytes at handshake");
    lines.push("");
    lines.push(`Kind: **${report.handshake.kind}**. ${report.handshake.note}`);
    lines.push("");
    lines.push(`Local MCP total: **${report.handshake.total_bytes}** bytes across **${report.handshake.tool_count}** tools. Worker audit subset: **${report.handshake.worker_audit_subset_bytes}** bytes across **${report.handshake.worker_audit_tool_count}** tools.`);
    lines.push("");
    lines.push(row(["tool", "bytes", "schema_bytes", "kind"]));
    lines.push(row(["---", "---:", "---:", "---"]));
    for (const t of report.handshake.tools) {
      lines.push(row([t.name, String(t.bytes), String(t.schema_bytes), "census"]));
    }
    lines.push("");
  }
  lines.push("### hook wall-clock p50/p95");
  lines.push("");
  const hw = report.hook_wall_clock;
  lines.push(`Kind: **${hw.kind}**. present ${hw.present}/${hw.seals}. p50=${fmt(hw.p50)} p95=${fmt(hw.p95)}. ${hw.note}`);
  lines.push("");
  lines.push("### Worker classification time per seal");
  lines.push("");
  const cm = report.classification_ms;
  lines.push(`Kind: **${cm.kind}**. present ${cm.present}/${cm.seals_with_decision} decisions. p50=${fmt(cm.p50)} p95=${fmt(cm.p95)}. over 500 ms: ${cm.over_500ms}. ${cm.note}`);
  lines.push("");
  lines.push("### pending-seal retries");
  lines.push("");
  const psr = report.pending_seals;
  lines.push(`Kind: **${psr.kind}**. queued: ${psr.queued_shas.length ? psr.queued_shas.join(", ") : "(empty or not supplied)"}. hook-log failures: ${psr.hook_log_failures ?? "n/a"}. ${psr.note}`);
  lines.push("");
  lines.push("## Recorded actor on commit seals (not the classifier)");
  lines.push("");
  lines.push(`Kind: **${report.recorded_commit_actors.kind}**. ${report.recorded_commit_actors.note}`);
  lines.push("");
  lines.push(row(["actor", "n", "kind"]));
  lines.push(row(["---", "---:", "---"]));
  for (const [k, n] of Object.entries(report.recorded_commit_actors.by_type).sort()) {
    lines.push(row([`type=${k}`, String(n), "census"]));
  }
  for (const [k, n] of Object.entries(report.recorded_commit_actors.by_actor).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(row([k, String(n), "census"]));
  }
  lines.push("");
  return lines.join("\n");
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

function fmtShare(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

export async function runCli(argv: string[]): Promise<string> {
  const { values: flags, positionals: pos } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      since: { type: "string" },
      until: { type: "string" },
      "hook-log": { type: "string" },
      "pending-seal": { type: "string" },
      json: { type: "boolean" },
      "no-handshake": { type: "boolean" },
    },
  });
  if (pos.length !== 1) {
    throw new Error("usage: phase-a-measure <bundle.json> [--since ISO] [--until ISO] [--hook-log path] [--pending-seal path] [--json] [--no-handshake]");
  }
  const bundle = parseExportBundle(readFileSync(pos[0], "utf8"));
  const measured = measureBundle(bundle, {
    since: flags.since,
    until: flags.until,
    hookLog: flags["hook-log"],
    pendingSeal: flags["pending-seal"],
  });
  const handshake = flags["no-handshake"] === true ? undefined : await measureHandshakeSchemas();
  const report: MeasureReport = {
    generated_at: new Date().toISOString(),
    ...measured,
    handshake,
  };
  if (flags.json === true) return JSON.stringify(report, null, 2);
  return renderMarkdown(report);
}
