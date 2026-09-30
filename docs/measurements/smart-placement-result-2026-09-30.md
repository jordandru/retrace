# Smart Placement result — retrace-api, 2026-09-30

**Status:** v0.1 — five classified deliveries sealed; this commit's push is sample 6. Author grok (measurer), `Grok 4.6 (high)`, harness-display. Class **(b)** under agent-rules 12: a measurement that governs nothing; one non-author review. Go: `evt_dd964d92dac64f118dc6367de6438fd1`. Routing: `evt_86f8407bf72b404999dbf8332598a2e2`. Instruction: `evt_af2175a1b09c4a8493b1d6e5756743bd`. Brief `~/.retrace/ops-2026-09-30/brief-grok-placement-measure.md` sha256 `8a13e7d8d138fb448fb6999f6e361d4f6ae0dc7e29daea3c692f716d6cea5005`. Contract: `docs/design/smart-placement-deploy-note.md` v1.1 on main `b972c1c6` (PR 141). Pull request **#142**.

This pull request is also the sample: GitHub writes on it (open, comment, body edit, review, push) are classified deliveries, as in step B. Tables fill from raw `GET /events/<id>` and from `gh api repos/jordandru/retrace/hooks/671790737/deliveries`. No new thresholds. No causal claims.

## Facts on record (cited; not re-derived)

- Deploy: Version **`f3b73603-878f-4d6d-8c60-e152723c8c72`** from `b972c1c6`, `wrangler deploy` at **2026-09-30T15:14:02Z** (outcome `evt_fce4ac4a07754da6a9ce64ce9237ba76`). Previous version `0acfff97`.
- §3 baseline, recorded before the deploy by the script (`~/.retrace/ops-2026-09-30/step11-probes.txt`): `/api` 200 ×5, median **0.193018 s**; `/mcp` 401 ×5, median **0.356604 s**. Step-B medians: `candidates_ms` **89**, `consumption_ms` **81**.
- §4.2 engagement: Workers API `placement_status` **`SUCCESS`**, `last_analyzed_at` 2026-09-30T15:14:17.352017Z, read 15:30:22Z by Jordan (`evt_effe29bed231473181d468609db33672`). SUCCESS is deployment-level and says nothing about a single request.
- At 15:31Z no owner-login decision had been sealed after 15:14:02Z.

## Method

1. Sample (§4.3): the first six classified owner-login deliveries sealed after the §4.2 read (after 15:30:22Z), across at least three kinds. Each GitHub write is declared under agent-ops 19 before the `gh` call. Each decision is read raw: seq, id, kind, `decision.status`, `decision.reason`, `classification_ms`, the whole `timing` block. Each is matched to its GitHub delivery and the HTTP `status_code` recorded.
2. Probes after (§4.4): five sequential `curl -s -o /dev/null -w '%{http_code} %{time_total}'` to each of `/api` and `/mcp`, 1 second apart, after the six are in.
3. Read (§5–§6): median over the six of `candidates_ms` and of `consumption_ms`. Pick the §5 row by its predicate. Codex round-3 wording for the ≥ 75 ms row: **Improvement threshold not met**. Evaluate each §6 rollback condition. `amendments_ms` is reported and is never read as a per-call time.

## Sample (§4.3)

Five classified deliveries sealed after 15:30:22Z on PR 142 (kinds `pr_open`, `comment`, `pr_edit`, `comment`, `review`). This commit's push is the sixth. Full timing table after the sixth seals and the §4.4 probes run.

## Probes after (§4.4)

*Pending the six.*

## §5 row and §6 rollback

*Pending the six and the probes.*

## What this result does not show

Cause. Whether any single request was placed. Cloudflare's `cf-placement` value is a request header this Worker neither records nor returns.

Retrace-Caused-By: evt_dd964d92dac64f118dc6367de6438fd1
