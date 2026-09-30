# Owner-login step B — live Worker timing after PR 138, 2026-09-30

**Status:** v2, 04:00Z 2026-09-30 (10:00 PM MDT 2026-09-29) — seven classified deliveries; Jordan's nine D1 EXPLAIN/COUNT results applied (paste `evt_cd9014c2ad454b158d0d12f329b9c7d5`, relay `evt_8f554e349e6a4e3bb06e35e47a7c8686`). Author grok (measurer), `Grok 4.6 (high)`, harness-display. Class **(b)** under agent-rules 12: a measurement that governs nothing; one non-author review. Go: `evt_3625211c19b24549a439654f786a6674`. Routing: `evt_7bac1370d1d84ab0ac204258e7f842af`. Instruction: `evt_7018e21098e544ccade81d3fd3cc6c74`; follow-up instruct `evt_6ee1be0467e14275aa16392137f1b652`. Brief `~/.retrace/ops-2026-09-29/brief-grok-stepB-owner-login-timing.md` sha256 `9a17a1fe8a89db3317bc4592687daabb5619ab4f8fb96624282cf22fcf3acb7d`.

**v2.1** 04:17Z 2026-09-30 (10:17 PM MDT 2026-09-29) — dated correction of EXPLAIN `meta.duration` as planning time (claude-code L1 `evt_31b9f7e7dfa042ecacb430676eae3e3b`, Low; Jordan go `evt_495c061be73a4a308835e0adfab16248` "Grok as author, you review"). Routing `evt_57a79a55fba848c895424687ac3bbe68`. Instruction `evt_00fbe088414341f182db99d6914fc22c`. Brief `~/.retrace/ops-2026-09-30/brief-grok-stepB-l1-correction.md` sha256 `990217022a74e892d97cbe5b7840d0d62f5f664de09521fdb6edbc3b8deee207`. Class **(b)**; reviewer claude-code.

## 1. What is measured

T3 (`docs/measurements/owner-login-t3-2026-09-29.md` §4 T3-F1) sealed every classified GitHub delivery `unavailable` / `deadline` at `classification_ms 300` and could not name the read that spent the budget. PR 138 (merged `3f926396`, Worker Version `0acfff97-4cf3-4a5e-b279-8fa3a971878a`, deploy outcome `evt_7f536ba93b22418cb6e55943c53b7812` seq 9746) adds `decision.timing`. This file records every owner-login decision sealed after that deploy (seq > 9746), names the failing stage's D1 statements at `3f926396`, and points at the read-only script Jordan runs for `EXPLAIN QUERY PLAN` and Workers Logs.

Measurement only: no code, config, policy or Worker change.

State at the first read (this seat, `GET /projects/retrace/head` and `GET /projects/retrace/status`):

| what | value |
|---|---|
| Worktree HEAD | `3f92639656053ddf547b9865261dcc66d187c3d9` at start; this text is committed on `jordandru/grok-owner-login-stepB` |
| Live Worker | `retrace-api` Version `0acfff97-4cf3-4a5e-b279-8fa3a971878a` |
| Ledger head | seq **9753**, hash `1111074cffef3eace840c1cd7f3efe00a1c2f0a0c2d19a6a7e33a72b3db46f09` |
| Events 9747–9753 | Jordan go `evt_3625211c…`, tidy, routing, sent pointer, grok received, two instructed events — **zero** `github:jordandru` webhook seals |
| `capture.owner_login_events` at seq 9753 | total 738, sealed_as_human 711, by_status.unavailable **27**, declared_by_seat 0 |

## 2. Method

1. Read `GET /projects/retrace/events?limit=N` only to discover ids (the list is an envelope). Every decision in §3 is then read raw: `GET /events/<id>` with this seat's credential.
2. Each GitHub write this seat made on PR 139 was declared under agent-ops 19 (`method.params.github_action`) before the `gh` call; the webhook seal was read raw afterwards. `pr_edit` used REST `PATCH` (T3: `gh pr edit` fails on `projectCards`).
3. Stage SQL is taken from `packages/core/src/owner-login.ts` `classifyOwnerLogin` and `apps/worker/src/d1-store.ts` at `3f926396`. Bind values below are from sample 1 (PR open, seq 9761, `read_head_seq` 9760).
4. Numbers are copied from sealed events or from Jordan's wrangler `--json` `meta.duration` / `rows_read` / result rows. Nothing is estimated. UTC times are the Worker's clock; MDT is UTC−6. Wrangler CLI `wall_ms` in the script log is the laptop-to-query-API path and is not Worker-to-D1 RTT.

Classifier stopwatch (`owner-login.ts:119`) starts at `classifyOwnerLogin` entry. `pre_ms` is measured in `appendOwnerLoginEvent` around `head` + policy reads (lines 229–235) and sits **outside** `classification_ms`. Timed stages: `candidates` (`eventsReferencingArtifacts`), `filter` (in-memory eligibility), `consumption` (`ownerLoginConsumptionUpTo`), `amendments` (`evaluateAmendmentsAtU`), `filter` again (selection), then `final_check` (`budget.check()`). `setup` and `final_check` have no `*_ms` field. `OWNER_LOGIN_DEADLINE_MS` is 300; `OWNER_LOGIN_ROW_CAP` is 2_000.

## 3. Timing blocks (seq > 9746)

Every post-deploy owner-login decision read raw through seq 9793 carries a `timing` block. None is missing. All seven sealed `system` `github:jordandru`, `unavailable` / `deadline`, `classification_ms 300` = `deadline_ms`, `consumed []`, `stage_failed` **amendments**. `filter_ms` is 0 on every sample. The sum `candidates_ms + filter_ms + consumption_ms + amendments_ms` equals 300 on every sample.

| # | kind | seal | seq | classification_ms | pre_ms | candidates_ms | filter_ms | consumption_ms | amendments_ms | stage_failed | candidates_rows | budget_rows_remaining | deadline_ms | read_head_seq | ingress_at |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `pr_open` | `evt_af42288ee2ed4f17a5461f9046e28828` | 9761 | 300 | 146 | 89 | 0 | 75 | 136 | amendments | 5 | 1988 | 300 | 9760 | 2026-09-30T03:40:31.160Z |
| 2 | `comment` | `evt_7953236af2d94e599e4f73774938acaa` | 9765 | 300 | 222 | 89 | 0 | 83 | 128 | amendments | 4 | 1991 | 300 | 9764 | 2026-09-30T03:41:30.524Z |
| 3 | `pr_edit` | `evt_e0b84daa5e064b1daab9676d4b99f7cf` | 9769 | 300 | 159 | 87 | 0 | 80 | 133 | amendments | 11 | 1984 | 300 | 9768 | 2026-09-30T03:42:08.961Z |
| 4 | `comment` | `evt_eb3862c5bfff4e1aaf12443c4580bb58` | 9772 | 300 | 163 | 86 | 0 | 81 | 133 | amendments | 11 | 1984 | 300 | 9771 | 2026-09-30T03:43:23.913Z |
| 5 | `review` | `evt_b73292cfe21e458c815d1b75aa745178` | 9775 | 300 | 165 | 101 | 0 | 81 | 118 | amendments | 19 | 1972 | 300 | 9774 | 2026-09-30T03:45:48.434Z |
| 6 | `push` | `evt_3df41332856a4714a72b34e964e2bb35` | 9783 | 300 | 162 | 111 | 0 | 91 | 98 | amendments | 23 | 1976 | 300 | 9782 | 2026-09-30T03:49:08.039Z |
| 7 | `push` | `evt_6586f473e10c421db14dad65e329bc0e` | 9793 | 300 | 184 | 118 | 0 | 84 | 98 | amendments | 28 | 1966 | 300 | 9792 | 2026-09-30T03:51:06.117Z |

`candidates_ms` 86–118, `consumption_ms` 75–91, `amendments_ms` 98–136. `amendments_ms` equals the remainder `deadline_ms − candidates_ms − consumption_ms − filter_ms` on every row (136, 128, 133, 133, 118, 98, 98). Samples 6–7 spent more in candidates (111–118 ms, 23–28 rows), so amendments had 98 ms left and still failed there. `pre_ms` 146–222 sits outside the stopwatch and does not reduce `classification_ms`. `budget_rows_remaining` 1966–1991 of 2000: the failure is the deadline, not the row cap. `candidates_rows` grew 4 → 28 as PR 139 artifacts accumulated; a one-key comment (sample 2, no branch, no head_sha) still failed on amendments with the same shape as a three-key `pr_open`.

`payload_time` → `ingress_at`: 20.160 s (sample 1), 2.524 s, 2.961 s, 1.913 s, 2.434 s, 2.039 s, 1.117 s. Sample 1 is the PR-open delivery; samples 2–7 match T3's 2–4 s payload-to-ingress band. Ingress spacings: 59.364 s, 38.437 s, 74.952 s, 144.521 s, 199.605 s, 118.078 s.

Declarations (agent-ops 19, before each `gh` write): sample 1 `evt_8bd1c1424c564fbca6835e50612973ae`; sample 2 `evt_7c2b4ab2bdfd41899ad03aa8f5dfc8e8`; sample 3 `evt_356aac73279644aea24e005b5ccdc218`; sample 4 `evt_55e493f2ef7e420ebc3407166f5da4be`; sample 5 `evt_9f60230ccd8c4402a3907907be510665`; sample 6 `evt_6adff91d608643fd8e425e0c5833d903`; sample 7 `evt_f34634e7373045b287f9d9d8331a50f9`. GitHub objects: PR 139; comment 5903596852; body PATCH 03:42:06Z; comment 5903614160; review 5361238286 `COMMENTED` at `b8788cbff8dc682b9d9ee548d54d3ae71acebf78`; pushes `b8788cb..178d559` and `178d559..13cdbb8`.

## 4. The failing stage's query (code at `3f926396`)

**Failing stage: `amendments`.** `evaluateAmendmentsAtU` (`classify.ts:577`) runs after candidates and consumption have returned. Sample 1 binds: `project = "retrace"`, `U = 9760`, `CLASSIFY_ROW_CAP + 1 = 20001`.

### 4.1 `amendments` — `D1Store.amendmentEventsUpTo` (`d1-store.ts:114–125`)

```
SELECT body FROM events
 WHERE project = ? AND seq <= ?
   AND action = 'other'
   AND json_extract(body, '$.action_detail') = 'amended'
   AND (
     json_type(body, '$.method.params.attribution') IS NOT NULL
     OR EXISTS (SELECT 1 FROM json_each(body, '$.tags') WHERE value = 'attribution')
   )
 ORDER BY seq ASC LIMIT ?
```

Binds for sample 1: `'retrace'`, `9760`, `20001`. Partial index `idx_events_amendment_candidates ON events(project, seq) WHERE action = 'other' AND json_extract(body, '$.action_detail') = 'amended'` (`schema.sql:24–25`). The `json_type` / `json_each(tags)` predicates are not in that index. Jordan's EXPLAIN of this statement is `SEARCH events USING INDEX idx_events_amendment_candidates (project=? AND seq<?)` plus a correlated `json_each` subquery (`sql_duration_ms` 0.4555). The COUNT of the same predicate returns **n = 1** (`sql_duration_ms` 1.3754, `rows_read` 528). The first SELECT is not a table scan and is not a large result.

If this read returns rows, `amendmentDependencies` follows with `getMany` (`SELECT body FROM events WHERE id IN (SELECT value FROM json_each(?))`, `d1-store.ts:101–106`) and `amendmentCaptureDependencies` may run a second `eventsReferencingArtifacts`. Those follow-ups are inside `amendments_ms` and are sequential D1 calls after the first SELECT.

### 4.2 `candidates` — completed in 86–118 ms (not the failing stage)

Called at `owner-login.ts:168–169` with `after_seq: -1`, `through_seq: readHead.seq`, `row_cap` 2_000 at entry. Exact `eq` keys only:

- `pr:jordandru/retrace#139` when the delivery names a PR
- `git:jordandru/retrace#jordandru/grok-owner-login-stepB` when `github_payload.branch` is a string
- `commit:jordandru/retrace@<head_sha first 12 hex>` when `github_payload.head_sha` is a string

Sample 1 (`pr_open`) bound all three, `through_seq` 9760, `LIMIT 2001`. Sample 2 (`comment`) bound only `pr:jordandru/retrace#139`, `through_seq` 9764. One statement (`store.ts:412–424`):

```
WITH w(project, after_seq, through_seq) AS (SELECT ?, ?, ?)
SELECT e.body, m.seq, m.artifact_key FROM (
  SELECT DISTINCT i.seq, i.artifact_key
  FROM w CROSS JOIN json_each(?) t CROSS JOIN event_artifact_index i
  WHERE i.project = w.project
    AND i.artifact_key = t.value
    AND i.seq > w.after_seq AND i.seq <= w.through_seq
) m CROSS JOIN events e ON e.project = ? AND e.seq = m.seq
ORDER BY m.seq ASC, m.artifact_key ASC
LIMIT ?
```

Indexes that should serve the inner seek: `event_artifact_index` primary key `(project, artifact_key, seq)` and `idx_eai_project_key_seq (project, artifact_key, seq)` (`schema.sql:35–46`). Outer join: `events` unique `(project, seq)`.

### 4.3 `consumption` — completed in 75–91 ms

`d1-store.ts:45–48`. Binds: `project`, `throughSeq` (read head), eligible-by-time candidate ids (up to 90 per batch), `LIMIT` remaining+1. Primary key `(project, declaration_event_id)` (`schema.sql:183–191`). No index on `consumed_by_seq`.

### 4.4 `filter` / `setup` / `final_check`

No D1 statement. `filter_ms` measured 0.

## 5. Live D1 plan and Workers Logs

Jordan ran `~/.retrace/ops-2026-09-30/stepB-d1-plan-and-logs.sh` (paste `evt_cd9014c2ad454b158d0d12f329b9c7d5`). Raw wrangler `--json` files: `~/.retrace/ops-2026-09-30/stepB-output/`. Manifest file sha256 `8b561b1389575a2411abb97bc740defb134f964d2965ff002f26a9697a91c410`; `sha256sum -c` matches every result file (the manifest's self-line is the empty-file digest and is unused). All nine calls: wrangler exit 0, `rows_written` 0. `meta.duration` below is D1 SQL engine time. *(corrected below.)* Script `wall_ms` 1537–2135 is the laptop wrangler path and is not used as Worker-to-D1 RTT.

| call | plan / result | D1 `duration_ms` | `rows_read` |
|---|---|---:|---:|
| explain amendments (full) | `SEARCH events USING INDEX idx_events_amendment_candidates (project=? AND seq<?)`; correlated `json_each` subquery | 0.4555 | 0 |
| explain amendments (partial) | same index, no subquery | 0.5142 | 0 |
| count amendments full | n = **1** | 1.3754 | 528 |
| count amendments partial | n = **159** | 0.2903 | 159 |
| explain candidates pr_open 9760 | `SEARCH i USING COVERING INDEX idx_eai_project_key_seq (project=? AND artifact_key=? AND seq>? AND seq<?)`; `SEARCH e USING INDEX sqlite_autoindex_events_2`; temp B-trees for DISTINCT and ORDER BY | 0.3633 | 0 |
| explain candidates comment 9764 | same plan | 0.5496 | 0 |
| count candidates pr_open 9760 | `index_rows` = 7 | 0.3427 | 13 |
| list candidate index 9760 (`artifact_key IN (...)`, diagnostic) | 7 rows | 40.8151 | 29,463 |
| explain consumption | `SEARCH owner_login_consumption USING INDEX sqlite_autoindex_owner_login_consumption_1 (project=? AND declaration_event_id=?)` | 0.3443 | 0 |

*Correction, 04:17Z 2026-09-30 (10:17 PM MDT 2026-09-29; source: claude-code review `evt_31b9f7e7dfa042ecacb430676eae3e3b`, L1, Low; Jordan go `evt_495c061be73a4a308835e0adfab16248`): the `meta.duration` values on the `EXPLAIN QUERY PLAN` rows (0.4555, 0.5142, 0.3633, 0.5496, 0.3443; `rows_read` 0) are planning time. `EXPLAIN QUERY PLAN` compiles and does not run the statement. Only the two amendment COUNTs executed a production predicate: full filter 1.3754 ms, 528 rows read, n=1; partial 0.2903 ms, 159 rows read, n=159. Candidate and consumption execution time was not measured. The sentence above the table that calls every `meta.duration` "D1 SQL engine time" is the claim this paragraph corrects.*

**The 40.8 ms / 29,463-row query is not a production classifier statement.** It is this measurement's `list-candidate-index-9760.sql` (`IN` on `artifact_key` with a seq filter). `eventsReferencingArtifactsStatements` (`store.ts:371–427`) binds keys through `json_each` and seeks `idx_eai_project_key_seq` with the seq window in the seek — the 0.36 ms covering-index plan. `artifactKeyMatchSql`'s `artifact_key IN (?)` form (`store.ts:306`) is reached only from tests (`store.test.ts:286–287`), not from `classifyOwnerLogin`. Consumption's `declaration_event_id IN (...)` is a primary-key seek per id (EXPLAIN above), a different table.

Workers Logs: wrangler 4.123.0 has no historical query (`tail` is live-only). Jordan has not read the dashboard. Delivery ids for a later dashboard pass:

| sample | delivery |
|---|---|
| 1 pr_open | `a472d1a0-bc80-11f1-86f3-f2ed59eac385` |
| 2 comment | `d2317b50-bc80-11f1-8f33-8bbc7c98025e` |
| 3 pr_edit | `e9126a50-bc80-11f1-87da-4827c8c8b09c` |
| 4 comment | `15e57b80-bc81-11f1-842e-cc9734107f25` |
| 5 review | `6c027770-bc81-11f1-9222-ae7e8f8fa114` |
| 6 push | `e2e2e640-bc81-11f1-9ead-42d06c624027` |
| 7 push | `29791ed0-bc82-11f1-803c-5bde80da5a9b` |

### 5.1 D1 statements per stage at `3f926396` (code count, not logs)

Sequential calls on the live append path. Each `prepare`/`first`/`all` is one Worker→D1 round trip.

| stage | statements | count |
|---|---|---|
| `pre` (outside `classification_ms`) | `head`; `getPolicyByActivationSeq` | **2** sequential |
| `candidates` | `eventsReferencingArtifacts` — one statement when all keys are `eq` (PR/branch/commit) | **1** |
| `filter` | none | **0** |
| `consumption` | `ownerLoginConsumptionUpTo` — one `IN` batch of ≤90 ids; samples 1–7 have ≤28 candidate events | **1** |
| `amendments` | `amendmentEventsUpTo` (always); then `getMany` once for the required id set and once per `caused_by` hop not already loaded (`classify.ts:451–484`); then 0–2 further `eventsReferencingArtifacts` in `amendmentCaptureDependencies` (uncovered target keys; commit prefixes) | **≥1**; with n=1 amendment row, a `caused_by` walk adds **≥1** `getMany` |
| `final_check` | `budget.check()` only | **0** |

Minimum sequential D1 **inside** the 300 ms stopwatch: **3** (candidates, consumption, `amendmentEventsUpTo`). A fourth call (`getMany` or a capture re-query) starts after those three have returned.

## 6. Conclusion

The failing stage on every measured delivery is **`amendments`**. The deploy took (`timing` present on every seq > 9746 decision). The row cap is not exhausted. The query **plans are index searches**, not table scans.

D1 SQL engine time on the production-shaped statements is **0.29–1.38 ms**. *(corrected below.)* Sealed stage times on those same stages are **75–136 ms**. The COUNT of the failing statement returns **one row**. The planner and the row counts do not account for the sealed milliseconds.

That gap is consistent with the coordinator's hypothesis (relay §hypothesis): the 300 ms budget is spent on **sequential Worker→D1 round trips and the number of those calls**, not on a missing index. Workers Logs were not read, so round-trip time itself is **unmeasured**; what is measured is that SQL `duration_ms` is two orders of magnitude below `*_ms` on every indexed query. *(corrected below.)*

*Correction, 04:17Z 2026-09-30 (10:17 PM MDT 2026-09-29; same sources as §5): the "0.29–1.38 ms" band and the "two orders of magnitude below `*_ms` on every indexed query" sentence treat EXPLAIN `meta.duration` as SQL engine time. Those EXPLAIN durations are planning time (`rows_read` 0). The executed production-predicate times in §5 are the two amendment COUNTs only (1.3754 ms full, 0.2903 ms partial). Candidate and consumption execution time is unmeasured, so a comparison of SQL engine time to sealed `candidates_ms` / `consumption_ms` is not in the record. The conclusion of this section is unchanged: amendments spends the budget; the plans are index searches; Worker→D1 round-trip time is unmeasured.*

A picture that fits both the seals and the plans, without claiming the unread logs: three sequential D1 calls (candidates, consumption, first amendment SELECT) consume most of 300 ms; the next sequential call inside `evaluateAmendmentsAtU` (`getMany` on the `caused_by` walk, or a capture `eventsReferencingArtifacts`) starts with ~98–136 ms remaining and hits the deadline, so `stage_failed` is always `amendments`. Sample 7 (v1.1 push, seq 9793) repeated the same shape (`candidates_ms` 118, `consumption_ms` 84, `amendments_ms` 98).

Options for step C (not a decision):

1. **Cut sequential D1 calls in `classifyOwnerLogin` / `evaluateAmendmentsAtU`.** Collapse the `caused_by` walk's per-hop `getMany` into one `getMany` of the remaining chain; skip `amendmentCaptureDependencies` extra index reads when the amendment row has no uncovered target artifacts; consider combining `head` + policy (already outside the stopwatch, `pre_ms` 146–222). Evidence: §5 plans are seeks; §5.1 call count; COUNT n=1; sealed `amendments_ms` is the remainder after two ~80–110 ms stages. Workers Logs would confirm per-query wait; they are still unread.
2. **Raise `OWNER_LOGIN_DEADLINE_MS`** so the existing call sequence can finish. Keeps fail-closed behaviour. Does not remove round trips. Evidence: the same seeks and n=1; three sequential calls already fill most of 300 ms (§3 sums).
3. **Leave the candidate and consumption SQL as-is for the first cut.** Each is one indexed statement (`idx_eai_project_key_seq` covering seek; consumption primary key). Their sealed 75–118 ms is the same round-trip tax as amendments' first SELECT, not a scan. Evidence: §5 EXPLAIN + §3. A one-key comment and a three-key PR open fail the same way.
4. **Do not add or extend `idx_events_amendment_candidates` as the first cut.** EXPLAIN is already `SEARCH` on that index; full COUNT is 1 row in 1.38 ms. Evidence: §5 rows 1–4.
5. **Do not treat the 40.8 ms `IN`-list as a classifier defect.** It is the diagnostic listing query; production does not issue that shape (`store.ts:371–427` vs `artifactKeyMatchSql` tests-only). Evidence: §5 last two candidate rows vs `list-candidate-index-9760`.

Option 1 of v1.1 (rewrite the first SELECT for a missing scan) is closed by the EXPLAIN. Option 2 of v1.1 (scope a thousands-row amendment read) is closed by n=1 / n=159. Option 3 of v1.1 (follow-up calls) remains, now as option 1 here, with the sequential-call count from the code.

## 7. Record

| what | event |
|---|---|
| Jordan go (step B to Grok) | `evt_3625211c19b24549a439654f786a6674` |
| Deploy PR 138 Worker `0acfff97…` | `evt_7f536ba93b22418cb6e55943c53b7812` seq 9746 |
| Routing (class b, grok, high) | `evt_7bac1370d1d84ab0ac204258e7f842af` |
| Sent pointer / grok received / instruct | `evt_7e0a61c6934c497f86bea062ba113f66` / `evt_7ef3c5907e25486cb3b6f6d7973c841f` / `evt_7018e21098e544ccade81d3fd3cc6c74` |
| Head at first read | seq 9753 |
| v0 skeleton edit / commit | `evt_ffc4a3f3d9544f62b31bfb795fc32c13` / `b8788cbff8dc682b9d9ee548d54d3ae71acebf78` |
| PR 139 | https://github.com/jordandru/retrace/pull/139 |
| Samples 1–7 seals | §3 |
| Jordan script / paste / relay | `~/.retrace/ops-2026-09-30/stepB-d1-plan-and-logs.sh` / `evt_cd9014c2ad454b158d0d12f329b9c7d5` / `evt_8f554e349e6a4e3bb06e35e47a7c8686` |
| Raw D1 JSON | `~/.retrace/ops-2026-09-30/stepB-output/` (manifest file sha256 `8b561b1389575a2411abb97bc740defb134f964d2965ff002f26a9697a91c410`) |
| claude-code L1 (Low) / Jordan go / routing | `evt_31b9f7e7dfa042ecacb430676eae3e3b` / `evt_495c061be73a4a308835e0adfab16248` / `evt_57a79a55fba848c895424687ac3bbe68` |
| L1 correction sent / received / instruct | `evt_aed7b090433d4e6d905551f431820741` / `evt_952c41a31e4749fa979b84b1828599e8` / `evt_00fbe088414341f182db99d6914fc22c` |
