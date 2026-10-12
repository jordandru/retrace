/**
 * Agent-to-agent pane messages — the pure half of agent-rules 15 / agent-ops 18.
 *
 * A pane message is ONE line: `SEAT <text> SEAT` where SEAT is the sender's pinned actor id upper-cased. The sender logs a
 * `sent` event carrying the sha256 of exactly those bytes (no suffix, no trailing newline), then sends the line with
 * ` [sent-event <id>]` appended. The receiver strips exactly that suffix, hashes the rest and reads the named event raw.
 * Nothing here does IO: the MCP tools (`retrace_send`, `retrace_verify_send` in packages/mcp-server) own the credential,
 * the terminal and the ledger; this module owns the byte rules and the checks, so both ends compute the same thing
 * and a test can prove it without a Worker.
 */
import { posix } from "node:path";
import { sha256Hex } from "./chain.js";
import type { Event } from "./schema.js";

/** The suffix is a single space, then `[sent-event evt_<32 hex>]`, and nothing after it. */
export const SENT_EVENT_SUFFIX_RE = /^(.*) \[sent-event (evt_[0-9a-f]{32})\]$/;
/** Whole line including the suffix (agent-ops 18: Cursor folds a longer paste so the reader sees nothing). */
export const PANE_MESSAGE_MAX_BYTES = 240;
/** ` [sent-event evt_<32 hex>]` is 50 bytes, so the text before it is at most 190. */
export const PANE_TEXT_MAX_BYTES = 190;
/** The owner's envelope (docs/owner-protocol.md §1) is never used by an agent (§5, the hard guard). A message that
 *  carries an enveloped span `JD … JD` is refused before it is hashed, so the ledger never records an agent sending
 *  one. A lone `JD` token (a message that talks about the envelope) is not an envelope (Codex, PR 222 r1, L2). */
const OWNER_ENVELOPE_SPAN = /(^|\s)JD\s[\s\S]*?\sJD(\s|$)/;
/**
 * A pane text that names a brief, in one of the three forms the coordinator uses (Codex, PR 222 r2, H1):
 *   `~/.retrace/ops-2026-10-11/pr222/BRIEF.md`   (home-relative)
 *   `/home/x/.retrace/ops-2026-10-11/pr222/BRIEF.md`   (absolute)
 *   `brief pr222/BRIEF-222-r2.md`   (relative to one `~/.retrace/ops-*` directory; only after the word `brief`)
 * The optional word `brief` may precede the first two forms as well.
 */
const BRIEF_NAMED = /(?:^|\s)(?:brief\s+)?((?:~\/|\/)[^\s`"'<>]+)|(?:^|\s)brief\s+((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)/;
/** Where a relative brief name resolves: `<home>/.retrace/ops-<something>/<name>`. */
const OPS_DIR_RE = /^\.retrace\/ops-[^/]+\//;

export function seatEnvelope(actorId: string): string {
  return actorId.toUpperCase();
}

/** Why a candidate pane text cannot be sent, or undefined when it can. Each reason is a stable word for the refusal record. */
export function paneTextProblem(text: string, seatId: string): string | undefined {
  if (typeof text !== "string" || text.length === 0) return "empty";
  if (/[\r\n]/.test(text)) return "multi_line";
  if (text !== text.trimEnd()) return "trailing_whitespace";
  if (text !== text.trimStart()) return "leading_whitespace";
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > PANE_TEXT_MAX_BYTES) return `too_long:${bytes}>${PANE_TEXT_MAX_BYTES}`;
  const seat = seatEnvelope(seatId);
  if (!text.startsWith(`${seat} `) || !text.endsWith(` ${seat}`) || text.length < seat.length * 2 + 3) return "envelope_missing";
  if (OWNER_ENVELOPE_SPAN.test(text)) return "owner_envelope_forbidden";
  if (/\[sent-event /.test(text)) return "suffix_in_text";
  return undefined;
}

/** The brief name a pane text carries, if any, exactly as written (`~/…`, `/…`, or the relative form after `brief`).
 *  A text that names a brief must be bound to that brief on both sides (Codex, PR 222 r1 H3, r2 H1): otherwise the
 *  instruction body is replaceable after the pointer is signed. */
export function briefNamedIn(text: string): string | undefined {
  const m = BRIEF_NAMED.exec(text);
  return m ? (m[1] ?? m[2]) : undefined;
}

/** `~` and `~/x` expanded against `homeDir`; `.`/`..` segments normalised; nothing else changed. */
export function expandHome(p: string, homeDir: string): string {
  const expanded = p === "~" ? homeDir : p.startsWith("~/") ? `${homeDir}${p.slice(1)}` : p;
  return posix.normalize(expanded);
}

/**
 * Does `briefPath` (as the sender passed it or the event recorded it) denote the brief the text names? Absolute and
 * home-relative names must resolve to the same path; the relative form must be the tail of `<home>/.retrace/ops-<something>/`.
 * Both sides use this one rule, so a pointer naming A can never be bound to a file B (Codex, PR 222 r2, H1).
 */
export function briefPathNames(briefPath: string, named: string, homeDir: string): boolean {
  const b = expandHome(briefPath, homeDir);
  if (named.startsWith("~/") || named.startsWith("/")) return b === expandHome(named, homeDir);
  const home = posix.normalize(homeDir);
  if (!b.startsWith(`${home}/`)) return false;
  const rel = b.slice(home.length + 1);
  const m = OPS_DIR_RE.exec(rel);
  return m !== null && rel.slice(m[0].length) === posix.normalize(named);
}

/** The absolute path a brief name denotes. A relative name resolves only through the event's own `brief_path`
 *  (the sender said which ops directory); undefined when it cannot be resolved. */
export function resolveBriefName(named: string, homeDir: string, eventBriefPath?: string): string | undefined {
  if (named.startsWith("~/") || named.startsWith("/")) return expandHome(named, homeDir);
  return eventBriefPath !== undefined && briefPathNames(eventBriefPath, named, homeDir) ? expandHome(eventBriefPath, homeDir) : undefined;
}

/** sha256 of the exact UTF-8 bytes of the pre-suffix line. */
export async function paneTextSha256(text: string): Promise<string> {
  return sha256Hex(text);
}

export function withSentSuffix(text: string, sentEventId: string): string {
  return `${text} [sent-event ${sentEventId}]`;
}

/** Split a received line into the hashed text and the cited event id; undefined when the suffix is absent or malformed. */
export function splitSentSuffix(received: string): { text: string; sentEventId: string } | undefined {
  // The suffix is the final bytes of the line: nothing after it, not even a newline (Codex, PR 222 r1, L1).
  const m = SENT_EVENT_SUFFIX_RE.exec(received);
  if (!m) return undefined;
  return { text: m[1]!, sentEventId: m[2]! };
}

export type SentSignature = "verified" | "missing" | "mismatch" | "unverifiable";
export type SentCheck = { ok: boolean; detail: string };
export type SentVerification = {
  signature: SentSignature;
  sent_event_id?: string;
  sender?: string;
  checks: Record<string, SentCheck>;
  /** The first failing check's name, for the `received` record. */
  failure?: string;
};

/** What the verifying side knows about itself and the brief it read. */
export type SentExpectation = {
  /** The received line with the suffix removed. */
  text: string;
  sentEventId: string;
  /** The verifying seat (the MCP server's actor id) and its own terminal handle, when the host told it (Codex, PR 222 r2, H2). */
  receiver: { seat: string; terminal?: string };
  /** For resolving `~/` and the relative brief form. */
  homeDir: string;
  /** sha256 of the brief the receiver read, when it read one. */
  briefSha256?: string;
  /** The receiver passed a brief path (whether or not it could be read). */
  briefPresent?: boolean;
  /** The brief path the receiver passed, as given. */
  briefPath?: string;
  /** Why the brief could not be read (EISDIR, ENOENT, …). */
  briefReadError?: string;
  /** Why the event could not be read. */
  readError?: string;
};

function paramsOf(e: Pick<Event, "method">): Record<string, unknown> {
  const p = e.method?.params;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

/**
 * The checks of agent-rules 15 over a raw event, plus the envelope on the received text, the receiver binding and the
 * brief binding. `raw` is what `GET /events/<id>` returned (or null when it does not exist / could not be read).
 */
export async function verifySentEvent(raw: Event | null | undefined, expect: SentExpectation): Promise<SentVerification> {
  const checks: Record<string, SentCheck> = {};
  const unverifiable = new Set<string>();
  const envelope = /^([A-Z][A-Z0-9_-]+) .* \1$/.exec(expect.text);
  checks.envelope = envelope
    ? { ok: true, detail: `text starts and ends with ${envelope[1]}` }
    : { ok: false, detail: "text does not start and end with the same SEAT marker" };
  const seat = envelope ? envelope[1]!.toLowerCase() : undefined;
  if (!raw) {
    checks.exists = { ok: false, detail: expect.readError ? `could not read ${expect.sentEventId}: ${expect.readError}` : `${expect.sentEventId} does not exist` };
    return { signature: "unverifiable", sent_event_id: expect.sentEventId, sender: seat, checks, failure: "exists" };
  }
  checks.exists = { ok: true, detail: `${raw.id} seq ${raw.seq}` };
  const p = paramsOf(raw);
  checks.action = raw.action === "sent" ? { ok: true, detail: "sent" } : { ok: false, detail: `action is ${raw.action}, not sent` };
  checks.actor = seat && raw.actor.type === "agent" && raw.actor.id === seat
    ? { ok: true, detail: `agent/${raw.actor.id}` }
    : { ok: false, detail: `event actor ${raw.actor.type}/${raw.actor.id} is not the envelope's seat ${seat ?? "(none)"}` };
  const sealedBy = typeof p.sealed_by === "string" ? p.sealed_by : "";
  // `pinned:<credential name>`, and that credential is the envelope's seat: the name carries the seat id as a word
  // ("claude-code MCP (pinned) (signing)", "codex (signing)", "Grok MCP (pinned) (signing)"). A pinned seal of another
  // seat is not this seat's (Codex, PR 222 r1, M3).
  const credentialName = sealedBy.startsWith("pinned:") ? sealedBy.slice("pinned:".length).trim() : undefined;
  const namesSeat = credentialName !== undefined && seat !== undefined
    && new RegExp(`(^|[^a-z0-9-])${seat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9-]|$)`, "i").test(credentialName);
  checks.sealed_by = credentialName === undefined
    ? { ok: false, detail: `sealed_by is ${sealedBy || "(absent)"}, not pinned:` }
    : namesSeat
      ? { ok: true, detail: sealedBy }
      : { ok: false, detail: `sealed_by ${sealedBy} is a pinned credential, but not the envelope's seat ${seat ?? "(none)"}` };
  const verdict = typeof p.producer_sig_verdict === "string" ? p.producer_sig_verdict : "";
  checks.producer_sig_verdict = verdict === "verified"
    ? { ok: true, detail: "verified" }
    : { ok: false, detail: `producer_sig_verdict is ${verdict || "(absent)"}, not verified` };
  // The receiver binding (Codex, PR 222 r2, H2): a signed dispatch is addressed to one seat at one terminal, and only
  // that seat at that terminal may act on it. A seat that does not know its own terminal cannot make the second check.
  const receiverSeat = typeof p.receiver_seat === "string" ? p.receiver_seat : "";
  checks.receiver_seat = receiverSeat === expect.receiver.seat
    ? { ok: true, detail: receiverSeat }
    : { ok: false, detail: `the dispatch is addressed to ${receiverSeat || "(absent)"}, and this seat is ${expect.receiver.seat}` };
  const targetTerminal = typeof p.target_terminal === "string" ? p.target_terminal : "";
  if (expect.receiver.terminal === undefined) {
    checks.target_terminal = { ok: false, detail: `the dispatch targets ${targetTerminal || "(absent)"}, and this seat does not know its own terminal handle (ORCA_TERMINAL_HANDLE or RETRACE_TERMINAL is not set); the binding cannot be checked` };
    unverifiable.add("target_terminal");
  } else {
    checks.target_terminal = targetTerminal === expect.receiver.terminal
      ? { ok: true, detail: targetTerminal }
      : { ok: false, detail: `the dispatch targets ${targetTerminal || "(absent)"}, and this seat's terminal is ${expect.receiver.terminal}` };
  }
  const expectedText = await paneTextSha256(expect.text);
  const recordedText = typeof p.text_sha256 === "string" ? p.text_sha256 : "";
  checks.text_sha256 = recordedText === expectedText
    ? { ok: true, detail: expectedText }
    : { ok: false, detail: `event text_sha256 ${recordedText || "(absent)"} ≠ received text ${expectedText}` };
  // The brief binding (Codex, PR 222 r1 H3, r2 H1): the brief the text names, the brief the event recorded and the
  // brief the receiver read must be one file, and its bytes must hash to the recorded sha256.
  const named = briefNamedIn(expect.text);
  const recordedPath = typeof p.brief_path === "string" ? p.brief_path : undefined;
  const recordedBrief = typeof p.brief_sha256 === "string" ? p.brief_sha256 : undefined;
  if (named !== undefined) {
    if (recordedPath === undefined) checks.brief_path = { ok: false, detail: `the text names brief ${named} but the event records no brief_path` };
    else if (!briefPathNames(recordedPath, named, expect.homeDir)) checks.brief_path = { ok: false, detail: `the text names brief ${named} but the event's brief_path is ${recordedPath}` };
    else if (expect.briefPath !== undefined && !briefPathNames(expect.briefPath, named, expect.homeDir)) checks.brief_path = { ok: false, detail: `the receiver's brief_path ${expect.briefPath} is not the brief the text names (${named})` };
    else checks.brief_path = { ok: true, detail: `${named} is ${expandHome(recordedPath, expect.homeDir)}` };
  } else if (recordedPath !== undefined && expect.briefPath !== undefined && expandHome(recordedPath, expect.homeDir) !== expandHome(expect.briefPath, expect.homeDir)) {
    checks.brief_path = { ok: false, detail: `the event's brief_path ${recordedPath} is not the receiver's brief_path ${expect.briefPath}` };
  } else {
    checks.brief_path = { ok: true, detail: named === undefined ? "no brief named" : named };
  }
  if (expect.briefReadError !== undefined) {
    checks.brief_sha256 = { ok: false, detail: `the brief could not be read: ${expect.briefReadError}` };
    unverifiable.add("brief_sha256");
  } else if (recordedBrief === undefined) {
    checks.brief_sha256 = named !== undefined
      ? { ok: false, detail: `the text names a brief (${named}) but the event records no brief_sha256` }
      : expect.briefPresent
        ? { ok: false, detail: "a brief was supplied but the event records no brief_sha256" }
        : { ok: true, detail: "no brief named" };
  } else if (expect.briefSha256 === undefined) {
    checks.brief_sha256 = { ok: false, detail: `event records brief_sha256 ${recordedBrief} but no brief was read` };
    unverifiable.add("brief_sha256");
  } else {
    checks.brief_sha256 = recordedBrief === expect.briefSha256
      ? { ok: true, detail: recordedBrief }
      : { ok: false, detail: `event brief_sha256 ${recordedBrief} ≠ brief on disk ${expect.briefSha256}` };
  }
  const failure = Object.keys(checks).find((k) => !checks[k]!.ok);
  const signature: SentSignature = failure ? (unverifiable.has(failure) ? "unverifiable" : "mismatch") : "verified";
  return { signature, sent_event_id: raw.id, sender: seat, checks, ...(failure ? { failure } : {}) };
}
