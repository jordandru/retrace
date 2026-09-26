# GitHub owner-login attribution — design note v1 (evaluation plan P1; issues #82, #69)

**Status:** DRAFT v1.4, 2026-09-26 (v1.4 06:3xZ / 00:3x MDT: the final text touch on Jordan's go `evt_1e00d0a0b1804e68b3b66af34d6db2e2` —
Codex round-4 R4-L1, NOOA round-4 N4-M1/N4-M2/N4-L3, and the Grok seat's (cursor-agent) first-pass findings R1-M1/R1-L1/R1-L2
(`evt_238adda495d04d6c8307bb4d39c760d6`); Codex `evt_34361117eb5d4745835616bf5442615c` and NOOA `evt_b3ad9f6c0d1b4ba6a2c13e3717baccff`
approved v1.3. v1.3 05:4xZ / 23:4x MDT 2026-09-25: Codex round-3 findings `evt_c906656c7cd344cb9c52f43d74dffecc`
— R3-F1 allocation committed atomically with the seal, no pre-seal reservation; R3-L1 three v1.1 leftovers — applied in place on
Jordan's go `evt_3cf2f506b8e948ca9bd66b6fdb0b87f8`; NOOA round 3 approved `evt_22fff7f3bdcc4817b204750a121a4a3d`. v1.2 05:1xZ / 23:1x MDT 2026-09-25: Codex round-2 findings `evt_2a358258d9c54624a49c0fa769e09e98`
— R2-F2 ingress cutoff, R2-F3 consumption read, R2-L1 T14 split — applied in place on Jordan's go `evt_eaab62d8b9e842f29d04f17bd21881bc`;
NOOA round 2 approved `evt_ca197d293b1d40f1905cc00dafc64be3`. v1 03:5xZ / 21:5x MDT 2026-09-25; v1.1 04:3xZ / 22:3x MDT, round-1 findings of Codex
`evt_cc16a99f33ab467895ddc5831adc6043` — F1 lookup, F2 caller time, F3 body-only keys — and NOOA
`evt_45521b66918f4938919b26768995bf80` — N1 D1 framing, N2 `declared_by_seat`, N3 §1.3, N4 owner-action marks; N5
declined, see §14 — applied in place on Jordan's decision `evt_4be7266d49b64e1e94c8d4da4a0ff875`). Author claude-code (coordinator, `claude-fable-5-1`,
model source harness-runtime), on Jordan's instruction `evt_603025a3932a4193a23f16b49b742f96` ("Accept all four, draft the
P1 note"), which accepted the coordinator's recommendations on `docs/design/evaluation-response-plan-2026-09-24.md` §6
Q1–Q4 as presented in `evt_e5ce6a0ed09e40bc8cd39b57b8801ecf`. **Class (a)** under agent-rules 12: it governs how the
Worker writes the WHO of every GitHub webhook event, adds a project-policy field, and proposes an environment rule
(appendix A). Design gate: Codex → NOOA (Nemotron, pinned) → the Grok seat; the author does not sit. **Not built.**

Companions: `commit-trailer-consistency.md` (a claim is classified against pinned evidence, never trusted — this note
reuses its evidence model and its decision-record shape), `attribution-v7-contract.md` (corrections), `model-source.md`
§4.1 (a server-resolved actor beside a claim), `project-policy-document.md` (where the new fields live),
`docs/owner-protocol.md` §7–§8 (the envelope proves nothing about who typed; prevention is per-seat identity).

## 0. Decisions this note asks the gate to confirm

Jordan decided Q3 and Q4 (`evt_603025a3…`): one note for both approaches, classification built first; the existing
events are labelled, never batch-amended. Within that, the coordinator proposes:

- **D1. The webhook knows the account, not the person.** The payload names the account (`sender.login`) and signals a
  User, not a Bot (`sender.type`); today's adapter infers `human` from that signal. For a GitHub login the project policy
  marks **shared** (a login pinned seats act through), the adapter **stops inferring `human` from the User signal** — a
  policy-driven reclassification the owner sets in §5, not something the webhook distinguishes on its own (NOOA round 1,
  N1) — and writes the **account** (`type: system`, `id: github:<login>`) unless a seat's own declaration resolves the
  actor (§4).
- **D2. Evidence is a content-bound declaration, not proximity.** A seat's pinned event that names the exact content of
  the GitHub action — the body hash, the pushed sha, the merge commit — logged before the action. A pull-request number
  inside a time window is not evidence; §1.3 measures why.
- **D3. The decision is sealed beside the actor**, hash-covered, in `method.params.owner_login_decision`, the way
  `claim_decision` sits beside a commit's actor. Consumers read the decision; nothing is inferred later from the actor alone.
- **D4. Existing events are labelled at read time** by the same rule (status, doctor, `why`), and amended one at a time
  only where a declaration or an outcome record exists (§8). No batch amendment (`docs/reference.md:267`, Q4).
- **D5. Per-seat GitHub identities are the prevention** and follow as step 5 (§6): a GitHub App per seat, mapped to the
  seat's actor by the project policy. When no seat acts through the owner's login any more, the shared mark comes off
  and the owner's own GitHub actions are `human` again — on evidence, not by default.

## 1. The problem

### 1.1 The code

`packages/core/src/github.ts:41–51`, `githubActor()`: a sender that is not a GitHub `Bot` and does not match `BOT_RE`
is `type: human`, `id: github:<login>` (or the payload e-mail), unconditionally. `gh` runs as the repository owner for
every seat (agent-rules 11), so every seat's pull-request open, push, body edit, comment, review and merge arrives with
`sender.login` = `jordandru` and is sealed as him. The router stamps these seals `sealed_by: webhook:github`, producer
verdict `none` (`router.ts:674, :691`; `store.ts:651`). The `push` event is different and out of scope here: its actor
comes from the commit trailers through `resolveCommitActor` and is classified by `commit-trailer-consistency.md`.
`workflow_run` is a `system` actor already.

### 1.2 The size (census)

`GET /projects/retrace/status` at 2026-09-26T03:43:56Z: actor `human` / `github:jordandru` has **650 events**, last
seen 03:02:01Z (Jordan's own `gh pr merge 129`, reported in his signed `evt_2efc9203…` and verified `evt_461993f6…`). The
evaluation plan counted 592 on 2026-09-24; issue #82 counted 344 on 2026-09-20. It grows with every agent `gh` call.

Probe over the project export (`GET /projects/retrace/export`, bundle generated 2026-09-24T18:07:55Z, seq 0–7697, 7,698
events — the Worker served a cached bundle two days older than the status above, so the probe covers 576 of the 650 events;
the other 74 are later than seq 7697; script in the coordinator's scratchpad, results logged with this note's edit event):

| human `github:jordandru` events in that slice | 576 |
|---|---:|
| `issue_comment` → `sent` (tool `github-comment`) | 127 |
| `pull_request_review` commented → `other/reviewed` (tool `github-review`) | 107 |
| `synchronize` → `edited` | 111 |
| PR body `edited` → `other/edited` | 89 |
| `closed` merged → `merged` | 69 |
| `opened`/`reopened` → `created` | 67 |
| `closed` unmerged, `ready_for_review` | 6 |
| sealed `webhook:github` / unstamped (before 2026-08-30) | 572 / 4 |

Some of the 650 are Jordan's own. The defect is not that any one of them is wrong; it is that the record cannot say
which are (#82, "what this is not").

### 1.3 Why proximity is not evidence (measured)

Issue #82 option 1 proposed correlating a webhook event with a pinned event that names the same pull request inside a
short window. The probe tested that on the 576 events, matching any pinned agent event whose artifacts or intent name the
same PR number or head sha:

| window | no pinned event names the PR | exactly one seat does | more than one seat does |
|---|---:|---:|---:|
| ± 10 min | 30 | 129 | 417 |
| ± 30 min | 18 | 75 | 483 |
| ± 120 min | 8 | 47 | 521 |

A pull request under review is named by the coordinator (routing, pointers), the reviewer (verdict, `used` artifacts) and
the builder (edits) inside the same minutes. Proximity finds the pull request, not the hand on `gh`. In 129 of the 576
events (± 10 min) and 75 (± 30 min) exactly one seat names the pull request, so proximity does single out a candidate
there; the design still treats that as insufficient evidence, because the one seat that happened to be logging is not
thereby the seat that ran `gh` (NOOA round 1, N3). An exact `pr:jordandru/retrace#<n>` artifact on a pinned event within
± 30 min exists for 354 of the 576; it narrows the candidates. So the design binds evidence to **content** (§3), and the
probe is the reason.

### 1.4 What seats already do, unstandardised

49 pinned events in the slice describe a `gh` action in their intent (claude-code 27, codex 19, cursor-agent 3); 14 carry
`method.params.body_sha256`, 23 a `github_review_id`, 4 `comment_copy_posted`. Example pair on PR 118 (2026-09-24): the
coordinator's `sent` `evt_b3827f2b…` (`pr: 118`, `body_sha256: 141777f2…`, `posted_by_seat: claude-code`,
`github_identity: "jordandru (owner, shared by every seat)"`) before the call, and `executed` `evt_42fed194…` (`review_id:
5302879598`, `submitted_at`) after it. The practice used flat, differently named fields (`pr`, `body_sha256`, `review_id`;
on PR 130 itself `state: "COMMENT"` and `commit_id`); the declaration this note defines (§3.2) is what that practice
becomes once it has one schema the Worker can match, and §3.3 says how the older spellings are read (the Grok seat's
round-1 finding R1-M1: under strict field equality none of PR 130's own eight review declarations would have matched).

## 2. Principles

1. **Write what the producer knows.** A signed webhook proves that GitHub saw the account `jordandru` perform the action
   as a User (`sender.type: "User"`). It does not prove which person did. For a login the policy marks shared, `human` is
   an inference the payload cannot support, so the adapter no longer draws it; the account, `system` / `github:<login>`,
   is what is left when that inference is withdrawn (issue #61 option 3, the same shape as #82 option 3). The
   withdrawal is the policy's decision (§5), recorded in the decision record as `shared: true`; the webhook itself does
   not know which logins are shared (NOOA round 1, N1).
2. **A seat's declaration is testimony, classified like a trailer.** It is admitted only from a pinned, producer-signed
   seat event (trailer-consistency §3.3's ingress rule), matched on content, and recorded with the decision. It
   establishes that the seat declared the action. A content match with no other declarer is the strongest testimony the
   ledger can hold that the seat performed it; it is not proof (Codex round 1, F3), and the gap is stated in §10.
3. **Only contradiction withholds; absence labels.** Two seats declaring the same content is `conflicting` and the
   account is written. No declaration is `unresolved`, the account is written and the status says so. Nothing writes a
   seat's name without a matching declaration.
4. **The history is labelled, not rewritten** (rule 10, Q4). Read-time labels are computed by the same rule and say so.
5. **Prevention is identity, not inference** (owner-protocol §8; `docs/reference.md:263`, "distinguish content author from
   committer and relayer"). Per-seat GitHub identities end the shared login; until then the classifier is the floor.

## 3. Evidence model

### 3.1 What the webhook event records at ingestion (new, hash-covered)

For `pull_request` (`opened`, `reopened`, `edited`, `synchronize`, `closed`), `pull_request_review` and `issue_comment`
on a pull request, `mapGithubWebhook` adds `method.params.github_payload`:

| field | from | present on |
|---|---|---|
| `login` | `sender.login` (review: `review.user.login`; comment: `comment.user.login`; merge: `merged_by.login`) | all |
| `branch` | `pull_request.head.ref`, with `pull_request.head.repo.full_name` | all `pull_request` actions, review, comment |
| `body_sha256` | sha256 of the normalised body (§3.4) of the PR / review / comment | opened, edited, review, comment |
| `title_sha256` | sha256 of the normalised PR title | opened, edited |
| `review_state` | `review.state`, lower-cased (`commented`, `approved`, `changes_requested`) | review |
| `head_sha` | `pull_request.head.sha`; synchronize: `after`; review: `review.commit_id` | opened, synchronize, review |
| `merge_commit_sha` | `pull_request.merge_commit_sha` | merged |
| `review_id`, `comment_id` | `review.id`, `comment.id` | review, comment |
| `delivery` | `X-GitHub-Delivery` | all |
| `ingress_at` | the Worker's clock at HTTP arrival of the delivery, read **before** any store read (the first statement of the `POST /hooks/github` handler after signature verification), carried unchanged through the pending queue, a deferred drain and every append retry | all |

Today the event keeps only a 300-character `intent` (`trim(body)`), so a body hash cannot be recomputed from the ledger
afterwards; recording it at ingestion is what makes the decision reproducible offline from an export (T2).

### 3.2 What a seat declares (the declaration event)

Before running the `gh` command, the seat logs one pinned event — `sent` for a comment or review, `created` for a PR
open, `edited` for a body edit or a push, `merged` for a merge — with the pull request as an artifact
(`pr:<owner/repo>#<n>`, role `used`, or `generated` for an open) and `method.params.github_action`:

```json
{ "kind": "comment | review | pr_open | pr_edit | push | merge",
  "repo": "jordandru/retrace", "pr": 118, "login": "jordandru",
  "body_sha256": "<sha256 of the body file as it will be submitted, normalised per §3.4>",
  "title_sha256": "<sha256 of the normalised title, pr_open and pr_edit>",
  "review_state": "<commented | approved | changes_requested, review only>",
  "head_sha": "<full sha the push or open will carry; for a review, the commit it reviews>",
  "merge_commit_sha": "<full sha the merge will land>" }
```

`kind`, `repo` and `login` are required; `pr` is required for every kind except `pr_open`, where the number does not
exist before the call (found the first time the coordinator declared this note's own pull request: the artifact is then
the branch, `git:<owner/repo>#<branch>`, and the match is on `repo`, `branch`, `head_sha`, `body_sha256` and
`title_sha256`); exactly the content field(s) the kind needs are required, and they are the fields that define the
action, not the body alone (Codex round 1, F3: a body-only key let one honest `pr_edit` declaration match a later
title-only edit, and one `review` declaration match a review of another state or commit): `comment`: `body_sha256`;
`review`: `body_sha256`, `review_state`, `head_sha` (the commit reviewed); `pr_open`: `body_sha256`, `title_sha256`,
`head_sha`; `pr_edit`: `body_sha256` **and** `title_sha256` (both, so a title-only edit never matches a body-only
declaration and the reverse); `push`: `head_sha`; `merge`: `merge_commit_sha`. **A declaration resolves at most one
webhook event**: once matched it is consumed (its id is written in that event's decision) and cannot resolve a second;
two identical operations need two declarations, and an unconsumed duplicate is `unresolved` / `no_declaration`.
The seat knows every one of these before the call: it wrote the body file, it has the sha it is about to push, the merger
has the merge commit before `git push`. After the call the seat may log an **outcome record** (`executed`,
`github_action.result: { review_id | comment_id | pr | delivery }`). An outcome record is not a declaration: §3.3 excludes
any event whose `github_action` carries `result`, whatever its timing (Codex round 1, F2: webhook delivery is not
guaranteed to precede the outcome log). Outcome records enter read-time labels and individual amendments only (§8).

### 3.3 Eligibility and window

A declaration `E` resolves webhook event `G` iff all hold:

- `E.project` = `G.project`; `E.method.params.sealed_by` starts with `pinned:` **and** `E.method.params.producer_sig_verdict`
  = `verified` (agent-rules 15's two checks; an owner-sealed or asserted declaration is a claim by the relayer, not the
  seat — Codex round-2 F4 on rule 15 applies here unchanged);
- `E.actor.type` = `agent`; `E.action_detail` ≠ `amended`; `E` is not the target of an effective attribution amendment at
  the read head;
- `E.github_action` exists and carries **no `result`** (an outcome record is never a declaration; Codex round 1, F2);
- `E.github_action.repo` = the canonical repository of `G`, `E.github_action.login` = `G.github_payload.login`,
  `E.github_action.kind` matches `G`'s action (`pull_request` `edited` ↔ `pr_edit`, `synchronize` ↔ `push`, and so on),
  and `E.github_action.pr` = `G`'s pull-request number for every kind but `pr_open`, where the branch artifact
  `git:<R>#<branch>` must equal `G.github_payload.branch` instead;
- **field normalisation before comparison** (Grok seat round 1, R1-M1): in a declaration, `state` is read as
  `review_state` and `commit_id` as `head_sha`; `review_state` values are case-folded and aliased — `COMMENT`, `COMMENTED`
  → `commented`; `APPROVE`, `APPROVED` → `approved`; `REQUEST_CHANGES`, `CHANGES_REQUESTED` → `changes_requested` — so the
  eight review declarations PR 130 already carries (`state: "COMMENT"`, `commit_id`) match GitHub's lower-cased
  `review.state` `commented`; any other spelling is not normalised and does not match;
- every content field the kind requires (§3.2) is **equal**, after that normalisation, to `G.github_payload`'s (`body_sha256`, `title_sha256`,
  `review_state`, `head_sha`, `merge_commit_sha` as the kind demands);
- `E` has not been consumed by an earlier decision (§3.2) — a fact the classifier learns from the consumption table,
  not from the declaration (§3.5; Codex round 2, R2-F3);
- **server time, not caller time** (Codex round 1, F2; the cutoff corrected in round 2, R2-F2): `E.seq` ≤ `U`, the read
  head at classification, and `E.received_at` — the Worker's hash-covered seal time of the declaration, the only server
  time a declaration has — is **not later than `G.github_payload.ingress_at`**, the Worker's clock at HTTP arrival of the
  delivery (§3.1), and not earlier than `ingress_at − 30 min`. `G.received_at`, the webhook seal's own receipt time, is
  **not** the cutoff: `chain.ts` sets it inside `sealEvent`, after the router's policy and routing reads, so it does not
  exist when classification needs it, and a declaration sealed after the delivery arrived but before the webhook sealed
  would pass a comparison against it (Codex round 2, R2-F2, shown on the sealing primitive). `ingress_at` is captured
  before any read and travels with the delivery through the pending queue and every retry, so the same cutoff applies
  whether the delivery is classified synchronously or drained later. The caller-supplied `E.timestamp` is never
  compared: a seat that sees an action land can log a declaration with any earlier timestamp it likes, but it cannot make
  the Worker seal that declaration before the delivery arrived. GitHub's payload times (`updated_at`, `submitted_at`,
  `created_at`, `merged_at`) are recorded in `github_payload` for the reader and have one-second precision; they play no
  part in eligibility, so a declaration sealed in the same second as the action is not rejected. The 30-minute lower
  bound is a guard against a stale declaration for an action retried much later, not the evidence; the content match is.
  **Residual timing gap, stated:** the action happens at GitHub before the delivery reaches the Worker — normally within
  seconds, longer when GitHub retries a delivery — and a declaration sealed in that interval, after the action but before
  `ingress_at`, is eligible. The decision record carries `ingress_at`, the declaration's seal time and GitHub's payload
  time so a reader can see the interval; the payload time is GitHub's claim under an HMAC, not a trusted clock, so the gap
  is narrowed by `ingress_at`, never closed by it; per-seat identities (§6 step 5) close it.

`Decl(G)` = the set of eligible declarations; `Seats(G)` = their distinct `actor.id`s.

### 3.4 Body normalisation

GitHub stores what it received but may alter line endings and trailing whitespace. Both sides hash the same bytes: UTF-8,
`\r\n` → `\n`, trailing whitespace on each line removed, trailing newlines removed. One real post per kind is measured at
build time against the webhook payload (T3); if GitHub alters anything else, the normalisation is extended and the
measurement recorded here as a dated correction.

### 3.5 Read contract

Two bounded reads per webhook event, then one atomic event-plus-consumption write (item 3).

1. **Candidates.** Pinned events in `(U − N, U]` referencing **any of** `pr:<R>#<n>`, `git:<R>#<branch>`
   (`github_payload.branch`) and `commit:<R>@<head_sha12>` through the existing `event_artifact_index`
   (`eventsReferencingArtifacts`, PR 27; it takes several keys in one statement), then filtered in memory on
   `github_action` and the §3.3 predicate. The branch and commit keys exist because a `pr_open` declaration cannot name a
   PR number (§3.2); the first live sample, `evt_df2d386c…`, carries only the branch, the commit and a body-file
   artifact, and Codex showed (round 1, F1) that the PR-keyed query alone returns nothing for it. The build tests the
   live sample **through this lookup** (T14a).
2. **Consumption.** A new table `owner_login_consumption(project, declaration_event_id PRIMARY KEY, consumed_by_delivery,
   consumed_by_event_id, consumed_at)`, read for the candidates' ids. The consuming webhook seal is `sealed_by
   webhook:github` and carries `owner_login_decision`, not a declaration's `github_action`, so the pinned-only candidate
   read can never see consumption (Codex round 2, R2-F3); the table is the classifier's memory of it, the way
   trailer-consistency §3.2's classification-context row is the memory of a commit's window. A candidate with a row is
   consumed and drops out of `Decl(G)`.
3. **Allocation, committed with the seal.** When more than one unconsumed candidate from the **same** seat is eligible,
   the one with the lowest `seq` is chosen (earliest sealed; deterministic from an export). **There is no reservation
   before the seal** (Codex round 3, R3-F1: a pre-seal row is unsealed mutable state — a stalled or failed delivery would
   hold a declaration that no sealed decision claims, and a competing delivery that read that row and sealed
   `unresolved` could not be reproduced from the export). Instead the consumption row and the consuming event are written
   in **one atomic store write** — a D1 `batch` on the Worker, a transaction in SQLite: `INSERT` the event, `INSERT` the
   row `(project, declaration_event_id)` under its primary key. If the row already exists the whole write fails and
   nothing is sealed; the classifier then **re-runs classification at the new read head** — which now contains the
   winner's sealed decision, so the second read (§3.5 item 2) sees the consumption — and seals what that read supports
   (`unresolved` / `no_declaration` when nothing else is eligible). This is a reclassification, not an append retry: the
   existing UNIQUE retry loop in `router.ts` re-appends the same input, which would re-assert a stale decision, so the
   owner-login path retries from the read, not from the append. A delivery that ends `unavailable`, times out, or fails
   before the write leaves no row. **Replay contract:** the table holds a row iff a sealed decision lists that declaration
   under `consumed`, so an offline re-derivation (T2) that replays sealed decisions in `seq` order reproduces every
   decision exactly, and the table adds no trusted state the export cannot show. Idempotent redelivery: GitHub redelivers
   with the same `X-GitHub-Delivery`; the existing idempotency key returns the sealed event and no second write is
   attempted. Build note: the pending-delivery drain routes only `push` today (`router.ts`, `drainPending…`); the step-1
   build makes it event-kind-aware so a deferred non-push delivery is classified by this path. **What the atomic write
   rests on, and what it does not:** Cloudflare documents `D1Database.batch()` as a transaction that rolls back the
   sequence when a statement fails, and both stores already write an event together with its artifact-index rows inside
   that boundary (`apps/worker/src/d1-store.ts`, `packages/mcp-server/src/sqlite-store.ts`); the consumption insert joins
   the same write (Codex round 4; NOOA round 4, N4-M1). An uncertain response after the write began is **not** proof of
   rollback — both statements may have committed — so the path never releases a row or treats a response deadline as a
   cancellation; it resolves the outcome by the idempotent lookup of the delivery, exactly as the existing append does.
   **Bound on reclassification** (NOOA round 4, N4-M2): after a primary-key failure the classifier re-reads once; the
   winner's decision is a strictly later `seq` on the same primary database, so the re-read sees the consumption. If the
   second write also fails, the delivery seals `unresolved` / `no_declaration` with reason `allocation_failed` — one
   re-read, never a loop.

Budget 300 ms
and 2,000 rows (a pull request's index rows over 30 minutes are two orders of magnitude fewer than a commit's file
witnesses); over budget or any store error → `unavailable` (§4). The classifier records `read_head_seq` and
`read_head_hash` so the decision is reproducible from an export.

## 4. Decision table

Applies only when `github_payload.login` is in the project policy's `github.shared_logins` (§5). Every other login keeps
today's mapping (§10, limit 1). The `actor` written in the unresolved rows is a **policy-driven reclassification** of the
webhook's User signal, not a copy of producer evidence: the decision record carries `shared: true` so a reader can see
which rule produced the account actor (NOOA round 1, N1).

| Case | `status` | `reason` | Recorded `actor` |
|---|---|---|---|
| `|Seats(G)| = 1` | `declared_by_seat` | — | the seat: `{ type: agent, id: <seat>, on_behalf_of: <the declaration's on_behalf_of> }`, with `evidence_level: declaration_only` in the record — the seat *declared* this action; nothing here verifies its identity at GitHub (NOOA round 1, N2). `identity_mapped` (§6 step 5) is the level above it. |
| `|Seats(G)| > 1` | `conflicting` | `multiple_declarers` | the account: `{ type: system, id: github:<login>, display_name: "<login> (GitHub account, shared)" }` |
| `Decl(G) = ∅`, some pinned event names the PR in the window | `unresolved` | `proximity_only` | the account |
| `Decl(G) = ∅`, none does | `unresolved` | `no_declaration` | the account |
| the atomic write failed on the consumption key twice (one re-read; §3.5 item 3) | `unresolved` | `allocation_failed` | the account |
| evidence read failed / over budget | `unavailable` | `store_error` / `budget` / `deadline` | the account |

There is no policy switch for `unresolved`: the account is always true, so there is nothing to `record` or `withhold`.
`unavailable` seals immediately with the account actor — unlike a commit claim, which the trailer classifier holds back,
the honest floor here needs no evidence — and an offline re-derivation may amend it individually later (§8).

The decision record, `method.params.owner_login_decision` (hash-covered; stripped from any client body on `POST /events`
the way `claim_decision` is, `router.ts:817–823`):

```json
{ "policy": "owner-login/1", "observer": { "producer": "github-webhook", "sealed_by": "webhook:github" },
  "login": "jordandru", "shared": true,
  "payload": { "body_sha256": "…", "head_sha": "…", "merge_commit_sha": null, "review_id": 5302879598, "comment_id": null },
  "decision": { "status": "declared_by_seat", "reason": null,
    "actor_written": { "type": "agent", "id": "claude-code", "on_behalf_of": "jordansboxing@gmail.com" },
    "evidence_level": "declaration_only",
    "declarations": [ { "id": "evt_…", "seq": 7401, "actor": { "type": "agent", "id": "claude-code" }, "sealed_by": "pinned:claude-code MCP (pinned) (signing)", "producer_sig_verdict": "verified" } ],
    "proximity_hints": 3,
    "context": { "read_head_seq": 7410, "read_head_hash": "…", "policy_digest": "…" },
    "window": { "from": "2026-09-24T09:33:57Z", "to": "2026-09-24T10:03:57Z", "basis": "ingress_at" },
    "received": { "webhook": "2026-09-24T10:03:57.412Z", "declaration": "2026-09-24T10:02:41.090Z" },
    "consumed": ["evt_…"],
    "ingress_at": "2026-09-24T10:03:57.101Z",
    "classification_ms": 41 } }
```

`sealed_by` stays `webhook:github` and the producer verdict `none`: the Worker did not fix this actor from a credential,
it derived it from a declaration, and the decision record says so. A `declared_by_seat` event is therefore **not** a witness
under trailer-consistency §3.3 (pinned ingress only) and counts in status under `agent_events_not_pinned`. Both are
correct: the seat's own declaration is the pinned event; this one is the webhook's echo of it.

## 5. Project policy fields

`project-policy-document.md` gains, under `github`:

```json
{ "github": { "shared_logins": ["jordandru"],
              "identities": { "retrace-claude-code[bot]": "claude-code" } } }
```

- `shared_logins`: logins that pinned seats act through. Set by the owner in the policy document (its `set_by` and
  digest are the authorisation; §2 of that note, the envelope). A login is added when a seat first declares an action under it, and
  removed under §6 step 6.
- `identities`: GitHub login → seat actor id, for per-seat identities (§6). Empty until step 5.

A webhook for a project without a policy document follows the existing pending rules (`router.ts:536–568`); this note adds
nothing there. A policy without `github.shared_logins` classifies nothing and the adapter behaves as today — the change
is opt-in per project, which is what a stranger's install needs.

## 6. Build order

1. **Ingestion hashes and the classifier** (core `github.ts`, `router.ts` webhook path, a small `owner-login.ts`;
   `store.ts` gains the `owner_login_consumption` table and the atomic event-plus-row write of §3.5; the artifact index
   serves the candidate read; policy schema gains `github`). Code, class C/S under the
   routing rules (`router.ts` is a security surface); builder cursor-agent, review Codex → claude-code. Deploy is
   Jordan's go.
2. **Status, doctor, `why`** (§7). Same PR or the next.
3. **The declaration convention as an environment rule** — appendix A becomes agent-ops 19 in the same pull request as
   step 1, so the rule and the code it needs land together (class (a); this note's gate covers the text).
4. **Seat scripts.** `~/.retrace/bin/gh-declare` (or equivalent) that hashes the body file, logs the declaration through
   the seat's own MCP path or credential, then runs `gh` and logs the outcome. Until it exists, seats log by hand as in
   §1.4 with the §3.2 params.
5. **[OWNER ACTIONS] Per-seat GitHub identities.** One GitHub App per seat (`retrace-claude-code`, `retrace-codex`, `retrace-grok`,
   `retrace-github-copilot`, `retrace-cursor-agent`), installed on `jordandru/retrace`, each seat's app private key kept
   with that seat (agent-rules 13; terminal-boundary skill for every step that touches a key), `gh` run with an
   installation token minted by the seat's own helper. `githubActor` maps a login listed in `github.identities` to
   `{ type: agent, id: <seat> }` with `owner_login_decision.status: identity_mapped` (no declaration needed; the identity
   is GitHub's, the mapping is the policy's). A GitHub App is the sanctioned route: GitHub's terms allow one free
   personal account per person, and machine-user accounts would each need an e-mail and 2FA; an App's identity is
   `<slug>[bot]`, which `BOT_RE` already recognises. Creating and installing the apps and setting the policy are owner
   actions (rule 14), one go each. Effects to record when they land: rule 11's "the GitHub review is a COMMENT" exists
   because GitHub refuses request-changes on the owner's own pull request; with seat identities that constraint lifts,
   and a later class (a) change may let the verdict copy be a real review.
6. **[OWNER ACTION] Remove the shared mark.** When a login has had no `declared_by_seat` or `conflicting` event for 30 days of live
   operation and every seat has an identity in `github.identities`, the owner removes it from `shared_logins` and the
   adapter writes `human` for that login again — on measured absence of seat use, not by default.

Order 1 → 2 → 3 land together or in sequence; 5 waits on nothing in 1–4 but on the owner's time; 6 waits on 5.

## 7. Consumers

- **Status.** `capture.owner_login_events: { total, sealed_as_human, by_status: { declared_by_seat, conflicting, unresolved,
  unavailable, identity_mapped }, read_time_labels: { declared_by_seat, conflicting, unresolved } }`. `sealed_as_human` is the
  historical count (650 today) and falls only by individual amendment; `read_time_labels` applies §4 to those historical
  events using declarations and outcome records (§3.2) and is labelled "computed at read, not sealed". The text line:
  `GitHub owner-login events: 650 sealed human (before adoption) · read-time: 61 declared-by-seat · 589 unresolved`
  (numbers illustrative; the real ones come from the build).
- **Doctor.** `--gate` fails when a `github_payload.login ∈ shared_logins` event sealed after adoption carries
  `actor.type: human` (a producer defect, the shape of `model_claim: absent`). A `declared_by_seat` webhook event counts as
  agent evidence in `sealedLooksAgent` (`doctor.ts:226`) for the why-chain checks. No other gate change.
- **`why` / UI / report.** The account actor renders as "GitHub account jordandru (shared login) — who acted: unresolved"
  or "… — declared by claude-code (evt_…), not identity-verified"; a `declared_by_seat` event is always rendered as a
  declaration, never as an established actor (NOOA round 1, N2); never as a person's name when the status is not
  `declared_by_seat` or `identity_mapped`.
- **Export and verify.** The decision is inside the hashed event; `verifyExportBundle` needs no change. An offline
  re-derivation tool (`retrace-export owner-login --recompute`) recomputes §4 from the bundle for T2.
- **Trailer classifier and reconcile.** Unchanged: webhook seals are not witnesses (trailer-consistency §3.3) and this note
  does not make them so.

## 8. Corrections

- A historical event whose read-time label is `declared_by_seat` (a declaration or an outcome record exists) may be amended
  **individually** on the owner's go, citing the declaration, to the seat's actor. The mechanism is the attribution
  amendment of `attribution-v7-contract.md` where its target rules admit a `pr:` artifact event with `whole_event: true`;
  where they refuse (the contract was written for edit evidence on files), a narrow amendment kind
  `owner-login-correction/1` is specified in the step-1 PR — or the event stays labelled at read time. Either way the
  seal stays; the amendment is appended (rule 10).
- No batch amendment. The 650 are reported as `sealed_as_human` for as long as they exist; that number is the honest
  record of the defect's size before adoption.
- An `unavailable` seal is re-derived offline and amended individually if a declaration existed at its read head.

## 9. Public claims

`site/landing/index.html:140` says "Humans appear as themselves; when an agent relays your instruction, the ledger says
so." Under this defect agents also appear as the human. The sentence is issue #74's and the plan's P4 (§6 Q5, accepted
recommendation: correct now); this note does not edit it, and the landing footer must name the revision when P4 does.

## 10. Scope and limits (stated, not solved)

1. **Logins not marked shared keep today's mapping.** A collaborator's login is still written `human` by inference. The
   policy field is the only thing that distinguishes "shared" from "a person"; the note does not claim to know which
   logins are which without it.
2. **A declaration proves the declaration.** A seat could declare content another seat is about to post (the T31 shape of
   trailer-consistency §4) — or, cheaper, copy content it has just seen posted and declare it before the Worker receives
   the webhook (Codex round 1, F2; the receipt-time rule in §3.3 narrows this to the delivery gap and cannot close it).
   Two declarers are `conflicting`; one wrong declarer is `declared_by_seat` and wrong. **The classifier cannot tell a
   true declaration from a false one; per-seat GitHub identities (§6 step 5) are the only mechanism that closes this
   gap, and until then `declared_by_seat` with `evidence_level: declaration_only` is the honest label** (NOOA round 1, N2).
3. **The window is a guard, not a proof.** A retried `gh` call more than 30 minutes after its declaration is
   `unresolved`, and the seat re-declares. Two identical operations in one window need two declarations; the second
   without one is `unresolved`, and the note prefers that to guessing which declaration meant which.
3b. **Honest collisions are bounded by the key, not eliminated.** The action-defining fields of §3.2 stop a body-only
   match from covering a title edit or another review state (Codex round 1, F3); a truly identical repeated operation
   (same body, title, state and commit) is distinguished only by consumption order.
4. **Body normalisation** may need extending after the step-1 measurement (§3.4, T3).
5. **`unavailable` seals the account without evidence** and depends on later re-derivation; it never seals `human`.
6. **The read-time label is not the seal.** Two readers with different exports can compute different labels for a
   historical event if one export lacks the declaration; the label carries the export head it was computed at.
7. **Merges via `git push`** produce a `closed`/merged webhook with `merged_by` = the pusher's login; the merger's `merged`
   declaration with `merge_commit_sha` is the match. A merge from the GitHub web button by Jordan has no declaration and
   is `unresolved` until step 5 gives seats identities and the owner's login stops being shared.
8. Nothing here changes `push` classification, `workflow_run`, or the Drive adapter (#61, P7).

## 11. Acceptance tests (each names what it closes)

- **T1.** A comment webhook from a shared login with one eligible declaration (pinned, verified, matching `body_sha256`,
  inside the window) seals `actor` = the seat, `status declared_by_seat`, the declaration listed. Closes the plan's first
  "done when".
- **T2.** The same event's decision is recomputed byte-identically from an export bundle (`read_head_seq`, payload hashes).
- **T3 (measurement).** One real comment, one review, one PR body edit and one PR open posted through `gh` with a
  declaration; each webhook `body_sha256` equals the seat's; any mismatch is recorded here with the normalisation fix.
  **Measured so far on PR 130 itself (nine declared writes: one `pr_open`, eight reviews):** every declared `body_sha256`
  equals the sha256 of the body GitHub stores after §3.4 normalisation — nine of nine; one review (`evt_1d10e43e…`) was
  attached by GitHub to a commit other than the declared one because a push landed two seconds before the post, which
  T3's body check alone would pass and the §3.2 review key would not; the eight review declarations used `state` /
  `commit_id`, the spellings §3.3 now normalises (R1-M1). `comment` and `pr_edit` remain unmeasured (the Grok seat's
  round-1 finding R1-L1).
- **T4.** Two seats declare the same body hash → `conflicting`, the account is written, both declarations listed.
- **T5.** A declaration sealed `owner` (relayed through the owner token) or with verdict `none` is not eligible →
  `unresolved`; the decision lists it under `proximity_hints`, not `declarations`.
- **T6.** A declaration with the right PR and time but a different `body_sha256` → `unresolved` / `proximity_only`.
- **T7.** A declaration outside the 30-minute window → `unresolved`; the same one inside → `declared_by_seat`.
- **T8.** A login not in `shared_logins` → today's `human` mapping, no decision record. A project with no
  `github.shared_logins` → identical bytes to today's seal (regression guard).
- **T9.** Store error / budget → `unavailable`, account actor, nothing `human`; a `POST /events` body carrying
  `owner_login_decision` has it stripped.
- **T10.** Status reports `owner_login_events` with `sealed_as_human` unchanged by any read-time label; the read-time
  label of a historical event flips to `declared_by_seat` when a matching outcome record with `review_id` exists.
- **T11.** Doctor `--gate` fails on a post-adoption shared-login event sealed `human`; passes on `declared_by_seat` and
  `unresolved`.
- **T12.** A login in `github.identities` → the mapped seat actor with `status identity_mapped`, no declaration needed;
  an unlisted `[bot]` login keeps today's `system`/`agent` heuristic.
- **T13.** A merge webhook whose `merge_commit_sha` matches the merger's `merged` declaration → `declared_by_seat`
  (claude-code); the same merge with no declaration → `unresolved`.
- **T14a (F1, lookup).** The real PR 130 opening: declaration `evt_df2d386c…` (branch, commit and body-file artifacts,
  no PR artifact) and the real webhook `created` payload; the §3.5 candidate read by branch and head sha returns that
  event. It is then **refused by the predicate**, because the real declaration predates v1.1 and carries no
  `title_sha256` (Codex round 2, R2-L1): the expected classification of the real event is `unresolved` /
  `proximity_only`, and the test asserts exactly that.
- **T14b (F1, classification).** The same payload against a compliant `pr_open` declaration (branch, `head_sha`,
  `body_sha256`, `title_sha256`) → `declared_by_seat` (claude-code) through the lookup, never by handing the declaration
  to the predicate.
- **T15 (F2).** A declaration whose caller `timestamp` is earlier than the action but whose seal time (`received_at`) is
  later than the delivery's `ingress_at` → `unresolved`; the same declaration sealed one second before `ingress_at` →
  `declared_by_seat`; an outcome record (`github_action.result`) sealed before `ingress_at` → not a declaration,
  `unresolved`; a declaration and an action in the same GitHub second → `declared_by_seat`.
- **T16 (F3).** After a declared and matched `pr_edit` (body and title), a title-only edit within the window with the same
  body → `unresolved` / `no_declaration`, never `declared_by_seat`; a `review` declaration with `review_state: commented` does
  not match an `approved` review of the same body, nor a comment on a different `commit_id`.
- **T17 (F3).** Two identical comments posted after one declaration → the first `declared_by_seat`, the second
  `unresolved`; the decision of the first lists the declaration under `consumed`, and the consumption table holds one
  row for it. Sequential and concurrent variants: two deliveries classified in parallel both choose the declaration;
  exactly one atomic write succeeds and is `declared_by_seat`; the other fails the write, reclassifies at the new head,
  sees the consumption, and seals `unresolved`; a contrived third contender whose second write also fails seals
  `unresolved` / `allocation_failed` and never loops. A delivery that fails after classification and before the write leaves
  no row and no event; its redelivery classifies afresh. Replaying the export in `seq` order reproduces both decisions
  and the table.
- **T18 (R2-F2).** A declaration sealed after the delivery's `ingress_at` but before the webhook seals → `unresolved`;
  the same declaration sealed one second before `ingress_at` → `declared_by_seat`; a delivery drained from the pending
  queue carries its original `ingress_at`, and a declaration sealed between arrival and drain → `unresolved`.
- **T19 (R2-F3).** Two same-seat eligible declarations for one comment → the lower `seq` is consumed; the decision names
  it; the other stays available for the next identical operation.

## 12. Open questions for the gate

*Round 1 (Codex, `evt_cc16a99f…`, 2026-09-26): Q1 — immediate `unavailable` sealing at the account floor is reasonable;
Q2 — thirty minutes is a workable stated heuristic, not proof, and F2 (server receipt time) is the real fix; Q3 —
carrying `on_behalf_of` is consistent with the credential's principal relationship but is not approval of the
individual action; Q4 — v7 admits `pr:` output units in principle (`whole_event` is derived, not supplied) but not the
used-only comment/review events or later outcomes as prior evidence, so the read-time-only fallback of §8 is necessary
unless a separately gated correction contract is built; Q5 — one App per seat is confirmed: installations of one App do
not yield distinct identities. The questions stay listed for NOOA and the Grok seat.*

1. Should `unavailable` seal immediately with the account (this note) or defer to the pending queue like a commit claim?
   The coordinator prefers sealing: the account is true without evidence, and a missing event is worse than a labelled one.
2. Is 30 minutes the right window, and should it be a policy field?
3. Should the `declared_by_seat` actor carry `on_behalf_of` from the declaration, or only `id`? The note carries it because
   the seat's pinned credential names its principal; the webhook adds no knowledge of the principal.
4. Does `attribution-v7-contract.md` admit a `pr:` artifact event as a non-Git target with `whole_event: true`, or is
   the narrow amendment kind needed (§8)?
5. Step 5: one App per seat (this note) or one App with per-seat installations? The coordinator sees no way for one App
   to yield five `sender.login`s and asks the gate to confirm or refute.

## 13. Record

| What | Event |
|---|---|
| Q1–Q4 presented | `evt_e5ce6a0ed09e40bc8cd39b57b8801ecf` |
| Jordan: accept all four, draft the P1 note | `evt_603025a3932a4193a23f16b49b742f96` |
| This note's own pull request declared under §3.2 before `gh pr create` (first live sample; found the `pr_open` gap) | the declaration and outcome events are cited in the pull request's first coordinator comment or its body |
| Round 4 routing: Codex `evt_c47d00d6556048b797404bc01d4073ec`, NOOA `evt_9cceb4db63514a179e2e96b7881a3310`; Grok seat (cursor-agent, Jordan's reassignment `evt_cd9d5b806e574250bfa6069f14fd280f`) first pass `evt_01c2d719d55e41358097bf016efdfa93` | verdicts Codex `evt_34361117eb5d4745835616bf5442615c` (approved, 1 L), NOOA `evt_b3ad9f6c0d1b4ba6a2c13e3717baccff` (approved; 2 items labelled Medium, 2 L), cursor-agent `evt_238adda495d04d6c8307bb4d39c760d6` (rejected, 1 M 2 L) |
| Jordan: final text touch, then re-check to all three | `evt_1e00d0a0b1804e68b3b66af34d6db2e2` |
| Round 3 routing: Codex `evt_def09a367c464cfbae4267282d38a43c`, NOOA `evt_3e96c4ce48994c37a9babdff09dc3158` | verdicts Codex `evt_c906656c7cd344cb9c52f43d74dffecc` (rejected, 1 M 1 L), NOOA `evt_22fff7f3bdcc4817b204750a121a4a3d` (approved, no findings) |
| Jordan: v1.3 in place, then round 4 | `evt_3cf2f506b8e948ca9bd66b6fdb0b87f8` |
| Round 2 routing: Codex `evt_a43ebb9311d44b67ae93ba6be56d6dd5`, NOOA `evt_1d15d1c2040b440da63f5f5c40dbcce0` | verdicts Codex `evt_2a358258d9c54624a49c0fa769e09e98` (rejected, 2 M 1 L), NOOA `evt_ca197d293b1d40f1905cc00dafc64be3` (approved, no findings) |
| Jordan: v1.2 in place, then round 3 | `evt_eaab62d8b9e842f29d04f17bd21881bc` |
| Round 1 routing: Codex `evt_a3d7385b94bd435fa4a00b63cb7f1643`, NOOA `evt_0efbeca427544acfbc3385c0c0fae754` | verdicts Codex `evt_cc16a99f33ab467895ddc5831adc6043` (rejected, 3 M), NOOA `evt_45521b66918f4938919b26768995bf80` (rejected, 3 M 2 L) |
| Jordan: wait for NOOA, then fix both in place | `evt_4be7266d49b64e1e94c8d4da4a0ff875` |
| Live samples (T3): PR open declared `evt_df2d386c…` / outcome `evt_0efdea31…` / webhook `evt_2f60cfc7…` / measurement `evt_01d82280…`; eight review copies posted (5324545359, 5324576986, 5324633884, 5324642069, 5324722585, 5324731435, 5324806453, 5324807066), each declared first, each body hash matched on read-back; one commit mismatch on `evt_1d10e43e…` (push/post race) | nine body matches of nine; one commit mismatch; `comment` and `pr_edit` unmeasured (R1-L1) |
| Probe over the export slice (numbers in §1.2–§1.4) | script `~/.retrace/handoff-2026-09-26/probe-owner-login.py` (sha256 `0cf23d48630ac967…`), results on this file's edit event |

## 14. Review disposition

**Round 1 (head `57299cf`).** Codex (`gpt-6-astra`, high) REJECTED, `evt_cc16a99f…`, three Medium: F1 the §3.5 lookup
by PR number cannot find a branch-keyed `pr_open` declaration (the live sample would have been `unresolved`) → §3.5 now
queries branch and head-commit keys too; T14. F2 eligibility compared caller-controlled `E.timestamp` and did not
exclude outcome records → §3.3 now uses the Worker's `received_at` on both sides, excludes any `github_action` with
`result`, ignores GitHub's one-second payload times for eligibility, and states the residual delivery-gap; T15. F3
body-only keys for `pr_edit` and `review` → §3.2 keys carry `title_sha256`, `review_state` and the reviewed commit, a
declaration is consumed once; §2.2 no longer says "proves"; T16, T17. Codex confirmed: no pinned-authority escalation;
webhook seals stay out of witness sets; account floor and immediate `unavailable` sound; v7 cannot correct used-only
events; probe reproduced; one App per seat (§12 answers).
NOOA (`nemotron-3-ultra`, effort not applicable) REJECTED, `evt_45521b66…`, three Medium and two Low: N1 D1 and §2.1
presented the account actor as what the webhook carries, hiding that the payload signals a User and the switch is a
policy decision → reworded in D1, §2.1 and §4. N2 `seat_declared` and an agent actor imply established authorship →
status renamed `declared_by_seat`, `evidence_level: declaration_only` added, §7 renders it as a declaration, §10 limit 2
elevated. N3 §1.3 "never selects one" false for the one-seat rows → reworded with the numbers. N4 (Low) steps 5–6 not
marked as owner actions in the list → prefixed. N5 (Low) "→ unnecessary when" reads as self-revoking → **declined**: it
is agent-ops' standing form for every environment rule (its preamble), which NOOA could not see from the packet and said
so; one clause naming the convention added. Both stop rules were met (three Mediums each); Jordan decided
`evt_4be7266d…`: fix both in place as v1.1. Coordinator gate checks `evt_c33340b299c74191b62d25cfd41be434` (Codex) and
`evt_30b04532658b434484314a3da78663d5` (NOOA).

**Round 2 (head `e518caef`).** NOOA (`nemotron-3-ultra`) APPROVED, `evt_ca197d29…`, no findings: N1–N3 resolved
everywhere they appeared, N4 applied, N5 rightly declined, F1–F3 consistent with N1–N3. Codex (`gpt-6-astra`, medium)
REJECTED, `evt_2a358258…`, two Medium and one Low: R2-F2 (F2 re-raised) the v1.1 cutoff `G.received_at` is the webhook
seal's time, set inside `sealEvent` after the router's reads, so it does not exist at classification and a declaration
sealed in the gap passes → §3.1 records `ingress_at` at HTTP arrival, carried through queue and retry; §3.3 compares the
declaration's seal time against it and restates the residual gap; T18. R2-F3 (F3 re-raised) consumption lived only in
webhook-sealed decisions the pinned-only read never sees → §3.5 adds the `owner_login_consumption` table, a second
bounded read, earliest-`seq` allocation for same-seat duplicates, insert-if-absent before the seal, retry reuse, and
offline reconstruction from the sealed `consumed` lists; T17 extended, T19. R2-L1 (Low) T14 expected the real, pre-v1.1
declaration (no `title_sha256`) to classify → split into T14a (lookup finds it, predicate refuses it, `unresolved`) and
T14b (a compliant declaration classifies). Codex confirmed closed: F1, F2's caller-time and outcome parts, F3's keys,
N1–N5 dispositions, the `other`-action cases, and the race handling (no relaxation of the commit key). Gate checks
`evt_84ae7ea12d234720a7b698be52b4cd8a` (NOOA) and `evt_750549417fd44edabc9c88c91be44559` (Codex); Jordan's go for v1.2
and round 3 `evt_eaab62d8b9e842f29d04f17bd21881bc`.

**Round 3 (head `7a6336f6`).** NOOA APPROVED, `evt_22fff7f3…`, no findings: R2-F2, R2-F3 and R2-L1 resolved as the
dispositions say, N1–N3 undisturbed. Codex (medium) REJECTED, `evt_c906656c…`, one Medium and one Low: R3-F1 (R2-F3
re-raised) the v1.2 pre-seal reservation was unsealed mutable state — a stalled delivery A holding declaration E while B
reads the row and seals `unresolved` leaves B's decision irreproducible from the export, and a failed append leaves a
row with no seal (shown on the append primitive with an expired deadline) → §3.5 item 3 rewritten: no reservation; the
consumption row and the consuming event are one atomic store write; a primary-key failure re-runs classification at the
new head rather than retrying the append; the replay contract is exact (row iff a sealed decision lists it); the
push-only drain is named as a build item; T17 rewritten. R3-L1 (Low) §6 step 1 said `store.ts` gains no table, the §4
example's window basis said `received_at`, T15 spoke of the webhook's receipt → all three synchronised. Codex confirmed
closed: R2-F2 (capture point after signature verification and before the pending/policy reads; `PendingDelivery.received_at`
can carry the value), R2-L1, and the read and allocation halves of R2-F3. Gate checks `evt_3999f2ae4ae34287998dbff7b7e56cee`
(NOOA) and `evt_344115e8ad4b4614aee620af1038c70f` (Codex); Jordan's go for v1.3 and round 4 `evt_3cf2f506b8e948ca9bd66b6fdb0b87f8`.

**Round 4 (head `184dd6ae`) and the Grok seat's first pass.** Codex (medium) APPROVED, `evt_34361117…`, one Low: R4-L1 the
§3.5 overview still said "one insert, then the seal" → reworded. Codex confirmed R3-F1 closed (D1 `batch` is a documented
transaction; both stores already batch the event with its index rows; an uncertain response is resolved by idempotent
lookup) and R3-L1 closed. NOOA APPROVED, `evt_b3ad9f6c…`, its Findings carrying two items labelled Medium and two Low on an
approval (labels kept as written; team-roles rule 8): N4-M1 D1 batch atomicity not visible in its packet → §3.5 item 3
now cites the documented rollback, the existing batch boundaries and the uncertain-response rule; N4-M2 no bound on
reclassification → one re-read, then `unresolved` / `allocation_failed` (§4 row, T17); N4-L3 576 vs 650 unexplained →
§1.2 parenthetical; N4-L4 "[specific]" read as a placeholder → **declined**: it is agent-ops' own tag. The Grok seat
(cursor-agent, `Cursor Grok 4.6` high, Jordan's reassignment) REJECTED, `evt_238adda4…`, one Medium and two Low: R1-M1 the
coordinator's eight live review declarations carry `state: "COMMENT"` / `commit_id`, not `review_state: commented` /
`head_sha`, so §3.3 as written would match none of the note's own samples → §3.3 field normalisation, §1.4 reworded, T16
unchanged in meaning; R1-L1 T3/§13 under-reported the samples → nine body matches, one commit mismatch, two kinds
unmeasured, now stated; R1-L2 appendix A omitted the sequencing lesson → sentence added. The Grok seat confirmed: the probe
reproduces; live status 662 = 650 + PR 130's twelve webhook seals; T14a's lookup finds the real declaration by branch or
commit and the predicate rightly refuses it; the 2,000-row budget is realistic (busiest window 56 rows); every citation
and event id lands. Gate checks `evt_c6cfcea520b441e4902260be7f92f926` (Codex), `evt_69411ebc9168421395d0ab2a79749c90`
(NOOA), `evt_1cd43cb3c583455fbb71f38558a37fb2` (Grok seat). This version is the touch Jordan ordered in
`evt_1e00d0a0b1804e68b3b66af34d6db2e2`; a re-check round for all three seats follows under agent-rules 11.

## Appendix A — proposed agent-ops 19 (lands with step 1)

> 19. **Declare every `gh` write before you run it.** `gh` authenticates as the repository owner for every seat (agent-rules
> 11), so the GitHub webhook cannot see which seat acted; until per-seat GitHub identities exist
> (`docs/design/github-owner-login-attribution.md` §6 step 5) the seat's own pinned event is the only evidence. Before a
> `gh pr comment`, `gh pr review`, `gh pr create`, `gh pr edit`, `gh pr merge` or a push to a pull-request branch, log one
> event under your own credential with the pull request as an artifact and `method.params.github_action` — `kind`, `repo`,
> `login`, and the content the kind needs: the sha256 of the body file (normalised: UTF-8, `\r\n`→`\n`, trailing
> whitespace and trailing newlines removed), the full sha you will push, or the merge commit you will land. Then run the
> command; afterwards you may log the outcome (`executed`, `github_action.result` with the review or comment id). A `gh`
> write with no declaration seals as the GitHub account with `status: unresolved`, and that is the record of the
> omission. Never declare content you did not write and will not post yourself. **Never push to the pull request between
> a review declaration and its post**: GitHub attaches the review to the head at post time, and a declaration for the
> earlier commit no longer matches (measured on PR 130, `evt_1d10e43e…`); declare after the push, or re-declare.
> → unnecessary when [specific] (agent-ops' standing form: every environment rule names the product change that retires
> it; the rule binds until that change is measured, not before): every seat runs `gh` under its own GitHub App identity listed in the project policy's
> `github.identities` (step 5), and the owner's login is no longer in `github.shared_logins` (step 6).
