# Smart Placement for retrace-api — deployment and measurement note

**Status:** v1.1, 2026-09-30. Author claude-code (coordinator). Class **(a)** under agent-rules 12 (a deploy control), in PR 141 with the
`[placement]` block it governs. v1 was written on Jordan's go `evt_ad2606acb3a94ad980eb8c0e2d12df93` to answer the PR 141 round-1 findings:
Codex F1/F2 (`evt_b0cba5056712470dba2c1eae7a9fdc80`), NOOA M1/M2/L3 (`evt_ee1dd85c75db4be8aabc4d1189136ddd`) and Grok G-L1
(`evt_cd66dafed9754ee0bbc500f02a7e4f62`). v1.1 was written on Jordan's go `evt_ca15a87dbe3f408497ced878f773d66f` to answer the round-2 findings:
Codex F2a/F2b (`evt_8fa2de86955c4056a5619d6a1b376da0`), NOOA L1 (`evt_8afe9adedb5b45cd9779cc80002c4ada`) and Grok G-L2
(`evt_e005226713654468a3fd34785a576b93`). v1 said each response carries a `cf-placement` header and prescribed a laptop check of it. That was
wrong: Cloudflare documents the header on the request, and this Worker does not echo it. The error came from a summary of the Cloudflare page.
Cloudflare source: https://developers.cloudflare.com/workers/configuration/placement/ (read 2026-09-30).

## 1. What is measured and what is not

| | source |
|---|---|
| **Measured.** D1 `retrace-db` runs in WNAM; read replication is disabled. | `wrangler d1 info`, `evt_49c7d1532f15425d87417a48b4e5f58b` |
| **Measured.** Owner-login stages that make one D1 call seal `candidates_ms` 86–118, `consumption_ms` 75–91; `pre_ms` 146–222 covers two calls. | step-B record §3 |
| **Measured.** Every classified delivery after the PR 138 deploy (7 in the step-B record, plus PR 141's own open, seq 9900) sealed `unavailable` / `deadline`, `stage_failed amendments`. | step-B record §3; seal seq 9900 |
| **Measured.** One amendment COUNT executed in D1 in 1.3754 ms (528 rows read). | step-B record §5 correction |
| **Not measured.** Execution time of the candidate and consumption statements; the Cloudflare colo that runs GitHub's webhook requests; the Worker→D1 round-trip time. | — |
| **Hypothesis.** Most of each call is Worker→D1 transport because the Worker runs far from WNAM. Smart Placement is the test of it, not a consequence of it. | — |

## 2. What Smart Placement does here (Cloudflare's documentation)

- It affects **fetch handlers only**: the webhook route, `/api`, `/mcp` and every other HTTP route move together. The two crons (`7 * * * *`,
  `*/5 * * * *`) are not placed.
- It may take **up to 15 minutes** after deploy to analyse; until then the status is absent.
- Status values (Workers API, `GET /accounts/<id>/workers/services/retrace-api`): absent (not analysed), `SUCCESS`, `INSUFFICIENT_INVOCATIONS`
  ("not received enough requests from multiple locations"), `UNSUPPORTED_APPLICATION` (placement made it slower). The status is **per deployment**:
  `SUCCESS` means Cloudflare is placing the Worker. It does not show that any single webhook request was placed.
- **1 % of requests stay unplaced** as Cloudflare's baseline. Sealed deliveries do not record which requests were placed. Cloudflare's
  `cf-placement` value is a request header that this Worker neither records nor returns, so it is not used here.
- **It needs consistent traffic from multiple locations.** Nearly all of this Worker's fetch traffic is GitHub's webhooks, plus the owner's
  laptop and seats. `INSUFFICIENT_INVOCATIONS` is therefore a real outcome, in which case the change is inert (§5). One sender does not by itself
  prove one Cloudflare ingress location; the status is what decides.

## 3. Baseline: what is on record, and what the deploy must record

- **On record now:** the step-B record's 7 deliveries plus seq 9900, 8 of 8 `unavailable`/`deadline`. Over the step-B samples 1–7,
  `candidates_ms` is 86–118 (median 89) and `consumption_ms` is 75–91 (median 81).
- **Recorded by the deploy script, before the deploy (a required deploy step, not yet on record):** five sequential probes of each of `GET /api` and
  `GET /mcp` from the laptop, `curl -s -o /dev/null -w '%{http_code} %{time_total}'`, 1 second apart. Record every code and time, and the median time.

## 4. After the deploy (Grok seat, measurer, on its own go)

1. Record the deployed Version ID (deploy script output).
2. **Engagement.** No sooner than 15 minutes after the deploy, read the placement status from the Workers API in a typed script under Jordan's
   Cloudflare login (agent-ops 16), and record it verbatim. If it is absent, re-read every 15 minutes up to 60 minutes after the deploy.
3. **Sample**, taken only after a `SUCCESS` read: the next **six** classified deliveries, across at least three kinds. For each, read raw
   `decision.status`, `decision.reason`, `classification_ms`, `candidates_ms`, `consumption_ms`, the whole `timing` block, and the GitHub delivery's
   HTTP status (`gh api repos/jordandru/retrace/hooks/671790737/deliveries`, read-only).
4. **Probes after:** repeat the §3 laptop probes once the sample is complete.
5. **Report** as a class (b) measurement with the numbers only, reading them with the §5 table.

## 5. How the result is read (labels describe observations; none establishes cause)

**Threshold derivation (NOOA L1).** A classification with six sequential D1 calls fits the 300 ms budget only if the calls average **≤ 50 ms**
(300 / 6). The step-B band's lower bound is **75 ms**, the smallest single-call stage time sealed (`consumption_ms` 75). The statistic is the
**median over the six sampled deliveries**, computed separately for `candidates_ms` and for `consumption_ms`, the two stages that make exactly one D1
call. `amendments_ms` is never read as a per-call time, because that stage makes several calls.

| engagement status | sample | label |
|---|---|---|
| `SUCCESS` | both medians ≤ 50 ms and 6 of 6 deliveries not `unavailable`/`deadline` | **Per-call times fell and no delivery in the sample hit the deadline after placement engaged.** Cause is not established (no concurrent control). Part 2 is optional. |
| `SUCCESS` | both medians ≤ 50 ms and ≥ 1 of 6 `unavailable`/`deadline` | **Per-call times fell; N of 6 deliveries still hit the deadline.** Part 2 is required. |
| `SUCCESS` | both medians ≥ 75 ms | **No observed change in per-call times.** Roll back (§6). |
| `SUCCESS` | any other combination | **Inconclusive.** Take one further sample of six. If still inconclusive, report it and Jordan decides. |
| `INSUFFICIENT_INVOCATIONS`, or absent at 60 minutes | not taken | **Placement did not engage; the hypothesis is untested.** Jordan decides whether to keep it (inert) or roll it back. Next options: explicit targeted placement (`mode = "targeted"` with a region, schema-valid in wrangler 4.123.0) as its own class (a) PR, or Part 2. |
| `UNSUPPORTED_APPLICATION` | not taken | **Cloudflare judged placement slower.** Roll back. |

**Attribution limit, stated (NOOA M2).** A canary or statistical control is not practical at this traffic, a few classified deliveries an hour
from one sender. The comparison is before/after against the step-B record, with the placement status and the two medians as the evidence.

## 6. Regression and rollback

Roll back if any of these holds:
- a §5 row says roll back;
- the median `GET /api` probe time after deploy is more than twice the median before;
- any `GET /mcp` probe returns a different HTTP status code from the one recorded before the deploy;
- any GitHub delivery in the sample shows a 5xx status.

**Rollback** means removing the `[placement]` block from `apps/worker/wrangler.toml` and **deploying**. Editing the file alone changes nothing
live. Both the change (a PR) and the deploy wait for Jordan's go (agent-rules 14). Nothing needs restoring: no binding, secret or data depends
on placement.

## 7. Result, rollback and a correction (2026-09-30, appended; agent-rules 10)

*Appended on Jordan's go `evt_f50a1ec5eac64741bff18a788a4aa6e5`, revised in PR 143 before review on `evt_326a3954d2b54ce08c625b03c6068bef`. The text
above is unchanged.*

**Result.** Deployed as Version `f3b73603-878f-4d6d-8c60-e152723c8c72` at 15:14:02Z (`evt_fce4ac4a07754da6a9ce64ce9237ba76`). Workers API
`placement_status` was `SUCCESS` at 15:30:22Z (`evt_effe29bed231473181d468609db33672`). The first six classified deliveries after that read
(seqs 10026, 10031, 10034, 10037, 10039, 10044) all sealed `unavailable` / `deadline`. Median `candidates_ms` was 129.5 (baseline 89) and median
`consumption_ms` was 104.5 (baseline 81). §5 row: **Improvement threshold not met** (Codex's round-3 wording). The Grok seat's report is PR 142. The
coordinator recomputed it from the seals (`evt_e49599f5936b4a86b8134f3bfaa9c365`).

**Rollback, partial.** Jordan ran `wrangler rollback` to `0acfff97-4cf3-4a5e-b279-8fa3a971878a` at 16:03:01Z (`evt_1772404122494351b6ec61fba4356e87`).
It restored the code. It did **not** clear placement: at 16:15:18Z the Workers API still reported `placement_mode: smart`, `status: SUCCESS`,
and script `modified_on` 15:14:01Z (`evt_5d5ae2bfd24a43b8bb11250aba50227a`). So from 16:03Z the live Worker ran the 0acfff97 code **with placement on**.
Rolling back to a version does not revert a script setting; §6's "remove the block and deploy" is the revert that counts.

**The actual revert (this PR, then a deploy).** `apps/worker/wrangler.toml` sets `[placement] mode = "off"`. In wrangler 4.123.0,
`parseConfigPlacement` returns no placement for `mode = "off"` (without a hint), and the same happens when the block is absent, so the deploy uploads no
placement field either way. Whether Cloudflare then clears the setting is **not known in advance**. After the deploy, the same Workers API read
decides it: `placement_mode` absent or not `smart`. If it is still `smart`, the next step is an explicit Workers API change to the script's
placement setting, as its own step on Jordan's go.

**Correction to §6 (the `/api` probe rule).** The rule "roll back if the median `GET /api` probe time after deploy is more than twice the median
before" measures the owner's laptop path together with the Worker. The medians were 0.193018 s before the deploy (15:13Z), 0.690811 s at 15:51Z, and
0.645650 s at 16:03Z. Placement was on at both of the later reads, so they cannot separate placement from the network. What they do show: at
16:04Z the laptop's Cloudflare edge was YYZ (SJC at the earlier `wrangler d1 info` read); `/cdn-cgi/trace`, which the edge serves without running
the Worker, took 0.50–1.01 s; and one `/api` probe timed out. The laptop's own path was slow, so that condition cannot be attributed to placement. The
rollback rests on the §5 row, which uses times measured inside the Worker. Any future latency note should compare edge-only timings
(`/cdn-cgi/trace`) with Worker timings, or measure inside the Worker.

**Not established.** Why per-call times rose with placement on. Whether any single request was placed. Whether the next deploy clears the
placement setting (checked by the read above).
