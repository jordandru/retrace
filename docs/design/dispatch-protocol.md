# The dispatch and verdict protocol as product — `retrace_send`, `retrace_verify_send`, the verdict shape (design note v1)

**Status:** v1, 2026-10-11, by claude-code (the "system optimization" pane; `claude-mythos-5-1`, model source
harness-runtime, effort high). Class **(a)** under agent-rules 12: it governs how seats dispatch to each other and what a
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
  rules, the owner-envelope guard, the pane registry (agent panes only), two empty-composer reads, the `sent` event
  under the seat's credential, the send with the suffix, a post-send read, an outcome record. A refusal writes nothing.
- `retrace_verify_send` does the receiver's part: split the suffix, read the event raw with the seat's own credential,
  the six checks, a `received` record naming `verified | missing | mismatch | unverifiable` and the failing check.
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
optional `routing_event_id`, `caused_by`, optional `intent`, `enter_pressed_by` (default `retrace_send`). Order:

1. **Registry.** `~/.retrace/panes.json` (or `RETRACE_PANES_FILE`): `{"<handle>": {"seat": "<actor id>", "kind": "agent"|"human"}}`.
   Not listed → `unknown_pane`. `kind: human` → `human_pane`. `seat ≠ receiver` → `receiver_mismatch`. No file →
   `registry_missing`. The registry is the operator's statement of which panes take dispatches; "never send into a
   human's pane" is enforced by it, not inferred from a title (Jordan types into panes titled like agents).
2. **Text.** One line; no leading or trailing whitespace; ≤ 190 bytes (so ≤ 240 with the 50-byte suffix); starts with
   `SEAT ` and ends with ` SEAT` where SEAT is this server's configured actor id upper-cased; **no standalone `JD` token
   anywhere** (`owner_envelope_forbidden`; owner-protocol §5); no `[sent-event ` inside. Each failure is a word.
3. **Brief.** When named, read and hashed (sha256, full 64 hex) before anything is written; missing → `brief_missing`.
4. **Pane.** `orca-ide terminal list --json` must list the handle (`pane_not_live`) as writable.
5. **Gate.** Two `terminal read --screen --json` reads, 3 s apart; both must show an empty composer (last rendered line
   matches the harness's empty prompt — `❯`, `›`, `» Ask Codex to do anything` — and no `draft`); else `composer_not_empty`.
   Nothing rendered counts as not empty.
6. **Seal.** `sent` event, `action_detail: pane-message`, under the seat's credential and producer key: artifacts `pane:<handle>`
   (generated), the brief (used), the routing event (used); params `text_sha256`, `text_bytes`, `brief_path`, `brief_sha256`,
   `brief_bytes`, `routing_event_id`, `target_terminal`, `receiver_seat`, `enter_pressed_by`, `target_agent_identity`
   (Orca's label for the pane), `gate`; `caused_by` as given.
7. **Last look, then send.** One more screen read; if the composer filled during the write, nothing is sent and the
   outcome says so. Otherwise `terminal send --terminal <h> --text "<text> [sent-event <id>]" --enter --json`.
8. **Outcome.** `executed` event, `caused_by` the sent event, with Orca's receipt and a post-send read (last line,
   composer empty?). The caller sees `delivered`, both ids and the exact line. The Codex "line sits after `»`" case is
   visible in `post_send.last_line`; pressing Enter again is a separate logged keystroke, not this tool's act.

**Receiver (`retrace_verify_send`).** Inputs: the received line as it arrived, optional `brief_path`, optional own
`caused_by`, optional `log_received` (default true). Order: split the suffix (no suffix → `missing`); `GET /events/<id>`
raw with the seat's own credential (the MCP server's store; `retrace_why`/`retrace_history` are not used); the checks
of agent-rules 15 in order — envelope on the received text, event exists, `action: sent`, `actor.id` is the envelope's
seat, `sealed_by` starts `pinned:`, `producer_sig_verdict: verified`, `text_sha256` equals the sha256 of the received
text with the suffix removed, `brief_sha256` equals the brief on disk when the event names one (event names a brief and
none was read → `unverifiable`; a brief was supplied and the event records none → `mismatch`). Then the `received`
record: `input_signature`, `sent_event_id`, `sender`, `failure`, every check's result, the text hash; **`caused_by` is the
sent event only when verified**, so a verified dispatch links the receiver's chain to the sender's (and through it to the
owner's instruction, agent-ops item 20); an unverified receipt links to the receiver's own root if given, else to nothing.
The tool returns `act: true` only on `verified` and marks every other result as an error for the calling model.

**Verdict shape (`reviewVerdictProblem`).** Applies to agent events `approved` / `rejected` that are verdicts (tag
`review`, or `action_detail` `reviewed`/`review`; never routing events). Required in `method.params`: `findings:
{high, medium, low}` (non-negative integers), `routing_event_id` (full id), `reviewed_head` (hex sha), `blocking`
(boolean). `rejected` ⇒ `blocking: true` and (High + Medium ≥ 1 or `blocking_reason`). `approved` ⇒ `blocking: false`,
and High + Medium ≥ 1 needs `accepted_reason`. The MCP server's `retrace_log` refuses a verdict that fails this
(`review verdict refused: …`); the doctor's review-effort findings add a `review verdict shape` warning counting
verdicts that lack it, **from the shape's own adoption**: the first verdict in the ledger that carries a boolean `blocking`
(the same rule the routing findings use for routing adoption), so no verdict is held to a shape nobody had yet. NOOA writes verdicts over HTTP with its own key, outside this server;
its verdicts show up in the doctor's count until its review agent adopts the shape (item 2 of the plan carries that).

## 3. Each check, and where it now runs

| agent-rules 15 / agent-ops 18 says | by hand until now | now |
|---|---|---|
| envelope `SEAT … SEAT`, pinned id upper-cased, no alias | the sender types it | `paneTextProblem` → `envelope_missing` |
| one line, ≤ 240 bytes with the suffix, no trailing whitespace | the sender counts | `too_long`, `multi_line`, `trailing_whitespace` |
| the owner's envelope is never used by an agent (§5) | a rule sentence | `owner_envelope_forbidden`, before any write |
| `sent` logged **before** the send, with text and brief sha256, target, who presses Enter | three steps, two hashes | one write; the suffix is appended only after the id exists |
| never send into a human's pane | the sender knows | the registry; unknown → refused |
| read the pane before sending; a human may be typing | two reads 3 s apart by hand | two reads, then a third after the write |
| receiver reads the event raw, six checks, then `received` | `curl` with the token from env, six comparisons | `retrace_verify_send`; one `received` record with every check's result |
| the verdict of record self-reports effort and cites the routing event | partially (17 of 55 without counts) | counts, head, routing id, blocking: refused without them |

Nothing is checked less. Two things are checked more: the owner-envelope token (previously only a rule) and the
verdict's blocking answer (previously prose).

## 4. What it costs and what it risks

- **Provenance.** No evidence is removed. Two events per send (sent + outcome) replace the two or three the coordinator
  logs by hand today. A refused send writes nothing, which is the same as today (a refusal was never a send).
- **Credential custody.** Unchanged: the tools run inside the seat's MCP server, which already holds the pinned token
  and the producer key. No token passes through a shell, a pane or an argument. The owner token in the pane's environment
  is not used (the server's env is the MCP config's, not the shell's).
- **Registry maintenance.** A new file per seat host, kept by the operator (the coordinator when it creates panes). A
  stale entry (handle reused by a different pane) is caught by Orca's `agentIdentity` only loosely: the sent event
  records `target_agent_identity` so a reader can see a Codex-registered handle that Orca labels `claude`. A stricter
  binding (handle → `incarnationId`) is a follow-up, named in §7.
- **Race.** The composer gate is not race-free (measured 10-07: typing began in a sub-second gap). The third read after
  the write narrows it; the outcome record states what the screen showed after the send, so a collision is on record.
- **Local stores.** On a local SQLite ledger nothing stamps `sealed_by`, so `retrace_verify_send` fails `sealed_by` by
  design: a local ledger is not a pinned seal, and the test asserts that.
- **Historical verdicts.** Verdicts sealed before the first shaped verdict are not counted (adoption rule above); after
  it, every verdict without the shape is counted in a warn, never a gate failure. The count is the measurement in §6.

## 5. Rollout

1. This PR: core (`dispatch.ts`, `review-verdict.ts` + tests), MCP server (`dispatch-mcp.ts`, registration, the
   `retrace_log` guard + tests), doctor warning, `docs/reference.md` rows, this note. Class (a) gate (Codex, NOOA; Grok
   measures the counts in §1 if routed).
2. On merge: each seat's MCP server runs the checkout's `dist` (agent-ops 3/4/7), so the tools appear after the primary
   checkout is rebuilt at an idle moment and the panes are restarted. Each seat host gets a `~/.retrace/panes.json`.
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

- Registry binding to Orca's `incarnationId`, so a handle reused by another pane is refused, not just recorded.
- A `keystroke` mode (log one Enter without a message) for the Codex composer case, so that keystroke is a tool act too.
- The NOOA dispatch (`push-and-launch.sh`) as a tool, with the packet builder: plan item 2.
- The `tree_match` rule for head-only re-reviews: plan item 4, a rule change, not built here.
- The Worker enforcing the verdict shape on `POST /events` (class S): after the seats adopt it through the tool.
