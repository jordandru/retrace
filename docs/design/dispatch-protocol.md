# The dispatch and verdict protocol as product — `retrace_send`, `retrace_verify_send`, the verdict shape (design note v1)

**Status:** v1.5, 2026-10-12. v1 to v1.3 by claude-code (the "system optimization" pane; `claude-mythos-5-1`, model source
harness-runtime, effort high); v1.4 and v1.5 by claude-code (the coverage-audit pane; `claude-opus-5-5`, harness-runtime) on
a handover from that pane for throughput. v1.1 was the fix round for Codex's round-1 verdict `evt_6db893faeafc4f12a8b6c6af5c25001c`
(3 High, 6 Medium, 2 Low at `6ac80c98`), on the coordinator's verified pointer `evt_7a0fff88…`; its changes are listed in
§4a. v1.2 is the fix round for Codex's round-2 verdict `evt_841c4bb7af364d90917c1a7a96fbe8c5` (2 High, 5 Medium at
`9aca8b37`), on the coordinator's verified pointer `evt_ad06f82c…`; its changes are listed in §4b. v1.3 is the fix round
for Codex's round-3 verdict `evt_ea979a1085054bc7858f13cac334357a` (1 High, 2 Medium, 1 Low at `c6ea2d87`), on the
coordinator's verified pointer `evt_939211c9…`; its changes are listed in §4c. v1.4 is the fix round for Codex's round-4
verdict `evt_15db62c90e874719a3f88068d7d527fd` (1 Medium, 1 Low at `51dada16`), on the coordinator's verified pointer
`evt_410d8231…`; its changes are listed in §4d. **v1.5 is the fix round for Codex's round-5 verdict
`evt_d09dbbc057ce4880ad2d63800d8f32e6` (2 Medium, 2 Low at `289e081d`), on the coordinator's verified pointer
`evt_3d1d7ad2…`; its changes are listed in §4e.** Every sentence of this note was checked
against the code at v1.2 (Codex r2 M5) and the changed sentences again at v1.3, v1.4 and v1.5. Class **(a)** under agent-rules 12: it governs how seats dispatch to each other and what a
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
3. **Brief.** A text names a brief in one place only: the bare word `brief`, whitespace, then the brief's path as one
   token, in one of three forms — `~/…`, `/…`, or `<dir>/<file>` relative to one `~/.retrace/ops-<date>/` directory (the
   form the coordinator's pointers use, e.g. `brief pr222/BRIEF-222-r2.md`) — of ASCII letters, digits, `.`, `_`, `-` and
   `/`, ending in a file extension. **Candidates first (Codex r5 M1).** Before anything is bound, every *path-like* token
   in the whole text is found without that grammar — a token with a `/`, `\` or `~` anywhere in it, or one that ends,
   once trailing punctuation is dropped, in a dot followed by letters or digits (`BRIEF.md`, `BRIEF.md.`, `` `x.md` ``,
   `brief:pr222/x.md`, `v1.5`) — and every other token that opens with the word `brief` in any case, wrapped, punctuated
   or joined, is a *brief word* (`brief`, `Brief:`, `(brief`, `brief=x`; `briefly`, `briefs`, `debrief` are other words).
   Neither: the text names no brief. Otherwise the text must read `… brief <path> …` exactly once — one brief word,
   written bare, followed by a path-like token that is the only one in the text and is a supported path with an
   extension — or it is `brief_name_unparseable`, refused naming the offending token. **A dispatch text therefore carries no other path, URL or slash token** (no `https://…`, `221/222`,
   `and/or` or `~240`, and no dotted token that ends like a file, such as `v1.5` or `retrace.dev`), and prose that does is
   refused: that is the accepted cost of a rule that does not depend on knowing every form a path can take. Rounds 3, 4
   and 5 each found a form the binder did not know (a name with a space; `~user/` and a bare name; `brief:path`,
   `brief=path`, a backticked path, and a second backticked path beside a bound one, which verified with that file
   unsealed). When the text binds a brief, `brief_path` is required (`brief_required`) **and must denote that same file**
   — equal after `~` expansion and normalisation for the first two forms, `<home>/.retrace/ops-<date>/<name>` for the
   third — else `brief_name_mismatch` (Codex r2 H1: a pointer naming A can no longer seal B). Paths with whitespace are
   not supported. The file is read and hashed over its **exact bytes** (sha256, full 64 hex; never a decoded and
   re-encoded string, Codex r1 M6) before anything is written; missing → `brief_missing`, unreadable (a directory, a
   permission error) → `brief_unreadable`.
4. **Pane.** `orca-ide terminal list --json` must list the handle (`pane_not_live`), writable, **its `agentIdentity`
   must equal the registry entry's `agent_identity`** (`identity_mismatch`), **and its `incarnationId` must equal the
   entry's `incarnation_id`** (`incarnation_mismatch`): Orca gives a pane a new incarnation id when it is relaunched, so
   a handle that now hosts another incarnation of the same agent, or a pane a human has taken over since it was
   registered, is refused until the operator re-registers it after reading the pane (Codex r2 M3).
5. **Gate.** Two `terminal read --screen --json` reads, 3 s apart; both must show the harness's **composer** empty and no
   `draft`, else `composer_not_empty`, naming the composer row seen or saying that none was found. The composer is found
   by the harness's own layout (`composerOf`, chosen by the registry's `agent_identity`, which step 4 matched to Orca's
   live label), never as the last rendered row: on every harness here the last row is a status row (Codex r5 M2; v1.4's
   gate read the last row and so refused every send, §4e). Layouts, measured on this host's panes 2026-10-12: **Claude
   Code** draws `❯` between two rules of `─`, status rows below; the composer is every row between the last two rules,
   and its first row starts with `❯`. **Codex** draws `› Ask Codex to do anything` at column 0 with indented status rows
   below, and its own output starts at column 0 (`• …`); the composer row is the last row that starts at column 0, which
   must start with `›` (`»` in older builds) and have rows below it. **Grok** draws `│ ❯` inside a box of `╭─` and `╰─`,
   a footer below; the composer is the last box's inner rows, the first starting with `❯`. Empty is a one-row composer
   holding the bare prompt or Codex's placeholder; a pane's `empty_composer` in the registry overrides that pattern. A harness whose layout this code does not know has no
   composer it can find, so the gate refuses. Nothing rendered counts as not empty.
6. **Seal.** `sent` event, `action_detail: pane-message`, under the seat's credential and producer key: artifacts `pane:<handle>`
   (generated), the brief (used), the routing event (used); params `text_sha256`, `text_bytes`, `brief_path` (resolved,
   absolute), `brief_sha256`, `brief_bytes`, `brief_named` (the name as written in the text), `routing_event_id`,
   `target_terminal`, `receiver_seat`, `enter_pressed_by` (the constant), `target_agent_identity` and
   `target_incarnation_id` (Orca's label and incarnation for the pane), `pane_binding: "handle+identity+incarnation"`,
   `gate`; `caused_by` as given.
7. **Last look, then send.** One more screen read; if the composer filled during the write, nothing is sent and the
   outcome says so. Otherwise `terminal send --terminal <h> --text "<text> [sent-event <id>]" --enter --json`.
8. **Outcome.** `executed` event, `caused_by` the sent event, with Orca's receipt and what the post-send screen proved.
   `delivered` has three values, and each rests on the composer as step 5 finds it, never on which row happens to be
   last (Codex r1 M2, r2 M2, r3 M2, r5 M2). **`false`** (`line_sits_in_composer`) only on positive evidence that the line
   is still in the composer: Orca's `draft`, or the composer's own rows, show the start of this send's text (its first 40
   characters, or a prefix of at least 24 ending a row) or its id; or the CLI itself failed (`orca_send_failed`). Only
   `line_sits_in_composer` comes with advice: read the pane, then a human presses Enter as a separately logged keystroke.
   **`true`** only on positive evidence: the read succeeded, Orca returned the rendered screen (`source: screen`), the
   composer is found and does not hold the line, and a transcript row above it shows the start of the text **with this
   send's `[sent-event <id>]` on that row or in its continuation run**: the rows after it, leading indentation dropped,
   joined without a separator (a wrap may split the id), until the run holds as many characters as the line or reaches
   the composer. That bound is the line's own length in content characters, so it holds at every width with no row cap
   (Codex r5 L1: v1.4 capped the run at 12 rows, ceil(240 / 20), which assumed 20 content columns; a two-column prompt
   makes a 240-byte line 13 rows at 20 columns). At width W, with a P-column prompt and I-column indentation, an
   L-character line spans 1 + ⌈(L − (W − P)) / (W − I)⌉ rows when the harness breaks rows at the column limit. The first
   row must show 24 characters of the text after the prompt, so **the narrowest pane in which delivery can be proved is
   the prompt's width plus 24 columns: 26 for a two-column prompt** (`> `, `❯ `, `› `; Codex measured 26), more if the
   harness breaks rows at word boundaries; narrower, delivery is `"unknown"`. A row that shows the text with no id, or
   with another id, is a transcript of some earlier send of the same words and proves nothing about this one:
   `"unknown"`, `stale_prefix_only`. **`"unknown"`**, with the reason, for everything else the screen cannot settle:
   `post_send_read_failed`, `post_send_screen_unavailable`, `post_send_screen_empty`, `composer_not_on_screen` (an echo
   that ends the screen, an unrelated last row such as `]`, output or a dialog where the composer was, a harness whose
   layout is not known), `line_not_on_screen` (lag, a frame that scrolled, or a pane narrower than the minimum), or
   `stale_prefix_only`; the last three after a second read one gate interval later. `"unknown"` carries no advice to
   press Enter. The `executed` event's `action_detail` says which (`delivered`, `not delivered`, `delivery unknown`) and
   its params carry `delivered`, `accepted`, the reason, the frame's last line and the composer row. The caller sees
   `delivered`, `accepted`, both ids and the exact line; on `false` or `"unknown"` it reads the pane before relying on
   the send. A human pressing Enter on a sitting line is that human's keystroke, logged by the human, not this tool's act.

**Receiver (`retrace_verify_send`).** Inputs: the received line as it arrived, optional `brief_path` (when given it
must be the brief the text names), optional own `caused_by`, optional `intent`. Order: split the suffix (no suffix →
`missing`); `GET /events/<id>` raw with the seat's own credential (the MCP server's store; `retrace_why`/`retrace_history`
are not used); the brief to read is the one the text names, **resolved to exactly one path**: the name itself for `~/…`
and `/…`, the event's `brief_path` for the relative form (Codex r3 H1: two `ops-*` directories can carry the same tail,
and only the event's is the brief); then the checks in order — envelope on the received text, event exists,
`action: sent`, `actor.id` is the envelope's seat, `sealed_by` is `pinned:` **and the credential it names is the envelope's
seat** (a pinned seal of another seat fails; Codex r1 M3), `producer_sig_verdict: verified`, **`receiver_seat` equals this
server's actor id and `target_terminal` equals this server's own terminal handle** (`ORCA_TERMINAL_HANDLE`, which Orca sets
in every pane's environment and the agent's MCP server inherits, or `RETRACE_TERMINAL`; a server that knows neither fails
this check as `unverifiable` and says so — Codex r2 H2: a valid dispatch to codex at X is not a dispatch to grok, nor to
codex at Y. **What this check is, and is not:** `ORCA_TERMINAL_HANDLE` is what Orca told the pane, and `RETRACE_TERMINAL`
is what the operator configured; both are read by a server running under the seat's own credential. The check is an honest
seat naming its own pane — a same-credential configuration check — not pane authentication: another MCP server started
with the same seat credential could set the same handle and claim it. What it refuses is a dispatch addressed to another
seat, or to another terminal of this seat; it does not prove which process at that terminal is reading (Codex r3 L1)),
`text_sha256` equals the sha256 of the received text with the suffix removed (the suffix is the final bytes, nothing after
it; L1), **`brief_path`: the text cannot be bound to one brief → `brief_name_unparseable`, nothing bound (r3 M1; the same
rule as the sender's step 3, so a path-like token outside `brief <path>`, a second one, or a word `brief` that is not bare
or not followed by a supported path fails here with the receipt sealed and `act: false`, r4 M1, r5 M1); otherwise
the name resolves to the event's `brief_path`, and a receiver-supplied path must equal that one path after normalisation
— a same-tail file in another `ops-*` directory is `brief_path_mismatch`** (Codex r2 H1, r3 H1: a pointer naming A never
verifies against B, the relative form never verifies with no brief or with a different brief, and the receiver cannot
substitute its own file), `brief_sha256` equals the brief on disk (the event's path, the one that was read): text names a brief and the event records no hash or path →
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
| the brief a pointer names is the brief that was hashed | the sender's care | `brief_name_mismatch` and `brief_name_unparseable` on send (path-like tokens found without the binder; one bare `brief <path>`, no other path, URL or slash token); `brief_path` check on verify resolving the name to the event's one path, the receiver's path equal to it or refused |
| never send into a human's pane | the sender knows | the registry bound to Orca's live `agentIdentity` and `incarnationId`; unknown, mismatched or relaunched → refused |
| read the pane before sending; a human may be typing | two reads 3 s apart by hand | two reads of the harness's composer, found by its layout, then a third after the write |
| the line left the composer | the sender reads the pane again | `delivered: true` only when the screen shows the line with this send's id in the transcript above the composer; `false` only when the composer itself holds it; `"unknown"` with the reason otherwise (a same-words row without the id, or no composer on screen, included) |
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
  stated, until the operator configures it. The override is a same-credential configuration trust boundary, not pane
  authentication (Codex r3 L1): a second server under the same seat credential can set the same handle, so the check
  distinguishes seats and terminals, not processes at one terminal; that is what the seat's credential custody is for.
- **Delivery is three-valued.** A `sent` event stands whatever the screen later shows; the outcome record says `true`,
  `false` or `"unknown"` and why. `"unknown"` is not a defect of the tool, it is the screen not proving the claim; the
  coordinator reads the pane before relying on such a send, as it does today after a hand send.
- **Layouts.** The composer is found per harness (Claude Code, Codex, Grok), from layouts measured on this host. A new
  harness, or a harness that changes how it draws its composer, makes the gate refuse (`composer_not_empty`, "no …
  composer on screen") and delivery `"unknown"` until `composerOf` learns it: fail closed, and stated in the refusal.
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

## 4c. Fix round 3 (Codex `evt_ea979a10…`, applied in v1.3)

| finding | change |
|---|---|
| H1 a receiver-supplied same-tail file in another `ops-*` directory verified while the event's file was read | the name resolves to exactly one path (the event's `brief_path`; an absolute name to itself); a receiver path must equal it after normalisation, else `brief_path_mismatch`; `briefPathNames` stays the sender-side "may this path carry that name" rule |
| M1 a brief name with a space was bound to its prefix | `briefNameProblem`: a name without a file extension, or followed by a path-like token, is `brief_name_unparseable`; refused on send, a failing `brief_path` check on verify; nothing bound |
| M2 a stale transcript row proved a new send delivered | delivery evidence requires this send's id on the echoed row or its wrapped continuation (joined, so a split id still matches); a prefix-only row is `stale_prefix_only` → `"unknown"`, re-read once |
| L1 the terminal override's trust boundary unstated | §2 and §4 say it: a same-credential configuration check, an honest seat naming its pane, not pane authentication |

## 4d. Fix round 4 (Codex `evt_15db62c9…`, applied in v1.4)

Written by the coverage-audit pane on the coordinator's handover (this note's author pane was on PRs 225 and 226 and near
its usage limit).

| finding | change |
|---|---|
| M1 a `~user/…` path or a bare filename after `brief` named no brief, so the pointer verified with none sealed | `briefNameUnparseable` (core `dispatch.ts`): the word `brief` is reserved, and the token after it must be the bound name, whole; a `~user/…` path anywhere and a second brief name are unparseable too; `retrace_send` refuses naming the token, `retrace_verify_send` fails `brief_path` with the receipt sealed and `act: false`; tests on both sides for `~other/pr222/BRIEF.md` and `BRIEF.md` |
| L1 at 59 columns the id sat beyond the prefix row and two continuation rows, so delivery stayed `"unknown"` | `deliveryFromScreen` (`dispatch-mcp.ts`) follows the continuation run, indentation dropped, up to 12 rows; a last row that is a tail of this line is `line_sits_in_composer`, which also closes v1.3's `true` for a wrapped line still in the composer with only `]` on its last row; regressions at 40 and 59 columns, plain and indented, echoed, sitting and stale |

**v1.5 replaced these mechanisms (§4e):** the word `brief` now binds only when written bare, and every path-like token
is found without the binder; the 12-row cap became the line's own length; the tail-of-line rule became the composer found
by its layout.

## 4e. Fix round 5 (Codex `evt_d09dbbc0…`, applied in v1.5)

The rule chosen for M1 is the coordinator's: find path candidates first, without the binder, and bind exactly one, in
the one supported position, or refuse. Rounds 3, 4 and 5 each found a path form outside the binder, so v1.5 stops
enumerating forms.

| finding | change |
|---|---|
| M1 visible brief candidates bypassed binding: `brief:pr222/x.md`, `brief:/tmp/x.md`, `brief=pr222/x.md` and a backticked `/tmp/A.md` verified with no brief; `brief /tmp/A.md` beside a backticked `/tmp/B.md` verified with only A sealed | `parseBriefName` (core `dispatch.ts`) finds every path-like token and every `brief` word in the whole text first (`pathLikeToken`); the text must read `brief <path>` exactly once with no other path-like token, the word bare (v1.4 also accepted `Brief:` and `(brief`), or it is `brief_name_unparseable`: refused on send, a failing `brief_path` check on verify with the receipt sealed and `act: false`. The same path written twice is a second token and is refused. Regressions on both sides for Codex's five probes; passes for `… r5 289e081d brief pr222/BRIEF-222-r5.md sha256 <64 hex> rt evt_<32 hex> …`, for the round-5 pointer as sent and for a report line with no path |
| M2 an echo that ends the screen, or an unrelated last row of only `]`, was `line_sits_in_composer`, and the tool told a human to press Enter | `composerOf` (`dispatch-mcp.ts`) finds the composer by the harness's layout (§2 step 5); `false` only when the draft or the composer's own rows hold the line; no composer found is `"unknown"`, `composer_not_on_screen`, with no Enter advice. Tests: the echo at screen end and the unrelated `]` on each layout, Codex's composer replaced by output, an unknown harness, and the tool's outcome text |
| L1 the stated 20-column bound was false (13 rows at 20 columns; 26 is the true minimum) | the run is bounded by the line's own length in characters, with no row cap; the minimum is the prompt's width plus 24 columns (26 for a two-column prompt); tested at 26, 40, 59 and 80 columns (true, plain and indented, on Claude Code's and Codex's layouts) and at 25 and 20 (`"unknown"`) |
| L2 the status line said v1.3 | the status line says v1.5 and lists every round, v1.4 and v1.5 among them |
| found in this round: the gate read the last rendered row, which is a status row on all three live harnesses, so `retrace_send` refused every send to every live pane | the gate reads the composer through the same `composerOf`. Replayed on three live panes, each with an empty composer (Claude Code, Codex, Grok), on 2026-10-12: v1.4 `empty` false on all three, v1.5 true. The default empty form now accepts Codex's placeholder after `›` (v1.4 accepted it only after `»`). A screen without the layout's composer is not empty |

## 5. Rollout

1. This PR: core (`dispatch.ts`, `review-verdict.ts` + tests), MCP server (`dispatch-mcp.ts`, registration, the
   `retrace_log` guard + tests), doctor warning, `docs/reference.md` rows, this note. Class (a) gate (Codex, NOOA; Grok
   measures the counts in §1 if routed).
2. On merge: each seat's MCP server runs the checkout's `dist` (agent-ops 3/4/7), so the tools appear after the primary
   checkout is rebuilt at an idle moment and the panes are restarted. Each seat host gets a `~/.retrace/panes.json` with
   `agent_identity` (which also selects the composer layout: `claude`, `codex`, `grok`) and `incarnation_id` per agent
   pane, refreshed when a pane is relaunched; a seat started outside Orca
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
