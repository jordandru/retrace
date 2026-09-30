# Owner-login step B — live Worker timing after PR 138, 2026-09-30

**Status:** v0 skeleton, 03:3xZ 2026-09-30 — opened so this pull request's own classified deliveries are the sample. Author grok (measurer), `Grok 4.6 (high)`, harness-display. Class **(b)** under agent-rules 12: a measurement that governs nothing; one non-author review. Go: `evt_3625211c19b24549a439654f786a6674`. Routing: `evt_7bac1370d1d84ab0ac204258e7f842af`. Instruction: `evt_7018e21098e544ccade81d3fd3cc6c74`. Brief `~/.retrace/ops-2026-09-29/brief-grok-stepB-owner-login-timing.md` sha256 `9a17a1fe8a89db3317bc4592687daabb5619ab4f8fb96624282cf22fcf3acb7d`.

## 1. What is measured

T3 (`docs/measurements/owner-login-t3-2026-09-29.md` §4 T3-F1) sealed every classified GitHub delivery `unavailable` / `deadline` at `classification_ms 300` and could not name the read that spent the budget. PR 138 (merged `3f926396`, Worker Version `0acfff97-4cf3-4a5e-b279-8fa3a971878a`, deploy outcome `evt_7f536ba93b22418cb6e55943c53b7812` seq 9746) adds `decision.timing`. This file records every owner-login decision sealed after that deploy (seq > 9746), names the failing stage's D1 statements at `3f926396`, and points at the read-only script Jordan runs for `EXPLAIN QUERY PLAN` and Workers Logs.

Measurement only: no code, config, policy or Worker change.

State at the first read (this seat, `GET /projects/retrace/head` and `GET /projects/retrace/status`):

| what | value |
|---|---|
| Worktree HEAD | `3f92639656053ddf547b9865261dcc66d187c3d9` (`jordandru/grok-owner-login-stepB`) |
| Live Worker | `retrace-api` Version `0acfff97-4cf3-4a5e-b279-8fa3a971878a` |
| Ledger head | seq **9753**, hash `1111074cffef3eace840c1cd7f3efe00a1c2f0a0c2d19a6a7e33a72b3db46f09` |
| Events 9747–9753 | Jordan go `evt_3625211c…`, tidy, routing, sent pointer, grok received, two instructed events — **zero** `github:jordandru` webhook seals |
| `capture.owner_login_events` at seq 9753 | total 738, sealed_as_human 711, by_status.unavailable **27**, declared_by_seat 0 |

## 2. Method

1. Read `GET /projects/retrace/events?limit=30` only to discover ids (the list is an envelope). Every decision in the table is then read raw: `GET /events/<id>` with this seat's credential.
2. Each GitHub write this seat makes on this pull request is declared under agent-ops 19 (`method.params.github_action`) before the `gh` call; the webhook seal is read raw afterwards.
3. Stage SQL is taken from `packages/core/src/owner-login.ts` `classifyOwnerLogin` and `apps/worker/src/d1-store.ts` at `3f926396`. Bind values come from one measured delivery's `github_payload` and `decision.context.read_head_seq`.
4. Numbers are copied from sealed events or command output. Nothing is estimated.

Classifier stopwatch (`owner-login.ts:119`) starts at `classifyOwnerLogin` entry. `pre_ms` is measured in `appendOwnerLoginEvent` around `head` + policy reads (lines 229–235) and sits **outside** `classification_ms`. Timed stages: `candidates` (`eventsReferencingArtifacts`), `filter` (in-memory eligibility), `consumption` (`ownerLoginConsumptionUpTo`), `amendments` (`evaluateAmendmentsAtU`), `filter` again (selection), then `final_check` (`budget.check()`). `setup` and `final_check` have no `*_ms` field. `OWNER_LOGIN_DEADLINE_MS` is 300; `OWNER_LOGIN_ROW_CAP` is 2_000.

## 3. Timing blocks (seq > 9746)

None at head 9753. Rows are appended as this pull request's classified deliveries seal. A decision without a `timing` block after seq 9746 is a finding (the deploy did not take).

| # | kind | seal (seq) | status / reason | classification_ms | pre_ms | candidates_ms | filter_ms | consumption_ms | amendments_ms | stage_failed | candidates_rows | budget_rows_remaining | deadline_ms | read_head_seq |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| — | — | none yet | — | — | — | — | — | — | — | — | — | — | — | — |

## 4. The failing stage's query (code at `3f926396`)

Until a post-deploy decision seals, the failing stage is unnamed. The statements each timed stage runs on D1:

### 4.1 `candidates` — `D1Store.eventsReferencingArtifacts` / `eventsReferencingArtifactsStatements`

Called at `owner-login.ts:168–169` with `project: "retrace"`, `after_seq: -1`, `through_seq: readHead.seq`, `row_cap: budget.remaining` (2_000 at entry), `deadline: args.deadline`. Keys (exact `eq` terms only; no prefixes on this path):

- `pr:jordandru/retrace#<n>` when the delivery names a PR
- `git:jordandru/retrace#<branch>` when `github_payload.branch` is a string
- `commit:jordandru/retrace@<head_sha first 12 hex>` when `github_payload.head_sha` is a string

An `issue_comment` payload has no branch and no head_sha (build brief §1.1), so a **comment** delivery binds only the `pr:` key. `pr_open` / `push` (synchronize) bind all three when those payload fields are present.

One statement (all keys are `eq`, one `json_each` member, under D1's five-term compound limit):

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

Bind order (`store.ts:412–424`): `project`, `after_seq` (−1), `through_seq` (read head), JSON array of the exact keys, `project` again, `row_cap + 1` (2001 at entry).

Indexes that should serve the inner seek: `event_artifact_index` primary key `(project, artifact_key, seq)` and `idx_eai_project_key_seq (project, artifact_key, seq)` (`apps/worker/schema.sql:35–46`). The outer join is `events` unique `(project, seq)`. Comment on the SQL (`store.ts:360–368`): exact keys are intended to seek that index with the seq window inside the seek; a scan of the project's whole artifact index is the planner failure this shape was written to avoid.

### 4.2 `consumption` — `D1Store.ownerLoginConsumptionUpTo`

Runs only after candidates return. `d1-store.ts:45–48`:

```
SELECT * FROM owner_login_consumption
 WHERE project = ?
   AND consumed_by_seq <= ?
   AND declaration_event_id IN (/* up to 90 ids per batch */)
 LIMIT ?
```

Binds: `project`, `throughSeq` (read head), the eligible-by-time candidate ids, `row_cap - rows.length + 1`. Batched at 90 ids (`readOwnerLoginConsumption`, `store.ts:898–909`). Primary key `(project, declaration_event_id)` (`schema.sql:183–191`). There is no index on `consumed_by_seq`.

### 4.3 `amendments` — `evaluateAmendmentsAtU` → `amendmentEventsUpTo` then optional `getMany` / a second `eventsReferencingArtifacts`

`d1-store.ts:114–125`, limit `CLASSIFY_ROW_CAP + 1` = 20_001 (`classify.ts:42`, `store.ts:220`):

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

Partial index `idx_events_amendment_candidates ON events(project, seq) WHERE action = 'other' AND json_extract(body, '$.action_detail') = 'amended'` (`schema.sql:24–25`). The `json_extract` / `json_each` predicates on attribution are not in that index. Follow-up `getMany` is `SELECT body FROM events WHERE id IN (SELECT value FROM json_each(?))` (`d1-store.ts:101–106`). Capture follow-up reuses `eventsReferencingArtifacts` with the covered keys plus any extra paths amendments name.

### 4.4 `filter` / `setup` / `final_check`

No D1 statement. `filter` is in-memory. `setup` is the pre-query guard (`eventsReferencingArtifacts` and `ownerLoginConsumptionUpTo` present, finite ingress). `final_check` is `budget.check()` after selection.

Measured bind values for one delivery land in §3 once a seal exists, and in `~/.retrace/ops-2026-09-30/stepB-d1-plan-and-logs.sh`.

## 5. Live D1 plan and Workers Logs

Script (Jordan's hand, agent-ops 16 / agent-rules 13): `~/.retrace/ops-2026-09-30/stepB-d1-plan-and-logs.sh`. Mode 700; `read -p` before each remote call; prints plans, counts, durations, exit codes; never a token.

Wrangler at this checkout (`node_modules/.bin/wrangler --help`): `d1 execute` and `tail` exist; there is **no** wrangler subcommand that queries stored Workers Logs. Historical logs are the dashboard Observability Query Builder (Workers Logs enabled on this Worker, `head_sampling_rate 1`, `wrangler.toml:38–42`). The script states that and prints the dashboard filter for the measured window. `wrangler tail` is live-only and is not used to reconstruct a past delivery.

## 6. Conclusion

Deferred until §3 has ≥ 6 decisions across ≥ 3 kinds and Jordan's script output is in. Options for step C will cite those numbers; no cause is claimed from the code shape alone.

## 7. Record

| what | event |
|---|---|
| Jordan go (step B to Grok) | `evt_3625211c19b24549a439654f786a6674` |
| Deploy PR 138 Worker `0acfff97…` | `evt_7f536ba93b22418cb6e55943c53b7812` seq 9746 |
| Routing (class b, grok, high) | `evt_7bac1370d1d84ab0ac204258e7f842af` |
| Sent pointer / grok received / instruct | `evt_7e0a61c6934c497f86bea062ba113f66` / `evt_7ef3c5907e25486cb3b6f6d7973c841f` / `evt_7018e21098e544ccade81d3fd3cc6c74` |
| Head at first read | seq 9753 |
