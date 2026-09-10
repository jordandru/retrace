# Step 3 classifier-in-shadow — PR body notes (WIP)

Builder: cursor-agent (Cursor Grok 4.6). Branch: `jordandru/cursor-step3-classifier-shadow`.
Design docs (`step3-classifier-shadow-brief.md`, `commit-trailer-consistency.md`) are **unchanged**.
Copy this into the PR body when the suite is green. Do not treat this file as a contract amendment.

## Q4 — context key vs route reassignment (A5)

**Choice:** a later delivery of the same sha under a different canonical `R` addresses a **different context key** and creates a **second context**. No lookup of `(project, sha)` that ignores `R`. **No new recorded field.**

The key remains exactly `(project, canonical R, full sha)` as design §3.2 / contract §6. `?reassign=` can move a repository's route (and therefore the canonical `R` pinned on a later delivery). Forks already share SHAs across different `R`; collapsing those into one row would mix evidence windows. Recording the repository change on the first row would be a new field — that is a contract amendment, so it is not invented here.

A5 must classify a sha under `R1`, `PUT …/policy?reassign=` so a later delivery is `R2`, and assert **two context rows**.

## Breaker §7 (a), (b), (c)

Implemented in `packages/core/src/classify.ts` (`webhookBreakerAdmission`, `recordWebhookClassifyOutcome`) and `drainPendingGithubDeliveries` in `router.ts`.

**(a) What counts.** Only **synchronous webhook** per-commit outcomes of `deadline` or `store_error` increment the breaker. Drain failures do **not** call `recordWebhookClassifyOutcome`. `budget` never trips the breaker (it still pending/budget_failed after three drains). Hook path is a different route and is unaffected.

**(b) Open breaker vs drain.** An open breaker **does not short-circuit the drain**. `drainPendingGithubDeliveries` never consults the breaker; it keeps classifying. Webhook `POST /hooks/github` returns `202 pending` while open (or while another isolate holds the probe lease). No `conflicting` / `unresolved` is produced on the sync path while open, because that path skips classify.

**(c) What resets `failures`.** **Any successful synchronous webhook classification** resets `failures` to 0 and closes the breaker (`applyBreakerSuccess`). Failures **older than 5 minutes** (`BREAKER_WINDOW_MS`) start a new streak of 1 — the window elapsing without a third failure never opens. Probe success closes; probe failure re-opens with a fresh `opened_at`. The probe is claimed by CAS on the breaker row; an abandoned probe expires with the 60s lease.

## Design discrepancies (brief vs what shipped)

Design text wins. These are implementation notes for reviewers, not silent spec changes.

1. **`previousCaptureTouch` returns `-1` if none; persisted lower is `0`.** Brief §1.4 says `lower(p) = previousCaptureTouch(p, before = U)` (0 if none). `capture.ts` returns `-1`. Classification maps `prev < 0 ? 0 : prev` before insert-if-absent so the stored window matches the brief. Do not change `capture.ts`.

2. **Amendment filter is history `action=other`, not a full v7 git-facts walk.** Witnesses drop events that are the target of an effective attribution amendment at `U`, found via `store.history({ action: "other" })` + `isAttributionAmendment`. That is cheaper than reconstituting the amendment snapshot the design names; if a later review needs the exact snapshot bytes on the context row, that is more than this WIP stored (`amendment_snapshot` is currently `"[]"`).

3. **Unsigned `/2`-shaped commit seals in shadow require a selected policy**, same as `/2`. Missing policy → pending / hook 503 queued loud. `/1` seals stay byte-preserved: they may populate a context (`legacy` kind) but the event is sealed **without** `claim_decision` even if classify is unavailable (T38 counting unchanged).

4. **`would_write` lives inside `claim_decision`.** Shadow always writes `decision.actor_written: "claim"` so `/2` rule 3 (`actor_written = "withheld"`) must not fire. Enforce disposition is only in `would_write`. A1/T25 must assert that.

5. **RemoteStore still has no context readers** (fail closed in `classifyCommitClaim` via `ClassificationStoreError` → `unavailable`). Classification runs on Worker D1 / local SQLite / MemoryEventStore. Do not stub empty.

6. **Webhook `canonicalR` is the routed repo string** passed into `classifyCommitClaim`; facts then run it through `canonicalRepositoryR`. A5 depends on that, not on a `(project, sha)` index.

## What this checkpoint contains vs what is still red

Shipped on this branch:

- `packages/core/src/classify.ts` — derive, decide, would_write, context insert-if-absent, breaker helpers, attach
- Store interface + Memory / Sqlite / D1: classification context, path lowers, breaker CAS, pending lease/outcomes
- Router: shadow `POST /events` classify + 503 pending; GitHub push pending-first + breaker; drain (no breaker)
- GitHub push mapping: `raw_message`, `author`, `parents`
- Local git-hook: classify when `RETRACE_TRAILER_POLICY=shadow` (not `/1`)
- Worker: drain on every scheduled run; `*/5 * * * *` cron added next to hourly `7 * * * *`; checkpoints still hourly
- Tests: T1–T13 (table + classify), T17–T19, T22–T26, T28/T35/T37, T31, T36, T40, P4/P7/P8, A1–A5, two-connection insert-if-absent (Sqlite + D1)

Suite green on this branch (`npm test` from the worktree). Codex first pass is after 14 Sep 22:07. No review rounds before then.
