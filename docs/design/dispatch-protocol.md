# The dispatch and verdict protocol as product — `retrace_send`, `retrace_verify_send`, the verdict shape (design note v1)

**Status:** v1.2, 2026-10-12, by claude-code (the "system optimization" pane; `claude-mythos-5-1`, model source
harness-runtime, effort high). v1.1 was the fix round for Codex's round-1 verdict `evt_6db893faeafc4f12a8b6c6af5c25001c`
(3 High, 6 Medium, 2 Low at `6ac80c98`), on the coordinator's verified pointer `evt_7a0fff88…`; its changes are listed in
§4a. **v1.2 is the fix round for Codex's round-2 verdict `evt_841c4bb7af364d90917c1a7a96fbe8c5` (2 High, 5 Medium at
`9aca8b37`), on the coordinator's verified pointer `evt_ad06f82c…`; its changes are listed in §4b.** Every sentence of this
note was checked against the code at v1.2 (Codex r2 M5). Class **(a)** under agent-rules 12: it governs how seats dispatch to each other and what a
review verdict must carry, and it ships the code that does both (class c for the MCP server, with one validator shared
with the doctor). Written and built on Jordan's signed go `evt_c83cad7552a149a5940b27a0bcc84b0b` ("Let's go on your top 3
items starting with 1", received `evt_85ad930c…`), item 1 of `~/.retrace/ops-2026-10-11/system-optimization/OPTIMIZATION-PLAN.md`
(sha256 `499d1ee9…3527`, created `evt_71b02714…`). It builds what agent-ops 18 names as its own retirement condition:
"a `retrace-send` helper does (b) and (c) of agent-rules 15 itself … and a narrow `retrace_verify_send` tool exposes
exactly the six fields a receiver checks". It changes no rule text; the follow-up that strikes the by-hand steps from
agent-ops 18 is a separate class (a) PR after the measurement in §6.

## 0. The question and the answer

**Question.** Every pane dispatch in this environment is composed by hand: a 240-byte pointer, a `sent` event with two
hashes, an `orca-ide terminal send`, a check that the line moved, and on the other side a raw `GET /events/<id>` and six
comparisons before a `received` record. Can the product do it, without moving a credential out of the seat that owns it
or weakening a check?

**Answer.** Yes, as two tools of each seat's **own** MCP server, which already holds that seat's pinned credential and
producer key (agent-rules 13), and one validator for review verdicts:

- `retrace_send` does agent-rules 15 (b) and (c) and agent-ops 18's order of operations in one call: envelope and byte
  rules, the owner-envelope guard, the brief bound to the name in the text, the pane registry (agent panes only, bound to
  Orca's live identity and incarnation), two empty-composer reads, the `sent` event under the seat's credential, the send
  with the suffix (the tool presses Enter), a post-send read that proves delivery or says it could not, an outcome record.
  A refusal writes nothing.
- `retrace_verify_send` does the receiver's part: split the suffix, read the event raw with the seat's own credential,
  the six checks of rule 15 plus the receiver binding (addressed to this seat at this terminal) and the brief binding (the
  brief the text names is the brief the event sealed), a `received` record naming `verified | missing | mismatch |
  unverifiable` and the failing check, written on every path.
- `reviewVerdictProblem` (core) makes a verdict's findings counts, routing id, reviewed head and blocking answer part of
  the sealed record: the MCP server refuses a verdict without them; the doctor reports verdicts that lack them.

What this does **not** do: it does not relax any check (§3 lists each one and where it runs), it does not touch the NOOA
dispatch (a packet pushed over ssh, item 2 of the plan), and it does not decide a pane is a human's by guessing — the
operator says so in a registry, and anything not listed is refused.

## 1. Evidence (FINDINGS.md M3 and M6 of the same pane, read 2026-10-11 20:4x–21:0xZ)

| measured | value |
|---|---|
| coordinator `orca-ide terminal send` events since 10-01 | 216 (473 in the whole ledger) |
| coordinator raw `GET /events/<id>` verification events since 10-01 | 43 |
| coordinator events per review round, PR 220 | 41 over 4 rounds (routing 8, push-and-launch 7, declarations/outcomes 10, stop-rule 5, sends 4) |
| refusals caused by a malformed pointer this week | 2 (10-11 00:2xZ: abbreviated id in the suffix and no `text_sha256` on the sent event; 10-11 22:0xZ (10-10): a Codex line that needed a second Enter) |
| review verdicts on PRs 193/198/201/218/219/220 | 55; 17 carried `findings: None` in params (counts only in prose); 1 `rejected` with only Low findings that said of itself "this rejection does not block" (NOOA, PR 220 r3) |
| Cursor fold limit that fixed the 240-byte line | measured 2026-09-24 (`evt_7b1b2a4f…`); Cursor is not a live seat today (free plan refuses named models, STATE 10-10 05:2xZ) — the limit stays because the rule stays |

## 2. The protocol, as built

**Sender (`retrace_send`).** Inputs: `to` (Orca terminal handle), `receiver` (actor id), `text`, optional `brief_path`,
optional `routing_event_id`, `caused_by`, optional `intent`. There is no `enter_pressed_by` input: the tool always sends
with `--enter` and seals `enter_pressed_by: "retrace_send (tool)"` (Codex r2 M4). Order:

1. **Registry.** `~/.retrace/panes.json` (or `RETRACE_PANES_FILE`): `{"<handle>": {"seat": "<actor id>", "kind":
   "agent"|"human", "agent_identity": "<Orca's agentIdentity: claude|codex|grok|…>", "incarnation_id": "<Orca's
   incarnationId for the pane>"}}`. Not listed → `unknown_pane`. `kind: human` → `human_pane`. `seat ≠ receiver` →
   `receiver_mismatch`. No file → `registry_missing`; an agent entry without `agent_identity` or `incarnation_id` →
   `registry_invalid`. The registry is the operator's statement of which panes take dispatches; "never send into a
   human's pane" is enforced by it, not inferred from a title (Jordan types into panes titled like agents). **Step 4 binds
   it to Orca's live label and live incarnation**, so a stale, relaunched or reused handle is refused, not trusted (Codex
   r1 M4, r2 M3).
2. **Text.** One line; no leading or trailing whitespace; ≤ 190 bytes (so ≤ 240 with the 50-byte suffix); starts with
   `SEAT ` and ends with ` SEAT` where SEAT is this server's configured actor id upper-cased; no enveloped span `JD … JD`
   (`owner_envelope_forbidden`; owner-protocol §5) — a lone `JD` token, as in a message that talks about the envelope, is
   allowed (Codex r1 L2); no `[sent-event ` inside. Each failure is a word.
3. **Brief.** The text names a brief in one of three forms: `~/…`, `/…`, or `brief <dir>/<file>` relative to one
   `~/.retrace/ops-<date>/` directory (the form the coordinator's pointers use, e.g. `brief pr222/BRIEF-222-r2.md`). When
   it does, `brief_path` is required (`brief_required`) **and must denote that same file** — equal after `~` expansion and
   normalisation for the first two forms, `<home>/.retrace/ops-<date>/<name>` for the third — else `brief_name_mismatch`
   (Codex r2 H1: a pointer naming A can no longer seal B). The file is read and hashed over its **exact bytes** (sha256,
   full 64 hex; never a decoded and re-encoded string, Codex r1 M6) before anything is written; missing →
   `brief_missing`, unreadable (a directory, a permission error) → `brief_unreadable`.
4. **Pane.** `orca-ide terminal list --json` must list the handle (`pane_not_live`), writable, **its `agentIdentity`
   must equal the registry entry's `agent_identity`** (`identity_mismatch`), **and its `incarnationId` must equal the
   entry's `incarnation_id`** (`incarnation_mismatch`): Orca gives a pane a new incarnation id when it is relaunched, so
   a handle that now hosts another incarnation of the same agent, or a pane a human has taken over since it was
   registered, is refused until the operator re-registers it after reading the pane (Codex r2 M3).
5. **Gate.** Two `terminal read --screen --json` reads, 3 s apart; both must show an empty composer (last rendered line
   matches the harness's empty prompt — `❯`, `›`, `» Ask Codex to do anything` — and no `draft`); else `composer_not_empty`.
   Nothing rendered counts as not empty.
6. **Seal.** `sent` event, `action_detail: pane-message`, under the seat's credential and producer key: artifacts `pane:<handle>`
   (generated), the brief (used), the routing event (used); params `text_sha256`, `text_bytes`, `brief_path` (resolved,
   absolute), `brief_sha256`, `brief_bytes`, `brief_named` (the name as written in the text), `routing_event_id`,
   `target_terminal`, `receiver_seat`, `enter_pressed_by` (the constant), `target_agent_identity` and
   `target_incarnation_id` (Orca's label and incarnation for the pane), `pane_binding: "handle+identity+incarnation"`,
   `gate`; `caused_by` as given.
7. **Last look, then send.** One more screen read; if the composer filled during the write, nothing is sent and the
   outcome says so. Otherwise `terminal send --terminal <h> --text "<text> [sent-event <id>]" --enter --json`.
8. **Outcome.** `executed` event, `caused_by` the sent event, with Orca's receipt and what the post-send screen proved.
   `delivered` has three values (Codex r1 M2, r2 M2). **`true` only on positive evidence:** the read succeeded, Orca
   returned the rendered screen (`source: screen`), it is non-empty, the line is not on the last row or in the draft, and
   it is echoed on an earlier row — the harness took it into its transcript. **`false`** when the line (or its first 40
   characters, or a ≥ 24-character prefix cut off by the screen width, or its `[sent-event <id>]` suffix after a wrap) is
   on the last row or in the draft: `line_sits_in_composer`, the measured second-Enter failure; or when the CLI itself
   failed. **`"unknown"`**, with the reason, for everything the screen cannot settle: `post_send_read_failed`,
   `post_send_screen_unavailable`, `post_send_screen_empty`, or `line_not_on_screen` after a second read one gate
   interval later (lag, or a frame that scrolled). The `executed` event's `action_detail` says which (`delivered`, `not
   delivered`, `delivery unknown`) and its params carry `delivered`, `accepted`, the reason and the frame's last line. The
   caller sees `delivered`, `accepted`, both ids and the exact line; on `false` or `"unknown"` it reads the pane before
   relying on the send. A human pressing Enter on a sitting line is that human's keystroke, logged by the human, not this
   tool's act.

**Receiver (`retrace_verify_send`).** Inputs: the received line as it arrived, optional `brief_path` (when given it
must be the brief the text names), optional own `caused_by`, optional `intent`. Order: split the suffix (no suffix →
`missing`); `GET /events/<id>` raw with the seat's own credential (the MCP server's store; `retrace_why`/`retrace_history`
are not used); the brief to read is the one the text names, resolved from the name itself for `~/…` and `/…` and through
the event's `brief_path` for the relative form; then the checks in order — envelope on the received text, event exists,
`action: sent`, `actor.id` is the envelope's seat, `sealed_by` is `pinned:` **and the credential it names is the envelope's
seat** (a pinned seal of another seat fails; Codex r1 M3), `producer_sig_verdict: verified`, **`receiver_seat` equals this
server's actor id and `target_terminal` equals this server's own terminal handle** (`ORCA_TERMINAL_HANDLE`, which Orca sets
in every pane's environment and the agent's MCP server inherits, or `RETRACE_TERMINAL`; a server that knows neither fails
this check as `unverifiable` and says so — Codex r2 H2: a valid dispatch to codex at X is not a dispatch to grok, nor to
codex at Y), `text_sha256` equals the sha256 of the received text with the suffix removed (the suffix is the final bytes,
nothing after it; L1), **`brief_path`: the brief the text names is the brief the event sealed and, when the receiver passed
one, the brief it passed** (Codex r2 H1: a pointer naming A never verifies against B, and the relative form no longer
verifies with no brief), `brief_sha256` equals the brief on disk: text names a brief and the event records no hash or path →
`mismatch`; the event records a hash and the brief could not be read → `unverifiable`, with the read error (`EISDIR`,
`ENOENT`) in the check (Codex r2 M1). Every step between the split and the receipt runs inside one guard, so an exception
becomes a named failing check, never a return without a record; if the receipt write itself fails the tool says **no
received record was written** and `act: false`. Then the `received` record, **always sealed** (v1 had a dry-check option
that returned `act: true` without a receipt; Codex r1 H2): `input_signature`, `sent_event_id`, `sender`, `failure`, every
check's result, the text hash, the brief path and hash read, `receiver_seat` and `receiver_terminal` (or `unknown`);
**`caused_by` is the sent event only when verified**, so a verified dispatch links the receiver's chain to the sender's
(and through it to the owner's instruction, agent-ops item 20); an unverified receipt links to the receiver's own root if
given, else to nothing. The tool returns `act: true` only on `verified` with a receipt written, and marks every other
result as an error for the calling model.

**Verdict shape (`reviewVerdictProblem`).** Applies to agent events `approved` / `rejected` that are verdicts (tag
`review`, or `action_detail` `reviewed`/`review`; never routing events). Required in `method.params`: `findings:
{high, medium, low}` (non-negative integers), `routing_event_id` (full id), `reviewed_head` (the **full 40-hex** sha),
`blocking` (boolean). **The blocking answer is derived, never declared** (team-roles rule 8): `blocking` must equal
`high + medium > 0`; an `approved` verdict carries no High or Medium; a `rejected` verdict with only Low findings is
sealed as a non-blocking rejection. There is no reason field that can invert the gate (v1 had `blocking_reason` /
`accepted_reason`; Codex r1 H1 showed they let a Medium be sealed non-blocking). The MCP server's `retrace_log` refuses a verdict that fails this
(`review verdict refused: …`); the doctor's review-effort findings add a `review verdict shape` warning counting
verdicts that lack it, **from the shape's own adoption**: the first verdict in the ledger that carries a boolean `blocking`,
found by the same bounded targeted history scan the routing findings use for routing adoption (text `"blocking":`), so
adoption outside the 200-event window is not forgotten (Codex r1 M5) and no verdict is held to a shape nobody had yet. NOOA writes verdicts over HTTP with its own key, outside this server;
its verdicts show up in the doctor's count until its review agent adopts the shape (item 2 of the plan carries that).

## 3. Each check, and where it now runs

| agent-rules 15 / agent-ops 18 says | by hand until now | now |
|---|---|---|
| envelope `SEAT … SEAT`, pinned id upper-cased, no alias | the sender types it | `paneTextProblem` → `envelope_missing` |
| one line, ≤ 240 bytes with the suffix, no trailing whitespace | the sender counts | `too_long`, `multi_line`, `trailing_whitespace` |
| the owner's envelope is never used by an agent (§5) | a rule sentence | `owner_envelope_forbidden`, before any write |
| `sent` logged **before** the send, with text and brief sha256, target, who presses Enter | three steps, two hashes | one write; the suffix is appended only after the id exists; the tool presses Enter and the record says so |
| the brief a pointer names is the brief that was hashed | the sender's care | `brief_name_mismatch` on send; `brief_path` check on verify; one resolution rule for the three name forms |
| never send into a human's pane | the sender knows | the registry bound to Orca's live `agentIdentity` and `incarnationId`; unknown, mismatched or relaunched → refused |
| read the pane before sending; a human may be typing | two reads 3 s apart by hand | two reads, then a third after the write |
| the line left the composer | the sender reads the pane again | `delivered: true` only when the screen shows the line in the transcript; `false` when it sits; `"unknown"` with the reason otherwise |
| receiver reads the event raw, six checks, then `received` | `curl` with the token from env, six comparisons | `retrace_verify_send`; one `received` record with every check's result, written on every path; the pinned credential must name the seat; the dispatch must be addressed to this seat at this terminal; the named brief must be the sealed brief and must hash |
| the verdict of record self-reports effort and cites the routing event | partially (17 of 55 without counts) | counts, full head, routing id, blocking derived from severity: refused without them |

Nothing is checked less. Four things are checked more: the owner-envelope span (previously only a rule), the verdict's
blocking answer (previously prose), the receiver binding (previously nothing stopped another seat acting on a dispatch it
could read) and the brief binding on both sides (previously the pointer's name and the hashed file were independent).

## 4. What it costs and what it risks

- **Provenance.** No evidence is removed. Two events per send (sent + outcome) replace the two or three the coordinator
  logs by hand today. A refused send writes nothing, which is the same as today (a refusal was never a send).
- **Credential custody.** Unchanged: the tools run inside the seat's MCP server, which already holds the pinned token
  and the producer key. No token passes through a shell, a pane or an argument. The owner token in the pane's environment
  is not used (the server's env is the MCP config's, not the shell's).
- **Registry maintenance.** A new file per seat host, kept by the operator (the coordinator when it creates panes). Each
  agent entry carries Orca's `agentIdentity` and `incarnationId` for the handle (both from `orca-ide terminal list
  --json`); a pane relaunched, restored or reused since it was registered has a new incarnation id and is refused until
  re-registered after the pane has been read. This costs one registry edit per relaunch; it buys that a handle is never
  trusted from a declaration about a pane that no longer exists.
- **The receiver's own terminal.** `retrace_verify_send` binds a dispatch to the terminal it was addressed to, so each
  seat's MCP server must know which pane it runs in: Orca sets `ORCA_TERMINAL_HANDLE` in every pane's environment and the
  agent process hands its environment to the MCP server; `RETRACE_TERMINAL` overrides it. A server with neither (a seat
  started outside Orca) cannot make the check and every receipt it writes is `unverifiable` with that reason — fail closed,
  stated, until the operator configures it.
- **Delivery is three-valued.** A `sent` event stands whatever the screen later shows; the outcome record says `true`,
  `false` or `"unknown"` and why. `"unknown"` is not a defect of the tool, it is the screen not proving the claim; the
  coordinator reads the pane before relying on such a send, as it does today after a hand send.
- **Race.** The composer gate is not race-free (measured 10-07: typing began in a sub-second gap). The third read after
  the write narrows it; the outcome record states what the screen showed after the send, so a collision is on record.
- **Local stores.** On a local SQLite ledger nothing stamps `sealed_by`, so `retrace_verify_send` fails `sealed_by` by
  design: a local ledger is not a pinned seal, and the test asserts that.
- **Historical verdicts.** Verdicts sealed before the first shaped verdict are not counted (adoption rule above); after
  it, every verdict without the shape is counted in a warn, never a gate failure. The count is the measurement in §6.

## 4a. Fix round 1 (Codex `evt_6db893fa…`, applied in v1.1)

| finding | change |
|---|---|
| H1 severity gate invertible | `blocking` derived from counts; approval with High/Medium refused; Low-only rejection sealed non-blocking; reason fields refused |
| H2 act without receipt | `log_received` removed; the receipt is always sealed |
| H3 brief not bound | `briefNamedIn(text)`: a text naming a brief needs `brief_path` on send and a hash match on verify |
| M1 short heads | `reviewed_head` must be 40 hex |
| M2 sitting line sealed as delivered | delivered requires the post-send screen to show the line gone; `line_sits_in_composer` outcome |
| M3 pinned seal of any seat | the credential name must carry the envelope's seat id |
| M4 stale registry | `agent_identity` required in the registry and compared with Orca's live label |
| M5 adoption forgotten outside the window | bounded targeted scan for `"blocking":`, surfaced in the loader's scope |
| M6 hash of re-encoded text | sha256 over the file's exact bytes |
| L1 bytes after the suffix | exact suffix at the end of the line, no newline stripping |
| L2 lone `JD` token refused | only a `JD … JD` span is refused |

**Not changed in v1.1, and why:** PR 225's host wrapper v2 then encoded v1's `REASON:` rule (blocking_reason /
accepted_reason); the coordinator's brief said not to touch PR 225, so its alignment to the derived rule was its own fix
round (PR 225 round 1, head `248440f3`, aligned it; round 2, `d71d62a7`, kept the alignment).

## 4b. Fix round 2 (Codex `evt_841c4bb7…`, applied in v1.2)

| finding | change |
|---|---|
| H1 named brief bypassable (relative form unrecognised; name and `brief_path` never compared) | `briefNamedIn` recognises `~/…`, `/…` and `brief <dir>/<file>`; `briefPathNames` is the one resolution rule on both sides; send refuses `brief_name_mismatch`; verify adds the `brief_path` check (event's path, and the receiver's when given, must be the named brief); the relative form resolves only through the event's `brief_path` |
| H2 a valid dispatch replays into another seat | `verifySentEvent` takes the verifying seat and its terminal; `receiver_seat` and `target_terminal` checks; the terminal comes from `ORCA_TERMINAL_HANDLE` / `RETRACE_TERMINAL`; unknown → `unverifiable`, stated |
| M1 receipt not guaranteed | every step after the split runs in one guard; a brief that is a directory becomes a failing `brief_sha256` check with `EISDIR` in it; an exception becomes a `verification` check; a failed receipt write is reported as no record written, `act: false` |
| M2 `delivered: true` on unreadable, truncated or lagging screens | three-valued delivery from positive evidence only (`deliveryFromScreen`): read error, unrendered or empty frame, line nowhere → `"unknown"` with the reason; a cut-off or wrapped sitting line → `false`; one more read after the gate interval before `line_not_on_screen` is final |
| M3 same-identity pane reuse unbound | Orca exposes `incarnationId` per terminal; the registry requires `incarnation_id` for agent panes, the live value must match (`incarnation_mismatch`), the sent event records `target_incarnation_id` and `pane_binding` |
| M4 `enter_pressed_by` caller-forgeable | the input is removed; the tool seals the constant `retrace_send (tool)` on the sent and outcome events, since it always passes `--enter` |
| M5 note contradicts code | §2 step 2 states the lone-token rule as implemented; `log_received` is gone from the receiver's inputs; §8 → §4a; this note re-read against the code at v1.2 |

Where a claim was removed rather than a mechanism added: §4's sentence that same-identity reuse "needs a per-incarnation
binding, named in §7" is gone because the binding is built; nothing else in this round removed a claim, each finding had a
check the code could make.

## 5. Rollout

1. This PR: core (`dispatch.ts`, `review-verdict.ts` + tests), MCP server (`dispatch-mcp.ts`, registration, the
   `retrace_log` guard + tests), doctor warning, `docs/reference.md` rows, this note. Class (a) gate (Codex, NOOA; Grok
   measures the counts in §1 if routed).
2. On merge: each seat's MCP server runs the checkout's `dist` (agent-ops 3/4/7), so the tools appear after the primary
   checkout is rebuilt at an idle moment and the panes are restarted. Each seat host gets a `~/.retrace/panes.json` with
   `agent_identity` and `incarnation_id` per agent pane, refreshed when a pane is relaunched; a seat started outside Orca
   gets `RETRACE_TERMINAL` in its MCP config, or its receipts stay `unverifiable`.
3. The coordinator uses `retrace_send` for every pane dispatch and `retrace_verify_send` for every receipt; reviewers
   seal verdicts with the shape (Codex and Grok through this server; NOOA's `review_agent.py` in item 2's PR).
4. After two weeks: measure §6; then a class (a) PR strikes the by-hand steps from agent-ops 18 and adds the verdict
   shape to agent-rules 11's text (the rule itself already says the verdict "self-reports … and cites the routing decision").

## 6. The measurement that proves it worked

From the ledger, over the first two weeks after rollout, compared with 10-01 → 10-11:
- coordinator `orca-ide terminal send` events logged by hand (tool `orca-ide terminal send` with no `retrace_send` sent event) → 0;
- raw `GET /events/<id>` verification events by hand → 0;
- `received` records with `input_signature` other than `verified` → listed, each with its failure word (they are the
  refusals working, not a defect);
- review verdicts since adoption lacking the shape → only NOOA's until item 2, then 0;
- pointer-shape refusals by receivers (the 10-11 class) → 0.

## 7. Open items, not in this PR

- A `keystroke` mode (log one Enter without a message) for the Codex composer case, so that keystroke is a tool act too.
- The NOOA dispatch (`push-and-launch.sh`) as a tool, with the packet builder: plan item 2.
- The `tree_match` rule for head-only re-reviews: plan item 4, a rule change, not built here.
- The Worker enforcing the verdict shape on `POST /events` (class S): after the seats adopt it through the tool.
