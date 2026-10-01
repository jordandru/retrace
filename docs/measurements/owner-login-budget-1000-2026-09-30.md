# Owner-login classification at the 1,000 ms budget — live, 2026-09-30

**Status:** v1, 2026-09-30 (≈ 20:40Z / 14:40 MDT). Author claude-code (coordinator). Class **(b)** under agent-rules 12: a measurement that
governs nothing; one non-author review. Go: `evt_6ee7d69dcbec4df0ad4c2ac5adf56d50` ("a, you measure"). Earlier versions of this file: v0
(skeleton) and v0.1 (the status line whose push is sample 5). **v1.1** (2026-09-30, ≈ 22:35Z / 16:35 MDT): §5 added (diagnosis and fix); §§1–4 unchanged. **v1.2** (2026-10-01, ≈ 03:50Z / 21:50 MDT): §6 added (first post-fix sample and the read-only probes); §§1–5 unchanged. **v1.3** (2026-10-01, ≈ 12:50Z / 06:50 MDT): §7 added (every owner-login delivery after seq 10403, including the first per-call samples after PR 147); §§1–6 unchanged.

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

## 5. Diagnosis and fix (added 2026-09-30, v1.1)
Go for the diagnosis: `evt_873053bb47da43c2a139e56efabcef30` ("you diagnose"). Diagnosis event: `evt_1b22cec2b58045a78dd454eddff14b6d`.

1. **The path.** It is the capture read inside `amendmentCaptureDependencies`, the third call that the §4 lead pointed to.
   - The one amendment in scope (seq 2543, commit `5d7290f`, 11 files) makes the classifier look up each file under the policy's owner-less alias
     `retrace`.
   - Before PR 60, `artifactLookup` (`packages/core/src/capture.ts`) turned each lookup into `GLOB 'repo:*/retrace#<path>'`.
   - Seven of the eleven patterns are longer than 50 bytes; the longest is 59 (`packages/mcp-server/src/producer-key.test.ts`).
   - workerd/D1 rejects a LIKE or GLOB pattern over 50 bytes (`LIKE or GLOB pattern too complex`), and the bare catch in
     `runArtifactIndexStatements` returns `store_error`.
   - An offline `MemoryEventStore` replay at the sealed read head (U = 10265) succeeds, because that store matches in JavaScript and has no pattern
     limit. That is also why no local test saw it.
2. **Not new.** It is the same defect as the third shadow-window failure on 2026-09-15 (`evt_ea963123…`). A fix was built then as PR 60, approved
   by its first review seat, and never merged. The 300 ms deadline hid the defect on the owner-login path until PR 145 raised it.
3. **Fix.** PR 60 was revived (Codex, round 5) and merged as `b96676bc`. It replaces the GLOB with a `repo:` key range plus byte suffix equality,
   and adds a workerd regression test using the 11 files of `5d7290f`. The test fails on the old code with exactly
   `amendment capture read: {"ok":false,"reason":"store_error"}`, reproduced independently by the last review seat (`evt_3f792d8f…`).
   - Deployed as Worker Version `77400e6e-668e-447e-b4e5-bfbc0a6970ee` at 2026-09-30T22:26:34Z (`evt_48a996bf…`), placement off, with a 1,000 ms
     budget.
4. **Before the fix, one more sample on the old Version.** Seq 10388 (the PR 60 merge, 22:16:29Z) was `unavailable / store_error`,
   `stage_failed: amendments`, `amendments_ms` 258, `classification_ms` 511.
5. **Not yet established.** Whether owner-login deliveries now seal a decision on the new Version. The push of this v1.1 is the first delivery
   after the deploy. Its decision, and those that follow, will be recorded in a later version of this file, read raw from the ledger as in §2.

## 6. After the fix: one sample and three read-only probes (added 2026-10-01, v1.2)
Go: `evt_ac83ca0df60c4a4099a4caba402a7630`.

1. **Sample 7, the first delivery on Worker `77400e6e`.** It was the v1.1 push of this PR (head `e7a75559`, declared
   `evt_0be1ab270ab749c8a7a3b4052ac5d5c7`), sealed as seq 10403 (`evt_32c1e45665864f3a8b796046647222aa`, 2026-09-30T22:33:21Z):

   | # | kind | status / reason | classification_ms | pre_ms | candidates_ms | filter_ms | consumption_ms | amendments_ms | stage_failed | candidates_rows | budget_rows_remaining |
   |---|---|---|---|---|---|---|---|---|---|---|---|
   | 7 | `push` | unavailable / deadline | 1000 | 165 | 107 | 0 | 91 | 802 | amendments | 26 | 1969 |

   - **`store_error` is gone:** the amendments stage now runs its reads.
   - **But it takes 802 ms**, and the classification reaches the 1,000 ms deadline. The decision is still fail-closed: the seal names the
     account and attributes no seat.
   - This is **one sample**. No further owner-login delivery had arrived when this was written.
2. **Probes on production D1, read-only** (step 17 `evt_c0af48a7`, step 18 `evt_19d8e70c`, step 18b `evt_c3c5760c`; every query reported 0 changes).
   They ran the stage's capture read for amendment seq 2543 (11 files, whole history) as the deployed code builds it:
   - **SQL time:** 170–188 ms. The same keys owner-qualified (exact matches only) take 28–49 ms. So the suffix range scan costs about 140 ms.
   - **Volume:** 946 rows and 3,584,145 bytes of event bodies, for about 945 events in both variants. Only 389 rows (41 %, 1,784,532 bytes)
     are shaped like capture seals; the rest are agent logs and reviews the classifier discards.
   - **Duplicated bodies:** each body is returned once per matching (event, file) pair. Capture-shaped events average about 2.25 copies.
3. **Reading.** SQL accounts for at most about 190 ms of the 802 ms. The remainder (transfer, `JSON.parse`, the stage's other reads) is
   **inferred, not measured**. Per-call timing inside the stage is being built (cursor-agent, `evt_f3bb53d4…`) to measure it before any fix is
   chosen.

## 7. Every owner-login delivery after seq 10403, through seq 10649 (added 2026-10-01, v1.3)
Go: `evt_1799013926ae4cc5b5cf4c8a3ec0704c`.

How the sample was taken:
- Every event sealed after seq 10403 that carries `method.params.owner_login_decision`, read raw (listed at 2026-10-01T12:44:53Z, through
  seq 10649).
- There are **17 deliveries**. Every one is `unavailable / deadline`, with `classification_ms` 1000 and `stage_failed: amendments`.
- None attributed a seat. Each seal names the account, failing closed as designed.
- Nothing was selected out.

### 7.1 On Worker `77400e6e` (PR 60), before the PR 147 deploy at 2026-10-01T12:17:41Z: 11 deliveries
| seq | seal | kind | sealed | pre_ms | candidates_ms | candidates_rows | consumption_ms | amendments_ms |
|---|---|---|---|---|---|---|---|---|
| 10454 | `evt_b15f808607464618aa5e12157d521a71` | `push` | 03:37:25Z | 169 | 161 | 32 | 98 | 741 |
| 10481 | `evt_f4bdca18dace40edaa07b61648766e7f` | `pr_open` | 04:15:15Z | 339 | 191 | 9 | 166 | 643 |
| 10504 | `evt_512c468848f64c88bc5c121c3099ea10` | `merge` | 10:30:32Z | 172 | 122 | 43 | 83 | 795 |
| 10533 | `evt_9caae2a3ecef4855ac9e9a745a29d00a` | `push` | 11:11:05Z | 173 | 111 | 17 | 85 | 804 |
| 10539 | `evt_90b1f1eefd7f4568849893e20d4aa5bf` | `pr_edit` | 11:18:18Z | 166 | 110 | 21 | 89 | 801 |
| 10558 | `evt_c6ab3410c65d4cc7920cb56044a81e6a` | `review` | 11:38:06Z | 187 | 200 | 38 | 95 | 705 |
| 10573 | `evt_7186026e95174769a892e949a4c24c56` | `pr_edit` | 11:58:33Z | 164 | 192 | 44 | 84 | 724 |
| 10576 | `evt_7751e060aa284856809d63de79d4d851` | `review` | 12:00:24Z | 347 | 372 | 49 | 176 | 452 |
| 10586 | `evt_4f8d882123a8415990e1dbb63177f95b` | `review` | 12:06:29Z | 186 | 182 | 53 | 89 | 729 |
| 10591 | `evt_cf96afab5e524da99c3e3fa92d17f553` | `review` | 12:08:36Z | 167 | 185 | 57 | 91 | 724 |
| 10598 | `evt_ee02ab94dc9544f2baac02faf4031f0e` | `merge` | 12:13:55Z | 168 | 164 | 60 | 86 | 750 |

Ranges and medians over the 11 (computed):
- `candidates_ms` 110–372 (median 182), with `candidates_rows` 9–60 (median 43)
- `consumption_ms` 83–176 (median 89)
- `amendments_ms` 452–804 (median 729)
- `pre_ms` 164–347 (median 172)

### 7.2 On Worker `5d1b9edc` (PR 147, deployed 2026-10-01T12:17:41Z, `evt_79152cbce4c14963a5ad43b3e981b771`): 6 deliveries with per-call timing
| seq | seal | kind | sealed | pre_ms | candidates_ms | candidates_rows | consumption_ms | amendments_ms |
|---|---|---|---|---|---|---|---|---|
| 10611 | `evt_2a9715af0e1d477ca4c3e961389e6d43` | `comment` | 12:20:26Z | 165 | 210 | 62 | 95 | 695 |
| 10626 | `evt_fc1b852216f34eb0a26d04703ba5cbda` | `pr_open` | 12:31:12Z | 194 | 100 | 4 | 93 | 807 |
| 10633 | `evt_dd083cedebb641daae24d0eaa3fb01c1` | `push` | 12:33:00Z | 179 | 90 | 8 | 79 | 831 |
| 10636 | `evt_c75466a5e043433cba32f6b458709800` | `pr_edit` | 12:33:32Z | 172 | 103 | 9 | 86 | 811 |
| 10647 | `evt_7c280c1be68942aeabda9dc95de6d61b` | `push` | 12:39:14Z | 157 | 94 | 17 | 77 | 829 |
| 10649 | `evt_ce3fd1c33b9d4f4abaa97f96cc6e90a7` | `pr_edit` | 12:39:29Z | 162 | 109 | 17 | 85 | 806 |

Each delivery's `decision.timing.amendments_calls` holds three entries. `sql_ms` is D1's `meta.duration`. `wall_ms` is I/O-gated on a deployed
Worker: it covers the call's I/O plus CPU since the previous I/O (PR 147).

| seq | `amendment_rows` wall / sql ms | `dependencies` wall / sql ms | `capture_targets` wall ms (outcome) |
|---|---|---|---|
| 10611 | 95 / 3.2581 | 86 / 0.7258 | 514 (deadline) |
| 10626 | 104 / 4.0694 | 103 / 1.0374 | 600 (deadline) |
| 10633 | 80 / 1.9803 | 79 / 0.7294 | 672 (deadline) |
| 10636 | 90 / 1.7252 | 96 / 0.376 | 625 (deadline) |
| 10647 | 82 / 2.341 | 82 / 0.4349 | 665 (deadline) |
| 10649 | 89 / 2.4265 | 83 / 0.4449 | 634 (deadline) |

Over the 6 (computed):
- **`amendment_rows`:** wall 80–104 ms (median 89.5), SQL 1.7252–4.0694 ms, 1 row and 2,010 body characters each time.
- **`dependencies`:** wall 79–103 ms (median 84.5), SQL 0.376–1.0374 ms, 4 rows and 9,637 body characters each time.
- **Outside SQL:** wall minus `sql_ms` is 78.0–102.0 ms across these 12 small calls.
- **`capture_targets`:** cut off by the deadline in all 6, after 514–672 ms (median 629.5). So it recorded no SQL time, rows or bytes.
- **`capture_commits`:** never ran.

### 7.3 Reading
1. **Unchanged since §6.** The amendments stage reaches the 1,000 ms deadline on every delivery, on both Workers, and the decision fails closed.
2. **New, measured on 6.** Each small D1 call in the stage spends 78–102 ms outside SQL. Its SQL time is 0.4–4.1 ms.
3. **New, measured on 6.** The capture-target read is still running when the deadline fires, every time. Its full duration is not observed; in at
   least one delivery (seq 10633) it exceeded 672 ms.
   - Its SQL was 170–188 ms in the read-only probe (§6.2), so most of its time is spent outside SQL. That is an inference from the probe and these
     cut-offs.
4. **The candidates read varies with the pull request's activity:** 4–62 rows, 90–372 ms. A busy pull request leaves the least budget for the
   amendments stage.
5. **Next:** the design note in PR 148 (`docs/design/owner-login-capture-read.md`) proposes reading less from the capture index. It cites the
   first two of these samples.
