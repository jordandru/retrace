# Owner-login step 2 — builder brief (the cached capture closure: schema, fill, one logical read, delivery, invalidation, replay, status, doctor)

**Status:** v2, 2026-10-03, by claude-code (coordinator and spec author, `claude-fable-5-1`, model source harness-runtime), on Jordan's
signed go `evt_69acbdf91fdf46ed8a2452429fc12636` ("Go on s2 build brief"); v2 is the fix round on his go `evt_0cf2173b1cdc4c7383dc145b4bdc0ac4`
after Codex round 1 (`evt_0e22d9ebbd8f43b6861d192788033d4a`, PR 168 at `c2b8c270`: F1, F2, F3 Medium; NOOA approved
`evt_36c2b5d87f51409d8533bb0cf2864bc2`; gate check `evt_b24923c365364612905bb5fd8b5ff387`). **Not built.** Builds `docs/design/owner-login-capture-closure.md`
**v3** (merged `fdeb3b1d`, PR 165; cited below as **N§**), whose §7 probes are done: P4 `evt_520a8909cfca46c689bf1c9857d9f66d`,
P5 `evt_2b970cedfc574580bbeedf2e734c70b9` and `evt_294041feee804f13a874c2cb3c9f37ac`, P6 `evt_820b5d8ce8404a69b416396a2906b72c`. The note's
text wins over this brief wherever they differ, **except the extensions this brief lists as its own** (§1.1's table shapes and the refresh
row, §1.3's operation name and placement, §1.4's `failure_origin` placement, §1.5's migrate wrapping, §1.6's mismatch classes, §6's items);
those go in the code pull request's body and the build continues. Any other difference: file the discrepancy on the pull request and stop.

**Gate.** This brief is **class (a)** (it governs behaviour) and takes the design gate: Codex, NOOA, Grok, then the coordinator's
merge-readiness; merge on Jordan's go. The code pull request it specifies is **class S** (`router.ts`, `store.ts`, `d1-store.ts`,
`schema.sql`, `classify.ts`, `owner-login.ts`) **and class (a)** (it adds the maintenance runbook that every index operation must follow),
so the higher gate applies (agent-rules 12): Codex first, NOOA and Grok, then the coordinator's last review. §7 says who sits.

**Evidence the build stands on (measured, §7 of the note):**

| probe | result |
|---|---|
| P4 | `capture_commits` SQL on D1 is 13.6–17.9 ms; `capture_targets` 133–170 ms; the live deadline is bytes to the Worker, not SQL |
| P5 | the v3 closure for the one amendment target encodes to **106,432 characters** on both stores (236 terms, 173 keys, 2,480 pairs, 810 rows, 215 seal facts); a full fill took 0.42 s on SQLite; on D1 a value of that size materialises in 0.6–1.6 ms of SQL and the anchor read in under 1 ms |
| P6 | the §4.4 design, as a store proxy under the unchanged classifier, reproduced the uncached decision and counters for **215 of 215** owner-login decisions on SQLite (stale closure extended), 22 of 22 at an exact-head fill, 215 of 215 above-head fallbacks, and 54 of 54 on a memory sample; every §5 (a) fixture passed on both stores; thin seal records matched full events |

What P6 did not cover, and this build must: the `CLASSIFY_ROW_CAP` trip, the `EvidenceBudget` remaining counter under synthetic trips,
the fill statement's SQL form, workerd and D1 limits, concurrency, and **more than one amendment target** (P6's seal deduplication was
wrong for a seal shared by two targets, Codex round 1 F1; §1.3 fixes the rule).

**v2, the fix round for Codex round 1.** What changed:
- **F1 (Medium), a seal shared by two targets.** The P6 prototype, which v1 made the reference for §1.3, deduplicated seal facts by seq
  (`sealBySeq.set`), so a seal present in two targets' closures kept only the last target's path cut and lost a real previous touch; Codex
  reproduced an amendment accepted that the uncached path rejects. v2 (§1.3, "Selection") requires the **union of a seal's cuts across every
  closure used**, keeping one capture record per seal id; T6 gains the same-repository shared-seal fixture. P6's 215-of-215 result stands only
  because this ledger has one amendment target; the header says so.
- **F2 (Medium), migration order.** v1 seeded `capture_index_epoch` before the migration that creates it. v2 (§1.5) gives `migrate.mjs` a
  **bootstrap phase**: the three tables' DDL first (idempotent), then the epoch rows and `begin`, then the rest of `schema.sql`, then `end`;
  T17 runs first-install, upgrade and rerun orderings on a scratch store.
- **F3 (Medium), the SQLite constructor's backfill.** `SqliteStore` runs `backfillArtifactIndexOnce` on construction
  (`packages/mcp-server/src/sqlite-store.ts:29`, `:33–38`), an index mutation outside the fence. v2 (§1.5) puts it inside the protocol:
  the constructor brackets the backfill with `begin`/`end` for every project it touches, and refuses to backfill while any epoch is odd;
  a reopen fixture (T17) checks that closures filled before the reopen are stale after it.
- **Codex's refinements applied:** the logical read's pieces call the store's raw `captureIndexRows`, never the budget proxy (§1.3); the
  publish guard distinguishes an absent epoch row from an explicit 0 and decides success explicitly, including a zero-closure fill (§1.2);
  document-shape validation is separate from the hash check (§1.4); the thin record carries the encoded eligibility bit (§1.4); T8 reaches
  `CLASSIFY_ROW_CAP` through `evaluateAmendmentsAtU` and the owner budget through `classifyOwnerLogin`; T15's subset oracle runs on a small
  adversarial fixture, not the live term set (§2). §6 records Codex's agreement with all six positions.

## 0. What step 2 is, and is not

Build, in one pull request on a branch from main:

1. **Three tables** and their deletion (§1.1): `capture_closure`, `capture_index_epoch`, `capture_closure_refresh`.
2. **The fill** (§1.2): a scheduled job after the export-cache refresh that computes every closure of a project at one head and publishes
   all or none, under the generation fence.
3. **One logical read** (§1.3): a store-level operation that answers a capture read from closures plus extension and full reads, with the
   caps enforced once on the deduplicated union (N§ R7), wrapped by the owner-login budget like `captureIndexRows`.
4. **The delivery path** (§1.4): `amendmentCaptureDependencies` reads the closures in one batch, validates N§ R6, uses the logical read for
   both capture reads, keeps capture records from shadowing full events (R5), and records R8's metrics and `failure_origin`.
5. **The generation protocol** (§1.5): maintenance helpers, `migrate.mjs` wrapped, and the runbook every index operation follows.
6. **Replay classification** (§1.6): `owner-login-replay` labels each mismatch semantic, operational or unknown.
7. **Status and doctor** (§1.7): a `capture_closure` block on `/status` and a doctor warning.
8. **Tests T1–T20** (§2), the offline replay (§3), and the success test after deploy (§5).

Not in step 2: the commit-classification path (N§3 item 6 keeps the uncached reads); a doctor or auditor finding for a semantic replay
mismatch (N§4.5, follow-up); write-back from the request path (N§4.4); any change to the project policy document; any deploy, migration
or cron change on the live Worker (Jordan's, §5).

**Adoption is a deploy plus the first fill.** Until the first fill publishes, every delivery takes the uncached path exactly as today
(`cache: miss`). Nothing in this PR changes a decision on a ledger with no closure.

## 1. Inputs, in the order the code should be built

### 1.1 Tables (`apps/worker/schema.sql`; core `SCHEMA_SQL` for the SQL stores; `MemoryEventStore`)

All three are `CREATE TABLE IF NOT EXISTS`, so `migrate.mjs` applies them idempotently; the SQLite store applies the same text from core
`SCHEMA_SQL` (`store.ts`, beside `owner_login_consumption`); the memory store keeps equivalent maps. This brief's shapes:

```
capture_closure (project TEXT NOT NULL, target_event_id TEXT NOT NULL, policy_digest TEXT NOT NULL, profile TEXT NOT NULL,
                 epoch INTEGER NOT NULL, through_seq INTEGER NOT NULL, through_hash TEXT NOT NULL,
                 facts_json TEXT NOT NULL, facts_sha256 TEXT NOT NULL, computed_at TEXT NOT NULL,
                 PRIMARY KEY (project, target_event_id, policy_digest, profile))
capture_index_epoch (project TEXT PRIMARY KEY, epoch INTEGER NOT NULL, changed_at TEXT NOT NULL, reason TEXT NOT NULL)
capture_closure_refresh (project TEXT PRIMARY KEY, attempted_at TEXT NOT NULL, result TEXT NOT NULL, head_seq INTEGER,
                         closures INTEGER, fill_ms INTEGER, error TEXT, last_ok_at TEXT)
```

- `profile` is the string `capture-closure/3`; a closure of any other profile is never read (N§4.3).
- No row in `capture_index_epoch` means epoch 0 (N§4.3). `migrate.mjs` inserts a row at 0 for every project that has events before it
  bumps (§1.5).
- `facts_json` is the P5 encoding, verbatim: `{ v: "capture-closure/3", terms: string[], keys: string[], pairs: [seq, keyIdx, termIdx][],
  rows: [seq, stamped01][], seals: [...] }` with the seal tuple `[id, seq, action, tool, ik_git01, push01, sealed_by, caused_by, actor_type,
  actor_id, ref, sha, pathIdx[]]` (N§4.1; `~/.retrace/ops-2026-10-03/step2-probes/p5/p5-fill.mjs` is the reference encoder). `facts_sha256`
  is over the exact `facts_json` bytes.
- **Deletion.** All three join the table list in `deleteProject` (`apps/worker/src/d1-store.ts:65`) and its test; the SQLite and memory
  stores delete the same.

### 1.2 The fill (core `capture-closure.ts`; `apps/worker/src/index.ts` scheduled handler; CLI `retrace-export capture-closure --fill`)

`fillCaptureClosures(store, project, { now, budgetMs, policyAt })` returns `{ action: "refreshed" | "unchanged" | "incomplete" | "dirty" |
"failed", head_seq, closures, fill_ms, error? }` and follows N§4.4 and N§4.3 exactly:

1. Read the epoch. **Odd → return `dirty`, publish nothing.** Record the even value `e`.
2. Read the head `H` (`store.head`). If the project's existing closures are all at `H` under the same policy digest, profile and epoch →
   `unchanged`.
3. Select the policy active at `H` (`getPolicyByActivationSeq`); its complete `digest` keys the closures.
4. `amendmentEventsUpTo(project, H, CLASSIFY_ROW_CAP + 1)`; for each target (in seq order) derive the target keys exactly as
   `amendmentCaptureDependencies` does (`classify.ts:630–649`: output artifacts, canonicalised, `artifactKeysForPaths`; export that helper
   from `classify.ts` rather than duplicating it), the units, and then:
   - **the fill statement** (this brief's position, §6 (b)): on the SQL stores, `captureIndexStatements` gains a `withTerm` mode whose members
     project the lookup term (`SELECT DISTINCT i.seq, i.artifact_key, t.value AS term …`, `store.ts:487–493`) and whose grouped row carries a
     JSON array of `[key, term]` pairs; the runner maps each lookup term back to the query keys whose `artifactLookup` produced it
     (`capture.ts:46–56`), so a pair's query terms are what that store matched. On the memory store the per-term predicate of
     `captureIndexRowsFromEvents` already gives this. Both run with `row_cap = CLASSIFY_ROW_CAP`; a read that trips the cap makes the fill
     `failed` for the project (N§4.4);
   - the prefix superset: every seal-shaped matched event whose ref resolves under the policy, expanded by aliases as `classify.ts:657–665`
     does; then the commit read with the same statement;
   - the seal facts cut to the units (N§4.1), kept individually;
   - the document and its `facts_sha256`.
5. Stop at `budgetMs` (default **10,000 ms**, §6 (a)): if any target is unfinished, return `incomplete` and publish nothing.
6. Read the epoch again; if it is not `e` → `failed` with reason `epoch_moved`, publish nothing.
7. **Publish all or none** in one D1 batch: delete the project's rows and insert the new ones, every statement conditioned in SQL on the
   epoch still being `e`. **The guard distinguishes an absent row from an explicit 0:** when the fill read no row, the condition is
   `NOT EXISTS (SELECT 1 FROM capture_index_epoch WHERE project = ?)`; when it read `e`, the condition is `(SELECT epoch FROM
   capture_index_epoch WHERE project = ?) = ?` (never a single `IS NULL` comparison for both cases). The batch is atomic (D1 `batch`; SQLite
   a transaction). **Success is decided explicitly**, as `deleteProject` decides it (`d1-store.ts`, the `auditLanded` guard): the batch
   includes a guard write whose `changes` count says whether the condition held; zero deleted rows alone never means the epoch moved, and a
   project with zero closures publishes an empty set the same way. If the guard did not land, `failed` with `epoch_moved`.
8. Write the `capture_closure_refresh` row (`last_ok_at` moves on `refreshed` or `unchanged` only; a failed write is logged and never throws
   out of the cron chain), like `recordExportCacheRefreshResults` (`apps/worker/src/export-cache-refresh.ts`).

The scheduled handler (`apps/worker/src/index.ts:96–142`) runs it per allow-listed project **after** `refreshExportCache`, inside the same
`waitUntil` chain, with its own try/catch. The CLI gets `retrace-export capture-closure --fill [--project p] [--budget-ms n]` for the local
store and tests. The fill logs nothing to the ledger (N§4.4).

### 1.3 One logical read (core `capture-closure.ts`; `EventStore`; `owner-login.ts` `EvidenceBudget`)

A new optional store method `captureReadWithClosure?(q: ArtifactIndexQuery, closure: ClosureSet, now, metrics): Promise<CaptureIndexResult>`
with one shared implementation `runClosureCaptureRead` that every store calls with its own `captureIndexRows` for the physical pieces. It is
the §4.4 algorithm as P6 ran it (`~/.retrace/ops-2026-10-03/step2-probes/p6/p6-prototype.mjs`, `closureProxy`):

- **Selection:** pairs whose term is one of `q.artifact_keys` (as `key:` terms) or `q.artifact_prefixes` present in the closure (as `prefix:`
  terms), with `seq <= q.through_seq`; rows by seq with the closure's stamped flag; seal facts as **capture records** (§1.4). **A seal that
  appears in more than one closure used by the delivery is one record whose paths are the union of its cuts across those closures** (each
  closure cut the paths to its own target's units; the delivery needs every unit of every candidate target). Never keep only one closure's
  cut (Codex round 1 F1; T6).
- **Pieces at the original caps** (N§ R7): the extension over `(through_seq, q.through_seq]` for the cached terms, and one full read over
  `(-1, q.through_seq]` for prefixes the closure lacks, each a call on the **store's raw `captureIndexRows`**, never on the budget-wrapped
  proxy (a piece routed through `EvidenceBudget` would be charged twice), with `q.row_cap` and `q.deadline` unchanged. A piece that returns
  `budget`, `deadline` or `store_error` ends the logical read with that reason.
- **Union and dedup** by `(seq, key)` and by seq; **`budget` iff the deduplicated pairs exceed `q.row_cap`**; rows sorted by seq, each with
  its merged keys, stamped flag, and the event (a piece's full event when it returned one, else the capture record).
- A key term the closure lacks is not a fallback here: the caller (§1.4) decides before calling.
- **`EvidenceBudget.wrap`** (`owner-login.ts:75–130`) gains a branch for `captureReadWithClosure` identical to the `captureIndexRows` branch
  (`:123–129`): the zero-remaining precondition once before, `row_cap` and `deadline` clamped once, `take()` of the returned rows' keys that
  satisfy the predicate once after success, nothing on failure. That is R7's "debit once at the same success point".

### 1.4 The delivery path (core `classify.ts` `amendmentCaptureDependencies`, `:595–672`)

- **One batched closure fetch** before the target read: a new store method `captureClosures?(project, targetIds, throughSeqs?)` that returns,
  in one D1 batch (one round trip), the closure rows for the candidates' targets, the project's epoch row, and `events.hash` at each distinct
  `through_seq`. It is measured as a new `amendments_calls` entry named `capture_closure` (`measure`, `classify.ts:593`).
- **Validation, every N§ R6 condition**, in this order, each producing a `cache` value for R8: no row → `miss`; profile not
  `capture-closure/3` → `malformed`; policy digest ≠ the delivery's → `stale`; epoch odd → `dirty`; epoch ≠ a closure's → `stale`; closures
  at different `through_seq` → `stale`; `through_seq > U` → `above_head`; anchor hash ≠ `events.hash` at `through_seq` → `stale`;
  `facts_sha256` ≠ sha256 of `facts_json` → `malformed`; **the document fails shape validation** (version string, array shapes, index
  bounds, integer seqs, stamped flags in {0, 1}, the seal tuple's arity and types) → `malformed`, checked separately from and after the
  hash, because a matching hash proves integrity, not shape; a target key the closures lack → `malformed`. Any of these: today's uncached path for
  both reads, unchanged. Otherwise `hit`, and both reads go through §1.3 with the delivery's own terms (`uncovered` keys, then the
  preliminary seals' prefixes). The boundary, eligibility, veto and prefixes are computed as today over the returned rows (N§ R2).
- **R5, capture records never shadow full events.** A capture record is the thin event of N§4.1 (`id`, `project`, `seq`, `action`, `actor`
  {type, id}, `caused_by`, the `commit:` artifact and the unioned cut paths as artifacts, `method.tool`, `method.params.sealed_by` and
  `.sha`, `tags` push, and the encoded eligibility bit: `ik_git01 = 0` reconstructs a non-`git:` `idempotency_key` so `captureSealEligible`'s
  shape test fails as it would on the full event, as P6's `thinEvent` does). Change the two map constructions so a full event always wins: `classify.ts:733` builds `contextEvents` from
  `[...captureEvents, ...dependencies.events, ...candidates]`, and the call at `:737` passes `[...captureEvents, ...dependencies.events]`
  (later entries overwrite earlier ones in both maps, `attribution.ts:149`). T9 asserts the order.
- **R8 metrics** on the `amendments_calls` entries (`owner-login-record.ts`, `OwnerLoginAmendmentsCallTiming`): `cache`, `through_seq`,
  `selected_pairs`, `selected_rows`, `extension_rows`, `full_read_rows`, and the wall time the entries already carry.
- **`failure_origin`** (this brief's placement): `timing.failure_origin?: "veto" | "budget" | "store" | "deadline"` on the decision record
  (`owner-login-record.ts:49–63`), set when `stage_failed` is `amendments`: `veto` when `classifierCaptureSeals` returned `ok: false`
  (`classify.ts:656`, `:671`), `budget` and `deadline` from the reason, `store` for a store failure. `timing` is excluded from the replay
  comparison already (`owner-login-replay.ts`, `preserved`), so adding a field changes no sealed-record comparison.

### 1.5 The generation protocol (core `capture-closure.ts`; `apps/worker/migrate.mjs`; `docs/runbooks/capture-index-maintenance.md`)

- Helpers on the stores: `beginIndexMaintenance(project, reason)` moves an even epoch `e` to `e + 1` in one statement conditioned on
  `epoch % 2 = 0` and **throws if the epoch is already odd**; `endIndexMaintenance(project)` moves `e + 1` to `e + 2`, conditioned on odd.
  Both write `changed_at` and `reason`.
- **`migrate.mjs`** runs in **three phases** (Codex round 1 F2): (1) **bootstrap**: the three tables' `CREATE TABLE IF NOT EXISTS`
  statements of §1.1, idempotent, so they exist on a fresh database and on the current one; (2) **seed and begin**: insert an epoch row at 0
  for every project in `events` (`INSERT OR IGNORE … SELECT DISTINCT project, 0 FROM events`; on a fresh database `events` is created in
  phase 1's DDL set too, or the seed is skipped when it does not exist) and run `begin` for every project, because the `INSERT OR IGNORE`
  backfill in `schema.sql` inserts index rows at or below the head and so every migrate is maintenance; (3) the rest of `schema.sql`, then
  `end` for every project. A migrate that stops midway leaves the epoch odd, the intended fail-closed state until the operator finishes and
  runs `end`. T17 runs the three orderings a real deployment meets: a fresh database, the current production schema, and a rerun.
- **`SqliteStore`'s automatic backfill joins the protocol** (Codex round 1 F3). The constructor calls `backfillArtifactIndexOnce`
  (`packages/mcp-server/src/sqlite-store.ts:29`, body `:33–38`), which runs `BACKFILL_ARTIFACT_INDEX_SQL` whenever events exist and the
  index is empty: an index mutation at an unchanged epoch, so a local store reopened after a fenced index removal would restore membership
  under closures that still validate. The constructor therefore **brackets the backfill with `begin` and `end` for every project it
  touches**, in the same transaction as the backfill, and **refuses to backfill while any project's epoch is odd** (it throws with the
  runbook's instruction instead of mutating). The memory store has no persistent index and needs nothing. T17 covers the reopen.
- **The runbook** `docs/runbooks/capture-index-maintenance.md` (class a): one operation at a time; `begin` before the first change to
  `event_artifact_index` or `events` bodies at or below the head, `end` after the last; what to do when `begin` refuses (an operation is in
  progress or was abandoned: finish or roll it back, then `end`); restores run the protocol (N§4.3); manual D1 writes outside it are the
  stated trust limit; the CLI exposes `retrace-export capture-closure --begin-maintenance|--end-maintenance --reason …` for the local store
  and documents the D1 statements for the Worker.

### 1.6 Replay classification (`packages/mcp-server/src/owner-login-replay.ts`; `export-cli.ts`)

Each mismatch result gains `mismatch_class`: `semantic` when the sealed decision completed, or failed with `failure_origin` `budget` or
`veto`; `operational` when the sealed decision is `unavailable` with `failure_origin` `store` or `deadline`; `unknown` when the sealed
decision is `unavailable` and carries no `failure_origin` (historical records: never inferred from the `store_error` reason, N§4.5). The
CLI's summary prints the three counts. A `semantic` mismatch is the signal of a tampered closure or a bug (N§4.5); the tool reports, it does
not decide.

### 1.7 Status and doctor (core `status.ts`, `router.ts`; `packages/mcp-server/src/doctor.ts`)

- `GET /projects/:p/status` gains `capture_closure` when the router has the tables: `{ epoch, epoch_state: "committed" | "maintenance",
  closures, through_seq, last_refresh?: { attempted_at, result, head_seq, closures, fill_ms, error? } }`, supplied through router options like
  `export_cache` (`router.ts:980`; `status.ts:85`, `:247`). The rendered line is one `capture closure: …` line that never carries the free-text
  `error` and never contains `VERIFIED`, `BROKEN`, `fetch failed` or `timed out` (NOOA's audit reads the text; see the step-1 brief §1.6).
- Doctor: a `warn` named `capture-closure` when `epoch_state` is `maintenance`, when `last_refresh.result` is `failed` or `incomplete`, or
  when the closures' `through_seq` is more than 7,200 s behind the live head by `last_refresh.attempted_at`; patterned on
  `exportCacheFindingsFromStatus` (`doctor.ts:897`); a Worker without the field is skipped.

## 2. Tests — every test lands, each named in a `test(...)` title with its id

| id | where | assertion |
|---|---|---|
| T1 | `capture-closure.test.ts`, both stores | fresh closure at `H = U`: decision and the three counters equal the uncached run under R1's clock (`now` fixed, deadline infinite); `budget_rows_remaining` equal |
| T2 | same | stale closure (`H < U`) extended by the logical read: equal; `extension_rows` > 0 |
| T3 | same | a late webhook seal naming an old commit with a new path, and a new commit with a new prefix, after the fill: equal; one full read |
| T4 | same | the surplus-prefix veto (Codex's PR 165 r1 fixture, eight events): uncached `store_error`; closure at `H = U + 1` → `above_head`, uncached path, `store_error`; closure at `H = U` → selection by term, `store_error`; `failure_origin: veto` |
| T5 | same | two deliveries at one head with different base events: each equals its uncached run |
| T6 | same | two targets in two repositories with an alias, overlapping keys, and a covered key: equal (the union and dedup of N§4.4 step 3); and **Codex's shared-seal fixture**: one owner-stamped seal touching `a.ts` and `b.ts`, two targets in the same repository (one per path), one amendment per target citing the earlier evidence: uncached rejects both as `uncorroborated`, and the closure path must too (a single-closure cut would accept one) |
| T7 | same | every R6 condition from §1.4, one at a time: `cache` names it, the uncached path runs, the decision equals uncached |
| T8 | same | the three budget boundaries, each tripped by one row in the uncached path and the closure path alike: the runner's `row_cap` on the extension; `CLASSIFY_ROW_CAP` through `evaluateAmendmentsAtU` directly (no owner budget, cumulative base rows and reads so the stage's remaining allowance is what trips); `OWNER_LOGIN_ROW_CAP` through `classifyOwnerLogin`; and Codex's PR 165 r2 cases: exact-cap empty tail (succeeds), failed logical read (remaining counter equal), overlapping alias prefixes `app` / `app@aaaaaaa` (counted once) |
| T9 | same | an evidence id, a cause id and a traversed ancestor that are each also a capture record: the full event wins in both maps; a full dependency whose id is also a capture candidate |
| T10 | same | a seal with an empty cut whose own-key seq sets `before`; a missing full OID; conflicting resolutions of one reference |
| T11 | same | per-store over-match: `repo:x#/retrace#a.ts` against key `repo:retrace#a.ts` counts one pair on SQLite and none in memory; each store equals its own uncached run |
| T12 | same | the generation fence: a fill wholly inside maintenance publishes nothing (`dirty`); a fill that straddles the opening move fails with `epoch_moved`; a delivery reading an odd epoch takes the uncached path; closures under `e` are stale after `e + 2`; `begin` refuses when odd; `end` refuses when even |
| T13 | same | anchor mismatch (a rolled-back ledger), hash-invalid closure, policy-digest mismatch, mixed heads, missing term: uncached path, equal |
| T14 | same | a well-formed tampered closure (stamped flag flipped, hash recomputed) decides differently in band and is reported `semantic` by the replay of §1.6; a hash-invalid tamper falls back |
| T15 | `d1-store.workerd.test.ts` | the closure batch fetch, the fill statement and the extension under D1 limits: ≤ 100 bound parameters, ≤ 5 compound members, no LIKE or GLOB over 50 bytes; the fill statement's membership equals the capture statement's for every subset of the terms of a **small adversarial fixture** (overlapping and shared lookup terms; `eq`, `prefix`, `unbounded` and `suffix` members), not the live 236-term input |
| T16 | `d1-store.workerd.test.ts` | the publish batch is atomic and conditioned: a changed epoch leaves the previous rows; `deleteProject` removes all three tables' rows |
| T17 | `capture-closure.test.ts`, `sqlite-store.test.ts` | the three-phase migrate on a fresh database, on the current production schema and as a rerun (bootstrap, seed and begin, schema, end; each ends even); an abandoned operation leaves the epoch odd and the fill `dirty`; **reopen**: fill at an even epoch, remove the index rows under `begin`/`end`, close and reopen the store: the constructor's backfill runs bracketed, the epoch moves, and the earlier closures are `stale`; reopening while an epoch is odd throws and mutates nothing |
| T18 | `export-cli.test.ts` | the replay's `mismatch_class` on fixtures: a sealed `unavailable/deadline` → `operational`; a sealed completed decision whose recomputation differs → `semantic`; a historical `unavailable/store_error` without a marker → `unknown` |
| T19 | `router.test.ts`, `doctor.test.ts` | the `capture_closure` status block in each state; the rendered line's forbidden words; the doctor warning in each condition; an older Worker skipped |
| T20 | `capture-closure.test.ts` | operational: a real deadline inside the logical read ends `unavailable/deadline` with `failure_origin: deadline`; a store error on the closure fetch falls back; a `budget` or veto outcome is never retried uncached |

Baseline counts are taken at main `28c7e854` in the builder's worktree before the first change and reported with the head's. Run with the
scratch environment inline (agent-ops 10), `rm -rf apps/worker/.test-dist` before the worker suite (#161).

## 3. Acceptance, in order

1. `npm run build`, then the full suite with the scratch environment inline; doctor READY in the builder's worktree before every commit.
2. **The offline replay** (N§5 (c)): `retrace-export owner-login --recompute` over a fresh export with closures filled at three earlier
   heads and at the head, per store, every decision equal under R1's clock; the counts (decisions, equal, `mismatch_class` totals) go in the
   pull request body. P6's `p6-prototype.mjs` is the reference; the PR runs the built code, not the prototype.
3. The pull request body states: class S and (a) and why; every T id with its file; the baseline and head test counts; the worker
   typecheck; the fill statement's measured membership equality (T15); the `migrate.mjs` wrapping; the deploy steps for Jordan in order
   (`npm run migrate` creates the tables and epoch rows and ends at an even epoch; deploy; the first `:07` fill; `/status`
   `capture_closure`; then the success test); the rollback note (a rollback keeps today's uncached path: the tables are inert without the
   code); any discrepancy with the note.
4. Commits carry the builder seat's trailers in one final paragraph; every changed file is logged as an edit before its commit.

## 4. What the builder must not do

- No `wrangler`, no deploy, no migration or cron change on the live Worker, no D1 command, no change to any project policy document.
- No change to the export bundle, its signature, `owner_login_consumption`, the owner-login decision table, `declarationPinned`, or the
  commit-classification path.
- No Task sub-agents on other models; scratch environment inline on every test or script run; `git commit --only`; never read, print or
  copy a credential file or token.
- Never weaken a decision: every new failure path ends in today's uncached path or in today's `unavailable` reason (N§ R6).
- Never build or test in the primary checkout.

## 5. Sequencing and the success test

Merge on the gate (Jordan's go) → `npm run migrate` by Jordan (tables, epoch rows at 0, then the bump cycle; the run must end at an even
epoch) → deploy (its own go, version read back) → the first `:07` fill → `/status` shows `capture_closure` with `closures: 1` for `retrace`
→ **the success test** (N§5 (d)): on the next 6 owner-login deliveries, `cache: hit` or a stale hit with an extension, the stage finishes,
`classification_ms` under `deadline_ms`, and each decision equals the offline replay of the same delivery under §1.6's classification.
P5's inference for the closure read (about 140–160 ms wall against about 1.1 s today) is checked against the live `amendments_calls`
entries then, and the result goes on the note as a dated correction. If 2 or more of the 6 miss, the question goes back to Jordan.

## 6. Open items the gate should settle (each with the coordinator's position)

Codex round 1 agreed with each position below (`evt_0e22d9eb`), with riders applied in v2: (a) is a wall-time bound, not a CPU proof;
(b) subject to T15; (c) read the anchors from the fetched closures' heads in SQL; (d) Codex builds and does not review its own code; (e)
markerless `unavailable` records classify as `unknown`; (f) includes F3's local automatic path.

- **(a) The fill budget.** Position: 10,000 ms with `incomplete` on overrun (P5 measured 0.42 s per target offline; the Worker's cron
  has a 30 s CPU budget shared with the export refresh). Resume policy for many targets is deferred until a second amendment exists.
- **(b) The fill statement.** Position: the `withTerm` member projection (one round trip per read) rather than P5's per-term reads
  (236 round trips); T15 proves membership equality against the delivery statement on both SQL stores.
- **(c) The closure fetch.** Position: one D1 batch carrying the rows, the epoch and the anchor hashes, measured as one call.
- **(d) The builder.** Position: **Codex** (`gpt-6-astra`, high), bounded and specified as PR 15, 21 and 23 were, in a fresh built worktree,
  with **Grok as first reviewer** and NOOA, then the coordinator; team-roles 1: when Codex builds, Grok or NOOA is the reviewer of record.
  The alternative is github-copilot after B2 lands. Jordan may reassign.
- **(e) `failure_origin` in `timing`.** Position: yes; `timing` is already outside the replay comparison, so no sealed record changes meaning.
- **(f) Store parity.** Position: the SQLite and memory stores implement the tables, the fill and the logical read too, so the suite and the
  CLI's local ledger exercise the same code; only the scheduled trigger is Worker-only.

## 7. Roles

| seat | role on the step-2 pull request |
|---|---|
| Codex (`gpt-6-astra`) | builder (§6 (d)); own worktree; no review of its own work |
| Grok (xAI) | first review of the code PR, class S first pass high; measurer for the success test |
| NOOA (Nemotron 3 Ultra, pinned) | design-gate seat for the class (a) part (the runbook) and the packet |
| claude-code | author of this brief (merge-readiness only on it); last review of the code PR; gate check; merge on Jordan's go |
| Jordan | goes for the brief's merge, the build dispatch, the code merge, migrate, deploy, the success test |

## 8. Record

| what | event |
|---|---|
| Note v3 merged (`fdeb3b1d`, PR 165) | hook `evt_196f508cf78e406c9309a8a2384d7506`, outcome `evt_3935be694a60407c9bc67841b7ec2972` |
| P4 read | `evt_520a8909cfca46c689bf1c9857d9f66d` |
| P5 offline and kit; D1 result | `evt_2b970cedfc574580bbeedf2e734c70b9`; `evt_294041feee804f13a874c2cb3c9f37ac` |
| P6 result | `evt_820b5d8ce8404a69b416396a2906b72c` |
| Go for this brief | `evt_69acbdf91fdf46ed8a2452429fc12636` |
| v1 as PR 168 at `c2b8c270` | hook `evt_7aa1007c676c4899b84e6f3f6375d3da`, outcome `evt_a428e43741f24d62994db5eede8e87a3` |
| Codex round 1: rejected (F1, F2, F3 Medium) | `evt_0e22d9ebbd8f43b6861d192788033d4a` |
| NOOA round 1: approved | `evt_36c2b5d87f51409d8533bb0cf2864bc2` |
| Gate check round 1 | `evt_b24923c365364612905bb5fd8b5ff387` |
| Go for the v2 fix round | `evt_0cf2173b1cdc4c7383dc145b4bdc0ac4` |
