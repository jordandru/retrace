/**
 * Commit-message → actor resolution, shared by the git hook (dev machine) and the GitHub push webhook (server) so both
 * producers derive the SAME actor from the same bytes; a disagreement between them then means the commit was rewritten
 * after the hook ran, or one producer's event was forged — never a difference of parsers (reconciliation phase B).
 */
import { EventInput } from "./schema.js";

const AGENT_COAUTHOR = /claude|copilot|codex|cursor|devin|aider|gpt|gemini|grok|\[bot\]/i;
/** Agent families a Co-Authored-By name is mapped onto (first match wins) — the actor id (backlog #12). */
const AGENT_FAMILIES = ["claude", "copilot", "codex", "cursor", "devin", "aider", "gemini", "grok", "gpt"];
/** Family substring → pinned MCP actor id. Copilot's Co-Authored-By name is "Copilot"/"GitHub Copilot"; the Worker pin is `github-copilot`. */
const PINNED_FAMILY_IDS: Record<string, string> = { copilot: "github-copilot" };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
/** Retrace-Caused-By must be a real event id; junk trailers are dropped rather than sealed (audit 2026-08-30). */
export const CAUSED_BY_RE = /^evt_[0-9a-f]{32}$/i;
/** Retrace-Actor trailer: agent slug only (not an email, URL, or free text). */
export const ACTOR_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/i;
export function validCausedById(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t && CAUSED_BY_RE.test(t) ? t : undefined;
}
export function validActorId(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t && ACTOR_ID_RE.test(t) ? t : undefined;
}

/** A trailer line, per git: token, colon, whitespace, non-blank value. */
const TRAILER_LINE = /^[A-Za-z][\w-]*:\s+\S/;

/**
 * Trailers from EVERY trailing trailer-only paragraph of a commit message, walking back from the last paragraph
 * and stopping at the first paragraph with prose (the subject never counts). Git's own `%(trailers)` reads only
 * the LAST paragraph, so 68c343f's `Retrace-*` block + separate `Co-Authored-By` block lost the Retrace-* lines and
 * the hook minted actor "claude-fable-5" (backlog #12, dogfood log 2026-08-20). A `Key: value` line inside prose is
 * NOT a trailer. Keys are lowercased; continuation lines (leading whitespace) are unfolded into the previous value.
 * `trailerText` = the collected paragraphs' lines (CRLF → LF), so the caller can strip exactly those from the body.
 * Line endings are normalised first and the value capture avoids `.`/`$` (both stop at \r and U+2028): a CRLF
 * message (kept verbatim by `--cleanup=verbatim`, `git commit-tree`, API-made commits) otherwise had its lines
 * classified as trailers yet none extracted — the Retrace-* block vanished from the ledger (review of the #12 fix).
 */
export function parseTrailers(message: string): { trailers: Record<string, string[]>; trailerText: string[] } {
  const paras = message.replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/).map((p) => p.split("\n"));
  const isTrailerPara = (p: string[]) => TRAILER_LINE.test(p[0]) && p.every((l) => TRAILER_LINE.test(l) || /^\s/.test(l));
  let k = paras.length;
  while (k > 1 && isTrailerPara(paras[k - 1])) k--;
  const trailerText = paras.slice(k).flat();
  const trailers: Record<string, string[]> = {};
  let last: string[] | undefined;
  for (const line of trailerText) {
    const m = line.match(/^([A-Za-z][\w-]*):\s+([\s\S]*)$/);
    if (m) (last = trailers[m[1].toLowerCase()] ??= []).push(m[2].trim());
    else if (last) last[last.length - 1] += " " + line.trim();
  }
  return { trailers, trailerText };
}

/** Body minus its last `n` non-blank lines (the trailer paragraphs, which are always a suffix of the body). CRLF → LF
 *  as in parseTrailers, so `intent` never carries a stray \r next to git's already CR-free `%s` subject. */
export function stripTrailers(body: string, n: number): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let i = lines.length;
  while (n > 0 && i > 0) if (lines[--i].trim()) n--;
  return lines.slice(0, i).join("\n").trim().replace(/\n{3,}/g, "\n\n");
}

/** Co-Authored-By agent → { id: family, model: slug of the full name when it says more than the family, display_name:
 *  name as written }. Keeps "Claude Fable 5" from minting actor id "claude-fable-5" (backlog #12). */
export function coauthorActor(coauthor: string, ae: string): EventInput["actor"] {
  const name = coauthor.replace(/<.*>/, "").trim();
  const family = AGENT_FAMILIES.find((f) => name.toLowerCase().includes(f));
  const full = slug(name);
  const id = (family && PINNED_FAMILY_IDS[family]) ?? family ?? full;
  const model = family && full !== family && full !== id ? full : undefined;
  return { type: "agent", id, model, on_behalf_of: ae, display_name: name };
}


export interface CommitActorResolution {
  actor: EventInput["actor"];
  /** valid Retrace-Caused-By trailer, if any */
  causedBy?: string;
  trailers: Record<string, string[]>;
  /** subject + body with the trailer paragraphs removed */
  intent: string;
  isMerge: boolean;
}

/** Same precedence as the hook: Retrace-Actor trailer → agent Co-Authored-By → [bot] author → human author. */
export function resolveCommitActor(input: { message: string; authorName?: string; authorEmail?: string; parents?: string[] }): CommitActorResolution {
  const message = input.message ?? "";
  const { trailers, trailerText } = parseTrailers(message);
  const norm = message.replace(/\r\n?/g, "\n").trim();
  const nl = norm.indexOf("\n");
  const subject = nl < 0 ? norm : norm.slice(0, nl);
  const body = nl < 0 ? "" : norm.slice(nl + 1);
  const an = input.authorName ?? "", ae = input.authorEmail ?? "";
  const coauthors = trailers["co-authored-by"] ?? [];
  const agentId = validActorId(trailers["retrace-actor"]?.[0]);
  const agentCo = coauthors.find((c) => AGENT_COAUTHOR.test(c));
  const isBot = /\[bot\]/i.test(an);
  let actor: EventInput["actor"];
  if (agentId) actor = { type: "agent", id: agentId, model: trailers["retrace-model"]?.[0], on_behalf_of: ae || undefined };
  else if (agentCo) actor = coauthorActor(agentCo, ae);
  else if (isBot) actor = { type: "system", id: ae || an, display_name: an };
  else actor = { type: "human", id: ae || an, display_name: an };
  const cleanBody = stripTrailers(body, trailerText.length);
  return { actor, causedBy: validCausedById(trailers["retrace-caused-by"]?.[0]), trailers, intent: cleanBody ? `${subject}\n\n${cleanBody}` : subject, isMerge: (input.parents?.length ?? 0) > 1 };
}
