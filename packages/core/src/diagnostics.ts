/**
 * Fail-closed diagnostics — observability only, never a behaviour change.
 *
 * Every fail-closed exit on the classify path returns one of four reasons (`deadline`, `budget`,
 * `store_error`, `policy_missing`) and nothing else, so a 503 at the hook, or a `wrangler tail`,
 * says that classification stopped but never where or why. Three shadow windows were opened and
 * reverted on `store_error` with no way to tell which read produced it (finding
 * `evt_ea9631238e5040068c5eae82a115e810`, 2026-09-15; the same seal classifies to a decision on a
 * memory store).
 *
 * The library writes nothing on its own: a caller passes a sink, a missing sink is the default, and
 * a sink that throws is swallowed. A diagnostic can never change a result.
 *
 * Who emits what: each fail-closed exit emits one diagnostic at the point that decides the reason —
 * `classifyCommitClaim`'s outer catch, each of `classifyCommitClaimInner`'s own exits, and each exit
 * of `evaluateAmendmentsAtU` and its two helpers (which the classifier does not re-emit). A store
 * helper that swallows an exception (`runArtifactIndexStatements`, `policySnapshotFromIndex`) emits
 * a second, inner line carrying that exception's text. Two lines for one classification are
 * expected: that pairing is how a cause reaches the path that hit it.
 */

/** One fail-closed exit. */
export interface Diagnostic {
  /** Stable dotted name of the exit, e.g. `classify.amendments.captures`. */
  site: string;
  /** The reason the caller returns — the same value the hook sees in its 503. */
  reason: string;
  /** Message of a swallowed exception, or a short phrase naming the condition. One bounded line. */
  detail?: string;
}

export type DiagnosticSink = (diagnostic: Diagnostic) => void;

/** A D1 message is the signal; the rest is noise, and a log line that is not bounded is a hazard. */
export const DIAGNOSTIC_DETAIL_MAX = 300;

/** Name and message on one line, bounded. Never a stack: it carries SQL text and no new fact. */
export function diagnosticDetail(detail: unknown): string {
  let raw: string;
  if (detail instanceof Error) raw = `${detail.name}: ${detail.message}`;
  else if (typeof detail === "string") raw = detail;
  else {
    try { raw = JSON.stringify(detail) ?? String(detail); } catch { raw = String(detail); }
  }
  const line = raw.replace(/\s+/g, " ").trim();
  return line.length > DIAGNOSTIC_DETAIL_MAX ? `${line.slice(0, DIAGNOSTIC_DETAIL_MAX)}…` : line;
}

/** Emit through the sink. No sink, or a sink that throws, leaves the caller unchanged. */
export function emitDiagnostic(
  sink: DiagnosticSink | undefined,
  site: string,
  reason: string,
  detail?: unknown,
): void {
  if (!sink) return;
  try {
    sink(detail === undefined ? { site, reason } : { site, reason, detail: diagnosticDetail(detail) });
  } catch {
    // Observability must never break what it observes.
  }
}

/** The server-side sink: one `console.error` line per fail-closed exit, visible in `wrangler tail`. */
export function consoleDiagnosticSink(channel: string): DiagnosticSink {
  return (diagnostic) => console.error(`retrace-api: ${channel} fail-closed`, JSON.stringify(diagnostic));
}
