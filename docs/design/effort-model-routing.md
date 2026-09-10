# Effort and model routing for spawned agents — design note

**Status:** DRAFT v1, 2026-09-10, author claude-code, on Jordan's ask (2026-09-10). Not built. Companion to
`docs/team-roles.md` (reviewer ≠ builder) and `commit-trailer-consistency.md` §15 step 5 (cost profile).
Reviewer for v1: Nemotron 3 Ultra via NOOA (cross-vendor; Codex's weekly budget is reserved for code). Nothing
here changes what the ledger records about *who did what*; it adds a recorded answer to *how much thinking
was bought for it*, and a way to check later whether that was the right amount.

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
- **Execution must match intent, and the ledger checks it.** The review event already records the model
  that actually ran (`actor.model`, truthful by rule); it gains the effort that actually ran. A routing
  decision naming `gpt-6-astra/high` whose review event reports `medium` is a discrepancy the ledger
  surfaces, exactly as it surfaces a wrong `actor.model` today.
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

A PR takes the **highest** class of any file it touches. Jordan may pin a level on a PR
(`Routing-Pin: high` in the PR body); the rubric defers and records the pin as the reason.

Model choice in v1 is **role-driven, not rubric-driven**: reviewer ≠ builder, and the reviewer is a
different vendor from the builder where possible (`docs/team-roles.md`). The rubric picks effort *within*
the role's model. v2 may let the rubric pick among models of one role once §6's data exists.

## 4. Mechanism

1. **Classify** the diff (`git diff --name-only base..head` → class; PR body pin overrides).
2. **Launch** the agent at the chosen level in its own terminal — Codex: `codex -c
   model_reasoning_effort=<level>`; Claude subagents: `model` parameter; others: their launch flags — and
   send the brief. A second pane at a different level is closed when its task's verdict posts.
3. **Record the decision** (§5) before the agent starts; record the outcome when its review event lands.
4. **Escalate** when a signal fires mid-task: suite red on the head, two reviewers disagree, a new
   surface appears in a later push → re-launch the review at the next level, recording the escalation.

## 5. What the ledger records

Routing decision (coordinator, before launch):
```
{ action: "other", actor: <coordinator>, intent: "route: PR 32 first pass",
  method: { tool: "routing", params: { rule_version: "effort-routing/1", surface_class: "S",
    target: { agent: "codex", model: "gpt-6-astra", effort: "high" }, pin: null,
    escalated_from: null, why: "touches router.ts ingress + policy.ts" } },
  artifacts: [ { id: "https://github.com/jordandru/retrace/pull/32", role: "used" } ] }
```
Review event (reviewer, unchanged shape plus one field): `method.params.reasoning_effort` next to the
truthful `actor.model`. Routing intent vs execution is a standard consumer check: a mismatch is a WARN on
`/status` and a finding in reconcile, like any other claim/evidence disagreement.

## 6. Measurement (Grok, alongside §15 step 5)

Per `(model, effort, surface_class)`: findings per first pass by severity; whether a later re-review or a
post-merge amendment found something the routed level missed; tokens (from the agent's own accounting
where available); wall-clock. The question the data must answer before v2: **for which classes does
medium find what high finds?** Data points already in the ledger (2026-09-09/10): high first passes found
the P1s on PR 29, PR 31 and PR 32; medium correctly approved PR 30 r2 and PR 31 r2.

## 7. Portability

As a Claude Code skill (`.claude/skills/review-effort/`): the rubric table, the launch commands, and a
logging hook. Only the sink is Retrace-specific; elsewhere the decision record can go to a file or a PR
comment. The evaluation loop in §6 is the part that needs a ledger.

## 8. Out of scope for v1

Learned classification; per-task model selection inside a role; routing of the coordinator's own effort
(not controllable from inside a session); any change to what counts as a valid review (a low-effort
approve is recorded as such, not rejected).

## 9. Acceptance for v1

R1 Every spawned review has a routing event before its first ledger event, naming rule version and class.
R2 A review event without `reasoning_effort` on a model that supports the setting is a WARN.
R3 Routing intent ≠ recorded effort → WARN on `/status`, reconcile finding.
R4 A PR touching any class-S path is never routed below high on first pass; a pin lower than the rubric
   is refused (pins raise, never lower).
R5 Escalation records `escalated_from` and the signal.
R6 The rubric is a data file (`routing-rules/1.json`) with a digest recorded in every routing event.
