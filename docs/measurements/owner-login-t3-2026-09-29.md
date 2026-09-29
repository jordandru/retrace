# Owner-login step 1 — T3 live measurement, 2026-09-29

**Status:** v1.1, 16:0xZ 2026-09-29 — samples 1–5 measured and recorded (v1 at 16:02Z carried samples 1–4; sample 5 was the push of that commit). v0 skeleton opened the pull request at 15:46Z. Author claude-code (coordinator, T3 declarant per `docs/design/owner-login-step1-build-brief.md` §7). Class (b) on
its own; travels with the note's dated correction, so the pull request is class (a). Go: `evt_fb2c56a11f4341b087586c5f2563d7c7`.

## 1. What is measured

The brief (§5, §3 item 5) requires, once the step-1 code is live and the `/2` policy is written: the coordinator declares and
posts **one PR open, one comment, one review and one body edit** on a scratch pull request, reads the four webhook seals raw,
compares `body_sha256` (and the other content fields the kind requires, note §3.2) against the declarations, and records the
result on the note as a dated correction (N§3.4) if the normalisation needs extending. This file is that record; the pull
request that carries it is the scratch pull request.

State at the start:

| what | value |
|---|---|
| Worker | `retrace-api` version `c7f41377-9a9d-4709-bb3d-0795fc5c23c6`, deployed from main `7fe60eb4` by Jordan's hand (`evt_dbab087fb9f045b3bb78a998f29ca83f`) |
| D1 | `pending_deliveries.gh_event` and `owner_login_consumption` applied (`evt_04c17e0c4f76493694508a82de703f8f`) |
| Policy | `retrace-project-policy/2` v2, digest `1b84362392f4…`, `github.shared_logins ["jordandru"]`, `identities {}`; activation `evt_a53d981bc6c246e69b856d63e856523b` seq 9422 (`evt_a2b74a8530c14dce9df5a751b8a8d412`) |
| Status before | `owner_login_events`: total 711, sealed_as_human 711, read-time unresolved 711, declared_by_seat 0, legacy_unknown_login 1,237 (computed at seq 9422) |
| Doctor before | READY; `owner-login` PASS "no shared-login human seals after first /2 adoption" |

## 2. Method

For each write, in this order: (1) the body (and title) file is written to `~/.retrace/ops-2026-09-29/t3/` and hashed after the
N§3.4 normalisation (UTF-8, `\r\n`→`\n`, trailing whitespace per line removed, trailing newlines removed); (2) a pinned
declaration event is logged with the artifact the classifier's candidate read needs (`git:<R>#<branch>` for `pr_open`,
`pr:<R>#<n>` otherwise) and `method.params.github_action` carrying exactly the content fields note §3.2 requires for the
kind; (3) the `gh` command runs as the shared login `jordandru`; (4) the outcome is logged with the GitHub id; (5) the webhook
seal is read raw (`GET /events/<id>`) and its `github_payload` and `owner_login_decision` compared with the declaration.

## 3. Declarations and seals

All five writes were made by claude-code through the shared GitHub login `jordandru` on pull request #137 (this pull request), base
`main`, head `cf64068402cdfeaaa8ebc51ea335c0b10cb8f9aa` for samples 1–4. Every declaration was sealed pinned (`pinned:claude-code MCP
(pinned) (signing)`, `producer_sig_verdict verified`) before the `gh` call; every seal was read raw with `GET /events/<id>`.

| # | kind | declaration (seq) | GitHub object | webhook seal (seq) | content fields: declaration = GitHub read-back = seal payload | seal actor | `owner_login_decision.decision` |
|---|---|---|---|---|---|---|---|
| 1 | `pr_open` | `evt_e053ded3284745b09d73f654201894e6` (9427) | PR #137, opened 15:49:04Z | `evt_36db59b32724438e840f39ade442d44f` (9429), ingress 15:49:05.606Z | `body_sha256 80b6cbf8…` = = ; `title_sha256 acfb8593…` = = ; `head_sha cf64068…` = = ; `branch`, `login` = | `system` `github:jordandru` | `unavailable` / `deadline`, `classification_ms 300`, `read_head_seq 9428`, `declarations []`, `consumed []` |
| 2 | `comment` | `evt_f893c19f7b174d81bbb7b2bd18e4c98e` (9432) | comment 5893719700, 15:51:02Z | `evt_9d015f8e517b4e1e9a0121ff79373121` (9434), ingress 15:51:04.839Z | `body_sha256 87f57084…` = = | `system` `github:jordandru` | `unavailable` / `deadline`, 300 ms, `read_head_seq 9433`, nothing consumed |
| 3 | `review` | `evt_9e927eb9cafe45c7b20980fad0987545` (9436) | review 5355096958, COMMENTED, 15:53:04Z | `evt_1a8ea7d398ab457ebfbab111edacd61c` (9437) | `body_sha256 8b38e5ea…` = = ; `review_state` `commented` (declared `commented`, GitHub `COMMENTED`, §3.3 alias) = ; `head_sha cf64068…` = = | `system` `github:jordandru` | `unavailable` / `deadline`, 300 ms, `read_head_seq 9436`, nothing consumed |
| 4 | `pr_edit` | `evt_d2981e639f1745c2be1171e0dc36f324` (9439) | body edited 15:55:27Z (REST `PATCH`; the first `gh pr edit` failed client-side on a deprecated GraphQL field and changed nothing, `evt_93313878207c4052b049c171c9631b03`) | `evt_b0a3a88cfa154aa9bcf6875159be0d24` (9441) | `body_sha256 4fa4e68c…` = = ; `title_sha256 acfb8593…` = = (title unchanged, both required by §3.2) | `system` `github:jordandru` | `unavailable` / `deadline`, 300 ms, `read_head_seq 9440`, nothing consumed |
| 5 | `push` (`pull_request` `synchronize`) | `evt_19bcba47b6df466da1a44a8d5c702a72` (9447) | push `cf64068..130d951`, 16:06:05Z (hook seal `evt_5af8024e…` 9446, replayed after a Worker fetch failure; push webhook `evt_266e34c2…` 9448) | `evt_b6aa4ee027d14db3b22e67ec5f5fbd39` (9449) | `head_sha 130d951…` = = ; `login` = | `system` `github:jordandru` | `unavailable` / `deadline`, 300 ms, `read_head_seq 9448`, nothing consumed |

Outcome events (agent-ops 19, `github_action.result`): 1 `evt_593e679bd1c74c32ac611cb6e44aa796`, 2 `evt_a704c46a7fbd4f94997a91e9e84c4e14`,
3 `evt_cef4963420d0462497004576fec8d360`, 4 `evt_7c4a26c2073e422c88859a6581595803`, 5 the outcome event that follows `evt_19bcba47…` in the ledger (its id is in the pull request's final coordinator comment).

**Normalisation probes (N§3.4).** The comment body carried a line with two trailing spaces, a blank line and no final newline; the review
body carried a literal tab, a line with one trailing space and no final newline. GitHub returned every body byte-for-byte (no `\r\n`
introduced, trailing spaces and the tab preserved, no newline appended); after the §3.4 normalisation every hash equalled the
declaration's, on the read-back and in the seal's `github_payload`. Nothing to extend.

**Status route** (`GET /projects/retrace/status`, `capture.owner_login_events`, computed at seq 9442, after sample 4): `total 715`,
`sealed_as_human 711` (all pre-adoption), `by_status.unavailable 4`, `declared_by_seat 0`, `read_time_labels.unresolved 711`,
`legacy_unknown_login 1,240`. The read-time labels are computed only for seals whose actor is `human` (`owner-login-status.ts`), so an
`unavailable` seal is never re-labelled at read time; the note's path for it is offline re-derivation and an individual amendment (N§8).

**Doctor** (retrace-main dist at `7fe60eb4`, live Worker): READY; `owner-login` PASS "no shared-login human seals after first /2 adoption"
— true, and it says nothing about `unavailable` seals.

## 4. Result

1. **The defect P1 names is closed for these kinds.** None of the four writes sealed as `human:jordandru`. Each sealed as the GitHub
   account `system github:jordandru` with the hash-covered `github_payload` (login, body/title hashes, head, branch, `ingress_at`,
   delivery) and a decision record — the account floor of N§4, which never seals `human`.
2. **T3-F1 — the classifier does not finish within its budget on the live D1.** In 5 of 5 deliveries (samples 1–4 and the `synchronize` of sample 5) the decision is `unavailable` /
   `deadline` with `classification_ms 300` = `OWNER_LOGIN_DEADLINE_MS`, so an eligible, hash-matching, pinned declaration sealed 2–5
   seconds earlier (inside the read head every time) was **not consumed**, and the seal names no seat. Samples were 2 minutes apart
   over 7 minutes, the first 5 minutes after the deploy; this is not a cold start. The decision record does not say which of the
   reads (`head`, `eventsReferencingArtifacts` on the PR/branch/commit keys, `ownerLoginConsumptionUpTo`, `evaluateAmendmentsAtU`)
   spent the budget — the record has one `classification_ms`, no per-stage timing. The failure is fail-closed (N§4 row "evidence
   read failed / over budget") and correct as specified; it means step 1 records evidence but attributes nothing live until the
   budget is met. Same family as the 2026-09-15 shadow deadline (`classify.ts` `store.all` on the hot path; memory
   `retrace-shadow-deadline-store-all`), where the amendment evaluation was the cause; unmeasured here.
3. **T3-F2 — the offline recompute did not finish in 4 minutes on the live export** (`retrace-export owner-login --recompute
   --bundle <19.9 MB export of 9,442 events>`; a second run with a 10-minute budget is recorded in the ledger). N§8's remedy for an
   `unavailable` seal is exactly this tool, so its runtime on a real export is part of the finding.
4. **Normalisation: nothing to extend** (N§3.4). Four kinds measured live; `comment` and `pr_edit`, unmeasured on 2026-09-26 (R1-L1),
   now are.
5. **Operational:** `gh pr edit` fails in this repository on a deprecated GraphQL field (`projectCards`); the REST `PATCH` works and
   is one call, so one declaration covers it. Recorded for the seats' declaration practice (agent-ops 19).

**What this measurement does not show.** Whether the budget is missed by 10 ms or by seconds; which read misses it; whether a D1 index
is missing for the artifact-index query on `pr:`/`git:`/`commit:` keys; whether the pending-queue drain (which classifies with the
same deadline) fares differently. The fix is a class S change to `owner-login.ts` / the D1 store and needs those numbers first:
recommended first step is per-stage `ms` in the decision record plus a Workers-Logs read of the four deliveries, then the query plan.
No claim is made that the four seals *would* have been `declared_by_seat`; the recompute (item 3) is the check that would show it.

## 5. Record

| what | event |
|---|---|
| Jordan: go on T3 | `evt_fb2c56a11f4341b087586c5f2563d7c7` |
| Owner steps that preceded it (Jordan's hand): D1 migration, deploy `c7f41377`, policy `/2` v2 | `evt_04c17e0c4f76493694508a82de703f8f`, `evt_dbab087fb9f045b3bb78a998f29ca83f`, `evt_a2b74a8530c14dce9df5a751b8a8d412` (activation `evt_a53d981bc6c246e69b856d63e856523b`, seq 9422) |
| Skeleton edit / commit `cf64068` (hook seal) / push seal | `evt_4de6025746b2401f9d88d5e7de9b0c4d` / `evt_04d50372ba4644c78c81b89c017aa058` / `evt_5337c67c0aab40bbbfc5c036e82f3720` |
| Samples 1–4: declarations, seals, outcomes | §3 table |
| Results edit / commit `130d951` (hook seal, replayed) / sample-5 push declaration / push seal / synchronize seal | `evt_b449d0d329a74adfb10ab0bfe4797d75` / `evt_5af8024e0ebb40198810e9a750313917` / `evt_19bcba47b6df466da1a44a8d5c702a72` / `evt_266e34c2809a4819bc1e58a116f0afae` / `evt_b6aa4ee027d14db3b22e67ec5f5fbd39` |
| Follow-up commit (this row; sample 6 = its push, declared) | the edit event and the `push` declaration that follow the sample-5 outcome in the ledger |
