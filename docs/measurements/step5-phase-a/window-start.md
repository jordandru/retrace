# Step 5 Phase A — window start (shadow live)

**Recorded:** 2026-09-15 04:41Z by claude-code (coordinator). Class (b) measurement; governs nothing.

## The start marker

- Shadow policy live: Worker `retrace-api` version `55aadd8f-aee0-4fdf-9c6e-996edaac1fcc`, deployed from
  main `6818bd9acb8416753a1a2a5970e067c9128392f3` (PR 34 classifier-in-shadow + PR 35 routing fields),
  D1 migrated (`evt_b7da45e76c784293b2f52ede36b0004f`), deployed (`evt_108a5f88a6f54d1382e6fa49c020333c`),
  `RETRACE_TRAILER_POLICY=shadow` set as a Worker secret (`evt_851b623e15ad4535a9abb4e1d10fac66`).
  **The window opens at that last event.** One Worker serves both projects, so the policy covers
  `retrace` and `boxing-rpg` together.
- Activation is proven only by a sealed commit carrying `method.params.claim_decision`; none had been
  observed when this note was written (rule 0). The first such seal is to be cited here by a dated
  addition.

## Window-start census (live `GET /projects/:p/status`, unmodified JSON beside this note)

| Project | Phase 0 baseline (2026-09-12 03:51Z) | Window start (2026-09-15 04:41Z) | Δ |
| --- | --- | --- | --- |
| retrace — events | 3,532 | 4,386 | +854 |
| retrace — causal coverage | 98.2 % | 98.2 % | 0 |
| retrace — unlinked commits | 41 | 53 | +12 |
| boxing-rpg — events | 137 | 185 | +48 |
| boxing-rpg — causal coverage | 19.0 % | 32.9 % | +13.9 pts |
| boxing-rpg — unlinked commits | 83 | 94 | +11 |

Reading: boxing-rpg's coverage rose between baseline and window start because the fixed MCP credential
let its agents log edits over the weekend; the shadow window measures **new** seals from here, not that
history (Phase 0 instrument doc §2). The retrace unlinked count grew with the checkpoint-bot and
merge traffic of 09-14/15 and is the baseline the window's `unlinked` numbers compare against.

## What comes next (the brief, `docs/design/step5-phase-a-measurement-brief.md`)

Histogram of `would_write` dispositions over the window → by-hand review of every `conflicting` case →
cost profile (labelled census / bench / proxy per row) → the step 6 decision. The instrument is
`scripts/phase-a-measure.mjs --since 2026-09-15T04:41:00Z` over an export bundle, never the live API in a
loop. Jordan's live boxing-rpg work during the window is the second-project evidence Grok's assessment
asked for.

## Addition 2026-09-15 04:53Z — window PAUSED (policy reverted to off)

The first commit attempted under shadow was this note's own commit `5b358464`; it was not sealed until after the revert. Both the hook's attempt
(04:42:51Z) and a replay (04:43:57Z) returned `503 classification_unavailable / deadline`; the webhook
copy went to `pending_deliveries` (attempt 0, outcome pending/deadline); `classification_breakers`
recorded one failure; `classification_contexts` stayed empty. Root cause by code read: the amendment
evaluation on the classifier's hot path loads every event of the project (`store.all`, 4,386 events on
retrace) inside the 500 ms budget (`packages/core/src/classify.ts` ~396–406). Finding
`evt_e39d2f8ebea240f89bb74c3cd3e0042a`. On Jordan's go the policy was set back to `off`
(`evt_f9d8587309f9435cb817c3a77236feb4`) and the parked hook seal replayed (`evt_0eeedcb808154bef8c5a3c58836574b7`).
Shadow was live 12 minutes; one commit attempted; zero classifications completed; zero seals lost.
**Activation is therefore NOT proven**: no seal carrying `claim_decision` exists. The window restarts on
a redeploy with a bounded amendment query; the census above stays the "before" for that restart, and a
second start marker will be added here with its date.

## Second start marker 2026-09-15 19:09:30Z — window RESTARTED (shadow live on the bounded classifier)

- The P1 (`evt_e39d2f8ebea240f89bb74c3cd3e0042a`) is fixed by PR #51 "Bound classifier amendment scan",
  merged as `bba3757db1aa7e81c9665b09e932eaf00606b54e` (merge go `evt_945d08b2c0c548268a4cb9f03e092304`;
  gate of record `evt_0c55d1fdd25145238a841a9fc27ce676`): amendment candidates come from
  `amendmentEventsUpTo` on the new D1 index `idx_events_amendment_candidates`, witness and capture windows
  from `eventsReferencingArtifacts` (`json_each`-driven UNION members, `DISTINCT`, batched under workerd's
  limits), dependencies by point reads; a store without the bounded methods fails closed. No `store.all()`
  remains on the classify hot path.
- Deploy order as three separate go's: D1 migrated (`evt_95a7fd6b9c0547fe8d39bf6f1758ed81`; index present
  in `sqlite_master` before and after), Worker `retrace-api` version `66dcc89a-a453-4b97-a0b2-3084d255f83e`
  deployed from `bba3757` (`evt_6070bf10349249e19c3fdad3a41245c6`; root 200, fresh export chain ok over
  4,804 events), then `RETRACE_TRAILER_POLICY=shadow` set as a Worker secret, producing version
  `4c290ab1-0e4d-44bd-a0b0-1d72867a34f5` at 19:09:30.766Z (`evt_e31755ee9821423fb9412d90bbe53a2a`).
  **The window reopens at that secret-change event.** Project policy document present (digest
  `97dc14693483c1d78ee885a8c45219757668e6a0987ba0c28583132b9abc910e`). One Worker still serves `retrace`
  and `boxing-rpg` together.
- The census in this note's first section remains the "before" for this restart; no new census is taken.
- **Activation is not yet proven at the time of writing** (rule 0): the ledger holds zero seals carrying
  `method.params.claim_decision` between the first window's revert and this marker. This note's own commit
  is the first commit attempted under the restarted shadow; its outcome (a seal with `claim_decision`, or a
  parked seal with an `unavailable` reason) is to be cited here by a dated addition, as before.
