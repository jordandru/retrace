# Smart Placement result — retrace-api, 2026-09-30

**Status:** v1, 15:52Z 2026-09-30 (9:52 AM MDT). Author grok (measurer), `Grok 4.6 (high)`, harness-display. Class **(b)** under agent-rules 12: a measurement that governs nothing; one non-author review. Go: `evt_dd964d92dac64f118dc6367de6438fd1`. Routing: `evt_86f8407bf72b404999dbf8332598a2e2`. Instruction: `evt_af2175a1b09c4a8493b1d6e5756743bd`. Brief `~/.retrace/ops-2026-09-30/brief-grok-placement-measure.md` sha256 `8a13e7d8d138fb448fb6999f6e361d4f6ae0dc7e29daea3c692f716d6cea5005`. Contract: `docs/design/smart-placement-deploy-note.md` v1.1 on main `b972c1c6` (PR 141). Pull request **#142**.

Measurement only: no code, config, policy or Worker change. Rollback waits on Jordan's go (agent-rules 14).

## Facts on record (cited; not re-derived)

- Deploy: Version **`f3b73603-878f-4d6d-8c60-e152723c8c72`** from `b972c1c6`, `wrangler deploy` at **2026-09-30T15:14:02Z** (outcome `evt_fce4ac4a07754da6a9ce64ce9237ba76`). Previous version `0acfff97`.
- §3 baseline, recorded before the deploy by the script (`~/.retrace/ops-2026-09-30/step11-probes.txt`): `/api` 200 ×5, median **0.193018 s**; `/mcp` 401 ×5, median **0.356604 s**. Step-B medians: `candidates_ms` **89**, `consumption_ms` **81**.
- §4.2 engagement: Workers API `placement_status` **`SUCCESS`**, `last_analyzed_at` 2026-09-30T15:14:17.352017Z, read 15:30:22Z by Jordan (`evt_effe29bed231473181d468609db33672`). SUCCESS is deployment-level and says nothing about a single request.
- At 15:31Z no owner-login decision had been sealed after 15:14:02Z.

## Method

1. Sample (§4.3): the first six classified owner-login deliveries sealed after the §4.2 read (after 15:30:22Z), across at least three kinds. Each GitHub write on PR 142 was declared under agent-ops 19 before the `gh` call. `pr_edit` used REST `PATCH` (T3: `gh pr edit` fails on `projectCards`). Each decision was read raw (`GET /events/<id>`): seq, id, kind, `decision.status`, `decision.reason`, `classification_ms`, the whole `timing` block. Each was matched to its GitHub delivery (`gh api repos/jordandru/retrace/hooks/671790737/deliveries`) and the HTTP `status_code` recorded. The events list was used only to discover ids.
2. Probes after (§4.4): once the six were in, five sequential `curl -s -o /dev/null -w '%{http_code} %{time_total}'` to each of `/api` and `/mcp`, 1 second apart, from this laptop. Every line and the median are below. File `~/.retrace/ops-2026-09-30/step4-probes-after.txt` sha256 `a47cd6177771904170a939132575912467d601511f2e61b921dbde1e9c6e6feb`.
3. Read (§5–§6): median over the six of `candidates_ms` and of `consumption_ms` (average of the 3rd and 4th values in each sorted list of six). The §5 predicate is SUCCESS and both medians ≥ 75 ms. Label, per the brief's Codex round-3 wording: **Improvement threshold not met**. Each §6 rollback condition is evaluated below. `amendments_ms` is reported and is never read as a per-call time.

A scan of `github:jordandru` events after 15:30:22Z found **six** owner-login decisions and no earlier classified delivery in that window. Those six are the sample.

## Sample (§4.3)

Every sample sealed `system` `github:jordandru`, `unavailable` / `deadline`, `classification_ms` 300 = `deadline_ms`, `consumed []`. `filter_ms` is 0 on every sample. Kinds: `pr_open`, `comment`, `pr_edit`, `comment`, `review`, `push` (five kinds).

| # | kind | seal | seq | classification_ms | pre_ms | candidates_ms | filter_ms | consumption_ms | amendments_ms | stage_failed | candidates_rows | budget_rows_remaining | deadline_ms | read_head_seq | ingress_at |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `pr_open` | `evt_5c2d8fc57f9e4b948332ebb13e5c709a` | 10026 | 300 | 366 | 201 | 0 | 99 | null | consumption | 4 | 1995 | 300 | 10025 | 2026-09-30T15:44:49.735Z |
| 2 | `comment` | `evt_540b78add0194fea8ccb8fbbfbb96786` | 10031 | 300 | 232 | 124 | 0 | 127 | 49 | amendments | 6 | 1994 | 300 | 10030 | 2026-09-30T15:46:16.266Z |
| 3 | `pr_edit` | `evt_c9a61a4a6e58457685b246c9360a962e` | 10034 | 300 | 233 | 135 | 0 | 135 | 30 | amendments | 10 | 1989 | 300 | 10033 | 2026-09-30T15:47:26.299Z |
| 4 | `comment` | `evt_702ca3480a6d4bcaab6d378c0fad7bf6` | 10037 | 300 | 217 | 119 | 0 | 110 | 71 | amendments | 12 | 1988 | 300 | 10036 | 2026-09-30T15:48:17.050Z |
| 5 | `review` | `evt_314102dd5aae43c49a16fb078ed1f82b` | 10039 | 300 | 365 | 224 | 0 | 76 | null | consumption | 17 | 1980 | 300 | 10038 | 2026-09-30T15:48:54.851Z |
| 6 | `push` | `evt_2ce5d473c1414666a035cfe6d723af02` | 10044 | 300 | 168 | 95 | 0 | 77 | 128 | amendments | 19 | 1974 | 300 | 10043 | 2026-09-30T15:50:51.047Z |

`candidates_ms` 95, 119, 124, 135, 201, 224 (sample order 201, 124, 135, 119, 224, 95). Median of six = (124 + 135) / 2 = **129.5**. `consumption_ms` 76, 77, 99, 110, 127, 135 (sample order 99, 127, 135, 110, 76, 77). Median of six = (99 + 110) / 2 = **104.5**. Both ≥ 75. Neither ≤ 50.

`amendments_ms` (reported, not a per-call time): null, 49, 30, 71, null, 128. Samples 1 and 5 have `amendments_ms` null: `stage_failed` is `consumption`, so the amendments stage did not run. On samples 2–4 and 6, `candidates_ms + filter_ms + consumption_ms + amendments_ms` equals 300.

`pre_ms` 168–366 sits outside `classification_ms`. `budget_rows_remaining` 1974–1995 of 2000: the failure is the deadline, not the row cap.

`payload_time` → `ingress_at`: 83.735 s (sample 1), 22.266 s, 13.299 s, 3.050 s, 2.851 s, 2.047 s. Sample 1 is the PR-open delivery. Ingress spacings: 86.531 s, 70.033 s, 50.751 s, 37.801 s, 116.196 s.

Declarations (agent-ops 19, before each write): sample 1 `evt_f305b27eaaee4a20b944ee206fa43d55`; sample 2 `evt_9e5cd56cff3e410cae18638136536937`; sample 3 `evt_5bf30985f6df4b5d81b8cc304af55aee`; sample 4 `evt_a12719f38fc44e918f138e75724c5cbf`; sample 5 `evt_de63e4295d7e4e2ea0df92e0ee7e495d`; sample 6 `evt_3e746e30b3c0422cbe45659ab4a51b6b`. GitHub objects: PR 142; comment 5914695278; body PATCH 15:47:13Z; comment 5914738258; review 5368659567 `COMMENTED` at `85ff82e6090df51672f6016b869aa3becb52245d`; push `85ff82e..97b8662`.

GitHub delivery HTTP `status_code` (hook 671790737):

| sample | delivery | event / action | status_code |
|---|---|---|---|
| 1 pr_open | `ad8ba9a0-bce5-11f1-84ec-af01dcdb7470` | `pull_request` / `opened` | 201 |
| 2 comment | `0608dc60-bce6-11f1-988c-e5dbac41c741` | `issue_comment` / `created` | 201 |
| 3 pr_edit | `35391770-bce6-11f1-8252-0e1c0a146d27` | `pull_request` / `edited` | 201 |
| 4 comment | `59c552c0-bce6-11f1-8c17-71423399baed` | `issue_comment` / `created` | 201 |
| 5 review | `70479242-bce6-11f1-890a-f625b00f96cd` | `pull_request_review` / `submitted` | 201 |
| 6 push | `b5473a00-bce6-11f1-83a9-4971976a72a1` | `pull_request` / `synchronize` | 201 |

No 5xx in the sample.

## Probes after (§4.4)

Quoted from `~/.retrace/ops-2026-09-30/step4-probes-after.txt` (15:51:21Z):

```
  after /api #1: 200 0.455189
  after /api #2: 200 0.549982
  after /api #3: 200 0.690811
  after /api #4: 200 0.717765
  after /api #5: 200 0.718411
  after /api median_s: 0.690811
  after /mcp #1: 401 0.401582
  after /mcp #2: 401 0.615949
  after /mcp #3: 401 0.727331
  after /mcp #4: 401 0.616922
  after /mcp #5: 401 0.721342
  after /mcp median_s: 0.616922
```

Before (cited from `step11-probes.txt`): `/api` median **0.193018 s**, `/mcp` 401 ×5, median **0.356604 s**. After `/api` median **0.690811 s** is more than twice 0.193018 s (twice = 0.386036 s). After `/mcp` codes are 401, the same code recorded before the deploy.

## §5 row

Engagement status `SUCCESS`. Sample: both medians ≥ 75 ms (`candidates_ms` 129.5, `consumption_ms` 104.5); 6 of 6 `unavailable`/`deadline`.

Label: **Improvement threshold not met**.

That is the SUCCESS / both-medians-≥-75-ms row of the note. The brief directs Codex's round-3 wording for this row. The note on that row directs rollback under §6.

## §6 rollback conditions

| condition | holds |
|---|---|
| A §5 row says roll back | **yes** — Improvement threshold not met |
| Median `GET /api` after > twice the median before | **yes** — 0.690811 s > 0.386036 s |
| Any `GET /mcp` probe returns a different HTTP status from before | no — 401 ×5, matching the before-deploy code |
| Any GitHub delivery in the sample shows a 5xx status | no — 201 ×6 |

Two §6 conditions hold. Rollback means removing the `[placement]` block from `apps/worker/wrangler.toml` and deploying. Both the change (a PR) and the deploy wait for Jordan's go. This seat does not deploy, roll back, or change config.

**Correction (2026-09-30, appended; agent-rules 10).** On Jordan's go `evt_c9f052f9a8144996a8b2bf79de5104d1`, after claude-code review `evt_4c954e129dbc4fa385bc2138aef4e5e1` (L1, L2). The §6 table is unchanged. `docs/design/smart-placement-deploy-note.md` §7 records that later laptop `/api` probes cannot separate placement from the network: placement was on at both later reads. The laptop's own path was slow: edge YYZ, `/cdn-cgi/trace` 0.50–1.01 s, one timeout. The `/api` condition held as written; it cannot be attributed to placement. The rollback rests on the §5 row. A stray body line `Retrace-Caused-By: evt_dd964d92dac64f118dc6367de6438fd1` belonged in the commit message and has been removed.

## What this result does not show

Cause. Whether any single request was placed. Cloudflare's `cf-placement` value is a request header this Worker neither records nor returns. `placement_status` SUCCESS is per deployment. 1 % of requests stay unplaced as Cloudflare's baseline. The comparison is before/after against the step-B record.
