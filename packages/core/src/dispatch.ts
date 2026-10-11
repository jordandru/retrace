/**
 * Agent-to-agent pane messages — the pure half of agent-rules 15 / agent-ops 18.
 *
 * A pane message is ONE line: `SEAT <text> SEAT` where SEAT is the sender's pinned actor id upper-cased. The sender logs a
 * `sent` event carrying the sha256 of exactly those bytes (no suffix, no trailing newline), then sends the line with
 * ` [sent-event <id>]` appended. The receiver strips exactly that suffix, hashes the rest and reads the named event raw.
 * Nothing here does IO: the MCP tools (`retrace_send`, `retrace_verify_send` in packages/mcp-server) own the credential,
 * the terminal and the ledger; this module owns the byte rules and the six checks, so both ends compute the same thing
 * and a test can prove it without a Worker.
 */
import { sha256Hex } from "./chain.js";
import type { Event } from "./schema.js";

/** The suffix is a single space, then `[sent-event evt_<32 hex>]`, and nothing after it. */
export const SENT_EVENT_SUFFIX_RE = /^(.*) \[sent-event (evt_[0-9a-f]{32})\]$/;
/** Whole line including the suffix (agent-ops 18: Cursor folds a longer paste so the reader sees nothing). */
export const PANE_MESSAGE_MAX_BYTES = 240;
/** ` [sent-event evt_<32 hex>]` is 50 bytes, so the text before it is at most 190. */
export const PANE_TEXT_MAX_BYTES = 190;
/** The owner's envelope (docs/owner-protocol.md §1) is never used by an agent (§5, the hard guard). A message that
 *  carries `JD` as a standalone token anywhere is refused before it is hashed, so the ledger never records an agent
 *  sending one. */
const OWNER_ENVELOPE_TOKEN = /(^|\s)JD(\s|$)/;

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
  if (OWNER_ENVELOPE_TOKEN.test(text)) return "owner_envelope_forbidden";
  if (/\[sent-event /.test(text)) return "suffix_in_text";
  return undefined;
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
  const line = received.replace(/\r?\n$/, "");
  const m = SENT_EVENT_SUFFIX_RE.exec(line);
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

function paramsOf(e: Pick<Event, "method">): Record<string, unknown> {
  const p = e.method?.params;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

/**
 * The six checks of agent-rules 15 over a raw event, plus the envelope on the received text. `raw` is what
 * `GET /events/<id>` returned (or null when it does not exist / could not be read). `expect.text` is the received line
 * with the suffix removed; `expect.briefSha256` is the sha256 of the brief on disk when the caller has one.
 */
export async function verifySentEvent(
  raw: Event | null | undefined,
  expect: { text: string; sentEventId: string; briefSha256?: string; briefPresent?: boolean; readError?: string },
): Promise<SentVerification> {
  const checks: Record<string, SentCheck> = {};
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
  checks.sealed_by = sealedBy.startsWith("pinned:")
    ? { ok: true, detail: sealedBy }
    : { ok: false, detail: `sealed_by is ${sealedBy || "(absent)"}, not pinned:` };
  const verdict = typeof p.producer_sig_verdict === "string" ? p.producer_sig_verdict : "";
  checks.producer_sig_verdict = verdict === "verified"
    ? { ok: true, detail: "verified" }
    : { ok: false, detail: `producer_sig_verdict is ${verdict || "(absent)"}, not verified` };
  const expectedText = await paneTextSha256(expect.text);
  const recordedText = typeof p.text_sha256 === "string" ? p.text_sha256 : "";
  checks.text_sha256 = recordedText === expectedText
    ? { ok: true, detail: expectedText }
    : { ok: false, detail: `event text_sha256 ${recordedText || "(absent)"} ≠ received text ${expectedText}` };
  const recordedBrief = typeof p.brief_sha256 === "string" ? p.brief_sha256 : undefined;
  if (recordedBrief === undefined) {
    checks.brief_sha256 = expect.briefPresent
      ? { ok: false, detail: "a brief was supplied but the event records no brief_sha256" }
      : { ok: true, detail: "no brief named" };
  } else if (expect.briefSha256 === undefined) {
    checks.brief_sha256 = { ok: false, detail: `event records brief_sha256 ${recordedBrief} but no brief was read` };
  } else {
    checks.brief_sha256 = recordedBrief === expect.briefSha256
      ? { ok: true, detail: recordedBrief }
      : { ok: false, detail: `event brief_sha256 ${recordedBrief} ≠ brief on disk ${expect.briefSha256}` };
  }
  const failure = Object.keys(checks).find((k) => !checks[k]!.ok);
  let signature: SentSignature = "verified";
  if (failure) {
    signature = failure === "brief_sha256" && expect.briefSha256 === undefined && recordedBrief !== undefined
      ? "unverifiable"
      : "mismatch";
  }
  return { signature, sent_event_id: raw.id, sender: seat, checks, ...(failure ? { failure } : {}) };
}
