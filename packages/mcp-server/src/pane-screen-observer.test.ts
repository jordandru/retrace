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

function rowMetadata(
  tail: unknown[],
  wrappedRows: number[] = [],
  trailingSpaces: Record<number, number> = {},
): Array<{ wrapped: boolean; trailingSpaces: number }> {
  const wrapped = new Set(wrappedRows);
  return tail.map((_row, index) => ({
    wrapped: wrapped.has(index),
    trailingSpaces: trailingSpaces[index] ?? 0,
  }));
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

  const hostileRejection: OrcaRunner = async () => Promise.reject(Object.create(null));
  const hostileGate = await createPaneScreenObserver({ run: hostileRejection, terminal: HANDLE, layout: "codex" }).readComposerGate();
  assert.equal(hostileGate.empty, false);
  assert.equal(hostileGate.detail, "orca-ide terminal read failed: unknown error");

  for (const [label, result] of [
    ["ok false", screen(codexFrame([`› ${LINE}`]), { ok: false })],
    ["missing terminal", { code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: "" }],
    ["non-string tail", screen(["older", { toString: null }])],
    ["misaligned row metadata", screen(codexFrame([`› ${LINE}`, "• replying"]), { tailRows: [] })],
    ["malformed row metadata", screen(codexFrame([`› ${LINE}`, "• replying"]), {
      tailRows: codexFrame([`› ${LINE}`, "• replying"]).map(() => ({ wrapped: "no", trailingSpaces: -1 })),
    })],
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

  for (const malformedTerminal of [0, [], "malformed"] as const) {
    const conflicting: RunResult = {
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        result: { terminal: malformedTerminal },
        terminal: { tail: codexFrame([`› ${LINE}`, "• replying"]), source: "screen" },
      }),
      stderr: "",
    };
    const label = `malformed preferred terminal ${JSON.stringify(malformedTerminal)}`;
    const gate = await createPaneScreenObserver({
      run: runner(conflicting).run,
      terminal: HANDLE,
      layout: "codex",
    }).readComposerGate();
    assert.equal(gate.empty, false, `${label}: alternate payload cannot make the composer gate positive`);
    assert.ok(gate.evidence.error, label);

    const assessment = await createPaneScreenObserver({
      run: runner(conflicting).run,
      terminal: HANDLE,
      layout: "codex",
    }).assessPaneDelivery(LINE);
    assert.equal(assessment.delivered, "unknown", `${label}: alternate payload cannot prove delivery`);
    assert.match(assessment.reason, /^post_send_read_failed:/, label);
  }

  const liveTerminal = { tail: codexFrame([`› ${LINE}`, "• replying"]), source: "screen" };
  for (const [label, envelope] of [
    ["top-level terminal", { ok: true, terminal: liveTerminal }],
    ["direct result terminal", { ok: true, result: liveTerminal }],
  ] as const) {
    const read: RunResult = { code: 0, stdout: JSON.stringify(envelope), stderr: "" };
    const assessment = await createPaneScreenObserver({
      run: runner(read).run,
      terminal: HANDLE,
      layout: "codex",
    }).assessPaneDelivery(LINE);
    assert.equal(assessment.delivered, true, `${label}: legacy envelope shape remains supported`);
  }

  const malformedTopLevel: RunResult = {
    code: 0,
    stdout: JSON.stringify({ ok: true, terminal: null, result: liveTerminal }),
    stderr: "",
  };
  const topLevelConflict = await createPaneScreenObserver({
    run: runner(malformedTopLevel).run,
    terminal: HANDLE,
    layout: "codex",
  }).assessPaneDelivery(LINE);
  assert.equal(topLevelConflict.delivered, "unknown", "malformed selected top-level terminal cannot fall through to direct result");
  assert.match(topLevelConflict.reason, /^post_send_read_failed:/);
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

    for (const [label, altered] of [
      ["text after an extra prompt-row prefix", `${prompt}PREFIX ${LINE}`],
      ["text with a same-row suffix", `${prompt}${LINE} EXTRA`],
      ["text embedded in an ordinary output row", `output ${LINE}`],
    ] as const) {
      const alteredRead = runner(screen(frame(["older", altered, "• replying"])));
      const result = await createPaneScreenObserver({
        run: alteredRead.run,
        terminal: HANDLE,
        layout,
      }).assessPaneDelivery(LINE);
      assert.equal(result.delivered, "unknown", `${layout}: ${label}`);
      assert.equal(result.reobserve, true, `${layout}: ${label}`);
    }

    const wrapped = runner(screen(frame(["older", `${prompt}${LINE.slice(0, 30)}`, `  ${LINE.slice(30)}`, "• replying"])));
    assert.equal(
      (await createPaneScreenObserver({ run: wrapped.run, terminal: HANDLE, layout }).assessPaneDelivery(LINE)).delivered,
      true,
      `${layout}: an exact line may wrap`,
    );

    const wrappedWithSuffix = runner(screen(frame([
      "older",
      `${prompt}${LINE.slice(0, 30)}`,
      `  ${LINE.slice(30)} EXTRA`,
      "• replying",
    ])));
    assert.equal(
      (await createPaneScreenObserver({ run: wrappedWithSuffix.run, terminal: HANDLE, layout }).assessPaneDelivery(LINE)).delivered,
      "unknown",
      `${layout}: a wrapped line with a visible suffix is not the exact sent line`,
    );

    const nextRowSuffixIndented = frame([
      "older",
      `${prompt}${LINE.slice(0, 30)}`,
      `  ${LINE.slice(30)}`,
      "   EXTRA",
      "• replying",
    ]);
    assert.equal(
      (await createPaneScreenObserver({
        run: runner(screen(nextRowSuffixIndented)).run,
        terminal: HANDLE,
        layout,
      }).assessPaneDelivery(LINE)).delivered,
      "unknown",
      `${layout}: a suffix on a separate TUI continuation row is not an exact line`,
    );

    const nextRowSuffixSoft = frame([
      "older",
      `${prompt}${LINE.slice(0, 30)}`,
      LINE.slice(30),
      " EXTRA",
      "• replying",
    ]);
    assert.equal(
      (await createPaneScreenObserver({
        run: runner(screen(nextRowSuffixSoft, {
          tailRows: rowMetadata(nextRowSuffixSoft, [2, 3]),
        })).run,
        terminal: HANDLE,
        layout,
      }).assessPaneDelivery(LINE)).delivered,
      "unknown",
      `${layout}: a suffix on a separate terminal-soft-wrapped row is not an exact line`,
    );

    const earlier = runner(screen(frame(["older", `${prompt}${withSentSuffix(TEXT, `evt_${"0".repeat(32)}`)}`, "• done"])));
    const stale = await createPaneScreenObserver({ run: earlier.run, terminal: HANDLE, layout }).assessPaneDelivery(LINE);
    assert.equal(stale.delivered, "unknown", `${layout}: an earlier send is not this send`);
    assert.equal(stale.reason, "stale_prefix_only", layout);

    for (const composerLine of [`${prompt}${LINE}`, `${prompt}${TEXT.slice(0, 30)}`]) {
      const sitting = runner(screen(frame(["older"], [composerLine])));
      const result = await createPaneScreenObserver({ run: sitting.run, terminal: HANDLE, layout }).assessPaneDelivery(LINE);
      assert.equal(result.delivered, false, `${layout}: positive composer evidence`);
      assert.equal(result.reason, "line_sits_in_composer", layout);
    }

    for (const rows of [["older", `${prompt}${LINE}`], ["older", `${prompt}${LINE}`, "]"]]) {
      const noComposer = runner(screen(rows));
      const result = await createPaneScreenObserver({ run: noComposer.run, terminal: HANDLE, layout }).assessPaneDelivery(LINE);
      assert.equal(result.delivered, "unknown", `${layout}: transcript-shaped tail is not a composer`);
      assert.equal(result.reason, "composer_not_on_screen", layout);
    }

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

  const multiRowComposer = runner(screen(claudeFrame(["older"], [
    "❯ CLAUDE-CODE stand",
    `  by … [sent-event ${ID.slice(0, 18)}`,
    `  ${ID.slice(18)}]`,
  ])));
  const heldById = await createPaneScreenObserver({ run: multiRowComposer.run, terminal: HANDLE, layout: "claude" }).assessPaneDelivery(LINE);
  assert.equal(heldById.delivered, false, "Claude's later composer rows can hold the exact send id");

  const draft = runner(screen(codexFrame(["older"]), { draft: TEXT.slice(0, 50) }));
  const heldByDraft = await createPaneScreenObserver({ run: draft.run, terminal: HANDLE, layout: "codex" }).assessPaneDelivery(LINE);
  assert.equal(heldByDraft.delivered, false, "Orca draft is positive composer evidence for a known layout");
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

  const unavailableSource = runner(screen(codexFrame([`› ${LINE}`]), { source: "screen-unavailable" }));
  const unavailable = await createPaneScreenObserver({ run: unavailableSource.run, terminal: HANDLE, layout: "codex" }).assessPaneDelivery(LINE);
  assert.equal(unavailable.delivered, "unknown");
  assert.equal(unavailable.reason, "post_send_screen_unavailable: source screen-unavailable");

  const emptyScreen = runner(screen([]));
  const empty = await createPaneScreenObserver({ run: emptyScreen.run, terminal: HANDLE, layout: "codex" }).assessPaneDelivery(LINE);
  assert.equal(empty.delivered, "unknown");
  assert.equal(empty.reason, "post_send_screen_empty");

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

  const ambiguousTail = codexFrame([`› ${LINE}`, "ordinary unmarked output"]);
  const ambiguous = await createPaneScreenObserver({
    run: runner(screen(ambiguousTail, { tailRows: rowMetadata(ambiguousTail) })).run,
    terminal: HANDLE,
    layout: "codex",
  }).assessPaneDelivery(LINE);
  assert.equal(ambiguous.delivered, "unknown");
  assert.equal(ambiguous.reason, "delivery_boundary_unavailable");
  assert.equal(ambiguous.reobserve, false);

  const composerAdjacent = runner(screen(codexFrame([`› ${LINE}`])));
  assert.equal(
    (await createPaneScreenObserver({ run: composerAdjacent.run, terminal: HANDLE, layout: "codex" }).assessPaneDelivery(LINE)).delivered,
    true,
    "the recognized composer is structural termination evidence even when row metadata is absent",
  );
});

/** Render prompt + line at a terminal width. Orca drops trailing whitespace from each rendered row. */
function wrapRows(prompt: string, line: string, width: number, indent = ""): string[] {
  const rows: string[] = [];
  for (let rest = line, head = prompt; rest.length; head = indent) {
    const room = width - head.length;
    rows.push(`${head}${rest.slice(0, room)}`.replace(/\s+$/u, ""));
    rest = rest.slice(room);
  }
  return rows;
}

test("PaneScreenObserver: the exact-line proof keeps the documented 240-byte and 26-column wrap contract", async () => {
  assert.equal(PREFIX_MIN_CHARS, 24);
  const boundedText = `CLAUDE-CODE ${"review the PR at its exact head and seal the verdict ".repeat(4).slice(0, 166).trimEnd().padEnd(166, "x")} CLAUDE-CODE`;
  const boundedLine = withSentSuffix(boundedText, ID);
  const staleLine = withSentSuffix(boundedText, `evt_${"0".repeat(32)}`);
  assert.equal(Buffer.byteLength(boundedText, "utf8"), 190);
  assert.equal(Buffer.byteLength(boundedLine, "utf8"), 240);

  for (const [layout, frame, prompt] of [
    ["claude", claudeFrame, "❯ "],
    ["codex", codexFrame, "› "],
    ["grok", grokFrame, "❯ "],
  ] as const) {
    for (const width of [26, 40, 59, 80]) {
      for (const indent of ["", "  "]) {
        const exactRows = wrapRows(prompt, boundedLine, width, indent);
        const exactFrame = frame(["older", ...exactRows, "• replying"]);
        const exactMetadata = indent
          ? undefined
          : rowMetadata(exactFrame, exactRows.slice(1).map((_row, index) => index + 2));
        const fake = runner(screen(exactFrame, { tailRows: exactMetadata }));
        const result = await createPaneScreenObserver({ run: fake.run, terminal: HANDLE, layout }).assessPaneDelivery(boundedLine);
        assert.equal(result.delivered, true, `${layout}, ${width} columns${indent ? ", indented" : ""}`);

        const staleRows = wrapRows(prompt, staleLine, width, indent);
        const staleFrame = frame(["older", ...staleRows, "• replying"]);
        const staleMetadata = indent
          ? undefined
          : rowMetadata(staleFrame, staleRows.slice(1).map((_row, index) => index + 2));
        const stale = runner(screen(staleFrame, { tailRows: staleMetadata }));
        const staleResult = await createPaneScreenObserver({ run: stale.run, terminal: HANDLE, layout }).assessPaneDelivery(boundedLine);
        assert.equal(staleResult.delivered, "unknown", `${layout}, ${width} columns${indent ? ", indented" : ""}: stale id`);
      }
    }

    const corruptBoundary = wrapRows(prompt, boundedLine, 59, "  ");
    assert.ok(corruptBoundary[1]?.startsWith("  verdict"), `${layout}: fixture loses expected whitespace at the first wrap boundary`);
    corruptBoundary[1] = `  X${corruptBoundary[1]!.slice(3)}`;
    const corrupt = runner(screen(frame(["older", ...corruptBoundary, "• replying"])));
    assert.equal(
      (await createPaneScreenObserver({ run: corrupt.run, terminal: HANDLE, layout }).assessPaneDelivery(boundedLine)).delivered,
      "unknown",
      `${layout}: boundary whitespace elision does not hide a changed continuation character`,
    );
    const narrow = runner(screen(frame(["older", ...wrapRows(prompt, boundedLine, 25), "• replying"])));
    assert.equal(
      (await createPaneScreenObserver({ run: narrow.run, terminal: HANDLE, layout }).assessPaneDelivery(boundedLine)).delivered,
      "unknown",
      `${layout}, 25 columns`,
    );
  }
});

test("PaneScreenObserver: wrap-boundary whitespace may be partially elided without weakening exactness", async () => {
  const spacedLine = withSentSuffix("CLAUDE-CODE xxxxxxxxxxxx  end CLAUDE-CODE", ID);

  for (const [layout, frame, prompt] of [
    ["claude", claudeFrame, "❯ "],
    ["codex", codexFrame, "› "],
    ["grok", grokFrame, "❯ "],
  ] as const) {
    for (const indent of ["", "  "]) {
      const echo = wrapRows(prompt, spacedLine, 27, indent);
      assert.ok(echo[0]?.endsWith("x"), `${layout}: one of two expected spaces is elided at the first boundary`);
      assert.match(echo[1] ?? "", /^ {1,3}end/u, `${layout}: the other expected space remains visible`);
      const tail = frame(["older", ...echo, "• replying"]);
      const tailRows = indent
        ? undefined
        : rowMetadata(tail, echo.slice(1).map((_row, index) => index + 2), { 1: 1 });
      const assessment = await createPaneScreenObserver({
        run: runner(screen(tail, { tailRows })).run,
        terminal: HANDLE,
        layout,
      }).assessPaneDelivery(spacedLine);
      assert.equal(assessment.delivered, true, `${layout}${indent ? ", indented" : ", terminal soft-wrap"}`);
    }
  }
});
