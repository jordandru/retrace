# Owner-login amendments stage: read less from the capture index (design note v1)

**Status:** v1.5, 2026-10-02, by claude-code (coordinator and spec author, `claude-opus-5-5`, harness-runtime). Not built.
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
- v1.5, after Codex's round 1 (`evt_aabdb3cf98984d64b33e5086eb0a102a`: rejected, F1 Medium, F2 and F3 Low), on Jordan's go
  `evt_9ca021b8a82d4863af540f167ebb6e7e`:
  - F1: the stamped flag now comes from the event's own body in SQL, which is today's rule, not from the index's `sealed_by` (R3, R4). Both
    backfills copy that column without a string guard, so an index backfilled elsewhere can disagree with the bodies. Measured as P3d (§6).
    The build also makes both backfills string-safe (§5).
  - F2: the volume figures are characters, not bytes. SQLite's `length()` on TEXT counts characters (§1, §4, §6, §8).
  - F3: the round-trip constraint is one call per statement, as today (§3); option iv against option v is worded consistently (§7).
  - Codex's build obligations, which are not findings: each budget counter keeps its own predicate, plus a row contract and the grouped limit
    (R3); more fixtures, a per-store replay of outcomes and counters, and what the success test records (§5).
  - §2's veto also covers an eligible same-repository reference that does not resolve. §1's small-call range is 85–102 ms (Codex: 85.27–101.96).
- Go: `evt_af819387f1784392891f33a5c46a61a4` (Jordan, "let's go w/ 1": finish this note with the measured split).
- Earlier draft: `~/.retrace/ops-2026-09-30/design-capture-read-volume-draft.md` v0.1, written on go `evt_5642b1dfda3e4cf79574c09dda2d3094`, Jordan's
  option (c) part (b) (`evt_df7212b9526a415baf0bed46687c939d`).
- Class (a) under agent-rules 12: a design note for a WHO path. It goes through the design gate: Grok, NOOA and Codex (or a recorded substitute).
- Code references are at main `82a56d14`. Codex's round 1 compared them with main `ce8c7cc6` and found no relevant drift in the cited files.

## 0. Decisions this note asks the gate to confirm
1. **Build step 1 only:** in the two capture reads, return event bodies only for commit seals (option i), once per event (option ii).
   - Every matched event still returns one small row: its keys, and whether its own body carries a string stamp (v1.5). So counts and the
     boundary, and therefore decisions, do not change (§4).
2. **Keep every budget's meaning.** All three budget counters still count the unfiltered matched set (pairs or events, as each does today), not
   only the rows the filter keeps (§4, R3).
3. **Step 2 only if step 1 is measured not to fit.** That is the cached amendment closure, option iv. It adds cached state to a WHO path, so it
   gets its own note.
4. **The probes are done** (§6), including P3d for v1.5's stamped flag. The build brief can be written on Jordan's go, using the measured
   statement shape (R4).

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
1. **A small D1 call costs about 85–102 ms outside SQL.**
   - On a deployed Worker, timers advance only at I/O. So a call's `wall_ms` covers its own I/O plus any CPU since the previous I/O.
   - Each classification makes five or six sequential calls, which is roughly 450–600 ms before any data volume. This is an inference from two
     samples.
2. **The capture read is the dominant cost.** It took more than 600 ms (seq 10626, where the candidates read was light) and did not finish, so its
   full duration is **not observed**.
   - Its SQL is 170–188 ms (probe 17). So more than about 410 ms of it is spent outside SQL: transfer and handling of about 3.6 million
     characters of bodies.
   - That is an inference from the probe and one cut-off sample.
3. **The candidates read grows with pull-request activity.**
   - 210 ms for 62 rows here
   - 161 ms for 32 rows at seq 10454
   - 88–107 ms for 4–26 rows in the earlier samples (`docs/measurements/owner-login-budget-1000-2026-09-30.md` §2 and §6)

**Read-only probes on production D1** (`evt_c0af48a7…`, `evt_19d8e70c…`, `evt_c3c5760c…`). They used amendment seq 2543, whose target is commit
`5d7290f`, with 11 files and the whole history.
- **SQL time:** 170–188 ms, of which the suffix scan is about 140 ms. An owner-qualified exact-key control runs in 28–49 ms.
  - Re-timed in steps 20 and 21: 135–234 ms over 5 runs.
- **Volume:** the read returns 946 statement rows from **503 distinct events**, and 3,584,145 body characters (step 20,
  `evt_0981b98dbb434490b94e93793d36ad10`).
  - *v1.3 correction:* v1–v1.2 said "about 945 events". 945 was probe 17's control **row** count, mislabelled "events" in the 09-30 draft.
  - *v1.5 correction (Codex F2):* v1–v1.4 called these volumes bytes. The probes summed SQLite `length()` over TEXT bodies, which counts
    characters, not UTF-8 bytes (https://www.sqlite.org/lang_corefunc.html#length). Every volume in this note is a character count. The row and
    event counts and the timings are unaffected.
- **Capture-shaped rows:** only 389 of the rows (1,784,532 characters), across 173 events, are git commit seals. The rest are agent logs, reviews and
  instructions.
  - Source: step 18b's output, as recorded in the 09-30 draft §6 (`design-capture-read-volume-draft.md`). The 18b event's own params do not carry
    these figures (G-L1).
  - The `committed`/`merged` filter of R1 keeps 391 rows across 175 events (step 20). The two rows beyond 18b's git-tool subset are `committed`
    or `merged` rows whose `method.tool` is not `git`. Which events they are was not identified; R1 keeps them, and JavaScript applies the exact
    test.
- **Duplicated bodies:** each body is returned once per matching (event, file) pair, so commit seals average about 2.25 copies.
  - Returned once per event, the 175 filtered events carry 698,902 characters (step 20).

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
     `{ ok: false }`, and so does an eligible same-repository reference that does not resolve (v1.5, from Codex's round 1).
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
- **No additional round trips (v1.5, Codex F3).** Each capture read makes one call per statement, as today, and a round trip costs about 90 ms
  (§1). A read of up to 400 terms is one statement and one round trip. A larger read is split into statements (`ARTIFACT_INDEX_MAX_TERMS`,
  `store.ts:348`) that run one after another (`store.ts:519–522`, `apps/worker/src/d1-store.ts:157–166`). Step 1 adds no call. Batching the
  statements is not part of step 1.

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

  **Each counter keeps its own predicate (v1.5, from Codex's round 1).**
  - The runner's `row_cap` counts raw SQL (seq, key) pairs.
  - `rowsRead` counts returned events.
  - `EvidenceBudget.indexedRows` applies its existing semantic predicate (`artifactIndexRows` plus the `sameArtifact` and prefix tests) to the
    deduplicated keys.

  These differ today. The SQL suffix member over-matches a first-`#` key (`store.ts:424`), so `repo:retrace#a.ts` matches a stored
  `repo:x#/retrace#a.ts` as one raw pair that `EvidenceBudget` counts as 0. No counter is derived from another's total.

  **The row contract and the limit (v1.5, from Codex's round 1).**
  - The runner validates every returned row. It needs an integer `seq`; a non-empty, untruncated array of string keys; a stamped flag of 0 or 1;
    and a body exactly when the event is `committed` or `merged`.
  - Any statement, parse or shape failure is a store error, so the decision is `unavailable`.
  - `LIMIT row_cap + 1` stays on the grouped statement. Every grouped row carries at least one pair, so `row_cap + 1` rows already prove more
    than `row_cap` pairs. Under the limit, every key of every returned event is present.
  - Codex checked this on 84 combinations of caps, term-batch sizes and exact or prefix overlap, in a local prototype.

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

  And which events count as stamped (v1.5, Codex F1):
  - **The rule.** The stamped flag is `json_type(e.body, '$.method.params.sealed_by') IS 'text'`, computed in SQL from the event's own body.
    - The `events` row is already joined by (project, seq) for the body.
    - This is exactly today's rule: `firstStampedSeq` counts an event whose `method.params.sealed_by` is a string (`capture.ts:66–68`).
    - Both sides read the same stored text. Both stores write `body` as `JSON.stringify(e)` (`apps/worker/src/d1-store.ts:29`,
      `packages/mcp-server/src/sqlite-store.ts:59`) and read it back with `JSON.parse`. A stringified object has no duplicate keys, so SQLite's
      `json_type` and JavaScript's `typeof` see the same value.
    - So it holds on every store, whatever that store's index holds.
  - **Why not the index (v1.3–v1.4).** `sealed_by IS NOT NULL` on `event_artifact_index` matches the body rule only where the insert path wrote
    every index row. That path stores strings only (`store.ts:252`).
    - Both backfills copy `json_extract(body, '$.method.params.sealed_by')` with no string guard (`store.ts:554–566`, `apps/worker/schema.sql`).
    - `SqliteStore` runs its backfill on any store whose index is empty (`packages/mcp-server/src/sqlite-store.ts:32–37`).
    - A number, boolean or object stamp is then stored as TEXT, and the boundary moves with no error to fail closed on.
    - Codex reproduced it. P3d's local fixture reproduces it in SQL: the index put the boundary at 10, and the body rule at 13 (§6).
    - P2 had checked one project on one store.
  - **Measured.** P3d measured the body flag on production D1: results identical to v1.4's and no measurable SQL cost (§6, R4).
    - On that read the two flags also agree on all 503 matched events (0 mismatches), which confirms P2 for this project.
    - v1.5 does not depend on that agreement.
  - **The backfills.** The build also makes both backfills string-safe (§5 (a′)). That does not rewrite indexes already backfilled, and the
    boundary no longer depends on them.
- **R4. The statement shape (measured; v1.4).**
  - **Matched set unchanged.** The matched-set members stay exactly as today: `SELECT DISTINCT i.seq, i.artifact_key` only. Adding any other
    index column to the member select moves the suffix member off `idx_eai_project_key_seq` onto a seq-range scan of the whole project index.
    Step 20 measured that: SQL 373–541 ms and `rows_read` 346,674, against 150–234 ms and 159,736 for today's statement.
  - **Per event:** `GROUP BY m.seq` over the matched pairs, keys only.
    - v1.4 took the stamped flag here, as `max(sealed_by IS NOT NULL)` by primary-key lookup on the index
      (`sqlite_autoindex_event_artifact_index_1`).
    - v1.5 drops that lookup (F1).
  - **The stamped flag and the body**, both from the `events` row joined by (project, seq):
    - stamped = `json_type(e.body, '$.method.params.sealed_by') IS 'text'` (v1.5);
    - body = `CASE WHEN e.action IN ('committed','merged') THEN e.body END`.
  - **Measured on D1 (step 24, P3d, same rounds; v1.5):**
    - v1.5: SQL 153–200 ms (3 runs), `rows_read` 163,558
    - v1.4's shape: 167–264 ms, `rows_read` 164,504
    - today's statement: 182–210 ms (2 runs; the first failed with Cloudflare API error 7403 and returned nothing), `rows_read` 163,498

    v1.5 and v1.4 return the same results: 503 rows, 175 bodies, 698,902 body characters, 946 pairs, 503 events and boundary 970. These ranges
    are wider than step 22's, where v1.4 ran 129–138 ms. Read the timings as same-run comparisons only.
  - **Measured on D1 (step 22, P3c, same run; v1.4):**
    - v1.4: SQL 129–138 ms (3 runs), `rows_read` 161,831
    - v1.3's shape: 147–172 ms, `rows_read` 164,844
    - today's statement: 164–173 ms (2 runs; the first failed with a Cloudflare API 7403 error and returned nothing), `rows_read` 160,825

    In step 21, v1.3's shape ran 152–176 ms against 135–155 ms for today's statement, with `rows_read` 163,777 against 159,758 (G-L3; v1.3
    said 159,736). The control's `rows_read` differs between steps 21 and 22 (159,758 and 160,825) for the same keys and window; why is not
    established. Read the timings as same-run comparisons only.
  - **Plan (step 24, v1.5):** both members seek the covering `idx_eai_project_key_seq`, the equality member by key and the suffix member by key
    range, combined by MERGE (UNION). `e` is found through `sqlite_autoindex_events_2` (project, seq). There is no index-row lookup.
    - Step 22's v1.4 plan also looked up `s` by primary key.
  - **Proof in the build.** The build shows the same plan with `EXPLAIN QUERY PLAN` under workerd.
- **R5. Unchanged elsewhere.** The commit path's own window read (`readWindow`), the candidates read and the consumption read are out of scope.
  Unused fields in the shared reader stay unused, and other callers see identical results.
- **R6. Instrumentation.** Each capture call's `amendments_calls` entry still reports `rows.statement_rows` (matched pairs), `distinct_events`
  (matched events), `body_chars` (returned bodies) and `sql_ms`.

**Effect on the read (measured in SQL, steps 22 and 24):**
- Returned rows: 946 → 503 (one per matched event), of which 175 carry a body.
- Body characters: 3,584,145 → 698,902 (5.1× fewer).
- SQL time: no worse than today's statement in the same run.
  - Step 22, v1.4: 129–138 ms against 164–173 ms.
  - Step 24, v1.5: 153–200 ms against 182–210 ms.

**Effect on the Worker: not measured.**
- The suffix scan (about 140 ms of SQL) and the per-call round trip stay.
- Whether the capture read then fits the budget is **unknown**. It is measured after deploy (§5, success test).
- **A rough budget, inference only.** Say the outside-SQL part shrinks in proportion to the body volume, from more than 410 ms to roughly 90–100 ms plus
  the round trip.
  - Then the capture read is roughly 300–400 ms, and a classification is roughly 800–1,000 ms when candidates are light. That is still close to
    the budget.
  - On busy pull requests (candidates 160–210 ms) it would likely still miss. So option (iii) may be needed with step 1, and option (iv) remains
    the structural fix.
  - The success test decides.

## 5. Build plan, proof and success test
1. **Probes P1–P3, P3b, P3c and P3d are done** (§6).
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
     - *v1.5:* an index backfilled from bodies whose `sealed_by` is a number, a boolean or an object. Old and new reads give today's boundary;
       the v1.4 index flag would not (F1).
     - *v1.5:* the `EvidenceBudget` over-match case (R3) at an aggregate-budget boundary; stamps only on base events; distinct `preliminary` and
       `complete` boundaries; a malformed or missing row field, which gives `unavailable`; and a grouped read truncated at `row_cap + 1`.
   - **(a′) String-safe backfills (v1.5, F1).** `BACKFILL_ARTIFACT_INDEX_SQL` (`store.ts:554–566`) and the backfill in `apps/worker/schema.sql`
     store `sealed_by` only when `json_type(body, '$.method.params.sealed_by') = 'text'`, with a test.
     - The boundary no longer depends on the column (R3). This keeps the column honest for any other reader.
     - Indexes already backfilled are not rewritten.
   - **(b) A workerd test** on the `5d7290f` fixture (production schema), asserting the same seals and decision as before.
   - **(c) An offline replay over a fresh export.** For every owner-login decision and every recorded commit classification with a read head,
     recompute with the old and the new read and require identical results. Record the counts in the pull request.
     - *v1.5, from Codex's round 1:* compare, per store, the capture seals, the available or unavailable outcome with its reason, and the three
       budget counters, not only successful seal arrays.
     - Run `MemoryEventStore` and `SqliteStore` separately: they already differ on the over-match.
3. **Gate (class S):** Grok first at high, NOOA, then the last seat. **Deploy** on its own go.
4. **Success test after deploy.** On the next 6 owner-login deliveries:
   - `capture_targets` and `capture_commits` finish with outcome `ok`, and
   - `classification_ms` stays under `deadline_ms`.

   If either fails on 2 or more of the 6, step 2 (option iv) gets its own note.

   *v1.5, from Codex's round 1:* record, for each delivery:
   - whether both capture calls ran;
   - their counters and outcomes;
   - the final status;
   - the candidates load.

   A skipped or mapped read is not a success, and a store error below the deadline is a failure. Six deliveries are a small rollout rule for
   opening the step-2 note. They prove neither general performance nor decision equality; the replay in 2(c) is the equality proof.

## 6. Probes before the build brief (read-only, production D1; done)
How they were run:
- Steps 20, 21, 22 and 24 were run by Jordan in a plain terminal, with SQL files hashed in each script.
- The SQL was validated on an empty local schema and a fixture first.
- Same keys and window as steps 17 and 18b: amendment seq 2543's 11 files, through seq 10402.
- Results:
  - step 20: `evt_0981b98dbb434490b94e93793d36ad10`
  - step 21: `evt_e3bc896dafa84edc8f8efa8dd8498191`
  - step 22: `evt_e1be75bfee144d2480e4a6baa198e8a7` (Jordan's verbatim output)
  - step 24: `evt_32e2617cbdd543e5b4cb5bbee05f001b` (Jordan's verbatim output), read in `evt_7e309e25ff614d12a6a842e3ff84f679`

The probes:
- **P1, the filter's effect.** `action IN ('committed','merged')` keeps 391 of 946 rows, across 175 of 503 events: 1,789,352 characters as rows,
  698,902 characters once per event.
  - The `events.action` column equals the body's `action` on all 946 rows, so R1 can filter on the column.
- **P2, index against bodies.** No `event_artifact_index` row (31,936 in the project) has a non-NULL `sealed_by` whose body lacks a string
  `method.params.sealed_by`, and none the other way round, and no value differs.
  - Why it was asked: the insert path stores `sealed_by` only when it is a string (`store.ts:250`, `artifactIndexRows`). The one-time backfill
    stored `json_extract(body, '$.method.params.sealed_by')` (`apps/worker/schema.sql:99`), which would keep numbers and objects.
  - *v1.5:* R3 no longer relies on P2. P2 covered one project on one store, and both backfills are unguarded (F1). P3d re-checked it on its
    own read: 0 mismatches over 503 events. See R3 for why v1.5 takes the stamp from the body.
- **P3, the first prototype.** The first shape added `i.sealed_by` to the matched-set members. It returned the right rows and boundary, but took
  SQL 373–541 ms (6 runs) with `rows_read` 346,674: the suffix member moved to `idx_eai_project_seq`. Not to be built.
- **P3b, the corrected shape** (R4). Members as today, `sealed_by` by primary-key lookup, plain CTE: SQL 152–176 ms (3 runs), against 135–155 ms
  for today's statement in the same run. It returns 175 rows and 698,902 characters, with the unfiltered pair count 946, event count 503 and
  boundary 970.
- **P3c, v1.4's shape** (R4; step 22). One row per matched event, body only for seals: 503 rows, 175 bodies, 698,902 body characters, 946 pairs,
  503 events, boundary 970, exactly as expected. SQL 129–138 ms (3 runs), against 147–172 ms for v1.3's shape and 164–173 ms for today's
  statement in the same run (one control run failed with Cloudflare API error 7403 and returned nothing).
- **P3d, v1.5's stamped flag** (R3, R4; step 24). The flag comes from the body, `json_type(e.body, '$.method.params.sealed_by') IS 'text'`,
  with no index-row lookup.
  - Same results as P3c: 503 rows, 175 bodies, 698,902 body characters, 946 pairs, 503 events, boundary 970; 465 stamped events.
  - SQL 153–200 ms (3 runs), against 167–264 ms for v1.4's shape and 182–210 ms for today's statement in the same rounds. One control run
    failed with Cloudflare API error 7403.
  - `rows_read` 163,558, against 164,504 and 163,498.
  - Parity over the matched set: 465 events stamped by the index, 465 by the body, 0 mismatches, and the first stamped event is 970 either way.
  - Local validation came first (`evt_b7ef8fed3ef54e159358ced611fff56b`). The index was built by the unguarded backfill from bodies stamped
    `42`, `{"x":1}` and `true`, on the D1 schema. The index flag put the boundary at 10; the body flag put it at 13, which is today's JS rule.

## 7. The other options (not proposed for step 1)
- **(iii) Exact owner-qualified keys instead of the suffix scan.** Saves about 140 ms of SQL (28–49 ms against 170–188 ms). But the extra suffix
  row is seq 82, `repo:provenance/retrace#…`, an older owner name and a correct `sameArtifact` match. So exact keys must include every
  historical owner, or real history is silently dropped. It is an add-on after step 1, with its own probe.
- **(iv) Cache the amendment's capture closure** (per amendment seq and read head, extended by `after_seq` on later reads). In steady state it
  removes both capture round trips; option (v) instead combines them into one (v1.5, Codex F3).
  - It needs a new table, an invalidation rule and a backfill, and it puts cached state on a WHO path. Step 2, with its own note.
  - That note must not assume old membership is append-only. A newly matched older stamp can move a boundary (Codex's round 1).
- **(v) Fold `capture_commits` into the `capture_targets` statement** (one SQL statement finding the seals' commit keys and their other
  references). Saves one round trip (about 90 ms). The SQL is more complex, and the preliminary-seal logic (eligibility plus veto) would have to
  move into SQL. Not proposed.

## 8. What this note does not claim
- It does not claim step 1 fits the budget. The capture read's full live duration has not been observed (§1).
  - The SQL-side figures are measured (§6). The Worker-side saving is not: transfer and parse of about 0.7 million characters of bodies plus
    503 small rows, instead of about 3.6 million.
- The row reduction is measured on one amendment's keys and on today's ledger (§6), not proven for every future read. The equality proof in §5
  is still required.
  - Since v1.5 the stamped flag does not depend on the index's `sealed_by` parity (F1).
- The 85–102 ms per small call is a reading of two samples on I/O-gated timers, not a network measurement.
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
| Round 3 at `648ac447`: Grok approved (0 findings); NOOA approved | `evt_93785371c9b34cd79832f92e6a4c9bef`, `evt_23f9ba8d1c09425e91d1532c84681fca` |
| Codex round 1 at `648ac447`: rejected (F1 Medium, F2 and F3 Low); gate check | `evt_aabdb3cf98984d64b33e5086eb0a102a`, `evt_3ab171e1e8cb4ff1a07ef63021df569c` |
| Go for v1.5 | `evt_9ca021b8a82d4863af540f167ebb6e7e` |
| Probe P3d (step 24): kit and local validation, output, reading | `evt_b7ef8fed3ef54e159358ced611fff56b`, `evt_32e2617cbdd543e5b4cb5bbee05f001b`, `evt_7e309e25ff614d12a6a842e3ff84f679` |
