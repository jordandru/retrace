# Owner-login amendments stage, step 2: a cached capture closure (design note v2)

**Status:** v2 draft, 2026-10-03, by claude-code (coordinator and spec author). v1 was written by session 27 (`claude-opus-5-5`,
harness-runtime); v2 by session 28 (`claude-fable-5-1`, harness-runtime). **Not built.**
- **Go.** Jordan's go `evt_be6f7cb96342473baebcc310865ee961` (item 3: "draft the step-2 note"). It came after step 1's success test failed
  (`evt_3a6c63fa7dac47acbecb399866e836ac`). The v2 fix round is Jordan's go `evt_c24e9ea03d2a452cb36cabf67c177952`.
- **Parent.** `docs/design/owner-login-capture-read.md` v1.6:
  - §0 decision 3: step 2 is option iv, with its own note;
  - §5 item 4: the success test;
  - §7 (iv).
- **The direction was already chosen.** Jordan's decision of 2026-09-30 (`evt_df7212b9526a415baf0bed46687c939d`, option (c)): raise the budget
  to 1,000 ms now, and cache the immutable amendment closure as the follow-up.
- **Class (a)** under agent-rules 12: it puts cached state on a WHO path. Design gate: Codex, Grok and NOOA. The build is class S.
- **Code references** are at main `c9f9e985`, whose code is identical to `07c3276b`, the deployed Worker `48e32f29`. Main moved to `3354b3ed`
  (PR 159, docs only) while v2 was written; the code is unchanged.

**v2, the fix round for Codex round 1 (`evt_19cad49439a84a5d96d2477856382e91`, rejected with three Medium; NOOA round 1
`evt_9f35f36953d644fe9711bdcec2e6f1c0` approved; Grok held for v2).** What changed:
- **F1, query membership.** v1 cached a matched event as `(seq, stamped)` and a seal as a key plus cut paths. That loses which query term
  matched each row, so a closure filled at a later head could keep a row the delivery's own reads would never have fetched. Codex reproduced it
  on both stores: a closure filled at head 7 and filtered to read head 6 kept a stamped event found only through a seal at seq 7, lowered the
  boundary, and bypassed a full-OID veto that the uncached path raises (`/tmp/pr165-review/repro.mjs`, `evt_2517563f80ca4c26a2d7dd9e9fdd80d4`).
  v2 caches **matched pairs with their query term** (§4.1) and selects, per delivery and per read, exactly the rows its own terms would have
  fetched (§4.4). A closure filled above the delivery's read head is **not used** (R3). Key resolution, the veto and the repository filter are
  recomputed per delivery from raw facts, so `canonicalRepo` needs no place in the key (R2). Union and deduplication across targets are stated
  (§4.4, step 3).
- **F2, the equality oracle and the budgets.** R1 now names its clock: semantic equality is defined under a deterministic, non-expiring clock;
  operational outcomes are tested separately (R1, §5 (a) and (e)). The three evidence counters are charged **exactly as the uncached reads
  would charge them**, from the selected sets, with each store's own matching semantics; a cache hit buys wall time and nothing else, and every
  `budget` outcome is preserved (R7). What the offline replay checks, preserves and cannot reproduce is stated (§4.5), and a replay mismatch
  is classified as semantic or operational (§5 (c)).
- **F3, invalidation.** The epoch contract now covers every insert, update, delete or rebuild of index membership or event bodies, project
  deletion and recreation, and restores; each fill is bound to a ledger anchor (`through_seq`, `through_hash`) and to one coherent epoch read
  before and after its reads; a project's closures are published all-or-nothing in one atomic batch; `capture_closure` and
  `capture_index_epoch` join `deleteProject`'s table set (§4.3, §4.4).
- Codex's remaining notes are applied: individual seal facts are kept before grouping; the own-key minimum seq is kept even when a seal's cut
  paths are empty; cause, target, evidence and traversed causal ancestors stay full events (R5); the policy key is the complete `PolicyDocument`
  digest; `ownerSeals` is noted as a classifier constant; the size estimate is relabelled (§4.1); P4–P6 and the fixtures are respecified (§5, §7).

## 0. Decisions this note asks the gate, and Jordan, to confirm
1. **Step 2 caches derived capture facts, not rows or bodies (§4).**
   - The cache holds, per amendment target, the matched pairs of the two capture reads with the query term that matched each, and the thin
     facts of every event that carried a body (§3). The facts are kept small enough that reading them beats the uncached reads.
   - Scope: the owner-login caller only. The commit-classification path keeps today's reads; it is not live (§3, item 5).
2. **No budget raise (§6 A).**
   - The uncached stage needs about 1.2 s (an inference, §2), inside a 2,000 ms delivery deadline that also carries the earlier stages.
   - Both reads grow with each file's history.
3. **Fill out of band; extend in band (§4.4).**
   - A scheduled job computes every closure of a project at one head, with its own budget, and publishes all of them or none.
   - A delivery reads the closures and extends them only with events newer than the cached head.
   - A missing, stale, mismatched or malformed closure falls back to today's reads, so the decision fails closed exactly as now.
4. **Probes P4–P6 (§7) run before the build brief.**
5. **The equality standard (R1, v2).** Under a deterministic non-expiring clock, every decision equals the uncached decision; the budgets are
   charged identically; only `timing` and `classification_ms` differ. Under a real clock the closure path completes where the uncached path
   deadlines, and never decides anything the uncached path with unlimited time would not.
6. **The counters charge cached facts as reads (R7, v2).** No new allowance comes with a cache hit. v1 left this to the gate; Codex's round-1
   recommendation is adopted.

## 1. Step 1's success test failed (measured)
Step 1 was deployed on 2026-10-03 at 02:18:59Z as Worker `48e32f29` (`evt_c1b6e064484a4ba3a5e2f474f6b498ec`). The first five owner-login
deliveries after it:

| seq | event | kind | capture_targets | capture_commits | outcome |
|---|---|---|---|---|---|
| 11514 | `evt_5db01311…` | push | ok: 534 events, 989 pairs, 756,608 body chars, SQL 180 ms, wall 560 ms | deadline | unavailable / deadline |
| 11546 | `evt_573340a4…` | review | ok: 535 events, 992 pairs, 756,608 chars, SQL 170 ms, wall 556 ms | deadline (34 ms in) | unavailable / deadline |
| 11555 | `evt_4298fbb5…` | review | ok: 535 events, 992 pairs, 756,608 chars, SQL 202 ms, wall 523 ms | deadline | unavailable / deadline |
| 11556 | `evt_fc3cd2ee…` | review | ok: 535 events, 992 pairs, 756,608 chars, SQL 165 ms, wall 461 ms | deadline | unavailable / deadline |
| 11563 | `evt_27a975df…` | merge | ok: 535 events, 992 pairs, 756,608 chars, SQL 178 ms, wall 476 ms | deadline | unavailable / deadline |

- **Before the deploy,** `capture_targets` itself hit the deadline at 584 ms (seq 11360, `evt_6cff5db8…`).
- **After it,** step 1 lets the first capture read finish. The stage still does not fit: every classification ends at `classification_ms`
  1,000 in stage `amendments`.
- **The design's rule is met:** two or more of six failed.
- **The other calls** each took 74–96 ms wall (`amendment_rows`, `dependencies`).

## 2. How big the two reads are (measured offline; sizes only, no timings)
The latest owner-login decision in the 14:07Z export was replayed offline through the step-1 code: seq 11084, read head 11082. Script and output are
in `~/.retrace/ops-2026-10-03/step2-evidence/` (sha256 prefixes `511a0edf0826ce77` and `fc14ddc1630bb148`). Codex reproduced both rows exactly
on the review worktree (round 1).

| read | terms | events | pairs | bodies | body chars | thin-record chars | artifact-id chars |
|---|---|---|---|---|---|---|---|
| `capture_targets` | 22 keys | 530 | 982 | 188 | 756,608 | 339,188 | 131,809 |
| `capture_commits` | 214 prefixes | 476 | 485 | 215 | 808,753 | 353,042 | 132,547 |

- **These are JSON character counts,** not wire bytes and not Worker timings.
- **The offline sizes match production.** `capture_targets`' 756,608 body characters equal the live figure exactly (§1).
- **`capture_commits` has never been observed to finish live.** It returns more: 215 bodies, 808,753 characters.
- **With no deadline,** the replay decides `unresolved / no_declaration`. That is what the delivery would have decided with time; the recorded
  outcome is `unavailable / deadline`.
- **Inference, not measured.** The live rate is about 460–560 ms for 757K characters. At that rate `capture_commits` would take about 500–600 ms,
  and the amendments stage roughly 85 + 85 + 500 + 550 ≈ 1.2 s. With candidates and consumption (about 100–210 and 90 ms), the classification
  needs about 1.5 s. P4 measures the commit read's SQL time; its Worker wall time is known only from the success test (§7).
- **A thin record per seal still carries about 45 % of the volume.** The record holds id, project, seq, action, actor, caused_by,
  idempotency_key, tags, artifacts {id, kind, role}, tool, stamp, sha and after_hash (the measuring script's projection omits `action_detail`;
  it is an illustration, not the closure format). The artifact lists dominate. So shrinking each row (§6 B) does not fit on its own.

## 3. What the owner-login decision consumes from the capture reads (code facts at `c9f9e985`)
1. **The owner-login callers use only the effective-amendment set.**
   - `classifyOwnerLogin` reads `amended.collection.effective.keys()` (`owner-login.ts:221`), and so does the status view
     (`owner-login-status.ts:59`). Both also consume the evaluator's **failure**: `unavailable` with the evaluator's reason (`owner-login.ts:218`,
     `:241–245`). A closure that turned a `budget` or veto failure into a decision would change what these callers see (R1, R7).
   - The stage's `captureSeals` output is used only by the commit path (`classify.ts:1068–1125`, the touches).
2. **The capture context needs, per seal key, its minimum seq and its canonical paths** (`classify.ts:379–388`).
   - Per amendment target unit, `previousCaptureTouch(touches, unit, before)` (`classify.ts:412`; `capture.ts:5–9`) uses only touches with
     `seq < before`, and only whether a touch's paths contain that unit.
   - `before` is the minimum of the target's seq and the seq of the target's **own** commit key (`classify.ts:391–398`). That own-key seq is used
     even when the seal's paths intersect no unit, so every seal's minimum seq is a fact in its own right (Codex, round 1).
   - So for a unit, only a key's seq and whether its paths include that unit matter.
3. **Each seal's first eligible event is joined to the collector's events** (`classify.ts:732–737`).
   - `captureSeals` keeps one event per key, the first in seq order among the **eligible** events (`capture.ts:84–98`). Which event is first
     depends on eligibility, so it depends on the boundary, so it is a per-delivery result (R2).
   - That event joins `contextEvents` and the collector's dependency list. Both are maps by id in which a **later entry overwrites an earlier
     value** (`classify.ts:733`; `attribution.ts:149`).
   - In `checkCandidate` those events feed:
     - **the unknown-actor scan** (`attribution.ts:81`): any event of the project before the attempt whose actor equals the amendment's `to` and
       whose stamp is `pinned:`, `assert:` or `webhook:`. It reads `project`, `seq`, `actor` and `method.params.sealed_by`;
     - **id lookups** of cause, target and evidence (`attribution.ts:33`, `:88`), and the causal-root walk from the cause (`attributionRooted`).
       Each of those is a point-read dependency today, read in full, and so are the traversed causal ancestors.
   - Cause, target and evidence ids are also read as dependencies. Today the same full event wins either way. Once a capture record is not a
     full event, it must never overwrite a dependency's full event (R5).
4. **Eligibility and the veto depend on the boundary, which depends on the delivery.**
   - The boundary is the lowest stamped seq among the base events and the matched events (step 1, R3).
   - The base events are the owner-login candidates, which differ per delivery. An older stamped candidate lowers the boundary and changes which
     legacy unstamped seals are eligible.
   - **The matched set itself depends on the delivery.** The target read's terms are the targets' keys minus the delivery's own covered keys
     (`classify.ts:650`); the commit read's terms are the prefixes of the **preliminary** seals, which the boundary selects (`:655–665`). A row
     found through a term the delivery would not have used is not part of its evidence. That is Codex's F1, and it is why the closure records
     the query term of every matched pair (§4.1).
   - So the closure stores the inputs to eligibility and to the full-OID veto, not their result.
5. **The three evidence counters** (parent note §4 R3, v1.5):
   - the runner's `row_cap` counts distinct raw `(seq, key)` pairs per read, across the read's statements (`store.ts:582–632`, `seenPairs`);
   - the amendments stage adds each read's distinct event count to `rowsRead` and checks `CLASSIFY_ROW_CAP` (20,000; `classify.ts:596–621`);
   - the owner-login budget takes, per read, the returned keys that satisfy its own predicate (`sameArtifact` for keys, `startsWith` for
     prefixes) against the aggregate 2,000-row `OWNER_LOGIN_ROW_CAP` (`owner-login.ts:123–129`).

   Each counts matched events and pairs, not bodies, and the SQL stores and the memory store can disagree on what matches (the first-`#`
   over-match, parent §4 R3). A `budget` outcome from any of the three is a decision the callers see (item 1).
6. **The commit path is out of scope.** It needs every seal's full paths and `extractSha(event)` for its touches. It is not live: the 14:07Z
   export holds no `claim_decision`. Its budget is `CLASSIFY_DEADLINE_MS` (500 ms). It keeps the uncached reads.

## 4. The design
### 4.1 What is cached: capture facts per amendment target, with query membership
A closure is keyed by:
- the project;
- the amendment target's event id;
- the **complete policy digest**: `PolicyDocument.digest` over body and envelope (`policy.ts:210`), the value the classifier already receives as
  `policyDigest`. It covers repositories, aliases, `trusted_hook_stamps`, `unresolved_claims`, `github_repos`, `shared_logins` and
  `identities`. `ownerSeals` is a classifier constant (`classify.ts:344`), covered by the profile;
- a closure-format **profile**, bumped by any change to the closure format, the classifier, the canonicalizer or the capture statements;
- the **index epoch** (§4.3).

It is bound to a **ledger anchor**: `through_seq` and `through_hash`, the seq and hash of the ledger event the fill read as its head.

It holds, as of `through_seq`:

| fact | per | fields | consumed by |
|---|---|---|---|
| **term** | each query term of either read | the term string, and its kind: `key` (a target key) or `prefix` (a commit prefix) | selection (§4.4) |
| **matched pair** | every `(seq, key)` either read returned, once per term that matched it | seq, key, term | selection, the three counters (R7), the boundary (stamped flag on the row) |
| **matched row** | every seq with at least one pair | seq, stamped flag as the runner decided it | the boundary (§3, item 4) |
| **seal fact** | every matched event whose row carried a body: `committed`/`merged`, or an unknown stamp (parent R1) | id, project, seq, action, `method.tool`, whether `idempotency_key` is absent or starts with `git:`, whether `tags` includes `push`, `method.params.sealed_by`, `caused_by`, actor {type, id}, the first `commit:` artifact id (the ref, unresolved), `extractSha(event)` (`method.params.sha` or `change.after_hash`), and its canonical paths **∩ the target's units** | eligibility, key resolution, the veto, prefixes, keys, the context, and the unknown-actor scan (for the first eligible event per key) |

- **Terms are the superset a delivery can need.** The key terms are the target's keys as `amendmentCaptureDependencies` derives them
  (`classify.ts:630–649`): output artifacts, canonicalised, expanded by `artifactKeysForPaths`. The prefix terms are the prefixes of **every**
  seal-shaped matched event whose ref resolves under the policy, expanded by aliases as `classify.ts:657–665` does, whatever the boundary. Any
  boundary selects a subset of those seals, so any delivery's prefix set is a subset of the cached prefixes or needs a full read (R4).
- **Membership is the store's own.** On the SQL stores the fill statement is the capture statement with the lookup term kept in the projection
  (`SELECT DISTINCT i.seq, i.artifact_key, <term>` per member, `store.ts:487–493`), and each lookup term is mapped back to the query keys whose
  `artifactLookup` produced it (`capture.ts:46–56`; two query keys can share one `equals` value). On the memory store the predicate is per
  query term already (`store.ts`, `captureIndexRowsFromEvents`). So a pair's terms are what that store would match for that term, over-matches
  included; nothing is re-derived in JavaScript.
- **Seal facts are kept individually, never grouped.** Grouping by key, the first-eligible rule and the paths union are per delivery (R2).
- **Paths are cut to the target's units,** at most the target's output files (11 for the ledger's one amendment), canonicalised with the keyed
  policy exactly as `classifierLedgerAttributionContext` canonicalises units and touches. The cut is sound for owner-login because a seal that
  touches a unit of another target is matched by that target's own key term, or is a base event of the delivery, and the seals map unions paths
  per key across all of them (`classify.ts:379–388`); the cut is why the closure is small. A seal fact with an empty cut is still kept, for its
  seq (§3, item 2).
- **Encoding.** One JSON document per closure with a term dictionary and a key dictionary; pairs are index pairs; rows and seal facts reference
  seqs. `facts_sha256` over the document guards accidental corruption only (§4.5).
- **Estimated size, an inference until P5.** Codex's literal projection of the v1 seal fields over the §2 replay gave 215 candidates and
  92,986 characters before membership metadata. With dictionaries, the §2 reads (about 1,000 rows, 1,467 pairs, 236 terms, 403 seal facts) come
  to roughly 150–250K characters, against 1.57M today. That is an estimate of a compact encoding, not a measurement; P5 measures the final row,
  and §8 says what follows if it does not fit.

### 4.2 Requirements
- **R1. Same decisions, under a stated clock.** For every input, with `now` fixed and the deadline at infinity (the fixtures' and the replay's
  clock), `classifyOwnerLogin` gives the same record with the closure as without it: the same `effective` set, status, reason, declarations,
  consumed ids, actor written and `budget_rows_remaining`. Exceptions: `timing` and `classification_ms`, and the cache fields R8 adds to
  `timing`. Under a real clock the closure path completes where the uncached path would deadline; it never produces a decision the uncached path
  with unlimited time would not, and when it cannot complete it ends `unavailable / deadline` as today. Deadline and store failures are
  operational outcomes and are tested on their own (§5 (e)); equality is not claimed for them.
- **R2. Recompute, don't cache the per-delivery parts.** These are computed per delivery from the facts plus the delivery's own inputs:
  - the terms actually in play: the targets' keys minus the delivery's covered keys, and the prefixes of the delivery's preliminary seals;
  - the matched sets of each read, by selection on those terms (§4.4);
  - the boundary: base events plus the selected rows, preliminary and complete, as in step 1;
  - eligibility, with the delivery's `canonicalRepo` and policy (`classifierCaptureSeals`: the repository filter at `classify.ts:358`, the
    strict full-OID resolution and the conflicting-resolution veto at `:359–360`);
  - key resolution from the raw ref and sha;
  - the full-OID veto;
  - commit prefixes;
  - the first eligible event per key, the paths union per key, and the touches.
- **R3. Bounded by, and never above, the read head.** A delivery at read head `U` uses a closure only when `through_seq <= U`, and then only
  facts with `seq <= through_seq`; events in `(through_seq, U]` come from the extension (R4). A closure whose `through_seq` is above `U` is
  **not used**: the delivery takes the uncached path. That is Codex's narrower first version, and it is the whole of v2's answer to a closure
  filled past the read head; nothing is filtered down from a later head. (With exact membership a later closure could in principle be filtered
  safely; v2 does not rely on that, and the fixture asserts the fallback.)
- **R4. The extension covers late events and new prefixes.**
  - A new event can reference an old commit (a late webhook seal, or a re-logged hook seal). It then adds paths to a key whose minimum seq is
    old. So each read's extension re-reads the delivery's terms for `seq in (through_seq, U]`, and the rows merge by seq with the selected ones.
  - A prefix the delivery derives that is not among the closure's prefix terms is read in full, `seq in (-1, U]`, because its history is not
    in the closure.
- **R5. Capture records never shadow full events.**
  - A capture record joins the collector's events only where no dependency or candidate has that id. Today's map order lets the later list
    win (§3, item 3). Cause, target, evidence and traversed causal ancestors stay the full point-read events.
  - The record carries exactly the fields §3 item 3 reads (`project`, `seq`, `actor`, `method.params.sealed_by`, `id`, `caused_by`), so the
    unknown-actor scan sees the same set of (actor, stamp, seq) triples as today.
- **R6. Fail closed, and only on operational states.** A missing closure, a wrong profile, a wrong policy digest, a wrong epoch, a ledger-anchor
  mismatch, `through_seq > U`, closures of one project at different heads, a term the selection needs that the closure lacks, a malformed
  document or a `facts_sha256` mismatch, a store error on the closure read, or the deadline, gives today's uncached path. That path currently
  ends `unavailable / deadline`. **A semantic failure is not a fallback:** a `budget` outcome or a full-OID veto computed from the selected facts
  is returned as the uncached path would return it (`unavailable / budget`, `unavailable / store_error`), because that is the same decision; it
  is not retried uncached. The closure never weakens a decision.
- **R7. The counters charge the selected sets exactly (v2).** Per read, the delivery computes from the selected pairs and the extension's rows
  what the uncached read would have produced, and charges it the same way:
  - the runner's cap: distinct `(seq, key)` pairs over the selection plus the extension (and the full reads of R4), against the same `row_cap`;
    `budget` exactly when that count exceeds the cap. The extension and full reads run through the real runner with `row_cap` reduced by the
    pairs already selected, so the trip point is the same; pairs cannot collide across the pieces because their seq ranges and prefix terms are
    disjoint;
  - `rowsRead`: the distinct seqs over the same union, per read;
  - the owner-login budget: the selected keys that satisfy its predicate, with the same `sameArtifact` and `startsWith` tests, taken through the
    same `EvidenceBudget`, plus the extension's rows as the proxy already charges them.

  Cached facts are charged as reads. No new allowance comes with a hit; a closure that represents more evidence than the caps allow yields
  `budget` as today. Each store keeps its own matching semantics because the pairs were recorded by that store (§4.1). Physical I/O is reported
  separately (R8) and never enters a decision.
- **R8. Metrics.** Each closure read records `cache: hit | miss | stale | malformed | above_head`, `through_seq`, the number of selected pairs
  and rows per read, the size of each extension and full read, and wall times. These go in `timing` (§1 of the parent note's R6) and are
  excluded from R1's comparison.
- **R9. Coherent fills.** A fill reads the epoch, the head and every closure of a project in one run, and publishes all of that project's rows in
  one atomic batch or none (§4.4). A partial fill never publishes.

### 4.3 Invalidation (v2)
- **The epoch.** A per-project row `capture_index_epoch(project, epoch, changed_at, reason)`; no row means epoch 0. **Every** maintenance
  operation that inserts, updates, deletes, re-keys or rebuilds `event_artifact_index` rows or `events` bodies at or below the head changes the
  epoch: backfills (`BACKFILL_ARTIFACT_INDEX_SQL`), migrations, repairs, re-keying, remove-only fixes and manual D1 writes. The operation bumps
  the epoch **before its first change and after its last**, so a fill that overlaps either boundary sees the change. A manual operation that
  cannot bump atomically truncates `capture_closure` instead. A well-formed cache under an unchanged epoch after such an operation is the
  failure Codex named; the contract makes it an operator error that the runbook names, not a state the design accepts.
- **The ledger anchor.** Each closure records `through_seq` and `through_hash`. A delivery reads `events.hash` at `through_seq` in the same D1
  batch as the closures and compares; a missing row or a different hash is stale. That catches a ledger restored to a different history, a
  rollback below `through_seq`, and a fill that read a chain the live ledger no longer has. The hash is the chain's, so a matching anchor means
  the fill's head is an event of the live chain; events below it are fixed by the chain.
- **The fill's own coherence** (R9). The fill reads the epoch, then the head, then performs its reads, then reads the epoch again; it publishes
  only if both epoch reads agree, and the publish batch is conditioned in SQL on the epoch still being that value. A fill that observed partial
  membership under a new epoch cannot publish, because the operation's closing bump changes the value it conditions on.
- **Project deletion and recreation.** `capture_closure` and `capture_index_epoch` join the table set `deleteProject` deletes in its guarded
  batch (`apps/worker/src/d1-store.ts:65`). A recreated project starts at epoch 0 with no closures, and its new chain's hashes differ, so an
  old closure that somehow survived could not match an anchor.
- **Restores.** A whole-database restore of one coherent snapshot (events, index, closures and epoch together) stays valid: the anchor and the
  epoch match. A partial restore, or a restore followed by a divergent history, is caught by the anchor on the ledger side; on the index or
  cache side the restore runbook bumps the epoch. That runbook step is part of the build.
- **A policy change** changes the complete digest, so a closure keyed by the old digest is never read. A profile change (format, classifier,
  canonicalizer, capture statements) bumps the profile.
- **A new amendment** has a new target, and so a new closure, filled at the next scheduled run. Until then the delivery takes the uncached path
  (R6).
- **Unsigned D1 writes** remain the explicitly accepted trust limit (§4.5). No epoch prevents them.

### 4.4 Fill and use (v2)
- **Fill: scheduled.**
  - It runs after the hourly export-cache refresh (`apps/worker/src/index.ts:96–142`), with its own bounded budget. v1 proposed 10 s; that is
    unvalidated. The fill processes targets in seq order and stops at its budget; if it cannot finish every target of a project it publishes
    nothing for that project and records `incomplete` (below). The budget and a resume policy for projects with many amendments are measured by
    P5 and set in the build brief, not here.
  - Per project: read the epoch; read the head `H` (`seq`, `hash`); list the targets from `amendmentEventsUpTo(project, H)`; for each target run
    the two capture reads through `H` with the fill statement (§4.1) and `row_cap = CLASSIFY_ROW_CAP`; derive the prefix superset from every
    seal-shaped matched event; run the commit read; build the document. A read that exceeds the cap writes no closure for the project. Read the
    epoch again.
  - Publish: one D1 batch that deletes the project's previous rows and inserts the new ones (`capture_closure`: project, target id, policy digest,
    profile, epoch, `through_seq`, `through_hash`, `facts_json`, `facts_sha256`, `computed_at`), each statement conditioned on the epoch still
    being the value read. All or nothing (R9).
  - It logs nothing to the ledger, because it is derived state. Its outcome per project (`refreshed | unchanged | incomplete | failed`, head,
    error) goes into a `capture_closure_refresh` row in the style of `export_cache_refresh`, and `/status` shows it.
- **Use: the delivery, in order.**
  1. As today: candidates, dependencies and base events (`classify.ts:705–725`), charged as today. The targets' keys and the delivery's
     uncovered keys are computed as today (`:633–647`).
  2. **One D1 batch:** the closures for the candidates' targets (keyed by project, target id, policy digest, profile), the current epoch row, and
     `events.hash` at the closures' `through_seq`. Validate every R6 condition. All closures used in one delivery must share one `through_seq`;
     otherwise the uncached path.
  3. **Target read, by selection.** From each closure, take the pairs whose term is one of the delivery's uncovered keys; union across closures
     and deduplicate by `(seq, key)`, as the uncached single read over the union of keys deduplicates across its statements. Then the extension:
     one `captureIndexRows` call for the uncovered keys over `(through_seq, U]`, with `row_cap` reduced by the selected pairs. Charge R7. The
     preliminary boundary is the minimum over the base events' stamped seqs and the selected and extension rows' stamped flags.
  4. **Preliminary seals.** The pool is the base events, the seal facts of the selected rows (as capture records, R5) and the extension's bodies.
     Apply `classifierCaptureSeals`' rules with the delivery's `canonicalRepo`, policy and preliminary boundary: eligibility, repository filter,
     strict full-OID resolution, the conflicting-resolution veto. A veto is returned as `store_error`, exactly as `classify.ts:656` returns it.
     Derive the prefixes as `:657–665` does.
  5. **Commit read, by selection.** Take, from the closures, the pairs whose term is one of the derived prefixes; deduplicate. Prefixes not among
     the closures' terms: one full `captureIndexRows` call over `(-1, U]`. Cached prefixes: one extension call over `(through_seq, U]`. Each call
     runs with `row_cap` reduced by what the earlier pieces of this read already counted. Charge R7 over the union. The complete boundary adds
     the stamped flags of every row in the union.
  6. **Complete seals, context, collection,** as today (`:670–748`), with capture records only where no dependency or candidate has the id (R5).
  - Cost, an inference: one batched round trip for step 2 (about 85–100 ms, the small-call cost measured in §1) plus the closure bytes, and two
    to three small index calls for the extensions. The closure read dominates and P5 measures it.
- **No write-back from the request path** in v1. Extensions are recomputed per delivery until the next scheduled fill.

### 4.5 Trust (v2)
- **The closure is derived, unsigned state in D1.** Anyone who can write D1 can alter it and flip an amendment's effect in later owner-login
  seals. That writer can already alter `events`, `event_artifact_index` and `owner_login_consumption`; the closure adds one more table to the
  same trust boundary, not a new boundary.
- **`facts_sha256` detects accidental corruption only.** A writer who changes the facts and the hash together is not detected by it, and it
  does not authenticate completeness.
- **Detection is offline replay, with limits.** Every sealed decision can be recomputed from the hash-chained ledger and its policies with no
  cache: `owner-login-replay.ts` rebuilds a memory store from a complete export, re-runs `classifyOwnerLogin` under a fresh 60-second deadline,
  preserves the observed timings and allocation outcomes, and compares the rest of the record (`packages/mcp-server/src/owner-login-replay.ts`).
  - **What it checks:** that a sealed decision's semantic content equals the ledger-only recomputation.
  - **What it cannot reproduce:** an operational outcome. A sealed `unavailable` with reason `deadline` or `store_error` from a failing store
    will not recur under the replay's clock and store; today the replay reports that as a mismatch. Such a mismatch is ordinary and is not
    evidence of corrupted derived state. A **semantic** mismatch is a sealed decision that completed (or failed on `budget`, or on the veto) and
    whose recomputation differs; that is the signal of a tampered closure, or of a bug.
  - **The build adds that classification** to the replay output (§5 (c)), so a reader does not mistake an operational mismatch for tampering
    or a semantic one for noise.
  - It is a detector after the fact, not a live prevention and not a deployed automatic auditor. A doctor or auditor finding for a semantic
    mismatch is proposed as follow-up work.
- **Tamper fixtures** (§5 (a)) distinguish a malformed or hash-invalid closure, which falls back (R6), from a well-formed, self-consistent
  tampered closure, which decides wrongly in band and is detected only by replay. R6 is a promise about the first; against the second this note
  promises detection, not prevention.

## 5. Proof (required in the build, as in step 1)
- **(a) Fixtures on MemoryEventStore and SqliteStore,** each asserting the uncached and closure decisions equal under R1's clock, including
  `budget_rows_remaining` and the three counters:
  - a fresh closure; a stale closure extended by R4; a late seal for an old key; a new preliminary seal with a new prefix (a full read);
  - **the surplus-prefix veto case:** Codex's round-1 reproduction as a fixture, with the closure filled at `H = U + 1`; v2 must take the
    uncached path (R3) and, in a second variant filled at `H = U`, must select by term and raise the veto;
  - base events that lower the boundary, and **the same head with different base events** (two deliveries, two decisions, one closure);
  - multiple targets, and targets in two repositories, with overlapping keys (the union and deduplication of §4.4 step 3);
  - a closure above `U` (fallback), closures of one project at two heads (fallback), a missing term (fallback);
  - **all three budget boundaries,** each tripped by one row in the uncached path and in the closure path alike: the runner's `row_cap`,
    `CLASSIFY_ROW_CAP` and `OWNER_LOGIN_ROW_CAP`;
  - the per-store over-match: a `repo:x#/retrace#a.ts` row that the SQL store counts as a pair and the memory store does not, with the budget
    charged per store as today;
  - an evidence id, a cause id and a traversed causal ancestor that are each also a capture record (R5), and a full dependency whose id is also
    a capture candidate;
  - a missing full OID, conflicting resolutions of one reference, and a seal with an empty cut whose own-key seq sets `before`;
  - each invalidation in §4.3: a policy change, a profile change, an epoch bump by an insert, by a delete, by a rebuild; an epoch bump between
    a fill's reads and its publication (nothing published); an anchor mismatch; a partial fill (nothing published);
  - a malformed closure and a hash-invalid closure (fallback); a well-formed tampered closure (wrong decision in band, caught by (c)).
- **(b) A workerd test** of the closure read batch, the fill statement and the extension under D1 limits: at most 100 bound parameters, at most
  5 compound members, and no LIKE or GLOB over 50 bytes. It also asserts that the fill statement's membership equals the capture statement's
  for every subset of its terms, on fixtures that exercise every member kind (`eq`, `prefix`, `unbounded`, `suffix`).
- **(c) An offline replay.**
  - Over every owner-login decision in a fresh export, per store: decisions with the closure built at several earlier heads equal decisions
    without it, under R1's clock. The counts are recorded in the pull request.
  - The replay tool gains the semantic/operational classification of §4.5, and the replay over the live export reports each mismatch under it.
- **(d) A success test after deploy.**
  - On the next 6 owner-login deliveries, the closure is read (`hit` plus extensions), the stage finishes, and `classification_ms` stays under
    `deadline_ms`.
  - Each decision equals the offline replay of the same delivery under (c)'s classification.
  - This measures rollout behaviour on six deliveries; it is not a proof of R1, which (a)–(c) carry.
- **(e) Operational tests.** A real deadline inside the closure path ends `unavailable / deadline`; a store error on the closure read falls back
  and, if the uncached path then deadlines, ends as today; the fallback never happens on a semantic failure (R6).

## 6. Alternatives considered
- **A. Raise `OWNER_LOGIN_DEADLINE_MS` again.**
  - The classifier's deadline is `min(now + OWNER_LOGIN_DEADLINE_MS, delivery deadline)` (`owner-login.ts:270`). The delivery deadline is
    `WEBHOOK_DELIVERY_DEADLINE_MS`, 2,000 ms (`router.ts:71`), and it also carries the pre stage: 146–560 ms measured.
  - The uncached stage needs about 1.5 s (§2, an inference), so with the pre stage the delivery would use roughly 1.65–2.06 s of its 2 s. The
    margin is near zero or negative, and the reads grow with history.
  - It would also reverse the 09-30 decision's direction. A raise is a temporary lever, not a measured fix.
  - Not proposed. It stays Jordan's lever if the cache is refused.
- **B. Thin rows: return only the fields consumers use.** About 45 % of today's volume (§2). "Not enough on its own" is a hypothesis from the
  character counts; equal counts do not prove equal query, transfer and parse costs. The closure uses the same field list.
- **C. Fold `capture_commits` into `capture_targets`** (the parent's option v). Saves about 90 ms. Not enough.
- **D. Exact owner-qualified keys** (the parent's option iii). Saves about 140 ms of SQL, and must include historical owners. Not enough on its
  own.

## 7. Probes before the build brief (read-only; v2)
- **P4.** Time `capture_commits` on production D1 with the step-1 statement for the current amendment at the live head. The kit
  (`~/step27.sh`, `evt_78070f5d6b0f4e77a78d51939544ac04`) reports SQL time only: an aggregate wrapper keeps the bodies on D1, so it cannot
  measure transfer or parse. Worker wall time for the same statement is known only from a live delivery's `amendments_calls`; for
  `capture_targets` that ratio was 180 ms SQL to 560 ms wall (§1). P4 tests §2's inference about the SQL part; the success test measures the rest.
- **P5.** Size the closure for the current amendment in its **final encoded form**, membership and seal facts included (§4.1), offline from a
  fresh export; then measure on D1 the read time of one row of that size and of the batched step-2 read for all targets. P5 also measures a
  full fill of every target to set the fill budget (§4.4).
- **P6.** An offline prototype of §4.4 over every owner-login decision in a fresh export: closure-based decisions against uncached decisions,
  per store, under R1's clock, with the counters compared. It also runs the adversarial fixtures of §5 (a) as scratch tests: the surplus-prefix
  veto case, changing base events at one head, multiple targets and repositories, closures above and below the read head, the three budget
  boundaries, the per-store over-match, the dependency collisions, the epoch race and removal, the anchor mismatch, and the trust cases. It is
  scratch code, not a build. Its result decides whether the build brief can promise R1.

## 8. What this note does not claim
- It does not claim the closure fits the budget. The sizes are measured offline (§2); the closure's size and read time are inferences until P5,
  and the stage's wall time until the success test. If P5 shows the batched closure read near the budget, the build brief must choose a more
  compact encoding or a smaller fact set before building; a budget raise is not the answer this note proposes.
- It does not claim R2–R7 reproduce every decision. §3 is a reading of the code at `c9f9e985`, and P6 and the replay are the proof.
- It does not claim equality for operational outcomes (R1): a deadline or a failing store is reproduced by neither path.
- It does not claim R6 protects against a D1 writer (§4.5): a well-formed tampered closure decides wrongly until replay finds it.
- It does not cover the commit-classification path (§3, item 6).
- **The ledger has one attribution amendment today.** The closure count and the scheduled fill's cost grow with amendments. That is unmeasured;
  P5 measures a full fill, and the fill's resume policy is a build-brief decision.

## 9. Record
| what | event |
|---|---|
| Jordan's decision (option c: budget now, closure as follow-up) | `evt_df7212b9526a415baf0bed46687c939d` |
| Step 1 deployed (Worker `48e32f29`) | `evt_c1b6e064484a4ba3a5e2f474f6b498ec` |
| Step 1 success test failed, threshold met | `evt_3a6c63fa7dac47acbecb399866e836ac` |
| Go for this note | `evt_be6f7cb96342473baebcc310865ee961` |
| v1 opened as PR 165 at `6da9c3e0` | `evt_9f23fd89` |
| NOOA round 1, approved | `evt_9f35f36953d644fe9711bdcec2e6f1c0` |
| Codex round 1, rejected (F1–F3, Medium) | `evt_19cad49439a84a5d96d2477856382e91` |
| Codex's F1 reproduction | `evt_2517563f80ca4c26a2d7dd9e9fdd80d4` |
| Gate check, round 1 | `evt_2d87f061c0dc4a0d8fe7319a71adb0cc` |
| P4 kit ready | `evt_78070f5d6b0f4e77a78d51939544ac04` |
| Jordan's go for the v2 fix round | `evt_c24e9ea03d2a452cb36cabf67c177952` |
