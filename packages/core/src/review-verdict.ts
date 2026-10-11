/**
 * Review verdict shape (agent-rules 11). A verdict of record is an agent event `approved` / `rejected` tagged `review`.
 * Measured 2026-10-11 (docs/design/dispatch-protocol.md §2): 17 of 55 verdicts on six PRs carried no findings counts
 * in their params (the counts lived in prose), and one `rejected` carried only Low findings and said of itself "this
 * rejection does not block". The merger and the doctor then have to read prose to know whether a round is blocked.
 * This validator makes the counts and the blocking answer part of the sealed record. It applies only to verdicts
 * (not routing events, not the receiver's receipts); historical events are reported by the doctor, never rewritten.
 */
export const REVIEW_TAG = "review";
const EVENT_ID_RE = /^evt_[0-9a-f]{32}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;

export type ReviewVerdictLike = {
  action: string;
  action_detail?: string;
  tags?: string[];
  actor?: { type?: string };
  method?: { tool?: string; params?: Record<string, unknown> };
};

/** Is this event a review verdict, as the doctor counts them (`isReviewEvent`)? */
export function isReviewVerdict(e: ReviewVerdictLike): boolean {
  if (e.actor?.type !== "agent") return false;
  if (e.method?.tool === "routing") return false;
  if (e.action !== "approved" && e.action !== "rejected") return false;
  return e.tags?.includes(REVIEW_TAG) === true || e.action_detail === "reviewed" || e.action_detail === "review";
}

export type ReviewFindings = { high: number; medium: number; low: number };

function counts(v: unknown): ReviewFindings | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === "number" && Number.isInteger(o[k]) && (o[k] as number) >= 0 ? (o[k] as number) : undefined);
  const high = n("high"), medium = n("medium"), low = n("low");
  if (high === undefined || medium === undefined || low === undefined) return undefined;
  return { high, medium, low };
}

/**
 * Why a verdict cannot be sealed as it stands, or undefined when it can. Required on `method.params`:
 * `findings: {high, medium, low}` (integers), `routing_event_id` (full id), `reviewed_head` (hex sha),
 * `blocking` (boolean). A `rejected` verdict is blocking; it needs a High or Medium finding, or a
 * `blocking_reason`. An `approved` verdict is not blocking; with a High or Medium it needs an `accepted_reason`.
 */
export function reviewVerdictProblem(e: ReviewVerdictLike): string | undefined {
  if (!isReviewVerdict(e)) return undefined;
  const p = e.method?.params ?? {};
  const f = counts(p.findings);
  if (!f) return "review verdict needs method.params.findings = {high, medium, low} as non-negative integers";
  if (typeof p.routing_event_id !== "string" || !EVENT_ID_RE.test(p.routing_event_id))
    return "review verdict needs method.params.routing_event_id (the full evt_ id of the coordinator's routing event)";
  if (typeof p.reviewed_head !== "string" || !SHA_RE.test(p.reviewed_head))
    return "review verdict needs method.params.reviewed_head (the commit sha the verdict binds to)";
  if (typeof p.blocking !== "boolean") return "review verdict needs method.params.blocking (true for rejected, false for approved)";
  const severe = f.high + f.medium > 0;
  if (e.action === "rejected") {
    if (p.blocking !== true) return "a rejected verdict is blocking: set method.params.blocking = true, or seal it as approved with its Low findings";
    if (!severe && !(typeof p.blocking_reason === "string" && p.blocking_reason.trim()))
      return "a rejected verdict with no High or Medium finding needs method.params.blocking_reason (or is approved with Low findings)";
  } else {
    if (p.blocking !== false) return "an approved verdict is not blocking: set method.params.blocking = false";
    if (severe && !(typeof p.accepted_reason === "string" && p.accepted_reason.trim()))
      return "an approved verdict that reports a High or Medium finding needs method.params.accepted_reason";
  }
  return undefined;
}
