# Step 3 builder brief — classifier in shadow (`RETRACE_TRAILER_POLICY=shadow`)

**Status:** DRAFT v1, 2026-09-10, author claude-code (coordinator). Not built. §15 step 3 of
`commit-trailer-consistency.md` (v2.5.1). Prerequisites LIVE: step 1 (producer-sig `/2`, Worker 8bca96a1+),
step 2 (credential `principal` + never-reissue, PR 31; stored policy document, PR 32 — contract
`project-policy-document.md` v4.2; `selectPolicyForContext`, `bundle.policies`, activation predicate exist).
Reviewer-first: Nemotron 3 Ultra (NOOA) design pass on this brief, then Codex first code review once its
budget resets (2026-09-14 22:07), Claude last. Builder: cursor-agent in a **fresh** thread.

## 0. What step 3 is — and is not

Build `classifyCommitClaim` and the **classification context table**, run it on every commit seal at
Worker ingestion under `shadow`, and write `method.params.claim_decision` (§6) **without changing
`actor`** (`actor_written: "claim"`, `shadow: true`; T25). No withholding, no 426 (that is step 6),
no consumer changes beyond what recording the decision literally requires (step 4). `/1`-signed commit
seals stay byte-preserved and are counted `legacy_client` (§6 rule 5; T38 already lands the counting).
Unsigned and `/2`-signed commit seals receive `claim_decision`. The webhook producer runs the same
function through the pending path (§5.3). Design text wins over this brief; file discrepancies in the PR.

## 1. Inputs, in the order the code should be built

1. **Claim** (§3.1, §5.1): re-derive from the signed `raw_message` + `author` + `parents` with
   `resolveCommitActor` — the hook's asserted claim that differs from the re-derived one is `malformed`.
   Record `claim: { type, id, source, model?, raw_trailers }` and `caused_by: { id?, source, root?, problem? }`
   (§3.4 — the chain is recorded, never used to find witnesses).
2. **Facts `F`** (§5.1): hook = submitted files + parents; webhook = GitHub's `added/modified/removed`.
   Canonical repository `R` from routing (contract §7, pinned on the delivery). Context key
   `(project, R, full sha)` (§3.2; contract §6 — forks share SHAs, aliases map to one `R`).
3. **Policy** (contract §5A/§6): `selectPolicyForContext` on the same snapshot as the evidence read —
   `{U, events ≤ U, activations ≤ U}`; the context stores `policy_digest`, `read_head_seq = U`,
   `classifier_profile: "trailer-consistency/1"`, `rollout_mode`, and the amendment snapshot used. Missing
   policy in shadow → the delivery stays **pending** and the hook is queued loud (contract §7, P8) — never a
   seal without a decision.
4. **Window** (§3.2): `U` = head at the first read; `lower(p)` per path = seq of the previous seal touching
   `p` (0 if none). Persist the context **insert-if-absent**; every later producer, retry, drained
   delivery and new path reuses it (T11 both orders, T26 race, T37 new-path lower bound derived at `U`).
5. **Witnesses** (§3.3, verbatim): `E.project` = project; `lower(p) < E.seq ≤ U`; `sealed_by` starts
   `pinned:` (assert/owner/webhook/unstamped/local **never** witness); `actor.type = agent`;
   `action ∉ {instructed, committed, merged}`; `action_detail ≠ amended`; artifact is canonical `repo:R#p`
   (or policy alias) with `role ∈ {generated, both}` or no role with a writing action; bare/`file:`
   references are `loose_hints` only; not the target of an effective attribution amendment at `U`. Read
   through `eventsReferencingArtifacts` (PR 27) within the §3.5 budget: 500 ms / 20,000 rows; over budget
   or store error → `unavailable` (nothing sealed; pending).
6. **Decision** (§4 table, verbatim): `supported` (`C ∈ Wall`); `conflicting/no_match` (`Wall ≠ ∅`,
   `C ∉ Wall`); `unresolved/{loose_evidence_only | root_only | unrooted}` (`Wall = ∅`);
   `malformed_claim` → `conflicting` if `Wall ≠ ∅` else `unresolved`; human/bot author →
   `human_claim_with_agent_evidence` / `no_agent_evidence`; merge with no emitted files →
   `merge_unclassified`. `unresolved_policy` comes from the **policy document** (`record` default — Jordan's
   decision; `withhold` recorded but **not applied** in shadow).
7. **Seal record** (§6): full `claim_decision` incl. `observer`, `claim`, `caused_by`, `signed_actor`
   (for `/2`), `decision.{status, reason, actor_written:"claim", unresolved_policy, shadow:true, context,
   submitted, window, witnesses[], witness_actors, loose_hints, harness}`. Server-derived; a caller-supplied
   `claim_decision` is discarded (T17). `harness.mismatch` is informational (T22).

## 2. Webhook pending path and breaker (§5.3)

Store read > 500 ms → `202 pending`, durable row (PR 27's `pending_deliveries` + PR 32's routing pin),
drained by the 5-minute cron; the drain's first classification creates the context (first-attempt
semantics, T18). Per-project breaker: three consecutive deadlines open it; open → immediate `202 pending`;
no `conflicting` can be produced while open (T19); half-open probe after 5 min; counters in the shared row
(T36). Tracked notes to close here: atomic half-open claim, lease expiry, failure-window persistence,
drain/breaker interaction.

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

## 5. Rollout after merge

Deploy Worker with `RETRACE_TRAILER_POLICY=shadow` for `retrace` and `boxing-rpg` only after: policies
present for both (done), `/status` shows `legacy_client = 0` for new seals (all hooks on 0.1.9 — the
main checkout is; `boxing-rpg`'s hook needs `retrace-git install` re-run), and a dry run against an export
replays ≥ 50 recent commits with the expected histogram. Then §15 step 5 (Grok, ≥ 7 days; cost profile).

## 6. Open questions for the Nemotron design pass

Q1 Is anything in §1.3–§1.5 under-specified for a builder without reading §3 — name it. Q2 Breaker: does
the tracked-note list (§2) fully define the state machine, or does step 3 need a small contract like the
policy document got? Q3 Should `shadow` also record what `withhold` *would* have written, for step 5's
histogram? (Proposed: yes, as `decision.would_write`.) Q4 Any interaction between the context table and
PR 32's `policy_routes`/reassignment that could move a sha between contexts?
