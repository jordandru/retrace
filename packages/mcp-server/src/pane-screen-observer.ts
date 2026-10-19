import { splitSentSuffix } from "@retrace-dev/core";

export type OrcaRunResult = { code: number; stdout: string; stderr: string };
export type OrcaRunner = (args: string[]) => Promise<OrcaRunResult>;

/** The empty composer row of each harness this environment runs. */
const DEFAULT_EMPTY_COMPOSER = "^(?:❯|[›»](?: Ask Codex to do anything)?)[\\s\\u00a0]*$";

/** How much of a sent line one rendered row must show before it can start a delivery proof. */
export const PREFIX_MIN_CHARS = 24;

type Composer = { top: number; lines: string[] };

type ScreenRead = {
  rows: string[];
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
  return { rows: [], lastLine: "", composerEmpty: false, error };
}

function terminalPayload(envelope: Record<string, unknown>): Record<string, unknown> | undefined {
  const result = isRecord(envelope.result) ? envelope.result : undefined;
  if (result && isRecord(result.terminal)) return result.terminal;
  if (isRecord(envelope.terminal)) return envelope.terminal;
  if (result && ("tail" in result || "source" in result || "draft" in result)) return result;
  return undefined;
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

/** Reconstruct only as many visible characters as the exact sent line contains. */
function continuationRun(body: string[], index: number, text: string, lineLength: number): string {
  let run = body[index]!.slice(Math.max(0, prefixOffset(body[index]!, text))).slice(0, lineLength);
  for (let next = index + 1; next < body.length && run.length < lineLength; next++) {
    run += body[next]!.trimStart().slice(0, lineLength - run.length);
  }
  return run;
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
    const terminal = terminalPayload(parsed);
    if (!terminal) return failedRead("orca-ide terminal read returned no terminal payload");
    if (!Array.isArray(terminal.tail) || !terminal.tail.every((line) => typeof line === "string")) {
      return failedRead("orca-ide terminal read returned a non-string tail");
    }
    if (terminal.source !== undefined && typeof terminal.source !== "string") {
      return failedRead("orca-ide terminal read returned an invalid source");
    }
    if (terminal.draft !== undefined && typeof terminal.draft !== "string") {
      return failedRead("orca-ide terminal read returned an invalid draft");
    }

    const rows = terminal.tail.map((line) => line.replace(/\s+$/u, "")).filter((line) => line.trim().length > 0);
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

    const body = read.rows.slice(0, read.composer.top);
    const prefixRows = body
      .map((row, index) => (rowShowsPrefix(row, sent.text) ? index : -1))
      .filter((index) => index >= 0);
    if (!prefixRows.length) return unknown("line_not_on_screen");
    const exactLine = prefixRows.some((index) => continuationRun(body, index, sent.text, line.length) === line);
    if (!exactLine) return unknown("stale_prefix_only");
    return { delivered: true, reobserve: false, evidence };
  };

  return { readComposerGate, assessPaneDelivery };
}
