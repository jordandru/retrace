import { test } from "node:test";
import assert from "node:assert/strict";
import { paneTextProblem, paneTextSha256, splitSentSuffix, withSentSuffix, verifySentEvent, briefNamedIn, briefNameProblem, briefPathNames, resolveBriefName, expandHome, PANE_TEXT_MAX_BYTES } from "./dispatch.js";
import type { Event } from "./schema.js";

const ID = "evt_" + "a".repeat(32);
const HOME = "/home/alice";
const TERM = "term_11111111-2222-3333-4444-555555555555";
const text = "CLAUDE-CODE review PR 220 r4 per brief ~/.retrace/x/BRIEF.md sha256 9d136e52 — routing evt_955ad2d6 CLAUDE-CODE";
const RECEIVER = { receiver: { seat: "codex", terminal: TERM }, homeDir: HOME };

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
  assert.equal(paneTextProblem("CLAUDE-CODE the JD token is the owner's CLAUDE-CODE", "claude-code"), undefined, "a lone JD token is not an envelope (L2)");
  assert.equal(paneTextProblem("CLAUDE-CODE x [sent-event evt_1] CLAUDE-CODE", "claude-code"), "suffix_in_text");
  // a JD inside a word is not the owner's token
  assert.equal(paneTextProblem("CLAUDE-CODE see JDOC.md CLAUDE-CODE", "claude-code"), undefined);
  assert.equal(PANE_TEXT_MAX_BYTES, 190);
});

test("suffix round-trip: exactly one space, the full id, nothing after", () => {
  const line = withSentSuffix(text, ID);
  assert.equal(Buffer.byteLength(line) - Buffer.byteLength(text), 50);
  assert.deepEqual(splitSentSuffix(line), { text, sentEventId: ID });
  assert.equal(splitSentSuffix(line + "\n"), undefined, "bytes after the suffix, a newline included, are not a suffix (L1)");
  assert.equal(splitSentSuffix(text), undefined);
  assert.equal(splitSentSuffix(`${text} [sent-event evt_abc]`), undefined, "a short id is not a suffix");
  assert.equal(splitSentSuffix(`${text}  [sent-event ${ID}]`)?.text, text + " ", "a second space stays in the hashed text");
});

test("briefNamedIn: the three forms the coordinator uses, and texts that name none (H1)", () => {
  assert.equal(briefNamedIn(text), "~/.retrace/x/BRIEF.md");
  assert.equal(briefNamedIn("CODEX review per brief /tmp/BRIEF.md sha256 1234 CODEX"), "/tmp/BRIEF.md");
  assert.equal(briefNamedIn("CLAUDE-CODE PR 222 fix round 2: brief pr222/FIX-ROUND-2-222.md sha256 d452 rt evt_e95b CLAUDE-CODE"), "pr222/FIX-ROUND-2-222.md", "the relative form, after the word brief");
  assert.equal(briefNamedIn("CLAUDE-CODE review PR 220 r8 per brief agent-ops-20/BRIEF-220-r8.md CLAUDE-CODE"), "agent-ops-20/BRIEF-220-r8.md");
  assert.equal(briefNamedIn("CLAUDE-CODE stand by CLAUDE-CODE"), undefined);
  assert.equal(briefNamedIn("CLAUDE-CODE the brief is ready CLAUDE-CODE"), undefined, "the word brief without a path names nothing");
  assert.equal(briefNamedIn("CLAUDE-CODE see pr222/notes.md later CLAUDE-CODE"), undefined, "a relative path not introduced by brief names nothing");
});

test("briefNameProblem: a name the grammar cannot bind whole is refused, never bound to a prefix (M1 r3)", () => {
  assert.equal(briefNameProblem(text), undefined);
  assert.equal(briefNameProblem("CLAUDE-CODE PR 222 fix round 3: brief pr222/FIX-ROUND-3-222.md sha256 b7e6 rt evt_743e CLAUDE-CODE"), undefined);
  assert.equal(briefNameProblem("CLAUDE-CODE per brief /tmp/A.md CLAUDE-CODE"), undefined, "a name at the end of the text");
  assert.equal(briefNameProblem("CLAUDE-CODE stand by CLAUDE-CODE"), undefined, "no brief named, nothing to parse");
  assert.equal(briefNameProblem("CLAUDE-CODE per brief /tmp/Brief A.md sha256 1234 CLAUDE-CODE"), "brief_name_unparseable", "Codex's probe: a space in the path");
  assert.equal(briefNameProblem("CLAUDE-CODE per brief /tmp/My Brief.md CLAUDE-CODE"), "brief_name_unparseable");
  assert.equal(briefNameProblem("CLAUDE-CODE brief pr222/Brief A.md CLAUDE-CODE"), "brief_name_unparseable", "the relative form too");
  assert.equal(briefNameProblem("CLAUDE-CODE read ~/.retrace/ops-2026-10-11/pr222/ now CLAUDE-CODE"), "brief_name_unparseable", "a directory is not a brief");
  assert.equal(briefNameProblem("CLAUDE-CODE brief /tmp/A.md /tmp/B.md CLAUDE-CODE"), "brief_name_unparseable", "a second path token after the name is not a field");
});

test("briefPathNames / resolveBriefName: one rule on both sides; a pointer naming A never binds to B (H1)", () => {
  const abs = `${HOME}/.retrace/ops-2026-10-11/pr222/FIX-ROUND-2-222.md`;
  assert.equal(expandHome("~/.retrace/x", HOME), `${HOME}/.retrace/x`);
  assert.equal(expandHome("/tmp/a/../b.md", HOME), "/tmp/b.md", "dot segments are normalised");
  // relative form
  assert.equal(briefPathNames(abs, "pr222/FIX-ROUND-2-222.md", HOME), true);
  assert.equal(briefPathNames("~/.retrace/ops-2026-10-11/pr222/FIX-ROUND-2-222.md", "pr222/FIX-ROUND-2-222.md", HOME), true);
  assert.equal(briefPathNames(`${HOME}/.retrace/ops-2026-10-11/pr222/OTHER.md`, "pr222/FIX-ROUND-2-222.md", HOME), false);
  assert.equal(briefPathNames(`${HOME}/elsewhere/pr222/FIX-ROUND-2-222.md`, "pr222/FIX-ROUND-2-222.md", HOME), false, "the relative form lives only under ~/.retrace/ops-*");
  assert.equal(briefPathNames(`${HOME}/.retrace/ops-2026-10-11/pr222/FIX-ROUND-2-222.md`, "pr223/FIX-ROUND-2-222.md", HOME), false);
  assert.equal(resolveBriefName("pr222/FIX-ROUND-2-222.md", HOME, abs), abs);
  assert.equal(resolveBriefName("pr222/FIX-ROUND-2-222.md", HOME, `${HOME}/.retrace/ops-2026-10-11/pr222/OTHER.md`), undefined, "the event's brief_path is not the named brief");
  assert.equal(resolveBriefName("pr222/FIX-ROUND-2-222.md", HOME), undefined, "a relative name without the event cannot be resolved");
  // absolute and home-relative forms
  assert.equal(briefPathNames("/tmp/A.md", "/tmp/A.md", HOME), true);
  assert.equal(briefPathNames("/tmp/B.md", "/tmp/A.md", HOME), false, "A named, B supplied");
  assert.equal(briefPathNames(`${HOME}/.retrace/x/BRIEF.md`, "~/.retrace/x/BRIEF.md", HOME), true);
  assert.equal(briefPathNames("~/.retrace/x/BRIEF.md", `${HOME}/.retrace/x/BRIEF.md`, HOME), true);
  assert.equal(briefPathNames("/tmp/x/../A.md", "/tmp/A.md", HOME), true);
  assert.equal(resolveBriefName("~/.retrace/x/BRIEF.md", HOME), `${HOME}/.retrace/x/BRIEF.md`);
  assert.equal(resolveBriefName("/tmp/A.md", HOME, "/tmp/B.md"), "/tmp/A.md", "an absolute name resolves on its own, whatever the event says; brief_path is checked separately");
  assert.equal(briefPathNames(`${HOME}/.retrace/ops-2026-10-12/pr222/FIX-ROUND-2-222.md`, "pr222/FIX-ROUND-2-222.md", HOME), true, "a sender may bind the name under any ops-* directory; the receiver must then use that one (H1 r3, below)");
});

function raw(over: Partial<Event> & { params?: Record<string, unknown> }): Event {
  const { params, ...rest } = over;
  return {
    id: ID, seq: 10, project: "retrace", action: "sent", actor: { type: "agent", id: "claude-code" },
    artifacts: [{ id: "pane:term_x" }], timestamp: "2026-10-11T00:00:00.000Z", received_at: "2026-10-11T00:00:00.000Z",
    prev_hash: "", hash: "", method: { tool: "retrace_send", params: { sealed_by: "pinned:claude-code MCP (pinned) (signing)", producer_sig_verdict: "verified", receiver_seat: "codex", target_terminal: TERM, ...params } },
    ...rest,
  } as Event;
}

test("verifySentEvent: every check passes on a well-formed sent event addressed to this seat at this terminal", async () => {
  const h = await paneTextSha256(text);
  const b = "1".repeat(64);
  const v = await verifySentEvent(raw({ params: { text_sha256: h, brief_sha256: b, brief_path: `${HOME}/.retrace/x/BRIEF.md` } }), { text, sentEventId: ID, briefSha256: b, briefPresent: true, briefPath: "~/.retrace/x/BRIEF.md", ...RECEIVER });
  assert.equal(v.signature, "verified", JSON.stringify(v.checks));
  assert.equal(v.sender, "claude-code");
  assert.equal(v.failure, undefined);
  assert.deepEqual(Object.keys(v.checks), ["envelope", "exists", "action", "actor", "sealed_by", "producer_sig_verdict", "receiver_seat", "target_terminal", "text_sha256", "brief_path", "brief_sha256"]);
});

test("verifySentEvent: each failure is named and the signature word matches rule 15", async () => {
  const h = await paneTextSha256(text);
  const BP = `${HOME}/.retrace/x/BRIEF.md`;
  const cases: Array<[string, Event | null, Partial<Parameters<typeof verifySentEvent>[1]>, string, string]> = [
    ["missing event", null, {}, "unverifiable", "exists"],
    ["text names a brief, event records none (r1 H3)", raw({ params: { text_sha256: h } }), {}, "mismatch", "brief_path"],
    ["text names a brief, event records a hash but no path", raw({ params: { text_sha256: h, brief_sha256: "1".repeat(64) } }), { briefSha256: "1".repeat(64) }, "mismatch", "brief_path"],
    ["pointer names A, event bound B (r2 H1)", raw({ params: { text_sha256: h, brief_sha256: "1".repeat(64), brief_path: `${HOME}/.retrace/x/OTHER.md` } }), { briefSha256: "1".repeat(64), briefPresent: true }, "mismatch", "brief_path"],
    ["pointer names A, receiver supplies B (r2 H1)", raw({ params: { text_sha256: h, brief_sha256: "1".repeat(64), brief_path: BP } }), { briefSha256: "1".repeat(64), briefPresent: true, briefPath: "/tmp/B.md" }, "mismatch", "brief_path"],
    ["unparseable brief name (r3 M1)", raw({ params: { text_sha256: await paneTextSha256("CLAUDE-CODE per brief /tmp/Brief A.md CLAUDE-CODE"), brief_sha256: "1".repeat(64), brief_path: "/tmp/Brief" } }), { text: "CLAUDE-CODE per brief /tmp/Brief A.md CLAUDE-CODE", briefSha256: "1".repeat(64) }, "mismatch", "brief_path"],
    ["pinned seal of another seat (r1 M3)", raw({ params: { text_sha256: h, brief_sha256: "1".repeat(64), brief_path: BP, sealed_by: "pinned:Grok MCP (pinned) (signing)" } }), { briefSha256: "1".repeat(64), briefPresent: true }, "mismatch", "sealed_by"],
    ["not sent", raw({ action: "received", params: { text_sha256: h } }), {}, "mismatch", "action"],
    ["other actor", raw({ actor: { type: "agent", id: "codex" }, params: { text_sha256: h } }), {}, "mismatch", "actor"],
    ["owner sealed", raw({ params: { text_sha256: h, sealed_by: "owner" } }), {}, "mismatch", "sealed_by"],
    ["sig none", raw({ params: { text_sha256: h, producer_sig_verdict: "none" } }), {}, "mismatch", "producer_sig_verdict"],
    ["addressed to another seat (r2 H2)", raw({ params: { text_sha256: h, brief_sha256: "1".repeat(64), brief_path: BP, receiver_seat: "grok" } }), { briefSha256: "1".repeat(64) }, "mismatch", "receiver_seat"],
    ["addressed to another terminal (r2 H2)", raw({ params: { text_sha256: h, brief_sha256: "1".repeat(64), brief_path: BP, target_terminal: "term_other" } }), { briefSha256: "1".repeat(64) }, "mismatch", "target_terminal"],
    ["no receiver_seat on the event", raw({ params: { text_sha256: h, receiver_seat: undefined } }), {}, "mismatch", "receiver_seat"],
    ["this seat does not know its terminal (r2 H2)", raw({ params: { text_sha256: h, brief_sha256: "1".repeat(64), brief_path: BP } }), { briefSha256: "1".repeat(64), receiver: { seat: "codex" } }, "unverifiable", "target_terminal"],
    ["text hash", raw({ params: { text_sha256: "0".repeat(64) } }), {}, "mismatch", "text_sha256"],
    ["brief hash", raw({ params: { text_sha256: h, brief_sha256: "1".repeat(64), brief_path: BP } }), { briefSha256: "2".repeat(64) }, "mismatch", "brief_sha256"],
    ["brief not read", raw({ params: { text_sha256: h, brief_sha256: "1".repeat(64), brief_path: BP } }), {}, "unverifiable", "brief_sha256"],
    ["brief unreadable (r2 M1)", raw({ params: { text_sha256: h, brief_sha256: "1".repeat(64), brief_path: BP } }), { briefReadError: "EISDIR: illegal operation on a directory" }, "unverifiable", "brief_sha256"],
    ["brief supplied but unrecorded", raw({ params: { text_sha256: h } }), { briefSha256: "1".repeat(64), briefPresent: true }, "mismatch", "brief_path"],
  ];
  for (const [name, ev, extra, signature, failure] of cases) {
    const v = await verifySentEvent(ev, { text, sentEventId: ID, ...RECEIVER, ...extra });
    assert.equal(v.signature, signature, `${name}: ${JSON.stringify(v.checks)}`);
    assert.equal(v.failure, failure, name);
  }
  const v = await verifySentEvent(raw({ params: { text_sha256: h, brief_sha256: "1".repeat(64), brief_path: BP } }), { text, sentEventId: ID, briefSha256: "1".repeat(64), briefPresent: true, ...RECEIVER });
  assert.equal(v.signature, "verified");
  // A text that names no brief, sent without one.
  const plain = "CODEX stand by CODEX";
  const codex = await verifySentEvent(raw({ actor: { type: "agent", id: "codex" }, params: { text_sha256: await paneTextSha256(plain), sealed_by: "pinned:codex (signing)", receiver_seat: "claude-code" } }), { text: plain, sentEventId: ID, receiver: { seat: "claude-code", terminal: TERM }, homeDir: HOME });
  assert.equal(codex.signature, "verified", JSON.stringify(codex.checks));
  // The relative form: the event's brief_path denotes the named brief, and the receiver read that file.
  const rel = "CLAUDE-CODE PR 222 fix round 2: brief pr222/FIX-ROUND-2-222.md sha256 d452 CLAUDE-CODE";
  const relPath = `${HOME}/.retrace/ops-2026-10-11/pr222/FIX-ROUND-2-222.md`;
  const relOk = await verifySentEvent(raw({ params: { text_sha256: await paneTextSha256(rel), brief_sha256: "3".repeat(64), brief_path: relPath } }), { text: rel, sentEventId: ID, briefSha256: "3".repeat(64), ...RECEIVER });
  assert.equal(relOk.signature, "verified", JSON.stringify(relOk.checks));
  const relBad = await verifySentEvent(raw({ params: { text_sha256: await paneTextSha256(rel), brief_sha256: "3".repeat(64), brief_path: `${HOME}/.retrace/ops-2026-10-11/pr222/OTHER.md` } }), { text: rel, sentEventId: ID, briefSha256: "3".repeat(64), ...RECEIVER });
  assert.equal(relBad.failure, "brief_path", "a relative pointer no longer verifies with a different brief (r2 H1)");
  // r3 H1: the receiver supplies the same tail under another ops-* directory → refused; the event's own path → verified.
  const otherOps = await verifySentEvent(raw({ params: { text_sha256: await paneTextSha256(rel), brief_sha256: "3".repeat(64), brief_path: relPath } }), { text: rel, sentEventId: ID, briefSha256: "3".repeat(64), briefPath: `${HOME}/.retrace/ops-2026-10-12/pr222/FIX-ROUND-2-222.md`, ...RECEIVER });
  assert.equal(otherOps.failure, "brief_path", "another ops-* directory with the same tail is not the event's brief");
  assert.match(otherOps.checks.brief_path!.detail, /^brief_path_mismatch/);
  const sameOps = await verifySentEvent(raw({ params: { text_sha256: await paneTextSha256(rel), brief_sha256: "3".repeat(64), brief_path: relPath } }), { text: rel, sentEventId: ID, briefSha256: "3".repeat(64), briefPath: "~/.retrace/ops-2026-10-11/pr222/FIX-ROUND-2-222.md", ...RECEIVER });
  assert.equal(sameOps.signature, "verified", "the same path, written with ~, is the event's path");
  const relNone = await verifySentEvent(raw({ params: { text_sha256: await paneTextSha256(rel) } }), { text: rel, sentEventId: ID, ...RECEIVER });
  assert.equal(relNone.signature, "mismatch", "a relative pointer no longer verifies with no brief (r2 H1)");
  assert.equal(relNone.failure, "brief_path");
});

test("verifySentEvent: a received text without the SEAT envelope fails the envelope check first", async () => {
  const bare = "hello there";
  const v = await verifySentEvent(raw({ params: { text_sha256: await paneTextSha256(bare) } }), { text: bare, sentEventId: ID, ...RECEIVER });
  assert.equal(v.signature, "mismatch");
  assert.equal(v.failure, "envelope");
});
