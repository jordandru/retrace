# The webhook as witness, not second author — one authoritative record per commit (design note v1.1)

**Status:** v1.1, 2026-10-12, by claude-code (the "system optimization" pane; `claude-mythos-5-1`, model source
harness-runtime, effort high). **v1.1 is the fix round for Codex's round-1 verdict `evt_ba3081460461418b8cb2c5d6389bcc51`
(3 High, 3 Medium, 1 Low at `9878437e`), on the coordinator's verified pointer `evt_b624313f…`; what changed, and the two
claims withdrawn, are listed in §13.** **It proposes no code in this PR**: a design note, class **(a)** under agent-rules 12,
for the design gate. Written on Jordan's signed go `evt_c83cad7552a149a5940b27a0bcc84b0b` ("Let's go on your top 3 items starting
with 1", received `evt_85ad930c…`), item 3 of `~/.retrace/ops-2026-10-11/system-optimization/OPTIMIZATION-PLAN.md` (sha256
`499d1ee9…3527`, created `evt_71b02714…`). Items 1 and 2 are PRs 222 and 225. The measurements it rests on are
`FINDINGS.md` M1 and M2 of the same pane (read 2026-10-11 20:48–21:05Z); each number below names its source.

## 0. The question and the proposed answer

**Question.** Every commit on main leaves two or three full records in the ledger: the git hook's seal, the GitHub push
webhook's record of the same commit, and for a merge the PR-merge webhook record. Agent-rules 5 wants two producers on
one sha so that a missing or forged hook seal is detectable. Does the second producer have to be a second *author* of the
same facts, or can it be a *witness* to the first record, and what would that change in what the ledger says?

**Proposed answer, for Jordan to decide after the gate:**

- **A1. The push webhook writes a witness record when an eligible hook seal for that sha already exists at delivery**, and a
  full record (today's behaviour) only when it does not. Eligible means the seal meets reconcile's trusted-hook boundary
  (§3: the policy-pinned hook stamp by equality, a verified producer signature, a git-shaped event, the same project, the
  full sha). The witness names the seal's event id and the sha, carries GitHub's own facts (ref, pusher, delivery id,
  ingress time and the ledger sequence at ingress), carries **GitHub's observed values of the compared fields as
  collision-resistant digests with completeness metadata** (message, file list, parents, author, trailer actor), the
  field-by-field comparison with the seal, and a verdict `matches` | `conflict` | `incomplete`; on `conflict` it keeps
  GitHub's observed value of every differing field verbatim, so both sides stay inspectable. It is sealed by
  `webhook:github` like today; it is still a second producer; it is not a second copy.
- **A2. The PR-merge record records a derived causal candidate, outside `caused_by`, when the PR body carries no full
  token**: the hook's `merged` seal of the merge commit if it exists at delivery, else the hook seal of the PR head, in
  `method.params.derived_cause` with its source, and the seal cited as an artifact. `caused_by` is populated only from a
  full token in the PR body, as today, because every consumer walks `caused_by` as assertion (§4). The record stays (it
  is the only place GitHub's `merged_by` login and the owner-login decision are recorded).
- **A3. The push mapper names merges**: a pushed commit with two parents is `merged`, not `committed`
  (`packages/core/src/github.ts`, the push branch: `action: "committed"` unconditionally today; Grok's class table found
  7 of 11 `human_merge_no_trailer` seals are push records of merges stored as `committed`).
- **A4. `status` counts commits and records separately.** Today `capture.commits` is the number of `committed`/`merged`
  *events* (`packages/core/src/status.ts:133`), 1,662 at 20:48Z, while the ledger holds 836 distinct shas; "180 unlinked
  commits" is 180 records of 164 commits. Both numbers stay reported; the words change to match them.
- **A5. Nothing already sealed is rewritten.** The 116 PR-merge records with empty `caused_by`, the 31 checkpoint-bot
  records and the rest of the 180 are history; what to attest is Jordan's call (§8). This note changes what the next
  records say, not what the past ones said.
- **A6. The known merge gap stays known.** Reconcile does not evaluate file coverage on merge commits (agent-rules 3); a
  witness on a merge commit witnesses the seal, not the merge's content. This note does not close that gap and says so.

## 1. Evidence

| measured (FINDINGS.md M1/M2, `runs/analyze-m1.out`) | value |
|---|---|
| commit records / distinct commit shas in the ledger (20:50Z pull, 17,523 events) | 1,649 / 836 |
| producer combinations over all shas | hook+push 494; hook only 155; hook+push+PR-merge 117; **push only 34**; hook+pinned merge-record+push+PR-merge 25; push+PR-merge 4; other 7 |
| last 200 commits on main: records / per commit | 474 / 2.37 (135 with 2, 50 with 3, 13 with 4, 2 with 1) |
| bytes per record (mean): hook / push / PR-merge | 3,659 / 3,257 / 2,909; 9,668 per commit |
| hook+push pairs with byte-identical `raw_message` | 198 of 198; 180,342 duplicated bytes in 200 commits |
| root state of the 474 records | 398 rooted, 73 unlinked, 3 broken; **PR-merge records 4 of 62 rooted**; hook 190/198; push 190/200 |
| unlinked seals by class (Grok, 180 seals, 164 commits) | PR-merge no trailer 116; checkpoint bot 31; coordinator-receipt roots 13; human merges no trailer 11 (4 hook `merged` + 7 push `committed`); human commits 3; PR-body short id 3 (= 3 of the 4 broken links); agent commits no trailer 2; unstamped 1 |
| PR-merge records with `owner_login_decision: unavailable:deadline` | 52 of 116 (2026-10: 49 of 53) |
| `causedByFrom` regex | `/Retrace-Caused-By:\s*(evt_[a-f0-9]+)/i` (`github.ts:54`): an 8-hex prefix is captured and sealed as a dangling link; **PR 223 (open at `d25b889d`, fix round 5 in flight at the time of v1.1) carries the 32-hex fix and one shared caused-by parser for the hook and the webhook** |

The push record is the capture of record for 38 commits (34 push-only + 4 push+PR-merge) where the hook did not seal:
that is the fallback the second producer exists for, and A1 keeps it.

## 2. The records today, and what each one is for

| record | producer | sealed_by | carries | unique to it |
|---|---|---|---|---|
| hook seal (`committed` / `merged`) | `retrace-git` post-commit / post-merge, producer-signed | `assert:git hook (assert)`, verdict `verified` | sha, parents, files, insertions/deletions, `raw_message`, author, trailers → actor, model, `caused_by`; `claim_decision` (trailer-consistency §6) | the only record signed by the seat's producer key; the only one that can be rooted at commit time |
| push record (`committed`) | `POST /hooks/github` push | `webhook:github`, verdict `none` | sha, ref, pusher, `raw_message` (same bytes), files, author, parents (when complete), trailers → actor; `claim_decision` from the webhook side | the only record proving the sha reached GitHub (ref, pusher, delivery id) |
| PR-merge record (`merged`) | `POST /hooks/github` pull_request closed | `webhook:github`, verdict `none` | PR number, head sha, merge sha, `merged_by` login, `owner_login_decision`, additions/deletions; `caused_by` only from a body token | the only record of who pressed merge at GitHub and of the owner-login decision |

What agent-rules 5 needs from the second producer is **agreement on the sha and on what was committed**; what it gets
today is a second copy of every field, which a reader compares by eye, and a second causal chain that is empty whenever
the PR body carried no token, which is every PR-merge record but 4 of 62 on recent main.

## 3. The witness record (A1)

Written by the push path of `POST /hooks/github` (trailer-consistency §5.3) **instead of** the full push record, when an
eligible hook seal for the sha is found at delivery. Finding candidates is one indexed read, `eventsReferencingArtifacts`
on `commit:<repo>@<sha12>` restricted to `committed`/`merged` records (the same index the classifier already reads; the
2,000 ms delivery deadline applies, and a read that misses the deadline falls to the pending row like any other, §5.3).

**Eligibility is reconcile's trusted-hook boundary, not a prefix of `sealed_by`** (Codex r1 H3). A candidate is the seal
the witness may name only when every one of these holds; otherwise the push takes the fallback path as if no seal existed:

1. `sealed_by` is **exactly one of the policy-pinned hook stamps** for this project — the stored policy's
   `trusted_hook_stamps` / `repositories[].hook_sealed_by`, the same set `reconcile.ts` (`isHookSeal`, `hookStamps.has`)
   and `producer-sig.ts` (`trustedStampKind`, "equality only — no substring, no case folding") consult. Nothing is trusted
   by class: another `assert:` credential (a Drive forwarder, a backfill token), a `pinned:` agent credential, `owner`, or
   an unstamped record is not a hook seal here, whatever shape it has. A project whose policy pins no hook stamp has no
   eligible seal and every push is a fallback capture; the note says so rather than guessing a stamp.
2. `producer_sig_verdict` is `verified`.
3. The record is git-shaped as reconcile requires: `method.tool: git`, idempotency key absent or `git:`-prefixed,
   `action` `committed` or `merged`.
4. Same project as the delivery's resolved project.
5. **Full-sha equality**: the 40-hex sha the seal records equals the pushed commit's sha. The 12-hex artifact id is only
   the index key; it never decides.
6. **Exists at delivery, by sequence** (Codex r1 M1): the seal's `seq` is ≤ the ledger head sequence the Worker read at
   ingress (`ingress_seq`, §3 below). A seal that landed after ingress is not "present at delivery", even when the
   delivery is drained from the pending row later.

```
{
  action: "other", action_detail: "commit-witness",
  actor: <as today: resolveCommitActor from the pushed commit's trailers>,
  artifacts: [
    { id: "commit:<repo>@<sha12>", kind: "commit", role: "used" },
    { id: "event:<hook seal id>", kind: "event", label: "hook seal witnessed", role: "used" }
  ],
  caused_by: "<hook seal id>",                      // the witness descends from the seal it witnesses
  method: { tool: "github", automated: true, params: {
    producer: "github-push", witness_of: "<hook seal id>", witness_of_seq: <seal seq>, sha, ref, pusher, delivery,
    ingress_at, ingress_seq,                          // the ledger head sequence read at ingress (M1)
    eligibility: { stamp: "<the pinned stamp matched>", producer_sig: "verified", shape: "git", project: "<project>" },
    observed: {                                     // GitHub's side, recomputable by anyone holding the payload
      message_sha256, message_bytes,                // sha256 of the exact message bytes GitHub delivered
      files_sha256, files_count, files_complete,    // sha256 over the sorted path list; complete=false when truncated
      parents, parents_complete,                    // the full parent shas GitHub delivered
      author: { name, email },
      trailer_actor                                 // the Retrace-Actor the webhook side parsed, or null
    },
    sealed: {                                       // the seal's side, the same digests over the seal's stored fields
      message_sha256, files_sha256, files_count, parents, author: { name, email }, trailer_actor
    },
    comparison: {                                   // field by field; unknown = one side incomplete or absent
      message: "match" | "differ",
      files: "match" | "differ" | "unknown",
      parents: "match" | "differ" | "unknown",
      author: "match" | "differ",
      trailer_actor: "match" | "differ" | "unknown"
    },
    verdict: "matches" | "conflict" | "incomplete", // matches = every field match; conflict = any differ; else incomplete
    differing: {                                    // present only on conflict: GitHub's verbatim value of each
      message?: "<raw message>", files?: [ ... ], parents?: [ ... ], author?: {...}, trailer_actor?: "<actor>"
    },
    sealed_by: "webhook:github", producer_sig_verdict: "none"
  }},
  idempotency_key: "gh:push:<repo>:<sha>",          // unchanged: a redelivery dedups against whichever record exists
  tags: ["github", "push", "witness"]
}
```

- **Not a commit record.** `status`, reconcile and the doctor count `committed`/`merged`; a witness is `other`. So the
  sha is counted once, by its seal, and the witness is evidence about the seal.
- **What the witness keeps, and what it does not** (Codex r1 H1). It keeps GitHub's observed values as sha256 digests
  over exact bytes (message) and canonical lists (sorted paths; parent shas in order), with the counts and completeness
  flags that say whether the digest covers the whole value, and it keeps the seal's digests computed the same way, so a
  reader recomputes either side from the stored seal or from GitHub's API and checks the comparison instead of trusting
  it. On `conflict` it also keeps GitHub's verbatim value of each differing field, so both sides of a disagreement are in
  the ledger. What it does **not** keep in the quiet case is GitHub's verbatim copy of a message or file list that matched
  the seal's: that copy is the second byte-identical `raw_message` §1 measured, and the seal has it. `unknown` on any
  field (a truncated file list, `parents_complete: false`, no trailer actor parsed on one side) makes the verdict
  `incomplete`, never `matches`.
- **Rooted by construction** when the seal is rooted: `caused_by` is the seal. This is a direct relation, not an
  inference: the witness exists because the seal was found. A witness never creates a new unlinked chain, which is what
  58 of the 73 unlinked records on recent main are (PR-merge, §1) — the push half of that class (the 7 push records of
  human merges) disappears forward; the PR-merge half is A2, which records a candidate and does not root the record (§4).
- **The comparison is the check** agent-rules 5 describes, made explicit and sealed, instead of two records a reader
  diffs. `conflict` is a doctor finding (§6) and a reconcile finding; `incomplete` is a doctor warning; `matches` is the
  quiet case.
- **Exists at delivery is a sequence, not a clock** (Codex r1 M1). At ingress the Worker reads the ledger head sequence and
  stores it on the pending row as `ingress_seq` next to `received_at` (`PendingDelivery`, `store.ts`; today the row has
  no sequence). The indexed read for the seal is bounded `through_seq = ingress_seq`, whether it runs at delivery or when
  the drain (`drainPendingGithubDeliveries`, `router.ts`) remaps the row later. A hook seal with `seq > ingress_seq` was
  not present at delivery: the push is a fallback capture and the later seal is a second full record, as today. Without
  the snapshot a seal landing between ingress and drain would turn required fallback evidence into a quiet witness.
- **Fallback unchanged.** No eligible seal at or before `ingress_seq` → the full push record exactly as today, with one
  added param `fallback_capture: true` and, when a candidate existed but failed eligibility, `fallback_reason` naming the
  failed condition (stamp, signature, shape, project, sha, sequence) and the candidate's id, so a reader knows why the
  hook's record was not trusted. If the hook's seal arrives later, that sha has two full records, as today; the drain does
  not convert them (a conversion would rewrite nothing, but it would add a third record for the quiet case, and §1 shows
  the hook normally lands first).
- **Bytes (estimate from §1 means):** a `matches` witness is ~1.6–2.0 KB against a 3,257-byte push record (the digests,
  counts and eligibility block add ~0.6 KB to v1's estimate); ~2.5 KB per commit, about a quarter of the 9,668 bytes a
  commit leaves today, and the duplicated `raw_message` disappears from the quiet case. A `conflict` witness is larger by
  the differing values it keeps; that is the case worth the bytes.

## 4. The PR-merge record's `caused_by` (A2) and the short-id token

Today `caused_by` is whatever `causedByFrom(pr.body)` captures, else empty. **v1 proposed copying the merge seal's or the
head seal's `caused_by` into the record, labelled `caused_by_source: merge_seal | head_seal`. v1.1 withdraws that** (Codex
r1 H2): `causalRootState` (`packages/core/src/causality.ts`) and the doctor's `instructRootFinding`
(`packages/mcp-server/src/doctor.ts`) walk `caused_by` and stop at a human `instructed` event without reading any label;
`caused_by_source` is read only by the classifier (`classify.ts`, `causedBySourceOf`) to say where a hook commit's link
came from. A derived link in `caused_by` would therefore make the outward record of a **merge** read as rooted in an
instruction the merger never cited, and agent-rules 14 makes merge an outward action that waits for its own explicit go —
inferred ancestry must not satisfy that. The choice here is **option 1: keep derived candidates outside `caused_by`**,
rather than introducing an inference-aware causal type that every consumer would have to honour first; the second option
is larger than this note and would have to land before, not with, A2.

Proposed, each outcome labelled in `method.params.caused_by_source`:

1. `body`: a full `evt_` + 32-hex token in the PR body (today's path, with the regex fixed to 32 hex **by PR 223**, which
   also gives the hook and the webhook one caused-by parser; a shorter token is recorded as `caused_by_rejected:
   "<token>"` and **not** used — the 3 broken links of 2026-09-30, 2026-10-08 and 2026-10-11 are that regex capturing
   `evt_dd964d92`, `evt_57b9aa95`, `evt_052a3936`). This is the only path that populates `caused_by`.
2. `none`, with a candidate: `caused_by` stays empty, and the record carries `method.params.derived_cause: { source:
   "merge_seal" | "head_seal", event: "<seal id>", root: "<the seal's caused_by, if any>" }` and cites the seal as an
   artifact (`event:<seal id>`, label `causal candidate, not asserted`). The seal is found at delivery under §3's
   eligibility and sequence rules; `merge_seal` (the hook's `merged` seal of `merge_commit_sha`) is preferred over
   `head_seal` (the hook seal of the PR head).
3. `none`, no candidate: as today, empty, and the record says so.

The record keeps its actor (`system/github:jordandru` or the identity-mapped seat, owner-login design), its
`owner_login_decision` and its GitHub facts. What changes is that a reader of the merge record can **open** the seal the
webhook found and see where it roots, while `status`, reconcile and the doctor go on counting the record as unlinked
until the merger cites the token in the PR body. The forward fix for the 116-record class (§8) is therefore the merger's
token, not A2; A2 makes the candidate inspectable and nothing more. The label stays the difference between "the merger
said" and "the webhook found", and the field placement is what keeps every existing reader from mistaking one for the
other.

## 5. `status` (A4) and reconcile

- `capture.commits` → `capture.commit_records` (what it counts today, `status.ts`: the `committed`/`merged` events)
  **and** a new `capture.commits` = distinct shas among those records. `unlinked_commits` splits into **three** counts,
  defined separately (Codex r1 M2): `unlinked_commit_records`, the records that are neither rooted nor attested (today's
  180, the per-record count `status.ts` makes now); `commits_with_unlinked_record`, distinct shas with at least one such
  record (164 today: the audit's distinct-sha collapse of the 180 is exactly this count and nothing more); and
  `unlinked_commits`, distinct shas **none** of whose records is rooted or attested — **to be measured**: the audit did
  not derive it, and deduplicating the 180 rows does not establish that each sha lacks a rooted sibling (a sha whose push
  record is unlinked while its hook seal is rooted counts in the second number and not the third). The doctor prints all
  three for one release so the readings sit side by side; docs that cite the headline cite `unlinked_commits` once it is
  measured, and `commits_with_unlinked_record` until then, by that name.
- `capture.witnesses: { matches, conflict, fallback_captures }` reports A1's outcomes.
- Reconcile: the `missing_commit` branch (`reconcile.ts:362–372`) already treats a webhook-merged head as "made where no
  hook runs"; a `commit-witness` with `verdict: conflict` becomes a reconcile finding `witness_conflict` (fail) naming the
  fields that differ; `matches` adds nothing. The merge branch is untouched (A6).

## 6. Doctor

- `commit witness` finding on `--gate`: FAIL when the HEAD sha's witness says `conflict`; **PASS only when it says
  `matches`, which by §3 means every compared field is `match`**; WARN, never PASS, when it says `incomplete` (a field was
  `unknown` on one side), naming the fields, with D6 deciding whether that becomes FAIL; PASS also when the only record is
  a fallback capture (the hook was absent or ineligible; today's "HEAD delivery" finding already names that, and
  `fallback_reason` says why).
- The existing "HEAD delivery" check (`headDelivery`) accepts a hook seal **or** a push record today; after A1 it accepts
  a hook seal with or without a witness, or a fallback capture. Nothing becomes weaker: a sha with no record of any kind
  still fails.

## 7. What it costs and what it risks

- **Provenance.** v1 said "no field is lost"; v1.1 says exactly what is kept (Codex r1 H1). Per quietly-committed sha the
  ledger keeps: the seal's full fields; GitHub's facts (ref, pusher, delivery, ingress time and sequence); GitHub's observed
  values of the compared fields as digests with counts and completeness flags, and the seal's digests computed the same
  way; the comparison and the verdict. On `conflict` it also keeps GitHub's verbatim value of every differing field. What
  is **not** kept in the quiet case is GitHub's verbatim copy of a message or file list that matched the seal's — the
  byte-identical second copy §1 measured; a reader who wants GitHub's text recomputes the digest from the seal, or from
  GitHub's API, and checks it against `observed`. The fallback keeps today's full record when no eligible seal was present
  at delivery. Two producers remain on every quietly-committed sha (seal + witness). What is removed is the matching copy
  and the second empty chain.
- **A dependency the push path does not have today**: one indexed read per pushed commit before deciding witness or
  fallback. It runs inside the existing 2,000 ms budget and the pending-row path; a deadline there yields the same 202
  and drain as today (PR 219). Measured cost unknown until built; the acceptance test in §9 measures it.
- **Trailer-consistency §6 (`claim_decision`)** is written on both producers' records today. On a witness, the classifier
  does not run again; the witness compares the trailer actor it parsed with the seal's and records `trailer_actor`.
  Whether the webhook-side `claim_decision` is still needed when a verified seal exists is a question for the gate (§10 Q2).
- **Readers that counted push records as commits** (dashboards, the digest's stage-1 brief, measurement docs) see the
  number drop. That is the number becoming true; the transition release prints both.

## 8. The 180 existing unlinked records (A5)

| class | seals | this note's position |
|---|---:|---|
| PR-merge no trailer | 116 | history; forward, A2 records the derived candidate so the seal is one click away, but the record stays unlinked until the merger cites the token in the PR body (§4) — the forward fix is that token, and the measurement that proves it is `commits_with_unlinked_record` falling. Attesting them needs the merge seal's root per record (available for the 2026-10 ones whose hook merge seals are rooted; the 63 of 2026-09 pre-date owner-login and most pre-date trailers). Jordan's call (§11 D3) |
| checkpoint bot pushes | 31 | not an agent act and not a human one: the Worker's own cron. Proposal: the project policy names the standing instruction that authorises the checkpoint workflow; the push record of a `retrace-checkpoint[bot]` commit takes that id as `caused_by` with `caused_by_source: policy`. Forward only; the 31 stay or are attested once with that root (D4) |
| coordinator-receipt roots | 13 | agent-ops 20 (PR 220); 10 of them already attested on 2026-10-11 |
| human merges / commits without trailers, cursor-agent, unstamped | 17 | honest history; A3 stops the push record of a human merge being stored as `committed` |
| short-id broken links | 3 | A2 step 1 stops new ones; the 3 are corrected by attestation only |

## 9. Acceptance tests (each names the finding it closes)

1. Push of a sha whose eligible hook seal exists at or before `ingress_seq` → one `commit-witness`, `caused_by` the seal,
   `verdict: matches` with every comparison field `match`, `observed` and `sealed` digests equal and recomputable from the
   fixture, no `committed` record from the webhook; `status.commits` unchanged, `commit_records` +0, `witnesses.matches` +1.
2. Push of a sha with no seal → full record with `fallback_capture: true`; a later hook seal is a second full record;
   `status` shows two records, one commit.
2b. **Eligibility** (H3): a candidate sealed by another `assert:` credential, by a `pinned:` credential, with
   `producer_sig_verdict` other than `verified`, not git-shaped, from another project, or recording a different full sha
   → fallback capture with `fallback_reason` naming the condition; no witness.
2c. **The drain race** (M1): the delivery is parked on the pending row, the hook seal lands after `ingress_seq`, the drain
   runs → fallback capture, not a witness; the same fixture with the seal before `ingress_seq` → a witness from the drain.
3. **Same-sha disagreement** (M3; a force-pushed amend is a new sha and does not reach this path): (a) the push payload
   carries, for the sealed sha, a message whose bytes differ from the seal's `raw_message` (a mapper/source divergence
   fixture: the hook's bytes against GitHub's normalised text) → `comparison.message: differ`, `verdict: conflict`,
   `differing.message` holds GitHub's text, doctor `--gate` FAIL `commit witness`, reconcile `witness_conflict`; (b) the
   payload's file list is truncated → `comparison.files: unknown`, `verdict: incomplete`, doctor WARN not PASS; (c)
   `parents_complete: false` → `incomplete` likewise; (d) the trailer actor parsed on one side only → `incomplete`.
3b. **Forced ref replacement**: amend and force-push over a sealed sha → a new sha with no seal takes the fallback path;
   the old sha's seal and any witness stand; `status` shows both shas.
4. Redelivery of the same push → dedup on `gh:push:<repo>:<sha>` whichever record exists; no second witness.
5. PR merged with no body token, eligible merge seal present → PR-merge record `caused_by` empty, `caused_by_source: none`,
   `derived_cause: { source: merge_seal, event, root }`, the seal cited as an artifact, and `causalRootState` of the record
   `unlinked` (H2: the candidate is inspectable, not asserted); with only the head seal → `head_seal`; with an 8-hex token
   in the body → `caused_by_rejected` and the same; with a 32-hex token → `body` and `caused_by` set.
6. Pushed merge commit (two parents) → `action: merged` from the push mapper; a single-parent commit → `committed`.
7. `status` on the current ledger prints `commit_records: 1,6xx`, `commits: 8xx`, `unlinked_commit_records: 180`,
   `commits_with_unlinked_record: 164` (the audit's two numbers) and `unlinked_commits: <measured>` (M2: derived from the
   audit's per-record data before the code merges, and written here), and the doctor prints the three lines.
8. Latency: 100 synthetic push deliveries against a store with 20K events, witness path vs today's path, p50 and p95
   wall time inside the Worker's 2,000 ms budget, measured and written into this note's §7 before the code merges.

## 10. Open questions for the gate

- **Q1.** Should the witness also carry the seal's `hash`, so a later reader can detect a seal whose stored body changed
  under it? The chain hash already covers this; a copy in the witness is belt and braces at ~70 bytes.
- **Q2.** Is the webhook-side `claim_decision` (trailer-consistency §6) still needed on a witness when the seal's own
  `claim_decision` exists and the trailer actor matched? Dropping it removes the second classifier run per push.
- **Q3.** When the seal exists but was sealed by an **assert** credential other than the git hook (a forwarder), is it a
  seal the witness may name? **Answered in v1.1: no** (Codex r1 H3). v1 proposed yes for any `assert:` stamp on a
  `committed`/`merged` record; that is trust by class, which reconcile and producer verification refuse by design. Only a
  seal under the policy-pinned hook stamp, by equality, with a verified producer signature (§3) is eligible; a forwarder's
  record is a fallback capture's neighbour, not a seal. The question is kept so the gate sees it was asked and closed.
- **Q4.** Does a `conflict` witness block a merge (gate FAIL) or warn? Proposal: FAIL, because the two producers
  disagreeing about what was committed is the exact event agent-rules 5 exists to catch.

## 11. Decisions for Jordan (default, and how to overrule)

- **D1. Adopt A1–A4 as the design** and route the build as class S code in this order, **after PR 223 merges** (it already
  carries the 32-hex `causedByFrom` fix and the shared caused-by parser; v1 listed that fix as this plan's first step
  without naming the open PR — Codex r1 L1): `status` counts (quick win 3, with the third count measured first) → push
  mapper `merged` → `derived_cause` on the PR-merge record → `ingress_seq` on the pending row → witness record +
  eligibility + reconcile + doctor, each its own PR. Overrule by striking any letter; A1 without A4 leaves the headline
  counting records.
- **D2. The fallback stays a full record** (not a witness that waits). Overrule: make the drain convert fallbacks when a
  seal lands later, accepting a third record in that case.
- **D3. Do not attest the 116 historic PR-merge records by batch.** Attest only where a rooted merge seal exists and a
  reader can open it (the 2026-10 ones); leave the 2026-09 ones as history with the class named in `status`. Overrule:
  name the evidence rule for a batch.
- **D4. Checkpoint commits take the standing-instruction root from policy** (forward). Overrule: leave them unlinked and
  have `status` class them `system_bot` instead.
- **D5. Q4 default FAIL.** Overrule: warn for one release while the conflict rate is measured.
- **D6. An `incomplete` witness on HEAD is a gate WARN, never a PASS** (§6). Overrule: FAIL, accepting that a truncated
  GitHub payload (a very large commit) then blocks a merge until the hook seal is read by hand.

## 12. What this note does not claim

Nothing here is built or measured in code. **Measured** (§1, from the ledger pull of 2026-10-11 20:50Z and the coverage
audit): the record and sha counts, the producer combinations, the byte means, the 198 identical `raw_message` pairs, the
root states, the class table, the two unlinked counts 180 and 164 (records, and shas with an unlinked record). **Estimated**
(§3, §7): witness bytes per record and per commit. **Deferred to the build, before merge:** the third unlinked count
(`unlinked_commits`, §5), the latency of the indexed read (§9 test 8), and confirmation that the Worker resolves the
trusted hook-stamp set from the stored policy at delivery the way `router.ts` already does for producer verification
(`trusted_hook_stamps`); if a project's policy pins no stamp, A1 degrades to today's behaviour for that project and says
so in `fallback_reason`. The class counts are the coverage audit's (Grok's CSV, verified by Codex's independent derivation
to the same totals; Codex's set diff was pending at 20:48Z).

## 13. Fix round 1 (Codex `evt_ba308146…`, applied in v1.1)

| finding | change | where |
|---|---|---|
| H1 a `matches` witness kept only enums; `unknown` could pass; "no field is lost" | the witness carries `observed` and `sealed` digests with counts and completeness flags, verbatim differing values on `conflict`, a third verdict `incomplete`; doctor PASS only on `matches`; §7 now says what is kept and what is not | §0 A1, §3, §6, §7, §9 tests 1 and 3 |
| H2 A2 put inferred ancestry into `caused_by` | **withdrawn**: `caused_by` is populated only from a body token; the found seal goes to `method.params.derived_cause` and an artifact; the record stays unlinked until the merger cites the token; agent-rules 14 named as the reason; option 1 chosen over an inference-aware causal type | §0 A2, §3 bullet, §4, §8 row 1, §9 test 5, §11 D1 |
| H3 eligibility was `sealed_by` starting `assert:git hook`; Q3 proposed any `assert:` | eligibility is reconcile's boundary: the policy-pinned stamp by equality, verified producer signature, git shape, same project, full-sha equality, sequence; **Q3 answered no** and the v1 proposal withdrawn; `fallback_reason` names a failed condition | §0 A1, §3, §9 test 2b, §10 Q3, §12 |
| M1 exists-at-delivery not preserved across the drain | `ingress_seq` on the pending row; the seal read bounded `through_seq = ingress_seq` at delivery and at drain; race acceptance test | §3, §9 test 2c, §11 D1 |
| M2 the 164 did not follow from the definition | three counts defined separately; 164 is `commits_with_unlinked_record`; `unlinked_commits` is to be measured before merge | §5, §9 test 7, §12 |
| M3 the conflict fixture (a force-pushed amend) is a new sha | same-sha fixtures: message bytes divergence, truncated file list, incomplete parents, one-sided trailer actor; forced ref replacement tested separately as a fallback | §9 tests 3 and 3b |
| L1 the build order omitted PR 223 | PR 223 (open at `d25b889d`) named as the dependency carrying the 32-hex fix and the shared parser; D1 starts after it | §1, §4 step 1, §11 D1 |

Two claims were withdrawn rather than reworded: that a derived link may populate `caused_by` (H2), and that any
`assert:` credential may seal a witnessable record (H3). One claim was narrowed to what the design keeps: "no field is
lost" (H1). One number was relabelled to what it measures: 164 (M2).
