import { test } from "node:test";
import assert from "node:assert/strict";
import { assessOrcaSendReceipt } from "./orca-send-receipt.js";

const HANDLE = "term_11111111-2222-3333-4444-555555555555";
const INCARNATION = "977b50fe-87d7-435e-8e21-1b57da749867";
const result = (send: unknown, code = 0) => ({
  code,
  stdout: JSON.stringify({ ok: true, result: { send, mutation: { requestId: "prompt-1", replayed: false } } }),
  stderr: code ? "transport failed" : "",
});
const prompt = (stages: unknown) => ({
  handle: HANDLE,
  accepted: true,
  bytesWritten: 42,
  prompt: {
    requestId: "prompt-1",
    stages,
    provider: "codex",
    observation: "supported",
    processIncarnation: INCARNATION,
    generation: 3,
    baselineWorkingSequence: 7,
  },
});

test("assessOrcaSendReceipt: only the expected handle's request-bound turn_started stage proves delivery", () => {
  const delivered = assessOrcaSendReceipt(result(prompt(["input_accepted", "turn_started"])), HANDLE, "codex", INCARNATION);
  assert.equal(delivered.delivered, true);
  assert.equal(delivered.accepted, true);
  assert.equal(delivered.receipt.status, "turn_started");
  assert.equal(delivered.receipt.request_id, "prompt-1");
  assert.deepEqual(delivered.receipt.stages, ["input_accepted", "turn_started"]);

  assert.equal(
    assessOrcaSendReceipt(result({ ...prompt(["input_accepted", "turn_started"]), handle: "term_other" }), HANDLE, "codex", INCARNATION).delivered,
    "unknown",
  );
});

test("assessOrcaSendReceipt: acceptance without turn start and malformed success stay unknown", () => {
  const accepted = assessOrcaSendReceipt(result(prompt(["input_accepted"])), HANDLE, "codex", INCARNATION);
  assert.equal(accepted.delivered, "unknown");
  assert.equal(accepted.reason, "turn_start_unobserved");

  for (const malformed of [
    prompt(["turn_started"]),
    prompt(["turn_started", "input_accepted"]),
    prompt(["input_accepted", 7]),
    { ...prompt(["input_accepted", "turn_started"]), prompt: { stages: ["input_accepted", "turn_started"], provider: "codex" } },
    { ...prompt(["input_accepted", "turn_started"]), bytesWritten: 0 },
    { accepted: true, submission: "observed" },
  ]) {
    const assessment = assessOrcaSendReceipt(result(malformed), HANDLE, "codex", INCARNATION);
    assert.equal(assessment.delivered, "unknown");
    assert.equal(assessment.reason, "orca_send_receipt_invalid");
  }

  const okFalse = result(prompt(["input_accepted", "turn_started"]));
  okFalse.stdout = JSON.stringify({ ok: false, result: { send: prompt(["input_accepted", "turn_started"]) } });
  assert.equal(assessOrcaSendReceipt(okFalse, HANDLE, "codex", INCARNATION).delivered, "unknown");

  const wrongProvider = prompt(["input_accepted", "turn_started"]);
  wrongProvider.prompt.provider = "claude";
  assert.equal(assessOrcaSendReceipt(result(wrongProvider), HANDLE, "codex", INCARNATION).delivered, "unknown");
});

test("assessOrcaSendReceipt: only explicit zero-byte refusal is false; transport failure is unknown", () => {
  const refused = assessOrcaSendReceipt(result({ handle: HANDLE, accepted: false, bytesWritten: 0, refusedReason: "not_sendable" }, 1), HANDLE, "codex", INCARNATION);
  assert.equal(refused.delivered, false);
  assert.equal(refused.reason, "orca_send_refused: not_sendable");

  const contradictory = assessOrcaSendReceipt(result({ handle: HANDLE, accepted: false, bytesWritten: 2 }), HANDLE, "codex", INCARNATION);
  assert.equal(contradictory.delivered, "unknown");
  assert.equal(contradictory.reason, "orca_send_receipt_invalid");

  const failed = assessOrcaSendReceipt({ code: 1, stdout: "", stderr: "transport failed" }, HANDLE, "codex", INCARNATION);
  assert.equal(failed.delivered, "unknown");
  assert.equal(failed.accepted, "unknown");
  assert.equal(failed.reason, "orca_send_failed: exit 1");
});
