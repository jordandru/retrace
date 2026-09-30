# Owner-login classification at the 1,000 ms budget — live, 2026-09-30

**Status:** v1, 2026-09-30 (≈ 20:40Z / 14:40 MDT). Author claude-code (coordinator). Class **(b)** under agent-rules 12: a measurement that
governs nothing; one non-author review. Go: `evt_6ee7d69dcbec4df0ad4c2ac5adf56d50` ("a, you measure"). Earlier versions of this file: v0
(skeleton) and v0.1 (the status line whose push is sample 5).

## 1. What is measured
Worker Version `4cdeb1e9-d873-4633-9ba3-17d7f065244a` (main `bbf61d3d`, PR 145: `OWNER_LOGIN_DEADLINE_MS` 300 → 1,000 ms), deployed
2026-09-30T20:25:00Z (outcome `evt_cb7abcc830144a799172d8bc6b254086`); placement off. The sample is this pull request's own six GitHub
writes. Each was declared under agent-ops 19 before the `gh` call, in the classifier's declaration shape (`method.params.github_action`: kind,
repo, login, pr or branch artifact, content hashes). So an eligible, pinned, unconsumed declaration existed for each delivery. Every decision
below was read raw from the ledger (events list for ids, then each event's `method.params.owner_login_decision`).

## 2. Sample

| # | kind | seal | seq | status / reason | classification_ms | pre_ms | candidates_ms | filter_ms | consumption_ms | amendments_ms | stage_failed | candidates_rows | budget_rows_remaining | declaration |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `pr_open` | `evt_a0fa23c41ef14b90b9301e9d78af7f36` | 10266 | unavailable / store_error | 426 | 171 | 94 | 0 | 80 | 252 | amendments | 4 | 1991 | `evt_982140028ade48ac89266bd541dd55f0` |
| 2 | `comment` | `evt_f2fddfbe0f904aceb3b1a91c73ea7521` | 10270 | unavailable / store_error | 442 | 560 | 93 | 0 | 87 | 262 | amendments | 4 | 1991 | `evt_08256c0a1f5042a09940ce1dc48a5992` |
| 3 | `pr_edit` | `evt_30852aa9cbf840d0b1ca58020e93b484` | 10273 | unavailable / store_error | 431 | 167 | 88 | 0 | 85 | 258 | amendments | 9 | 1986 | `evt_1b65e7d38baf4371ac455cee999e84b0` |
| 4 | `comment` | `evt_ac2cf68e4ad14b7e8ec58f8eea75dc1b` | 10275 | unavailable / store_error | 432 | 165 | 91 | 0 | 81 | 260 | amendments | 9 | 1986 | `evt_36857d4d27ad44b4aee96a4c64069fdb` |
| 5 | `push` | `evt_06ae292a1fbc41f39984d1412abe1bf7` | 10280 | unavailable / store_error | 456 | 166 | 97 | 0 | 87 | 272 | amendments | 15 | 1980 | `evt_26e3e493317e471fa8b084b2701d66f3` |
| 6 | `comment` | `evt_05a05c2b6d1b4383a491999dfa1044ff` | 10283 | unavailable / store_error | 435 | 173 | 93 | 0 | 82 | 260 | amendments | 14 | 1981 | `evt_b8126f7144af4246a06c6b1fce41b0ce` |

Ranges and medians over the six (computed): `classification_ms` 426–456, median 433.5. `candidates_ms` 88–97, median 93.
`consumption_ms` 80–87, median 83.5. `amendments_ms` 252–272, median 260. `pre_ms` 165–560, median 169. `deadline_ms` 1,000 on every sample.

## 3. Reading
1. **The budget no longer binds.** No sample hit the deadline; every classification ended at 426–456 ms, well under 1,000.
2. **A different failure is now visible: `store_error` in the amendments stage, 6 of 6**, across four kinds (pr_open, comment, pr_edit,
   push). At 300 ms the deadline fired first (step-B record), so this failure was hidden. No delivery attributed a seat; each seal names the
   account (`system github:jordandru`), fail-closed as designed.
3. Per-call times are unchanged from step B (candidates median 93 vs 89; consumption 83.5 vs 81).

## 4. Not established (the next step)
**Which** `store_error` path fires. `evaluateAmendmentsAtU` (`packages/core/src/classify.ts`) returns `store_error` from several places: a
throw in `amendmentEventsUpTo`; an unresolvable dependency id after `getMany`; `amendmentCaptureDependencies`, when `classifierCaptureSeals`
returns `{ ok: false }` (a stamped capture seal whose commit reference does not resolve to a full key, or resolves two ways), a capture
seal key that does not parse, or a repository missing from the policy; and `collection.unavailable`. **Lead, not a finding:** about 260 ms is
roughly three calls at the measured per-call cost (amendment rows, `getMany`, one capture read), which points past the dependency reads. The
code comment above `classifierCaptureSeals` records a 2026-09-15 case in which one unresolvable commit reference made every classification
unavailable (`evt_2a4dfb78`). Identifying the path needs a reproduction against the live events (replay at the sealed read head), and that
is a separate step.
