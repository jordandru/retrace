#!/usr/bin/env node
/**
 * build-packet — assemble a NOOA witness-review packet and its launcher from the routing event, the head under review
 * and a rules file, with the evidence the review needs INSIDE the packet by default: the PR body and commit messages
 * verbatim, the diff and interdiff, selected fields of every ledger event the text cites (each read raw, each entry naming
 * the fields it does not carry), the CI gate lines for the head, the agent-rules items the rules file names, and (opt-in)
 * a status snapshot.
 *
 * Why (measured 2026-10-11, ~/.retrace/ops-2026-10-11/system-optimization/FINDINGS.md M3): 4–5 of 18 review rejections
 * on six PRs that week were "unverifiable from packet" — the evidence existed but the hand-built packet did not carry
 * it — and two NOOA runs stalled 30 minutes on a 56 KB packet while a 16 KB one passed in 3 minutes. The packet is the
 * witness's whole world (it executes nothing), so what is left out becomes a finding and what is too long is not read.
 *
 * The routing event is this builder's authority, and it is authenticated before anything else is read or written (Codex,
 * PR 225 round 1, H3): read raw from the Worker, it must be a `routing` event by the coordinator seat, sealed under the
 * pinned claude-code credential with a verified producer signature, and its `pr`, `head_sha`, `class`, `round`,
 * `reasoning_effort`, `seat`, `reviewer_actor` and `model` must each equal what this build asks for. Otherwise nothing is
 * written. The witness model is the constant NOOA_MODEL, not a flag (M2); the launcher carries the class and the review
 * surface the wrapper seals (M3). The launcher itself is a plain shell file: the host wrapper takes its values as given and
 * re-verifies none of them (PR 225 round 2, H1). The launch is `push-and-launch.sh`, which prints hashes and a pid and writes
 * nothing to the ledger; any record of what was launched is the coordinator's own act, not this code's (round 3, H1).
 *
 *   node scripts/nooa/build-packet.mjs --pr 220 --head <40 hex> --routing evt_… --round r4 --rubric high --class a \
 *     --rules-file rules.md [--base <sha>] [--prev-head <sha>] [--context-file notes.md] [--instruction evt_…] \
 *     [--codex-routing evt_…] [--events evt_…,evt_…] [--files a.md,b.ts] [--ci] [--status] [--max-bytes 45000] [--out dir] [--repo path]
 *
 * --files restricts the diff and interdiff to those paths (a large code PR cannot fit whole; the header then lists every
 * file of the PR and marks which ones the packet carries, so the witness knows what it did not see).
 *
 * Writes nooa-pr<N>-packet-<round>.md and launch-pr<N>-<round>.sh into --out (default: cwd) and prints their sha256
 * and sizes plus anything omitted for size. It does not push or launch: that stays `push-and-launch.sh`, which prints the
 * local hashes and the ones the host echoes back and writes nothing to the ledger; the coordinator's own `sent` event, logged
 * before the push, carries the local hashes it computed (agent-ops 18). Reads the Worker with RETRACE_URL / RETRACE_TOKEN from
 * the environment, in-process, never on a command line. Nothing is written to the ledger.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const EVENT_ID_RE = /evt_[0-9a-f]{32}/g;
export const DEFAULT_MAX_BYTES = 45_000;
export const REPO_FULL = "jordandru/retrace";
/** The witness model, pinned here and in the routing event; `nooa-review-generic.py` refuses any other (Codex, PR 225 r1, M2). */
export const NOOA_MODEL = "nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b";
/** The witness seat the routing event must name. */
export const NOOA_SEAT = "nooa";
/** The seat whose pinned credential must have sealed the routing event. */
export const COORDINATOR_SEAT = "claude-code";

const KNOWN_FLAGS = new Set(["pr", "head", "routing", "round", "rubric", "class", "rules-file", "base", "prev-head", "context-file", "instruction", "codex-routing", "events", "files", "ci", "status", "max-bytes", "out", "repo"]);

export function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === "model") throw new Error(`--model is not a flag: the witness model is ${NOOA_MODEL}, pinned here and in the routing event (Codex, PR 225 r1, M2)`);
    if (!KNOWN_FLAGS.has(key)) throw new Error(`unknown flag --${key}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; } else flags[key] = true;
  }
  const need = (k, re) => {
    const v = flags[k];
    if (typeof v !== "string" || !v) throw new Error(`--${k} is required`);
    if (re && !re.test(v)) throw new Error(`--${k} ${v} does not match ${re}`);
    return v;
  };
  return {
    pr: Number(need("pr", /^\d+$/)),
    head: need("head", /^[0-9a-f]{40}$/),
    routing: need("routing", /^evt_[0-9a-f]{32}$/),
    round: need("round", /^r\d+[a-z]?$/),
    rubric: need("rubric", /^(high|medium|low|xhigh|max)$/),
    cls: need("class", /^(a|b|c|S)$/),
    rulesFile: need("rules-file"),
    base: typeof flags.base === "string" ? flags.base : undefined,
    prevHead: typeof flags["prev-head"] === "string" ? flags["prev-head"] : undefined,
    contextFile: typeof flags["context-file"] === "string" ? flags["context-file"] : undefined,
    instruction: typeof flags.instruction === "string" ? flags.instruction : undefined,
    codexRouting: typeof flags["codex-routing"] === "string" ? flags["codex-routing"] : undefined,
    extraEvents: typeof flags.events === "string" ? flags.events.split(",").filter(Boolean) : [],
    onlyFiles: typeof flags.files === "string" ? flags.files.split(",").filter(Boolean) : undefined,
    ci: flags.ci === true,
    status: flags.status === true,
    maxBytes: typeof flags["max-bytes"] === "string" ? Number(flags["max-bytes"]) : DEFAULT_MAX_BYTES,
    out: typeof flags.out === "string" ? flags.out : process.cwd(),
    repo: typeof flags.repo === "string" ? flags.repo : process.cwd(),
    model: NOOA_MODEL,
  };
}

/** Every full event id in the given texts, first occurrence first, no duplicates. */
export function collectEventIds(texts) {
  const seen = new Set();
  const out = [];
  for (const t of texts) for (const m of String(t ?? "").matchAll(EVENT_ID_RE)) if (!seen.has(m[0])) { seen.add(m[0]); out.push(m[0]); }
  return out;
}

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…[${s.length} chars]` : s);

/** Does a pinned credential name carry the seat id as a word? Same rule as packages/core/src/dispatch.ts (PR 222, M3). */
export function credentialNamesSeat(sealedBy, seat) {
  if (typeof sealedBy !== "string" || !sealedBy.startsWith("pinned:")) return false;
  const name = sealedBy.slice("pinned:".length).trim();
  return new RegExp(`(^|[^a-z0-9-])${seat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9-]|$)`, "i").test(name);
}

/**
 * Why the raw routing event does not authorize this build, or undefined when it does (Codex, PR 225 r1, H3). The event
 * must be the one asked for, a `routing` event by agent/claude-code, sealed under the pinned claude-code credential with a
 * verified producer signature, and every routed scope field must equal the request: pr, head_sha (full), class, round,
 * reasoning_effort, seat and reviewer_actor (the witness seat), model (the pinned witness model).
 */
export function routingProblem(raw, o) {
  if (!raw || typeof raw !== "object") return "the event could not be read";
  if (raw.id !== o.routing) return `the event read is ${raw.id ?? "(no id)"}, not ${o.routing}`;
  if (raw.method?.tool !== "routing") return `method.tool is ${JSON.stringify(raw.method?.tool ?? null)}, not "routing"`;
  if (raw.actor?.type !== "agent" || raw.actor?.id !== COORDINATOR_SEAT) return `actor is ${raw.actor?.type ?? "?"}/${raw.actor?.id ?? "?"}, not agent/${COORDINATOR_SEAT}`;
  const p = raw.method?.params ?? {};
  if (!credentialNamesSeat(p.sealed_by, COORDINATOR_SEAT)) return `sealed_by is ${JSON.stringify(p.sealed_by ?? null)}, not the pinned ${COORDINATOR_SEAT} credential`;
  if (p.producer_sig_verdict !== "verified") return `producer_sig_verdict is ${JSON.stringify(p.producer_sig_verdict ?? null)}, not "verified"`;
  const want = { pr: o.pr, head_sha: o.head, class: o.cls, round: o.round, reasoning_effort: o.rubric, seat: NOOA_SEAT, reviewer_actor: NOOA_SEAT, model: NOOA_MODEL };
  for (const [k, v] of Object.entries(want)) if (p[k] !== v) return `params.${k} is ${JSON.stringify(p[k] ?? null)}, not ${JSON.stringify(v)} as requested`;
  return undefined;
}

/** Top-level fields of a raw event that Appendix A carries when present, empty values included (intent clipped as
 * `intent_head`; artifacts and change with their strings clipped; `method` through `method_tool` and `params`). */
export const EVENT_FIELDS_CARRIED = ["id", "seq", "timestamp", "actor", "action", "action_detail", "caused_by", "tags", "intent", "artifacts", "change", "method"];
/** `method.params` keys Appendix A carries when present; every other key present in the event is listed by name under `omitted.params`. */
export const PARAM_KEYS_CARRIED = [
  "sealed_by", "producer_sig_verdict", "pr", "round", "class", "surface_class", "seat", "seat_order", "reviewer_actor", "model",
  "reasoning_effort", "head_sha", "base_sha", "author", "author_instruction_event", "routing_event_id", "reviewed_head", "findings",
  "blocking", "blocking_reason", "accepted_reason", "verdict", "finding_summary", "review_sha256", "packet_sha256", "validation_event_id",
  "codex_verdict", "nooa_verdict", "text_sha256", "brief_sha256", "brief_path", "bytes", "pane", "enter_pressed_by", "target",
  "target_event_id", "attest_causal_root", "input_signature", "github_action", "relayed_by", "owner_login_decision", "owner_pin_event",
  "rules_digest", "models_digest", "merge_ready", "next",
];
/** Where a carried raw key lands in the rendered entry (identity unless listed). */
const TOP_KEY_OUT = { intent: "intent_head" };
const PARAM_KEY_OUT = { sealed_by: "sealed_by", producer_sig_verdict: "producer_sig_verdict" };

const clipStrings = (v, n) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" ? clip(x, n) : x])) : v);

/**
 * Selected fields of a raw event for Appendix A (Codex, PR 225 r1, M4: a projection, labelled as one). Signature material
 * is never carried. Every key PRESENT in the raw event — empty strings and empty arrays included — is either carried or
 * named under `omitted`; the `omitted` lists are computed from the properties this function actually emitted, not from a
 * static declaration (Codex, PR 225 r2, M2), so a reader cannot take absence in the packet for absence in the ledger.
 * Strings over their clip length end with `…[N chars]`.
 */
export function renderEvent(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const out = {};
  for (const k of Object.keys(raw)) {
    if (k === "method" || !EVENT_FIELDS_CARRIED.includes(k)) continue;
    const v = raw[k];
    if (k === "intent") out.intent_head = clip(v, 240);
    else if (k === "artifacts") out.artifacts = Array.isArray(v) ? v.map((a) => clipStrings(a, 160)) : v;
    else if (k === "change") out.change = clipStrings(v, 300);
    else out[k] = v;
  }
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const method = isObj(raw.method) ? raw.method : undefined;
  const p = method && isObj(method.params) ? method.params : undefined;
  out.sealed_by = p && "sealed_by" in p ? p.sealed_by : "(absent)";
  out.producer_sig_verdict = p && "producer_sig_verdict" in p ? p.producer_sig_verdict : "(absent)";
  if (method && "tool" in method) out.method_tool = method.tool;
  // A present but empty object is carried as `{}`, never dropped (Codex, PR 225 r3, M1); `null` or a non-object is named under `omitted`.
  if (method && Object.keys(method).length === 0) out.method = {};
  if (p) {
    const params = {};
    for (const k of Object.keys(p)) if (!(k in PARAM_KEY_OUT) && PARAM_KEYS_CARRIED.includes(k)) params[k] = typeof p[k] === "string" ? clip(p[k], 300) : p[k];
    if (Object.keys(params).length || Object.keys(p).length === 0) out.params = params;
  }
  // Omission, computed from what was emitted: a raw key is carried only if its rendered property exists in `out`, or (for
  // `method`) every one of its keys is itself rendered or named below.
  const topCarried = (k) => (k === "method" ? Boolean(method) : (TOP_KEY_OUT[k] ?? k) in out);
  const methodCarried = (k) => (k === "tool" ? "method_tool" in out : k === "params" ? "params" in out : false);
  const paramCarried = (k) => (k in PARAM_KEY_OUT ? PARAM_KEY_OUT[k] in out : Boolean(out.params) && k in out.params);
  out.omitted = {
    fields: Object.keys(raw).filter((k) => !topCarried(k)).sort(),
    method: method ? Object.keys(method).filter((k) => !methodCarried(k)).sort() : [],
    params: p ? Object.keys(p).filter((k) => !paramCarried(k)).sort() : [],
  };
  return out;
}

/** Numbered items of docs/agent-rules.md ("15. **…" up to the next item), by number. */
export function extractRuleItems(agentRulesMd, numbers) {
  const lines = agentRulesMd.split("\n");
  const starts = [];
  lines.forEach((l, i) => { const m = /^(\d+)\. \*\*/.exec(l); if (m) starts.push({ n: Number(m[1]), i }); });
  const end = lines.findIndex((l, i) => i > (starts.at(-1)?.i ?? 0) && /^Roles, review order/.test(l));
  const out = {};
  for (const n of numbers) {
    const k = starts.findIndex((s) => s.n === n);
    if (k === -1) continue;
    const from = starts[k].i;
    const to = k + 1 < starts.length ? starts[k + 1].i : (end === -1 ? lines.length : end);
    out[n] = lines.slice(from, to).join("\n").trimEnd();
  }
  return out;
}

/** Rule numbers a rules file cites as "agent-rules N" / "rule N" / "rules 11 and 15". */
export function citedRuleNumbers(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/\b(?:agent-)?rules?\s+(\d{1,2})(?:\s*(?:,|and|\/)\s*(\d{1,2}))*/gi)) {
    for (const n of m[0].match(/\d{1,2}/g) ?? []) out.add(Number(n));
  }
  return [...out].sort((a, b) => a - b);
}

/** The gate step's verdict lines from a `gh run view --log` dump: job<TAB>step<TAB>timestamp text. */
export function gateLines(logText) {
  const out = [];
  for (const line of String(logText).split("\n")) {
    const cols = line.split("\t");
    if (cols.length < 3 || !/doctor --gate/.test(cols[1])) continue;
    const text = cols.slice(2).join("\t").replace(/^﻿?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "");
    if (/^(READY|NOT READY)\b|^(FAIL|PASS)\s+(instruct root|HEAD delivery|pin\/session|attribution|capture coverage)\b/.test(text)) out.push(text);
  }
  return out;
}

/** What the review surface is, from the routed class (agent-rules 12) and the files the packet carries; the wrapper seals it. */
export const CLASS_TEXT = {
  a: "class (a): a governing change under the design gate (agent-rules 12)",
  b: "class (b): a non-governing document, one non-author review (agent-rules 12)",
  c: "class (c): code or scripts under the code order of docs/team-roles.md (agent-rules 12)",
  S: "class (S): a security change; the higher gate applies (agent-rules 12)",
};
export function reviewSurface(cls, files) {
  const shown = files.slice(0, 6);
  return `${CLASS_TEXT[cls]}; files under review: ${shown.join(", ")}${files.length > shown.length ? ` and ${files.length - shown.length} more` : ""}`;
}

export const ROLE_TEXT = `## Your role, and its limits — state these in your review

You are the independent witness seat. You read **this file only** and execute nothing: no commands, no repository
access, no network. Everything you can legitimately check is in this packet or is a matter of reasoning about it. Where a
claim rests on a file, a line or an event you cannot see here, say "unverified from packet" rather than guessing either
way. Appendix A holds selected fields of the ledger events the text cites, fetched raw by the coordinator's builder from
\`GET /events/<id>\`; each entry lists under \`omitted\` the field names it does not carry, so a field's absence there is not
its absence in the ledger. Treat them as quotations, not as your own verification.

When the change under review is a design note or brief marked **not built**, a sentence stating what the design specifies
is a statement of intent, not a claim that the code does it today. Judge whether the design is sound, complete and honest
about its limits. A note that claims something *is* built or deployed when the packet shows no such evidence is a finding,
at the severity its consequence carries.`;

export const CONTRACT_TEXT = `## Output contract — follow exactly

Severity is a claim about consequence, not a label of convenience (team-roles rule 8). **High** and **Medium** name what a
reader would wrongly believe or what capability is given away, with the evidence. **Low** alleges neither: wording,
placement, a citation one hop off, a check that could be stated more precisely without changing what it proves. Only
Medium and High block a merge.

Write the review in this structure and no other:

\`\`\`
## Findings
### 1. <High|Medium|Low> — <one-line claim> (rule <n>)
**Where:** the file and section or line.
**Failure:** for High or Medium: what a reader would wrongly believe, or what capability is given away, with the evidence
in the packet. For Low: what is imprecise, and why no wrong belief follows.
**Fix:** the specific replacement wording or change.
(repeat, highest severity first; if there is nothing, write "No findings")

## What is sound
Three to six bullets naming claims you checked and judge correct, each with where. On a re-check, the disposition of each
earlier finding (resolved, or rightly declined) goes HERE, not under Findings.

## Limits of this review
What you could not verify from this packet alone; the slices you read; that this review is packet-scoped and advisory.

FINDINGS: high=<n> medium=<n> low=<n>
BLOCKING: <yes|no>
VERDICT: approved — <one line>   |   VERDICT: needs changes: <the findings>
\`\`\`

The **last three lines of the whole review** are bare text starting at column zero, in that order, with nothing after them:
not indented, no heading, no bold, no list marker, no blockquote, no code fence, no closing remark. They are derived from
your findings, never declared: the counts are the findings you listed; \`BLOCKING: yes\` exactly when high + medium > 0,
otherwise \`BLOCKING: no\`. The VERDICT line is \`approved\` or \`needs changes\`, alone or followed by one of the delimiters
— – : - and at least one word (a bare delimiter is refused). \`approved\` cannot carry a Medium or High. \`needs changes\` is sealed as the action \`rejected\`; with
only Lows it is allowed and reads \`BLOCKING: no\` (a non-blocking rejection; only a Medium or High blocks a merge). There is
no REASON line and no override. Write FINDINGS, BLOCKING and VERDICT at the start of exactly one line each in the whole
review and never quote them in a fence, a blockquote, a list or a heading: the seal reads the one block at the very end,
refuses a keyword line in any of those forms anywhere, refuses a second keyword line, refuses text after the block, and
refuses lines that disagree with each other.
Write no HTML comment and no comment marker anywhere in the review, code and quotations included: no less-than sign
followed by an exclamation mark or a question mark, no less-than sign and slash followed by anything but a letter, and no
two hyphens followed by a greater-than sign; describe such text in words. The seal refuses a review that contains one, whole,
before reading anything else. Then nothing is sealed, the run is reported as failed, and the text you wrote is kept. The
derivation rules are the ones the repository's verdict validator applies to every sealed verdict (team-roles rule 8); the form
rules are the wrapper's.`;

const code = (lang, body) => `\`\`\`${lang}\n${body.replace(/\n$/, "")}\n\`\`\``;

/** Drop optional sections in a fixed order until the packet fits; record what was dropped and how to get it. */
export function trimToBudget(sections, maxBytes) {
  const order = ["ci", "status", "rulesText", "interdiff", "instruction"];
  const omitted = [];
  const fits = () => Buffer.byteLength(assemble(sections), "utf8") <= maxBytes;
  for (const key of order) {
    if (fits()) break;
    if (sections[key]) {
      omitted.push({ section: key, bytes: Buffer.byteLength(sections[key], "utf8"), how: HOW_TO_GET[key] });
      sections[key] = undefined;
    }
  }
  if (!fits()) {
    const before = Buffer.byteLength(sections.events ?? "", "utf8");
    sections.events = sections.events?.replace(/"intent_head": "[^"]{80,}"/g, (m) => m.slice(0, 95) + '…"');
    const after = Buffer.byteLength(sections.events ?? "", "utf8");
    if (after < before) omitted.push({ section: "events.intent_head", bytes: before - after, how: HOW_TO_GET.events });
  }
  return { sections, omitted, bytes: Buffer.byteLength(assemble(sections), "utf8"), fits: fits() };
}

const HOW_TO_GET = {
  ci: "`gh run view <id> --log` on the laptop, gate step; the run ids are in the header",
  status: "`node packages/mcp-server/dist/doctor.js status retrace --json` on the laptop",
  rulesText: "docs/agent-rules.md at the head under review",
  interdiff: "`git diff <prev-head> <head>` on the laptop",
  instruction: "`GET /events/<id>` raw on the laptop",
  events: "`GET /events/<id>` raw on the laptop (the ids are unchanged; only the intent text was clipped)",
};

function assemble(s) {
  const parts = [s.header, s.role, s.rules, s.context, s.body, s.commits, s.diff, s.interdiff, s.contract, s.events, s.ci, s.rulesText, s.instruction, s.status, s.omittedNote];
  return parts.filter(Boolean).join("\n\n") + "\n";
}

export function renderLauncher(o) {
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  return `#!/usr/bin/env bash
# NOOA witness review (${o.round}) of PR ${o.pr} at ${o.head} — generated by scripts/nooa/build-packet.mjs from routing event ${o.routing} (read raw by the builder, which refused to build unless that event authorized this build). This file is plain shell: the wrapper takes its values as given and re-verifies none of them; push-and-launch.sh prints this file's hash and writes nothing to the ledger. Runs as user nooa. Prints nothing secret.
set -u
cd /home/nooa/nooa-retrace
set -a; . ./.env; set +a
export NOOA_MCP_CONFIG=.mcp.remote.json
export NOOA_MODEL=${q(o.model)}
export NOOA_REVIEW_FILE=review/${o.packetName}
export NOOA_PR=${o.pr}
export NOOA_PR_TITLE=${q(o.title)}
export NOOA_ROUTING_EVENT=${o.routing}
export NOOA_REVIEWED_HEAD=${o.head}
export NOOA_CLASS=${o.cls}
export NOOA_SURFACE=${q(o.surface)}
export NOOA_FILES=${q(o.files.join(","))}
export NOOA_ROUND=${q(o.round)}
export NOOA_RUBRIC=${q(o.rubric)}
export NOOA_SCOPE=${q(`witness review of PR ${o.pr} ${o.round} at ${o.head}: the packet carries the PR body, commit messages, the diff${o.prevHead ? " and interdiff" : ""}, selected fields of ${o.eventCount} ledger events${o.ci ? ", CI gate lines" : ""}${o.rulesCited.length ? `, agent-rules ${o.rulesCited.join("/")}` : ""}${o.status ? ", a status snapshot" : ""}; judge the packet's numbered rules`)}
export NOOA_JUDGEMENT=${q("whether the change does what its body claims and nothing more, judged against the packet's numbered rules; every finding with a severity and its rule; any Medium or High goes to Jordan and blocks; a Low-only verdict does not block; do not merge")}
export NOOA_TAGS=${q(`pr-${o.pr},class-${o.cls},${o.round}`)}
nohup .venv/bin/python review/nooa-review-generic.py > review/pr${o.pr}-${o.round}-run.log 2>&1 < /dev/null &
echo "launched pid $!"
`;
}

/** Build the packet. `io` is injectable: { git(args), gh(args), fetchJson(path), readFile(path), now() }. */
export async function build(o, io) {
  // The routing event first, raw: it is the authority for everything that follows, and nothing is read or written until it
  // authorizes exactly this build (Codex, PR 225 r1, H3).
  let routingRaw;
  try { routingRaw = await io.fetchJson(`/events/${o.routing}`); } catch (e) { throw new Error(`routing event ${o.routing} could not be read raw (${String(e?.message ?? e).slice(0, 120)}); nothing built`); }
  const routingIssue = routingProblem(routingRaw, o);
  if (routingIssue) throw new Error(`routing event ${o.routing} does not authorize this build: ${routingIssue}; nothing built`);

  const pr = JSON.parse(io.gh(["pr", "view", String(o.pr), "--json", "title,body,headRefOid,baseRefName,files,author"]));
  if (pr.headRefOid !== o.head) throw new Error(`PR ${o.pr} head on GitHub is ${pr.headRefOid}, not --head ${o.head}; the packet binds to the head you route`);
  const base = o.base ?? io.git(["merge-base", `origin/${pr.baseRefName ?? "main"}`, o.head]).trim();
  const prFiles = (pr.files ?? []).map((f) => f.path);
  if (o.onlyFiles) for (const f of o.onlyFiles) if (!prFiles.includes(f)) throw new Error(`--files names ${f}, which PR ${o.pr} does not change`);
  const files = o.onlyFiles ?? prFiles;
  const omittedFiles = prFiles.filter((f) => !files.includes(f));
  const commits = io.git(["log", "--reverse", "--format=%H%n%(trailers)%n----MSG----%n%B%n====END====", `${base}..${o.head}`]);
  const commitShas = [...commits.matchAll(/^([0-9a-f]{40})$/gm)].map((m) => m[1]);
  let headSeal;
  try {
    const r = await io.fetchJson(`/projects/retrace/events?limit=300`);
    headSeal = (r.events ?? r).find((e) => (e.artifacts ?? []).some((a) => a?.id === `commit:${REPO_FULL}@${o.head.slice(0, 12)}` && a.role === "generated"));
  } catch { headSeal = undefined; }
  const rulesMd = io.readFile(o.rulesFile);
  const context = o.contextFile ? io.readFile(o.contextFile) : "";
  const diff = io.git(["diff", "-U3", base, o.head, "--", ...files]);
  const interdiff = o.prevHead ? io.git(["diff", "-U2", o.prevHead, o.head, "--", ...files]) : "";
  const rulesCited = citedRuleNumbers(rulesMd);
  const agentRules = io.git(["show", `${o.head}:docs/agent-rules.md`]);
  const ruleItems = extractRuleItems(agentRules, rulesCited);

  // Every id the text cites, the diff and interdiff included (Codex, PR 225 r1, M1): an id that appears only in a changed line
  // is still a claim the witness will read.
  const ids = collectEventIds([o.routing, o.codexRouting, o.instruction, pr.body, commits, rulesMd, context, diff, interdiff, ...o.extraEvents]);
  const events = [];
  const unreadable = [];
  for (const id of ids) {
    try { events.push(renderEvent(id === o.routing ? routingRaw : await io.fetchJson(`/events/${id}`))); } catch (e) { unreadable.push({ id, error: String(e?.message ?? e).slice(0, 120) }); }
  }

  let ciText = "";
  let ciRuns = [];
  if (o.ci) {
    ciRuns = JSON.parse(io.gh(["run", "list", "--workflow", "retrace-gate", "--commit", o.head, "--json", "databaseId,conclusion,status,createdAt"]));
    const blocks = [];
    for (const r of ciRuns) {
      if (r.status !== "completed") { blocks.push(`### run ${r.databaseId} — ${r.status} at build time (${r.createdAt})`); continue; }
      const lines = gateLines(io.gh(["run", "view", String(r.databaseId), "--log"]));
      blocks.push(`### run ${r.databaseId} — conclusion ${r.conclusion} (${r.createdAt})\n${code("", lines.join("\n") || "(no gate lines in the log)")}`);
    }
    ciText = `# Appendix B — CI \`retrace-gate\` runs for head ${o.head.slice(0, 12)} (gate step lines, read ${io.now()})\n\n${blocks.join("\n\n") || "(no runs for this head)"}`;
  }
  let statusText = "";
  if (o.status) {
    const st = await io.fetchJson(`/projects/retrace/status`);
    const sel = { generated_at: st.generated_at, events_total: st.events?.total, commits: st.capture?.commits, unlinked_commits: st.capture?.unlinked_commits, amended_unlinked_commits: st.capture?.amended_unlinked_commits, ineffective_amendments: st.capture?.ineffective_amendments, causality: st.causality };
    statusText = `# Appendix E — \`GET /projects/retrace/status\` (selected fields), read ${io.now()}\n${code("json", JSON.stringify(sel, null, 1))}`;
  }
  const instructionText = o.instruction ? (() => { const e = events.find((x) => x.id === o.instruction); return e ? `# Appendix D — this round's instruction (selected fields, as in Appendix A)\n${code("json", JSON.stringify(e, null, 1))}` : ""; })() : "";

  const author = headSeal?.actor ? `${headSeal.actor.type}/${headSeal.actor.id}${headSeal.actor.model ? ` (${headSeal.actor.model})` : ""}` : `GitHub login ${pr.author?.login ?? "?"} (no hook seal found in the last 300 events)`;
  const header = `# Review packet — Retrace PR ${o.pr}: ${pr.title} — witness review, ${o.round} at ${o.head.slice(0, 8)} (${io.now().slice(0, 10)})

- **What you review.** Repository \`${REPO_FULL}\`, PR ${o.pr}, head \`${o.head}\` (${commitShas.length} commit${commitShas.length === 1 ? "" : "s"} on base \`${base.slice(0, 12)}\`): ${prFiles.length} file${prFiles.length === 1 ? "" : "s"} changed${omittedFiles.length ? `, of which this packet carries the diff of ${files.length}: ${files.map((f) => `\`${f}\``).join(", ")}; **not in this packet** (say "unverified from packet" about them): ${omittedFiles.map((f) => `\`${f}\``).join(", ")}` : ` — ${files.map((f) => `\`${f}\``).join(", ")}`}. Author per the head's hook seal: ${author}${headSeal ? ` (seal \`${headSeal.id}\`)` : ""}. You did not write this.
- **Classification.** Class (${o.cls}) under agent-rules 12. Routing event \`${o.routing}\`, read raw by the builder and authenticated before this packet was built: a \`routing\` event by agent/${COORDINATOR_SEAT}, sealed under the pinned ${COORDINATOR_SEAT} credential with a verified producer signature, naming PR ${o.pr}, head \`${o.head.slice(0, 12)}\`, class ${o.cls}, ${o.round}, effort ${o.rubric}, seat ${NOOA_SEAT}, model \`${NOOA_MODEL}\`${o.codexRouting ? `; the first seat's routing \`${o.codexRouting}\`` : ""}. Rubric effort ${o.rubric}; your model exposes no effort control, so report \`not_applicable\`.
- **What this packet carries.** The PR body and every commit message verbatim; the diff against base${o.prevHead ? ` and the interdiff against the previous head \`${o.prevHead.slice(0, 12)}\`` : ""}; selected fields of the ${events.length} ledger events the text cites, each naming the fields it omits (Appendix A)${unreadable.length ? `, ${unreadable.length} unreadable (listed there)` : ""}${o.ci ? "; the CI gate lines for this head (Appendix B)" : ""}${rulesCited.length ? `; the text of agent-rules ${rulesCited.join(", ")} (Appendix C)` : ""}${o.instruction ? "; this round's instruction (Appendix D)" : ""}${o.status ? "; a status snapshot (Appendix E)" : ""}. If a claim's evidence is not here, say "unverified from packet"; a section the builder dropped for size is listed under "Omitted for size" with where to find it.
- **What your verdict carries.** Cite routing \`${o.routing}\` and reviewed head \`${o.head}\`; artifacts the PR and the files. End with the three bare lines of the output contract (FINDINGS, BLOCKING, VERDICT). Do not merge. Do not push.
- **Stop rule.** Any Medium or High goes to Jordan and blocks. A verdict with only Low findings does not block.`;

  const sections = {
    header,
    role: ROLE_TEXT,
    rules: `## Rules to judge against (name the rule in every finding; a severity on each)\n\n${rulesMd.trim()}`,
    context: context.trim() ? `## This round, as the coordinator describes it (a claim under test, not evidence)\n\n${context.trim()}` : undefined,
    body: `## PR body (verbatim, read ${io.now()})\n\n${(pr.body ?? "").trim() || "(empty)"}`,
    commits: `## Commit messages (verbatim; \`git log ${base.slice(0, 12)}..${o.head.slice(0, 12)}\`)\n${code("", commits)}`,
    diff: `## Diff vs base (-U3, verbatim; \`git diff ${base.slice(0, 12)} ${o.head.slice(0, 12)}\`)\n${code("diff", diff || "(empty diff)")}`,
    interdiff: o.prevHead ? `## Interdiff vs previous head (-U2, verbatim; \`git diff ${o.prevHead.slice(0, 12)} ${o.head.slice(0, 12)}\`)\n${code("diff", interdiff || "(empty interdiff)")}` : undefined,
    contract: CONTRACT_TEXT,
    events: `# Appendix A — selected fields of every event the text cites (each read raw by the builder from \`GET /events/<id>\`; this is a projection: each entry lists under \`omitted\` the top-level fields, method keys and params keys present in the event and not carried here, so absence here is not absence in the ledger; signature material is never carried; strings over their clip length end with …[N chars])\n\n${events.map((e) => code("json", JSON.stringify(e, null, 1))).join("\n\n") || "(none cited)"}${unreadable.length ? `\n\nUnreadable at build time: ${unreadable.map((u) => `\`${u.id}\` (${u.error})`).join("; ")}` : ""}`,
    ci: ciText || undefined,
    rulesText: rulesCited.length ? `# Appendix C — agent-rules items the rules above cite, verbatim at ${o.head.slice(0, 12)}\n\n${rulesCited.map((n) => ruleItems[n] ?? `(rule ${n} not found in docs/agent-rules.md)`).join("\n\n")}` : undefined,
    instruction: instructionText || undefined,
    status: statusText || undefined,
    omittedNote: undefined,
  };
  const trimmed = trimToBudget(sections, o.maxBytes);
  if (trimmed.omitted.length) {
    sections.omittedNote = `# Omitted for size (packet budget ${o.maxBytes} bytes)\n\n${trimmed.omitted.map((x) => `- **${x.section}** (${x.bytes} bytes): ${x.how}`).join("\n")}`;
  }
  const packet = assemble(sections);
  const packetName = `nooa-pr${o.pr}-packet-${o.round}.md`;
  const launcherName = `launch-pr${o.pr}-${o.round}.sh`;
  const surface = reviewSurface(o.cls, files);
  const launcher = renderLauncher({ ...o, packetName, title: pr.title, files, surface, eventCount: events.length, rulesCited });
  return { packet, packetName, launcher, launcherName, bytes: Buffer.byteLength(packet, "utf8"), fits: Buffer.byteLength(packet, "utf8") <= o.maxBytes, omitted: trimmed.omitted, events: ids, unreadable, ciRuns, files, base, surface };
}

export function realIo(o) {
  const url = (process.env.RETRACE_URL ?? "").replace(/\/+$/, "");
  const token = process.env.RETRACE_TOKEN;
  if (!url || !token) throw new Error("RETRACE_URL and RETRACE_TOKEN must be set in the environment (read-only GETs)");
  return {
    git: (args) => execFileSync("git", ["-C", o.repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
    gh: (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: o.repo }),
    fetchJson: async (path) => {
      const res = await fetch(url + path, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
      return res.json();
    },
    readFile: (p) => readFileSync(p, "utf8"),
    now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`build-packet: ${e.message}`); process.exit(2); }
  let r;
  try { r = await build(o, realIo(o)); } catch (e) { console.error(`build-packet: ${e.message}`); process.exit(2); }
  mkdirSync(o.out, { recursive: true });
  const packetPath = join(o.out, r.packetName);
  const launcherPath = join(o.out, r.launcherName);
  writeFileSync(packetPath, r.packet);
  writeFileSync(launcherPath, r.launcher, { mode: 0o755 });
  console.log(`packet   ${packetPath}\n  sha256 ${sha256(r.packet)}  bytes ${r.bytes}${r.fits ? "" : "  OVER BUDGET"}\nlauncher ${launcherPath}\n  sha256 ${sha256(r.launcher)}  bytes ${Buffer.byteLength(r.launcher)}`);
  console.log(`base ${r.base}  files ${r.files.length}  events ${r.events.length}${r.unreadable.length ? `  unreadable ${r.unreadable.length}` : ""}${o.ci ? `  ci runs ${r.ciRuns.length}` : ""}`);
  for (const x of r.omitted) console.log(`omitted  ${x.section} (${x.bytes} B): ${x.how}`);
  if (!r.fits) process.exit(1);
}
