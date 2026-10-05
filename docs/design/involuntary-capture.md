# Involuntary capture for Claude Code: a `PostToolUse` hook that logs edits as the seat

**Status:** v2, 2026-10-05 07:29 MDT (13:29Z): round-1 findings resolved: C-M1–C-M5 (Codex REJECTED `evt_51d29a9e84f944daaaa7a4edc93d3908`), G-L1, G-L2 (Grok APPROVED WITH NOTES `evt_7b28bdddf1f24eed9b105c2ee6a4ff30`); NOOA APPROVED with confirmations only (`evt_24607740c90c4962a4ce87922de4eee0`); applied in place on the coordinator's fix-round routing `evt_76b818938ba94d2f830e42858224d3ad` and Jordan's go `evt_c22d7d53215242e0936a6bf32f80ada4`; §10 lists every change. v1 draft 2026-10-04 22:04 MDT (2026-10-05 04:04Z). Author `claude-code` (`claude-fable-5-1`, `model_source:
harness-runtime`), session `0a9d8a07`, worktree `claude-capture-design` from main `8d77bc08`. **Class (a)** under
agent-rules 12: it proposes a control that would write to the ledger on every edit and touches agent-rules 2, 3, 7 and
13. Design only: no code, no hook installed, no change to `.claude/settings.json`, no credential. A prototype is a
later build gate. Origin: Jordan's signed go `evt_85ec6191c92041caa7111a4bc7b733c3` ("JD Go on Recommended
disposition JD", 2026-10-05 02:00Z), item 1 of the coordinator's disposition of the "Retrace Review 2026-10-04"
(read `evt_8a73a395e00c4c84a6e8409344725353`); this task's root `evt_3ecc86e41ae44f7d970915b452c3885c`; brief
`~/.retrace/ops-2026-10-04/brief-capture-hook-design-r1.md`, sha256 `d518728692849bbf…`, receipt
`evt_d3587645a3224a9c8e45073e1113034b`.

Every number below names its source. Vendor documentation is quoted as a claim about the vendor's product, verified
against the live page on 2026-10-04 by a research subagent of this session; nothing a vendor documents is called
measured until §4's probes run here.

## 0. What this note decides, and what it leaves to the gate

It decides the shape of the first involuntary-capture hook: which harness events, what the event carries, who it is
sealed as, what it cites as its cause when the agent recorded no instruction, what it does on failure, what it must
never log, and how the result is measured. It leaves to Jordan the eight yes/no decisions in §8 and to a later build
gate the code. It changes no rule by itself; §7 lists the amendments a build would carry.

The one-sentence version: **a hook event is the seat's asserted record that a process of its own saw a tool report an
edit to a file; it is not the agent's testimony about why, and it is not an attestation that the capture code ran.**
Under I-1 (§2.3) the seat's signature authenticates the assertion, not the observation: the same key signs the agent's
own `retrace_log` calls, and the marker that tells the two apart is a convention the producer follows, not a boundary
the Worker enforces (Codex C-M1). The design keeps the two kinds of claim visibly distinct in the ledger by that
convention, states its limit wherever it matters, and keeps "tamper-evident, not tamper-proof" and "instruction roots
are testimony" intact.

## 1. The question and the measured gap

**The review's claim** (`~/.retrace/ops-2026-10-04/retrace-review-2026-10-04-extracted.txt`, sha256 `743a7e4dfa346e0a…`,
line 10): "The one other project it was pointed at fell to 0.16 agent events per commit and 43 percent causal
coverage." And line 117: "a recorder that needs the pilot's cooperation is not a recorder." The review is untrusted
input; here is what the record says.

| Figure | Primary record | What it measures |
|---|---|---|
| **0.16** | `docs/design/step5-phase0-instrument.md:255`: boxing-rpg, "91 seals → 84 unique SHAs → 83 intervals. p50 **0**, p95 **1**, mean **0.16**, max **4**, **90.4%** zero", export of 2026-09-12 | `retrace_log` calls per commit interval over the project's whole history to 2026-09-12. Not "agent events per commit" in general; `docs/design/evaluation-response-plan-2026-09-24.md:212` (C63) already notes the census counts every agent action, not only edits |
| **43 percent** | **Checked in once, as a live read, not as a measurement record:** `docs/design/evaluation-response-plan-2026-09-24.md:213` (C64) records "causal coverage is 42.8%" with "96 of 140 commits are unlinked" from a live status read (Grok G-L1; v1 of this note wrongly said "not in the repository"). The dated figures in measurement records are 19.0 % (2026-09-12) and 32.9 % (2026-09-15), `docs/measurements/step5-phase-a/window-start.md:25`. The live `retrace_status` for `boxing-rpg`, read 2026-10-05 03:57:34Z by this session, returns `causality.coverage_pct: 42.8` over 173 eligible events, 94 unlinked, 221 events total, last event 2026-09-17 | The review rounded the C64 figure or a live read of its own. The number is real and reproducible today (`retrace_status`, project `boxing-rpg`) |
| Reconcile, boxing-rpg, last 20 commits | This session, 2026-10-05 04:04Z: `RETRACE_PROJECT=boxing-rpg retrace-export reconcile --repo ~/provenance/slc-wit-it --limit 20 --hook-sealed-by 'assert:git hook (assert)'`, HEAD `5e7fe52` (2026-09-17), ledger seqs 150–219 | 20 sealed, 0 missing, **22 uncovered of 168 evaluated file transitions** (claude-code 8 of 154, grok 14 of 14), 0 misattributed |
| Reconcile, retrace, last 40 commits | This session, 2026-10-05 04:03Z: `retrace-export reconcile --repo . --limit 40`, ledger seqs 11652–12873, head 13069 | 40 sealed, **0 uncovered of 77 evaluated file transitions** (github-copilot 59, claude-code 18), 0 misattributed; 13 `unreachable_seal` and 2 `producer_disagreement` are outside this note |
| Causal coverage, retrace | `retrace_status`, 2026-10-05 03:57:28Z | 98.3 % over 8,417 eligible events; 13,049 events total |

So the two projects differ in kind. On `retrace`, where five seats work under agent-rules 1–3 with the coordinator
watching, voluntary logging covers every file transition in the last 40 commits. On `boxing-rpg`, where one seat
worked without that supervision, 13 % of recent file transitions have no edit event and 57 % of eligible events
have no human root. The review's reading is right in substance: the mechanism works when the pilot cooperates, and
the second project shows what happens when the pilot is busy. Its figures are a rounded live read and a census
mean, not a reconcile result, and the boxing-rpg ledger has been dormant since 2026-09-17, so any "after" needs real
work on that repository (second-project baseline, `docs/second-project-baseline.md`, "Live window": do not invent
features for the sake of the number).

**A gap the reconcile numbers hide.** A `PostToolUse` hook on `Edit` and `Write` sees only tool-mediated edits. Over
the last seven days, this laptop's Claude Code transcripts (29 files under `~/.claude/projects/`, counted 2026-10-05
04:02Z by tool name only, no content read) show 280 `Edit`, 170 `Write`, 0 `MultiEdit`, 0 `NotebookEdit` and
**5,346 `Bash`** tool calls. A file written by `sed`, a heredoc or a script inside `Bash` fires no `Edit` or `Write`
hook. This session itself edits by `Bash` under the harness's auto mode. Involuntary capture of the two edit tools
is therefore a floor, not a ceiling, and §3 says so.

## 2. The proposal

### 2.1 Hook events

Claude Code documents `PreToolUse` and `PostToolUse` among its hook events, with `PostToolUse` receiving
`session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`,
`tool_response`, `tool_use_id` and `duration_ms` on stdin (reference, `https://code.claude.com/docs/en/hooks`,
"PostToolUse"). The documented `tool_input` schemas include `Write` (`file_path`, `content`) and `Edit`
(`file_path`, `old_string`, `new_string`); `MultiEdit` does not appear in the current reference (zero hits), and
`NotebookEdit` appears once as a matcher example ("`Edit.*` matches both `Edit` and `NotebookEdit`"). A
`PostToolUseFailure` event exists for a tool that failed, so `PostToolUse` means the tool reported success.

Proposal: match **`Edit|Write`** exactly (anchored), on `PostToolUse`; add `NotebookEdit` only after a probe shows
its `tool_input` names a file path; leave `MultiEdit` out until the reference documents it. A **paired
`PreToolUse`** on the same matcher, observe-only (exit 0, no decision), records the file's sha256 before the tool runs,
keyed by `tool_use_id`, so the `PostToolUse` event can carry both hashes. The pre-hook never blocks; it exists only
to supply `before_hash`.

### 2.2 The event

One `EventInput` per fired hook, posted to the Worker's `POST /events` (`packages/core/src/router.ts:826–935`):

| Field | Value | Source of truth |
|---|---|---|
| `actor` | `{type: agent, id: claude-code, model_source: none}`; `model` **absent**. The hook payload names no model and the hook must not guess one, so agent-rules 4 v2 applies: the unknown is recorded as `none`, never silent (`schema.ts:38–42` requires `none` to pair with an absent `model`) | the Worker pins `type` and `id` from the credential and, when the credential pins no model, keeps `model` and `model_source` as sent (`router.ts:366–380`) |
| `action` | `edited` when `tool_response.type` is not `create`, else `created` | `tool_response` of `Write` carries `type: "create"` (documented example) |
| `artifacts` | one `repo:jordandru/retrace#<path>` with `role: generated` when `file_path` is under the repository root; see §5 for paths outside it | `cwd` and `git rev-parse --show-toplevel` |
| `change` | `before_hash`, `after_hash` (sha256 of the file bytes, from the pre-hook and from disk); **no `diff`, no `summary`** | the hook reads the file; it never reads `tool_input.content` or `old_string`/`new_string` |
| `method.tool` | `claude-code:PostToolUse` | fixed string; it is how every consumer tells this event from a `retrace_log` call |
| `method.automated` | `true` | fixed |
| `method.params` | `hook_event_name`, `tool_name`, `tool_use_id`, `duration_ms`, `capture_version` (the hook's own package version), `session_root_candidate` and `session_root_candidate_source` (§2.4), `redacted` (§5.1) | stdin payload |
| `location` | `path` (repository root), `session` = the payload's `session_id`, `system: claude-code`, `environment: local`, `surface: agent` | the harness payload. The MCP server stamps the same id from `CLAUDE_CODE_SESSION_ID` (`packages/mcp-server/src/index.ts:157–162`, 180–202); §4 P2 measures that the two ids are equal |
| `caused_by` | **absent** in the pilot (C-3, §2.4) | |
| `intent` | **absent.** A hook has no why; writing one would be a fabricated testimony | |
| `idempotency_key` | `capture:<sha256 of session_id + tool_use_id, first 32 hex>` | prevents a double seal when a queued event is retried (§5.4); hashed so that no unvalidated payload string is copied into an identifier or a queue filename (C-M5) |
| `producer_sig` | §2.3 | |

`location.session`, `device`, `client`, `ide`, `workspace` and `surface` are server-only on the MCP path
(`index.ts:104–116`, `SERVER_ONLY`) because an MCP caller is the model. A hook is not the model, and `POST /events`
accepts a body `location` as submitted except `client` (`router.ts:915–916`). The hook therefore stamps `session`
itself from the harness payload, and §3 says what that is worth.

### 2.3 Who seals it: credential and key

The Worker pins the actor from the credential on every pinned write and stamps `sealed_by` and
`producer_sig_verdict` server-side (`router.ts:294–303`, 917–922). Two shapes are possible.

- **I-1, the seat's own credential and key.** The hook posts with the `claude-code` pinned credential and signs with
  the seat's producer key (`RETRACE_PRODUCER_KEY_FILE`, agent-rules 13), the file the seat's MCP server already
  reads (`packages/mcp-server/src/producer-key.ts:64–66`). The event seals as `pinned:claude-code …`, verdict
  `verified`, kid the seat's. Machine capture and the agent's testimony are then told apart only by
  `method.tool` and `method.automated`, both hash-covered and producer-signed, both asserted by the producer. No
  rule change beyond the one-line amendment to agent-rules 13 in §7 (a second process of the same seat reads the key).
- **I-2, a second pinned credential for the hook.** Actor `{agent, claude-code}` pinned, its own name
  (`claude-code capture hook`) and its own Ed25519 key, so the stamp itself says `pinned:claude-code capture hook`
  and the kid differs. Server-stamped distinction, visible to every consumer that reads `sealed_by`. Cost: it breaks
  agent-rules 7 and 13 ("one credential per seat; never mint a second token for a seat that has one"), needs an
  amendment with a bounded exception like the cloud seat's (`docs/design/cloud-seat.md` §2.3), a mint under
  agent-ops 16, a `worker-credentials-extra.json` mirror entry and one more secret in the few-KB Worker secret
  (agent-ops 13).

**What the key in a hook process means.** On this laptop the hook, the MCP server and the model's `Bash` tool all
run as the same OS user. The model can already read the key file and the credential mirror through `Bash` and
`POST` anything it likes under the seat's identity; the MCP server's `RETRACE_ACTOR_LOCK` is a convenience, not a
boundary. So I-1 adds no capability the seat's trust domain lacked, and I-2 buys a label, not a boundary: the second
key would sit in the same home directory. The boundary that would make the distinction mean something is a signer
the model's process cannot reach. The sandbox credential proxy (`docs/design/sandbox-credential-proxy.md`, PR 175)
is not that signer: it holds bearer tokens and states in its §4.1 that a proxy holds no producer key and cannot sign.
An isolated signer is a separate, unbuilt design, and moving credentials out of the Worker secret (agent-ops 13's
direction) does not by itself isolate signing (Codex, scoped judgement on I-1). **Recommend I-1** for the pilot and
state the limit wherever the event is described: the rule-13 line §7 proposes permits exactly the installed capture
process to read the key by path, not any same-seat process, and it is not permission to print or export key material.
Revisit I-2 only when an isolated signer exists; "when credentials leave the Worker secret" is a consideration, not a
trigger.

**Where the hook gets the token.** Never from the shell's `RETRACE_TOKEN`: on this machine that is the owner token
(agent-ops 16 and this seat's memory), and an owner-token write keeps whatever actor the body asserts, stamped
`sealed_by: owner`, verdict `none` (agent-rules 15; `router.ts:294–299`), which is worthless as a seat witness and a
rule-13 breach. The git hook's resolution is the precedent, with one deliberate difference. `resolveHookToken`
(`packages/mcp-server/src/git-hook.ts:69–83`; the header comment at 13–18 describes it) reads, in order,
`RETRACE_HOOK_TOKEN`, then the credential named by the `.retrace.json` field **`credential`** (matched on `actor.id` in
`~/.retrace/worker-credentials.json`), then **falls back to `RETRACE_TOKEN`** and the file's `token` when no credential
is named; `resolveHookProducerKeyFile` (87–100) takes the `producer_key_file` **path** from the same entry (Grok G-L2;
v1 miscited the lines and the field). The capture hook proposes a sibling field, `capture.credential`, with the same
mirror lookup and **no environment fallback at all**: an absent or unresolvable `capture.credential` means the hook
writes nothing, queues one `config_missing` diagnostic record (§5.4) and exits 2 with a one-line stderr. It never
reads `RETRACE_TOKEN` or `RETRACE_HOOK_TOKEN`. That is the one place this design is stricter than the git hook, because
on this laptop the fallback is the owner token.

### 2.4 The `caused_by` rule

**Correction to the brief.** The brief says `POST /events` rejects a dangling `caused_by` at write time. The code
says otherwise: `appendEvent` keeps the link and stamps the hash-covered tag `caused_by:unverified` plus
`method.params.caused_by_problem` (`packages/core/src/store.ts:1046–1052`; the comment reads "Keep the claimed link.
Adapters (git hook, Drive) must not drop an event…"). Only the MCP server's `retrace_log` throws `CausedByError`
(`index.ts:326–329`). A hook is an adapter, so a wrong id would be sealed and flagged, not refused. That changes
nothing about the rule below; it means the ledger would record a bad guess rather than reject it, which is one more
reason the hook must never guess.

A hook event with **no** `caused_by` is legal and `causalRootState` returns `unlinked` for it
(`packages/core/src/causality.ts:13`); it still covers its file in reconcile, which does not read `caused_by` at all
(`reconcile.ts:362–383`). So the honest default costs nothing in file coverage and is visible in causal coverage.
The options the brief asks for, plus the one the code makes available:

| Option | What the event says | Truth value | Cost |
|---|---|---|---|
| **C-1 Refuse** when no instruct root is known; the file stays `uncovered` | nothing | true by silence | throws away the capture exactly when the agent skipped `retrace_instruct`, which is the boxing-rpg case; the review's point is lost |
| **C-2 Session-root convention**: `caused_by` = the most recent `instructed` event in this project whose `location.session` equals the hook's `session_id`, labelled in `method.params` | "the latest instruction this session recorded preceded this edit" | a mechanical rule, stated as such; wrong when one session runs several tasks or concurrent subagents share the session id (the agent's own `retrace_log` names the specific one); and **today's consumers ignore the label**, so the link counts as rooted (C-M2) | one read per fire, or a per-session cache. `GET /projects/:p/events` filters by `artifact_id`, `actor_id`, `since`, `text` but not by session (`router.ts:14`), so the first build either scans the recent page client-side or adds a `session=` filter (small router change) |
| **C-3 No `caused_by`, session id only**: `location.session` carries the harness id and nothing else is claimed | "this edit happened in session S" | strictly true | causal coverage counts the event `unlinked`; the join to the session's instruct roots exists in the data but no consumer makes it today |
| **C-4 A fixed default root** (a per-pane or per-day "capture root") | "this edit was caused by X" | **false**; and under `appendEvent` it would be sealed with `caused_by:unverified` if the id were stale, or silently accepted if it exists | rejected |

**Recommend C-3 for the pilot, with the C-2 candidate recorded outside `caused_by`.** v1 recommended C-2 with C-3
as the fallback. Codex C-M2 showed why that is wrong today: no consumer reads the label. `causalRootState` walks
`caused_by` and never looks at `method.params` (`causality.ts:6–18`), and `buildProjectStatus` counts every rooted
traversal into `coverage_pct` (`status.ts:101`, `125–134`, `179–183`). Codex's synthetic ledger (one rooted and one
unlinked agent event, 50 %) went to 75 % after two C-2-labelled capture events were added, with the unlinked event
unchanged (`evt_51d29a9e…`). So C-2 as the written `caused_by` would **inflate** the headline metric on a disciplined
project by multiplying inferred links, while on an undisciplined project C-3 makes it **fall**. Both effects are
stated here before D3 is decided. The pilot therefore writes **no `caused_by`** and records the inference where no
consumer mistakes it for the agent's own citation: `method.params.session_root_candidate` (the id of the most recent
`instructed` event in this project whose `location.session` equals the hook's `session_id`, when one exists) and
`session_root_candidate_source: "session-latest-instruct"`, or `"none"`. A reader can still make the join; status
and `causalRootState` do not. C-2 becomes available only after a consumer change that reports agent-cited and
hook-inferred links in separate numerators with the same denominator; that change is a class (c) item of its own,
not part of this note. `appendEvent`'s check (existence, project, order) validates that an id exists, not that it is
the true cause, so an existing but wrong root would pass it; one more reason the inference stays out of `caused_by`.

### 2.5 Two events for one edit

An agent that keeps logging under agent-rules 2 and 3 produces its own `edited` event beside the hook's. Reconcile's
coverage is **existential per file transition**: one qualifying edit event in the window covers the path
(`reconcile.ts:371–395`, `n ≥ 1` at 381), so duplication is harmless there, and so is a missing second capture (§3). Census figures such as
"`retrace_log` calls per commit" (`step5-phase0-instrument.md` §7) must exclude `method.tool: claude-code:PostToolUse`
or they double-count; the classifier's witness set (`docs/design/commit-trailer-consistency.md` §3.3) admits any
`pinned:` agent output claim, so hook events become witnesses to commit claims, which is the intended effect and is
stated in §3.

## 3. What it proves and what it does not

**Records.** A sealed hook event records that a holder of the seat's credential (and, under I-1, its key) **asserted**
that a tool call named `Edit` or `Write` reported success on path `p` in harness session `S`, and that the file's
bytes hashed to `after_hash` afterwards (and, with the pre-hook, to `before_hash` before). Because the Worker pins the
actor and stamps `sealed_by`, a reader can tell the assertion came through the seat's credential and not the owner
token or an assert relay. That is the whole of what the seal authenticates.

**Does not prove.**
- **That capture code ran.** The seat's signature authenticates the assertion, not the observation. The MCP log path
  preserves a caller's `method.tool`, `method.automated`, `method.params` and `change` and signs the result with the
  same key (`packages/mcp-server/src/index.ts:318–330`; `schema.ts:218–234`), so the model can emit an event labelled
  `claude-code:PostToolUse` through `retrace_log` without any tool call and without touching the key file. The
  marker is a convention; a consumer that trusts it is trusting the producer. The §5.3 gate is a compatibility
  filter over inherited values, not harness authentication. Such an event also corroborates the seat's own commit
  claims under the classifier's pinned-output witness rule (`commit-trailer-consistency.md` §3.3), which is one more
  assertion from the same trust domain, not independent evidence (Codex C-M1).
- **Why.** The why stays the instruct root the agent chose to log. The session-root candidate (§2.4) is a
  session-ordering inference kept out of `caused_by`; it is not the agent saying "I did this because of that".
  Instruction roots remain testimony.
- **That the model made the edit.** Anything in the seat's trust domain can produce the event; on this laptop that
  domain includes the model's own `Bash`. The independent witness is still git: reconcile compares the commit's file
  list from the repository, never from the ledger (`reconcile.ts:4–8`), and the GitHub webhook seals the push a
  second time. The hook adds a third, earlier witness; it does not replace the two that already disagree with each
  other when something is wrong.
- **Edits made outside `Edit` and `Write`.** `Bash` writes, editor writes, `git apply`, a `MultiEdit` if the harness
  adds one unannounced: none fire this hook. 5,346 `Bash` calls against 450 edit-tool calls in seven days on this
  laptop (§1) says the blind spot is large. Reconcile shows it only when **no** qualifying event covers the file in
  its window: coverage is existential per file transition, so an earlier hook event or manual log for `x.ts` covers
  the path even when a later `Bash` write, disabled-hook edit or lost capture to the same file is absent, and a
  capture that lands after the commit seal shows as `pending` or `orphan_edit`, not as `uncovered` on that commit
  (`reconcile.ts:371–395`, `428–446`; Codex C-M4's fixture). Missing and late captures are detected by the
  tool-use pairing in §4, not by reconcile.
- **That the hook ran.** Hooks are user configuration. Claude Code holds back every hook until the workspace trust
  dialog is accepted, except in `-p` or SDK sessions, where "hooks committed in a repository's `.claude/settings.json`
  run in a folder you've never trusted" (reference, "Workspace trust"). A user can remove the settings file; a session
  can be started with hooks disabled. The absence of hook events in a window is evidence that no hook fired, not
  that no edit happened. Reconcile keeps saying `uncovered`.
- **Tamper-proof anything.** The event is hash-chained and producer-signed like every other event; it is
  tamper-evident, not tamper-proof, and a seat that holds its own key can write what it likes under its own name.

## 4. Measurement plan

Before any of this is called an improvement, the following is measured and written up as a class (b) record.

**P0, probes before building** (one session, scratch ledger, no production write):
- **P1** `PostToolUse` fires on `Edit` and `Write` in this harness build (`claude-code@2.1.289`) and the payload
  carries the documented fields. Pass: a stdin dump into a scratch file shows `session_id`, `tool_name`,
  `tool_input.file_path`, `tool_response`, `tool_use_id`.
- **P2** The hook's `session_id` equals the id the MCP server stamps as `location.session`. This session's `Bash`
  child saw `CLAUDE_CODE_SESSION_ID=0a9d8a07-0e50-49bf-90f7-a9d6aa088383` and its instruct root
  `evt_3ecc86e4…` carries the same `location.session`; the hook is another child of the same parent, which makes
  equality likely and unproven. Pass: byte-equal in one session.
- **P3** `NotebookEdit`'s `tool_input` names a path (decides whether it joins the matcher).
- **P4** The hook fires, or does not, in Copilot CLI and Grok Build sessions that read `.claude/settings.json`
  (§6) and the harness gate in §5.3 exits 0 there, for ordinary launches **and** for a launch nested inside a Claude
  Code session that inherits `CLAUDE_CODE_SESSION_ID` (C-M1). Pass: zero events from a non-Claude session, and a
  sanitized local diagnostic record for each refused fire. Behaviour is established by the run, never inferred from
  inheritance.
- **P5** Cost: wall-clock of one hook fire end to end, with and without the session-root lookup, over 20 fires.
  Report p50 and p95; the number decides whether the lookup caches.
- **P6** Durability (C-M3): kill the hook process between the in-flight record and the POST; force a timeout whose
  append outcome is unknown; make the queue directory unwritable; fire two `Edit` calls in parallel. Pass: every
  case leaves a record the doctor check sees, the retry with the same `idempotency_key` is deduplicated
  (`store.ts:1054–1060`), and the unwritable directory is a doctor FAIL, never a silent exit 0.

**Before/after on `retrace`.** Before: the 40-commit reconcile of §1 (0 uncovered, 77 transitions), and the
transcript tool-call counts. After the hook is live in one pane (the coordinator's, the only pane whose settings
the coordinator controls without a second seat's build), over the next **20 non-merge commits sealed as
`claude-code`**, with the installation time and the ledger seq at installation written down first: (a) reconcile
`uncovered` on those commits stays 0 and `misattributed` stays 0, which shows **no regression**, not complete capture
(C-M4); (b) **capture pairing**: every successful `Edit` or `Write` tool call in that pane's transcripts over the
window, identified by its `tool_use_id`, is paired one-to-one with a **reported** capture event carrying the same
`tool_use_id` in `method.params` (C-M1: the numerator is reported capture events; the transcript is the independent
observation the pilot checks them against), and the result is tabulated as captured, redacted (§5.1), missing,
duplicate, and late (sealed after the git-hook seal of the commit that carried the file); the pilot acceptance
threshold is **captured ÷ eligible ≥ 0.95 with zero duplicates**, a bounded pilot choice over a sample that must hold
enough eligible calls to mean anything, not a reliability claim; (c) causal coverage on `retrace` reported before and
after, with the counts of capture events whose `session_root_candidate_source` is `none` and
`session-latest-instruct`. Failure looks like: pairing below 0.95, any missing or late capture without a matching
queue record, any event whose `change` carries content, any event sealed `owner`, or an edit event naming a path
under §5.1's never-log classes.

**Before/after on `boxing-rpg`.** Before: §1's 20-commit reconcile (22 uncovered of 168, causal 42.8 %, 0.16 calls
per commit historically). After: the second-project baseline's live-window rule applies unchanged
(`docs/second-project-baseline.md`, "Live window"): `start_sha` = `5e7fe52`, N ≥ 5 consecutive real commits by a
Claude Code session with the hook installed in that repository's `.claude/settings.json` and `RETRACE_PROJECT=boxing-rpg`,
then `covered ÷ (covered + uncovered)` over evaluated file transitions **≥ 0.95**, `missing_commit` 0,
`misattributed` 0, and causal coverage reported beside it. Jordan supplies the commits by doing real work there;
nobody invents game features for the number. If no real boxing-rpg work happens, the boxing-rpg half of this plan is
reported as **not measured**, not as passed.

**Write volume.** The ledger took 4,186 events between 2026-09-28 and 2026-10-05 04:00Z, about 520 a day with a peak
of 679 (counted by this session from `GET /projects/retrace/events`), median stored event 2.2 KB. The seven-day
edit-tool count of 450 (peak 202 on 2026-10-01) would add roughly 10 % on an average day and a third on the peak
day if every Claude Code session on this laptop ran the hook; one pane adds a fraction of that. The hook's write is a
plain pinned `POST /events`: it takes no classifier path, because classification runs only for git commit seals from
assert ingress (`router.ts:870–912`), so `CLASSIFY_DEADLINE_MS` (500 ms, `classify.ts:41`) is untouched. The
`store.all`-on-the-hot-path lesson (`docs/measurements/step5-phase-a/window-start.md`, 2026-09-15 addition) applies
to the C-2 lookup if it ever scans a whole project: it must page by `limit` and `before_seq`, never fetch the
project. D1 row and request limits on the Workers Paid plan are not measured here.

## 5. Threats and sinks (agent-ops 16)

### 5.1 What the hook sees and must never log

The payload carries the full `content` of a `Write` and the `old_string`/`new_string` of an `Edit`. Those bytes are the
thing the ledger must never hold: ledger bodies are hash-covered and served by share links before authentication
(`schema.ts:189–215`, the `device` comment), and no later redaction is possible. Rules, in order:
1. **Content never.** No `change.diff`, no `change.summary`, no `tool_input` fields other than `file_path`, no
   `tool_response` text. Hashes of file bytes only.
2. **Outside the repository: redacted by default.** Any resolved path not under the repository root produces one
   event with `artifacts: [{id: "redacted:path", kind: "redacted-path"}]`, no hashes, `method.params.redacted: true`.
   The identifier is a **constant**: v1's `redacted:<top-level dir>` reproduced a path component, which is itself a
   disclosure (Codex C-M5). The edit is counted; nothing of the name is written. A project may allow-list specific
   outside directories as loggable `file:` ids (loose, never corroborating a commit) through `.retrace.json`; nothing
   is allow-listed by default.
3. **Never-log classes inside the repository.** A path matching any of these is redacted the same way, and the
   decision is taken **before** the pre-hook hashes and again before the post-hook hashes, so no hash of such a file
   is ever computed: `.gitignore`d paths; names `.env`, `.env.*`, `*.env`, `*.env.*`, `*credentials*`, `*secret*`,
   `*token*`, `*key*.json`, `*.jwk`, `*.pem`, `*.p12`, `*.pfx`, `*.kdbx`; and, should the repository root ever be a
   home directory or contain one, the harness and credential locations `~/.claude.json` (Anthropic documents it as
   the store for local and user MCP configurations), `~/.claude/`, `~/.codex/`, `~/.cursor/`, `~/.grok/`,
   `~/.copilot/`, `~/.config/`, `~/.retrace/`, `~/.ssh/`, `~/.aws/`, `~/.gnupg/`, and shell startup files. The list is
   a floor; the default-redacted rule 2 is the defence against the next sink nobody thought of.
4. **Shareable metadata, named.** `location.session` (the harness session id), `location.path` (the repository
   root) and `tool_use_id` are correlation information, not secrets, and every MCP event this seat writes already
   carries the first two (`index.ts:180–202`); omitting content does not make them confidential, and this note
   records that they are written. No other payload string is copied into an identifier, a queue filename or a
   diagnostic (`idempotency_key` is a hash, §2.2).

### 5.2 The seat key in a hook process

Under I-1 the hook reads the same 0600 key file the MCP server reads. It must read it by **path from the credential
mirror entry**, never from an environment variable that a transcript could print, never pass it on argv, and never
write it anywhere. The hook's stderr reaches the model when it exits 2 ("Shows stderr to Claude; the tool already
ran", reference, exit-code table) and the debug log otherwise, so stderr carries record names, byte counts and hash
prefixes only, agent-ops 16's rule for scripts. The hook runs "with your full user permissions" (reference,
"Security considerations: Disclaimer"); nothing in it needs more than read on the repository and the key path, and
write on its own queue directory.

### 5.3 The harness gate

Copilot CLI executed this repository's `.claude/settings.json` `PreToolUse` hook on 2026-10-04 (PR 169 F4 round;
this seat's memory of the lock-out), and xAI's documentation says Grok Build reads "Claude Code hook files" as well
(`https://docs.x.ai/build/features/hooks`). A capture hook that fired in a Copilot or Grok session and posted under
`claude-code`'s credential would misattribute every edit, agent-rules 7's exact prohibition. The hook therefore
**exits before reading anything when it cannot establish it is running under Claude Code**: `hook_event_name` and
`session_id` present in the payload **and** `CLAUDE_CODE_SESSION_ID` set in its environment **and** equal to the
payload's `session_id` (P2). **What the gate is:** a compatibility filter over values the caller supplies and the
process inherits, not harness authentication; it rejects a nested harness whose payload carries a different session
id even though the child inherited the variable, and it cannot certify which harness supplied two equal strings
(Codex C-M1). **What a refused fire leaves behind:** a sanitized local diagnostic, one counter line per refusal in
`~/.retrace/capture-queue/<project>/refused.log` with the reason code (`no_payload_session`, `no_env_session`,
`session_mismatch`, `config_missing`) and a timestamp, no payload strings, so a Claude Code deployment whose gate is
failing is distinguishable from a harness that was intentionally excluded, and doctor reports the count. P4 covers
ordinary and nested launches.

### 5.4 The hook's own failure mode

`PostToolUse` cannot deny: "the tool already ran" (reference). A blocking `PreToolUse` that waits for a ledger write
before every edit would stop all work on every Worker fetch flake (this seat's retry memory of 2026-09-29) and every
outage, so it is rejected on cost. It is not rejected as inherently untruthful: a pre-hook can record that an
operation **started** without claiming an edit succeeded (Codex, scoped judgement on D4), and that is exactly what the
design below has the pre-hook do.

**Recommend F-2, fail open at the edit and fail closed at the commit, with durable state written before any remote
work** (C-M3; v1 queued only after a detected failure, which left a crash, a cancelled hook, an ambiguous timeout or a
queue-write failure with no record). The record directory is `~/.retrace/capture-queue/<project>/`, mode 0700, files
0600, named by the hashed `idempotency_key`, written with write-to-temp-then-rename so a record is either whole or
absent:
1. **Pre-hook (`PreToolUse`, observe-only):** writes an `in_flight` record (`tool_use_id`, path or `redacted`,
   `before_hash` or none, `started_at`) **before the tool runs**. It asserts an operation started, nothing more.
2. **Post-hook:** rewrites the record to `sealing` with `after_hash`, then POSTs with the `idempotency_key`. On a
   2xx it deletes the record. On a timeout or any error it leaves the record (`pending`, with the error class) and
   exits 2 with one stderr line, "capture pending, N records", so the model sees it. Every later fire drains pending
   records first (the git hook's `drainPendingSeals` pattern, `git-hook.ts:317–322`); a retry of an append whose
   outcome was unknown is deduplicated by the Worker on the key (`store.ts:1054–1060`), so the ambiguous case
   resolves to exactly one event.
3. **Crash, cancellation, queue-write failure:** a process that dies after step 1 leaves `in_flight`; a hook cancelled
   on timeout leaves whatever state it reached; a queue directory that cannot be written makes the hook exit 2 with
   `capture state unavailable`, and the doctor check below treats an unwritable directory as a FAIL. Parallel tool
   calls each own one record. P6 measures all four.
4. **The commit boundary:** `retrace doctor` gains a check that the directory holds no `in_flight`, `sealing` or
   `pending` record and no refusals since the last check (§5.3), and agent-rules 8 already makes a doctor FAIL a stop
   before every commit. **Stated guarantee and its limit:** this closes the boundary for a single-writer worktree,
   one agent pane per worktree (agent-ops 1) that runs doctor and then commits with no tool call between them. An
   edit made between the doctor run and the commit, or a second writer in the same worktree, is outside the
   guarantee; the retirement condition is a `pre-commit` git hook that runs the same check at commit time, which this
   note proposes as a build item and does not assume. A capture that lands after the commit seal is not backdated and
   no timestamp is faked; it appears as `pending` or `orphan_edit` in reconcile and as `late` in §4's pairing, which is
   where it is counted.

**Mode and self-lock-out.** The 2026-10-04 incident (a hook rewritten as mode 644, every shell call denied, the agent
unable to `chmod`) applies to any hook script. The capture hook is installed from the packed CLI (`retrace capture
install`, writing the settings entry and a mode-755 wrapper that calls the versioned CLI, agent-ops 3's retirement
condition), never hand-edited in place by an agent; the wrapper's first statement is the harness gate; and a
non-executable wrapper is a `PostToolUse` error, which cannot deny anything, so the lock-out cannot recur on this
event. The `PreToolUse` pre-hash hook can: its wrapper is the same file, and a broken one would deny every `Edit`
and `Write`. The pre-hook therefore exits 0 on any internal error (observe-only, stated in its header), and only a
non-executable file can deny, which the installer checks (`stat -c %a`) and doctor re-checks. Installer and doctor
checks are operational checks; they are no guarantee against a hook that is disabled, missing, cancelled or broken,
which is why §3 says the absence of capture events proves nothing about edits.

### 5.5 Sinks named

Transcripts (hook stderr on exit 2 is shown to the model and lands in the transcript; keep it to names and counts);
the debug log (hook stdout and exit-0 stderr); the queue directory (events without content, 0600); the clipboard
and panes (nothing here touches them); a hook that another harness runs (§5.3). Docker is not involved.

## 6. Harness scope

Claude Code first, because it is the seat that writes most edit events (223 of 293 agent `edited`/`created` events in
the last eight days, this session's count) and the seat the review names. What the other four document today
(verified against live pages 2026-10-04; every claim below is the vendor's):

| Harness | Documented hook | Edit payload | Trust gate | Relevant limit |
|---|---|---|---|---|
| **Codex CLI** (`https://developers.openai.com/codex/hooks`) | `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, … in `~/.codex/hooks.json` or `<repo>/.codex/hooks.json`; feature flag `features.hooks` | `tool_name`, `tool_use_id`, `tool_input`, `tool_response`, `turn_id`; edits arrive as `apply_patch` | "Codex requires you to review and trust the exact hook definition" | open issues on `PostToolUse` coverage gaps (`openai/codex#16246`, `#20204`) |
| **Cursor** (`https://cursor.com/docs/hooks`) | `afterFileEdit` ("useful for … accounting of agent-written code"), `postToolUse`, … in `.cursor/hooks.json` | `file_path` and **`edits: [{old_string, new_string}]`**, so §5.1 rule 1 applies with force | project hooks; CLI support stated only in a staff forum post, not in docs | a Linux CLI bug report that hooks never fire (forum, 2026-08-11) |
| **GitHub Copilot** (`https://docs.github.com/en/copilot/reference/hooks-reference`) | `preToolUse`, `postToolUse`, … in `.github/hooks/*.json`, "Copilot CLI and Copilot cloud agent" | `toolName`, `toolArgs`, `toolResult` | not stated for repository hooks | Copilot CLI also runs `.claude/settings.json` hooks (measured here, §5.3) |
| **Grok Build** (`https://docs.x.ai/build/features/hooks`, official) | `PreToolUse` ("the only blocking event"), `PostToolUse`, … in `.grok/hooks/*.json`; reads Claude Code and Cursor hook files | `PostToolUse` field list not in docs | "Project hooks require trust … `/hooks-trust` or `--trust`" | "Everything else — timeouts, crashes, malformed output — is fail-open" |

So cross-harness capture is nearer than the review assumed: every seat's harness documents a post-tool hook. It is
not a reason to wait. The payloads differ (`apply_patch` patches, `edits` arrays, `toolArgs`), the trust gates
differ, and two of the four read Claude Code's hook files, which is a hazard before it is a convenience (§5.3). The
first hook ships for Claude Code with the harness gate; each further harness is its own small design that reuses
§2.2's event shape and §5's rules, and its first measured capture ratio is the evidence it joined.

## 7. Rules it touches

| Rule | Change needed |
|---|---|
| agent-rules 1 (`retrace_instruct` first) | **None.** The hook supplies no why; the instruction root is still the agent's act |
| agent-rules 2 (log every meaningful act) | **One sentence**: an automated capture event is not the agent's log of the act; the agent still logs its edits with intent and the specific cause |
| agent-rules 3 (name every changed file) | **One sentence**: a `method.automated: true` capture event covers a file in reconcile like any pinned edit; census figures that count an agent's own logging exclude `method.tool: claude-code:PostToolUse` |
| agent-rules 7 (one credential) | **None under I-1.** Under I-2, a bounded exception like cloud-seat §2.3 |
| agent-rules 13 (keys stay with the seat) | **One line, bounded**: the installed capture hook of the same seat on the same host may read the seat's key by path from the credential mirror entry; no other process gains anything, and the line is not permission to print, copy or export key material; still never env, argv, a shared secret or another host |
| agent-ops 3 (git hooks run main's dist) | **Analogue**: the capture hook runs the packed CLI pinned by version, never a checkout's dist |
| agent-ops, new rule | hook installation: project `.claude/settings.json` hooks fire in Copilot CLI and Grok Build; every hook there carries a harness gate; hook scripts are installed by the CLI, never hand-edited by an agent; mode checked after install |
| `docs/team-roles.md` | **None** |
| `.claude/settings.json` | one `PreToolUse` and one `PostToolUse` entry on `Edit|Write`, at the build gate, not now |

## 8. Decisions for Jordan

Each is answerable yes/no on this note's evidence; "overrule" says how.

| # | Decision | Recommendation | Cost of yes | Overrule |
|---|---|---|---|---|
| D1 | Build the prototype as a class (c) code PR, for one pane (the coordinator's) on this laptop, scratch ledger first, production after P1–P5 pass | **yes** | one builder brief; a small CLI subcommand, hook wrapper, doctor check; no credential | say no and the review's item 1 is closed as "declined, voluntary logging stays" |
| D2 | Identity I-1 (seat's credential and key, `automated: true`) rather than I-2 (second credential) | **I-1** for the pilot | agent-rules 13 one-line amendment | choose I-2: adds a mint under agent-ops 16 and agent-rules 7 exception |
| D3 | `caused_by` rule **C-3 for the pilot** (no `caused_by`; the session-root candidate recorded in `method.params`); C-2 only after a consumer change that reports agent-cited and hook-inferred links separately; never C-4 | **yes** | causal coverage falls on undisciplined projects and does not rise on disciplined ones, both reported as such; the lookup still runs to fill the candidate | choose C-2 now (the metric inflates, C-M2) or C-1 (lose the capture when it matters) |
| D4 | Failure mode F-2 with durable state: in-flight record before the tool runs, pending record on any failure, doctor FAIL on any record; guarantee stated for a single-writer worktree, `pre-commit` check as the build item that widens it | **yes** | a doctor check; a record directory; one more probe set (P6) | choose a blocking `PreToolUse` (stops work on outages) |
| D5 | Content policy §5.1: hashes only; outside-repository paths redacted by default under a constant identifier; never-log classes inside the repository; session id and repository root named as shareable metadata | **yes** | edits outside the repository appear only as counts | allow-list specific outside directories per project |
| D6 | Pre-hook (observe-only `PreToolUse`) for `before_hash` and the in-flight record | **yes** | one more hook entry; the only entry that could deny on a broken file; the hash pair is not atomic evidence of one tool's change when another writer intervenes | drop it; events carry `after_hash` only and durability falls back to the post-hook's first write |
| D7 | boxing-rpg "after" requires real work by you under the live-window rule; otherwise reported not measured | **yes** | your time on that repository | say the retrace measurement alone decides |
| D8 | Matcher `Edit\|Write` now; `NotebookEdit` after P3; `MultiEdit` never until documented | **yes** | none | add names on your word |

## 9. Not claimed

- No coverage number has improved; nothing is installed; the capture ratio of §4 has never been measured.
- Every vendor fact in §2.1, §3 and §6 is a documentation claim read on 2026-10-04, not a behaviour measured here.
  P1–P5 are the measurements.
- `CLAUDE_CODE_SESSION_ID` reaching a hook process, and its equality with the payload's `session_id`, is likely and
  unproven (P2).
- That the hook fires in Grok Build is documented by xAI, not measured; that Copilot CLI runs this repository's
  `PreToolUse` hook is measured (2026-10-04); that it would run a `PostToolUse` entry is not.
- The write-volume estimate uses this laptop's transcripts and the `retrace` ledger; it is not a forecast for any
  other machine or project, and D1 limits are not measured.
- The 42.8 percent figure's only checked-in occurrence before this note is a live read recorded in C64
  (`evaluation-response-plan-2026-09-24.md:213`); no class (b) measurement record holds it; this session's live read of
  2026-10-05 03:57Z is reproduced in §1.
- The marker `method.tool: claude-code:PostToolUse` and `method.automated: true` are producer conventions. Nothing in
  the Worker distinguishes a hook-written event from a model-written one under I-1, and this note does not claim it
  does.
- Codex's two synthetic fixtures (coverage 50 % to 75 % under C-2; a late edit reported `pending`, not `uncovered`)
  are Codex's measurements on in-memory ledgers (`evt_51d29a9e…`), restated here, not re-run by this session.
- The brief's statement that `POST /events` rejects a dangling `caused_by` is corrected in §2.4 by code read, not by
  a test run; a test at the build gate should confirm `appendEvent`'s `caused_by:unverified` path on a hook-shaped
  event.

## 10. Changes in v2 (fix round 1, 2026-10-05 13:29Z)

Routing `evt_76b818938ba94d2f830e42858224d3ad` on Jordan's `evt_c22d7d53215242e0936a6bf32f80ada4` ("Go on A for both").
Round-1 verdicts: NOOA approved, confirmations only (`evt_24607740…`); Grok approved with two Lows (`evt_7b28bddd…`);
Codex rejected with five Mediums (`evt_51d29a9e…`). Every finding is applied in place; the earlier text is in the
git history of this file (`e0fa9dd4`). No recommendation reversed except D3.

| Finding | Change | Where |
|---|---|---|
| C-M1 (the "Proves" paragraph authenticated the observation, not the assertion; the model can emit capture-labelled events through `retrace_log`; the §5.3 gate is a compatibility filter) | "Proves" became "Records … asserted"; a new first "does not prove" bullet names the MCP path (`index.ts:318–330`) and calls the marker a convention; the gate is described as a filter over inherited values, with a sanitized refusal log; §4's numerator is "reported capture events" paired by `tool_use_id` against the transcript; P4 covers nested launches | §0, §3, §4, §5.3 |
| C-M2 (an inferred `caused_by` counts as rooted; fixture 50 % to 75 %) | Recommendation changed from C-2-with-C-3-fallback to **C-3 for the pilot**; the candidate root is recorded in `method.params.session_root_candidate`, never in `caused_by`; both metric effects stated; C-2 gated on a consumer change (`status.ts:101,125–134,179–183`; `causality.ts:6–18`) | §2.2, §2.4, §8 D3 |
| C-M3 (queue only after a detected failure; crashes, ambiguous appends, parallel fires escape the gate) | Durable `in_flight` record written by the pre-hook before the tool runs; `sealing`/`pending` transitions by atomic rename; dedup by `idempotency_key` (`store.ts:1054–1060`); unwritable directory is a doctor FAIL; guarantee narrowed to a single-writer worktree with a `pre-commit` check as the build item; P6 added; the blocking pre-hook is rejected on cost, not called inherently untruthful | §5.4, §4, §8 D4, D6 |
| C-M4 (reconcile coverage is existential per file transition; zero uncovered is not complete capture; late captures are `pending`, not `uncovered`) | §2.5 and §3 now describe reconcile as existential with the line cites (`reconcile.ts:371–395`, `428–446`); the agent-rules 9 sentence in §5.4 corrected; §4 pairs successful tool calls one-to-one with reported events and tabulates captured / redacted / missing / duplicate / late; zero uncovered is "no regression" | §2.5, §3, §4, §5.4 |
| C-M5 (never-log classes missed `~/.claude.json` and env-file variants; `redacted:<dir>` disclosed a path component; session ids and roots are shareable metadata) | Outside-repository paths redacted by default under the constant `redacted:path`; the in-repository class list extended (harness and credential locations, `.env.*` variants, `*secret*`, `*token*`); the decision taken before either hash; session id, repository root and `tool_use_id` named as shareable metadata; `idempotency_key` hashed so no payload string enters an identifier or filename | §2.2, §5.1, §8 D5 |
| G-L1 (42.8 % is checked in as C64) | §1 row and §9 corrected: checked in once as a live read at `evaluation-response-plan-2026-09-24.md:213`, in no measurement record | §1, §9 |
| G-L2 (`git-hook.ts:13–18` is the header comment; `resolveHookToken` is 69–83; the field is `credential`; an env fallback exists) | Cites corrected; the existing precedence stated including the `RETRACE_TOKEN` fallback; `capture.credential` introduced as a proposed sibling field with **no** environment fallback | §2.3 |
| Codex scoped judgement on I-1 (the sandbox proxy cannot sign; moving credentials does not isolate signing; the rule-13 line must be bounded) | §2.3 and §7 reworded: the needed boundary is an isolated signer, unbuilt; the rule-13 line covers the installed hook only and is no export permission | §2.3, §7 |
