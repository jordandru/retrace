# Owner-login step 1 — builder brief (classifier, ingestion hashes, consumers, agent-ops 19)

**Status:** v1.2, 2026-09-28 (v1.2 20:0xZ / 14:0x MDT: Codex round-1 REJECTED `evt_1e9f4144fb0042bf8bcb432d736554a2` — seven Medium F1–F7, zero High, zero Low — applied in place on Jordan's go `evt_5d5309168b6244c4aa1c20dbbab46e12`: F1 supported-profile handling across activation, selection and export verification; F2 `[bot]` App identities validate, case-only duplicates rejected; F3 the amendment fallback removed, the bounded evaluator named; F4 the consumption read bounded by the read head, with a dated correction to the note's §3.5 in this PR; F5 `received.webhook` sealed null, replay compares the sealed record, a dated correction to the note's §4; F6 status totals compare raw logins and state legacy coverage; F7 `after_seq: -1` and a sequence-zero fixture; plus Codex's clarifications applied — stripping under a signature, doctor's policy data path, pending retention for non-push timeouts, legacy outcome binding, payload fields listed as extensions, T14a labelling, T17 barrier placement. v1.1 21:3xZ / 15:3x MDT: NOOA round-1 Medium N1 `evt_b373209785314ca4a0a1fffc65b219a0` — §0 and §1.4
overclaimed byte-identity for unclassified seals while `github_payload` is added — applied in place on Jordan's go
`evt_7778c91baa3e4ea6879e52025a3acecb`; v1 18:5xZ / 12:5x MDT). Author claude-code (coordinator, `claude-fable-5-1`, model source
harness-runtime), on Jordan's signed go `evt_dc485a8af6ef47758bb9f439c62dce95` (hand-off 15 item 2). **Not built.**
Builds `docs/design/github-owner-login-attribution.md` **v1.4** (merged `b54b47d8`, PR #130) §6 steps 1–3 and §7; the
note's text wins over this brief wherever they differ — file the discrepancy on the pull request and stop. Builder:
**cursor-agent** in a fresh worktree (agent-ops 1, 4). Reviews: this brief is **class (a)** (it governs behaviour) and takes
the design gate; the code pull request it specifies is **class S** under `.claude/skills/review-effort/routing-rules/1.json`
(`router.ts`, `store.ts`, `policy*`, `schema.sql`, `schema.ts` are S paths; first pass `high`) **and class (a)**, because it
carries `docs/agent-ops.md` rule 19 and a dated correction to the note — the higher gate applies (agent-rules 12). §7 says
who sits.

Companions: the note (`github-owner-login-attribution.md`, cited below as **N§**), `commit-trailer-consistency.md` (the
classifier shape this one mirrors), `project-policy-document.md` (**P§**, the frozen canonical form), `model-source.md` §4.1,
`docs/owner-protocol.md` §7–§8, `docs/agent-rules.md` 11–12, 15.

## 0. What step 1 is — and is not

Build, in one pull request:

1. **Ingestion hashes** on every `pull_request`, `pull_request_review` and `issue_comment` (on a PR) webhook seal —
   `method.params.github_payload` (N§3.1), including `ingress_at` read before any store read.
2. **The owner-login classifier** (N§3.3–§3.5, §4): for a login the project policy marks shared, resolve the actor from
   pinned declarations matched on content, seal the decision beside the actor as `method.params.owner_login_decision`,
   and consume the matched declaration in **the same atomic store write** as the event.
3. **Policy fields** `github.shared_logins` and `github.identities` (N§5), as a new policy profile `/2` (§1.3 below), with
   explicit supported-profile handling wherever the code checks the single `/1` constant today (F1).
4. **Consumers** (N§7): status `capture.owner_login_events`, doctor `--gate` and `sealedLooksAgent`, `why` rendering,
   `retrace-export owner-login --recompute`.
5. **agent-ops 19** — the note's appendix A, verbatim, appended to `docs/agent-ops.md` after rule 18 and before
   "## Build order" (N§6 step 3: the rule and the code it needs land together).
6. **The note's R5-L1 fix** (Codex round 5, Low, open on PR 130's record): the T3 and §13 sample counts ("nine of nine",
   "eight review copies", the review ids) are a snapshot — add the date they were measured (2026-09-26) to both lines as a
   dated in-place correction; change no number.

Not in step 1: per-seat GitHub identities (N§6 step 5, owner actions), removing the shared mark (step 6), `gh-declare`
scripts (step 4), batch amendment (D4; never), any change to `push` classification, `workflow_run`, the Drive adapter,
reconcile or the trailer classifier (N§7 last bullet, N§10.8), the landing-page sentence (N§9, plan P4), and the
`owner-login-correction/1` amendment kind (N§8) — step 1 records read-time labels only and states in the PR whether
`attribution-v7-contract.md` admits a `pr:` target (Codex round 1 Q4 says the used-only events need a separate contract;
the builder confirms or refutes against the contract's target rules and writes the answer in the PR body; no amendment
code in this PR either way).

**Adoption is a policy write, not a deploy.** A project whose current policy is `/1`, or `/2` with an empty
`github.shared_logins`, classifies nothing: the sealed `actor` is what today's adapter writes and no `owner_login_decision` is
attached, while `github_payload` (§1.1) is added to every relevant seal regardless of policy (T8). The switch for `retrace` is Jordan
setting a `/2` policy with `shared_logins: ["jordandru"]` — an owner action under rule 14, after deploy, on its own go.

## 1. Inputs, in the order the code should be built

### 1.1 `github_payload` (core `github.ts`)

`mapGithubWebhook` (`packages/core/src/github.ts:59–136`) is a pure mapping and stays pure. It gains, for the three
event kinds, `method.params.github_payload` with the N§3.1 fields **plus the extensions this brief adds** — `login_source`, `body_null`,
`head_repo`, `payload_time`, and hashes, title and head on `reopened`; an `issue_comment` payload carries no branch, so N§3.1's table is
corrected here and a comment matches by PR number — taken from the payload (Codex round 1: these are listed as extensions and
clarifications, never as "exactly" the note's fields):

| field | `pull_request` | `pull_request_review` (`submitted`) | `issue_comment` (`created`, on a PR) |
|---|---|---|---|
| `login` | `sender.login`; on `closed` + `merged`, `pull_request.merged_by.login` (falls back to `sender.login` when `merged_by` is null — record which in `login_source: "merged_by" \| "sender"`) | `review.user.login` (fallback `sender.login`) | `comment.user.login` (fallback `sender.login`) |
| `branch` | `pull_request.head.ref` and `head_repo: pull_request.head.repo.full_name` | same, from `pull_request` | absent (an `issue_comment` payload has no `pull_request` object; `issue.pull_request.url` only) |
| `body_sha256` | `opened`/`reopened`/`edited`: N§3.4 over `pull_request.body` (null → hash of the empty string, and `body_null: true`) | over `review.body` | over `comment.body` |
| `title_sha256` | `opened`/`reopened`/`edited`: over `pull_request.title` | — | — |
| `review_state` | — | `review.state` lower-cased | — |
| `head_sha` | `opened`/`reopened`: `pull_request.head.sha`; `synchronize`: `payload.after` | `review.commit_id` | — |
| `merge_commit_sha` | `closed` + `merged`: `pull_request.merge_commit_sha` | — | — |
| `review_id` / `comment_id` | — | `review.id` | `comment.id` |
| `delivery` | `opts.deliveryId` (the `X-GitHub-Delivery` header the router already passes) | same | same |
| `ingress_at` | `opts.ingressAt` (§1.2) | same | same |
| `payload_time` | `pull_request.updated_at` (merge: `merged_at`) | `review.submitted_at` | `comment.created_at` |

`GithubMapOptions` gains `ingressAt?: string`. Hash function: one exported `normaliseGithubBody(s: string): string` and
`githubBodySha256(s)` in `github.ts` (UTF-8, `\r\n`→`\n`, trailing whitespace per line removed, trailing newlines
removed; N§3.4) — **the same function** the recompute tool and the tests use, so a normalisation change is one edit.
`push` and `workflow_run` are untouched; the `push` branch's `timestamp: c.timestamp` pass-through is issue #131, not
this PR.

### 1.2 `ingress_at` and the pending queue (core `router.ts`)

- In the `POST /hooks/github` handler (`packages/core/src/router.ts`, the block that begins `// ---- GitHub webhook ----`),
  read `const ingressAt = new Date().toISOString()` as the **first statement after `verifyGithubSignature` returns true**
  and before `getPendingDelivery`, `getPolicyRoute`, `getPolicy` or any other store read (N§3.1, Codex R2-F2). Pass it to
  `mapGithubWebhook` as `ingressAt`.
- `PendingDelivery` (`store.ts:211–226`) gains **`gh_event: string`** (the `X-GitHub-Event` header) and keeps
  `received_at` as the ingress time: every `insertPendingDelivery` call in the handler (unresolved routing, `pending_policy`,
  shadow push) writes `received_at: ingressAt` (today each writes `new Date().toISOString()` at the call site, which is later
  than arrival) and `gh_event: ghEvent`. Schema: `ALTER TABLE pending_deliveries ADD COLUMN gh_event TEXT` in a new
  `SCHEMA_PENDING_EVENT_COLUMNS_SQL` list beside `SCHEMA_PENDING_LEASE_COLUMNS_SQL` (`store.ts:606`), applied wherever
  the lease columns are applied (memory, SQLite, `apps/worker/schema.sql`, `migrate.mjs` treats an existing column as
  success). A row with `gh_event` NULL is a pre-upgrade row and is drained as `push` (today's behaviour).
- `drainPendingGithubDeliveries` (`router.ts:1147–1241`) today maps every row as `"push"`; it becomes event-kind-aware:
  `mapGithubWebhook(row.gh_event ?? "push", payload, { project, includePush: true, deliveryId: row.delivery_id,
  ingressAt: row.received_at })`. Non-push inputs go through §1.4's classification and `appendEvent`, with the same
  outcome bookkeeping keyed by `idempotency_key` instead of `sha` (`outcomes` is a JSON map already; key non-push entries
  by `idem:<idempotency_key>`). A queued non-push delivery today produces zero inputs and the row fails forever
  (`shas.length > 0` is false → `allSealed` false → `failed++`); this PR fixes that and tests it (T18, third clause).
- **Pending retention for non-push timeouts** (Codex round 1): today's non-push handler inserts no pending row on entry, and its 202
  timeout branch alone is not a queue. In the owner-login path an `AppendDeadlineExceededError` inserts the pending row (`gh_event`,
  `received_at: ingressAt`, the raw payload) before the 202 is returned, so the drain classifies the delivery later with its original
  `ingress_at`; a redelivery or drain keeps the stored receipt. T18 covers the drained case.

### 1.3 Policy profile `/2` (core `policy.ts`, P§2)

P§2 freezes `retrace-project-policy/1`: all fields required, unknown fields at any depth → 400, nothing defaulted into
the hash. So `github` cannot be an optional key of `/1`. Add **`retrace-project-policy/2`**: the `/1` body plus one
required key

```
github: { shared_logins: [ "<login>", … ],            // sorted unique by UTF-8 bytes; may be empty
          identities:    { "<login>": "<seat actor id>", … } }   // may be empty; keys unique (JCS sorts them)
```

- `validatePolicyBody` (`policy.ts:371`) accepts `profile` `/1` (unchanged, `github` absent) or `/2` (`github` required,
  shape above, `GITHUB_KEYS = {shared_logins, identities}` with unknown keys → 400; logins are GitHub account logins
  `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$` **or GitHub App identities `<slug>[bot]`**
  (`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\[bot\]$`) — N§5's own example `retrace-claude-code[bot]` and N§6 step 5's
  `<slug>[bot]` must validate (F2); compared case-insensitively at classification — GitHub logins are case-insensitive — but stored as
  sent; **two entries of `shared_logins`, or two keys of `identities`, that are equal case-insensitively → 400** (F2: JCS's byte-distinct
  keys do not resolve that); identity values are non-empty seat actor ids). `BODY_KEYS` becomes per-profile.
- `canonicalPolicyV1` is unchanged and serves `/2` too (same JCS rules; the profile string differs, so no `/1` digest can
  collide with a `/2` digest). Golden vectors `packages/core/src/fixtures/policy-v2/*.json`: at least three complete
  body+envelope inputs (empty `github`; one shared login; a login plus the identity `retrace-claude-code[bot]` → `claude-code`) with
  canonical bytes and digests, and one rejected vector with case-only duplicates.
- `PolicyBody` type: `github?: { shared_logins: string[]; identities: Record<string, string> }` present iff `/2`.
- **Supported-profile handling (F1).** The code checks the single constant `POLICY_PROFILE` (`/1`) in more places than the validator:
  activation evaluation `policy.ts:503` (a document whose profile differs is `policy_corrupt`), activation construction `:643` (stamps
  the constant into `policy_profile`), the stamp comparison `:514`, offline selection `:1045` (`policy_unsupported_profile`) and export
  verification `export.ts:264`. Codex's probe of a well-formed `/2` document returned `incomplete/policy_corrupt` from
  `evaluateActivation` and `policy_unsupported_profile` from `verifyExportBundle`. So: keep `POLICY_PROFILE` = `/1` as the bootstrap
  profile, add `SUPPORTED_POLICY_PROFILES` = {`/1`, `/2`}, and make every one of those checks accept a supported profile and stamp the
  document's own profile; **never** change the constant to `/2` (that breaks `/1` history and the `/1` bootstrap). Routes,
  `bundle.policies` and `policy_routes` are otherwise untouched: a `/2` document is a version like any other. Tests: a `/1` → `/2`
  activation, selection of the historical `/1` documents after it, `verifyExportBundle` over the mixed history, and doctor against it.
  The event-hash algorithm does not change; the policy checks do. The classifier reads `github` from the **current** policy at ingestion (`store.getPolicy(project, { current:
  true })`, which the handler already calls and collapses to the boolean `hasDoc` — keep the document that read returns
  instead of adding a second read) and records its digest as `context.policy_digest`. Bootstrap (P§8) still writes `/1`; the `/2` document for `retrace` is Jordan's write.

### 1.4 The classifier (new core `owner-login.ts`; wiring in `router.ts`)

```ts
export const OWNER_LOGIN_DECISION_PARAM = "owner_login_decision";   // beside CLAIM_DECISION_PARAM (producer-sig.ts:47)
export async function classifyOwnerLogin(args: {
  store: EventStore; input: EventInput /* the mapped webhook event, github_payload present */;
  policy: PolicyDocument; canonicalR: string; readHead: ChainHead; deadline: number; now?: () => number;
}): Promise<{ kind: "not_applicable" } | { kind: "decision"; input: EventInput; consume: string[] }>
```

- **Applicability**: `github_payload.login` (case-folded) ∈ `policy.body.github.shared_logins` (case-folded). Otherwise
  `not_applicable`: the `actor` is left as the adapter wrote it and no `owner_login_decision` is attached, while
  `github_payload` is still present — T8's regression guard is byte identity of the `actor` and the absence of the
  decision param, not of the whole event, for a `/1` policy, an empty list, or an unlisted login (`identities` handling
  below is the one exception and is tested apart).
- **Identities** (N§6 step 5, T12): before the shared check, if `github_payload.login` ∈ `policy.body.github.identities`,
  the actor is `{ type: "agent", id: identities[login] }` with `owner_login_decision.status: "identity_mapped"`, no
  declaration read. Built now so step 5 is a policy write; the field is empty until then.
- **Kind mapping** (N§3.3): `pull_request` `opened`/`reopened` ↔ `pr_open`; `edited` ↔ `pr_edit`; `synchronize` ↔
  `push`; `closed`+`merged` ↔ `merge`; `pull_request_review` ↔ `review`; `issue_comment` ↔ `comment`. `closed`
  unmerged, `ready_for_review`, `converted_to_draft`: **no kind** — the account is written with `status: unresolved`,
  `reason: no_declaration`, `kind: null` (a state change no seat declares; N§3.2 lists none).
- **Candidates read** (N§3.5 item 1): one `store.eventsReferencingArtifacts` call (`store.ts:146`, query shape
  `store.ts:190–203`) with `artifact_keys` = `pr:<R>#<n>` (when `n` is known), `git:<R>#<branch>` (when `branch` is
  known) and `commit:<R>@<head_sha12>` (when `head_sha` is known); `after_seq` = the `seq` of the newest event with
  `received_at < ingress_at − 30 min` is not cheaply known, so use **`after_seq: -1`** (the bound is exclusive, `store.ts:195–197`,
  `:259`; `0` would drop a declaration at sequence zero, a real event — F7; the existing index tests use `-1` for all history) with
  `through_seq: readHead.seq`,
  `row_cap: 2000`, `deadline`; then filter in memory on `received_at ∈ [ingress_at − 30 min, ingress_at]` and the
  N§3.3 predicate. If the row cap or deadline trips → `unavailable`/`budget` or `deadline` (N§4). Measure the busiest
  real window in the test fixture (the Grok seat found 56 rows for PR 130; assert the fixture stays under 2,000). The row cap counts
  matching index rows over the artifact's whole life, before the time filter, so a many-old-rows fixture (2,001 rows older than the
  window, one inside it) must seal `unavailable`/`budget` — an accepted availability trade-off, not a capacity proof (§6 item 4) — and
  a sequence-zero fixture (declaration at seq 0, policy activation at seq 1, the webhook next) must classify `declared_by_seat` (F7).
- **Predicate** (N§3.3), applied in memory, each clause a named function with its own unit test: project; `sealed_by`
  starts with `pinned:` **and** `producer_sig_verdict === "verified"`; `actor.type === "agent"`; `action_detail !==
  "amended"` and not the target of an effective attribution amendment at `readHead` — evaluated with the **bounded** evaluator that
  exists, `evaluateAmendmentsAtU` (`classify.ts:576–648`: bounded candidates through `store.amendmentEventsUpTo`, `store.ts:135`,
  point-read dependencies, capture context, fails closed), under the owner-login deadline and an explicit aggregate row budget of 2,000
  (its own cap is 20,000); `collectAttributionAmendments` alone is not the store-loading helper. **There is no fallback** (F3): when that
  read is unavailable, over budget or past the deadline the decision is `unavailable`, never a classification that ignores amendments; `github_action` present and **without** `result`; `repo`, `login`
  (case-folded), `kind`, and `pr` (or the branch artifact for `pr_open`) equal; normalisation `state`→`review_state`,
  `commit_id`→`head_sha`, review-state aliases exactly as N§3.3 lists them and no others; the kind's content fields
  equal after normalisation; not consumed **as of `U`** (§1.5, F4); `received_at ≤ ingress_at` and `≥ ingress_at − 30 min`; `seq ≤
  readHead.seq`. `E.timestamp` is never read.
- **Decision** (N§4 table): `declared_by_seat` (one seat; when the same seat has several eligible declarations, choose
  the lowest `seq`, N§3.5 item 3) → `actor: { type: "agent", id: <seat>, on_behalf_of: <declaration's on_behalf_of> }`,
  `evidence_level: "declaration_only"`; `conflicting`/`multiple_declarers`; `unresolved`/`proximity_only` (some
  candidate row named the PR, branch or commit but none passed the predicate) or `no_declaration`; `unavailable`. The
  account actor: `{ type: "system", id: "github:<login as sent>", display_name: "<login> (GitHub account, shared)" }`.
  The record is exactly the N§4 JSON (`policy: "owner-login/1"`, `observer`, `login`, `shared: true`, `payload`,
  `decision`, `context { read_head_seq, read_head_hash, policy_digest }`, `window { from, to, basis: "ingress_at" }`,
  `received { webhook: null — sealed as null, because the seal time is assigned inside sealEvent (chain.ts:74–93) after the record is
  hashed; the event's own received_at is that time and the recompute tool reports it beside the record, never inside it (F5; N§4's
  example showed it filled — corrected in the note by this PR); declaration }`,
  `consumed`, `ingress_at`, `classification_ms`). Attach with a sibling of `attachClaimDecision` (`classify.ts:1144`).
- **Stripping** (N§4, T9): `POST /events` deletes `params[OWNER_LOGIN_DECISION_PARAM]` next to `CLAIM_DECISION_PARAM`
  (`router.ts`, the block commented "/2 and unsigned: strip so a client cannot plant stamps") for every producer-sig
  format including `/1` — unlike `claim_decision`, no client ever legitimately submits this param. A **signed** body that carries it
  becomes invalid once it is stripped before `producerSigCheck`: under `require_signature` the expected result is 401, not a sealed
  stripped event — T9 states that expectation — and the key is **not** added to either frozen signature format's exclusion list
  (`producer-sig.ts:74–87`), which would change historical signature semantics (Codex round 1).
- **Budget**: `OWNER_LOGIN_DEADLINE_MS = 300` (beside `CLASSIFY_DEADLINE_MS = 500`, `classify.ts:40`), always inside the
  delivery's remaining `WEBHOOK_DELIVERY_DEADLINE_MS` (`router.ts:70`, 2,000 ms): `deadline = min(now + 300,
  deliveryDeadline)`.
- **Wiring**: in the handler's non-commit append loop (the `stampSealedBy(parsed.data, SEALED_BY_GITHUB_WEBHOOK)` branch
  after the shadow-commit branch), when `parsed.data.method.params.github_payload` exists and the current policy is `/2`:
  classify, then append with `consume` (§1.5). `sealed_by` stays `webhook:github`, `producer_sig_verdict` stays `none`
  (N§4 last paragraph). Same wiring in the drain (§1.2).

### 1.5 Atomic event-plus-consumption write (core `store.ts`, `apps/worker/src/d1-store.ts`, `packages/mcp-server/src/sqlite-store.ts`)

- New table, every store: `owner_login_consumption(project TEXT NOT NULL, declaration_event_id TEXT NOT NULL,
  consumed_by_delivery TEXT, consumed_by_event_id TEXT NOT NULL, consumed_by_seq INTEGER NOT NULL, consumed_at TEXT NOT NULL, PRIMARY KEY (project,
  declaration_event_id))` — in `SCHEMA_SQL` (`store.ts:479`), `apps/worker/schema.sql`, the memory store (a `Map`
  keyed `project\u0000declaration_event_id`), and the D1/SQLite `tables` lists used by `deleteProject`
  (`d1-store.ts:45`, `sqlite-store.ts:73`) so a project delete removes its rows.
- `EventStore.insert(e: Event, extras?: { owner_login_consumption?: Array<{ declaration_event_id: string;
  consumed_by_delivery?: string }> })`: D1 appends one `INSERT INTO owner_login_consumption … VALUES` statement per row to
  the **same** `db.batch()` as `insertStatements(e)` (`d1-store.ts:33–35`); SQLite runs them inside the same `BEGIN … COMMIT`
  as `insertRows(e)` (`sqlite-store.ts:59–68`); the memory store checks the map and writes event and rows in one
  synchronous step. `consumed_by_event_id = e.id`, `consumed_by_seq = e.seq`, `consumed_at = e.received_at`. `appendEvent`
  (`store.ts:812`) passes `opts.extras` through to `insert`.
- **Consumption is read at the recorded head (F4).** A candidate's row counts only when `consumed_by_seq ≤ readHead.seq` (`U`):
  `EventStore.ownerLoginConsumptionUpTo(project, declaration_ids, throughSeq, { deadline, row_cap })` is the bounded read on every store,
  and it is the read §1.4's "not consumed as of `U`" clause uses. The counterexample the bound closes: A captures `U`; B seals E's
  consumption at `U+1`; A's read of the current table would see E consumed and seal `unresolved` with `read_head_seq: U`, which a replay
  at `U` cannot reproduce. With the bound, A does not see it, attempts allocation, loses the atomic insert on the primary key, and takes
  the reclassification path already specified. The note's N§3.5 item 2 gains a dated correction to this effect in this PR; the replay
  contract (a row iff a sealed decision lists it) is unchanged.
- **Primary-key failure** surfaces as a `UNIQUE constraint failed: owner_login_consumption…` error. The handler's existing
  retry loop treats any `/UNIQUE/i` as a seq collision and re-appends the same input up to four times; that would
  re-assert a stale decision (N§3.5 item 3). So: the owner-login append path catches an error whose message names
  `owner_login_consumption` **before** that loop, re-runs `classifyOwnerLogin` once at the new head, and appends what
  that read supports; a second such failure seals `unresolved`/`allocation_failed` (N§4 row; NOOA N4-M2). Other UNIQUE
  errors keep today's loop. An `AppendDeadlineExceededError` keeps today's 202-pending path and **never** releases a row
  (N§3.5: an uncertain response is resolved by the idempotent lookup, not by cleanup).
- **Replay contract** (T2, T17): a row exists iff a sealed decision lists that declaration under `consumed`. The recompute
  tool (§1.6) rebuilds the table from the export in `seq` order and diffs it against the store's rows in a test.

### 1.6 Consumers (`status.ts`, `doctor.ts`, `explain.ts`, `export-cli.ts`, `ui`)

- **Status** (`packages/core/src/status.ts`, `capture` block `:43–70`, `buildProjectStatus :84`, `renderProjectStatus :263`):
  `capture.owner_login_events: { total, sealed_as_human, by_status: { declared_by_seat, conflicting, unresolved,
  unavailable, identity_mapped }, read_time_labels: { declared_by_seat, conflicting, unresolved }, computed_at_seq }`
  exactly as N§7. `total` = webhook-produced events (`sealed_by webhook:github`, plus the unstamped pre-2026-08-30 events whose method
  identifies the GitHub adapter — N§1.2 counts four) for a login in the current policy's `shared_logins`, matched as `github_payload.login`
  equal to the raw login case-insensitively when the payload exists, otherwise (pre-hash seals) `actor.id === "github:<login>"` in its
  prefixed form; an old seal whose actor id is a payload e-mail records no login and is counted under `legacy_unknown_login`, never
  attributed to a login it did not record (F6); `identity_mapped` counts logins in `identities`, a stated separate scope; `sealed_as_human` = those with
  `actor.type === "human"` (650 on 09-26 03:43Z; the number the build reports is the number). `read_time_labels`
  applies §1.4's predicate to `sealed_as_human` events using declarations **and** outcome records (`github_action.result`
  with a matching `review_id`/`comment_id`/`pr`, N§3.2 last sentence, N§8) — label only, no consumption. Binding rule for historical
  seals (Codex round 1): the old adapter kept no `review_id`/`comment_id` in params but does keep the location URL and, usually, a
  delivery-based idempotency key, so an outcome binds only when its `review_id`/`comment_id` appears in the historical event's location
  URL or idempotency key; a PR number alone never binds. A pre-hash event has no `ingress_at` or content hashes, so this is a separate
  read-time evidence path, not the ingestion predicate re-run. Text line as
  N§7 with the word "read-time:" and "(computed at read, not sealed)". `docs/reference.md` documents the field where
  `agent_events_not_pinned` is documented (`:263`).
- **Doctor** (`packages/mcp-server/src/doctor.ts`): `sealedLooksAgent` (`:226`) returns true for a webhook event whose
  `owner_login_decision.status` is `declared_by_seat` or `identity_mapped`; a new finding `owner-login` fails under
  `--gate` (warn otherwise) when an event with `github_payload.login ∈ shared_logins` sealed **after** the `/2` policy's
  activation `seq` carries `actor.type: "human"` (a producer defect, the shape of `model_claim: absent`). Doctor reads the current policy document through the `/projects/:p/policy` route it already fetches
  (`doctor.ts:941`); status exposes only mode, digest and version (`status.ts:80`), and the export's policy documents are discarded by
  `fetchVerifiedRemoteEvents` today — either keep the verified documents beside the verified events for the gate, or use the policy
  route; no new Worker route. The adoption point for a login is the **first** activation of a `/2` document that lists it in
  `shared_logins`, not the newest activation. The gate and every consumer read the status at its canonical nesting,
  `owner_login_decision.decision.status`.
- **`why` / timeline** (`packages/core/src/explain.ts`, `describeRecordedActor :103`): an actor carrying an `owner_login_decision`
  (`system` for the account, `agent` for `declared_by_seat` and `identity_mapped`) renders by `decision.status`: "GitHub account <login> (shared login) — who acted: unresolved (<reason>)" /
  "… — declared by <seat> (evt_<id12>), not identity-verified" / "… — conflicting: <seats>"; an `identity_mapped` actor
  renders as the seat with "(GitHub App identity)"; a `declared_by_seat` actor is **never** rendered as an established
  actor (NOOA N2). `eventForModel` (`:68`) gains `owner_login_display` with the same string, marked untrusted like the
  other displays. The UI (`ui/**`) shows the same string where it shows `sealed_by`.
- **Recompute** (`packages/mcp-server/src/export-cli.ts`): `retrace-export owner-login --recompute --bundle <export.json>
  [--policy <digest>]` replays every webhook seal in `seq` order against the bundle's events and `bundle.policies`,
  recomputes N§4 with the **sealed** `ingress_at`, `read_head_seq` and `policy_digest` from each decision record, and
  prints per event `match` / `mismatch <field>`; exit 1 on any mismatch. Observed fields — `classification_ms`, `received.declaration`,
  `received.webhook` (sealed null) — are **preserved from the sealed record and reported as preserved**, never presented as recomputed
  evidence (F5); the event's `received_at` is printed beside the record as an annotation. `verifyExportBundle` is unchanged (the
  decision is inside the hashed event).

### 1.7 agent-ops 19 and the note's dated correction (`docs/agent-ops.md`, `docs/design/github-owner-login-attribution.md`)

- Append N appendix A as rule **19** after rule 18, text verbatim including its "→ unnecessary when [specific]" line;
  add nothing else to that file.
- In the note: §11 T3's "Measured so far on PR 130 itself" and §13's "Live samples (T3)" rows gain "(measured
  2026-09-26; snapshot — later samples are recorded on the step-1 pull request)" and no number changes; add one row to
  §13: "Step-1 build brief | `docs/design/owner-login-step1-build-brief.md`, `evt_dc485a8a…`". The note's **Status** line
  gains "v1.4.2 — R5-L1 dated (step-1 PR)" (v1.4.1 is this brief's own PR #133: the dated corrections to §3.5 item 2 (F4) and §4 (F5),
  §8 below). Nothing else in the note changes; a needed change is a discrepancy report.

## 2. Tests — every N§11 test lands, each named in a `test(...)` title with its id

| id | where | what the assertion is |
|---|---|---|
| T1 | `router.test.ts` (memory store, `/2` policy) | comment webhook + one eligible pinned declaration → `actor` = seat, `status declared_by_seat`, declaration listed, `consumed` = [id], consumption row present |
| T2 | `export-cli.test.ts` | `owner-login --recompute` over an export of T1/T4/T17's store reproduces every decision byte-identically (the sealed record; observed fields preserved and reported as such, F5) and the table |
| T3 | **live, after deploy** (§5) | one real comment, review, PR body edit and PR open through `gh` with declarations; each webhook `body_sha256` equals the seat's; result recorded on the note as a dated correction if normalisation changes |
| T4 | `owner-login.test.ts` | two seats, same body hash → `conflicting`, account actor, both listed |
| T5 | `owner-login.test.ts` | declaration `sealed_by: owner` / verdict `none` → ineligible; listed under `proximity_hints`, `unresolved` |
| T6 | `owner-login.test.ts` | right PR and time, different `body_sha256` → `unresolved`/`proximity_only` |
| T7 | `owner-login.test.ts` | declaration at `ingress_at − 30 min − 1 s` → `unresolved`; at `− 30 min` → `declared_by_seat` |
| T8 | `router.test.ts` | `/1` policy, `/2` with empty list, and an unlisted login: sealed event bytes identical to a pre-change fixture (store the fixture JSON; `github_payload` is **present** in all three — T8's identity is of `actor` and the absence of `owner_login_decision`; state this in the test) |
| T9 | `router.test.ts`, `owner-login.test.ts` | store error / row cap / deadline → `unavailable` with the named reason, account actor; a `POST /events` body carrying `owner_login_decision` has it stripped under every producer-sig format; a **signed** body carrying it under `require_signature` → 401 (the stripped body no longer matches its signature) |
| T10 | `status.test.ts` | `sealed_as_human` unchanged by labels; a historical human event flips to read-time `declared_by_seat` when an outcome record whose `review_id` appears in the event's location URL or idempotency key exists (a PR number alone does not flip it); `total` counts pre-hash, unstamped and declared-agent events, and an e-mail-id seal lands in `legacy_unknown_login` (F6) |
| T11 | `doctor.test.ts` | `--gate` fails on a post-activation shared-login `human` seal; passes on `declared_by_seat` and `unresolved` |
| T12 | `owner-login.test.ts` | login in `identities` → mapped seat, `identity_mapped`, no declaration read (assert the store's index read was not called); an unlisted `[bot]` login keeps today's heuristic |
| T13 | `router.test.ts` | merge webhook with `merge_commit_sha` matching a `merged` declaration → `declared_by_seat`; without → `unresolved` |
| T14a | `owner-login.test.ts` + fixtures | the real declaration `evt_df2d386cc03b4a06a435906aa582de9e` (fetch raw with the seat token; fixture JSON committed) and a synthesised `pull_request.opened` payload for PR 130 (body = `~/.retrace/handoff-2026-09-26/pr-p1/body.md`, whose normalised sha256 must equal `fa882683fb429ed12986762d08cb4511d19c2d830d986fdbed5c5e994e4d720d`; title `docs(design): GitHub owner-login attribution v1 — P1 note (#82, #69), class (a)`; `head.ref jordandru/claude-owner-login-p1`; `head.sha 57299cf20f83cff20dc27da2d08596e24274ec2b`; sender `jordandru`): the candidate read by branch and commit key returns the declaration; the predicate refuses it (no `title_sha256`); classification is `unresolved`/`proximity_only`. The payload is labelled **reconstructed** in the fixture, and its `ingress_at` is set so the real declaration is inside the window — the missing title is the only reason tested |
| T14b | same fixture + a compliant declaration | → `declared_by_seat` (claude-code) through the lookup |
| T15 | `owner-login.test.ts` | caller `timestamp` earlier than the action but `received_at > ingress_at` → `unresolved`; `received_at = ingress_at − 1 s` → `declared_by_seat`; an outcome record before `ingress_at` → not a declaration; declaration and action in the same second → `declared_by_seat` |
| T16 | `owner-login.test.ts` | after a matched `pr_edit`, a title-only edit with the same body → `unresolved`/`no_declaration`; `review_state: commented` does not match an `approved` review; a different `commit_id` does not match |
| T17 | `store.test.ts`, `sqlite-store.test.ts`, `d1-store.workerd.test.ts`, `router.test.ts` | two identical comments after one declaration → first `declared_by_seat`, second `unresolved`, one row; concurrent variant (two `Promise.all` deliveries against the memory store with an injected yield between read and write, and against SQLite): exactly one row, one `declared_by_seat`, the other reclassified to `unresolved`; a contrived third whose second write also fails → `allocation_failed`, no loop (assert the classifier ran twice, never three times); a failure injected between classification and `insert` leaves no row and no event; replay reproduces both; **F4 interleaving**, tested apart from the two-readers-then-write race: A captures `U`, B seals E's consumption at `U+1`, A's bounded read must not see it, A attempts allocation, fails the key, reclassifies. The asynchronous barrier sits outside the synchronous `insert` transaction (an await inside the memory store's allocation would break atomicity) |
| T18 | `router.test.ts` | declaration sealed after `ingress_at` but before the webhook's own seal → `unresolved`; one second before → `declared_by_seat`; a delivery queued `pending_policy` with `gh_event: issue_comment`, drained after a `/2` policy lands, carries its original `received_at` as `ingress_at`, and a declaration sealed between arrival and drain → `unresolved`; the drain seals a non-push row (today it cannot) |
| T19 | `owner-login.test.ts` | two same-seat eligible declarations → lowest `seq` consumed and named; the other stays available |
| — | `github.test.ts` | every `github_payload` field of §1.1 for each event kind and action, including `body_null`, `login_source`, and that `push`/`workflow_run` outputs are byte-identical to before |
| — | `policy.test.ts` | `/2` validation (unknown key → 400, unsorted logins → 400, bad login syntax → 400, `retrace-claude-code[bot]` accepted, case-only duplicate logins or identity keys → 400, empty `github` accepted), `/1` unchanged, golden vectors `/2`; a `/1` → `/2` activation, historical `/1` selection after it, `verifyExportBundle` over the mixed history and doctor against it (F1) |
| — | `owner-login.test.ts`, `store.test.ts` | sequence-zero fixture → `declared_by_seat`; many-old-rows fixture (2,001 rows outside the window) → `unavailable`/`budget` (F7, §6 item 4); a corrected (amended) but otherwise eligible `pr_open` declaration → excluded; amendment read failure → `unavailable` (F3); `ownerLoginConsumptionUpTo` respects `throughSeq` on every store (F4) |
| — | `explain.test.ts` | the three rendering strings; a `declared_by_seat` event never renders as a plain agent line |

Baseline at `b54b47d8`: core 361, cli 238, worker 36 tests (hand-off 15). Every new test is additive; no existing
assertion changes except where this brief names the file. Run `npm test` with the scratch environment inline
(agent-ops 10) — never exported.

## 3. Acceptance, in order

1. `npm run build && npm test` green at the head; `node packages/mcp-server/dist/doctor.js doctor` READY (rule 8) in the
   builder's worktree, built there (agent-ops 4).
2. Every changed file named on a logged edit (rule 3): the builder's `retrace_log` events list each path as
   `repo:jordandru/retrace#<path>`, `generated` or `both`; `docs/agent-ops.md` and the note included.
3. The pull request body states: class **S + (a)**; the N§ sections each change implements; the Q4 answer (§0); the
   `/2` profile decision (§1.3) as a discrepancy against N§5's wording "gains, under `github`" (the note did not say how
   the frozen canonical form admits a new key — this brief decides `/2`; the gate confirms or overrules); the T14a
   fixture's provenance; and `Retrace-Caused-By: evt_dc485a8af6ef47758bb9f439c62dce95`.
4. Reviews per §7; merge by the coordinator from `retrace-main` on Jordan's go (agent-ops 12).
5. **Deploy** (Jordan's go, rule 14): `npm run migrate` in `apps/worker` (adds `owner_login_consumption` and the
   `gh_event` column; idempotent), then `wrangler deploy`; `scripts/check-deploy.mjs` current. Then Jordan's `/2`
   policy write for `retrace` (its own go). Then T3 live: the coordinator declares and posts one comment, one review,
   one body edit and one PR open on a scratch pull request, reads the four webhook seals raw, compares `body_sha256`,
   and records the result on the note as a dated correction (N§3.4).

## 4. What the builder must not do

- Change `actor` for any login not in `shared_logins`, or for any project on a `/1` policy (T8).
- Write `human` for a shared login under any status (N§4: the account is the floor; `unavailable` seals the account).
- Reserve a consumption row before the seal, release a row on an uncertain response, or retry the append after a
  consumption-key failure (N§3.5 item 3; Codex R3-F1).
- Compare `E.timestamp`, GitHub's payload times, or `G.received_at` for eligibility (N§3.3; Codex F2, R2-F2).
- Widen the review-state aliases or the `state`/`commit_id` normalisation beyond N§3.3's list (Grok seat R1-M1).
- Make a webhook seal a witness for the trailer classifier or change reconcile (N§7). Reconcile's `missing_commit`
  downgrade keys on `sealed_by: webhook:github`, not on the actor, so a `system`/`agent` actor on a merge seal does not
  move it; assert this with one reconcile test on a merge fixture whose actor is the account.
- Edit `docs/agent-rules.md`, `docs/team-roles.md`, `docs/owner-protocol.md`, or any identity file.
- Commit anything but the builder's own paths (`git commit --only`, agent-ops 2), or build in the primary checkout
  (agent-ops 3).

## 5. Sequencing and the live measurement (T3)

Build → review (§7) → merge → migrate + deploy (go) → `/2` policy write (go) → T3 on a scratch PR (go) → dated
correction on the note if N§3.4 needs extending. Until the policy write, the deployed Worker records `github_payload`
on every relevant seal and classifies nothing: those pre-adoption seals are the first `sealed_as_human` events that
carry hashes, so the read-time label can be computed for them without an outcome record.

## 6. Open items the gate should settle (each with the coordinator's position)

1. **`/2` profile versus an optional key on `/1`** (§1.3). Position: `/2`; the frozen form says unknown keys are 400 and
   nothing is defaulted, so an optional key would either break `/1` digests or default into the hash. To overrule: name
   how `/1` admits the key without changing existing digests. *Codex round 1: confirmed, subject to F1 (supported-profile handling
   across activation, selection and export verification) and F2; the frozen schema, not digest preservation, is the reason an
   optional key is out.*
2. **`gh_event` on pending rows** (§1.2). Position: required for the event-kind-aware drain the note names as a build
   item; NULL drains as push. To overrule: keep the drain push-only and state that queued non-push deliveries are dropped. *Codex
   round 1: confirmed (its probe: zero push inputs and one comment input for the same comment payload); NULL-as-push does not recover
   pre-upgrade non-push rows — a stated migration limit.*
3. **Consumption-key error detection by message text** (§1.5). Position: match `owner_login_consumption` in the error
   message on all three stores (SQLite and D1 both name the table in `UNIQUE constraint failed:`); a test per store
   asserts the message shape so a driver change fails loudly. To overrule: propose a pre-read that does not reintroduce
   the reservation. *Codex round 1: confirmed and measured — Node SQLite: `UNIQUE constraint failed: owner_login_consumption.project,
   owner_login_consumption.declaration_event_id`; Miniflare/workerd D1: the same text prefixed `D1_ERROR:` and suffixed
   `SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)`; a batch with the event insert followed by the duplicate row left zero
   event rows. Match a constraint failure that names the table, not any error that mentions it; a typed store error is an acceptable
   alternative. These are local driver measurements, not a production-D1 measurement.*
4. **The 30-minute lower bound applied in memory over an `after_seq: 0` read** (§1.4). Position: the index read is
   bounded by `row_cap` and `deadline`, and a PR's rows over its life are far under 2,000 (measured 56 in the busiest
   window); a `received_at`-bounded index read does not exist and adding one is out of scope. To overrule: specify the
   index change. *Codex round 1: accepted as a lifetime budget, not a window capacity — the cap counts matching index rows before the
   time filter, so the 56-row window measurement proves nothing about an artifact's lifetime; F7 fixed and the many-old-rows fixture
   added (§1.4).*

## 7. Roles

| seat | role on the step-1 pull request |
|---|---|
| cursor-agent | builder (own worktree; fresh thread; `--yolo` per agent-ops 15) |
| Codex (`gpt-6-astra`) | first code review, class S first pass **high** (its weekly limit resets 2026-09-28 21:13Z; route after that) |
| NOOA (Nemotron 3 Ultra, pinned) | design-gate seat for the class (a) parts (agent-ops 19 text, the note's correction) and the packet |
| Grok (xAI) | Grok seat for the class (a) gate (**not** cursor-agent, which builds here — reviewer ≠ builder); measurer for T3 |
| claude-code | last review, gate check, merge on Jordan's go; T3 declarant |
| Jordan | goes for merge, migrate, deploy, the `/2` policy write, T3 |

Routing events in the skill shape with a stop rule before every round (team-roles rule 8 (ii)); the reviewers are asked to
put `pr:jordandru/retrace#<n>` on every verdict.

## 8. Record

| What | Event |
|---|---|
| Jordan: go, draft the P1 step-1 build brief | `evt_dc485a8af6ef47758bb9f439c62dce95` |
| Session 22 resume (hand-off 15) | `evt_1565646190fe4d7d96414d116c098375` |
| This brief written (edit event) | `evt_8e6340f1cea54f3494bdb2483fac979e`; PR #133 opened `evt_d4e1a1458a8c4aabacc8025ea2a3728b` |
| Round 1: routing NOOA `evt_9a878724bd7c409f994195db2e5ffcbf`; verdict rejected, 1 Medium (N1) `evt_b373209785314ca4a0a1fffc65b219a0`; gate check `evt_3d4e15bb290142a2bf3a95f2fd4c589d`; copy review 5331907214 | Jordan: apply N1 in place as v1.1, then round 2 `evt_7778c91baa3e4ea6879e52025a3acecb` |
| Round 1 (Codex): routing `evt_876a04064c4f4b24a975cab67b209bdc`; verdict rejected, 7 Medium F1–F7 `evt_1e9f4144fb0042bf8bcb432d736554a2`; gate check `evt_109a0378b92141de97aace463362ad45`; copy review 5343817023 | Jordan: apply F1–F7 in place as v1.2 with the note's F4/F5 corrections, then round 2 (Codex re-check, NOOA re-check, Grok seat first pass) `evt_5d5309168b6244c4aa1c20dbbab46e12` |
| Note v1.4 merged | PR #130, `b54b47d8`, merge record `evt_01f8c7d8…` |
| Real `pr_open` declaration / webhook seal / outcome used by T14 | `evt_df2d386cc03b4a06a435906aa582de9e` / `evt_2f60cfc75d604371bffb0b3be81a1ab9` / `evt_0efdea31057b4ef8aa1cede2c6ab9c5a` |
