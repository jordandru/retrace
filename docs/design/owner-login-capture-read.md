# Owner-login amendments stage: read less from the capture index (design note v1)

**Status:** v1.2, 2026-10-01, by claude-code (coordinator and spec author, `claude-opus-5-5`, harness-runtime). Not built.
- v1 opened PR 148.
- v1.1, before review: adds the second live sample (seq 10626) to §1, and a rough budget inference to §4.
- v1.2, before review: R3 now covers all three budget counters, not only the runner's.
- Go: `evt_af819387f1784392891f33a5c46a61a4` (Jordan, "let's go w/ 1": finish this note with the measured split).
- Earlier draft: `~/.retrace/ops-2026-09-30/design-capture-read-volume-draft.md` v0.1, written on go `evt_5642b1dfda3e4cf79574c09dda2d3094`, Jordan's
  option (c) part (b) (`evt_df7212b9526a415baf0bed46687c939d`).
- Class (a) under agent-rules 12: a design note for a WHO path. It goes through the design gate: Grok, NOOA and Codex (or a recorded substitute).
- Code references are at main `82a56d14`.

## 0. Decisions this note asks the gate to confirm
1. **Build step 1 only:** filter the two capture reads to commit seals (option i) and return each event body once (option ii).
   - The read must also carry the unfiltered boundary and row count from the index, so decisions do not change (§4).
2. **Keep every budget's meaning.** All three budget counters still count the unfiltered matched set (pairs or events, as each does today), not
   only the rows the filter keeps (§4, R3).
3. **Step 2 only if step 1 is measured not to fit.** That is the cached amendment closure, option iv. It adds cached state to a WHO path, so it
   gets its own note.
4. **Run three read-only probes before the build brief is written** (§6).

## 1. The problem, measured
Owner-login deliveries on the live Worker seal `unavailable / deadline`, failing closed: the seal names the account and attributes no seat. The
classification budget is 1,000 ms (`OWNER_LOGIN_DEADLINE_MS`).

| delivery | Worker | candidates_ms | consumption_ms | amendments_ms | outcome |
|---|---|---|---|---|---|
| seq 10403 (`evt_32c1e456…`) | `77400e6e` (PR 60) | 107 | 91 | 802 | deadline |
| seq 10454 (`evt_b15f808607464618aa5e12157d521a71`) | `77400e6e` | 161 (32 rows) | 98 | 741 | deadline |
| seq 10611 (`evt_2a9715af0e1d477ca4c3e961389e6d43`) | `5d1b9edc` (PR 147) | 210 (62 rows) | 95 | 695 | deadline |
| seq 10626 (`evt_fc1b852216f34eb0a26d04703ba5cbda`, this note's own `pr_open`) | `5d1b9edc` | 100 (4 rows) | 93 | 807 | deadline |

**Per call** (`decision.timing.amendments_calls`, read raw; seq 10611 is recorded in `evt_2801fab20533439a95a937c2d1981cad`):

| seq | call | wall_ms | sql_ms (D1 `meta.duration`) | rows | body_chars | outcome |
|---|---|---|---|---|---|---|
| 10611 | `amendment_rows` | 95 | 3.2581 | 1 | 2,010 | ok |
| 10611 | `dependencies` | 86 | 0.7258 | 4 | 9,637 | ok |
| 10611 | `capture_targets` | 514, then cut off | not recorded | not recorded | not recorded | deadline |
| 10626 | `amendment_rows` | 104 | 4.0694 | 1 | 2,010 | ok |
| 10626 | `dependencies` | 103 | 1.0374 | 4 | 9,637 | ok |
| 10626 | `capture_targets` | 600, then cut off | not recorded | not recorded | not recorded | deadline |

What this shows. These are two samples, so read them as two samples.
1. **A small D1 call costs about 85–103 ms outside SQL.**
   - On a deployed Worker, timers advance only at I/O. So a call's `wall_ms` covers its own I/O plus any CPU since the previous I/O.
   - Each classification makes five or six sequential calls, which is roughly 450–600 ms before any data volume. This is an inference from two
     samples.
2. **The capture read is the dominant cost.** It took more than 600 ms (seq 10626, where the candidates read was light) and did not finish, so its
   full duration is **not observed**.
   - Its SQL is 170–188 ms (probe 17). So more than about 410 ms of it is spent outside SQL: transfer and handling of about 3.6 MB.
   - That is an inference from the probe and one cut-off sample.
3. **The candidates read grows with pull-request activity.**
   - 210 ms for 62 rows here
   - 161 ms for 32 rows at seq 10454
   - 88–107 ms for 4–26 rows in the earlier samples (`docs/measurements/owner-login-budget-1000-2026-09-30.md` §2 and §6)

**Read-only probes on production D1** (`evt_c0af48a7…`, `evt_19d8e70c…`, `evt_c3c5760c…`). They used amendment seq 2543, whose target is commit
`5d7290f`, with 11 files and the whole history.
- **SQL time:** 170–188 ms, of which the suffix scan is about 140 ms. An owner-qualified exact-key control runs in 28–49 ms.
- **Volume:** the read returns 946 statement rows and 3,584,145 body bytes, about 945 events.
- **Capture-shaped rows:** only 389 of the rows (1,784,532 bytes) are commit seals, across 173 events. The rest are agent logs, reviews and
  instructions.
- **Duplicated bodies:** each body is returned once per matching (event, file) pair, so commit seals average about 2.25 copies.

## 2. What the capture reads feed
These are code facts at `82a56d14`.
- **What the two reads are.** `amendmentCaptureDependencies` (`classify.ts:580`) makes them through `eventsReferencingArtifacts`:
  - `capture_targets` (`:649`): the amendment target's output files
  - `capture_commits` (`:665`): commit prefixes of the preliminary seals
- **How the results are pooled.** Results are pooled with the base events (`:623`). The pool is passed **only** to `classifierCaptureSeals`
  (`:335`), twice: `preliminary` (`:653`) and `complete` (`:668`).
- **What the caller consumes.** `evaluateAmendmentsAtU` (`:673`) consumes only `captures.seals` (`:730`). No other code reads the pooled events.
- **What `classifierCaptureSeals` does with the pool.** Three things:
  1. It computes `firstStampedSeq(pool)` (`capture.ts:66–68`): the lowest seq among pooled events whose `method.params.sealed_by` is a string,
     unless `CapturePolicy.firstStampedSeq` pins it.
  2. It applies `captureSealEligible` (`capture.ts:73–82`). That test is true only for `committed` or `merged` events: a legacy unstamped git
     seal below the boundary, a trusted-hook or owner git seal, or a GitHub push seal.
  3. It applies the strict full-OID veto (`classify.ts:335–363`) to the same eligible events. Two resolutions of one commit reference return
     `{ ok: false }`.
- **Consequence:** an event whose `action` is neither `committed` nor `merged` can affect the result only through `firstStampedSeq`.
  - The live ledger has exactly that case. Inside this read, the first stamped event is seq **970**, which is not a seal; the first stamped seal
    is **975** (probe 18).
  - Dropping non-seals without carrying the boundary would move the boundary to 975, and the unstamped git seals at 970–974 would become
    eligible.

## 3. Constraints
- **Same decisions.** Every capture seal, every veto, and therefore every decision must equal today's. The only exceptions are `timing` and
  `classification_ms`.
- **Fail closed.** Any error, missing field or surprise yields `unavailable`, never a weaker decision.
- **Workerd and D1 limits:** at most 100 bound parameters, at most 5 compound SELECT members, and no LIKE or GLOB over 50 bytes (PR 60).
- **Budgets.** No budget or deadline change in this work. No new table, and no cached state in step 1.
- **One round trip per read.** Each capture read stays a single round trip, because a round trip costs about 90 ms (§1).

## 4. Requirements for step 1 (options i + ii)
- **R1. Filter.** Each capture read returns only events whose `events.action` is `committed` or `merged`. That is a strict superset of
  `captureSealEligible`. JavaScript still applies the exact predicate, so the filter can drop only events that can never be seals.
- **R2. One body per event.** Each returned event's body appears once per statement, for example grouped by `seq`, with its matched artifact keys
  aggregated (`json_group_array`). The runner still sees every matched (seq, key) pair.
- **R3. Unfiltered boundary and counts.** The same statement returns, from the index alone (no body), for the **unfiltered** matched (seq, key)
  set:
  - the count of distinct pairs
  - the count of distinct events (seqs)
  - `MIN(seq)` over rows whose `sealed_by` is a string

  Then every budget counter that today counts what the read returns counts the unfiltered set instead, so every budget outcome is unchanged. There
  are three such counters at `82a56d14`:
  - **The runner.** `runArtifactIndexStatements` applies `row_cap` to distinct (seq, key) pairs. It uses the unfiltered pair count.
  - **The amendments stage.** `amendmentCaptureDependencies` adds the returned **event** count to `rowsRead` and checks `CLASSIFY_ROW_CAP`
    (`classify.ts:621–622`). It adds the unfiltered event count.
  - **The owner-login budget.** `EvidenceBudget` takes `indexedRows(returned events, query)`, the matching (event, key) rows
    (`owner-login.ts:99,121`). It takes the unfiltered pair count.

  And the boundary:
  - The classifier takes the boundary as the minimum of three values: the boundary over the events already in memory (base events and
    returned events), and each capture read's index boundary.
  - It passes that value as `CapturePolicy.firstStampedSeq` to both `classifierCaptureSeals` calls. That is the existing pin; `capture.ts` does
    not change.
  - *v1.2: before review, the author found that v1 named only the runner's counter. The two other counters are added here.*
- **R4. Matched set computed once.** The matched set is computed once per statement (for example a `MATERIALIZED` CTE). The suffix scan (§1) is not
  paid twice. Show this with `EXPLAIN QUERY PLAN` under workerd and with probe P3.
- **R5. Unchanged elsewhere.** The commit path's own window read (`readWindow`), the candidates read and the consumption read are out of scope.
  Unused fields in the shared reader stay unused, and other callers see identical results.
- **R6. Instrumentation.** Each capture call's `amendments_calls` entry still reports `rows.statement_rows` (unfiltered matched pairs),
  `distinct_events` (returned), `body_chars` (returned) and `sql_ms`.

**Expected effect (estimate, from probe 18b; not measured):**
- Returned rows: about 946 → about 400.
- Body bytes: about 3.6 MB → about 0.8 MB, once each body is returned once.
- The suffix scan (about 140 ms of SQL) and the per-call round trip stay.
- Whether the capture read then fits the budget is **unknown**. It is measured after deploy (§5, success test).
- **A rough budget, inference only.** Say the outside-SQL part shrinks in proportion to the bytes, from more than 410 ms to roughly 90–100 ms plus
  the round trip.
  - Then the capture read is roughly 300–400 ms, and a classification is roughly 800–1,000 ms when candidates are light. That is still close to
    the budget.
  - On busy pull requests (candidates 160–210 ms) it would likely still miss. So option (iii) may be needed with step 1, and option (iv) remains
    the structural fix.
  - The success test decides.

## 5. Build plan, proof and success test
1. **Probes P1–P3** (§6), read-only, before the build brief. If P2 finds a non-string `sealed_by` in the index, R3 stops until that is resolved
   (§6).
2. **Build (class S),** in one pull request with:
   - **(a) Unit tests** on `MemoryEventStore` and `SqliteStore`, with fixtures for each boundary case:
     - a stamped non-seal before the first stamped seal
     - unstamped legacy git seals on either side of the boundary
     - webhook push seals
     - two seals of one reference with different full OIDs (the veto)
     - a `merged` GitHub event that is not a git seal
     - an unfiltered count above each cap with a filtered count below it (must still be `budget`): the runner's `row_cap`, `CLASSIFY_ROW_CAP`
       through `rowsRead`, and the owner-login `EvidenceBudget`
   - **(b) A workerd test** on the `5d7290f` fixture (production schema), asserting the same seals and decision as before.
   - **(c) An offline replay over a fresh export.** For every owner-login decision and every recorded commit classification with a read head,
     recompute the capture seals with the old and the new read and require them to be identical. Record the counts in the pull request.
3. **Gate (class S):** Grok first at high, NOOA, then the last seat. **Deploy** on its own go.
4. **Success test after deploy.** On the next 6 owner-login deliveries:
   - `capture_targets` and `capture_commits` finish with outcome `ok`, and
   - `classification_ms` stays under `deadline_ms`.

   If either fails on 2 or more of the 6, step 2 (option iv) gets its own note.

## 6. Probes before the build brief (read-only, production D1, same method as steps 17 and 18b)
- **P1.** For amendment seq 2543's 11 keys, how many matched rows and distinct events have `action IN ('committed','merged')`? Expected: about 389
  rows. This confirms R1's reduction.
- **P2.** Does any `event_artifact_index` row have a non-NULL `sealed_by` whose event body does not have a **string** `method.params.sealed_by`?
  - Why it matters: the insert path stores `sealed_by` only when it is a string (`store.ts:250`, `artifactIndexRows`). The one-time backfill
    stored `json_extract(body, '$.method.params.sealed_by')` (`apps/worker/schema.sql:99`), which keeps numbers and objects.
  - If the count is not zero, R3's boundary must use `typeof(i.sealed_by) = 'text'` **and** a corrective step, or read the boundary from bodies.
    That is decided before building.
- **P3.** Time the R2/R3 statement shape against the deployed SQL (`sql_ms` and `rows_read`), with the same keys.

## 7. The other options (not proposed for step 1)
- **(iii) Exact owner-qualified keys instead of the suffix scan.** Saves about 140 ms of SQL (28–49 ms against 170–188 ms). But the extra suffix
  row is seq 82, `repo:provenance/retrace#…`, an older owner name and a correct `sameArtifact` match. So exact keys must include every
  historical owner, or real history is silently dropped. It is an add-on after step 1, with its own probe.
- **(iv) Cache the amendment's capture closure** (per amendment seq and read head, extended by `after_seq` on later reads). In steady state it
  removes both capture round trips; it is the only option that cuts calls. It needs a new table, an invalidation rule and a backfill, and it puts
  cached state on a WHO path. Step 2, with its own note.
- **(v) Fold `capture_commits` into the `capture_targets` statement** (one SQL statement finding the seals' commit keys and their other
  references). Saves one round trip (about 90 ms). The SQL is more complex, and the preliminary-seal logic (eligibility plus veto) would have to
  move into SQL. Not proposed.

## 8. What this note does not claim
- It does not claim step 1 fits the budget. The capture read's full live duration has not been observed (§1), and the reduction figures are
  estimates.
- It does not claim the row reduction until P1 is run. It does not claim that the index's `sealed_by` matches the bodies until P2 is run.
- The ~90 ms per call is one sample's reading of I/O-gated timers, not a network measurement.
- Owner-login stays fail-closed throughout. Until a fix is live and measured, no GitHub delivery attributes a seat.

## 9. Record
| what | event |
|---|---|
| Jordan's option (c), cache as follow-up design | `evt_df7212b9526a415baf0bed46687c939d` |
| Go for the draft | `evt_5642b1dfda3e4cf79574c09dda2d3094` |
| Probes 17, 18 and 18b | `evt_c0af48a7…`, `evt_19d8e70c…`, `evt_c3c5760c…` |
| PR 147 (per-call timing) merged as `82a56d14`; deployed as `5d1b9edc` | `evt_84d21fe982cc4e10b5cd6b9d9a4b1cd8`, `evt_79152cbce4c14963a5ad43b3e981b771` |
| First per-call sample (seq 10611), read raw | `evt_2801fab20533439a95a937c2d1981cad` |
| Go for this note | `evt_af819387f1784392891f33a5c46a61a4` |
