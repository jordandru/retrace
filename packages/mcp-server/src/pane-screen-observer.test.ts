import { test } from "node:test";
import assert from "node:assert/strict";
import { withSentSuffix } from "@retrace-dev/core";
import { createPaneScreenObserver, PREFIX_MIN_CHARS, type OrcaRunner } from "./pane-screen-observer.js";

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
  options: { source?: string | null; draft?: string; ok?: boolean; tailRows?: unknown } = {},
): RunResult {
  const source = options.source === undefined ? "screen" : options.source;
  return {
    code: 0,
    stdout: JSON.stringify({
      ok: options.ok ?? true,
      result: {
        terminal: {
          tail,
          ...(options.tailRows !== undefined ? { tailRows: options.tailRows } : {}),
          ...(source === null ? {} : { source }),
          ...(options.draft ? { draft: options.draft } : {}),
        },
      },
    }),
    stderr: "",
  };
}

function rowMetadata(tail: unknown[], wrappedRows: number[] = []): Array<{ wrapped: boolean; trailingSpaces: number }> {
  const wrapped = new Set(wrappedRows);
  return tail.map((_row, index) => ({ wrapped: wrapped.has(index), trailingSpaces: 0 }));
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

test("PaneScreenObserver: composer gates use one live read and expose stable evidence for every supported layout", async () => {
  for (const [layout, frame, composerLine] of [
    ["claude", claudeFrame, "❯"],
    ["codex", codexFrame, "› Ask Codex to do anything"],
    ["grok", grokFrame, "❯"],
  ] as const) {
    const fake = runner(screen(frame(["older output"])));
    const gate = await createPaneScreenObserver({ run: fake.run, terminal: HANDLE, layout }).readComposerGate();
    assert.equal(gate.empty, true, layout);
    assert.deepEqual(gate.evidence, {
      last_line: frame(["older output"]).at(-1),
      row_count: frame(["older output"]).length,
      composer_line: composerLine,
      composer_empty: true,
      source: "screen",
    });
    assert.deepEqual(fake.calls, [["terminal", "read", "--terminal", HANDLE, "--screen", "--json"]]);
  }

  const unavailable = runner(screen(codexFrame([]), { source: null }));
  const gate = await createPaneScreenObserver({ run: unavailable.run, terminal: HANDLE, layout: "codex" }).readComposerGate();
  assert.equal(gate.empty, false);
  assert.match(gate.detail, /not a live screen \(source none\); composer "› Ask Codex to do anything"/);
});

test("PaneScreenObserver: malformed reads and preferred-envelope conflicts fail closed", async () => {
  const unused = runner(screen(codexFrame([])));
  assert.throws(
    () => createPaneScreenObserver({ run: unused.run, terminal: HANDLE, layout: "codex", emptyComposer: "[" }),
    /invalid empty composer pattern/,
  );
  assert.equal(unused.calls.length, 0);

  for (const [label, result] of [
    ["runner rejection", new Error("runner rejected")],
    ["ok false", screen(codexFrame([]), { ok: false })],
    ["missing terminal", { code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: "" }],
    ["non-string tail", screen(["older", { toString: null }])],
    ["misaligned metadata", screen(codexFrame([]), { tailRows: [] })],
    ["malformed metadata", screen(codexFrame([]), { tailRows: codexFrame([]).map(() => ({ wrapped: "no", trailingSpaces: -1 })) })],
    ["malformed JSON", { code: 0, stdout: "{", stderr: "" }],
  ] as const) {
    const fake = runner(result);
    const assessment = await createPaneScreenObserver({ run: fake.run, terminal: HANDLE, layout: "codex" }).inspectPostSend(LINE);
    assert.equal(assessment.delivered, "unknown", label);
    assert.match(assessment.reason, /^post_send_read_failed:/, label);
    assert.ok(assessment.evidence.error, label);
  }

  for (const malformedTerminal of [0, [], "malformed"] as const) {
    const conflicting: RunResult = {
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        result: { terminal: malformedTerminal },
        terminal: { tail: codexFrame([], [`› ${LINE}`]), source: "screen" },
      }),
      stderr: "",
    };
    const assessment = await createPaneScreenObserver({
      run: runner(conflicting).run,
      terminal: HANDLE,
      layout: "codex",
    }).inspectPostSend(LINE);
    assert.equal(assessment.delivered, "unknown");
    assert.match(assessment.reason, /^post_send_read_failed:/);
  }
});

test("PaneScreenObserver: known wrapped composer anchors cannot pass the empty-composer gate", async () => {
  for (const [layout, frame, anchors] of [
    ["claude", claudeFrame, [1, 2, 3]],
    ["codex", codexFrame, [1, 2]],
    ["grok", grokFrame, [1, 2, 3]],
  ] as const) {
    const tail = frame(["older"]);
    for (const anchor of anchors) {
      const gate = await createPaneScreenObserver({
        run: runner(screen(tail, { tailRows: rowMetadata(tail, [anchor]) })).run,
        terminal: HANDLE,
        layout,
      }).readComposerGate();
      assert.equal(gate.empty, false, `${layout}: wrapped anchor ${anchor}`);
    }
  }
});

test("PaneScreenObserver: positive composer evidence proves only that the unique line remains unsubmitted", async () => {
  assert.equal(PREFIX_MIN_CHARS, 24);
  for (const [layout, frame, prompt] of [
    ["claude", claudeFrame, "❯ "],
    ["codex", codexFrame, "› "],
    ["grok", grokFrame, "❯ "],
  ] as const) {
    for (const composerLine of [`${prompt}${LINE}`, `${prompt}${TEXT.slice(0, 30)}`]) {
      const assessment = await createPaneScreenObserver({
        run: runner(screen(frame(["older"], [composerLine]))).run,
        terminal: HANDLE,
        layout,
      }).inspectPostSend(LINE);
      assert.equal(assessment.delivered, false, layout);
      assert.equal(assessment.reason, "line_sits_in_composer", layout);
    }
  }

  const multiRow = await createPaneScreenObserver({
    run: runner(screen(claudeFrame(["older"], ["❯ unrelated", `  [sent-event ${ID.slice(0, 18)}`, `  ${ID.slice(18)}]`]))).run,
    terminal: HANDLE,
    layout: "claude",
  }).inspectPostSend(LINE);
  assert.equal(multiRow.delivered, false, "a sent-event id split across composer rows is still positive stuck evidence");

  const draft = await createPaneScreenObserver({
    run: runner(screen(codexFrame(["older"]), { draft: TEXT.slice(0, 40) })).run,
    terminal: HANDLE,
    layout: "codex",
  }).inspectPostSend(LINE);
  assert.equal(draft.delivered, false, "Orca draft evidence is used only after recognizing the layout's composer");
});

test("PaneScreenObserver: transcript echoes never become positive delivery evidence", async () => {
  for (const [layout, frame, prompt] of [
    ["claude", claudeFrame, "❯ "],
    ["codex", codexFrame, "› "],
    ["grok", grokFrame, "❯ "],
  ] as const) {
    for (const transcript of [
      ["older", `${prompt}${LINE}`, "• replying"],
      ["older", `${prompt}${LINE} EXTRA`, "• replying"],
      ["older", `${prompt}${LINE.slice(0, 30)}`, `  ${LINE.slice(30)}`, "• replying"],
      ["older", `${prompt}${LINE}`, "• EXTRA"],
    ]) {
      const tail = frame(transcript);
      const assessment = await createPaneScreenObserver({
        run: runner(screen(tail, { tailRows: rowMetadata(tail) })).run,
        terminal: HANDLE,
        layout,
      }).inspectPostSend(LINE);
      assert.equal(assessment.delivered, "unknown", `${layout}: ${JSON.stringify(transcript)}`);
      assert.equal(assessment.reason, "line_not_in_composer", layout);
    }
  }

  // Orca 1.4.229 filters blank rows and clears `wrapped` across the resulting gap. The exact echo plus marker below is
  // indistinguishable from an echo, a full soft-wrapped whitespace row, then a same-message suffix. It remains unknown.
  const normalized = codexFrame(["older", `› ${LINE}`, "• EXTRA"]);
  const assessment = await createPaneScreenObserver({
    run: runner(screen(normalized, { tailRows: rowMetadata(normalized) })).run,
    terminal: HANDLE,
    layout: "codex",
  }).inspectPostSend(LINE);
  assert.equal(assessment.delivered, "unknown");
});

test("PaneScreenObserver: absent composer evidence remains typed unknown", async () => {
  for (const [read, layout, expected] of [
    [screen(codexFrame([]), { source: null }), "codex", "post_send_screen_unavailable: source none"],
    [screen(codexFrame([]), { source: "screen-unavailable" }), "codex", "post_send_screen_unavailable: source screen-unavailable"],
    [screen([]), "codex", "post_send_screen_empty"],
    [screen(codexFrame([]), { draft: LINE }), "cursor", "composer_not_on_screen"],
    [screen(codexFrame([])), "codex", "sent_line_invalid"],
  ] as const) {
    const line = expected === "sent_line_invalid" ? TEXT : LINE;
    const assessment = await createPaneScreenObserver({ run: runner(read).run, terminal: HANDLE, layout }).inspectPostSend(line);
    assert.equal(assessment.delivered, "unknown");
    assert.equal(assessment.reason, expected);
  }
});

test("PaneScreenObserver: supported legacy terminal envelopes preserve only composer diagnostics", async () => {
  const tail = codexFrame([`› ${LINE}`, "• replying"]);
  const terminal = { tail, tailRows: rowMetadata(tail), source: "screen" };
  for (const envelope of [
    { ok: true, terminal },
    { ok: true, result: terminal },
  ]) {
    const assessment = await createPaneScreenObserver({
      run: runner({ code: 0, stdout: JSON.stringify(envelope), stderr: "" }).run,
      terminal: HANDLE,
      layout: "codex",
    }).inspectPostSend(LINE);
    assert.equal(assessment.delivered, "unknown");
    assert.equal(assessment.reason, "line_not_in_composer");
  }
});
