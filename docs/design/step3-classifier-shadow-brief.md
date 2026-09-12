# Step 3 builder brief — classifier in shadow (`RETRACE_TRAILER_POLICY=shadow`)

**Status:** v2, 2026-09-10, author claude-code (coordinator). Not built. §15 step 3 of
`commit-trailer-consistency.md` (v2.5.1). Prerequisites LIVE: step 1 (producer-sig `/2`, Worker 8bca96a1+),
step 2 (credential `principal` + never-reissue, PR 31; stored policy document, PR 32 — contract
`project-policy-document.md` v4.2; `selectPolicyForContext`, `bundle.policies`, activation predicate exist).
v2 folds the Nemotron 3 Ultra design pass (run `review_38dea7e42d5c`, `evt_f32b78aa3af24e2ab72352988d997470`);
dispositions are in §6 — read it before building, two of its findings rest on premises that are wrong in the
reviewer's terms and right in the design's. Codex first code review once its budget resets (2026-09-14 22:07),
Claude last. Builder: cursor-agent in a **fresh** thread.

## 0. What step 3 is — and is not

Build `classifyCommitClaim` and the **classification context table**, run it on every commit seal at
Worker ingestion under `shadow`, and write `method.params.claim_decision` (§6) **without changing
`actor`** (`actor_written: "claim"`, `shadow: true`; T25). No withholding, no 426 (that is step 6),
no consumer changes beyond what recording the decision literally requires (step 4). `/1`-signed commit
seals stay byte-preserved and are counted `legacy_client` (§6 rule 5; T38 already lands the counting).
Unsigned and `/2`-signed commit seals receive `claim_decision`. The webhook producer runs the same
function through the pending path (§5.3). Design text wins over this brief; file discrepancies in the PR.

Shadow adds information and removes none: before it, the same seal carries the same `actor` with **no**
recorded decision. Nothing in step 3 may make an existing property weaker (§6 #1).

## 1. Inputs, in the order the code should be built

1. **Claim** (§3.1, §5.1): re-derive from the signed `raw_message` + `author` + `parents` with
   `resolveCommitActor` — the hook's asserted claim that differs from the re-derived one is `malformed`.
   Record `claim: { type, id, source, model?, raw_trailers }` and `caused_by: { id?, source, root?, problem? }`
   (§3.4 — the chain is recorded, never used to find witnesses).
2. **Facts `F`** (§5.1): hook = submitted files + parents; webhook = GitHub's `added/modified/removed`.
   Canonical repository `R` from routing (contract §7, pinned on the delivery). Context key
   `(project, R, full sha)` (§3.2; contract §6 — forks share SHAs, aliases map to one `R`).
3. **Policy** (contract §5A/§6): for a **new** context, the version whose activation event has the
   greatest `seq ≤ U` — activations are a total order in the ledger, so "two policies active at once"
   cannot arise and needs no tie-break. For an **existing** context, retrieve by `(project,
   context.policy_digest)` **exactly** — never latest, never a union. Same snapshot as the evidence read
   (`{U, events ≤ U, activations ≤ U}`). The context stores `policy_digest`, `read_head_seq = U`,
   `classifier_profile: "trailer-consistency/1"`, `rollout_mode`, and the amendment snapshot used. Missing
   policy in shadow → the delivery stays **pending** and the hook is queued loud (contract §7, P8) — never a
   seal without a decision.
4. **Window** (§3.2): `U` = head at the **first** read of this sha, persisted as the context's
   `read_head_seq`. `lower(p)` per path = `previousCaptureTouch(p, before = U)` (0 if none), **always
   evaluated at the context's `U`, never at a later delivery's own head** — that prefix is immutable, so
   every producer, retry, drain and offline re-derivation gets the same answer. Persist the context and
   each `lower(p)` **insert-if-absent**; two concurrent first classifiers race on the insert and the loser
   re-reads the winner's context and recomputes against it (§3.2). A path the first producer did not submit
   gets its bound derived at that same `U` and cached into the row on first use. T11/T26/T37, both orders.
   `previousCaptureTouch(touches, path, before)` in `capture.ts` takes a touch list, not a store — the
   query that feeds it is yours to write inside the §3.5 budget.
5. **Witnesses** (§3.3, restated in full — the design text governs): `E.project` = project; `lower(p) < E.seq ≤ U`; `E.method.params.sealed_by`
   **starts with `pinned:`** — `assert:*`, `owner`, `webhook:github`, unstamped and local-only seals are
   **never** witnesses, whatever else they carry (a producer signature does not substitute for the stamp);
   `actor.type = agent`; `action ∉ {instructed, committed, merged}`; `action_detail ≠ amended`; artifact is
   canonical `repo:R#p` (or policy alias) with `role ∈ {generated, both}` or no role with a writing action;
   bare/`file:` references are `loose_hints` only; not the target of an effective attribution amendment at
   `U`. Read through `eventsReferencingArtifacts` (PR 27) within the §3.5 budget: 500 ms / 20,000 rows; over
   budget or store error → `unavailable` (nothing sealed; pending).
6. **Decision** (§4 table, condensed — the table governs): `supported` (`C ∈ Wall`); `conflicting/no_match` (`Wall ≠ ∅`,
   `C ∉ Wall`); `unresolved/{loose_evidence_only | root_only | unrooted}` (`Wall = ∅`);
   `malformed_claim` → `conflicting` if `Wall ≠ ∅` else `unresolved`; human/bot author →
   `human_claim_with_agent_evidence` / `no_agent_evidence`; merge with no emitted files →
   `merge_unclassified`. `unresolved_policy` comes from the **policy document** (`record` default — Jordan's
   decision; `withhold` recorded but **not applied** in shadow). In shadow also record what enforce
   **would** have written — see §1.7 `would_write`.
7. **Seal record** (§6): full `claim_decision` incl. `observer`, `claim`, `caused_by`, `signed_actor`
   (for `/2`), `decision.{status, reason, actor_written:"claim", unresolved_policy, shadow:true, context,
   submitted, window, witnesses[], witness_actors, loose_hints, harness}`. Server-derived; a caller-supplied
   `claim_decision` is discarded (T17). `harness.mismatch` is informational (T22).
   **New in shadow — `decision.would_write`:** `{ actor_written: "claim" | "withheld", reason? }`, the
   actor disposition enforce would have produced for this same decision (`conflicting` → `withheld`;
   `unresolved` → the policy's value; everything else → `claim`). Constraints, all load-bearing:
   - it lives **inside** `claim_decision`, which is already in `RESERVED_METHOD_PARAMS_V2`, so it is **not**
     a new reserved param and needs **no** `/3` bump (§6 rule 1);
   - it is informational and **never a selector**. The `/2` withheld-verification rule keys strictly on
     `decision.actor_written = "withheld"` (§6 rule 3, one path, "the verifier never accepts a second
     selector field"). Shadow never writes that value, so rule 3 must never fire in shadow — assert it;
   - one field, not two. The reviewer asked for `would_withhold: true` beside a reason (§6 #3); a boolean
     that duplicates a field the verifier already keys on is exactly the second selector the design
     forbids, so the same information is carried by `would_write.actor_written`.

## 2. Webhook pending path and breaker (§5.3)

Store read > 500 ms → `202 pending`, durable row (PR 27's `pending_deliveries` + PR 32's routing pin),
drained by the 5-minute cron; the drain's first classification creates the context (first-attempt
semantics, T18).

**Breaker contract** (settled by §5.3; restated here because a builder should not have to infer a state
machine from prose):

- **Scope and storage.** One shared D1 row per project (`breaker(project, failures, opened_at, …)`).
  Counters and failure timestamps live in the row, never in process memory — Worker isolates cannot see
  each other's counters, and a global counter would let one project penalise another (T36).
- **What counts as a failure.** A per-commit classification outcome of `deadline` (latency over the 500 ms
  per-commit budget) or `store_error`. A `budget` outcome (the 20,000-row cap) is **not** a breaker
  failure: it is the per-commit path that ends in `budget_failed` after three drains (§5.3).
- **States.** `closed` → 3 consecutive failures within a 5-minute window → `open`. While `open` (5 min),
  webhook deliveries for that project skip synchronous classification and return `202 pending`; the hook
  path is a different route and budget and is unaffected. No `conflicting` and no `unresolved` may be
  produced while open — both require a completed read (T19).
- **Half-open.** The first delivery after the open window is the probe, **claimed atomically** by
  compare-and-set on the breaker row so simultaneous deliveries do not all probe. Success → `closed`;
  failure → `open` again with a fresh `opened_at`. An abandoned probe expires with the lease window (60 s,
  as for `pending_deliveries` leases).

Three points §5.3 does not settle. The PR must **state which it implements and test it** (flag them in the
PR description for Codex and me; if closing one needs a new recorded field, it is a contract amendment,
not a builder's choice):
(a) do failures inside the cron drain count toward the breaker, or only synchronous webhook deliveries?
(b) does an open breaker also short-circuit the drain, or does the drain keep classifying?
(c) what resets `failures` — any success, or the 5-minute window elapsing without a third failure?

## 3. What must NOT change

`actor` on any seal; `/1`-signed seal bytes; the producer-signature verifier (PR 29/32 contract);
`RESERVED_METHOD_PARAMS_V2` (adding a name is a `/3`); consumers' verdicts (step 4); the default policy.

## 4. Acceptance (design §11 numbering; each must exist as a test)

T1–T6 decision table (incl. T5: a prior git seal is never a witness; T6: per-commit actor equality with
per-file coverage still reported by reconcile); T7 caused_by problems recorded, decided by witnesses alone;
T8/T9 malformed claims; T10 same agent id from two credentials both witness (documented limit); T11 both
producer orders identical decisions; T12 both `conflicting` → one finding (step 4 asserts; context proves);
T13 amend → different sha; T17 caller `claim_decision` discarded; T18 pending + drain first-attempt;
T19 breaker; T22 harness mismatch informational; T23 duplicate delivery dedup; T24 local ledger
`unresolved/no_authenticated_ingress`; T25 shadow writes `conflicting` with actor unchanged; T26
read-before-append race; T28 chosen `F` stands on submitted facts; T31 A-edits/B-commits gap documented;
T35 different `F` under one context; T36 breaker per project; T37 new-path lower bound; T40 clean
commit needs no certificate. Plus, from step 2: contract P4 (policy selected at `U`, drift reported),
P7 (fork vs alias contexts), P8 (missing policy pending in shadow), and the **two-connection D1 race test**
deferred from PR 32 (`applyPolicyWrite` and the context insert-if-absent).

**Additions from the v2 design pass** (brief-local ids; fold into design §11 as T41–T45 at its next revision):

- **A1 (extends T25) — `would_write`.** Shadow `conflicting` → `actor_written: "claim"`,
  `would_write.actor_written: "withheld"`, `actor` unchanged. Shadow `unresolved` under a `withhold`
  policy → same shape with the policy's reason; under `record` → `would_write.actor_written: "claim"`.
  Assert the `/2` rule-3 substitution does **not** fire on any shadow seal.
- **A2 (extends T26/T37) — context creation race.** Two concurrent first classifiers of one sha with
  different heads: one context row wins; the loser recomputes against the winner's `read_head_seq`; both
  seals record identical `window.per_path_lower`, in both producer orders. A path only the second producer
  submits gets its bound at the context's `U`, cached, and identical on a third read.
- **A3 (extends T22) — `harness.mismatch` is populated, both ways.** Witness clients disagreeing with the
  claim's harness → `mismatch: true`; witness clients agreeing → `mismatch: false`; in neither case does
  `status`, `actor` or `would_write` change. Note the correction in §6 #6: divergent `F` between hook and
  webhook is **`facts_disagreement`** (T28/T35), not `harness.mismatch`; a test that conflates them would
  encode the wrong meaning.
- **A4 — loose-reference stuffing.** A commit whose trailers and event refs carry many bare paths,
  `file:` refs and paths outside `F`: none appear in `witnesses[]` or `witness_actors`; `status` is
  unchanged (`Wall = ∅` still yields `unresolved`, with `reason: loose_evidence_only` at most);
  `loose_hints` stays a **count** (§6) and no path string from it reaches the actor decision.
- **A5 — context key under route reassignment** (open question Q4, §7): the behaviour the PR chooses,
  under test — a sha already classified under canonical `R1` whose repository is later reassigned
  (contract §7 `?reassign=`) and delivered again under `R2`.

## 5. Rollout after merge

Deploy Worker with `RETRACE_TRAILER_POLICY=shadow` for `retrace` and `boxing-rpg` only after: policies
present for both (done), `/status` shows `legacy_client = 0` for new seals (all hooks on 0.1.9 — the
main checkout is; `boxing-rpg` runs `.githooks/` via `core.hooksPath` against the main dist and is on 0.1.9 —
verified by Grok in PR 37; `retrace-git install` there would write an unreachable `.git/hooks/`), and a dry run against an export
replays ≥ 50 recent commits with the expected histogram. Then §15 step 5 (Grok, ≥ 7 days; cost profile).

## 6. Review disposition — Nemotron 3 Ultra design pass (`review_38dea7e42d5c`)

Event `evt_f32b78aa3af24e2ab72352988d997470`; artifact `design-review-step3-classifier-shadow-brief-review_38dea7e42d5c.md`
(reviewed at 10ff53a, design sha256 `cdef5b7d…`). Verdict was "needs changes: #1–#4". Findings #3–#7
accepted, #1–#2 rejected on the design text; two accepted findings carry a mistaken premise, corrected here
rather than silently dropped.

| # | Sev | Claim | Disposition |
|---|---|---|---|
| 1 | High | Shadow records `conflicting` while `actor` still says the claim → actor spoofing | **Rejected.** That is the definition of shadow, decided in §9 Phase A and tested by T25: classify and record, `actor` unchanged, measure for ≥ 7 days, then Phase B withholds. Shadow introduces no new exposure — the pre-classifier seal writes the same `actor` with no decision at all, and the seal now additionally carries `signed_actor` and a recorded `conflicting`. The residual the finding is pointing at — consumers reading `actor` without the decision — is closed by step 4 (§7.0's single resolution predicate) and step 6, not by weakening shadow. Its proposed `effective_actor` field is also refused on its own terms: a second field consumers must prefer over `actor` is the second selector §6 rule 3 forbids. What the finding did earn: §1.7's explicit rule that `would_write` must never become such a selector. |
| 2 | High | Witness filter excludes `pinned:` but admits `local` seals | **Rejected — inverted reading.** §3.3 says the opposite of the finding's premise: `sealed_by` must **start with `pinned:`**, and "`assert:*`, `owner`, `webhook:github`, unstamped and local-only seals are **not** witnesses". The brief's v1 parenthetical compressed that list and was read as a list of `pinned:` prefixes. No semantic change; §1.5 is reworded so no builder can make the same reading. |
| 3 | Med | Shadow ignores `unresolved_policy: withhold`, so the histogram cannot see it | **Accepted** as `decision.would_write` (§1.7, A1) — with one field rather than the proposed `would_withhold` + `would_write` pair, for the selector reason above. |
| 4 | Med | Concurrent deliveries can compute `lower(p)` at different heads | **Accepted** as a clarification: §3.2 already fixes every bound at the context's `U` and has the insert loser recompute, but the brief said "derived at `U`" without saying *whose* `U`. §1.4 now states it and A2 tests both orders. |
| 5 | Med | Breaker underspecified | **Accepted:** §2 is now a compact breaker contract restated from §5.3, with the three genuinely open points named for the PR to close. The finding's guess that a "deadline" might mean a drain cycle is answered: it is a per-commit outcome, and `budget` does not trip the breaker. |
| 6 | Low | No test asserts `harness.mismatch` is populated | **Accepted as A3, premise corrected.** `harness.mismatch` is about witness *clients* versus the claim's harness (§6, T22). Divergent file lists between hook and webhook are `facts_disagreement` (§5.1, T28/T35) and must not be folded into `harness.mismatch`. |
| 7 | Low | `loose_hints` stuffing could inflate `witness_actors` | **Accepted as A4, premise corrected.** `loose_hints` is a **count** in §6, and §4 states loose evidence never changes the actor written. The adversarial test is still worth having — it pins the property against a future implementation that promotes hints. |

Answers Q1–Q3 are folded above (Q1 → §1.3 selection rule, §1.4 helper signature, the context columns in
§3.2 of the design, and §5.3 for what happens to a failed read; Q2 → §2; Q3 → §1.7). Q4 is **open** and
carried to §7. Weighting note for later reviews: this reviewer misread D1 batch atomicity once during PR 32
and misread §3.3 here — its structural questions have been valuable, its readings of specific clauses need
checking against the text.

## 7. Open questions the PR must close

**Q4 (from the design pass) — context key versus route reassignment.** The context key is
`(project, R, full sha)`; contract §7 allows a repository's route to move between projects atomically
(`?reassign=`) and pins the resolved route on a pending delivery. A later delivery of an already-classified
sha under a different canonical `R` therefore addresses a **different context key**. State which behaviour
you implement — a second context, or a lookup that finds the existing `(project, sha)` context and records
the repository change — and test it (A5). If your answer needs a new recorded field, stop and say so: that
is a contract amendment for the design, not a builder decision.

**Breaker (a)–(c)** in §2.

**Where the code lands.** The context table needs the same four places as PR 32's tables:
`apps/worker/schema.sql`, `apps/worker/src/d1-store.ts`, `packages/mcp-server/src/sqlite-store.ts`
(local ledgers) and the `EventStore` interface in `packages/core/src/store.ts`, plus `mem-store.ts` for
tests. A store that cannot serve the context must fail closed, not silently return "no context" — the
step-2 read path already has one such gap in the field (`RemoteStore` implements none of the policy
readers, so MCP `retrace_status` reports `policy: none` on a project that has an active document); do not
add a second.
