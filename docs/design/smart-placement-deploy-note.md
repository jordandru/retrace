# Smart Placement for retrace-api — deployment and measurement note

**Status:** v1, 2026-09-30. Author claude-code (coordinator). Class **(a)** under agent-rules 12 (a deploy control), in PR 141 with the
`[placement]` block it governs. Written on Jordan's go `evt_ad2606acb3a94ad980eb8c0e2d12df93` to answer PR 141 round-1 findings: Codex F1/F2
(`evt_b0cba5056712470dba2c1eae7a9fdc80`), NOOA M1/M2/L3 (`evt_ee1dd85c75db4be8aabc4d1189136ddd`), Grok G-L1 (`evt_cd66dafed9754ee0bbc500f02a7e4f62`).
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
  ("not received enough requests from multiple locations"), `UNSUPPORTED_APPLICATION` (placement made it slower).
- **1 % of requests stay unplaced** as Cloudflare's baseline.
- Each response carries `cf-placement: remote-<colo>` (placed) or `local-<colo>` (not placed).
- **It needs consistent traffic from multiple locations.** Nearly all of this Worker's fetch traffic is GitHub's webhooks from one source, plus
  the owner's laptop and seats. `INSUFFICIENT_INVOCATIONS` is therefore a real outcome, in which case the change is inert (§5).

## 3. Before the deploy (baseline, already on record)

The step-B record is the baseline: 8 of 8 deliveries `unavailable`/`deadline`; per-call stage times in the bands above. Also recorded right before
the deploy, by the deploy script: five `curl` timings of `GET /api` from the laptop (median ms) and the `cf-placement` header on one of them.

## 4. After the deploy (Grok seat, measurer, on its own go)

1. Record the deployed Version ID (deploy script output).
2. **Engagement.** Wait at least 15 minutes. Then, in a typed script under Jordan's Cloudflare login (agent-ops 16), read the placement status
   from the Workers API, and read `cf-placement` on a laptop request. Record both verbatim. If the status is absent, wait and re-read, up to 60
   minutes after the deploy.
3. **Sample.** Once the status is `SUCCESS` (or at 60 minutes, whatever it is), read the next **six** classified deliveries across at least three
   kinds, raw: `decision.status`, `decision.reason`, `classification_ms`, the whole `timing` block. Deliveries do not record whether they were in
   the 1 % unplaced baseline; say so rather than guess.
4. **Report** as a class (b) measurement with the numbers only.

## 5. How the result is read

| outcome | reading |
|---|---|
| Status `SUCCESS`, per-call stage times fall below ~30 ms, and ≥ 5 of 6 deliveries finish without `unavailable`/`deadline` | The budget problem is resolved for now. Placement is the likely cause, but there is no concurrent control: the claim is "after placement engaged, timing changed from the step-B band to X". |
| Status `SUCCESS`, per-call times fall, deliveries still deadline | Transport was part of it; Part 2 (fewer sequential calls) is still required. |
| Status `SUCCESS`, per-call times unchanged | The transport hypothesis is not supported; roll back (below) and look at D1 execution time. |
| `INSUFFICIENT_INVOCATIONS` or still absent at 60 minutes | Placement did not engage and says nothing about the hypothesis. Keep or roll back (it is inert). Next options: explicit targeted placement (`mode = "targeted"` with a region; schema-valid in wrangler 4.123.0) as its own class (a) PR, or Part 2. |
| `UNSUPPORTED_APPLICATION` | Cloudflare judged placement slower; roll back. |

**Attribution limit, stated (NOOA M2).** A canary or statistical control is not practical at this traffic, a few classified deliveries an hour
from one sender. The comparison is before/after against the step-B record, with placement status and the per-call timing as the evidence.

## 6. Regression and rollback

Roll back if any of these holds after engagement:
- per-call stage times do not fall below the step-B band;
- the laptop median for `GET /api` more than doubles against the baseline in §3, or `/mcp` stops answering;
- any webhook delivery returns 5xx (GitHub's delivery log or Workers Logs);
- the status is `UNSUPPORTED_APPLICATION`.

**Rollback** means removing the `[placement]` block from `apps/worker/wrangler.toml` and **deploying**. Editing the file alone changes nothing
live. Both the change (a PR) and the deploy wait for Jordan's go (agent-rules 14). Nothing to restore: no binding, secret or data depends on
placement.
