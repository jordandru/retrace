# GitHub owner-login attribution — design note v1 (evaluation plan P1; issues #82, #69)

**Status:** DRAFT v1, 2026-09-26 (03:5xZ; 21:5x MDT 2026-09-25). Author claude-code (coordinator, `claude-fable-5-1`,
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

- **D1. The webhook knows the account, not the person.** For a GitHub login the project policy marks **shared** (a login
  pinned seats act through), the adapter never again writes `actor.type: human`. It writes the **account**
  (`type: system`, `id: github:<login>`) unless a seat's own declaration resolves the actor (§4).
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
events; script in the coordinator's scratchpad, results logged with this note's edit event):

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
the builder (edits) inside the same minutes. Proximity finds the pull request, not the hand on `gh`. An exact
`pr:jordandru/retrace#<n>` artifact on a pinned event within ± 30 min exists for 354 of the 576; it narrows the candidates
and never selects one. So the design binds evidence to **content** (§3), and the probe is the reason.

### 1.4 What seats already do, unstandardised

49 pinned events in the slice describe a `gh` action in their intent (claude-code 27, codex 19, cursor-agent 3); 14 carry
`method.params.body_sha256`, 23 a `github_review_id`, 4 `comment_copy_posted`. Example pair on PR 118 (2026-09-24): the
coordinator's `sent` `evt_b3827f2b…` (`pr: 118`, `body_sha256: 141777f2…`, `posted_by_seat: claude-code`,
`github_identity: "jordandru (owner, shared by every seat)"`) before the call, and `executed` `evt_42fed194…` (`review_id:
5302879598`, `submitted_at`) after it. The declaration this note defines (§3.2) is that practice made a schema, so the
Worker can match it.

## 2. Principles

1. **Write what the producer knows.** A signed webhook proves that GitHub saw the account `jordandru` perform the action.
   It does not prove a person did. `human` is an inference the payload cannot carry for a shared login; `system` /
   `github:<login>` (the account) is what it carries (issue #61 option 3, the same shape as #82 option 3).
2. **A seat's declaration is testimony, classified like a trailer.** It is admitted only from a pinned, producer-signed
   seat event (trailer-consistency §3.3's ingress rule), matched on content, and recorded with the decision. It
   establishes that the seat declared the action; what proves the seat performed it is the content match plus the
   absence of any other declarer. The gap is stated in §10.
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
| `body_sha256` | sha256 of the normalised body (§3.4) of the PR / review / comment | opened, edited, review, comment |
| `head_sha` | `pull_request.head.sha`; synchronize: `after` | opened, synchronize, review (`review.commit_id`) |
| `merge_commit_sha` | `pull_request.merge_commit_sha` | merged |
| `review_id`, `comment_id` | `review.id`, `comment.id` | review, comment |
| `delivery` | `X-GitHub-Delivery` | all |

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
  "head_sha": "<full sha the push or open will carry>",
  "merge_commit_sha": "<full sha the merge will land>" }
```

`kind`, `repo` and `login` are required; exactly the content field(s) the kind needs are required (`comment`, `review`,
`pr_edit`: `body_sha256`; `pr_open`: `body_sha256` and `head_sha`; `push`: `head_sha`; `merge`: `merge_commit_sha`).
The seat knows every one of these before the call: it wrote the body file, it has the sha it is about to push, the merger
has the merge commit before `git push`. After the call the seat may log an **outcome record** (`executed`,
`github_action.result: { review_id | comment_id | delivery }`); outcome records never enter the sealed decision (they
arrive after the webhook) but do enter read-time labels and individual amendments (§8).

### 3.3 Eligibility and window

A declaration `E` resolves webhook event `G` iff all hold:

- `E.project` = `G.project`; `E.method.params.sealed_by` starts with `pinned:` **and** `E.method.params.producer_sig_verdict`
  = `verified` (agent-rules 15's two checks; an owner-sealed or asserted declaration is a claim by the relayer, not the
  seat — Codex round-2 F4 on rule 15 applies here unchanged);
- `E.actor.type` = `agent`; `E.action_detail` ≠ `amended`; `E` is not the target of an effective attribution amendment at
  the read head;
- `E.github_action.repo` = the canonical repository of `G`, `E.github_action.login` = `G.github_payload.login`,
  `E.github_action.kind` matches `G`'s action (`pull_request` `edited` ↔ `pr_edit`, `synchronize` ↔ `push`, and so on);
- the content field(s) the kind requires are **equal** to `G.github_payload`'s (`body_sha256`, `head_sha`,
  `merge_commit_sha`);
- `E.seq` ≤ `U`, the read head at classification, and `E.timestamp` lies in `[G.timestamp − 30 min, G.timestamp]`, where
  `G.timestamp` is the payload time (`updated_at`, `submitted_at`, `created_at`, `merged_at`). The window is a guard
  against a stale declaration for an action that was retried a day later, not the evidence; the content match is.

`Decl(G)` = the set of eligible declarations; `Seats(G)` = their distinct `actor.id`s.

### 3.4 Body normalisation

GitHub stores what it received but may alter line endings and trailing whitespace. Both sides hash the same bytes: UTF-8,
`\r\n` → `\n`, trailing whitespace on each line removed, trailing newlines removed. One real post per kind is measured at
build time against the webhook payload (T3); if GitHub alters anything else, the normalisation is extended and the
measurement recorded here as a dated correction.

### 3.5 Read contract

One bounded query per webhook event: pinned events in `(U − N, U]` referencing `pr:<R>#<n>` through the existing
`event_artifact_index` (`eventsReferencingArtifacts`, PR 27), then filtered in memory on `github_action`. Budget 300 ms
and 2,000 rows (a pull request's index rows over 30 minutes are two orders of magnitude fewer than a commit's file
witnesses); over budget or any store error → `unavailable` (§4). The classifier records `read_head_seq` and
`read_head_hash` so the decision is reproducible from an export.

## 4. Decision table

Applies only when `github_payload.login` is in the project policy's `github.shared_logins` (§5). Every other login keeps
today's mapping (§10, limit 1).

| Case | `status` | `reason` | Recorded `actor` |
|---|---|---|---|
| `|Seats(G)| = 1` | `seat_declared` | — | the seat: `{ type: agent, id: <seat>, on_behalf_of: <the declaration's on_behalf_of> }` |
| `|Seats(G)| > 1` | `conflicting` | `multiple_declarers` | the account: `{ type: system, id: github:<login>, display_name: "<login> (GitHub account, shared)" }` |
| `Decl(G) = ∅`, some pinned event names the PR in the window | `unresolved` | `proximity_only` | the account |
| `Decl(G) = ∅`, none does | `unresolved` | `no_declaration` | the account |
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
  "decision": { "status": "seat_declared", "reason": null,
    "actor_written": { "type": "agent", "id": "claude-code", "on_behalf_of": "jordansboxing@gmail.com" },
    "declarations": [ { "id": "evt_…", "seq": 7401, "actor": { "type": "agent", "id": "claude-code" }, "sealed_by": "pinned:claude-code MCP (pinned) (signing)", "producer_sig_verdict": "verified" } ],
    "proximity_hints": 3,
    "context": { "read_head_seq": 7410, "read_head_hash": "…", "policy_digest": "…" },
    "window": { "from": "2026-09-24T09:33:57Z", "to": "2026-09-24T10:03:57Z" },
    "classification_ms": 41 } }
```

`sealed_by` stays `webhook:github` and the producer verdict `none`: the Worker did not fix this actor from a credential,
it derived it from a declaration, and the decision record says so. A `seat_declared` event is therefore **not** a witness
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
   `store.ts` gains no new table — the artifact index suffices; policy schema gains `github`). Code, class C/S under the
   routing rules (`router.ts` is a security surface); builder cursor-agent, review Codex → claude-code. Deploy is
   Jordan's go.
2. **Status, doctor, `why`** (§7). Same PR or the next.
3. **The declaration convention as an environment rule** — appendix A becomes agent-ops 19 in the same pull request as
   step 1, so the rule and the code it needs land together (class (a); this note's gate covers the text).
4. **Seat scripts.** `~/.retrace/bin/gh-declare` (or equivalent) that hashes the body file, logs the declaration through
   the seat's own MCP path or credential, then runs `gh` and logs the outcome. Until it exists, seats log by hand as in
   §1.4 with the §3.2 params.
5. **Per-seat GitHub identities.** One GitHub App per seat (`retrace-claude-code`, `retrace-codex`, `retrace-grok`,
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
6. **Remove the shared mark.** When a login has had no `seat_declared` or `conflicting` event for 30 days of live
   operation and every seat has an identity in `github.identities`, the owner removes it from `shared_logins` and the
   adapter writes `human` for that login again — on measured absence of seat use, not by default.

Order 1 → 2 → 3 land together or in sequence; 5 waits on nothing in 1–4 but on the owner's time; 6 waits on 5.

## 7. Consumers

- **Status.** `capture.owner_login_events: { total, sealed_as_human, by_status: { seat_declared, conflicting, unresolved,
  unavailable, identity_mapped }, read_time_labels: { seat_declared, conflicting, unresolved } }`. `sealed_as_human` is the
  historical count (650 today) and falls only by individual amendment; `read_time_labels` applies §4 to those historical
  events using declarations and outcome records (§3.2) and is labelled "computed at read, not sealed". The text line:
  `GitHub owner-login events: 650 sealed human (before adoption) · read-time: 61 seat-declared · 589 unresolved`
  (numbers illustrative; the real ones come from the build).
- **Doctor.** `--gate` fails when a `github_payload.login ∈ shared_logins` event sealed after adoption carries
  `actor.type: human` (a producer defect, the shape of `model_claim: absent`). A `seat_declared` webhook event counts as
  agent evidence in `sealedLooksAgent` (`doctor.ts:226`) for the why-chain checks. No other gate change.
- **`why` / UI / report.** The account actor renders as "GitHub account jordandru (shared login) — who acted: unresolved"
  or "… — declared by claude-code (evt_…)"; never as a person's name when the status is not `seat_declared` or
  `identity_mapped`.
- **Export and verify.** The decision is inside the hashed event; `verifyExportBundle` needs no change. An offline
  re-derivation tool (`retrace-export owner-login --recompute`) recomputes §4 from the bundle for T2.
- **Trailer classifier and reconcile.** Unchanged: webhook seals are not witnesses (trailer-consistency §3.3) and this note
  does not make them so.

## 8. Corrections

- A historical event whose read-time label is `seat_declared` (a declaration or an outcome record exists) may be amended
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
   trailer-consistency §4). Two declarers are `conflicting`; one wrong declarer is `seat_declared` and wrong. Per-seat
   identities (§6 step 5) close this; the classifier cannot.
3. **The window is a guard, not a proof.** A retried `gh` call more than 30 minutes after its declaration is
   `unresolved`, and the seat re-declares.
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
  inside the window) seals `actor` = the seat, `status seat_declared`, the declaration listed. Closes the plan's first
  "done when".
- **T2.** The same event's decision is recomputed byte-identically from an export bundle (`read_head_seq`, payload hashes).
- **T3 (measurement).** One real comment, one review, one PR body edit and one PR open posted through `gh` with a
  declaration; each webhook `body_sha256` equals the seat's; any mismatch is recorded here with the normalisation fix.
- **T4.** Two seats declare the same body hash → `conflicting`, the account is written, both declarations listed.
- **T5.** A declaration sealed `owner` (relayed through the owner token) or with verdict `none` is not eligible →
  `unresolved`; the decision lists it under `proximity_hints`, not `declarations`.
- **T6.** A declaration with the right PR and time but a different `body_sha256` → `unresolved` / `proximity_only`.
- **T7.** A declaration outside the 30-minute window → `unresolved`; the same one inside → `seat_declared`.
- **T8.** A login not in `shared_logins` → today's `human` mapping, no decision record. A project with no
  `github.shared_logins` → identical bytes to today's seal (regression guard).
- **T9.** Store error / budget → `unavailable`, account actor, nothing `human`; a `POST /events` body carrying
  `owner_login_decision` has it stripped.
- **T10.** Status reports `owner_login_events` with `sealed_as_human` unchanged by any read-time label; the read-time
  label of a historical event flips to `seat_declared` when a matching outcome record with `review_id` exists.
- **T11.** Doctor `--gate` fails on a post-adoption shared-login event sealed `human`; passes on `seat_declared` and
  `unresolved`.
- **T12.** A login in `github.identities` → the mapped seat actor with `status identity_mapped`, no declaration needed;
  an unlisted `[bot]` login keeps today's `system`/`agent` heuristic.
- **T13.** A merge webhook whose `merge_commit_sha` matches the merger's `merged` declaration → `seat_declared`
  (claude-code); the same merge with no declaration → `unresolved`.

## 12. Open questions for the gate

1. Should `unavailable` seal immediately with the account (this note) or defer to the pending queue like a commit claim?
   The coordinator prefers sealing: the account is true without evidence, and a missing event is worse than a labelled one.
2. Is 30 minutes the right window, and should it be a policy field?
3. Should the `seat_declared` actor carry `on_behalf_of` from the declaration, or only `id`? The note carries it because
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
| Probe over the export slice (numbers in §1.2–§1.4) | script `~/.retrace/handoff-2026-09-26/probe-owner-login.py` (sha256 `0cf23d48630ac967…`), results on this file's edit event |

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
> omission. Never declare content you did not write and will not post yourself.
> → unnecessary when [specific]: every seat runs `gh` under its own GitHub App identity listed in the project policy's
> `github.identities` (step 5), and the owner's login is no longer in `github.shared_logins` (step 6).
