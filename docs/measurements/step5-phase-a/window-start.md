# Step 5 Phase A — window start (shadow live)

**Recorded:** 2026-09-15 04:41Z by claude-code (coordinator). Class (b) measurement; governs nothing.

## The start marker

- Shadow policy live: Worker `retrace-api` version `55aadd8f-aee0-4fdf-9c6e-996edaac1fcc`, deployed from
  main `6818bd9acb8416753a1a2a5970e067c9128392f3` (PR 34 classifier-in-shadow + PR 35 routing fields),
  D1 migrated (`evt_b7da45e76c784293b2f52ede36b0004f`), deployed (`evt_108a5f88a6f54d1382e6fa49c020333c`),
  `RETRACE_TRAILER_POLICY=shadow` set as a Worker secret (`evt_851b623e15ad4535a9abb4e1d10fac66`).
  **The window opens at that last event.** One Worker serves both projects, so the policy covers
  `retrace` and `boxing-rpg` together.
- Activation is proven only by a sealed commit carrying `method.params.claim_decision`; none had been
  observed when this note was written (rule 0). The first such seal is to be cited here by a dated
  addition.

## Window-start census (live `GET /projects/:p/status`, unmodified JSON beside this note)

| Project | Phase 0 baseline (2026-09-12 03:51Z) | Window start (2026-09-15 04:41Z) | Δ |
| --- | --- | --- | --- |
| retrace — events | 3,532 | 4,386 | +854 |
| retrace — causal coverage | 98.2 % | 98.2 % | 0 |
| retrace — unlinked commits | 41 | 53 | +12 |
| boxing-rpg — events | 137 | 185 | +48 |
| boxing-rpg — causal coverage | 19.0 % | 32.9 % | +13.9 pts |
| boxing-rpg — unlinked commits | 83 | 94 | +11 |

Reading: boxing-rpg's coverage rose between baseline and window start because the fixed MCP credential
let its agents log edits over the weekend; the shadow window measures **new** seals from here, not that
history (Phase 0 instrument doc §2). The retrace unlinked count grew with the checkpoint-bot and
merge traffic of 09-14/15 and is the baseline the window's `unlinked` numbers compare against.

## What comes next (the brief, `docs/design/step5-phase-a-measurement-brief.md`)

Histogram of `would_write` dispositions over the window → by-hand review of every `conflicting` case →
cost profile (labelled census / bench / proxy per row) → the step 6 decision. The instrument is
`scripts/phase-a-measure.mjs --since 2026-09-15T04:41:00Z` over an export bundle, never the live API in a
loop. Jordan's live boxing-rpg work during the window is the second-project evidence Grok's assessment
asked for.

## Addition 2026-09-15 04:53Z — window PAUSED (policy reverted to off)

The first commit attempted under shadow was this note's own commit `5b358464`; it was not sealed until after the revert. Both the hook's attempt
(04:42:51Z) and a replay (04:43:57Z) returned `503 classification_unavailable / deadline`; the webhook
copy went to `pending_deliveries` (attempt 0, outcome pending/deadline); `classification_breakers`
recorded one failure; `classification_contexts` stayed empty. Root cause by code read: the amendment
evaluation on the classifier's hot path loads every event of the project (`store.all`, 4,386 events on
retrace) inside the 500 ms budget (`packages/core/src/classify.ts` ~396–406). Finding
`evt_e39d2f8ebea240f89bb74c3cd3e0042a`. On Jordan's go the policy was set back to `off`
(`evt_f9d8587309f9435cb817c3a77236feb4`) and the parked hook seal replayed (`evt_0eeedcb808154bef8c5a3c58836574b7`).
Shadow was live 12 minutes; one commit attempted; zero classifications completed; zero seals lost.
**Activation is therefore NOT proven**: no seal carrying `claim_decision` exists. The window restarts on
a redeploy with a bounded amendment query; the census above stays the "before" for that restart, and a
second start marker will be added here with its date.

## Second start marker 2026-09-15 19:09:30Z — window RESTARTED (shadow live on the bounded classifier)

- The P1 (`evt_e39d2f8ebea240f89bb74c3cd3e0042a`) is fixed by PR #51 "Bound classifier amendment scan",
  merged as `bba3757db1aa7e81c9665b09e932eaf00606b54e` (merge go `evt_945d08b2c0c548268a4cb9f03e092304`;
  gate of record `evt_0c55d1fdd25145238a841a9fc27ce676`): amendment candidates come from
  `amendmentEventsUpTo` on the new D1 index `idx_events_amendment_candidates`, witness and capture windows
  from `eventsReferencingArtifacts` (`json_each`-driven UNION members, `DISTINCT`, batched under workerd's
  limits), dependencies by point reads; a store without the bounded methods fails closed. No `store.all()`
  remains on the classify hot path.
- Deploy order as three separate go's: D1 migrated (`evt_95a7fd6b9c0547fe8d39bf6f1758ed81`; index present
  in `sqlite_master` before and after), Worker `retrace-api` version `66dcc89a-a453-4b97-a0b2-3084d255f83e`
  deployed from `bba3757` (`evt_6070bf10349249e19c3fdad3a41245c6`; root 200, fresh export chain ok over
  4,804 events), then `RETRACE_TRAILER_POLICY=shadow` set as a Worker secret, producing version
  `4c290ab1-0e4d-44bd-a0b0-1d72867a34f5` at 19:09:30.766Z (`evt_e31755ee9821423fb9412d90bbe53a2a`).
  **The window reopens at that secret-change event.** Project policy document present (digest
  `97dc14693483c1d78ee885a8c45219757668e6a0987ba0c28583132b9abc910e`). One Worker still serves `retrace`
  and `boxing-rpg` together.
- The census in this note's first section remains the "before" for this restart; no new census is taken.
- **Activation is not yet proven at the time of writing** (rule 0): the ledger holds zero seals carrying
  `method.params.claim_decision` between the first window's revert and this marker. This note's own commit
  is the first commit attempted under the restarted shadow; its outcome (a seal with `claim_decision`, or a
  parked seal with an `unavailable` reason) is to be cited here by a dated addition, as before.

## Addition 2026-09-15 19:21:48Z — window PAUSED a second time (policy reverted to off)

This note's own commit `4416d2d0` was the first attempted under the restarted shadow. The hook's attempt
(19:12:55Z) returned `503 classification_unavailable / store_error`, the seal was parked in
`retrace-pending-seal`, and no classification completed. Not the deadline: the recorded probes of PR #51's
bounded reads against production D1 took 4 ms (amendment candidates) and 7 ms (the artifact-index
statement for this commit's keys) — observations supporting this diagnosis, not a latency guarantee — and
the index and the policy document are present. Root cause, reproduced locally against the exported
ledger and the production policy body (finding `evt_2a4dfb78f2744e8fa86bbbd670fafaf0`): the round-4
strict full-OID resolution in `classifierCaptureSeals` (`packages/core/src/classify.ts` ~319) is applied
to every `committed`/`merged` event naming a canonical-repo commit in the read set, including events the
seal filter would never accept as a seal. The live ledger holds one — `evt_728c78b0091940c687f96b07b1f0bc89`
(seq 2753, an MCP-logged 2026-09-09 correction for the trailer-less merge `9c3156b`, a 7-character
reference and no `sha`) — inside the artifact window of amendment #2543's target, so every classification
on `retrace` fails closed. Ten review rounds missed it because every test ledger is synthetic. On Jordan's
go (`evt_e12e96bef5c4473ca632eb6804ba0e1c`) the policy was set back to `off` (Worker version
`4fc02b5b-2f8c-4299-aa86-07354f7e64a5`, `evt_ecf9c31031cf41eba9ddd10927b60dfa`) and the parked seal
replayed (`evt_8ce84cf1f7454e1da3f5bf9ef35f1a9d`). Shadow was live 12 minutes (19:09:30Z–19:21:48Z); one
commit attempted; zero classifications completed; zero seals lost. **Activation remains NOT proven.** The
window restarts on a redeploy in which the strict resolution applies only to seal-eligible events; the
census above stays the "before"; a third start marker will be added here with its date.

## Third start marker 2026-09-15 21:08:49Z — window RESTARTED (PR #56 fix deployed)

- The second pause's cause (`evt_2a4dfb78`: strict full-OID resolution vetoing on non-seal commit references)
  is fixed by PR #56, merged as `97a6a27badc9` (`evt_2cb82595`; Codex `evt_6190db98`, cursor-agent last seat
  `evt_a824fcbf`), with PR #55 recording the second start and pause (`2cf7988fdde0`, `evt_a334d2cf`).
- No schema change this time. Worker `retrace-api` version `8fc6b82a-3534-4726-a141-82ee33c1002b` deployed from
  main `2cf7988` (`evt_45b0bf77`; root 200, fresh export chain ok over 4,873 events), then
  `RETRACE_TRAILER_POLICY=shadow` set as a Worker secret, producing version
  `d995c8f5-4609-453a-9ec5-b8ccc0a47114` at 21:08:49.492Z (`evt_ad3c735b`). **The window reopens at that
  secret-change event.** The census in the first section remains the "before".
- **Activation is not yet proven at the time of writing** (rule 0). This note's own commit is the first attempted
  under the third start; its outcome (a seal carrying `method.params.claim_decision`, or a parked seal with an
  `unavailable` reason) is to be cited here by a dated addition, as before.

## Addition 2026-09-15 21:10:45Z — window PAUSED a third time (policy reverted to off)

*Recorded 2026-09-16 06:40Z, after the cause was found. The delay is itself part of the record: the third
window was paused within two minutes, but the reason was not known for another two hours.*

This note's own commit `ce9c4eb` was the first attempted under the third start. The hook's attempt
(21:10:13.950Z) returned `503 classification_unavailable / store_error`, the seal was parked in
`retrace-pending-seal`, and no classification completed — `classification_contexts` stayed at zero rows.
On Jordan's pre-authorisation (`evt_181aa0a7`) the policy was set back to `off` (Worker version
`6a284ec6-003c-4391-934d-1dac67f528da` at 21:10:45.464Z, `evt_db0d7e0a583f43ee902d23de29bd6564`) and the
parked seal replayed (`evt_eaf5da16cd3040538ae98c26413d49b1`). **Shadow was live 21:08:49.492Z–21:10:45.464Z,
one minute fifty-six seconds** — the first two windows ran twelve minutes each; this one was cut short
because the failure was immediate and identical. One commit attempted; zero classifications completed; zero
seals lost. **Activation remains NOT proven**: no seal carrying `method.params.claim_decision` exists.

**Root cause — and this one was not the fix that preceded it.** The first finding
(`evt_ea9631238e5040068c5eae82a115e810`) established only that the deployed bundle *did* carry the PR #56
fix, that every D1 query run directly against production succeeded in single-digit milliseconds, and that
the Worker discarded whatever actually failed. The cause was confirmed later
(triage `evt_a942f8e2d47b4f55ae703e065189f74b`; investigation `evt_b49d53e5cfeb42caa84cca64c55a6868`;
independent Miniflare reproduction with a real D1 binding, `evt_a2cffab4199344ec99045e89dee9098d`):

> **workerd sets `SQLITE_LIMIT_LIKE_PATTERN_LENGTH` to 50 bytes**, where ordinary SQLite defaults it to
> 50,000. The project policy gives `jordandru/retrace` the bare alias `retrace`, so `artifactLookup`
> (`packages/core/src/capture.ts:51`) takes its GLOB branch and builds `repo:*/retrace#<path>`;
> `eventsReferencingArtifactsStatements` (`store.ts:376`, member SQL `:387`) applies it as
> `i.artifact_key GLOB json_extract(t.value, '$[2]')` — the pattern travels inside a bound JSON value, not
> as a literal `GLOB ?`; `D1Store.eventsReferencingArtifacts` (`apps/worker/src/d1-store.ts:137-142`)
> executes it; D1 throws `LIKE or GLOB pattern too complex: SQLITE_ERROR`; the bare catch in
> `runArtifactIndexStatements` (`store.ts:443-445`) discards the error and returns `store_error`;
> `classify.ts:954` renders that as `unavailable` and `router.ts:843-847` answers 503.

For this commit the pattern was `repo:*/retrace#docs/measurements/step5-phase-a/window-start.md` — **62
bytes**. `repo:*/retrace#` is 15 bytes, so any path longer than 35 bytes throws on that first read. A
boundary probe in the same workerd build the repo already tests against confirms 50 bytes succeeds and 51
throws. Because this is the *first* artifact-index read, nothing ever reached the context insert.

**Why *every* seal parked, not only long-path ones** — and this is not the prevalence of long paths. At
this HEAD only **78 of 192** tracked paths exceed 35 bytes, so path length alone cannot explain a
short-path commit failing. The accepted triage (`evt_a942f8e2d47b4f55ae703e065189f74b`) gives the actual
reason: the classifier's *subsequent* amendment-target read expands to alias globs of up to **59 bytes**
for the target of amendment `evt_51c4a8ad` (seq 2543), which is over the cap regardless of the committed
path. A long-path commit like this one therefore fails on the first artifact-index statement; a short-path
commit survives that and fails on the later one. Same defect, different query.

**Why three windows failed before this was visible.** `MemoryEventStore` matches in JavaScript
(`mem-store.ts:69-71`) and never evaluates a SQL GLOB, so every local reproduction returned `kind=decision`
on the same seal, the same export and the same policy. The local SQLite store cannot show it either, at a
50,000-byte limit. And the workerd test written specifically to catch workerd-only limits could not reach
the cap: `store.ts:315-321` accounts for exactly two workerd limits — 100 bound parameters and
`SQLITE_LIMIT_COMPOUND_SELECT=5` — and the test's fixtures top out at 24-byte alias globs.

**A hypothesis, recorded as it resolved.** Jordan's stated hypothesis was that ~15 sequential D1 round
trips exhausted the 500 ms budget. **Disconfirmed as the cause**: the failure reproduces identically at a
20-second deadline, and the failing query returns in ~38 ms. The thing that throws is the SQL error, not
the timer. His related prediction is nevertheless **confirmed as a separate real defect** — `classify.ts`
collapses a **rejected** `Error("deadline")` into `store_error` at the amendment-candidate catch and at
the outer catch. The qualifier matters: an ordinary explicit deadline check already returns `deadline`
correctly, so only an overrun that surfaces as a rejected promise at those two catches is mislabelled —
and that one would have been indistinguishable from this fault in the logs.
That is issue **#62**, unfixed.

**A second latent instance of the same class, live today with the policy off.** `likeContains`
(`store.ts:106-108`) wraps a history text search as `%needle%` with no length bound, so any
`retrace_history` text search whose escaped UTF-8 pattern exceeds 50 bytes throws the same D1 error. That
is issue **#53**, which this incident explains; the real threshold is the escaped pattern's byte length,
not a flat 48 characters, and `%`, `_` and `!` each expand to two bytes.

**What the fourth start requires.** A fix to the alias lookup that binds no LIKE or GLOB pattern on the
classify path. That fix is in review as PR **#60** and is **not merged and not deployed** at the time of
writing, so nothing here should be read as saying the defect is closed (rule 0). PR **#57**
(classify-path diagnostics) is the instrument this incident argues for — the discarded SQL error text at
that bare catch is precisely why the cause was invisible across three live windows — and its gate is
closed, unmerged, held. The census in the first section remains the "before" for any restart; a fourth
start marker will be added here with its date, as before.
