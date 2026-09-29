# Owner-login step 1 — T3 live measurement, 2026-09-29

**Status:** v1.2, 16:47Z 2026-09-29 — round-1 findings applied in place (Codex R1-M1/M2/M3 `evt_ae2435e61ba2441989746ada805fc09c`, Grok seat M1/L1/L2 `evt_6a8040b0249444209a853660125ae10e`, NOOA M1 `evt_2008c8cb31fd43dba80cda555bc51a71`; Jordan's go in §5): the declaration-to-ingress interval corrected (21–89 s, not 2–5 s), sample timing corrected, the cold-start and future-behaviour sentences scoped to what the seals show, `head` removed from the reads inside the classifier's stopwatch, counts made consistent, later deliveries added to §3. v1.1 16:07Z carried samples 1–5; v1 16:02Z samples 1–4. v0 skeleton opened the pull request at 15:46Z. Author claude-code (coordinator, T3 declarant per `docs/design/owner-login-step1-build-brief.md` §7). Class (b) on
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

**Later classified deliveries on this pull request** (same login, same policy; every one `system` `github:jordandru`, `unavailable` /
`deadline`, `classification_ms 300`, `consumed []`): sample 6, the push of `a449f9a` (declaration `evt_23c3db87ba424fcfb4c184c1e30cbeea` 9455 →
synchronize seal `evt_93a8fcf0c2434ef0a807caa8d5b76d6a` 9457); sample 7, the coordinator's summary comment 5894054632 (declaration
`evt_c7b56332e91e42dbb974766f5d121ec4` 9460 → seal `evt_65db1fc072b54d58ba155d6c7610b2cc` 9461); and the three round-1 verdict copies posted
as declared COMMENT reviews — Codex 5355627713 (seal `evt_25be1afe…` 9493), Grok seat 5355634617 (`evt_630f9aeb…` 9495), NOOA 5355653171
(`evt_ac8d9a0f…` 9499). Ten classified deliveries between 15:49:05Z and 16:42:1xZ; ten deadlines. The push that lands this text is the eleventh
and is recorded in the ledger under the same declaration shape.

**Timing of the declarations, by the Worker's clock** (declaration `received_at` → delivery `ingress_at`; corrected on round 1, Codex R1-M1 and
Grok M1 — the v1.1 text said "2–5 s", which is GitHub's `payload_time` → `ingress_at`, a different interval): samples 1–7: 41.1, 25.8, 25.1,
88.9, 23.7, 31.4, 21.2 s. `payload_time` → `ingress_at`: 3.6, 2.8, 2.4, 2.6, 2.5, 2.4, 2.5 s. Every declaration is inside the 30-minute
window and inside the read head. Samples 1–4 ran two minutes apart over six minutes (15:49–15:55Z); samples 1–5 span 17 min 3 s with a
10 min 39 s gap before sample 5; sample 1's ingress was 11 min 13 s after the deploy receipt `evt_dbab087f…` (15:37:52Z) and 4 min 11 s
after Jordan's T3 go.

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

1. **The defect P1 names is closed for these kinds.** None of the classified deliveries on this pull request sealed as `human:jordandru` (five at v1.1; ten by 16:42Z, §3). Each sealed as the GitHub
   account `system github:jordandru` with the hash-covered `github_payload` (login, body/title hashes, head, branch, `ingress_at`,
   delivery) and a decision record — the account floor of N§4, which never seals `human`.
2. **T3-F1 — the classifier does not finish within its budget on the live D1.** In every classified delivery measured (5 of 5 at v1.1;
   10 of 10 by 16:42Z, §3) the decision is `unavailable` / `deadline` with `classification_ms 300` = `OWNER_LOGIN_DEADLINE_MS`, so an
   eligible, hash-matching, pinned declaration — sealed 21–89 s before ingress by the Worker's clock, inside the read head every time — was
   **not consumed**, and the seal names no seat. The miss recurred on every delivery over 53 minutes (15:49–16:42Z), at spacings from two
   minutes to eleven; the seals carry no cold/warm or per-stage observation, so **whether a cold isolate contributed is not observed**
   (Codex R1-M2), and the failing read is not identified: the decision record has one `classification_ms`, no per-stage timing. Inside the
   classifier's stopwatch (`owner-login.ts` `classifyOwnerLogin`, started at entry) are the candidate lookup (`eventsReferencingArtifacts`
   on the PR/branch/commit keys), the consumption lookup (`ownerLoginConsumptionUpTo`), the amendment evaluation (`evaluateAmendmentsAtU`)
   and the computation between them; the head and policy reads run **before** the stopwatch (`appendOwnerLoginEvent`, lines 200–205)
   and cannot have spent it (Codex R1-M3). The failure is fail-closed (N§4 row "evidence read failed / over budget") and correct as
   specified. **None of the measured deliveries attributed a seat**; the code classifies each delivery afresh, so later deliveries are
   unmeasured, not disabled — no fix-dependent condition exists in the code. Same family as the 2026-09-15 shadow deadline (`classify.ts`
   `store.all` on the hot path; memory `retrace-shadow-deadline-store-all`), where the amendment evaluation was the cause; unmeasured here.
3. **T3-F2 — the offline recompute did not finish within either timeout on the live export** (`retrace-export owner-login --recompute
   --bundle <19,939,132-byte export of 9,442 events>`: killed at 240 s, then at 590.04 s wall with 497 MB resident and no output —
   `evt_009be63c5cd441378e3609aa1451b247`). What two timeouts prove: not under ten minutes; nothing about the runtime beyond that. N§8's remedy for an
   `unavailable` seal is exactly this tool, so its runtime on a real export is part of the finding.
4. **Normalisation: nothing to extend** (N§3.4). Four kinds measured live; `comment` and `pr_edit`, unmeasured on 2026-09-26 (R1-L1),
   now are.
5. **Operational:** `gh pr edit` fails in this repository on a deprecated GraphQL field (`projectCards`); the REST `PATCH` works and
   is one call, so one declaration covers it. Recorded for the seats' declaration practice (agent-ops 19).

**What this measurement does not show.** Whether the budget is missed by 10 ms or by seconds; which read misses it; whether a cold isolate
contributed to any sample; what any later, unmeasured delivery does; whether a D1 index
is missing for the artifact-index query on `pr:`/`git:`/`commit:` keys; whether the pending-queue drain (which classifies with the
same deadline) fares differently. The fix is a class S change to `owner-login.ts` / the D1 store and needs those numbers first:
recommended first step is per-stage `ms` in the decision record plus a Workers-Logs read of these deliveries, then the query plan.
No claim is made that the seals *would* have been `declared_by_seat`; the recompute (item 3) is the check that would show it.

## 5. Record

| what | event |
|---|---|
| Jordan: go on T3 | `evt_fb2c56a11f4341b087586c5f2563d7c7` |
| Owner steps that preceded it (Jordan's hand): D1 migration, deploy `c7f41377`, policy `/2` v2 | `evt_04c17e0c4f76493694508a82de703f8f`, `evt_dbab087fb9f045b3bb78a998f29ca83f`, `evt_a2b74a8530c14dce9df5a751b8a8d412` (activation `evt_a53d981bc6c246e69b856d63e856523b`, seq 9422) |
| Skeleton edit / commit `cf64068` (hook seal) / push seal | `evt_4de6025746b2401f9d88d5e7de9b0c4d` / `evt_04d50372ba4644c78c81b89c017aa058` / `evt_5337c67c0aab40bbbfc5c036e82f3720` |
| Samples 1–4: declarations, seals, outcomes | §3 table |
| Results edit / commit `130d951` (hook seal, replayed) / sample-5 push declaration / push seal / synchronize seal | `evt_b449d0d329a74adfb10ab0bfe4797d75` / `evt_5af8024e0ebb40198810e9a750313917` / `evt_19bcba47b6df466da1a44a8d5c702a72` / `evt_266e34c2809a4819bc1e58a116f0afae` / `evt_b6aa4ee027d14db3b22e67ec5f5fbd39` |
| Follow-up commit `a449f9a` (sample 6 = its push) | edit `evt_8a04864f8c4245f7a47d75843b497c01` / hook `evt_b39d5c0bdb5643b09931343c274bd1ed` / declaration `evt_23c3db87ba424fcfb4c184c1e30cbeea` / seal `evt_93a8fcf0c2434ef0a807caa8d5b76d6a` / outcome `evt_62b15261c01048c3a59923925fd55061` |
| Sample 7 (summary comment) and the recompute result | declaration `evt_c7b56332e91e42dbb974766f5d121ec4` / seal `evt_65db1fc072b54d58ba155d6c7610b2cc` / outcome `evt_91f39fa7345f47bcbf95a97e64bb31c7`; recompute `evt_009be63c5cd441378e3609aa1451b247` |
| Round 1 (head `a449f9a`, go `evt_ccd6aa52e1284c05afd7bdc6047db154`): routing Codex `evt_7fde28f1…`, Grok seat `evt_34089e02…`, NOOA `evt_8794b2a2…`; verdicts Codex rejected 3 M `evt_ae2435e61ba2441989746ada805fc09c`, Grok seat rejected 1 M 2 L `evt_6a8040b0249444209a853660125ae10e`, NOOA rejected 1 M `evt_2008c8cb31fd43dba80cda555bc51a71`; gate checks `evt_9bab3c56…`, `evt_6af533af…`, `evt_059061bf…`; copies 5355627713 / 5355634617 / 5355653171 | Jordan: apply all seven in place, then scoped re-checks — the go is the instruct event that precedes the v1.2 edit event in the ledger |
