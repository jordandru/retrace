import { test } from "node:test";
import assert from "node:assert/strict";
import { isReviewVerdict, reviewVerdictProblem } from "./review-verdict.js";

const RID = "evt_" + "b".repeat(32);
const base = (over: Record<string, unknown> = {}, params: Record<string, unknown> = {}) => ({
  action: "approved", tags: ["review"], actor: { type: "agent" },
  method: { tool: "review", params: { findings: { high: 0, medium: 0, low: 0 }, routing_event_id: RID, reviewed_head: "0437948cbc81", blocking: false, ...params } },
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

test("reviewVerdictProblem: complete verdicts pass", () => {
  assert.equal(reviewVerdictProblem(base()), undefined);
  assert.equal(reviewVerdictProblem(base({ action: "rejected" }, { findings: { high: 0, medium: 1, low: 2 }, blocking: true })), undefined);
  assert.equal(reviewVerdictProblem(base({ action: "rejected" }, { blocking: true, blocking_reason: "head differs from the routed head" })), undefined);
  assert.equal(reviewVerdictProblem(base({}, { findings: { high: 0, medium: 1, low: 0 }, accepted_reason: "Medium is a documentation nit the merger accepts" })), undefined);
  assert.equal(reviewVerdictProblem(base({ tags: [], action: "approved" })), undefined, "not a verdict → no problem");
});

test("reviewVerdictProblem: each missing or inconsistent field is named", () => {
  assert.match(reviewVerdictProblem(base({}, { findings: undefined }))!, /findings/);
  assert.match(reviewVerdictProblem(base({}, { findings: { high: 0, medium: "1", low: 0 } }))!, /findings/);
  assert.match(reviewVerdictProblem(base({}, { routing_event_id: "evt_abc" }))!, /routing_event_id/);
  assert.match(reviewVerdictProblem(base({}, { reviewed_head: "" }))!, /reviewed_head/);
  assert.match(reviewVerdictProblem(base({}, { blocking: "no" }))!, /blocking/);
  assert.match(reviewVerdictProblem(base({ action: "rejected" }, { blocking: false }))!, /rejected verdict is blocking/);
  assert.match(reviewVerdictProblem(base({ action: "rejected" }, { blocking: true }))!, /no High or Medium/);
  assert.match(reviewVerdictProblem(base({}, { blocking: true }))!, /approved verdict is not blocking/);
  assert.match(reviewVerdictProblem(base({}, { findings: { high: 1, medium: 0, low: 0 } }))!, /accepted_reason/);
});
