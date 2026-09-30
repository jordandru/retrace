# Owner-login step B — live Worker timing after PR 138, 2026-09-30

**Status:** v1, 03:47Z 2026-09-30 (9:47 PM MDT 2026-09-29) — five classified deliveries on PR 139, four kinds; the push that lands this text is sample 6. Author grok (measurer), `Grok 4.6 (high)`, harness-display. Class **(b)** under agent-rules 12: a measurement that governs nothing; one non-author review. Go: `evt_3625211c19b24549a439654f786a6674`. Routing: `evt_7bac1370d1d84ab0ac204258e7f842af`. Instruction: `evt_7018e21098e544ccade81d3fd3cc6c74`. Brief `~/.retrace/ops-2026-09-29/brief-grok-stepB-owner-login-timing.md` sha256 `9a17a1fe8a89db3317bc4592687daabb5619ab4f8fb96624282cf22fcf3acb7d`.

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
4. Numbers are copied from sealed events. Nothing is estimated. UTC times are the Worker's clock; MDT is UTC−6.

Classifier stopwatch (`owner-login.ts:119`) starts at `classifyOwnerLogin` entry. `pre_ms` is measured in `appendOwnerLoginEvent` around `head` + policy reads (lines 229–235) and sits **outside** `classification_ms`. Timed stages: `candidates` (`eventsReferencingArtifacts`), `filter` (in-memory eligibility), `consumption` (`ownerLoginConsumptionUpTo`), `amendments` (`evaluateAmendmentsAtU`), `filter` again (selection), then `final_check` (`budget.check()`). `setup` and `final_check` have no `*_ms` field. `OWNER_LOGIN_DEADLINE_MS` is 300; `OWNER_LOGIN_ROW_CAP` is 2_000.

## 3. Timing blocks (seq > 9746)

Every post-deploy owner-login decision read raw through seq 9775 carries a `timing` block. None is missing. All five sealed `system` `github:jordandru`, `unavailable` / `deadline`, `classification_ms 300` = `deadline_ms`, `consumed []`, `stage_failed` **amendments**. `filter_ms` is 0 on every sample. The sum `candidates_ms + filter_ms + consumption_ms + amendments_ms` equals 300 on every sample.

| # | kind | seal | seq | classification_ms | pre_ms | candidates_ms | filter_ms | consumption_ms | amendments_ms | stage_failed | candidates_rows | budget_rows_remaining | deadline_ms | read_head_seq | ingress_at |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `pr_open` | `evt_af42288ee2ed4f17a5461f9046e28828` | 9761 | 300 | 146 | 89 | 0 | 75 | 136 | amendments | 5 | 1988 | 300 | 9760 | 2026-09-30T03:40:31.160Z |
| 2 | `comment` | `evt_7953236af2d94e599e4f73774938acaa` | 9765 | 300 | 222 | 89 | 0 | 83 | 128 | amendments | 4 | 1991 | 300 | 9764 | 2026-09-30T03:41:30.524Z |
| 3 | `pr_edit` | `evt_e0b84daa5e064b1daab9676d4b99f7cf` | 9769 | 300 | 159 | 87 | 0 | 80 | 133 | amendments | 11 | 1984 | 300 | 9768 | 2026-09-30T03:42:08.961Z |
| 4 | `comment` | `evt_eb3862c5bfff4e1aaf12443c4580bb58` | 9772 | 300 | 163 | 86 | 0 | 81 | 133 | amendments | 11 | 1984 | 300 | 9771 | 2026-09-30T03:43:23.913Z |
| 5 | `review` | `evt_b73292cfe21e458c815d1b75aa745178` | 9775 | 300 | 165 | 101 | 0 | 81 | 118 | amendments | 19 | 1972 | 300 | 9774 | 2026-09-30T03:45:48.434Z |
| 6 | `push` | this commit's `pull_request` `synchronize` | — | — | — | — | — | — | — | — | — | — | — | — | after this push |

`candidates_ms` 86–101, `consumption_ms` 75–83, `amendments_ms` 118–136. `amendments_ms` equals the remainder `deadline_ms − candidates_ms − consumption_ms − filter_ms` on every row (136, 128, 133, 133, 118). `pre_ms` 146–222 sits outside the stopwatch and does not reduce `classification_ms`. `budget_rows_remaining` 1972–1991 of 2000: the failure is the deadline, not the row cap. `candidates_rows` grew 4 → 19 as PR 139 artifacts accumulated; a one-key comment (sample 2, no branch, no head_sha) still failed on amendments with the same shape as a three-key `pr_open`.

`payload_time` → `ingress_at`: 20.160 s (sample 1), 2.524 s, 2.961 s, 1.913 s, 2.434 s. Sample 1 is the PR-open delivery; the later four match T3's 2–4 s payload-to-ingress band. Ingress spacings: 59.364 s, 38.437 s, 74.952 s, 144.521 s.

Declarations (agent-ops 19, before each `gh` write): sample 1 `evt_8bd1c1424c564fbca6835e50612973ae`; sample 2 `evt_7c2b4ab2bdfd41899ad03aa8f5dfc8e8`; sample 3 `evt_356aac73279644aea24e005b5ccdc218`; sample 4 `evt_55e493f2ef7e420ebc3407166f5da4be`; sample 5 `evt_9f60230ccd8c4402a3907907be510665`. GitHub objects: PR 139; comment 5903596852; body PATCH 03:42:06Z; comment 5903614160; review 5361238286 `COMMENTED` at `b8788cbff8dc682b9d9ee548d54d3ae71acebf78`.

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

Binds for sample 1: `'retrace'`, `9760`, `20001`. Partial index `idx_events_amendment_candidates ON events(project, seq) WHERE action = 'other' AND json_extract(body, '$.action_detail') = 'amended'` (`schema.sql:24–25`). The `json_type` / `json_each(tags)` predicates are not in that index. If this read returns rows, `amendmentDependencies` follows with `getMany` (`SELECT body FROM events WHERE id IN (SELECT value FROM json_each(?))`, `d1-store.ts:101–106`) and `amendmentCaptureDependencies` may run a second `eventsReferencingArtifacts`. Those follow-ups are inside `amendments_ms`. Whether the 118–136 ms is the first SELECT, the follow-ups, or both is what the EXPLAIN and Workers Logs have to show.

### 4.2 `candidates` — completed in 86–101 ms (not the failing stage)

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

### 4.3 `consumption` — completed in 75–83 ms

`d1-store.ts:45–48`. Binds: `project`, `throughSeq` (read head), eligible-by-time candidate ids (up to 90 per batch), `LIMIT` remaining+1. Primary key `(project, declaration_event_id)` (`schema.sql:183–191`). No index on `consumed_by_seq`.

### 4.4 `filter` / `setup` / `final_check`

No D1 statement. `filter_ms` measured 0.

## 5. Live D1 plan and Workers Logs

Script (Jordan's hand, agent-ops 16 / agent-rules 13): `~/.retrace/ops-2026-09-30/stepB-d1-plan-and-logs.sh`. Mode 700; `read -p` before each remote call; prints plans, counts, `duration_ms`, `rows_read`, exit codes; never a token. SQL files beside it under `~/.retrace/ops-2026-09-30/sql/` are `EXPLAIN QUERY PLAN` and `SELECT COUNT(*)` / index-key lists only.

Wrangler at this checkout (`node_modules/.bin/wrangler --help`): `d1 execute` and `tail` exist; there is **no** wrangler subcommand that queries stored Workers Logs. Historical logs are the dashboard Observability Query Builder (Workers Logs enabled, `head_sampling_rate 1`, `wrangler.toml:38–42`). The script prints the dashboard path and the measured `X-GitHub-Delivery` ids. `wrangler tail` is live-only and is not started by the script.

Deliveries for the dashboard filter:

| sample | delivery |
|---|---|
| 1 pr_open | `a472d1a0-bc80-11f1-86f3-f2ed59eac385` |
| 2 comment | `d2317b50-bc80-11f1-8f33-8bbc7c98025e` |
| 3 pr_edit | `e9126a50-bc80-11f1-87da-4827c8c8b09c` |
| 4 comment | `15e57b80-bc81-11f1-842e-cc9734107f25` |
| 5 review | `6c027770-bc81-11f1-9222-ae7e8f8fa114` |

## 6. Conclusion (bounded by the seals; plan still Jordan's)

The stage that spends the remaining budget is **`amendments`**. Candidates and consumption return on every measured kind; filter is 0 ms; `classification_ms` equals `deadline_ms` because `amendments_ms` takes the remainder. The deploy took: every seq > 9746 decision has `timing`. The row cap is not exhausted.

What the seals do not show: whether `amendmentEventsUpTo` scans `events`, whether `idx_events_amendment_candidates` is used, how many amendment rows exist at U ≈ 9760, and how much of the 118–136 ms is the first SELECT versus `getMany` / a second artifact-index read. That is the script.

Options for step C, each with the evidence it still needs:

1. **Rewrite `amendmentEventsUpTo` to a covering index seek, or extend `idx_events_amendment_candidates` to include the attribution predicates**, if Jordan's EXPLAIN is `SCAN events` or a temp b-tree sort. Evidence required: the EXPLAIN of `explain-amendments-9760.sql` plus `count-amendments-full-9760.sql`.
2. **Scope the amendment candidate read to this delivery's artifact keys / window**, if the partial-index EXPLAIN is a seek but `COUNT(*)` is large (thousands of `action=other` / `amended` rows through U). The classifier already has the covered keys from the candidate stage; `evaluateAmendmentsAtU` still asks for every amendment through U (`classify.ts:610`). Evidence required: the two COUNTs (partial-index predicate vs full filter).
3. **Bound or skip the follow-up `getMany` / second `eventsReferencingArtifacts` inside `evaluateAmendmentsAtU`**, if EXPLAIN of the first SELECT is a cheap seek and COUNT is small, so the 118–136 ms is the follow-ups. Evidence required: Workers Logs D1 duration for the delivery window, and `rows_read` on the COUNT statements.
4. **Raise `OWNER_LOGIN_DEADLINE_MS`**, if the plan is already the intended seek and the live duration of that seek is ~130 ms with no missing index. That keeps fail-closed behaviour and buys the remainder; it does not remove a scan if one is there. Evidence required: the same EXPLAIN showing an index seek, plus Workers Logs wall/CPU for one delivery.
5. **Leave candidates and consumption alone as the first cut.** They complete in 86–101 ms and 75–83 ms with 4–19 events; a one-key comment and a three-key PR open fail the same way. Evidence: §3.

No option is a decision. Sample 6 (the push of this text) is expected to repeat `stage_failed` amendments; if it does not, that is a finding and this section is corrected in place.

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
| Samples 1–5 seals | §3 |
| Jordan script | `~/.retrace/ops-2026-09-30/stepB-d1-plan-and-logs.sh` |
