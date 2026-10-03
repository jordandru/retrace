# Owner-login amendments stage, step 2: a cached capture closure (design note v1)

**Status:** v1 draft, 2026-10-03, by claude-code (coordinator and spec author, `claude-opus-5-5`, harness-runtime). **Not built.**
- **Go.** Jordan's go `evt_be6f7cb96342473baebcc310865ee961` (item 3: "draft the step-2 note"). It came after step 1's success test failed
  (`evt_3a6c63fa7dac47acbecb399866e836ac`).
- **Parent.** `docs/design/owner-login-capture-read.md` v1.6:
  - §0 decision 3: step 2 is option iv, with its own note;
  - §5 item 4: the success test;
  - §7 (iv).
- **The direction was already chosen.** Jordan's decision of 2026-09-30 (`evt_df7212b9526a415baf0bed46687c939d`, option (c)): raise the budget
  to 1,000 ms now, and cache the immutable amendment closure as the follow-up.
- **Class (a)** under agent-rules 12: it puts cached state on a WHO path. Design gate: Codex, Grok and NOOA. The build is class S.
- **Code references** are at main `c9f9e985`, whose code is identical to `07c3276b`, the deployed Worker `48e32f29`.

## 0. Decisions this note asks the gate, and Jordan, to confirm
1. **Step 2 caches derived capture facts, not rows or bodies (§4).**
   - The cache holds, per amendment target, the facts the owner-login decision actually consumes (§3). The facts are kept small enough that
     reading them beats the uncached reads.
   - Scope: the owner-login caller only. The commit-classification path keeps today's reads; it is not live (§3, item 5).
2. **No budget raise (§6 A).**
   - The uncached stage needs about 1.2 s (an inference, §2), inside a 2,000 ms delivery deadline that also carries the earlier stages.
   - Both reads grow with each file's history.
3. **Fill out of band; extend in band (§4.4).**
   - A scheduled job computes each closure with its own budget.
   - A delivery reads the closure and extends it only with events newer than the cached head.
   - A missing, stale or malformed closure falls back to today's reads, so the decision fails closed exactly as now.
4. **Probes P4–P6 (§7) run before the build brief.**
5. **The equality standard is unchanged.** Every decision equals the uncached decision; only `timing` and `classification_ms` may differ.

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
in `~/.retrace/ops-2026-10-03/step2-evidence/` (sha256 prefixes `511a0edf0826ce77` and `fc14ddc1630bb148`).

| read | terms | events | pairs | bodies | body chars | thin-record chars | artifact-id chars |
|---|---|---|---|---|---|---|---|
| `capture_targets` | 22 keys | 530 | 982 | 188 | 756,608 | 339,188 | 131,809 |
| `capture_commits` | 214 prefixes | 476 | 485 | 215 | 808,753 | 353,042 | 132,547 |

- **The offline sizes match production.** `capture_targets`' 756,608 body characters equal the live figure exactly (§1).
- **`capture_commits` has never been observed to finish live.** It returns more: 215 bodies, 808,753 characters.
- **With no deadline,** the replay decides `unresolved / no_declaration`. That is what the delivery would have decided with time; the recorded
  outcome is `unavailable / deadline`.
- **Inference, not measured.** The live rate is about 460–560 ms for 757K characters. At that rate `capture_commits` would take about 500–600 ms,
  and the amendments stage roughly 85 + 85 + 500 + 550 ≈ 1.2 s. With candidates and consumption (about 100–210 and 90 ms), the classification
  needs about 1.5 s. P4 measures the commit read itself.
- **A thin record per seal still carries about 45 % of the volume.** The record holds id, project, seq, action, action_detail, actor, caused_by,
  idempotency_key, tags, artifacts {id, kind, role}, tool, stamp, sha and after_hash. The artifact lists dominate. So shrinking each row (§6 B) does
  not fit on its own.

## 3. What the owner-login decision consumes from the capture reads (code facts at `c9f9e985`)
1. **The owner-login callers use only the effective-amendment set.**
   - `classifyOwnerLogin` reads `amended.collection.effective.keys()` (`owner-login.ts:221`), and so does the status view
     (`owner-login-status.ts:59`).
   - The stage's `captureSeals` output is used only by the commit path (`classify.ts:1068–1125`, the touches).
2. **The capture context needs, per seal key, its minimum seq and its canonical paths** (`classify.ts:379–388`).
   - Per amendment target unit, `previousCaptureTouch(touches, unit, before)` (`classify.ts:412`; `capture.ts:5–9`) uses only touches with
     `seq < before`, and only whether a touch's paths contain that unit.
   - `before` is at most the target's seq (`classify.ts:398`).
   - So for a unit, only a key's seq and whether its paths include that unit matter.
3. **Each seal's first eligible event is joined to the collector's events** (`classify.ts:732–737`).
   - `captureSeals` keeps one event per key, the first in seq order (`capture.ts:94`).
   - That event joins `contextEvents` and the collector's dependency list. Both are maps by id in which a **later entry overwrites an earlier
     value** (`classify.ts:733`; `attribution.ts:149`).
   - In `checkCandidate` those events feed:
     - **the unknown-actor scan** (`attribution.ts:81`): any event before the attempt whose actor equals the amendment's `to` and whose stamp is
       `pinned:`, `assert:` or `webhook:`;
     - **id lookups** of cause, target and evidence (`attribution.ts:33`, `:88`). The evidence match (`attribution.ts:96`) reads actor, stamp,
       artifacts and `generatesArtifact` (action, action_detail and role, `capture.ts:11`).
   - Cause, target and evidence ids are also read as dependencies. Today the same full event wins either way. Once a capture record is not a
     full event, it must never overwrite a dependency's full event (R5).
4. **Eligibility and the veto depend on the boundary, which depends on the delivery.**
   - The boundary is the lowest stamped seq among the base events and the matched events (step 1, R3).
   - The base events are the owner-login candidates, which differ per delivery. An older stamped candidate lowers the boundary and changes which
     legacy unstamped seals are eligible.
   - So the closure stores the inputs to eligibility and to the full-OID veto, not their result.
5. **The commit path is out of scope.** It needs every seal's full paths and `extractSha(event)` for its touches. It is not live: the 14:07Z
   export holds no `claim_decision`. Its budget is `CLASSIFY_DEADLINE_MS` (500 ms). It keeps the uncached reads.

## 4. The design
### 4.1 What is cached: capture facts per amendment target
A closure is keyed by:
- the project;
- the amendment target's event id;
- the policy digest, which covers repositories, aliases, `trusted_hook_stamps` and owner seals;
- a closure-format profile;
- an index epoch (§4.3).

It holds, as of `through_seq`:

| fact | per | fields | consumed by |
|---|---|---|---|
| matched event | every event either read matched | seq, stamped flag | the boundary (§3, item 4) |
| seal candidate | every `committed`/`merged` event either read matched | seq, event id, action, tool, idempotency-key shape, push tag, stamp, commit ref, sha (`method.params.sha` or `change.after_hash`), actor {type, id}, and its canonical paths **∩ the target's units** | eligibility, the veto, keys, the context, and the unknown-actor scan (for the first eligible event per key) |
| read terms | each of the two reads | the target keys, and the commit prefixes derived at `through_seq` | extension (§4.4) |

- **Paths are cut to the target's units,** at most the target's output files (11 for the ledger's one amendment). For owner-login that
  intersection is all §3 item 2 uses. It is the change that makes the closure small.
- **Estimated size:** roughly 400 seal candidates × about 150 characters, plus about 1,000 matched events × about 15. That is around 75K
  characters, against 1.57M today. P5 measures it.

### 4.2 Requirements
- **R1. Same decisions.** For every input, `classifyOwnerLogin` gives the same `effective` set, the same outcome and the same reason with the
  closure as without it. Exceptions: `timing`, `classification_ms`.
- **R2. Recompute, don't cache the per-delivery parts.** These are computed per delivery from the facts plus the delivery's own inputs:
  - the boundary: base events plus the matched facts, preliminary and complete, as in step 1;
  - eligibility;
  - key resolution;
  - the full-OID veto;
  - commit prefixes;
  - touches.
- **R3. Bounded by the read head.** A delivery at read head `U` uses only facts with `seq <= U`. A closure built through a later head is
  filtered, never trusted whole.
- **R4. The extension covers late events for old keys.**
  - A new event can reference an old commit (a late webhook seal, or a re-logged hook seal). It then adds paths to a key whose minimum seq is
    old.
  - So each extension re-reads the cached read terms for `seq in (through_seq, U]`, and merges by key.
  - New preliminary seals produce new commit prefixes. Those are read in full, because their history is not in the closure.
- **R5. Capture records never shadow full events.**
  - A capture record joins the collector's events only where no dependency or candidate has that id. Today's map order lets the later list
    win (§3, item 3).
  - The unknown-actor scan sees the same set of (actor, stamp, seq) triples as today.
- **R6. Fail closed.** A missing closure, a wrong profile, a wrong policy digest, a wrong epoch, a malformed fact, a store error or a deadline
  gives today's uncached path. That path currently ends `unavailable / deadline`. The closure never weakens a decision.
- **R7. Counters keep their meanings.** `rowsRead`, the runner's raw pairs and the owner-login budget are charged for the rows the delivery
  actually reads. Cached facts are not reads, but their count is reported (R8). Whether a read budget should apply to cached facts is a gate
  question, not assumed here.
- **R8. Metrics.** Each closure read records `cache: hit | miss | stale | malformed`, `through_seq`, the size of the extension, and its wall
  time. These go in `timing` (§1 of the parent note's R6).

### 4.3 Invalidation
- **Append is not the only change.** Old index membership changes when a backfill or migration inserts rows for old seqs (the parent note's §7
  (iv) caveat).
  - Every migration or backfill that can add `event_artifact_index` rows bumps an **index epoch** in its own table.
  - A closure with an older epoch is stale (R6).
- **A policy change** changes the digest, so a closure keyed by the old digest is never read.
- **A closure-format or classifier change** bumps the profile.
- **A new amendment** has a new target, and so a new closure, filled at the next scheduled run. Until then the delivery takes the uncached path
  (R6).

### 4.4 Fill and use
- **Fill: scheduled.**
  - It runs after the hourly export-cache refresh, with its own budget (proposed 10 s, a gate question).
  - It computes the closure for every amendment target that `amendmentEventsUpTo(project, head)` returns, through `head`, using the step-1 reads.
  - It writes one row per closure into a new table (`capture_closure`: the key columns, `through_seq`, `facts_json`, `facts_sha256`,
    `computed_at`).
  - It logs nothing to the ledger, because it is derived state. Its outcome goes into the `/status` export-cache style block.
- **Use: the delivery.**
  - One read of the closures for the candidate amendments' targets.
  - Then the R4 extension: at most two reads, small when the closure is fresh.
  - Then R2 in JavaScript.
  - Estimate, an inference: about 90–150 ms for the closure read plus about 180 ms for two small extension reads, against about 1.1 s today.
- **No write-back from the request path** in v1. Extensions are recomputed per delivery until the next scheduled fill.

### 4.5 Trust
- **The closure is derived, unsigned state in D1.** Anyone who can write D1 can alter it and flip an amendment's effect in later owner-login
  seals.
- **Such a write can already alter other tables, but not undetectably.** Every sealed decision is reproducible from the hash-chained ledger
  alone: the offline replay (`owner-login-replay.ts`) recomputes decisions with no cache. That makes cache tampering detectable after the fact.
- **The build must include that replay check** (P6 and §5). A doctor or auditor finding for a decision whose replay differs is proposed as
  follow-up work.

## 5. Proof (required in the build, as in step 1)
- **(a) Fixtures on MemoryEventStore and SqliteStore.** Each asserts the uncached and closure decisions are equal:
  - a fresh closure;
  - a stale closure, extended by R4;
  - a closure built past `U`;
  - a late seal for an old key;
  - a new preliminary seal with a new prefix;
  - a base event that lowers the boundary;
  - an evidence id that is also a capture record (R5);
  - each invalidation in §4.3;
  - a malformed or tampered closure (R6).
- **(b) A workerd test** of the closure read and extension under D1 limits: at most 100 bound parameters, at most 5 compound members, and no
  LIKE or GLOB over 50 bytes.
- **(c) An offline replay.**
  - Over every owner-login decision in a fresh export, per store: decisions with the closure built at several earlier heads equal decisions
    without it.
  - The counts are recorded in the pull request.
- **(d) A success test after deploy.**
  - On the next 6 owner-login deliveries, the closure is read (`hit` or `stale` plus extension), the stage finishes, and `classification_ms` stays
    under `deadline_ms`.
  - Each decision equals the offline replay of the same delivery.

## 6. Alternatives considered
- **A. Raise `OWNER_LOGIN_DEADLINE_MS` again.**
  - The classifier's deadline is `min(now + OWNER_LOGIN_DEADLINE_MS, delivery deadline)` (`owner-login.ts:270`). The delivery deadline is
    `WEBHOOK_DELIVERY_DEADLINE_MS`, 2,000 ms (`router.ts:71`), and it also carries the pre stage: 146–560 ms measured.
  - The uncached stage needs about 1.5 s (§2, an inference), so the margin would be near zero, and the reads grow with history.
  - It would also reverse the 09-30 decision's direction.
  - Not proposed. It stays Jordan's lever if the cache is refused.
- **B. Thin rows: return only the fields consumers use.** About 45 % of today's volume (§2). Not enough on its own, though the closure uses the
  same field list.
- **C. Fold `capture_commits` into `capture_targets`** (the parent's option v). Saves about 90 ms. Not enough.
- **D. Exact owner-qualified keys** (the parent's option iii). Saves about 140 ms of SQL, and must include historical owners. Not enough on its
  own.

## 7. Probes before the build brief (read-only)
- **P4.** Time `capture_commits` on production D1, using the step-1 statement for the current amendment at the live head. It tests §2's 1.2 s
  inference.
- **P5.** Size the closure for the current amendment:
  - offline, from a fresh export;
  - on D1, the read time of one row of that size.
- **P6.** An offline prototype of R2–R5 over every owner-login decision in a fresh export: closure-based decisions against uncached decisions,
  per store. It is scratch code, not a build. Its result decides whether the build brief can promise R1.

## 8. What this note does not claim
- It does not claim the closure fits the budget. The sizes are measured offline (§2); the closure read and extension times are inferences
  until P5 and the success test.
- It does not claim R2–R5 reproduce every decision. §3 is a reading of the code at `c9f9e985`, and P6 and the replay are the proof.
- It does not cover the commit-classification path (§3, item 5).
- **The ledger has one attribution amendment today.** The closure count and the scheduled fill's cost grow with amendments. That is unmeasured.

## 9. Record
| what | event |
|---|---|
| Jordan's decision (option c: budget now, closure as follow-up) | `evt_df7212b9526a415baf0bed46687c939d` |
| Step 1 deployed (Worker `48e32f29`) | `evt_c1b6e064484a4ba3a5e2f474f6b498ec` |
| Step 1 success test failed, threshold met | `evt_3a6c63fa7dac47acbecb399866e836ac` |
| Go for this note | `evt_be6f7cb96342473baebcc310865ee961` |
