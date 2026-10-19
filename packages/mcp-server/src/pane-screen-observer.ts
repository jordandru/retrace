import { splitSentSuffix } from "@retrace-dev/core";

export type OrcaRunResult = { code: number; stdout: string; stderr: string };
export type OrcaRunner = (args: string[]) => Promise<OrcaRunResult>;

/** The empty composer row of each harness this environment runs. */
const DEFAULT_EMPTY_COMPOSER = "^(?:❯|[›»](?: Ask Codex to do anything)?)[\\s\\u00a0]*$";

/** How much of a sent line one rendered row must show before it can start a delivery proof. */
export const PREFIX_MIN_CHARS = 24;

type Composer = { top: number; lines: string[] };

type RowMetadata = {
  wrapped: boolean;
  trailingSpaces: number;
};

type RenderedRow = RowMetadata & {
  text: string;
  rawIndex: number;
  metadataAvailable: boolean;
};

type ScreenRead = {
  rows: string[];
  renderedRows: RenderedRow[];
  lastLine: string;
  composer?: Composer;
  draft?: string;
  source?: string;
  error?: string;
  composerEmpty: boolean;
};

export type PaneScreenEvidence = {
  last_line: string;
  row_count: number;
  composer_line?: string;
  composer_empty: boolean;
  draft?: string;
  source?: string;
  error?: string;
};

export type ComposerGateRead =
  | { empty: true; evidence: PaneScreenEvidence }
  | { empty: false; detail: string; evidence: PaneScreenEvidence };

export type PaneDeliveryAssessment =
  | { delivered: true; reobserve: false; evidence: PaneScreenEvidence }
  | { delivered: false; reason: string; reobserve: false; evidence: PaneScreenEvidence }
  | { delivered: "unknown"; reason: string; reobserve: boolean; evidence: PaneScreenEvidence };

export type PaneScreenObserver = {
  /** Read the pane once and decide whether the live harness composer is empty. */
  readComposerGate(): Promise<ComposerGateRead>;
  /** Read the pane once and assess evidence for the exact suffixed line supplied to Orca. */
  assessPaneDelivery(line: string): Promise<PaneDeliveryAssessment>;
};

export type PaneScreenObserverOptions = {
  run: OrcaRunner;
  terminal: string;
  /** Orca's verified agentIdentity. Unknown layouts deliberately have no adapter. */
  layout?: string;
  emptyComposer?: string;
};

const RULE_ROW_RE = /^─{8,}$/u;
const PROMPT_ROW_RE = /^❯(?:[\s\u00a0]|$)/u;
const CODEX_PROMPT_ROW_RE = /^[›»](?:[\s\u00a0]|$)/u;
const BOX_TOP_RE = /^\s*╭─/u;
const BOX_BOTTOM_RE = /^\s*╰─/u;
const TRANSCRIPT_BLOCK_START_RE = /^(?:[•●◦○✻✳◆◇◈](?:[\t \u00a0]|$)|[›»❯](?:[\t \u00a0]|$))/u;

function composerOf(rows: string[], layout: string | undefined): Composer | undefined {
  if (layout === "claude") {
    const rules = rows.flatMap((row, index) => (RULE_ROW_RE.test(row.trim()) ? [index] : []));
    const [top, bottom] = rules.slice(-2);
    if (top === undefined || bottom === undefined || bottom - top < 2 || !PROMPT_ROW_RE.test(rows[top + 1]!)) return undefined;
    return { top, lines: rows.slice(top + 1, bottom) };
  }
  if (layout === "codex") {
    let index = rows.length - 1;
    while (index >= 0 && /^[\s\u00a0]/u.test(rows[index]!)) index--;
    if (index < 0 || index === rows.length - 1 || !CODEX_PROMPT_ROW_RE.test(rows[index]!)) return undefined;
    return { top: index, lines: [rows[index]!] };
  }
  if (layout === "grok") {
    let top = -1;
    for (let index = rows.length - 1; index >= 0 && top < 0; index--) {
      if (BOX_TOP_RE.test(rows[index]!)) top = index;
    }
    const bottom = top < 0 ? -1 : rows.findIndex((row, index) => index > top && BOX_BOTTOM_RE.test(row));
    if (top < 0 || bottom < 0 || bottom - top < 2) return undefined;
    const lines = rows
      .slice(top + 1, bottom)
      .map((row) => row.replace(/^\s*│[\s\u00a0]?/u, "").replace(/[\s\u00a0]*│$/u, ""));
    if (!PROMPT_ROW_RE.test(lines[0]!)) return undefined;
    return { top, lines };
  }
  return undefined;
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return String(value);
  } catch {
    return "unknown error";
  }
}

function failedRead(error: string): ScreenRead {
  return { rows: [], renderedRows: [], lastLine: "", composerEmpty: false, error };
}

type TerminalPayloadSelection =
  | { found: false }
  | { found: true; value: unknown };

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function terminalPayload(envelope: Record<string, unknown>): TerminalPayloadSelection {
  const result = isRecord(envelope.result) ? envelope.result : undefined;
  // Choose one legacy envelope shape by field presence before validating it. A malformed preferred shape must not
  // fall through to a second, valid-looking payload and become positive screen evidence.
  if (result && hasOwn(result, "terminal")) return { found: true, value: result.terminal };
  if (hasOwn(envelope, "terminal")) return { found: true, value: envelope.terminal };
  if (result && ["tail", "source", "draft"].some((key) => hasOwn(result, key))) {
    return { found: true, value: result };
  }
  return { found: false };
}

function evidenceOf(read: ScreenRead): PaneScreenEvidence {
  return {
    last_line: read.lastLine,
    row_count: read.rows.length,
    ...(read.composer ? { composer_line: read.composer.lines[0]! } : {}),
    composer_empty: read.composerEmpty,
    ...(read.draft !== undefined ? { draft: read.draft } : {}),
    ...(read.source !== undefined ? { source: read.source } : {}),
    ...(read.error !== undefined ? { error: read.error } : {}),
  };
}

function composerDetail(read: ScreenRead, layout: string | undefined): string {
  if (read.error) return read.error;
  const live = read.source === "screen" ? "" : `not a live screen (source ${read.source ?? "none"}); `;
  const seen = read.composer
    ? `composer ${JSON.stringify(read.composer.lines[0]!)}`
    : `no ${layout ?? "known"} composer on screen (last line ${JSON.stringify(read.lastLine)})`;
  return `${live}${seen}${read.draft ? ` draft ${JSON.stringify(read.draft)}` : ""}`;
}

function prefixOffset(row: string, text: string): number {
  const exactPrefix = row.indexOf(text.slice(0, 40));
  if (exactPrefix >= 0) return exactPrefix;
  for (let length = Math.min(text.length, 120); length >= PREFIX_MIN_CHARS; length--) {
    if (row.endsWith(text.slice(0, length))) return row.length - length;
  }
  return -1;
}

function rowShowsPrefix(row: string, text: string): boolean {
  return prefixOffset(row, text) >= 0;
}

function transcriptStartContent(row: string, line: string, layout: string | undefined): string | undefined {
  const prompt = layout === "codex"
    ? row.match(/^[›»][\t \u00a0]+/u)
    : layout === "claude" || layout === "grok"
      ? row.match(/^❯[\t \u00a0]+/u)
      : undefined;
  const content = prompt ? row.slice(prompt[0].length) : row;
  const required = Math.min(PREFIX_MIN_CHARS, line.length);
  if (content.length < required || content.slice(0, required) !== line.slice(0, required)) return undefined;
  return content;
}

function boundaryPositions(line: string, positions: Set<number>): Set<number> {
  const expanded = new Set(positions);
  for (const position of positions) {
    let afterWhitespace = position;
    while (afterWhitespace < line.length && /^[\t \u00a0]$/u.test(line[afterWhitespace]!)) {
      afterWhitespace++;
      expanded.add(afterWhitespace);
    }
  }
  return expanded;
}

function advancePositions(line: string, positions: Set<number>, fragment: string): Set<number> {
  const advanced = new Set<number>();
  if (!fragment.length) return advanced;
  for (const position of positions) {
    if (line.startsWith(fragment, position)) advanced.add(position + fragment.length);
  }
  return advanced;
}

type WrappedLineMatch = "exact" | "not_exact" | "boundary_unknown";

type CompletionEvidence = "exact" | "continues" | "unknown";

function completionEvidence(
  body: RenderedRow[],
  completedAt: number,
  indent: "" | "  ",
): CompletionEvidence {
  const current = body[completedAt]!;
  const next = body[completedAt + 1];
  if (!next) return "exact";
  if (next.rawIndex !== current.rawIndex + 1) return "unknown";

  // Orca defines `wrapped` on the following row: true means it continues this terminal-emulator line.
  if (next.metadataAvailable && next.wrapped) return "continues";

  // Agent TUIs paint their own continuation rows. The supported layouts indent those rows by two columns and begin a
  // new transcript block with a stable prompt/status glyph. Text with neither shape has no provable message boundary.
  if (indent && next.text.startsWith(indent)) return "continues";
  if (TRANSCRIPT_BLOCK_START_RE.test(next.text)) return "exact";
  return "unknown";
}

/**
 * Match a rendered transcript line against the exact line supplied to Orca. The first fragment is anchored at column
 * zero or immediately after this layout's prompt. Terminal-emulator continuations require Orca's `wrapped` metadata;
 * TUI-painted continuations require the measured two-space indent. Orca removes trailing row whitespace, so only
 * horizontal whitespace already present in `line` may disappear at a row boundary. Every visible fragment is compared
 * whole, and completion requires a structural boundary: visible prefixes and suffixes are never truncated away.
 */
function matchesWrappedLine(
  body: RenderedRow[],
  index: number,
  line: string,
  layout: string | undefined,
): WrappedLineMatch {
  const first = transcriptStartContent(body[index]!.text, line, layout);
  if (first === undefined) return "not_exact";

  let boundaryUnknown = false;

  for (const indent of ["", "  "] as const) {
    let positions = advancePositions(line, new Set([0]), first);
    if (positions.has(line.length)) {
      const completion = completionEvidence(body, index, indent);
      if (completion === "exact") return "exact";
      if (completion === "unknown") {
        boundaryUnknown = true;
        continue;
      }
    }

    for (let next = index + 1; next < body.length && positions.size; next++) {
      const row = body[next]!;
      const previous = body[next - 1]!;
      if (row.rawIndex !== previous.rawIndex + 1) break;
      if (indent) {
        if ((row.metadataAvailable && row.wrapped) || !row.text.startsWith(indent)) break;
      } else {
        if (!row.metadataAvailable || !row.wrapped) break;
      }
      const fragment = indent ? row.text.slice(indent.length) : row.text;
      positions = advancePositions(line, boundaryPositions(line, positions), fragment);
      if (positions.has(line.length)) {
        const completion = completionEvidence(body, next, indent);
        if (completion === "exact") return "exact";
        if (completion === "unknown") {
          boundaryUnknown = true;
          break;
        }
      }
    }
  }
  return boundaryUnknown ? "boundary_unknown" : "not_exact";
}

function composerHolds(lines: string[], text: string, sentEventId: string): boolean {
  return lines.some((line) => rowShowsPrefix(line, text)) || lines.map((line) => line.trimStart()).join("").includes(sentEventId);
}

function shouldReobserveDelivery(reason: string): boolean {
  return reason === "line_not_on_screen" || reason === "stale_prefix_only" || reason === "composer_not_on_screen";
}

export function createPaneScreenObserver(options: PaneScreenObserverOptions): PaneScreenObserver {
  let emptyComposer: RegExp;
  try {
    emptyComposer = new RegExp(options.emptyComposer ?? DEFAULT_EMPTY_COMPOSER, "u");
  } catch (error) {
    throw new TypeError(`invalid empty composer pattern: ${errorMessage(error)}`);
  }

  const readScreen = async (): Promise<ScreenRead> => {
    let result: OrcaRunResult;
    try {
      result = await options.run(["terminal", "read", "--terminal", options.terminal, "--screen", "--json"]);
    } catch (error) {
      return failedRead(`orca-ide terminal read failed: ${errorMessage(error)}`);
    }

    const parsed = parseJson(result.stdout);
    if (result.code !== 0) {
      return failedRead(`orca-ide terminal read exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
    }
    if (!isRecord(parsed)) return failedRead("orca-ide terminal read returned invalid JSON");
    if (parsed.ok === false) return failedRead("orca-ide terminal read returned ok false");
    const selected = terminalPayload(parsed);
    if (!selected.found) return failedRead("orca-ide terminal read returned no terminal payload");
    if (!isRecord(selected.value)) return failedRead("orca-ide terminal read returned an invalid terminal payload");
    const terminal = selected.value;
    if (!Array.isArray(terminal.tail) || !terminal.tail.every((line) => typeof line === "string")) {
      return failedRead("orca-ide terminal read returned a non-string tail");
    }
    if (terminal.source !== undefined && typeof terminal.source !== "string") {
      return failedRead("orca-ide terminal read returned an invalid source");
    }
    if (terminal.draft !== undefined && typeof terminal.draft !== "string") {
      return failedRead("orca-ide terminal read returned an invalid draft");
    }

    let metadata: RowMetadata[] | undefined;
    if (terminal.tailRows !== undefined) {
      if (!Array.isArray(terminal.tailRows)
        || terminal.tailRows.length !== terminal.tail.length
        || !terminal.tailRows.every((value) => isRecord(value)
          && typeof value.wrapped === "boolean"
          && Number.isSafeInteger(value.trailingSpaces)
          && Number(value.trailingSpaces) >= 0)) {
        return failedRead("orca-ide terminal read returned invalid row metadata");
      }
      metadata = terminal.tailRows.map((value) => ({
        wrapped: (value as Record<string, unknown>).wrapped as boolean,
        trailingSpaces: Number((value as Record<string, unknown>).trailingSpaces),
      }));
    }

    const renderedRows = terminal.tail
      .map((line, rawIndex): RenderedRow => ({
        text: line.replace(/\s+$/u, ""),
        rawIndex,
        metadataAvailable: metadata !== undefined,
        wrapped: metadata?.[rawIndex]?.wrapped ?? false,
        trailingSpaces: metadata?.[rawIndex]?.trailingSpaces ?? 0,
      }))
      .filter((row) => row.text.trim().length > 0);
    const rows = renderedRows.map((row) => row.text);
    const lastLine = rows.at(-1) ?? "";
    const source = terminal.source as string | undefined;
    const draft = typeof terminal.draft === "string" && terminal.draft.length ? terminal.draft : undefined;
    const composer = composerOf(rows, options.layout);
    const composerEmpty = source === "screen"
      && composer !== undefined
      && composer.lines.length === 1
      && emptyComposer.test(composer.lines[0]!)
      && draft === undefined;
    return {
      rows,
      renderedRows,
      lastLine,
      ...(composer ? { composer } : {}),
      ...(draft !== undefined ? { draft } : {}),
      ...(source !== undefined ? { source } : {}),
      composerEmpty,
    };
  };

  const readComposerGate = async (): Promise<ComposerGateRead> => {
    const read = await readScreen();
    const evidence = evidenceOf(read);
    return read.composerEmpty
      ? { empty: true, evidence }
      : { empty: false, detail: composerDetail(read, options.layout), evidence };
  };

  const assessPaneDelivery = async (line: string): Promise<PaneDeliveryAssessment> => {
    const read = await readScreen();
    const evidence = evidenceOf(read);
    const unknown = (reason: string): PaneDeliveryAssessment => ({
      delivered: "unknown",
      reason,
      reobserve: shouldReobserveDelivery(reason),
      evidence,
    });

    if (read.error) return unknown(`post_send_read_failed: ${read.error}`);
    if (read.source !== "screen") return unknown(`post_send_screen_unavailable: source ${read.source ?? "none"}`);
    if (!read.rows.length) return unknown("post_send_screen_empty");

    const sent = splitSentSuffix(line);
    if (!sent) return unknown("sent_line_invalid");
    // Resolve a known layout before draft inspection. A draft from an unknown harness has no trusted composer meaning.
    if (!read.composer) return unknown("composer_not_on_screen");
    if (read.draft !== undefined && composerHolds([read.draft], sent.text, sent.sentEventId)) {
      return { delivered: false, reason: "line_sits_in_composer", reobserve: false, evidence };
    }
    if (composerHolds(read.composer.lines, sent.text, sent.sentEventId)) {
      return { delivered: false, reason: "line_sits_in_composer", reobserve: false, evidence };
    }

    const body = read.renderedRows.slice(0, read.composer.top);
    const prefixRows = body
      .map((row, index) => (transcriptStartContent(row.text, line, options.layout) !== undefined ? index : -1))
      .filter((index) => index >= 0);
    if (!prefixRows.length) return unknown("line_not_on_screen");
    const matches = prefixRows.map((index) => matchesWrappedLine(body, index, line, options.layout));
    if (!matches.includes("exact")) {
      return unknown(matches.includes("boundary_unknown") ? "delivery_boundary_unavailable" : "stale_prefix_only");
    }
    return { delivered: true, reobserve: false, evidence };
  };

  return { readComposerGate, assessPaneDelivery };
}
