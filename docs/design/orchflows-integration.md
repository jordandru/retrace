# Orchflows × Retrace — recording orchestrated work and review (design note v1)

**Status:** DRAFT v1, 2026-09-20, author claude-code (coordinator, `claude-fable-5-1`), on Jordan's
instruction `evt_adc713dc24ca4f34bb48a2f8df91ad4d` ("implement orchflows into Retrace where it best fits, both
projects"). **Class (a)** under agent-rules 12: the library it introduces governs how a review is recorded.
Design gate per `docs/team-roles.md` §2: Codex → NOOA (Nemotron, pinned) → Grok; the author does not sit.
Companion to `effort-model-routing.md` §5 (record shapes), §7 (portability) and §11 (prior art, PR 80 —
this note is what §11.4's "integration seam" becomes). **Not built beyond the library in
`adapters/orchflows/`; the library is untrialed until §8 reports otherwise.** Corrections are appended
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
and evidence: Caller workspace, never a package" (libraries, *Where things live*). Retrace keeps records
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
   The class is data on the event, so a consumer can never read it as `cross-seat` by omission.
2. **A doctor finding** (§6): a review event whose independence is not cross-seat is reported as
   `review independence — same-credential (orchestrated child), not a rule-11 verdict`. INFO by default;
   under `--gate`, a same-credential review counts for nothing. This is a consumer change in
   `packages/mcp-server/src/doctor.ts`, class C, built by a builder seat after this note merges (§10).
3. **A witness for self-reported settings** (§7): orchflows' `history inspect` reads the host's native
   transcript, children included, without writing. That is the first external check Retrace has ever had
   on `reasoning_effort` and the child's model. v1 records enough to make the check possible; v2 runs it.

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

**Actor.** The host seat's own credential, model verbatim (agent-rules 4). The child is not a new actor:
it has no credential (13) and orchflows gives it no identity of its own. Its native id, when the host
exposes one, is evidence for §7 and goes in `method.params.child_id`; `location.session` stays the host
session so doctor's pin/session comparison keeps its meaning.

## 5. What these events establish, and what they do not

| Claim | Established by | Not established |
|---|---|---|
| A review ran against exactly this state | `reviewed_head` = routing `head_sha`, R7 | that the reviewer read all of it (`used` artifacts are the reviewer's claim) |
| It was assigned these settings | routing `target` | that the host honoured them (§7 witness, v2) |
| It ran at this effort | `reasoning_effort` self-report | same |
| The reviewer did not write the candidate | orchflows' `orch-review` contract + `independence` class | **anything about a second seat, credential or vendor** |
| The event came from this project's credential | `sealed_by` server stamp; producer signature where the seat has a key | a signature for a generic install (server-stamped, unsigned — the ledger says which) |

**Rule 11 is not satisfied and is not amended.** "Whoever built a change does not review it" is a
statement about seats; a fresh child is the same seat. A same-credential review can inform a builder, it
cannot be a gate verdict, and §6 makes doctor say so. PR 80 §11.2 point 3 stands: routing gate seats
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
- `target.child`/`target.host` are accepted params, not "unusable target" (line 308).
- `reasoning_effort: "not_exposed"` is a recognised literal alongside `supports_effort: false` (closes the
  "routed high · ran not-supported" noise the 09-18 hand-off flagged, which deserves its own issue).

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

**Result:** _not run at v1_ — recorded here when it has, with the scratch export path. Until then the
library's `Status` says untrialed, and orchflows' own rule applies: "Frontmatter proves no behavior."

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

_None yet. Review findings and their dispositions go here, in the order received, with event ids._
