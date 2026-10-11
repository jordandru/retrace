import { test } from "node:test";
import assert from "node:assert/strict";
import { paneTextProblem, paneTextSha256, splitSentSuffix, withSentSuffix, verifySentEvent, PANE_TEXT_MAX_BYTES } from "./dispatch.js";
import type { Event } from "./schema.js";

const ID = "evt_" + "a".repeat(32);
const text = "CLAUDE-CODE review PR 220 r4 per brief ~/.retrace/x/BRIEF.md sha256 9d136e52 — routing evt_955ad2d6 CLAUDE-CODE";

test("paneTextProblem: the accepted shape and each refusal", () => {
  assert.equal(paneTextProblem(text, "claude-code"), undefined);
  assert.equal(paneTextProblem("", "claude-code"), "empty");
  assert.equal(paneTextProblem(text + "\n", "claude-code"), "multi_line");
  assert.equal(paneTextProblem(text + " ", "claude-code"), "trailing_whitespace");
  assert.equal(paneTextProblem(" " + text, "claude-code"), "leading_whitespace");
  assert.equal(paneTextProblem("CLAUDE-CODE " + "x".repeat(200) + " CLAUDE-CODE", "claude-code")?.startsWith("too_long:"), true);
  assert.equal(paneTextProblem("CODEX hello CODEX", "claude-code"), "envelope_missing");
  assert.equal(paneTextProblem("CLAUDE-CODE hello", "claude-code"), "envelope_missing");
  assert.equal(paneTextProblem("CLAUDE-CODE JD do it JD CLAUDE-CODE", "claude-code"), "owner_envelope_forbidden");
  assert.equal(paneTextProblem("CLAUDE-CODE x [sent-event evt_1] CLAUDE-CODE", "claude-code"), "suffix_in_text");
  // a JD inside a word is not the owner's token
  assert.equal(paneTextProblem("CLAUDE-CODE see JDOC.md CLAUDE-CODE", "claude-code"), undefined);
  assert.equal(PANE_TEXT_MAX_BYTES, 190);
});

test("suffix round-trip: exactly one space, the full id, nothing after", () => {
  const line = withSentSuffix(text, ID);
  assert.equal(Buffer.byteLength(line) - Buffer.byteLength(text), 50);
  assert.deepEqual(splitSentSuffix(line), { text, sentEventId: ID });
  assert.deepEqual(splitSentSuffix(line + "\n"), { text, sentEventId: ID });
  assert.equal(splitSentSuffix(text), undefined);
  assert.equal(splitSentSuffix(`${text} [sent-event evt_abc]`), undefined, "a short id is not a suffix");
  assert.equal(splitSentSuffix(`${text}  [sent-event ${ID}]`)?.text, text + " ", "a second space stays in the hashed text");
});

function raw(over: Partial<Event> & { params?: Record<string, unknown> }): Event {
  const { params, ...rest } = over;
  return {
    id: ID, seq: 10, project: "retrace", action: "sent", actor: { type: "agent", id: "claude-code" },
    artifacts: [{ id: "pane:term_x" }], timestamp: "2026-10-11T00:00:00.000Z", received_at: "2026-10-11T00:00:00.000Z",
    prev_hash: "", hash: "", method: { tool: "retrace_send", params: { sealed_by: "pinned:claude-code MCP (pinned) (signing)", producer_sig_verdict: "verified", ...params } },
    ...rest,
  } as Event;
}

test("verifySentEvent: the six checks pass on a well-formed sent event", async () => {
  const h = await paneTextSha256(text);
  const v = await verifySentEvent(raw({ params: { text_sha256: h } }), { text, sentEventId: ID });
  assert.equal(v.signature, "verified", JSON.stringify(v.checks));
  assert.equal(v.sender, "claude-code");
  assert.equal(v.failure, undefined);
});

test("verifySentEvent: each failure is named and the signature word matches rule 15", async () => {
  const h = await paneTextSha256(text);
  const cases: Array<[string, Event | null, Partial<Parameters<typeof verifySentEvent>[1]>, string, string]> = [
    ["missing event", null, {}, "unverifiable", "exists"],
    ["not sent", raw({ action: "received", params: { text_sha256: h } }), {}, "mismatch", "action"],
    ["other actor", raw({ actor: { type: "agent", id: "codex" }, params: { text_sha256: h } }), {}, "mismatch", "actor"],
    ["owner sealed", raw({ params: { text_sha256: h, sealed_by: "owner" } }), {}, "mismatch", "sealed_by"],
    ["sig none", raw({ params: { text_sha256: h, producer_sig_verdict: "none" } }), {}, "mismatch", "producer_sig_verdict"],
    ["text hash", raw({ params: { text_sha256: "0".repeat(64) } }), {}, "mismatch", "text_sha256"],
    ["brief hash", raw({ params: { text_sha256: h, brief_sha256: "1".repeat(64) } }), { briefSha256: "2".repeat(64) }, "mismatch", "brief_sha256"],
    ["brief not read", raw({ params: { text_sha256: h, brief_sha256: "1".repeat(64) } }), {}, "unverifiable", "brief_sha256"],
    ["brief supplied but unrecorded", raw({ params: { text_sha256: h } }), { briefSha256: "1".repeat(64), briefPresent: true }, "mismatch", "brief_sha256"],
  ];
  for (const [name, ev, extra, signature, failure] of cases) {
    const v = await verifySentEvent(ev, { text, sentEventId: ID, ...extra });
    assert.equal(v.signature, signature, name);
    assert.equal(v.failure, failure, name);
  }
  const v = await verifySentEvent(raw({ params: { text_sha256: h, brief_sha256: "1".repeat(64) } }), { text, sentEventId: ID, briefSha256: "1".repeat(64), briefPresent: true });
  assert.equal(v.signature, "verified");
});

test("verifySentEvent: a received text without the SEAT envelope fails the envelope check first", async () => {
  const bare = "hello there";
  const v = await verifySentEvent(raw({ params: { text_sha256: await paneTextSha256(bare) } }), { text: bare, sentEventId: ID });
  assert.equal(v.signature, "mismatch");
  assert.equal(v.failure, "envelope");
});
