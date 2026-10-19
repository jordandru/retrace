import { test } from "node:test";
import assert from "node:assert/strict";
import { withSentSuffix } from "@retrace-dev/core";
import {
  createPaneScreenObserver,
  PREFIX_MIN_CHARS,
  type OrcaRunner,
} from "./pane-screen-observer.js";

const HANDLE = "term_11111111-2222-3333-4444-555555555555";
const TEXT = "CLAUDE-CODE stand by for the next dispatch CLAUDE-CODE";
const ID = `evt_${"b".repeat(32)}`;
const LINE = withSentSuffix(TEXT, ID);
const RULE = "─".repeat(60);

const claudeFrame = (transcript: string[], composer: string[] = ["❯"]) => [
  ...transcript,
  RULE,
  ...composer,
  RULE,
  "  alice@host:/home/alice/provenance/retrace",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
];
const codexFrame = (transcript: string[], composer: string[] = ["› Ask Codex to do anything"]) => [
  ...transcript,
  ...composer,
  "  Daybreak Blue max · ~/orca/workspaces/retrace · Review PR 222",
  "  ? for shortcuts",
];
const grokFrame = (transcript: string[], composer: string[] = ["❯"]) => [
  ...transcript,
  `  ╭${"─".repeat(40)}╮`,
  ...composer.map((line) => `  │ ${line}`.padEnd(43) + "│"),
  `  ╰${"─".repeat(40)}╯`,
  "  Shift+Tab:mode  │  Ctrl+x:shortcuts",
];

type RunResult = Awaited<ReturnType<OrcaRunner>>;

function screen(
  tail: unknown[],
  options: { source?: string | null; draft?: string; ok?: boolean } = {},
): RunResult {
  const source = options.source === undefined ? "screen" : options.source;
  return {
    code: 0,
    stdout: JSON.stringify({
      ok: options.ok ?? true,
      result: {
        terminal: {
          tail,
          ...(source === null ? {} : { source }),
          ...(options.draft ? { draft: options.draft } : {}),
        },
      },
    }),
    stderr: "",
  };
}

function runner(...results: Array<RunResult | Error>): { run: OrcaRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      const next = results.shift();
      if (next instanceof Error) throw next;
      assert.ok(next, "test supplied one Orca result per observer read");
      return next;
    },
  };
}

test("PaneScreenObserver: composer gates use one live read and expose stable refusal evidence for every supported layout", async () => {
  for (const [layout, frame, composerLine] of [
    ["claude", claudeFrame, "❯"],
    ["codex", codexFrame, "› Ask Codex to do anything"],
    ["grok", grokFrame, "❯"],
  ] as const) {
    const fake = runner(screen(frame(["older output"])));
    const observer = createPaneScreenObserver({ run: fake.run, terminal: HANDLE, layout });
    const gate = await observer.readComposerGate();
    assert.equal(gate.empty, true, layout);
    assert.deepEqual(gate.evidence, {
      last_line: frame(["older output"]).at(-1),
      row_count: frame(["older output"]).length,
      composer_line: composerLine,
      composer_empty: true,
      source: "screen",
    });
    assert.equal(fake.calls.length, 1, `${layout}: one method call is exactly one Orca read`);
    assert.deepEqual(fake.calls[0], ["terminal", "read", "--terminal", HANDLE, "--screen", "--json"]);
  }

  const unavailable = runner(screen(codexFrame([]), { source: null }));
  const gate = await createPaneScreenObserver({ run: unavailable.run, terminal: HANDLE, layout: "codex" }).readComposerGate();
  assert.equal(gate.empty, false);
  assert.match(gate.detail, /not a live screen \(source none\); composer "› Ask Codex to do anything"/);
  assert.equal(gate.evidence.source, undefined);
  assert.equal(gate.evidence.composer_empty, false);
});

test("PaneScreenObserver: configuration and raw-read failures are total and never become positive evidence", async () => {
  const unused = runner(screen(codexFrame([])));
  assert.throws(
    () => createPaneScreenObserver({ run: unused.run, terminal: HANDLE, layout: "codex", emptyComposer: "[" }),
    /invalid empty composer pattern/,
  );
  assert.equal(unused.calls.length, 0, "configuration is validated before any read or sent-event write");

  const rejected = runner(new Error("runner rejected"));
  const rejectedGate = await createPaneScreenObserver({ run: rejected.run, terminal: HANDLE, layout: "codex" }).readComposerGate();
  assert.equal(rejectedGate.empty, false);
  assert.match(rejectedGate.detail, /orca-ide terminal read failed: runner rejected/);
  assert.match(rejectedGate.evidence.error ?? "", /runner rejected/);

  for (const [label, result] of [
    ["ok false", screen(codexFrame([`› ${LINE}`]), { ok: false })],
    ["missing terminal", { code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: "" }],
    ["non-string tail", screen(["older", { toString: null }])],
    ["malformed JSON", { code: 0, stdout: "{", stderr: "" }],
  ] as const) {
    const fake = runner(result);
    const assessment = await createPaneScreenObserver({ run: fake.run, terminal: HANDLE, layout: "codex" }).assessPaneDelivery(LINE);
    assert.equal(assessment.delivered, "unknown", label);
    assert.match(assessment.reason, /^post_send_read_failed:/, label);
    assert.equal(assessment.reobserve, false, label);
    assert.ok(assessment.evidence.error, label);
    assert.equal(fake.calls.length, 1, label);
  }
});

test("PaneScreenObserver: delivery requires the exact suffixed line above a recognized live composer", async () => {
  for (const [layout, frame, prompt] of [
    ["claude", claudeFrame, "❯ "],
    ["codex", codexFrame, "› "],
    ["grok", grokFrame, "❯ "],
  ] as const) {
    const exact = runner(screen(frame(["older", `${prompt}${LINE}`, "• replying"])));
    const delivered = await createPaneScreenObserver({ run: exact.run, terminal: HANDLE, layout }).assessPaneDelivery(LINE);
    assert.equal(delivered.delivered, true, layout);
    assert.equal(delivered.reobserve, false, layout);
    assert.equal(delivered.evidence.source, "screen", layout);

    const wrapped = runner(screen(frame(["older", `${prompt}${LINE.slice(0, 30)}`, `  ${LINE.slice(30)}`, "• replying"])));
    assert.equal(
      (await createPaneScreenObserver({ run: wrapped.run, terminal: HANDLE, layout }).assessPaneDelivery(LINE)).delivered,
      true,
      `${layout}: an exact line may wrap`,
    );

    const corruptedLine = `${TEXT.slice(0, 40)}${"x".repeat(TEXT.length - 40)} [sent-event ${ID}]`;
    const corrupted = runner(screen(frame(["older", `${prompt}${corruptedLine}`, "• replying"])));
    assert.deepEqual(
      (({ evidence: _evidence, ...decision }) => decision)(
        await createPaneScreenObserver({ run: corrupted.run, terminal: HANDLE, layout }).assessPaneDelivery(LINE),
      ),
      { delivered: "unknown", reason: "stale_prefix_only", reobserve: true },
      `${layout}: matching prefix plus current id is not the exact sent line`,
    );

    const unrelated = runner(screen(frame(["older", `${prompt}${TEXT.slice(0, 30)}`, `• unrelated ${ID}`, "• replying"])));
    assert.deepEqual(
      (({ evidence: _evidence, ...decision }) => decision)(
        await createPaneScreenObserver({ run: unrelated.run, terminal: HANDLE, layout }).assessPaneDelivery(LINE),
      ),
      { delivered: "unknown", reason: "stale_prefix_only", reobserve: true },
      `${layout}: a nearby id in unrelated output is not delivery evidence`,
    );
  }
});

test("PaneScreenObserver: false needs recognized live composer evidence; insufficient evidence is typed unknown", async () => {
  const sitting = runner(screen(codexFrame(["older"], [`› ${LINE}`])));
  const stuck = await createPaneScreenObserver({ run: sitting.run, terminal: HANDLE, layout: "codex" }).assessPaneDelivery(LINE);
  assert.equal(stuck.delivered, false);
  assert.equal(stuck.reason, "line_sits_in_composer");
  assert.equal(stuck.reobserve, false);
  assert.equal(stuck.evidence.composer_line, `› ${LINE}`);

  const missingSource = runner(screen(codexFrame([`› ${LINE}`, "• replying"]), { source: null }));
  const absent = await createPaneScreenObserver({ run: missingSource.run, terminal: HANDLE, layout: "codex" }).assessPaneDelivery(LINE);
  assert.equal(absent.delivered, "unknown");
  assert.equal(absent.reason, "post_send_screen_unavailable: source none");
  assert.equal(absent.reobserve, false);

  const unknownLayout = runner(screen(codexFrame([]), { draft: LINE }));
  const unknown = await createPaneScreenObserver({ run: unknownLayout.run, terminal: HANDLE, layout: "cursor" }).assessPaneDelivery(LINE);
  assert.equal(unknown.delivered, "unknown");
  assert.equal(unknown.reason, "composer_not_on_screen");
  assert.equal(unknown.reobserve, true);

  const lag = runner(screen(codexFrame([])));
  const notVisible = await createPaneScreenObserver({ run: lag.run, terminal: HANDLE, layout: "codex" }).assessPaneDelivery(LINE);
  assert.equal(notVisible.delivered, "unknown");
  assert.equal(notVisible.reason, "line_not_on_screen");
  assert.equal(notVisible.reobserve, true);

  const invalidLine = runner(screen(codexFrame([])));
  const invalid = await createPaneScreenObserver({ run: invalidLine.run, terminal: HANDLE, layout: "codex" }).assessPaneDelivery(TEXT);
  assert.equal(invalid.delivered, "unknown");
  assert.equal(invalid.reason, "sent_line_invalid");
  assert.equal(invalid.reobserve, false);
  assert.equal(invalidLine.calls.length, 1, "even an invalid classification input consumes exactly one observation");
});

test("PaneScreenObserver: the exact-line proof keeps the documented 26-column lower bound", async () => {
  assert.equal(PREFIX_MIN_CHARS, 24);
  // Use non-repeating, non-whitespace characters so Orca's trailing-whitespace normalization does not erase a
  // character at a wrap boundary and no continuation row can masquerade as the line's prefix.
  const boundedText = Array.from({ length: 100 }, (_unused, index) => String.fromCodePoint(0x400 + index)).join("");
  const boundedLine = withSentSuffix(boundedText, ID);
  const wrapped = (width: number): string[] => {
    const rows: string[] = [];
    for (let rest = boundedLine, prompt = "› "; rest.length; prompt = "") {
      const room = width - prompt.length;
      rows.push(`${prompt}${rest.slice(0, room)}`);
      rest = rest.slice(room);
    }
    return rows;
  };
  for (const width of [26, 40, 59, 80]) {
    const fake = runner(screen(codexFrame(["older", ...wrapped(width), "• replying"])));
    const result = await createPaneScreenObserver({ run: fake.run, terminal: HANDLE, layout: "codex" }).assessPaneDelivery(boundedLine);
    assert.equal(result.delivered, true, `${width} columns`);
  }
  const narrow = runner(screen(codexFrame(["older", ...wrapped(25), "• replying"])));
  assert.equal(
    (await createPaneScreenObserver({ run: narrow.run, terminal: HANDLE, layout: "codex" }).assessPaneDelivery(boundedLine)).delivered,
    "unknown",
  );
});
