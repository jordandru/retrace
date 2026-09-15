/**
 * Classify-path diagnostics — observability only, never a behaviour change.
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
 * Timing: a fail-closed exit is not only a place, it is also a duration. Each diagnostic carries
 * `ms` (from the start of the classification) and, on the classify path, `timing` — the per-step
 * milliseconds of every store call made so far. A completed classification emits one `classify.ok`
 * line carrying the same numbers, because the question the numbers answer (how close to the 500 ms
 * budget is a healthy production classification?) cannot be answered from failures alone.
 *
 * Who emits what: each fail-closed exit emits one diagnostic at the point that decides the reason —
 * `classifyCommitClaim`'s outer catch (which names the operation it was in), each of
 * `classifyCommitClaimInner`'s own exits, and each exit of `evaluateAmendmentsAtU` and its two
 * helpers (which the classifier does not re-emit). A store helper that swallows an exception
 * (`runArtifactIndexStatements`, `policySnapshotFromIndex`) emits a second, inner line carrying that
 * exception. Two lines for one classification are expected: that pairing is how a cause reaches the
 * path that hit it.
 *
 * **A log line is not a private place.** No text from a caught value ever reaches it. A decode
 * failure quotes the body it could not parse; a D1 message continues past its own prefix into
 * whatever the statement touched; `Error.name` is writable; and a rejection can simply be a string.
 * So a caught value contributes only a *class* — a recognised condition token or a plain identifier
 * — and the two channels are kept apart in the type (Codex P2, PR 57 rounds 1 and 2).
 */

/** One diagnostic line. */
export interface Diagnostic {
  /** Stable dotted name of the exit, e.g. `classify.amendments.captures`. */
  site: string;
  /** The reason the caller returns — the same value the hook sees in its 503. */
  reason: string;
  /** A fixed phrase written at a call site, or the class of a caught value. Never caught text. */
  detail?: string;
  /** Milliseconds from the start of the classification (or of the failing read) to this line. */
  ms?: number;
  /** Per-step milliseconds of the classify path, oldest first: `store.head=12 …`. Names only. */
  timing?: string;
}

export type DiagnosticSink = (diagnostic: Diagnostic) => void;

/** Measured after the sink check, never on a path that will not log. */
export type DiagnosticMeasure = () => { ms?: number; timing?: string };

/**
 * Detail comes from exactly two channels, and they are never mixed. `phrase` is text the call site
 * wrote; `thrown` is a value somebody else threw, and only its class survives. Keeping them apart
 * in the type is the fix for three separate bypasses found in review: an allow-listed prefix with a
 * body appended to it, a spoofed `Error.name`, and a rejection that is simply a string.
 */
export type DiagnosticDetail = { readonly phrase: string } | { readonly thrown: unknown };

/** Text written at the call site. Must be a literal; never build one out of data. */
export function phrase(text: string): DiagnosticDetail {
  return { phrase: text };
}

/** A caught value. Rendered as a condition code or a class label — never its own text. */
export function thrown(error: unknown): DiagnosticDetail {
  return { thrown: error };
}

/** A log line that is not bounded is a hazard. The returned text is never longer than this. */
export const DIAGNOSTIC_DETAIL_MAX = 300;

/** Step names are our own literals, so this is log hygiene rather than redaction. */
export const DIAGNOSTIC_TIMING_MAX = 600;

/** What a detail becomes when rendering it fails. The line itself is never lost. */
export const DIAGNOSTIC_DETAIL_UNAVAILABLE = "detail unavailable";

/**
 * Conditions worth telling apart. A caught value whose message begins with one of these renders as
 * the token itself — the literal below, never the message it was recognised in, because the rest of
 * a D1 message can be anything the statement or the row contained.
 */
const CONDITIONS = [
  "D1_ERROR",
  "D1_EXEC_ERROR",
  "D1_TYPE_ERROR",
  "D1_COLUMN_NOTFOUND",
  "Network connection lost",
  "Too many API requests",
  "Cannot perform I/O",
  "Worker exceeded",
  "Script exceeded",
  "storage limit",
  "deadline",
  "unresolvable",
  "classification context store is not available",
] as const;

/** A class label we are willing to print: an identifier, nothing else. `Error.name` is mutable. */
const SAFE_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

const bound = (text: string) =>
  (text.length > DIAGNOSTIC_DETAIL_MAX ? `${text.slice(0, DIAGNOSTIC_DETAIL_MAX - 1)}…` : text);

/** Never throws: an accessor on a caught value may, and losing the line loses the site too. */
function readString(read: () => unknown): string {
  try {
    const value = read();
    return typeof value === "string" ? collapse(value) : "";
  } catch {
    return "";
  }
}

/**
 * The class of a caught value, from a fixed vocabulary. A recognised condition renders as its token;
 * anything else renders as its class name when that name is a plain identifier, and as `Error`
 * otherwise. A value that is not an `Error` renders as its type and is never called, serialised or
 * coerced — a thrown function in particular is named, not invoked.
 */
export function thrownClass(error: unknown): string {
  if (!(error instanceof Error)) {
    return `non-error(${error === null ? "null" : typeof error})`;
  }
  const message = readString(() => (error as Error).message);
  const condition = CONDITIONS.find((c) => message.toLowerCase().startsWith(c.toLowerCase()));
  if (condition) return condition;
  const name = readString(() => (error as Error).name);
  return SAFE_CLASS.test(name) ? name : "Error";
}

/** One bounded line from one of the two channels. Never throws. */
export function diagnosticDetail(detail: DiagnosticDetail): string {
  try {
    return "phrase" in detail ? bound(collapse(detail.phrase)) : bound(thrownClass(detail.thrown));
  } catch {
    return DIAGNOSTIC_DETAIL_UNAVAILABLE;
  }
}

/**
 * Emit through the sink. No sink, or a sink that throws or rejects, leaves the caller unchanged.
 *
 * `detail` may be a thunk **of a `DiagnosticDetail`**, called only when there is a sink: a
 * diagnostic must not probe the store on a path that will not log. Only this outer wrapper is ever
 * called; a caught value travels inside `thrown(...)`, so a thrown function can never be executed.
 */
export function emitDiagnostic(
  sink: DiagnosticSink | undefined,
  site: string,
  reason: string,
  detail?: DiagnosticDetail | (() => DiagnosticDetail | undefined),
  measure?: DiagnosticMeasure,
): void {
  if (!sink) return;
  let text: string | undefined;
  let ms: number | undefined;
  let timing: string | undefined;
  try {
    const value = typeof detail === "function" ? detail() : detail;
    if (value !== undefined) text = diagnosticDetail(value);
  } catch {
    // A thunk that throws must not cost us the line: the site and the stage are the point.
    text = DIAGNOSTIC_DETAIL_UNAVAILABLE;
  }
  try {
    const measured = measure ? measure() : undefined;
    ms = typeof measured?.ms === "number" ? measured.ms : undefined;
    timing = measured?.timing;
    if (timing !== undefined && timing.length > DIAGNOSTIC_TIMING_MAX) {
      timing = `${timing.slice(0, DIAGNOSTIC_TIMING_MAX - 1)}…`;
    }
  } catch {
    // Same: a broken measure costs its numbers, not the line.
  }
  try {
    const result = sink({
      site,
      reason,
      ...(text === undefined ? {} : { detail: text }),
      ...(ms === undefined ? {} : { ms }),
      ...(timing === undefined ? {} : { timing }),
    }) as unknown;
    // The sink type returns void, but an `async` function satisfies it: observe the rejection here
    // rather than let an unhandled rejection take the runtime down (Codex P2, PR 57 round 1).
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      (result as Promise<unknown>).then(undefined, () => {});
    }
  } catch {
    // Observability must never break what it observes.
  }
}

/**
 * The server-side sink: one `console.error` line per diagnostic. Visible in `wrangler tail` and,
 * because `[observability]` is enabled on this Worker, retained in Workers Logs — so a shadow window
 * can be read back after the tail is gone, without a write of our own on the ingress path.
 */
export function consoleDiagnosticSink(channel: string): DiagnosticSink {
  return (diagnostic) => console.error(`retrace-api: ${channel}`, JSON.stringify(diagnostic));
}
