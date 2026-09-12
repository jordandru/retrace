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

2. **Amendment effectiveness is `collectAttributionAmendments` on the complete prefix at `U`, not a history page.** `store.all(project)` filtered to `seq ≤ U` (same 20,000-row / 500 ms budget as §3.5). A single `history({ action: "other", limit })` page is not used — that class is unbounded and would silently drop older amendments. Effectiveness uses attribution.ts (`effective` / `superseded` / `rejected`); a PARTIAL amendment excludes only its amended artifacts. Context `amendment_snapshot` is `{"effective":[{id,target,artifacts,whole_event},…]}` at `U`, or `{"unavailable":…}` if the prefix cannot be evaluated inside the budget. Never the literal `"[]"` (a false empty set). Full v7 git-facts are not reconstituted at ingest (Worker has no checkout); the ledger-only capture context feeds the same collector. Over-budget / store failure → classification `unavailable` (fail closed).

3. **Unsigned `/2`-shaped commit seals in shadow require a selected policy**, same as `/2`. Missing policy → pending / hook 503 queued loud. `/1` seals stay byte-preserved: they may populate a context (`legacy` kind) but the event is sealed **without** `claim_decision` even if classify is unavailable (T38 counting unchanged).

4. **`would_write` lives inside `claim_decision`.** Shadow always writes `decision.actor_written: "claim"` so `/2` rule 3 (`actor_written = "withheld"`) must not fire. Enforce disposition is only in `would_write`. A1/T25 must assert that.

5. **RemoteStore still has no context readers** (fail closed in `classifyCommitClaim` via `ClassificationStoreError` → `unavailable`). Classification runs on Worker D1 / local SQLite / MemoryEventStore. Do not stub empty.

6. **Webhook and drain `canonicalR` are the routed repo string.** The hook path now passes the same pin via `routedCanonicalRForHook` (the project's one active policy route, else the sole `github_repos` entry). `canonicalRForFacts` still gives a supplied pin precedence. A hook artifact repo that is not a policy alias therefore shares the webhook context (T11). A5 still depends on an explicit pin, not a `(project, sha)` index.

7. **`decision.classification_ms`** is server-derived elapsed ms inside `claim_decision` (already in `RESERVED_METHOD_PARAMS_V2`; no `/3` bump). Informational; never a selector. Rule 3 still keys only on `decision.actor_written === "withheld"`.

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

## Round 3 correction — 2026-09-12

The builder runtime for this round is **GPT-5.6 Sol**, not the model named in the original header.
The blanket test-coverage sentence above is superseded: it overstated what the named fixtures establish.
In particular, this PR no longer claims T3/T4, T7, T12/T13, T18, T19/T36, T23, T24,
T26/A2, T35/T37, or T40 beyond the assertions actually present in each test. Step-4 consumer,
report, certificate, and `may_downgrade` behavior is not a step-3 deliverable and is not claimed.

Round-3 finding disposition and pinning tests:

- F1 fixed — `F1: classifier amendment cascade matches v7 capture-boundary effectiveness`
- F2 fixed — `F2: deadline crossing during lower persistence returns unavailable and no decision`; `F2 HTTP: lower-bound deadline returns hook 503/webhook 202 and seals nothing`
- F3/F4 fixed — `F3/F4: saved policy aliases determine submitted F, witnesses, and previous captures`
- F5 fixed — expanded `T11 hook: non-alias repo string shares the webhook context` compares digest, bounds, witnesses, and decision on both seals
- F6 fixed (Codex's repro was valid: `captureSeals` returns a bare 12-character SHA key, so checks for keys ending in `@<sha>` did not match it) — `F6: a pre-existing seal for this SHA is excluded from lower-bound touches`
- F7 fixed — `F7: pinned client commit claim cannot create or freeze the producer context`
- F8 fixed — `F8: one 2s delivery budget returns 202 with current and remaining shas`
- F9/F10 fixed — `F9/F10: drain budgets are per-sha and terminal/policy-off work stays durable`
- F11/F12 fixed — `F11/F12: one atomic drainer wins and unresolved rows cannot starve ready work`; SQLite and D1 F11 connection tests
- F13 fixed — `F13: success resets per commit; classifier store errors are 202; pending insert failure is 500`
- F14/F15/F16 fixed — `F14/F15/F16: breaker CAS retries, sparse window restarts, and a live probe has one owner`; `F16 HTTP: duplicate delivery ids cannot execute the same half-open probe`
- F17 fixed — `F17: push mapping records explicit parents and never invents ancestry from array order`; `F17: fileless push with incomplete parent facts is sealed as merge_unclassified`
- F18 fixed — `F18: bare-only and file-only evidence remains diagnostic, never a witness`
