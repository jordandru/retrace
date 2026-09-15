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
 * a sink that throws — synchronously or as a rejected promise — is swallowed. A diagnostic can
 * never change a result.
 *
 * Who emits what: each fail-closed exit emits one diagnostic at the point that decides the reason —
 * `classifyCommitClaim`'s outer catch (which names the operation it was in), each of
 * `classifyCommitClaimInner`'s own exits, and each exit of `evaluateAmendmentsAtU` and its two
 * helpers (which the classifier does not re-emit). A store helper that swallows an exception
 * (`runArtifactIndexStatements`, `policySnapshotFromIndex`) emits a second, inner line carrying that
 * exception. Two lines for one classification are expected: that pairing is how a cause reaches the
 * path that hit it.
 *
 * **A log line is not a private place.** `detail` is never the raw text of an arbitrary exception:
 * a decode failure puts a slice of its input in its message, and a thrown object carries whatever
 * fields it has. Only an allow-listed store or platform condition is forwarded verbatim; anything
 * else is reduced to its class (Codex P2, PR 57 round 1).
 */

/** One fail-closed exit. */
export interface Diagnostic {
  /** Stable dotted name of the exit, e.g. `classify.amendments.captures`. */
  site: string;
  /** The reason the caller returns — the same value the hook sees in its 503. */
  reason: string;
  /** A fixed phrase from the call site, or the safe rendering of a swallowed exception. */
  detail?: string;
}

export type DiagnosticSink = (diagnostic: Diagnostic) => void;

/** A log line that is not bounded is a hazard. The returned text is never longer than this. */
export const DIAGNOSTIC_DETAIL_MAX = 300;

/**
 * Messages forwarded verbatim: each names a store or platform condition and carries no input of
 * ours. Everything else — a decode failure above all, whose message quotes the body it could not
 * parse — is reduced to its class. Widening this list is a deliberate change, not a default.
 */
const SAFE_MESSAGE = new RegExp(
  "^(?:"
  + "D1_ERROR\\b|D1_EXEC_ERROR\\b|D1_TYPE_ERROR\\b|D1_COLUMN_NOTFOUND\\b"
  + "|Network connection lost\\b|Too many API requests\\b|Cannot perform I/O\\b"
  + "|Worker exceeded\\b|Script exceeded\\b|storage limit\\b"
  + "|deadline$|unresolvable$|classification context store is not available$"
  + ")",
  "i",
);

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

const bound = (text: string) =>
  (text.length > DIAGNOSTIC_DETAIL_MAX ? `${text.slice(0, DIAGNOSTIC_DETAIL_MAX - 1)}…` : text);

/**
 * One bounded line. A string comes from one of our own call sites and is kept; an `Error` keeps its
 * class always and its message only when the message is allow-listed; anything else thrown is named
 * by its type and never serialised. Stacks never appear: they carry paths and no new fact.
 */
export function diagnosticDetail(detail: unknown): string {
  if (typeof detail === "string") return bound(collapse(detail));
  if (detail instanceof Error) {
    const name = collapse(detail.name) || "Error";
    const message = collapse(String(detail.message ?? ""));
    if (!message) return bound(name);
    return SAFE_MESSAGE.test(message) ? bound(`${name}: ${message}`) : bound(`${name} (message withheld)`);
  }
  return `non-error thrown value (${detail === null ? "null" : typeof detail})`;
}

/**
 * Emit through the sink. No sink, or a sink that throws or rejects, leaves the caller unchanged.
 *
 * `detail` may be a thunk, which is called only when there is a sink: a diagnostic must not probe
 * the store — or do any other work — on a path that will not log.
 */
export function emitDiagnostic(
  sink: DiagnosticSink | undefined,
  site: string,
  reason: string,
  detail?: unknown | (() => unknown),
): void {
  if (!sink) return;
  try {
    const value = typeof detail === "function" ? (detail as () => unknown)() : detail;
    const result = sink(
      value === undefined ? { site, reason } : { site, reason, detail: diagnosticDetail(value) },
    ) as unknown;
    // The sink type returns void, but an `async` function satisfies it: observe the rejection here
    // rather than let an unhandled rejection take the runtime down (Codex P2, PR 57 round 1).
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      (result as Promise<unknown>).then(undefined, () => {});
    }
  } catch {
    // Observability must never break what it observes.
  }
}

/** The server-side sink: one `console.error` line per fail-closed exit, visible in `wrangler tail`. */
export function consoleDiagnosticSink(channel: string): DiagnosticSink {
  return (diagnostic) => console.error(`retrace-api: ${channel} fail-closed`, JSON.stringify(diagnostic));
}
