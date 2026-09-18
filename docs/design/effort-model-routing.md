# Effort and model routing for spawned agents — design note

**Status:** DRAFT v2, 2026-09-10, author claude-code, on Jordan's ask (2026-09-10). PR 35 implements
doctor-only advisories; R3's `/status` and reconcile consumers are deferred to a follow-up PR. The complete
design is not yet built. v1 (a6a45c2) was
reviewed by Nemotron 3 Ultra via NOOA (evt_316223f7a9a84ed29a7bf5def3a91ebc): *needs changes* — four blocking
(TOCTOU on launch, unauthenticated pins, escalation ordering, moving-head classification), two non-blocking
(model capability registry, advisory token counts). v2 folds all six; dispositions in §10. Companion to
`docs/team-roles.md` (reviewer ≠ builder) and `commit-trailer-consistency.md` §15 step 5 (cost profile).
Reviewer for v1: Nemotron 3 Ultra via NOOA (cross-vendor; Codex's weekly budget is reserved for code). Nothing
here changes what the ledger records about *who did what*; it adds a recorded answer to *how much thinking
was bought for it*, and a way to check later whether that was the right amount.

**Addendum 2026-09-18** (claude-code, on Jordan's ask): §11 adds `DanMcInerney/orchflows` as named prior
art — where it agrees, where it diverges, and the one thing this note should take from it. Nothing in
§1–§10 changes; the earlier text stands as written (agent-rules 10).

## 1. The problem

Coordinators already choose, per task, which agent runs it, at which model, at which reasoning effort — and
today that choice is invisible. On 2026-09-09/10 the same reviewer (Codex, `gpt-6-astra`) produced a
17-finding first pass at **high** effort on PR 32 and correctly approved narrow re-check rounds at
**medium**; those are different claims, but both events read "codex reviewed". Two consequences:

1. **A review's strength is not legible.** "Approved" at low effort and "approved" after adversarial
   reproduction at high effort are recorded identically. The ledger's core promise — claims are not
   stronger than their evidence — is violated by omission.
2. **Effort is spent by habit, not by rule.** Weekly caps (Codex hit 11% on 09-10) force choices that are
   made ad hoc and never measured, so nobody learns which level a class of task actually deserves.

A model cannot change its own effort mid-thread (it is a client setting), so this is an **orchestration**
policy applied when an agent is launched, not self-modification.

## 2. Principles

- **Bias upward; fail closed.** The two errors are not symmetric: over-spending on a docs pass costs
  tokens; under-spending on an ingress change costs a hole found in production. Security surfaces never
  route down, whatever a learned component suggests.
- **Every routing decision is a ledger event**, citing the rule version and the classification that fired,
  so a wrong choice is a *rule* to fix, not a mystery.
- **The review event is the truth; the routing event is only the intent** (Nemotron F1). The review
  event already records the model that actually ran (`actor.model`, truthful by rule); it gains
  `reasoning_effort` as **self-reported by the running agent from its own configuration**, never copied
  from the coordinator's plan, and it references the routing event it fulfils (`routing_event_id`). A
  routing decision naming `gpt-6-astra/high` whose review reports `medium` is a discrepancy the ledger
  surfaces; nothing about the routing event makes the review stronger than the review says it is.
- **Effort is per-model.** "medium" on Codex and "medium" on Claude are not comparable; the rubric is a
  table keyed by model, never a single scale.
- **Escalation over prediction.** Prefer starting at the rubric's level and escalating on signals (a
  failing suite, reviewer disagreement, a flagged path in the diff) to predicting difficulty up front.

## 3. The rubric (v1, deterministic)

Classification is by **surface touched** (paths and PR metadata), computed from the diff, not from prose.

| Class | Surfaces | First pass | Re-check round |
|---|---|---|---|
| **S — security/trust** | `router.ts` auth/ingress, `producer-sig*`, `policy*`, `chain.ts`, `store.ts` reservations, credentials/secrets, `schema.sql`, `admin.ts` issuance, Worker `index.ts` | **high** | medium, **high if the round adds new surfaces** |
| **D — design contracts** | `docs/design/**` | high for v1–v2, medium after | medium |
| **C — consumers** | `status.ts`, `reconcile.ts`, `doctor.ts`, `export-cli.ts`, UI | medium | medium |
| **T — tests, fixtures, tooling** | `*.test.ts`, `fixtures/**`, `scripts/**`, `migrate.mjs` | medium | low |
| **F — formatting, comments, renames** | no semantic change (AST-equal or comment-only) | low | low |

A PR takes the **highest** class of any file it touches, classified against a **specific head sha** that
the routing event records; every new push is re-classified against the new head and gets a new routing
event before any further review (Nemotron F4). **Pins** (Nemotron F2): a pin is a ledger event, not PR-body
text — the pinning human (an owner-stamped or pinned-credential event by a principal listed in the project
policy's `set_by`/owner) records `{pr, head_sha, level}`; the coordinator verifies the event's stamp and
principal at routing time and cites its id as the reason. Pins **raise, never lower**. PR-body text is a
request, not a pin.

Model choice in v1 is **role-driven, not rubric-driven**: reviewer ≠ builder, and the reviewer is a
different vendor from the builder where possible (`docs/team-roles.md`). The rubric picks effort *within*
the role's model. v2 may let the rubric pick among models of one role once §6's data exists.

## 4. Mechanism

1. **Classify** the diff (`git diff --name-only base..head` → class; PR body pin overrides).
2. **Launch** the agent at the chosen level in its own terminal — Codex: `codex -c
   model_reasoning_effort=<level>`; Claude subagents: `model` parameter; others: their launch flags — and
   send the brief. A second pane at a different level is closed when its task's verdict posts.
3. **Record the decision** (§5) before the agent starts. It is an intent record; the agent's own review
   event carries the effort that actually ran (§2) and cites the routing event. A review event that cites
   no routing event, or one whose effort differs from the routing intent, is a finding (§9 R3).
4. **Escalate** when a signal fires — suite red on the head, two reviewers disagree, a new surface in a
   later push: **first** record a new routing event with `escalated_from` = the prior routing event id
   and the signal, **then** launch (Nemotron F3). Same order on de-escalation after a re-classification.

## 5. What the ledger records

Routing decision (coordinator, before launch):
```
{ action: "other", actor: <coordinator>, intent: "route: PR 32 first pass",
  method: { tool: "routing", params: { rule_version: "effort-routing/1", rules_digest: "<sha256>",
    models_digest: "<sha256>", head_sha: "8c4933e…", surface_class: "S",
    target: { agent: "codex", model: "gpt-6-astra", effort: "high" }, pin_event: null,
    escalated_from: null, why: "touches router.ts ingress + policy.ts" } },
  artifacts: [ { id: "https://github.com/jordandru/retrace/pull/32", role: "used" } ] }
```
Review event (reviewer, unchanged shape plus review metadata): `method.params.reasoning_effort` —
self-reported from the agent's own configuration — `method.params.routing_event_id`, and the full
`method.params.reviewed_head` commit SHA. The first two names are optional for old-client compatibility
but, when present, are typed non-empty strings: values such as `reasoning_effort: null` and
`routing_event_id: 17` fail schema validation. Unrelated arbitrary params still round-trip. A small data file
`routing-rules/models.json` maps `model_id → { supports_effort, levels[] }` (Nemotron F5); its digest is in
every routing event, and consumers use it to decide whether a missing `reasoning_effort` is a WARN or
expected. Routing intent vs execution is a standard consumer check shown side by side ("routed high ·
ran medium"), never one hiding the other. PR 35 reports these mismatches through doctor; `/status` and
reconcile delivery of R3 remain deferred to a follow-up PR.

## 6. Measurement (Grok, alongside §15 step 5)

Per `(model, effort, surface_class)`: findings per first pass by severity; whether a later re-review or a
post-merge amendment found something the routed level missed; wall-clock. Token counts are
**self-reported and advisory only** in v1 — never an input to any automated decision; v2 may require
provider-signed usage before treating cost as evidence (Nemotron F6). The question the data must answer before v2: **for which classes does
medium find what high finds?** Data points already in the ledger (2026-09-09/10): high first passes found
the P1s on PR 29, PR 31 and PR 32; medium correctly approved PR 30 r2 and PR 31 r2.

## 7. Portability

As a Claude Code skill (`.claude/skills/review-effort/`): the rubric table, the launch commands, and a
logging hook. Only the sink is Retrace-specific; elsewhere the decision record can go to a file or a PR
comment. The evaluation loop in §6 is the part that needs a ledger. §11 assesses a named alternative that
keeps the composition portable and deliberately records nothing.

## 8. Out of scope for v1

Learned classification; per-task model selection inside a role; routing of the coordinator's own effort
(not controllable from inside a session); any change to what counts as a valid review (a low-effort
approve is recorded as such, not rejected).

## 9. Acceptance for v1

R1 Every spawned review has a routing event before its first ledger event, naming rule version, rules
   and models digests, head sha and class.
R2 A review event without `reasoning_effort` on a model `models.json` says supports it is a WARN; on one
   that does not, it is expected and not a finding.
R3 A review event's self-reported effort ≠ its cited routing event's intent → WARN on `/status`,
   reconcile finding, displayed side by side; a review citing no routing event → WARN. PR 35's
   doctor-only advisory is partial delivery; `/status` and reconcile are deferred to a follow-up PR.
R4 A PR touching any class-S path is never routed below high on first pass; a pin lower than the rubric
   is refused; a pin whose event is not owner/pinned-stamped by an authorised principal is ignored and
   reported.
R5 Escalation and re-classification each record a new routing event (`escalated_from`, signal, new head
   sha) **before** launch; a review launched without one is a finding.
R6 The rubric and models registry are data files with digests recorded in every routing event.
R7 A PR that receives a push after routing is re-classified against the new head before any further
   review event is accepted as fulfilling a routing decision.

## 10. Dispositions (v1 → v2, Nemotron 3 Ultra via NOOA, evt_316223f7…)

| Finding | Where answered |
|---|---|
| F1 High — TOCTOU: intent recorded before launch; agent may run elsewhere | §2 truth-vs-intent bullet; §4 step 3; §5 `routing_event_id`; R3 |
| F2 High — pins unauthenticated | §3 pins as stamped ledger events by an authorised principal; R4 |
| F3 Medium — escalation ordering | §4 step 4 record-then-launch; R5 |
| F4 Medium — moving head | §3 head-sha classification, re-classify per push; §5 `head_sha`; R7 |
| F5 Low — which models support effort | §5 `models.json` + digest; R2 |
| F6 Low — self-reported tokens | §6 advisory only |

## 11. Prior art: orchflows (added 2026-09-18)

`DanMcInerney/orchflows` (MIT; created 2026-07-18; read at `main` = `36c9d46`, pushed 2026-09-18 20:15Z,
97 stars / 9 forks) composes two primitives — `orch-work` and `orch-review` — into Markdown workflows
that a host's native subagents execute. It is the closest live prior art to this note, and it is useful
here precisely because it states as **instructions** several of the rules this note states as **events**.
Read for this section: `README.md` and `docs/architecture.md` at that sha. Not read: `scripts/`,
`guidance/`, the example workflows, the E2E suite. Every quotation below is verbatim from those two
files at that sha; the repository moves fast enough that a read two days earlier (2026-09-16) quoted
README sentences that no longer exist, so cite it by sha and never by `main`.

### 11.1 Where it agrees with this note

| Rule | orchflows states it as an instruction | Here it is an event |
|---|---|---|
| Reviewer ≠ builder | "a fresh native child who did not make it reviews without fixing" (architecture, *Two primitives*); "never replace required independent review with self-review" (*Execution*) | agent-rules 11; the verdict event names the reviewing seat |
| Effort and model are per-assignment, with precedence | "Model and effort are optional for work, review, stages and named assignments. Resolve each separately: current caller instructions override saved preferences; within either source, named assignment overrides stage, then operation default." (*Model and effort*) | §3 rubric + §5 `target` |
| Never substitute a setting you cannot honour | "report unsupported settings as gaps without substituting values" (*Model and effort*) | §5 `models.json` + R2; a reviewer recording `reasoning_effort: not_exposed` rather than guessing |
| A verdict binds to what was inspected | "Verdicts apply only to the inspected state and scope; changes do not inherit them." (*Review*) | R7 and agent-rules 11: the routing event records the head sha, the verdict cites the routing event |
| No claims ahead of evidence | "Gather required outcomes before dependent work; report missing work as a gap." (*Execution*) | agent-rules 0 |

Two projects reaching the same five rules independently is the strongest external support these rules
have. It also shows the split cleanly: orchflows is prescriptive, this note is evidentiary, and they do
not do each other's job.

### 11.2 Where it diverges, and why that matters for §9

Orchflows produces no record on purpose: "Orchflows supplies no agent runtime, scheduler or workflow
language" (README) and "No shared event format or runtime is required" (*Iteration bounds*). Three
consequences follow for the acceptance criteria in §9 — none of them defects in orchflows, all of them
reasons its composition cannot stand in for this note's mechanism:

1. **Independence is asserted, not recorded.** "Work directly or reuse a worker only when those
   settings can be honored; otherwise use a fresh worker" (*Model and effort*) leaves three legitimate
   staffing paths, and nothing afterwards says which one ran. A later reader cannot distinguish a fresh
   reviewer from the coordinator's own pass. R1 and R3 exist to make exactly that difference checkable.
2. **An effort mismatch is undetectable.** R3 compares self-reported effort against routing intent, and
   that needs both records. Orchflows keeps neither, so a review that ran below its assignment reads the
   same as one that ran at it.
3. **It is host-bound.** Children are subagents of one host session on one credential. The seats here
   are cross-vendor with separate credentials and producer keys (agent-rules 7, 13), and that separation
   is most of what a verdict is worth. Routing gate seats through one host's subagents would collapse it.

Its testing posture is worth naming for contrast: the E2E framework "asks a fresh evaluator whether the
process and result were acceptable", where "Unsupported review, unauthorized effects and material wrong
results fail" (README). That is a suite asserting the process at test time — valuable, and orthogonal to
a per-run record a later reader can verify. The same README says of its own timing, "That is one
observation, not a reliability estimate," which is agent-rules 0 applied to its own claims.

### 11.3 Guidance documents versus §3's rubric

Orchflows puts the specificity outside the workflows: "Workflows express dependencies, independence,
review gates and stopping conditions. Guidance expresses what good work looks like" (README), under the
thesis "A better model should need fewer instructions, not a new workflow architecture" and the
maintenance rule "When a model stops needing a corrective instruction, test removing that instruction
from guidance."

§3 takes the same move for the same reason — the rubric and `routing-rules/models.json` are data files,
not prose inside the skill, so a model's supported levels change by editing data (R6). The divergence is
what happens to the old text. Orchflows deletes instructions a better model no longer needs, which is
right for a library whose only job is the next run. Here the digest of the rules in force is recorded in
every routing event (§5), so deleting a stale rule never makes a past decision unreadable: the event
still names the `rule_version` and `rules_digest` it was decided under. **Editable guidance explains the
next run; a digest-pinned rubric also explains the last one.** That is the sentence to reach for when
someone asks why the rubric is versioned data rather than advice.

### 11.4 What this note takes from it

- **Adopt the precedence form.** Its one-sentence resolution order — caller instruction over saved
  preference, and within either, named assignment over stage over operation default — is clearer than
  anything §3 or §5 currently says about how a pin, the rubric default and a coordinator's explicit
  choice combine. v2 should state precedence explicitly in that form (pin still raises and never lowers,
  per R4).
- **Do not adopt it in the gate path**, now or soon: §9 is a set of claims about records, and records
  are the one thing orchflows deliberately does not produce.
- **The integration seam, if it ever wants records**, is one step: after a verdict, emit an event
  carrying `routing_event_id`, the self-reported effort and the reviewed head sha (§5). A generic tool
  cannot mint per-seat producer keys (agent-rules 13), so a v1 would be unsigned client logging and
  would have to be labelled as such — weaker than a seat here, stronger than nothing.
