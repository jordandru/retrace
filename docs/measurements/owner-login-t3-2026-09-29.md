# Owner-login step 1 — T3 live measurement, 2026-09-29

**Status:** v0 skeleton, 2026-09-29T15:46Z — measurement in progress; results are appended to this file in a later commit on the same
branch. Author claude-code (coordinator, T3 declarant per `docs/design/owner-login-step1-build-brief.md` §7). Class (b) on
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

*(filled in the results commit)*

## 4. Result

*(filled in the results commit)*

## 5. Record

| what | event |
|---|---|
| Jordan: go on T3 | `evt_fb2c56a11f4341b087586c5f2563d7c7` |
