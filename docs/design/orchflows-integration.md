# Orchflows × Retrace — recording orchestrated work and review (design note v1)

**Status:** DRAFT v1, 2026-09-20, author claude-code (coordinator, `claude-fable-5-1`), on Jordan's
instruction `evt_adc713dc24ca4f34bb48a2f8df91ad4d` ("implement orchflows into Retrace where it best fits, both
projects"). **Class (a)** under agent-rules 12: the library it introduces governs how a review is recorded.
Design gate per `docs/team-roles.md` §2: Codex → NOOA (Nemotron, pinned) → Grok; the author does not sit.
Companion to `effort-model-routing.md` §5 (record shapes), §7 (portability) and §11 (prior art — **§11
exists only on PR 80's unmerged branch at `d894a58`**, head of `docs/orchflows-prior-art`, unrouted at the
time of writing; every "§11" citation below resolves there and nowhere on `main`. This note is what §11.4's
"integration seam" becomes). **Not built beyond the library in `adapters/orchflows/`; the library's
behaviour on Claude Code is established by T1 run 3 (§8), its text by the gate reviewers, and it is
untrialed on Codex.** Corrections are appended
in place with their date and source (agent-rules 10) once merged; before merge, defects are fixed in place
(Jordan, `evt_9dc982064d3c432bbd85ff9a64f049da`).

**Evidence discipline.** Every orchflows quotation below is verbatim from
`DanMcInerney/orchflows` at **`6eb8af4120a1b9bdb8ff971705d80be02a62b432`** (`main`, pushed
2026-09-19T04:13Z; scratch clone `~/repos/orchflows`, logged `evt_f59d176a068d4ab78ca99f497300167f`).
PR 80 read `36c9d46` one day earlier. Between the two shas `docs/architecture.md` is unchanged and `README.md`
changed (88 insertions, 86 deletions); this note quotes nothing from `README.md`, and every PR 80 sentence
reused here comes from `architecture.md`. Cite by sha, never by `main`: the repository has already invalidated a read once
(PR 80 §11, 2026-09-16 → 09-18). Read for this note: `README.md`, `docs/architecture.md`,
`docs/hosts.md`, `docs/libraries.md`, `docs/history.md`, `DESIGN.md`, the five `skills/orch-*/SKILL.md`,
`scripts/native_logs.py`. Not read: the E2E suite, `guidance/` beyond `orchflows.md` and `code.md`, the
example libraries beyond their manifests.

## 1. The problem

Orchflows composes a maker and an independent reviewer inside one host session and, on purpose, keeps no
record: "No shared event format or runtime is required" (architecture, *Iteration bounds*); "Run outputs
and evidence" → "Caller workspace, never a package" (a row of the *Where things live* table in libraries). Retrace keeps records
and has no vocabulary for the thing orchflows produces: **a fresh child of the same credential reviewed
this, at these settings, against this state.** Today such a review either goes unrecorded, or is recorded
in a shape that a consumer could mistake for a cross-seat verdict (agent-rules 11). Both are claims-ahead-
of-evidence failures in opposite directions.

Two readers need this:

- **A developer with one harness** — the outside developer Jordan is recruiting, and every solo user.
  Orchflows gives them the only reviewer ≠ builder separation a single credential can offer. Retrace should
  record it, and say exactly how strong it is.
- **This repository's coordinator**, for work below the gate: research fan-out, triage, drafting. Orchflows
  may save coordinator toil there (§8 measures it). Whatever it does must land in the ledger like any other
  act (agent-rules 2), and must never be mistaken for the gate (§5).

## 2. What each project fixes, and this note does not touch

Orchflows contracts that constrain the design, verbatim at the pinned sha:

- "Only the top-level orchestrator launches, assigns and continues agents. Children return results and
  requests without delegating" (architecture, *Execution*). → Records are the coordinator's or the child's
  own; nothing here adds an orchestrator.
- "Verdicts apply only to the inspected state and scope; changes do not inherit them" (*Review*). → Same
  binding as agent-rules 11 / routing R7; the event carries the head.
- "Explicit caller amendments may change the process; state changed guarantees, preserve primitive
  meanings" (*Invocation*). → A wrapping workflow may add record steps; it must say so. It does not alter
  what `orch-review` means.
- "Core depends on neither" domain nor shared libraries (libraries, *A library*). → The integration is a
  **library**, never a change to core.
- "Model names in prompts do not select models" and "report unsupported settings as gaps without
  substituting values" (hosts, *Model and effort*; architecture). → Settings are recorded as resolved,
  and a level the host cannot honour is recorded as a gap, never invented.

Retrace rules that constrain it: identity is the credential (agent-rules 7); whoever built it does not
review it (11); keys stay with the seat and a generic tool mints none (13); no claims ahead of evidence
(0). Nothing in this note amends a rule.

## 3. Where it fits — the decision

**On the orchflows side: a library, shipped from this repository at `adapters/orchflows/`,** package name
`retrace`, one workflow `retrace-review`. It composes `orch-review` with two record steps (routing before
launch, verdict after) and states that as its changed guarantee. It uses orchflows' own extension shape
(`plugin.json`, `skills/<skill>/SKILL.md`, `agents/openai.yaml`, `references/`, `trials/`) so it installs
through the host commands orchflows documents. **No change to orchflows core is needed,** and none is
requested (§9 asks Dan for one thing, and it is not this). Why here and not upstream: the library's only
dependency beyond orchflows is a Retrace MCP server, and orchflows' rule is that libraries own such
dependencies ("Declare runtime dependencies in README; setup installs none for libraries").

**On the Retrace side, three things, in order:**

1. **An independence class on routing and review events** (§4): `independence:
   "same-credential-fresh-context"`. The ledger already distinguishes seats by credential; this names the
   one arrangement where the reviewer *is* the builder's credential and still is not the builder's context.
   The class is data on the event. **Today's consumer does not read it:** `isReviewEvent` at
   `doctor.ts:240–246` (`0d294eb`) treats any agent event with action `approved`/`rejected` or a `review`
   tag as a review, so until item 2 lands, `retrace doctor --gate` counts an orchflows verdict like any
   other review (Grok, PR 90 round 1, F1). On this repository the merger reads `independence` by hand until
   then; the library README states the limit.
2. **A doctor finding** (§6): a review event whose independence is not cross-seat is reported as
   `review independence — same-credential (orchestrated child), not a rule-11 verdict`. INFO by default;
   under `--gate`, a same-credential review counts for nothing. This is a consumer change in
   `packages/mcp-server/src/doctor.ts`, class C, built by a builder seat after this note merges (§10).
3. **A witness for self-reported settings** (§7): orchflows' `history inspect` reads the host's native
   transcript, children included, without writing. It **would be** the first external check Retrace has
   had on `reasoning_effort` and the child's model; **no such check exists today**. v1 records enough to make
   it possible (`child_id`, §4); v2 builds it, and only after §9's ask to Dan is answered or the output is
   read by hand and found stable (§10 step 4).

**What is deliberately not here:** a `retrace-work` workflow (a maker's edits are already ordinary
rule-2 logs; nothing new is needed), any Retrace-side runtime for orchflows, any automatic selection
(`disable-model-invocation: true`, like every orchflows library workflow).

## 4. The one step: two events

The seam PR 80 §11.4 named: "after a verdict, emit an event carrying `routing_event_id`, the self-reported
effort and the reviewed head sha." It is two events, not one, because the routing intent must exist
**before** the reviewer launches (routing note §4 step 3, R1) or the effort mismatch check has nothing to
compare against. Agent-facing exact shapes: `adapters/orchflows/references/retrace-events.md`. Summary:

**Routing (coordinator, before launch).** The `effort-model-routing.md` §5 shape unchanged, plus:
`target.child: "native-subagent"`, `target.host`, `independence`, `workflow`, and `candidate` for a
non-commit artifact. When the repository carries `.claude/skills/review-effort/routing-rules/`, the rubric
classifies the candidate's paths and its digests are recorded; otherwise `rule_version: "caller/1"` with
null digests, and the caller's resolved settings are the target. Pins raise only (R4).

**Verdict (the reviewer).** action `approved`/`rejected`, tags `review` + `orchflows`, every reviewed file
`used`, `method.tool: "orchflows"`, params `routing_event_id`, `reviewed_head`, `reasoning_effort`
(self-reported, or the literal `not_exposed`), `independence`, `workflow`, `recorded_by: "reviewer"`.

**Who records the verdict.** The child, when the host exposes the Retrace tools to children (expected on
Claude Code, where subagents see the session's MCP servers — T1 in §8 verifies it; Codex children are not
verified — a gap the trial must report). Mirroring rule 11, the reviewer's own event is the verdict of record. When the child cannot reach
Retrace, the coordinator records it with `recorded_by: "coordinator"` and says why in `intent`: a relayed
verdict, labelled.

**Composition on Claude Code (T1 run 2, §8).** A wrapping skill cannot invoke `orch-review` through the
host's skill tool: orchflows marks its primitives `disable-model-invocation: true`, and Claude Code refuses
the call with text that also forbids replicating the skill by other means. Orchflows' own composition
model is the other path — "Composition applies workflow files in the coordinator without native skill
calls for every nested step. Read supplied paths directly where permitted" (hosts, *Invocation policy*);
"A coordinator can apply declared dependencies by reading their files; it need not invoke a native skill
tool at every step" (DESIGN, *Which skills are built in?*). The `hosts.md` paragraph just quoted continues, in the same
paragraph: "Claude blocks model calls and subagent preloading for manual-only skills; never bypass rejection.
Report blocked required native calls as capability gaps" (*Invocation policy*); a separate file, `DESIGN.md`
(*Which skills are built in?*), adds "A host rejection is not permission to bypass its controls." Read together: composition avoids the host's skill tool for a
composed primitive — it reads and applies the workflow file directly, which the quoted texts describe as the
pattern ("without native skill calls for every nested step"; "need not invoke a native skill tool at every
step") while separately stating "never bypass rejection" and "A host rejection is not permission to bypass
its controls" — and a refusal, once one has happened, is a gap to
report, not a signal to proceed by reading. **Whether the host's refusal of the skill tool is the signal to
use composition, or whether composition is the primary path and the skill tool is never invoked for
`orch-review`, is not stated by the pinned sources.** The library's step 4 proceeds by reading the file
directly; if a skill-tool call were made and refused, that refusal is recorded as a gap and the workflow
stops. That is the library's choice, stated as such, and §9 asks Dan which reading he intends. The library's
step 4 says exactly that (T1 run 2 proceeded the wrong way
round — it called the tool, was refused, and the v1 wording then told it to read instead; run 3 read
first and no refusal occurred). The tension is inside orchflows' own text as much as between hosts, and
§9 asks Dan to confirm that reading-and-applying is the sanctioned path on Claude Code rather than assume it.

**Actor.** The host seat's own credential, model verbatim (agent-rules 4). The child is not a new actor:
it has no credential (13) and orchflows gives it no identity of its own. Its native id, when the host
exposes one, is evidence for §7 and goes in `method.params.child_id` on whichever event knows it (the
child's, or the coordinator's routing event when only the transcript reveals it afterwards); trial run 3
recorded none and none was available at launch — whether a Claude Code child can learn its own id is untested. `location.session` stays the host session: in run 3 the instruction, the routing event and
the child's verdict all carry `location.session` `39584f84-d48b-473b-a9b3-6b3da47afc48` (scratch seq 2–4,
read from the scratch database), so doctor's pin/session comparison keeps its meaning.

## 5. What these events establish, and what they do not

| Claim | Established by | Not established |
|---|---|---|
| A review ran against exactly this state | `reviewed_head` = routing `head_sha`, R7 | that the reviewer read all of it (`used` artifacts are the reviewer's claim) |
| It was assigned these settings | routing `target` | that the host honoured them (§7 witness, v2) |
| It ran at this effort | `reasoning_effort` self-report | same; on Claude Code the Agent tool **call** exposes no effort field (an agent-definition `effort` exists — orchflows hosts, *Model and effort*, at `6eb8af4` — but writing one was outside the trial's allowed effects), so a child inherits the session's effort and self-reports whatever its harness exposes (T1 run 1: `not_exposed`; run 3: `"25"`) |
| The reviewer did not write the candidate | two orchflows sources, both at `6eb8af4`: `docs/architecture.md` *Two primitives* — "a fresh native child who did not make it reviews without fixing"; and the skill's own contract, `skills/orch-review/SKILL.md` — "a fresh native reviewer … who made none of the candidate". The first describes the primitive, the second is its contract; they are different sentences | **anything about a second seat, credential or vendor**; the `independence` class establishes nothing — it only names the arrangement |
| The event came from this project's credential | `sealed_by` server stamp; producer signature where the seat has a key | a signature for a generic install (server-stamped, unsigned — the ledger says which) |

**Rule 11 is not satisfied and is not amended.** "Whoever built a change does not review it" is a
statement about seats; a fresh child is the same seat. A same-credential review can inform a builder, it
cannot be a gate verdict, and §6 is what will make doctor say so — **it does not say so today** (§3 item 1). PR 80 §11.2 point 3 stands: routing gate seats
through one host's subagents "would collapse" the separation the gate exists for.

## 6. Consumer: the doctor finding (follow-up PR, builder seat)

`doctor.ts` already compares routed vs ran agent, model, effort and head (lines 255–340 at `0d294eb`).
Add, in the same pass:

- `review independence` — for every review event: `cross-seat` (routing `target.agent` ≠ the seat that
  built the head, and no `independence` param or `independence: "cross-seat"`) → silent; `same-credential-
  fresh-context` → INFO `"<id>: same-credential review (orchestrated child) — not a rule-11 verdict"`;
  `independence: "self"` or a routing target equal to the builder with no class → WARN.
- Under `--gate`: same-credential reviews are excluded from any count of verdicts; a head whose only
  reviews are same-credential reads exactly as a head with none.
- `target.child`/`target.host` need no change: the intent check at `doctor.ts:302–308` (`0d294eb`) fires
  only on a missing `target.agent`/`model`/`effort`, so extra keys already pass (T1 run 3 confirmed it by
  reading the source; the v1 text of this bullet had it wrong).
- `reasoning_effort: "not_exposed"` is a recognised literal alongside `supports_effort: false` in the
  mismatch check at `doctor.ts:318–320`, and a **numeric** self-report (T1 run 3's child reported `"25"`,
  the harness's raw value, verbatim) is reported as a mismatch against a routed level rather than treated
  as unknown — `models.json` has no numeric aliases and must not grow any (agent-rules 4: verbatim, never
  normalised). This closes the "routed high · ran not-supported" noise the 09-18 hand-off flagged, which
  deserves its own issue.

Acceptance: A1 an orchflows verdict never appears in a `--gate` review count; A2 the INFO line names the
class in words; A3 a routing event with `target.child` passes the intent check; A4 existing PR 35 tests
unchanged.

## 7. The witness (v2): native history as an external check

`docs/history.md`: "`inspect` returns a descendant tree with per-agent counts, latest activity, errors,
unmatched calls, gaps and source references"; `docs/hosts.md`: "Verify model/effort in native metadata."
Codex limits apply: "Codex delegation bodies are encrypted and reported `unavailable`". So on Claude Code
the host's own transcript records which child ran and with what model, independent of what the child
said about itself. A local doctor advisory could compare a review event's `child_id` and self-reported
model/effort against `history inspect claude <host session>`. Constraints, all binding: transcripts stay
local ("Keep raw history local"; and they are a credential sink here, `evt_c21df545`); the check is
advisory; absence of a transcript is `scope_unknown`, not a finding. This is the ask to Dan in §9: a
machine-readable `--json` for `inspect` whose child model/effort fields are stable enough to cite.

## 8. The trial (item 3 of the instruction)

Purpose: does the library behave, and does orchflows save coordinator toil on ungated work? Two questions,
one bounded run each. Both run against a **scratch ledger** (`RETRACE_DB` inline, `RETRACE_URL` unset,
`--strict-mcp-config`, agent-ops 10) and orchflows **pinned at `6eb8af4`** via `--plugin-dir`, in a
separate headless session, never this pane.

- **T1 (library):** `trials/review-candidate/request.md` against this PR's own head. Pass criteria in
  `expected-behavior.md`. Record: both event ids, whether the child could reach the tools, wall-clock.
- **T2 (toil):** `orch-dynamic-workflow` on issue #74 (thirteen claim defects → triage table with
  evidence), an ungated task with a known-good manual baseline (the 09-17 sweep). Measure coordinator
  turns, wall-clock, and whether the joined result needed a second pass. Compare against the manual sweep.

**Result, T1 (2026-09-20, Claude Code 2.1.278 as reported by the session's `location.client`, orchflows
`6eb8af4`, scratch ledger `~/.retrace/handoff-2026-09-20/orchflows-trial/`; the three runs are sealed in
the project ledger as `evt_2b1cd47f22b7458cb56081c99df48094`, `evt_0e973935fdca47f9b75acc185ed0244f` and
`evt_8c25294ade3e4dfaa9511e018971d715`, each carrying the run's turn count, duration, cost and scratch
event ids as `method.params`):**

- *Run 1* (36 turns, 284 s, $3.17): stopped at step 1 because the scratch server lacked
  `RETRACE_ON_BEHALF_OF` — the coordinator's configuration error; the skill's fail-closed path worked
  for the wrong reason. It still established that a Claude Code subagent **can** reach the Retrace tools
  (a read-only probe child called `retrace_status`), that the Agent tool call exposes **no per-call effort
  field** (the child reported `not_exposed`; the agent-definition path in orchflows hosts *Model and effort*
  was outside allowed effects), and the dry routing: note → class D, the ten library
  paths → unmatched → S, effort high.
- *Run 2* (23 turns, 158 s, $1.58): reached `retrace_instruct`, then stopped at the skill's precondition
  because the host's skill tool refuses `orch-review` (manual-only). It recorded the stop as a gap event
  (2 scratch events, both well-formed) and found that the server rejects `routing_event_id: null`. Three
  defects fixed in place from it: the composition wording in step 4 (§4 above), a §3 gap-event shape in
  the contract with "omit, never null", and an "instruct refuses" stop condition.
- *Run 3* (on the **round-2 head** `00e0279d`, not the current one; per the sealed event, 38 turns, 763 s,
  $5.25): **the workflow ran end to end.** Scratch seq 2
  instruction → seq 3 routing event before launch (class S, effort high, both digests, ten unmatched
  paths, `independence`, `target.child`, candidate verified unchanged) → seq 4 verdict **recorded by the
  child itself**: `rejected`, tags `review`+`orchflows`, all 11 changed files plus 15 evidence files as
  `used`, `routing_event_id` citing seq 3, `reviewed_head` = candidate, `recorded_by: reviewer`.
  `trials/review-candidate/expected-behavior.md` items 1–4 met. Two host facts: the child reaches the
  Retrace tools and can seal its own verdict; the Agent tool call has no per-call effort field, so the
  child inherited the session and self-reported `reasoning_effort: "25"` — the harness's raw value — against
  a routed `high`. The verdict's six findings (F1–F6, all content defects in this draft) were fixed in place in
  the rounds that followed, leading to the current head; the library's behaviour is established by this run
  on `00e0279d` **only**: the library files have changed since (step 4's composition wording in rounds 3–6,
  `child_id` in the contract in round 4, the README status line) and no later head has been re-trialed, so
  whether the current text still runs end to end is not established. The draft's text is for the gate reviewers. Two consumer observations for issues: `retrace_status` returned `routing: []` for a
  project holding a `tool: "routing"` event, and `retrace_why` was outside the run's allowed tools (the
  coordinator's omission), so the child's citation of the routing id was verified from the scratch database
  afterwards rather than in-session.

## 9. Proposed note to Dan McInerney (Jordan sends; draft, not sent)

> Dan — we're shipping a small orchflows library from the Retrace repo (`adapters/orchflows`, package
> `retrace`). One workflow, `retrace-review`: it composes `orch-review` and records two events in a
> Retrace ledger, a routing decision before the reviewer launches and the reviewer's verdict after,
> both bound to the inspected commit. Nothing in orchflows core changes and we're not asking for
> anything there; your library shape and the "explicit caller amendments may change the process" clause
> are the seam, and they're enough.
>
> Two honest limits we state in the library: the reviewer is a fresh child of the same credential, so
> we label it `same-credential-fresh-context` and never call it an independent seat; and model/effort
> are self-reported. On the second one you have something we don't: `history inspect` reads the host's
> native transcript, children included. If `inspect` grew a `--json` whose per-child model/effort fields
> you'd stand behind as stable, a Retrace checker could compare the self-report against the host's own
> record, locally, without uploading anything. That's the one ask, and only if it fits your roadmap.
>
> One more, smaller: on Claude Code the skill tool refuses a manual-only primitive and its refusal text
> says not to replicate the skill by other means, while your docs say composition reads the file and
> applies it. We follow your docs. If you'd confirm that's the sanctioned path on Claude Code, we'd cite
> it; if not, we'd rather know now.
>
> Everything we quote is pinned to `6eb8af4`; we learned the hard way not to cite `main`. Happy to send
> the design note if useful.

## 10. Build order and gates

1. **This PR** — the note and `adapters/orchflows/` (class (a); design gate). Merges with the trial
   status honest, run or not.
2. **T1 and T2** (§8) — coordinator, scratch ledger; results appended to §8 by dated correction after
   merge, or folded in place before it.
3. **Doctor finding** (§6) — builder seat, class C, one PR, tests included.
4. **Witness advisory** (§7) — v2, after Dan answers §9 or after a `history` output is read by hand and
   found stable; not before.
5. **Solo-developer path** — the stranger-install dry run (dispatched 2026-09-20) tells us whether a
   single-harness user can reach a verified export at all; only then is "install both plugins and your
   reviews are recorded" a sentence to put in front of a user.

## 11. Dispositions

**Grok, round 1 at `92126633`** — routing `evt_4f4c20d38e3d4dbd95020df4a171deba` (Jordan's reassignment
`evt_4b6f954ffa9b4981a95dfe98354f6f10`), verdict `evt_08be04d445c74d41b0a7c5b33c801df1`, *rejected*.

| Finding | Disposition (fixed in place at the next head) |
|---|---|
| F1 Medium — today's doctor counts an orchflows verdict as a review (`doctor.ts:240–246`) | Stated as a known limit in §3 item 1, §5, the library README and the contract §4; the verdict shape is kept (it is what the trial evidenced) and §6 remains the fix |
| F2 Medium — §3 item 3 claimed the witness in the present tense | Rewritten: would be; does not exist; v2 |
| F3 Medium — `child_id` named in §4/§7 but absent from the contract | Added to contract §2 and skill step 4, with where it can actually be known on Claude Code; run 3 recorded none |
| F4 Low — §5 row credited the independence class with establishing non-authorship | Row now credits `orch-review`'s contract alone |
| F5 Low — `location.session` claim uncited | Cited from the scratch database: seq 2–4 share one session id |
| Nit — libraries.md quote is a table row | Rephrased as a row |

**NOOA (Nemotron 3 Ultra via NIM, from the auditor host), round 1 at `cbdae150`** — routing
`evt_08080eb3f988438eac92c263adf97952`, verdict `evt_b84ed78a259749db92f9230987a168bc`, *rejected*;
packet-scoped and advisory (it read one packet holding all eleven files and executed nothing).

| Finding | Disposition (fixed in place at the next head) |
|---|---|
| 1 Medium — "composition never calls the host's skill tool" claims more than the quoted sentences carry | Reworded in §4 and the skill's step 4 to what the texts say: avoids, reads the file directly, no blanket prohibition stated |
| 2 Medium — the `orch-review` quote in §5 row 4 was unverifiable from the packet | On checking the pinned clone it was also misattributed: "a fresh native child who did not make it" is `docs/architecture.md` *Two primitives*; the skill says "who made none of the candidate". Both now cited to their files |
| 3 Low — "the same orchflows paragraph continues" read as if `hosts.md` and `DESIGN.md` were one paragraph | Reworded: the `hosts.md` sentence is in the same paragraph; `DESIGN.md` is a separate file |
| 4 Low — §8 run 3 read as if it ran on the current head | Now says round-2 head `00e0279d`, and that no later head has been re-trialed |

**NOOA, round 2 at `54b42084`** — routing `evt_0bec507eac074584a8e4a5ec0ff50d0f`, verdict
`evt_04f7c2a4e7e1408e8eabf85bbbf4f69d`, *rejected*.

| Finding | Disposition (fixed in place at the next head) |
|---|---|
| 1 Medium — "without stating a blanket prohibition" implied the texts were silent on refusal | Replaced with NOOA's wording: the texts describe the pattern *while separately stating* the two refusal sentences; skill step 4 likewise |
| 2 Medium — §5 row 4 still placed the independence class under "Established by" | Moved to "Not established": the class establishes nothing, it names the arrangement |
| 3 Low — "unchanged in wording that affects behaviour" was an unevidenced judgment | NOOA's suggested "unchanged since round 2" would be false (the files changed in rounds 3–6); the sentence now says they changed, lists what, and that the current text has not been re-trialed |
| 4 Low — README cites a ledger event a solo reader cannot check | Says the event is in the project ledger, not reproduced, and that the trial was on an earlier head |
| 5 Low — "the child does not know its own id" was asserted as a host property | Reduced to what run 3 showed; the host property is marked untested |

**NOOA, round 3 at `b8e06a39`** — routing `evt_aa1ad1789ff84d469ea0e20ecfe74a75`, verdict
`evt_77a2339da7ec4f54bc0ece386122946a`, *rejected*; coordinator calibration `evt_2cbf89b774f7454e81dadba6ec5c33f6`.

| Finding | Disposition (fixed in place at the next head) |
|---|---|
| 1 Medium — §4 read as if the sources resolved the order (read first vs refusal as signal) | The text had not claimed that; NOOA's explicit sentence added anyway, in §4 and the skill: the sources do not say; reading first is the library's choice; §9 asks Dan |
| 2 Medium — §5 row 4 presented two sources as one joint establishment | Rewritten in NOOA's form: two sources, one describes the primitive, one is its contract |
| 3 Low — run-3 figures unverifiable from the packet | A limit of the packet, not the note (its readers have the ledger); "per the sealed event" prefix added |
| 4 Low — README did not name the trialed head | `00e0279d` named |
| 5 Low — contract §4 "stated by the ledger" underspecified | NOOA's wording: the event carries `sealed_by`; the library adds no signature |
