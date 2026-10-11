import { test } from "node:test";
import assert from "node:assert/strict";
import { isReviewVerdict, reviewVerdictProblem, blockingFor } from "./review-verdict.js";

const RID = "evt_" + "b".repeat(32);
const HEAD = "6ac80c98c75b01118ca9aaabcf44b1957e1dc1ca";
const base = (over: Record<string, unknown> = {}, params: Record<string, unknown> = {}) => ({
  action: "approved", tags: ["review"], actor: { type: "agent" },
  method: { tool: "review", params: { findings: { high: 0, medium: 0, low: 0 }, routing_event_id: RID, reviewed_head: HEAD, blocking: false, ...params } },
  ...over,
});

test("isReviewVerdict: verdicts only", () => {
  assert.equal(isReviewVerdict(base()), true);
  assert.equal(isReviewVerdict(base({ action: "rejected" })), true);
  assert.equal(isReviewVerdict(base({ tags: [], action_detail: "reviewed" })), true);
  assert.equal(isReviewVerdict(base({ tags: [] })), false, "approved without the tag is not a verdict");
  assert.equal(isReviewVerdict(base({ method: { tool: "routing", params: {} } })), false);
  assert.equal(isReviewVerdict(base({ actor: { type: "human" } })), false);
  assert.equal(isReviewVerdict(base({ action: "other" })), false);
});

test("reviewVerdictProblem: blocking is derived from severity (team-roles rule 8)", () => {
  assert.equal(reviewVerdictProblem(base()), undefined, "approved, no findings");
  assert.equal(reviewVerdictProblem(base({}, { findings: { high: 0, medium: 0, low: 2 } })), undefined, "approved with Lows");
  assert.equal(reviewVerdictProblem(base({ action: "rejected" }, { findings: { high: 0, medium: 1, low: 2 }, blocking: true })), undefined, "rejected with a Medium blocks");
  assert.equal(reviewVerdictProblem(base({ action: "rejected" }, { findings: { high: 0, medium: 0, low: 3 }, blocking: false })), undefined, "a Low-only rejection is allowed and does not block");
  assert.equal(reviewVerdictProblem(base({ tags: [] })), undefined, "not a verdict → no problem");
  assert.equal(blockingFor({ high: 0, medium: 0, low: 9 }), false);
  assert.equal(blockingFor({ high: 0, medium: 1, low: 0 }), true);
});

test("reviewVerdictProblem: each missing or inconsistent field is named; no override can invert the gate", () => {
  assert.match(reviewVerdictProblem(base({}, { findings: undefined }))!, /findings/);
  assert.match(reviewVerdictProblem(base({}, { findings: { high: 0, medium: "1", low: 0 } }))!, /findings/);
  assert.match(reviewVerdictProblem(base({}, { routing_event_id: "evt_abc" }))!, /routing_event_id/);
  assert.match(reviewVerdictProblem(base({}, { reviewed_head: "6ac80c98c75b" }))!, /full 40-hex/);
  assert.match(reviewVerdictProblem(base({}, { blocking: "no" }))!, /blocking/);
  assert.match(reviewVerdictProblem(base({ action: "rejected" }, { findings: { high: 0, medium: 0, low: 3 }, blocking: true }))!, /must be false/);
  assert.match(reviewVerdictProblem(base({ action: "rejected" }, { findings: { high: 0, medium: 1, low: 0 }, blocking: false }))!, /must be true/);
  assert.match(reviewVerdictProblem(base({}, { findings: { high: 1, medium: 0, low: 0 }, blocking: true }))!, /approved verdict carries no High or Medium/);
  assert.match(reviewVerdictProblem(base({}, { findings: { high: 0, medium: 1, low: 0 }, blocking: false }))!, /must be true/, "an approval cannot hide a Medium behind blocking:false");
  assert.match(reviewVerdictProblem(base({ action: "rejected" }, { findings: { high: 0, medium: 0, low: 1 }, blocking: true, blocking_reason: "x" }))!, /must be false/);
  assert.match(reviewVerdictProblem(base({ action: "rejected" }, { findings: { high: 0, medium: 0, low: 1 }, blocking: false, blocking_reason: "x" }))!, /not accepted/);
  assert.match(reviewVerdictProblem(base({}, { accepted_reason: "x" }))!, /not accepted/);
});
