# Owner-login amendments stage: read less from the capture index (design note v1)

**Status:** v1.4, 2026-10-01, by claude-code (coordinator and spec author, `claude-opus-5-5`, harness-runtime). Not built.
- v1 opened PR 148.
- v1.1, before review: adds the second live sample (seq 10626) to §1, and a rough budget inference to §4.
- v1.2, before review: R3 now covers all three budget counters, not only the runner's.
- v1.3, after the round-1 approvals of Grok (2 Low) and NOOA, on Jordan's go `evt_ae6bf7b816a64cbebf4f09ae9344ec38`:
  - probes P1–P3 and a re-probe P3b, run on production D1 (§6), and their results through §1, §4 and §8
  - the measured statement shape (R4)
  - "about 945 events" corrected to 503 distinct events (§1); 945 was a row count
  - the index's TEXT affinity (R3)
  - Grok's G-L1 (§1 citation) and G-L2 (R3 boundary per call)
- v1.4, before Codex, on Jordan's go `evt_ed35f070144344ed91648b1c91205da7`. The author found a gap while drafting the build brief
  (`evt_be58a21db80849ea8a6cd2b0eab45f5e`):
  - v1.3 carried the unfiltered counts and the boundary on the rows the statement returns, and returned rows only for seals. A read with no
    seal among its matched events returned no row at all, and a read split over several statements could not deduplicate its counts.
  - R1–R4 now return one row per matched event, with the body only for seals; the runner counts exactly as today. Measured as P3c (§6).
  - Grok's G-L3: step 21's same-run control read 159,758 rows, not 159,736.
- Go: `evt_af819387f1784392891f33a5c46a61a4` (Jordan, "let's go w/ 1": finish this note with the measured split).
- Earlier draft: `~/.retrace/ops-2026-09-30/design-capture-read-volume-draft.md` v0.1, written on go `evt_5642b1dfda3e4cf79574c09dda2d3094`, Jordan's
  option (c) part (b) (`evt_df7212b9526a415baf0bed46687c939d`).
- Class (a) under agent-rules 12: a design note for a WHO path. It goes through the design gate: Grok, NOOA and Codex (or a recorded substitute).
- Code references are at main `82a56d14`.

## 0. Decisions this note asks the gate to confirm
1. **Build step 1 only:** in the two capture reads, return event bodies only for commit seals (option i), once per event (option ii).
   - Every matched event still returns one small row (its keys and whether it is stamped), so counts and the boundary, and therefore decisions,
     do not change (§4).
2. **Keep every budget's meaning.** All three budget counters still count the unfiltered matched set (pairs or events, as each does today), not
   only the rows the filter keeps (§4, R3).
3. **Step 2 only if step 1 is measured not to fit.** That is the cached amendment closure, option iv. It adds cached state to a WHO path, so it
   gets its own note.
4. **The probes are done** (§6). The build brief can be written on Jordan's go, using the measured statement shape (R4).

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
  - Re-timed in steps 20 and 21: 135–234 ms over 5 runs.
- **Volume:** the read returns 946 statement rows from **503 distinct events**, and 3,584,145 body bytes (step 20,
  `evt_0981b98dbb434490b94e93793d36ad10`).
  - *v1.3 correction:* v1–v1.2 said "about 945 events". 945 was probe 17's control **row** count, mislabelled "events" in the 09-30 draft.
- **Capture-shaped rows:** only 389 of the rows (1,784,532 bytes), across 173 events, are git commit seals. The rest are agent logs, reviews and
  instructions.
  - Source: step 18b's output, as recorded in the 09-30 draft §6 (`design-capture-read-volume-draft.md`). The 18b event's own params do not carry
    these figures (G-L1).
  - The `committed`/`merged` filter of R1 keeps 391 rows across 175 events (step 20). The two rows beyond 18b's git-tool subset are `committed`
    or `merged` rows whose `method.tool` is not `git`. Which events they are was not identified; R1 keeps them, and JavaScript applies the exact
    test.
- **Duplicated bodies:** each body is returned once per matching (event, file) pair, so commit seals average about 2.25 copies.
  - Returned once per event, the 175 filtered events carry 698,902 bytes (step 20).

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
    is **975** (probe 18). Steps 20 and 21 computed the same boundary (970) from the index.
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
- **R1. Bodies only for seals.** Each capture read returns an event's body only when `events.action` is `committed` or `merged`. That is a
  strict superset of `captureSealEligible`. JavaScript still applies the exact predicate, so only bodies that can never be seals are withheld.
  - *v1.4:* v1–v1.3 filtered the rows themselves. That lost the counts and boundary of a read whose matched events hold no seal (R3).
- **R2. One row per matched event.** Each statement returns exactly one row for every matched event, filtered or not. The row carries the
  event's `seq`, its matched artifact keys (`json_group_array`), a stamped flag (R3), and the body or NULL (R1). The runner still sees every
  matched (seq, key) pair.
- **R3. Counts and boundary, exactly as today.** The runner computes everything from the rows of every statement in the read, deduplicating
  across statements as it does today (`seenRows`, `store.ts:529-533`):
  - distinct (seq, key) pairs from the keys
  - distinct events from the seqs
  - the boundary: the lowest seq whose stamped flag is set

  So every budget counter that counts the read counts what it counts today, and every budget outcome is unchanged. There are three such
  counters at `82a56d14`:
  - **The runner.** `runArtifactIndexStatements` applies `row_cap` to distinct (seq, key) pairs.
  - **The amendments stage.** `amendmentCaptureDependencies` adds the **event** count to `rowsRead` and checks `CLASSIFY_ROW_CAP`
    (`classify.ts:621–622`).
  - **The owner-login budget.** `EvidenceBudget` takes `indexedRows(events, query)`, the matching (event, key) rows (`owner-login.ts:99,121`).

  Each counts all matched events and pairs, not only the ones whose bodies came back.

  *Why not v1.3's per-statement aggregate (v1.4):* it rode on returned rows, so a read with no seal returned no row and lost the counts and
  the boundary. And a read split at 400 terms (`ARTIFACT_INDEX_MAX_TERMS`, `store.ts:348`) cannot add per-statement counts without
  double-counting pairs matched in two statements. Either changes a decision. Local fixtures show the first case: the v1.3 shape returns no
  row, and v1.4 returns both events with the boundary (`evt_58f399ced3b342298d0b1f397e90428f`).

  And the boundary, per call (v1.3, G-L2):
  - **The `preliminary` call** (`classify.ts:653`) runs after the target read and before the commit read. It takes the minimum of the boundary
    over the events in memory at that point (base events and the target read's seals) and the target read's stamped seqs.
  - **The `complete` call** (`:668`) also takes the commit read's stamped seqs.
  - Each call passes its value as `CapturePolicy.firstStampedSeq`. That is the existing pin; `capture.ts` does not change.
  - This matches today's semantics: today `preliminary` sees only the pool as it stands before the commit read.

  And which index rows count as stamped (v1.3):
  - The stamped flag uses `sealed_by IS NOT NULL`. On today's ledger that equals "the body's `method.params.sealed_by` is a string" on every
    one of the 31,936 index rows, in both directions (P2, step 20).
  - `event_artifact_index.sealed_by` has TEXT affinity, so a non-string value written there would read back as text. `typeof(sealed_by) = 'text'`
    therefore cannot tell a string stamp from a numeric one. That held on a local fixture.
  - The guard that stands is the insert path, which writes only strings (`store.ts:250`), plus the P2 equality.
  - The build adds a test that a non-string `sealed_by` is indexed as NULL. Any future backfill keeps that rule, or P2 is rerun before it is
    trusted.
- **R4. The statement shape (measured; v1.4).**
  - **Matched set unchanged.** The matched-set members stay exactly as today: `SELECT DISTINCT i.seq, i.artifact_key` only. Adding any other
    index column to the member select moves the suffix member off `idx_eai_project_key_seq` onto a seq-range scan of the whole project index.
    Step 20 measured that: SQL 373–541 ms and `rows_read` 346,674, against 150–234 ms and 159,736 for today's statement.
  - **Per event:** `GROUP BY m.seq` over the matched pairs, with the stamped flag as `max(sealed_by IS NOT NULL)` by primary-key lookup
    (`sqlite_autoindex_event_artifact_index_1`).
  - **Body:** `CASE WHEN e.action IN ('committed','merged') THEN e.body END`, joining `events` by primary key.
  - **Measured on D1 (step 22, P3c, same run):**
    - v1.4: SQL 129–138 ms (3 runs), `rows_read` 161,831
    - v1.3's shape: 147–172 ms, `rows_read` 164,844
    - today's statement: 164–173 ms (2 runs; the first failed with a Cloudflare API 7403 error and returned nothing), `rows_read` 160,825

    In step 21, v1.3's shape ran 152–176 ms against 135–155 ms for today's statement, with `rows_read` 163,777 against 159,758 (G-L3; v1.3
    said 159,736). The control's `rows_read` differs between steps 21 and 22 (159,758 and 160,825) for the same keys and window; why is not
    established. Read the timings as same-run comparisons only.
  - **Plan (step 22):** both members seek the covering `idx_eai_project_key_seq` (the equality member by key, the suffix member by key
    range); `s` and `e` are primary-key lookups.
  - **Proof in the build.** The build shows the same plan with `EXPLAIN QUERY PLAN` under workerd.
- **R5. Unchanged elsewhere.** The commit path's own window read (`readWindow`), the candidates read and the consumption read are out of scope.
  Unused fields in the shared reader stay unused, and other callers see identical results.
- **R6. Instrumentation.** Each capture call's `amendments_calls` entry still reports `rows.statement_rows` (matched pairs), `distinct_events`
  (matched events), `body_chars` (returned bodies) and `sql_ms`.

**Effect on the read (measured in SQL, step 22):**
- Returned rows: 946 → 503 (one per matched event), of which 175 carry a body.
- Body bytes: 3,584,145 → 698,902 (5.1× fewer).
- SQL time: no worse than today's statement in the same run (129–138 ms against 164–173 ms).

**Effect on the Worker: not measured.**
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
1. **Probes P1–P3, P3b and P3c are done** (§6). P2 found no non-string `sealed_by`, so R3 stands as written.
2. **Build (class S),** in one pull request with:
   - **(a) Unit tests** on `MemoryEventStore` and `SqliteStore`, with fixtures for each boundary case:
     - a stamped non-seal before the first stamped seal
     - unstamped legacy git seals on either side of the boundary
     - webhook push seals
     - two seals of one reference with different full OIDs (the veto)
     - a `merged` GitHub event that is not a git seal
     - an unfiltered count above each cap with a filtered count below it (must still be `budget`): the runner's `row_cap`, `CLASSIFY_ROW_CAP`
       through `rowsRead`, and the owner-login `EvidenceBudget`
     - a read whose matched events hold no seal (counts and boundary still carried; v1.4)
     - a read split over several statements (more than 400 terms), with pairs matched in two statements (counted once; v1.4)
   - **(b) A workerd test** on the `5d7290f` fixture (production schema), asserting the same seals and decision as before.
   - **(c) An offline replay over a fresh export.** For every owner-login decision and every recorded commit classification with a read head,
     recompute the capture seals with the old and the new read and require them to be identical. Record the counts in the pull request.
3. **Gate (class S):** Grok first at high, NOOA, then the last seat. **Deploy** on its own go.
4. **Success test after deploy.** On the next 6 owner-login deliveries:
   - `capture_targets` and `capture_commits` finish with outcome `ok`, and
   - `classification_ms` stays under `deadline_ms`.

   If either fails on 2 or more of the 6, step 2 (option iv) gets its own note.

## 6. Probes before the build brief (read-only, production D1; done)
How they were run:
- Steps 20 and 21 were run by Jordan in a plain terminal, with SQL files hashed in each script.
- The SQL was validated on an empty local schema and a fixture first.
- Same keys and window as steps 17 and 18b: amendment seq 2543's 11 files, through seq 10402.
- Results: `evt_0981b98dbb434490b94e93793d36ad10` (step 20), `evt_e3bc896dafa84edc8f8efa8dd8498191` (step 21) and
  `evt_e1be75bfee144d2480e4a6baa198e8a7` (step 22, Jordan's verbatim output).

The probes:
- **P1, the filter's effect.** `action IN ('committed','merged')` keeps 391 of 946 rows, across 175 of 503 events: 1,789,352 bytes as rows,
  698,902 bytes once per event.
  - The `events.action` column equals the body's `action` on all 946 rows, so R1 can filter on the column.
- **P2, index against bodies.** No `event_artifact_index` row (31,936 in the project) has a non-NULL `sealed_by` whose body lacks a string
  `method.params.sealed_by`, and none the other way round, and no value differs.
  - Why it was asked: the insert path stores `sealed_by` only when it is a string (`store.ts:250`, `artifactIndexRows`). The one-time backfill
    stored `json_extract(body, '$.method.params.sealed_by')` (`apps/worker/schema.sql:99`), which would keep numbers and objects.
  - See R3 for the TEXT-affinity caveat.
- **P3, the first prototype.** The first shape added `i.sealed_by` to the matched-set members. It returned the right rows and boundary, but took
  SQL 373–541 ms (6 runs) with `rows_read` 346,674: the suffix member moved to `idx_eai_project_seq`. Not to be built.
- **P3b, the corrected shape** (R4). Members as today, `sealed_by` by primary-key lookup, plain CTE: SQL 152–176 ms (3 runs), against 135–155 ms
  for today's statement in the same run. It returns 175 rows and 698,902 bytes, with the unfiltered pair count 946, event count 503 and boundary
  970.
- **P3c, v1.4's shape** (R4; step 22). One row per matched event, body only for seals: 503 rows, 175 bodies, 698,902 body bytes, 946 pairs,
  503 events, boundary 970, exactly as expected. SQL 129–138 ms (3 runs), against 147–172 ms for v1.3's shape and 164–173 ms for today's
  statement in the same run (one control run failed with Cloudflare API error 7403 and returned nothing).

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
- It does not claim step 1 fits the budget. The capture read's full live duration has not been observed (§1).
  - The SQL-side figures are measured (§6). The Worker-side saving is not: transfer and parse of 0.7 MB of bodies plus 503 small rows,
    instead of 3.6 MB.
- The row reduction and the index's `sealed_by` parity are measured on one amendment's keys and on today's ledger (§6), not proven for every
  future read. The equality proof in §5 is still required.
- The 85–103 ms per small call is a reading of two samples on I/O-gated timers, not a network measurement.
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
| Round 1: Grok approved, 2 Low; NOOA approved | `evt_d073dd971d0c4afba0b03f45e13032d5`, `evt_a6e12a3871f8456aa62fc6667553d3ca` |
| Probes P1–P3 (step 20) and P3b (step 21) | `evt_0981b98dbb434490b94e93793d36ad10`, `evt_e3bc896dafa84edc8f8efa8dd8498191` |
| Go for v1.3 | `evt_ae6bf7b816a64cbebf4f09ae9344ec38` |
| Gap found in R3/R4 while drafting the build brief | `evt_be58a21db80849ea8a6cd2b0eab45f5e` |
| Go for v1.4 and probe P3c | `evt_ed35f070144344ed91648b1c91205da7` |
| Probe P3c (step 22), local validation and output | `evt_58f399ced3b342298d0b1f397e90428f`, `evt_e1be75bfee144d2480e4a6baa198e8a7` |
