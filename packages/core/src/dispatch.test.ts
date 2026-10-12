import { test } from "node:test";
import assert from "node:assert/strict";
import { paneTextProblem, paneTextSha256, splitSentSuffix, withSentSuffix, verifySentEvent, briefNamedIn, briefNameProblem, briefNameUnparseable, parseBriefName, pathLikeToken, briefPathNames, resolveBriefName, expandHome, PANE_TEXT_MAX_BYTES } from "./dispatch.js";
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
  assert.equal(briefNamedIn("CLAUDE-CODE see pr222/notes.md later CLAUDE-CODE"), undefined, "a relative path not introduced by brief binds nothing (and is refused, r5 M1)");
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

test("briefNameUnparseable: nothing visibly brief-like is read as no brief (M1 r4)", () => {
  // Codex's two probes: each named no brief and no problem at 51dada16, so the pointer verified with no sealed brief.
  assert.equal(briefNameProblem("CLAUDE-CODE PR 222: brief ~other/pr222/BRIEF.md CLAUDE-CODE"), "brief_name_unparseable", "~user/ after the word brief");
  assert.equal(briefNameUnparseable("CLAUDE-CODE PR 222: brief ~other/pr222/BRIEF.md CLAUDE-CODE")?.token, "~other/pr222/BRIEF.md");
  assert.equal(briefNameProblem("CLAUDE-CODE PR 222: brief BRIEF.md CLAUDE-CODE"), "brief_name_unparseable", "a bare filename after the word brief");
  assert.equal(briefNameUnparseable("CLAUDE-CODE PR 222: brief BRIEF.md CLAUDE-CODE")?.token, "BRIEF.md");
  // The word is reserved for naming the brief, in any case and with punctuation attached; what follows must bind whole.
  for (const t of [
    "CLAUDE-CODE Brief: pr222/X.md CLAUDE-CODE", "CLAUDE-CODE BRIEF pr222/X.md CLAUDE-CODE", "CLAUDE-CODE (brief pr222/X.md) CLAUDE-CODE",
    "CLAUDE-CODE brief … x.md CLAUDE-CODE", "CLAUDE-CODE brief at pr222/X.md CLAUDE-CODE", "CLAUDE-CODE brief: `~/x/A.md` CLAUDE-CODE",
    "CLAUDE-CODE the brief is ready CLAUDE-CODE", "CLAUDE-CODE read the brief CLAUDE-CODE", "CLAUDE-CODE brief /tmp/A.md` CLAUDE-CODE",
  ]) assert.equal(briefNameProblem(t), "brief_name_unparseable", t);
  // ~user/ anywhere: ~/… binds anywhere in the text, so its unsupported sibling is never ignored.
  assert.equal(briefNameProblem("CLAUDE-CODE review per ~other/x/BRIEF.md CLAUDE-CODE"), "brief_name_unparseable");
  // A pointer names one brief: a second name, after or before, is not silently left unbound.
  assert.equal(briefNameProblem("CLAUDE-CODE brief /tmp/A.md and brief /tmp/B.md CLAUDE-CODE"), "brief_name_unparseable");
  assert.equal(briefNameProblem("CLAUDE-CODE brief pr222/A.md worktree /home/alice/wt CLAUDE-CODE"), "brief_name_unparseable");
  // Accepted at r4, refused at r5 (M1): one spelling of the word, one path-like token per text.
  assert.equal(briefNameProblem("CLAUDE-CODE Brief: /tmp/A.md sha256 12 CLAUDE-CODE"), "brief_name_unparseable", "the brief is named by the bare word brief");
  assert.equal(briefNameProblem("CLAUDE-CODE brief /tmp/A.md sha256 1 then /tmp/A.md CLAUDE-CODE"), "brief_name_unparseable", "the same path twice is a second path-like token");
  assert.equal(briefNameProblem("CLAUDE-CODE progress ~5/10 CLAUDE-CODE"), "brief_name_unparseable", "a slash or tilde token");
  assert.equal(briefNameProblem("CLAUDE-CODE see pr222/notes.md later CLAUDE-CODE"), "brief_name_unparseable", "a path without the word brief");
  // Still accepted.
  assert.equal(briefNameProblem("CLAUDE-CODE debrief at 5, briefly, briefs CLAUDE-CODE"), undefined, "debrief, briefly, briefs are other words");
});

test("parseBriefName: path candidates are found without the binder; a text binds exactly one, as brief <path>, or is refused (M1 r5)", () => {
  // Codex's round-5 probes: at 289e081d each named no brief and no problem, or bound A while B stayed visible and unsealed.
  const probes: Array<[string, string]> = [
    ["CLAUDE-CODE PR 222 r5 brief:pr222/x.md CLAUDE-CODE", "brief:pr222/x.md"],
    ["CLAUDE-CODE PR 222 r5 brief:/tmp/x.md CLAUDE-CODE", "brief:/tmp/x.md"],
    ["CLAUDE-CODE PR 222 r5 brief=pr222/x.md CLAUDE-CODE", "brief=pr222/x.md"],
    ["CLAUDE-CODE PR 222 r5 read `/tmp/A.md` first CLAUDE-CODE", "`/tmp/A.md`"],
    ["CLAUDE-CODE PR 222 r5 brief /tmp/A.md and `/tmp/B.md` CLAUDE-CODE", "`/tmp/B.md`"],
  ];
  for (const [t, token] of probes) {
    const r = parseBriefName(t);
    assert.equal(r.named, undefined, t);
    assert.equal(r.problem?.reason, "brief_name_unparseable", t);
    assert.equal(r.problem?.token, token, t);
  }
  // The real forms: a pointer with its brief, and a report line with no path.
  const pointer = `CLAUDE-CODE PR 222 r5 289e081d brief pr222/BRIEF-222-r5.md sha256 ${"0".repeat(64)} rt evt_${"a".repeat(32)} CLAUDE-CODE`;
  assert.deepEqual(parseBriefName(pointer), { named: "pr222/BRIEF-222-r5.md" });
  assert.deepEqual(parseBriefName("CLAUDE-CODE PR 222 fix round 5: brief pr222/FIX-ROUND-5-222.md sha256 05c65061f7739d2270db93153b29c8f65ed0a74b44e3017351010eef9aa60bb5 rt evt_e25ae06058aa494db2b8d7c8b3e00365 CLAUDE-CODE"), { named: "pr222/FIX-ROUND-5-222.md" }, "the round-5 pointer as the coordinator sent it");
  const report = `CLAUDE-CODE PR 222 head ${"1".repeat(40)} body-sha256 ${"2".repeat(64)} CLAUDE-CODE`;
  assert.deepEqual(parseBriefName(report), {}, "no path and no word brief: names no brief");
  assert.deepEqual(parseBriefName("CLAUDE-CODE brief brief-222/x.md CLAUDE-CODE"), { named: "brief-222/x.md" }, "a path that opens with brief is the path, not a second word");
  // A word brief that introduces no path, and an extensionless or unsupported path, are refused, never "no brief".
  for (const t of ["CLAUDE-CODE brief FIX-ROUND-5-222 CLAUDE-CODE", "CLAUDE-CODE the brief is ready CLAUDE-CODE", "CLAUDE-CODE brief ~/.retrace/x/ CLAUDE-CODE", "CLAUDE-CODE brief /tmp/A,B.md CLAUDE-CODE", "CLAUDE-CODE brief pr222\\x.md CLAUDE-CODE"])
    assert.equal(parseBriefName(t).problem?.reason, "brief_name_unparseable", t);
  // The accepted cost: prose with any other path, URL or slash token, or a file-like dotted token, is refused.
  for (const t of ["CLAUDE-CODE see https://github.com/jordandru/retrace/pull/222 CLAUDE-CODE", "CLAUDE-CODE PRs 221/222 CLAUDE-CODE", "CLAUDE-CODE and/or CLAUDE-CODE", "CLAUDE-CODE about ~240 bytes CLAUDE-CODE", "CLAUDE-CODE note v1.5 CLAUDE-CODE", "CLAUDE-CODE see retrace.dev CLAUDE-CODE"])
    assert.equal(parseBriefName(t).problem?.reason, "brief_name_unparseable", t);
  // pathLikeToken, the candidate test itself.
  for (const t of ["/tmp/A.md", "~/x", "~", "a\\b", "BRIEF.md", "BRIEF.md.", "(BRIEF.md)", "`x.md`,", "x.md~", "brief:pr222/x.md"]) assert.equal(pathLikeToken(t), true, t);
  for (const t of ["brief", "Brief:", "evt_e25ae060…", "289e081d", "round:", "5,", "(same", "sent-event", "CLAUDE-CODE", "etc."]) assert.equal(pathLikeToken(t), false, t);
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
    ["~user/ after brief, the event records no brief (r4 M1)", raw({ params: { text_sha256: await paneTextSha256("CLAUDE-CODE PR 222: brief ~other/pr222/BRIEF.md CLAUDE-CODE") } }), { text: "CLAUDE-CODE PR 222: brief ~other/pr222/BRIEF.md CLAUDE-CODE" }, "mismatch", "brief_path"],
    ["bare filename after brief, the event records no brief (r4 M1)", raw({ params: { text_sha256: await paneTextSha256("CLAUDE-CODE PR 222: brief BRIEF.md CLAUDE-CODE") } }), { text: "CLAUDE-CODE PR 222: brief BRIEF.md CLAUDE-CODE" }, "mismatch", "brief_path"],
    ["joined brief:path, the event records no brief (r5 M1)", raw({ params: { text_sha256: await paneTextSha256("CLAUDE-CODE PR 222 r5 brief:pr222/x.md CLAUDE-CODE") } }), { text: "CLAUDE-CODE PR 222 r5 brief:pr222/x.md CLAUDE-CODE" }, "mismatch", "brief_path"],
    ["a backticked path, the event records no brief (r5 M1)", raw({ params: { text_sha256: await paneTextSha256("CLAUDE-CODE PR 222 r5 read `/tmp/A.md` first CLAUDE-CODE") } }), { text: "CLAUDE-CODE PR 222 r5 read `/tmp/A.md` first CLAUDE-CODE" }, "mismatch", "brief_path"],
    ["brief A sealed, a backticked B beside it (r5 M1)", raw({ params: { text_sha256: await paneTextSha256("CLAUDE-CODE PR 222 r5 brief /tmp/A.md and `/tmp/B.md` CLAUDE-CODE"), brief_sha256: "1".repeat(64), brief_path: "/tmp/A.md" } }), { text: "CLAUDE-CODE PR 222 r5 brief /tmp/A.md and `/tmp/B.md` CLAUDE-CODE", briefSha256: "1".repeat(64), briefPresent: true }, "mismatch", "brief_path"],
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
