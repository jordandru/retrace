# The webhook as witness, not second author — one authoritative record per commit (design note v1)

**Status:** v1, 2026-10-11, by claude-code (the "system optimization" pane; `claude-mythos-5-1`, model source
harness-runtime, effort high). **It proposes no code in this PR**: a design note, class **(a)** under agent-rules 12, for the
design gate. Written on Jordan's signed go `evt_c83cad7552a149a5940b27a0bcc84b0b` ("Let's go on your top 3 items starting
with 1", received `evt_85ad930c…`), item 3 of `~/.retrace/ops-2026-10-11/system-optimization/OPTIMIZATION-PLAN.md` (sha256
`499d1ee9…3527`, created `evt_71b02714…`). Items 1 and 2 are PRs 222 and 225. The measurements it rests on are
`FINDINGS.md` M1 and M2 of the same pane (read 2026-10-11 20:48–21:05Z); each number below names its source.

## 0. The question and the proposed answer

**Question.** Every commit on main leaves two or three full records in the ledger: the git hook's seal, the GitHub push
webhook's record of the same commit, and for a merge the PR-merge webhook record. Agent-rules 5 wants two producers on
one sha so that a missing or forged hook seal is detectable. Does the second producer have to be a second *author* of the
same facts, or can it be a *witness* to the first record, and what would that change in what the ledger says?

**Proposed answer, for Jordan to decide after the gate:**

- **A1. The push webhook writes a witness record when the hook's seal for that sha already exists at delivery**, and a
  full record (today's behaviour) only when it does not. The witness names the seal's event id and the sha, carries
  GitHub's own facts (ref, pusher, delivery id, ingress time), records the comparison of what both producers saw
  (message, files, parents, author, trailer actor) and a verdict `matches` | `conflict`. It is sealed by `webhook:github`
  like today; it is still a second producer; it is not a second copy.
- **A2. The PR-merge record derives its `caused_by` when the PR body carries none**: from the hook's `merged` seal of the
  merge commit if it exists at delivery, else from the hook seal of the PR head, each labelled with where it came from.
  The record stays (it is the only place GitHub's `merged_by` login and the owner-login decision are recorded).
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
| `causedByFrom` regex | `/Retrace-Caused-By:\s*(evt_[a-f0-9]+)/i` (`github.ts:54`): an 8-hex prefix is captured and sealed as a dangling link |

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

Written by the push path of `POST /hooks/github` (trailer-consistency §5.3) **instead of** the full push record, when a
hook seal for the sha is found at delivery. Finding it is one indexed read, `eventsReferencingArtifacts` on
`commit:<repo>@<sha12>` restricted to `committed`/`merged` records with `sealed_by` starting `assert:git hook` (the same
index the classifier already reads; the 2,000 ms delivery deadline applies, and a read that misses the deadline falls to
the pending row like any other, §5.3).

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
    producer: "github-push", witness_of: "<hook seal id>", sha, ref, pusher, delivery, ingress_at,
    comparison: {                                   // what both producers saw, field by field
      raw_message: "match" | "differ",
      files: "match" | "differ" | "unknown",        // unknown when GitHub's payload truncates the file list
      parents: "match" | "differ" | "unknown",      // unknown when parents_complete is false
      author: "match" | "differ",
      trailer_actor: "match" | "differ"             // the Retrace-Actor each side parsed
    },
    verdict: "matches" | "conflict",                // conflict = any "differ"
    sealed_by: "webhook:github", producer_sig_verdict: "none"
  }},
  idempotency_key: "gh:push:<repo>:<sha>",          // unchanged: a redelivery dedups against whichever record exists
  tags: ["github", "push", "witness"]
}
```

- **Not a commit record.** `status`, reconcile and the doctor count `committed`/`merged`; a witness is `other`. So the
  sha is counted once, by its seal, and the witness is evidence about the seal.
- **Rooted by construction** when the seal is rooted: `caused_by` is the seal. A witness never creates a new unlinked
  chain, which is what 58 of the 73 unlinked records on recent main are (PR-merge, §1) — the push half of that class
  (the 7 push records of human merges) disappears forward; the PR-merge half is A2.
- **The comparison is the check** agent-rules 5 describes, made explicit and sealed, instead of two records a reader
  diffs. `conflict` is a doctor finding (§6) and a reconcile finding; `matches` is the quiet case.
- **Fallback unchanged.** No seal at delivery → the full push record exactly as today, with one added param
  `fallback_capture: true` so a reader knows the hook was absent when GitHub reported the push. If the hook's seal
  arrives later, that sha has two full records, as today; the drain does not convert them (a conversion would rewrite
  nothing, but it would add a third record for the quiet case, and §1 shows the hook normally lands first).
- **Bytes (estimate from §1 means):** a witness is ~1.0–1.3 KB against a 3,257-byte push record; ~2 KB per commit, about
  a fifth of the 9,668 bytes a commit leaves today, and the duplicated `raw_message` disappears from the quiet case.

## 4. The PR-merge record's `caused_by` (A2) and the short-id token

Today `caused_by` is whatever `causedByFrom(pr.body)` captures, else empty. Proposed order, each outcome labelled in
`method.params.caused_by_source`:

1. `body`: a full `evt_` + 32-hex token in the PR body (today's path, with the regex fixed to 32 hex; a shorter token is
   recorded as `caused_by_rejected: "<token>"` and **not** used — the 3 broken links of 2026-09-30, 2026-10-08 and
   2026-10-11 are that regex capturing `evt_dd964d92`, `evt_57b9aa95`, `evt_052a3936`).
2. `merge_seal`: the hook's `merged` seal of `merge_commit_sha`, found at delivery; its `caused_by` is copied and the
   record also cites the seal (`artifacts: event:<seal>`, `witness_of`).
3. `head_seal`: the hook seal of the PR head sha, likewise.
4. `none`: as today, empty, and the record says so.

The record keeps its actor (`system/github:jordandru` or the identity-mapped seat, owner-login design), its
`owner_login_decision` and its GitHub facts. What changes is only that a reader following `caused_by` from the merge
record reaches the same instruction the merge seal reaches, with a label saying the link was derived, not asserted by
the merger in the PR body. That label is the difference between "the merger said" and "the webhook inferred", and it is
kept so nobody reads a derived link as an assertion.

## 5. `status` (A4) and reconcile

- `capture.commits` → `capture.commit_records` (what it counts today) **and** a new `capture.commits` = distinct shas
  among those records. `unlinked_commits` likewise splits into `unlinked_commit_records` (today's 180) and
  `unlinked_commits` = shas none of whose records is rooted or attested (164 today). The doctor prints both for one release
  so the two readings sit side by side; docs that cite the headline cite the sha count.
- `capture.witnesses: { matches, conflict, fallback_captures }` reports A1's outcomes.
- Reconcile: the `missing_commit` branch (`reconcile.ts:362–372`) already treats a webhook-merged head as "made where no
  hook runs"; a `commit-witness` with `verdict: conflict` becomes a reconcile finding `witness_conflict` (fail) naming the
  fields that differ; `matches` adds nothing. The merge branch is untouched (A6).

## 6. Doctor

- `commit witness` finding on `--gate`: FAIL when the HEAD sha's witness says `conflict`; PASS when it says `matches` or
  when the only record is a fallback capture (the hook was absent; today's "HEAD delivery" finding already names that).
- The existing "HEAD delivery" check (`headDelivery`) accepts a hook seal **or** a push record today; after A1 it accepts
  a hook seal with or without a witness, or a fallback capture. Nothing becomes weaker: a sha with no record of any kind
  still fails.

## 7. What it costs and what it risks

- **Provenance.** No field is lost from the ledger's capture of a commit: the seal carries it; the witness carries
  GitHub's facts and the comparison; the fallback keeps today's full record when the seal is absent. Two producers
  remain on every quietly-committed sha (seal + witness). What is removed is the second copy and the second empty chain.
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
| PR-merge no trailer | 116 | history; forward closed by A2. Attesting them needs the merge seal's root per record (available for the 2026-10 ones whose hook merge seals are rooted; the 63 of 2026-09 pre-date owner-login and most pre-date trailers). Jordan's call (§11 D3) |
| checkpoint bot pushes | 31 | not an agent act and not a human one: the Worker's own cron. Proposal: the project policy names the standing instruction that authorises the checkpoint workflow; the push record of a `retrace-checkpoint[bot]` commit takes that id as `caused_by` with `caused_by_source: policy`. Forward only; the 31 stay or are attested once with that root (D4) |
| coordinator-receipt roots | 13 | agent-ops 20 (PR 220); 10 of them already attested on 2026-10-11 |
| human merges / commits without trailers, cursor-agent, unstamped | 17 | honest history; A3 stops the push record of a human merge being stored as `committed` |
| short-id broken links | 3 | A2 step 1 stops new ones; the 3 are corrected by attestation only |

## 9. Acceptance tests (each names the finding it closes)

1. Push of a sha whose hook seal exists → one `commit-witness`, `caused_by` the seal, `verdict: matches`, no `committed`
   record from the webhook; `status.commits` unchanged, `commit_records` +0, `witnesses.matches` +1.
2. Push of a sha with no seal → full record with `fallback_capture: true`; a later hook seal is a second full record;
   `status` shows two records, one commit.
3. Push where GitHub's message or file list differs from the seal (a force-pushed amend over a sealed sha is the
   realistic case) → `verdict: conflict`; doctor `--gate` FAIL `commit witness`; reconcile `witness_conflict`.
4. Redelivery of the same push → dedup on `gh:push:<repo>:<sha>` whichever record exists; no second witness.
5. PR merged with no body token, merge seal present → PR-merge record `caused_by` = seal's, `caused_by_source: merge_seal`;
   with an 8-hex token in the body → `caused_by_rejected`, then steps 2–4; with a 32-hex token → `body`.
6. Pushed merge commit (two parents) → `action: merged` from the push mapper; a single-parent commit → `committed`.
7. `status` on the current ledger prints `commit_records: 1,6xx`, `commits: 8xx`, `unlinked_commit_records: 180`,
   `unlinked_commits: 164` (the audit's numbers), and the doctor prints both lines.
8. Latency: 100 synthetic push deliveries against a store with 20K events, witness path vs today's path, p50 and p95
   wall time inside the Worker's 2,000 ms budget, measured and written into this note's §7 before the code merges.

## 10. Open questions for the gate

- **Q1.** Should the witness also carry the seal's `hash`, so a later reader can detect a seal whose stored body changed
  under it? The chain hash already covers this; a copy in the witness is belt and braces at ~70 bytes.
- **Q2.** Is the webhook-side `claim_decision` (trailer-consistency §6) still needed on a witness when the seal's own
  `claim_decision` exists and the trailer actor matched? Dropping it removes the second classifier run per push.
- **Q3.** When the seal exists but was sealed by an **assert** credential other than the git hook (a forwarder), is it a
  seal the witness may name? Proposal: yes if `sealed_by` starts `assert:` and the record is `committed`/`merged`; the
  witness records which.
- **Q4.** Does a `conflict` witness block a merge (gate FAIL) or warn? Proposal: FAIL, because the two producers
  disagreeing about what was committed is the exact event agent-rules 5 exists to catch.

## 11. Decisions for Jordan (default, and how to overrule)

- **D1. Adopt A1–A4 as the design** and route the build as class S code in this order: `causedByFrom` 32-hex (one line,
  plan quick win 2) → `status` counts (quick win 3) → push mapper `merged` → derived `caused_by` → witness record +
  reconcile + doctor, each its own PR. Overrule by striking any letter; A1 without A4 leaves the headline counting records.
- **D2. The fallback stays a full record** (not a witness that waits). Overrule: make the drain convert fallbacks when a
  seal lands later, accepting a third record in that case.
- **D3. Do not attest the 116 historic PR-merge records by batch.** Attest only where a rooted merge seal exists and a
  reader can open it (the 2026-10 ones); leave the 2026-09 ones as history with the class named in `status`. Overrule:
  name the evidence rule for a batch.
- **D4. Checkpoint commits take the standing-instruction root from policy** (forward). Overrule: leave them unlinked and
  have `status` class them `system_bot` instead.
- **D5. Q4 default FAIL.** Overrule: warn for one release while the conflict rate is measured.

## 12. What this note does not claim

Nothing here is built or measured in code; §9 test 8 is the measurement that must exist before A1 merges. The byte and
latency figures are estimates from the means in §1. The class counts are the coverage audit's (Grok's CSV, verified by
Codex's independent derivation to the same totals; Codex's set diff was pending at 20:48Z).
