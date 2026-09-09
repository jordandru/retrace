# Commit trailer consistency — design note

**Status:** **v2.4 — ACCEPTED WITH NOTES, 2026-09-09** (coordinator, on Jordan's instruction; build order and tracked
notes in §15). Author: claude-code. Not built. v2.3 (f68823e) closure review by Codex (#2801,
evt_bffde560cfab4a46bb4fe106b8ace24b): R1, R4, R7, N1, N2, N3 CLOSED; R2, R5, R8 PARTIAL; four new findings
(V23-1 High, V23-2..4 Medium), all folded here (§14e); Codex asked for no further broad redesign and named the
signed-format/old-client contract as the one prerequisite before shadow — it is §15 step 1. v2.2 (6908d5d) closure review by
Codex (#2737, evt_2a74375e7ec34c51877b5843654e00e1): R3, R6 CLOSED; R1, R2, R4, R5, R7, R8 PARTIAL; two new
Highs (N1 signature selector, N2 context overwrites testimony) — dispositions in §14d. Phase 0 prerequisites
landed as PR 27 (9c3156b). v2 (ee9c889) was reviewed by
NOOA/Nemotron 3 Ultra (evt_f787df612d0d413ba13f1b887f160fc5): needs changes — dispositions in §14b. v2.1
(2a9abc2) was reviewed by Codex (#2716, evt_d88568a1185741a68bcc1e3709e1aa43): needs changes, 5 High /
3 Medium — dispositions in §14c. v2.2 renames the statuses to say what they actually judge (§2.7, §4).
Grok review pending (budget resets 2026-09-11).
v1 (9b6ef05, 2026-09-07) was reviewed by Codex (#2514, 4 High / 3 Medium), Grok (#2515) and NOOA on
Nemotron 3 Ultra (#2517, 6 findings). All three said *needs changes*. v2 answers every finding; §14 maps
each one to the section that answers it. Reviewers for v2: the same three. Builder once accepted:
cursor-agent or github-copilot (reviewer ≠ builder, `docs/team-roles.md`). PR 19 (OpenCode) stays held
(§13).

## 0. What changed from v1, and why

| v1 said | v2 says | Driven by |
|---|---|---|
| The trailer is checked against the `Retrace-Caused-By` ancestor chain (`/why`). | The trailer is a **claim**. It is classified against **this commit's** capture-window evidence: authenticated agent writes that name this commit's files. The causal chain is secondary evidence, never the test. | Codex H2, M1; Grok (siblings missed) |
| Peers = events with `actor.type === "agent"` or `surface === "agent"`. | Witnesses = events sealed through **pinned-credential ingress** (`sealed_by` = `pinned:*`), agent actor, output role, canonical `repo:` id, in window, same project. Trailer-derived seals, assert relays and owner writes never witness. | Codex H3; Grok (canonical ids) |
| No peers → seal as claimed, silently. | No evidence → status **`unresolved`**, recorded on the seal as an explicit, hash-covered observation. Never "agreement". Whether the claimed WHO is still written in that case is a policy (§4, Q1). | Codex H1 |
| Any matching ancestor → seal as claimed. | Only a witness **by the claimed actor on this commit's files** corroborates. Presence in a chain is not authorization. | Codex H2 |
| Check runs in the hook (GET `/why`) and in the webhook. | The check runs **once, in Worker ingestion**, for both producers: the hook's POST and the webhook's push both land there. The hook cannot stamp a system actor anyway (its assert allow-list has no `system/*`). Local-only ledgers run the same core function. | Codex H3; Grok (assert allow-list) |
| Lookup failure → hook seals nothing; webhook seals `chain_unavailable`. | Unavailable is a **pending** state, never an event. Webhook: durable pending table + drain; hook: visible non-zero exit + retry file. Deadline and breaker specified. | NOOA 1, 2; Codex Q1 |
| System seal + `attribution_conflict` marker. | Every commit seal carries `method.params.claim_decision` = **observer / claim / decision**, with `status`, `reason`, witnesses, read head and policy version. Conflicting claims get no agent WHO. | Codex H4; NOOA 4 |
| Conflicts are corrected by amendment; acks reused. | Exact-seal, per-scope human amendment; both producers' decisions compared as decisions, so matching withholds are not `producer_disagreement`; the ack rule treats the **claimed** actor as the accused. | Codex H4 |
| Human fallback bypasses the guard. | Claim source is recorded (`retrace-actor` / `co-authored-by` / `bot-author` / `human-author` / `malformed`); a human or malformed claim with agent evidence in window is recorded as such and never becomes a silent human seal. | Codex M2 |
| `{type,id}` is identity. | `{type,id}` is actor equality; principal binding is credential issuance, out of scope here and stated so. Witness credential/key provenance is recorded. | Codex M3 |
| Optional env marker on hook seals. | Kept as evidence only; plus each witness's server-stamped `location.client` is recorded on the seal, which gives the **webhook** harness evidence without a new trailer. `harness_mismatch` is a non-blocking finding. | NOOA 3, 5, Q4 |
| Test 7 = "amendment works". | Round-trip tests: real evidence restores WHO; fabricated evidence is rejected; self-ack is refused. | NOOA 6 |

## 1. The problem (unchanged)

A commit's WHO is derived from trailers the committing agent writes (`Retrace-Actor`, else an agent
`Co-Authored-By`, else `[bot]` author, else the human author — `commit-actor.ts`). Both producers trust
them: the git hook on the committing machine (assert credential, allow-list bounded) and the GitHub push
webhook on the Worker (HMAC-verified payload). Neither checks the trailer against anything the ledger
already knows. An agent that writes another agent's trailer — copied from a shared instruction file, or
a formatting slip — puts a false actor into an append-only ledger twice.

Evidence: github-copilot's first commit carried literal `\n` sequences and was sealed as a human (#2030);
OpenCode always loads Codex's `AGENTS.md`, so a model there sees `Retrace-Actor: codex` as an instruction
(PR 19). Jordan's rule: truthful, objective provenance is upheld at all costs. Detection after the fact
is not the same as never writing the false record.

## 2. Principles

1. **A trailer is a claim.** Nothing in a commit message authenticates anyone. The ledger may record a
   claim; it must say that it is one, and what it was checked against.
2. **Observer, claim, decision are three different facts** and are recorded separately on every commit
   seal: who sealed (producer + `sealed_by`), what was claimed (parsed trailer, with its source), and
   what the server decided against which evidence.
3. **Only authenticated ingress witnesses.** Evidence is an event whose actor the Worker fixed from a
   pinned credential. Events whose actor came from a trailer (git, webhook), from an assert relay, or
   from the owner token are not independent witnesses of WHO.
4. **Evidence is commit-specific.** A witness must name one of this commit's files as an output, in this
   commit's capture window. Membership in a caller-selected causal chain proves nothing about this commit.
5. **Never write a conflicting WHO. Never write an unavailable one.** Conflicting → withheld.
   Unavailable → pending, not sealed. `unresolved` is a recorded observation, not a failure and not
   agreement.
6. **One decision function, one place.** The classifier is a pure core function over (commit facts,
   claim, evidence rows, policy). The Worker runs it at ingestion for both producers. The gate, reconcile
   and the local hook path call the same function.
7. **The classifier judges the contribution claim, not the commit act (Codex v2.1 R3).** A trailer says
   "agent X made this commit". The only thing the ledger can test is whether X has authenticated, logged
   work on this commit's files. So the statuses are `supported` / `conflicting` / `unresolved` **of the
   contribution claim**; none of them authenticates who ran `git commit`. The seal's `actor` remains
   producer testimony about the commit act, bounded by the assert allow-list, and is labelled so.
   Withholding on `conflicting` is a *policy* response (the team rule is "commit only your own work", so
   a claimant with no logged work while others have some is what reconcile already calls
   `misattributed`), not an authentication result. The case this design **cannot** catch is stated in §4:
   agent A logs the edits, agent B commits them with A's trailer — the claim is `supported` and the
   wrong committer is written. Authenticating the commit act needs a separate, pinned-ingress
   **commit assertion** by the committing agent's own session: a `commit-intent` naming the tree (intent
   only — a tree belongs to many commits) and a `commit-ack` binding the canonical repository, the **full
   commit OID**, the authenticated principal/session and a replay nonce. Even that proves the session
   *asserted* the commit, not that it *executed* Git; proving execution needs a trusted execution observer.
   That is v3, out of scope here, and this note must not be read as an authentication guarantee (Codex
   #2737).

## 3. Evidence model

### 3.1 Commit facts (from the producer's event, before classification)

- canonical repository identity `R` (hook: `.retrace.json` project mapping + `RETRACE_GITHUB_PROJECTS`
  alias table; webhook: `repository.full_name`), full sha, parent shas;
- file set `F` = the producer's `repo:R#path` artifacts (both producers already emit them);
- claim `C` = `resolveCommitActor(...)` result plus **claim source** ∈ {`retrace-actor`, `co-authored-by`,
  `bot-author`, `human-author`, `malformed`}. `malformed` = a `Retrace-Actor` line is present but fails
  `validActorId`, or the trailer block is a single line containing literal `\n` (the #2030 shape);
- `caused_by` as parsed (trailer, else hook env/file fallbacks — recorded as `caused_by_source`).

### 3.2 Window

For each path `p ∈ F`: lower bound = `previousCaptureTouch(p)` (the last **trusted** seal in this project
that touched `p`, exactly as reconcile and attribution v7 define it — `capture.ts`), exclusive; upper
bound = `U` = the read head at the moment the **first** classification of this sha reads evidence.
That first read is persisted as a **classification context** row keyed `(project, canonical repo, full
sha)` — `{read_head_seq, read_head_hash, per_path_lower, policy_digest, first_producer, first_F_digest,
first_claim_digest}` — with an insert-if-absent unique constraint, *before* the first seal is appended.
The context is the **evaluation context only**: the window (`U` = `read_head_seq`, the per-path lower
bounds), the policy actually used, and — pinned to that same head — the alias/trust tables and the set of
effective amendments; touches of this same sha are excluded from the lower-bound search. Every later
classification of the same sha (the other producer, a pending retry, an offline re-derivation) reuses
exactly that context and **never the first seal's seq**: an edit that lands between the first read and
the first append is outside the window for everyone (Codex v2.1 R1; #2737 R1; T11, T26). Two concurrent
first classifiers race on the insert; the loser re-reads the winner's context and recomputes. A retry of any
kind — the other producer, a pending drain, a re-run after a timed-out synchronous query — **reuses an
existing context and never resets it**; "the drain creates the context" applies only when none exists
(#2801 R1). **Paths the first producer did not submit** (#2801 V23-4): if a later producer's `F` contains a
path `b` with no saved `lower(b)`, the classifier derives it deterministically as `previousCaptureTouch(b,
before = U)` evaluated on the ledger **at the snapshot head `U`** (that prefix is immutable, so the answer
is the same for everyone), caches it into the context row, and proceeds; it never defaults to the project
start, never uses today's head, and never strands the second seal. T37.

The context does **not** replace any producer's testimony (Codex #2737 R8/N2). Each producer's own
submitted `F`, parents, raw message and claim stay in that producer's own signed event, and each producer
is classified on **its own** `F` and claim against the shared window. `first_F_digest`/`first_claim_digest`
are recorded for reference only. If the producers' facts or claims differ, reconcile reports
`facts_disagreement` (§5.1) and the decisions may legitimately differ; "same decision" is promised only
for the same submitted inputs under the same context. A delivery deferred to the pending queue (§5.3) has
no context until the drain first classifies it; its window is that first-attempt read head. This is
**first-attempt semantics**, stated plainly: a deferred delivery is not promised to reproduce what a
synchronous classification would have decided (#2737 R1/R7; T18). Merge commits are classified on the
files the producer emitted; a merge with no emitted files is `merge_unclassified` (info).

### 3.3 Eligible witnesses

An event `E` witnesses path `p` for actor `A` iff all hold:

- `E.project` = this project; `lower(p) < E.seq ≤ U`;
- `E.method.params.sealed_by` starts with `pinned:` (**authenticated pinned ingress**; the Worker fixed
  `E.actor` from the credential). `assert:*`, `owner`, `webhook:github`, unstamped and local-only seals
  are **not** witnesses. A producer signature is recorded when present but does not substitute for the
  stamp (v7 rule);
- `E.actor.type === "agent"` and `E.action ∉ {instructed, committed, merged}` and `E.action_detail ≠ amended`;
- `E.artifacts` contains a reference to `p` with an **output claim**: canonical `repo:R#p` (or a
  configured alias of `R`) with `role ∈ {generated, both}`, or no role and `action ∈ {created, edited,
  deleted, renamed, moved}` (`generatesArtifact`, `sameArtifact`). Bare paths and `file:` references are
  **loose** and never corroborate (Grok); they are counted and reported as `loose_hints`.

- `E` is not itself the target of an effective attribution amendment at the read head (v7 rejects such
  evidence; the classifier must not admit what the corrector would refuse — Codex v2.1 R5).

`W(p)` = set of witnessing actors for `p`; `Wits` = all witness event ids; `Wall` = ∪ W(p).
Note the asymmetry with v7 (Codex R5): v7 accepts `pinned:` **or** `assert:` edit evidence for an
amendment; the classifier admits `pinned:` only, because an `assert:` edit's actor is the relaying
credential's claim. A witness set here is therefore, *at the evaluation head*, a subset of what an amendment may cite —
and it is a set of **candidates**: v7's final-ledger evaluation is authoritative for corrections, a
recorded witness can be disqualified by a later amendment (so the subset relation can stop holding
later), and an edit sealed in the open interval `(U, firstSeal.seq)` is outside the classifier's window
yet inside v7's correction window (#2737 R5; #2801 cleanup).

### 3.4 What the causal chain is for

`caused_by` is resolved with the existing exists/older/same-project rules. If it resolves, the root's id
and kind (`instructed` or otherwise) are recorded as `root`. It is **not** used to find witnesses (a
sibling edit under the same root is not in the ancestor chain; a foreign ancestor is not this commit).
Truncated or cyclic chains cannot produce `unresolved`, because `unresolved` is defined by `Wall = ∅`,
not by chain shape (Codex M1).

### 3.5 Read contract

Classification reads one bounded query: events in `(min lower, U]` referencing any `repo:R#p`, `p ∈ F`.
This needs an artifact index in D1 (`event_artifact_index(project, artifact_key, seq, actor_type, actor_id,
role, sealed_by)`, backfilled once from the ledger) — a build prerequisite, **landed** as PR 27 (9c3156b)
together with the bounded read (`eventsReferencingArtifacts`, typed `budget | deadline | store_error`). Budget: 500 ms
and 20,000 rows per commit; over budget, or any store error → **`unavailable`**, which is not sealed
(§5). The seal records `read_head_seq` and `policy = "trailer-consistency/1"` so the decision is
reproducible offline from an export.

## 4. Decision table

`C` = claimed actor, `Cs` = claim source, `Wall` = witnessing actors over this commit's files. The table
classifies the **contribution claim** (§2.7). Two consequences are stated up front:

- **Known gap:** agent A logs pinned edits to the files, agent B commits them carrying A's trailer → the
  claim is `supported` and `actor = A` is written. This guard cannot see B. Only a pinned-ingress commit
  assertion by the committing session (v3, §2.7) can. Reconcile's `misattributed` cannot see it either.
- **Meaning of `conflicting`:** other agents have authenticated work on these files and the claimant has
  none. Under the team rule "commit only your own paths" that is a policy violation and a false
  contribution claim; the WHO is withheld on that ground. An agent that truly committed another agent's
  work is `conflicting` too, and the human corrects it by amendment to the agent whose evidence exists.

| Case | `status` | `reason` | Recorded `actor` |
|---|---|---|---|
| `Cs` agent trailer/co-author, `C ∈ Wall` | `supported` | — | `C` |
| `Cs` agent, `Wall ≠ ∅`, `C ∉ Wall` | `conflicting` | `no_match` | **withheld** → producer system actor (`system/retrace-git` or `system/webhook:github`) |
| `Cs` agent, `Wall = ∅`, `loose_hints > 0` | `unresolved` | `loose_evidence_only` | policy (below) — `loose_hints` never changes the actor written; the reason is diagnostic only (NOOA v2 M4) |
| `Cs` agent, `Wall = ∅`, root resolves | `unresolved` | `root_only` | policy |
| `Cs` agent, `Wall = ∅`, no root / unverified `caused_by` | `unresolved` | `unrooted` | policy |
| `Cs` = `malformed`, `Wall ≠ ∅` | `conflicting` | `malformed_claim` | withheld |
| `Cs` = `malformed`, `Wall = ∅` | `unresolved` | `malformed_claim` | policy (fallback human is **not** written as agreement) |
| `Cs` human/bot author, `Wall ≠ ∅` | `human_claim_with_agent_evidence` | — | `C` (a human may commit an agent's work; coverage is a reconcile matter) |
| `Cs` human/bot author, `Wall = ∅` | `no_agent_evidence` | — | `C` |
| evidence read failed / over budget | `unavailable` | `store_error` / `deadline` / `budget` | **nothing sealed** — pending (§5) |

**Policy for `unresolved` (`.retrace.json` → `attribution.unresolved_claims`):**

- `"record"` — write `actor = C` **and** the status. The seal says, in hash-covered fields, "claimed by
  trailer, unsupported at read head N". Consumers show it as a claim (§7).
- `"withhold"` — write the producer system actor; the claim is preserved in `claim_decision.claim`.

**Decided (Jordan, 2026-09-08): `record` is the default for the first release.** Why: `record` knowingly writes
labelled, unsupported actor testimony; `withhold` writes the producer instead. Neither authenticates the
committer (§2.7). Since §7.2 requires coverage against the *claim* under either policy, the remaining
trade-off is compatibility and presentation: consumers that read only `actor` (older tools, dashboards)
see the claim under `record` and the producer under `withhold` (Codex #2737 restated the trade-off this
way; the earlier "coverage would disappear" rationale is withdrawn). Today most Boxing-RPG commits and a
fair share of retrace commits are `unresolved`; `record` keeps their presentation stable while the label
is rolled out everywhere, and the `withhold` switch exists from day one for a team that wants it. Either value is implementable with the same code; to overrule, set
`attribution.unresolved_claims: "withhold"` per project, or change this default in a later release. `conflicting` is **always** withheld; there is no policy to write a
WHO the ledger itself refutes.

## 5. Where it runs

### 5.1 Worker ingestion (both producers)

`POST /events` from an **assert** credential with a commit-shaped input (`action ∈ {committed, merged}`,
a `commit:` artifact, `method.tool = "git"`), and every `push` commit in `POST /hooks/github`, go through
`classifyCommitClaim` before `appendEvent`. The Worker overwrites `actor` per §4 and writes
`method.params.claim_decision` (§6). This is a server stamp like `sealed_by`: the assert allow-list is
applied to the **claim** (`body.actor`), and the server-derived system actor is not a client assertion,
so the hook credential's `allowed_actors` need no `system/*` entry. A caller-supplied `claim_decision` is
discarded (server wins, hash-covered — Codex H3: markers are derived server-side, never trusted from the
caller). Pinned credentials cannot record commit-shaped events as seals today (v7: "pinned client commit
claims do not become hook seals"); unchanged.

**What the Worker can and cannot bind (Codex v2.1 R4).** The hook supplies `F`, the parents and the
message; the Worker has no repository and cannot check them against Git. v2.2 therefore: (a) has the hook
send the **full raw commit message** (today it sends the trailer-stripped intent) and the parent shas, and
the Worker re-derives the claim itself — a claim the hook asserts that differs from the re-derived one is
`malformed`; (b) takes the webhook's `F` from GitHub's `added/modified/removed`, an independent
producer's facts; (c) adds reconcile kind `facts_disagreement` (fail) when the two producers' `F` or
parents for one sha differ; and (d) adds a **new** per-seal check, `facts_mismatch` (fail): reconcile
compares each seal's submitted `F` and parents against local Git (`git show --name-status -M`, renames
as `from→to`, merges against the first parent, the same canonicalisation as coverage); a seal whose facts
Git cannot confirm (object missing, truncated payload, unknown path form) is `facts_unknown` (warn), never
treated as clean. Today's reconcile computes coverage *from* Git facts but does **not** compare a seal's
facts *to* them (Codex #2737 R4) — this is new work. What remains **unbound** and is stated as a limit: a
holder of the hook's assert credential can submit a chosen `F` for a sha, and the classification stands
on those facts until an independent source is compared — the webhook's facts when it delivers, or local
Git when reconcile runs. Detection is **conditional** on that comparison happening; it is not a property
of the classifier. The threat model for v2 is an unmodified hook.

### 5.2 Hook (`retrace-git commit --hook`)

- Sends what it sends today plus `attribution_claim_source` and `caused_by_source` (both derived locally;
  the Worker re-derives the claim from the message and treats a mismatch as `malformed`).
- **No local pre-check.** v2 proposed refusing to send when an environment marker named a different
  harness than the trailer (NOOA Q4). NOOA's v2 review (H3) is right that a check an agent can defeat by
  unsetting a variable adds confidence without adding evidence, and a hook that *decides* locally would
  reintroduce the client-side trust boundary §5.1 removes. Dropped. Environment markers stay evidence on
  the seal (§6 `harness.marker`), nothing more.
- **Visibility (NOOA 2):** on any Worker 5xx, deadline, or `unavailable`, the hook prints a single
  stderr line naming the sha and the log path, exits non-zero, and appends the sha to
  `.git/retrace-pending-seal`. The commit itself is never blocked (post-commit cannot block it). The next
  hook run and `retrace-git backfill` retry pending shas first. `retrace doctor` reports a non-empty
  pending file as a FAIL (`pending seals`).

### 5.3 Webhook (`POST /hooks/github`, `push`)

- Deadline: 2,000 ms for the whole delivery, 500 ms per commit classification. GitHub expects a 2xx
  within 10 s and does not redeliver on its own (NOOA 1; Codex Q1).
- Before any classification the HMAC-verified raw delivery is written to a **durable `pending_deliveries`
  table** (delivery id, project, raw body, received_at; landed in PR 27). If that insert fails the response
  is **`500`**, never a 2xx — GitHub then shows a failed delivery an operator can redeliver (#2737 R7).
  Then each commit is classified and sealed; on success the pending row is deleted; the response is `201`
  with the sealed ids.
- On `unavailable` for any commit, or deadline: seal nothing further, keep the pending row, return
  **`202 {pending: [shas]}`**. A dedicated `*/5 * * * *` cron drains pending rows (NOOA v2 Q3; Codex R7
  asked for one consistent figure — it is five minutes everywhere in this document).
- **Pending state machine (Codex R7):** row states `received → leased(worker, expires_at) → done |
  budget_failed`. Per-commit outcomes are persisted inside the row (`outcomes: { [sha]: sealed | pending |
  budget_failed }`) so a crash after an append and before cleanup resumes idempotently (the `gh:push:`
  key dedups) and a terminal failure on one commit coexists with later successes in the same delivery
  without losing the audit trail. Leases expire after 60 s; a
  drain takes only unleased or expired rows. A commit whose evidence query exceeds the row budget on
  three drains is marked `budget_failed`, sealed **as nothing**, and surfaced as an audit finding with the
  sha — it is not retried forever and it does not block later commits in the same delivery. A row older
  than 24 h in any non-`done` state raises the audit finding `pending_deliveries`.
- **Circuit breaker:** state is **shared and scoped per project** (a D1 row `breaker(project, failures,
  opened_at)`; process-local counters cannot trip across Worker isolates, and a global counter would let
  one project's failures penalise another — #2737 R7). After 3 consecutive `deadline`/`store_error`
  outcomes within 5 min for a project, deliveries for that project skip synchronous classification and go
  straight to `202 pending` for 5 min; the first delivery after that is a half-open probe — success closes
  the breaker, failure re-opens it. The probe is **claimed atomically** (compare-and-set on the breaker
  row) so simultaneous deliveries do not all probe; an abandoned probe expires with the lease window; the
  failure-window timestamps live in the row, not in process memory (#2801 R7 notes). A breaker cannot force
  a `conflicting` or an `unresolved` outcome — those require a completed read (NOOA 1: latency must
  never be a catch-all). While the breaker is open the hook path is unaffected (it is a different route
  and budget), so a commit made on a hooked machine is still classified synchronously; only the webhook's
  second seal is delayed (NOOA v2 L7).
- Idempotency: `gh:push:<repo>:<sha>` unchanged; a pending row re-processed after a concurrent hook seal
  reuses the hook's stored classification context (§3.2) and dedups on its own key.

### 5.4 Local ledgers (`RETRACE_DB`, `retrace-serve`)

The hook calls `classifyCommitClaim` against the local store with the same budget rules. A local SQLite
ledger has no pinned ingress, so `Wall` is always empty there and every agent claim is `unresolved`
(`reason: no_authenticated_ingress`). That is the truth of a local ledger and is recorded as such.

## 6. Seal record

`method.params.claim_decision` on every commit seal produced after this ships (hash-covered; server-derived;
caller values discarded):

```
{
  policy: "trailer-consistency/1",
  observer: { producer: "git-hook" | "github-push", sealed_by: "<sealed_by value>" },
  claim: { type, id, source, model?, raw_trailers: { "retrace-actor"?: string, "co-authored-by"?: string[] } },
  caused_by: { id?, source: "trailer" | "env" | "file" | "none", root?: { id, action, actor: {type,id} }, problem? },
  decision: {
    status: "supported" | "conflicting" | "unresolved" | "human_claim_with_agent_evidence" | "no_agent_evidence" | "merge_unclassified",
    reason?: "no_match" | "malformed_claim" | "loose_evidence_only" | "root_only" | "unrooted" | "no_authenticated_ingress",
    actor_written: "claim" | "withheld",
    unresolved_policy: "record" | "withhold",
    context: { read_head_seq, read_head_hash, policy_digest, first_producer, first_F_digest, first_claim_digest },
    submitted: { F_digest, parents: [sha…], raw_message_param: "method.params.raw_message" },
    window: { upper_seq, per_path_lower: { [path]: seq } },
    witnesses: [ { id, seq, actor: {type,id}, paths: [..], sealed_by, producer_sig_verdict?, client?: "codex@x.y" } ],
    witness_actors: [ {type,id} ],
    loose_hints: n,
    harness: { marker?: "OPENCODE=1" | ..., marker_actor?: id, witness_clients: [ "opencode@1.18.29", ... ], mismatch: boolean }
  }
}
```

`actor` is `C` or the producer system actor per §4. `sealed_by` is unchanged (`assert:git hook (assert)`
/ `webhook:github`).

**Producer signatures (Codex v2.1 R2; #2737 R2/N1).** Hook seals are producer-signed (95 of 144 at
#2672), and the signed payload covers `actor.{type,id,on_behalf_of}` and `method.params` minus the
reserved server stamps. Rules:

1. **Format bump, bound in the signed bytes.** `retrace-producer-sig/2` puts its version inside the
   signed canonical payload (the existing `v` field), so a different format selects different signed
   bytes and no unsigned selector can pick a verifier (#2801 R2). `/2` excludes from the signed params
   exactly the **server annotation surface**: `sealed_by`, `producer_sig_verdict`, `relayed_by`,
   `claim_decision`, and `producer_signed_actor` — the complete list is a named constant
   (`RESERVED_METHOD_PARAMS_V2`) and adding to it later is a `/3`. `/1` keeps its exact old exclusions and
   **no** substitution rule; an absent `producer_sig.format` means `/1`; an unknown format fails closed.
2. **The producer signs its claim, with the inputs needed to re-derive it.** The hook's signed actor is
   always its claim `C` **including `on_behalf_of`**. The signed params carry `raw_message` **and**
   `author: { name, email }` (the inputs `resolveCommitActor` uses), so the verifier can re-derive the
   full signed actor deterministically — including the human-fallback and `on_behalf_of = author.email`
   cases (#2801 V23-2).
3. **Strict withheld-verification rule** (the only transformation a `/2` verifier accepts). Reconstruct
   the payload with `claim_decision.signed_actor` in place of the stored `actor` **only if all hold**: the
   event is a commit seal (`action ∈ {committed, merged}`, `method.tool = "git"`) with a trusted stamp
   (`sealed_by` in the project's trusted hook stamps, or `webhook:github`); the stored `actor` equals
   **exactly** the producer system actor for that stamp (`system/retrace-git` for the hook stamp,
   `system/webhook:github` for the webhook); **`claim_decision.decision.actor_written = "withheld"`** (one
   path; the verifier never accepts a second selector field — #2801 N1); `signed_actor` equals, field for
   field (`type`, `id`, `on_behalf_of`), the actor re-derived from the signed `raw_message` + `author`;
   and `claim_decision.claim.{type,id}` equals `signed_actor.{type,id}`. Any other combination is
   verified against the stored `actor` as today, and a mismatch is `invalid`. A hostile store therefore
   cannot re-point a signed event for A at an arbitrary B (T32).
4. **What the verdict says.** `producer_signed_actor` is a **derived verification result**, computed by
   the verifier from the verified bytes — never a client-supplied echo. The Worker may persist it as a
   `/2` server annotation (it is in the reserved list above, so it is outside the signed bytes); offline
   verifiers recompute it and ignore the stored copy. A reader sees "signed by the producer as A; actor
   withheld by the server", never an implied authentication of the rewritten actor. Server observations
   (`claim_decision`) are hash-chain-covered and not producer-authenticated; tampering with them is
   detected by the chain, not by the producer signature (T27).
5. **Old-client ingress (#2801 V23-1 — the prerequisite before shadow).** A `/1`-signed commit seal
   cannot receive any new annotation without breaking its signature. Rule: in **shadow** the Worker
   seals a `/1` commit seal **byte-for-byte as submitted** (no `claim_decision`, actor unchanged) and
   stores the computed decision only in the classification-context row for reporting; `/status`
   counts such seals as `legacy_client`. In **enforce**, a `/1` commit seal from an assert credential is
   refused with `426 Upgrade Required` naming the minimum CLI version; the hook treats 426 as **queued
   and loud** (pending-seal file + stderr + non-zero exit — an explicit exception to the 4xx-is-not-
   retryable rule, because upgrading fixes it) and `retrace doctor` reports the version gap. Unsigned
   commit seals (no `producer_sig`) are annotated freely in both phases. Acceptance: T27 covers `/1`
   ingress in shadow and enforce, and online + offline round trips for **every** `/2` server annotation. `intent` keeps the commit subject/body verbatim; nothing about the trailer is
removed from the record. Older seals have no `claim_decision` block and are `legacy` to every consumer.

## 7. Consumers

### 7.0 One resolution predicate for every consumer (Codex v2.1 R5)

The sealed `claim_decision` never changes. Two derived predicates, one shared core function each, are
what every consumer reads (Codex #2737 R5 asked for the narrower meaning to be explicit):

- **`resolved_status`** — *amendment effectiveness only*: `supported` if the recorded status is
  `supported`, or if effective v7 amendments (evaluated on the **current final ledger**, not the saved
  witness list) cover **every** file of the commit's canonical Git scope on the **primary seal**;
  otherwise the recorded status with `residual_files`. Missing Git context → `unavailable`, never
  inferred success.
- **`may_downgrade`** — applies **only** to amendment-based transformations (#2801 V23-3): it decides
  whether an effective amendment is allowed to downgrade a recorded `conflicting`/`unresolved` finding.
  An ordinary commit — recorded `supported`, two agreeing producers, no amendment — is evaluated by the
  recorded-report rules exactly as today and needs no certificate. When an amendment is present,
  `may_downgrade = true` requires: `resolved_status = supported` **and** no open `producer_disagreement`
  for the sha (unacknowledged, including warning-level lone-producer findings — reconcile rule 4
  unchanged; **acknowledging that disagreement does lift this clause**, as rule 4 already allows) **and**
  no `facts_disagreement`, no `facts_mismatch`, and **no `facts_unknown`** (unknown facts veto promotion
  and leave a mandatory WARN; they are never treated as clean) **and** the exact selected seal, matching
  canonical Git domain and windows, per-file certificate as v7 §6 defines. Independent failures
  (`facts_*`, `missing_commit`, …) are aggregated after the transformation, never hidden by it. A fully
  amended webhook-primary seal whose hook seal is still missing is `resolved_status = supported`,
  `may_downgrade = false`: red until the second producer arrives or the disagreement is acknowledged.

The primary seal of a sha is the **earliest trusted seal by seq** — a seal carrying a trusted hook stamp
or `webhook:github`, never a pinned client commit claim — whichever producer made it, and it never
changes when a later producer's seal arrives (T30). Reconcile's current hook-first selection migrates to
this rule in the same change. Two acknowledgements are different things (#2801 R5): acknowledging a **producer disagreement** satisfies
rule 4 and can therefore flip `may_downgrade`; acknowledging a **`conflicting_claim`** changes neither
predicate — it downgrades that finding to *acknowledged* (WARN) for reconcile's exit code, the gate's
`HEAD delivery`, **and** the NOOA audit alike, so a raw `conflicting` never fails forever once a human has
acknowledged it. Gate, reconcile and the audit read the same two predicates and the same ACK rules; none
re-implements them.

### 7.1 Gate (`retrace doctor --gate`)

- `HEAD delivery`: FAIL when the head seal's `resolved_status = conflicting`; WARN when `unresolved`
  under `record` (message names the missing evidence: "no pinned edit by agent/X names any of these N
  files between #a and #b"); FAIL when `pending seals` file is non-empty; INFO for
  `human_claim_with_agent_evidence`.
- `pin/session` keeps comparing against the verified ledger; it now uses `claim_decision.decision.witnesses`
  when present (same function), and reports `harness.mismatch` as a non-blocking finding.

### 7.2 Reconcile

- New kind `conflicting_claim` (fail): a seal with `status = conflicting`. Correction only by
  amendment (§8); an acknowledgement downgrades to acknowledged, never to attributed.
- `unresolved` is **not** a new kind: it is attached to **every commit verdict** as `claim_status`
  (rendered as a `CLAIM` line even when the commit has no other finding — a locally covered commit can
  still be `unresolved` here because `assert:`/local edits satisfy coverage but are not witnesses; Codex
  R8), so nothing is double-counted and nothing disappears.
- **Producer comparison becomes a three-way comparison** (Codex H4): hook and webhook seals of one sha
  are compared on `claim` (must be equal — otherwise the pushed commit differs from the committed one:
  `producer_disagreement`, fail, as today), then on `decision.status`. Two `conflicting` seals whose
  actors are both system producers are **not** `producer_disagreement`; they are one `conflicting_claim`
  with two observers. Order of comparison (#2801 R8): **first** normalise and compare the two producers' submitted
  facts and claims — different `F`/parents → `facts_disagreement`, different claim → `producer_disagreement`
  on claim, and in either case the computed outcomes are **not** compared (a `supported` vs `unresolved`
  pair with different `F` is a legitimate consequence of different facts, not a reproducibility failure).
  **Only** when inputs and context match are outcomes compared, and a mismatch there is
  `producer_disagreement` with `reason: decision_divergence` and both contexts — which §3.2's stored
  context should make unreachable. One policy governs a sha (the policy frozen in its context, §3.2); a
  change of the stored policy document between the two seals is reported as **current-policy drift**, a
  separate observation, never as a second effective policy. A legacy seal paired with a new one is
  compared on claim only.
- Coverage for a withheld seal is evaluated against **the claim**, not the system actor, so `uncovered`
  and `misattributed` keep working when a team chooses `withhold` (otherwise all such commits would
  collapse into `non_agent`).
- `ackFor`: the accused is the **claimed** actor when a claim exists, plus the producer; a claimed agent
  cannot acknowledge its own conflicting or unresolved commit (Codex H4).

### 7.3 `status`, `why`, export UI, audit

`retrace_status`/`/status` count seals by `decision.status` for the last N commits (the number Grok
measures, §9). `why` and the export UI render `claim → decision` on commit seals ("claimed codex;
conflicting: pinned edits by opencode on 3/3 files"). The NOOA hourly audit fails on any commit in the window with `resolved_status = conflicting` or
`may_downgrade = false` after an amendment, and on `pending_deliveries` older than 24 h (§7.0 governs;
the audit never reads the raw status alone).

## 8. Correction lifecycle

- A `conflicting` or `unresolved` seal is corrected only by a **Tier-1 human attribution amendment**
  targeting **that exact seal event** (v7), per scope (files), with a beneficiary that has a clean,
  strictly identified, in-window witness for every file in scope. The classifier's `claim_decision.decision.witnesses`
  are exactly the candidate evidence; the CLI pre-fills them (`amend-attribution --from-seal <evt>`),
  and the v7 evaluator still decides. Fabricated or out-of-window evidence is rejected by v7 as today.
- Two producers, two seals: the amendment targets the **primary** seal (earliest trusted seal, §7.0).
  When both producers are present with matching claims and decisions, rule 4 is satisfied because matching
  decisions are not disagreements (§7.2). When the second producer is missing, or recorded a different
  claim, the veto holds (`may_downgrade = false`) until it arrives or the disagreement is acknowledged;
  the amendment is effective meanwhile but does not turn anything green (#2737 R5). A second amendment on
  the other seal is permitted but not required, and a later-arriving seal never becomes primary.
- If no witness exists for the claimed agent (a copied trailer and *no* logged work), there is nothing
  to amend to: the truthful end state is the withheld seal with an acknowledged `conflicting_claim` or a
  labelled `unresolved`. The design does not invent a WHO to make the row green.
- Amendments never change `decision.*` on the original seal; consumers show "recorded → effective" as
  they do for every amendment.

## 9. Rollout and measurement

1. **Phase A — shadow.** Classify and record `claim_decision` on every seal; `actor` unchanged even for
   `conflicting` (`actor_written: "claim"`, `shadow: true`). Run ≥ 7 days on `retrace` and
   `boxing-rpg`. Grok reports the status histogram and every `conflicting` case by hand.
2. **Phase B — withhold conflicting.** Default on. Gate/reconcile/audit consumers live.
3. **Phase C — `unresolved` policy.** `record` by default; `withhold` available. Jordan decides per
   project after seeing Phase A numbers.

Overrule path: each phase is a Worker config flag (`RETRACE_TRAILER_POLICY = shadow | enforce`), and
the per-project `attribution.unresolved_claims` lives in `.retrace.json` beside the existing
`attribution` block. **Policy distribution (Codex R8):** the Worker does not read `.retrace.json`. The
effective per-project policy (unresolved policy, repository aliases, trusted hook stamps) is a stored
**project policy document** on the Worker, set by the owner (`PUT /projects/:p/policy`, owner token),
and its `policy_digest` is recorded in every classification context and seal. Two things are kept apart
(#2737 R8): the **policy used** (frozen in the context; every classification of that sha uses it) and
**current policy drift** (the stored document has changed since — reported by `retrace doctor` as a WARN
naming both digests, and by reconcile as `policy_divergence` between a sha's producers only when their
contexts differ, which the shared context prevents). Policy documents are versioned and retained on the
Worker and included in the export bundle by digest, so a retired alias table can be reconstructed
offline; a digest alone is not enough.

## 10. Scope and limits (stated, not solved here)

- **Principal binding (Codex M3; NOOA v2 H1):** two humans holding `agent/codex` credentials in one
  project collapse to one `{type,id}`. v2.1 makes the issuance rule a **build prerequisite** rather than a
  note: `retrace-admin` refuses to mint a second pinned credential for the same `{project, type, id}`
  unless the existing one is retired, **and** every credential carries an immutable `principal` (the
  human or team it was issued to); an actor id, once bound to a principal in a project, is **never
  re-issued to a different principal** — a new person gets a new id (Codex v2.1 R6: retire-then-reissue
  would let the second principal consume the first's in-window witnesses). `/status` reports any project
  where two live pinned credentials share an actor id (`shared_actor_id`, fail-level for the gate). The classifier keeps `{type,id}` as
  actor equality (a credential id in the actor key would make every rotation a new identity) and records
  each witness's `sealed_by` and `producer_sig_verdict` so a binding dispute can be audited. It never uses
  git author email, model, session or client name as identity.
- **Compromised or wrong-identity MCP credential:** out of scope (the rollout and admin tool own it).
- **Human commits:** never withheld; agent evidence in their window is recorded, not judged.
- **Legacy seals:** untouched; every consumer treats a seal without `claim_decision` as `legacy`.
- **Local ledgers:** always `unresolved / no_authenticated_ingress`; documented in the stranger walk.
- **Environment markers:** evidence only, hook only, and only for the local pre-check (§5.2). A
  `Retrace-Harness` trailer (NOOA 5) is **declined**: the post-commit hook cannot add trailers, and a
  trailer the agent writes is another self-claim; the witnesses' server-stamped `location.client`
  already gives the webhook harness evidence.

## 11. Acceptance tests (adversarial first; each names the finding it closes)

1. Trailer `codex`, pinned `opencode` edits name all files → `conflicting/no_match`, withheld;
   gate FAIL; reconcile `conflicting_claim`. (v1 T1; Grok scenario)
2. Trailer `codex`, root-only chain, no edits anywhere → `unresolved/root_only`; under `record` actor
   = codex **with** status; under `withhold` system actor; reconcile still reports `uncovered`. (Codex H1)
3. Trailer `codex`, sibling `opencode` edits under the same instruct root (not ancestors) →
   `conflicting`. (Codex H1, Grok)
4. Trailer `codex`, chain contains an old codex event that names none of this commit's files, pinned
   `opencode` edits name them → `conflicting`. (Codex H2)
5. Trailer `codex`, the only "codex" event in window is a prior **git seal** (trailer-derived,
   `assert:` stamp) → not a witness → `unresolved`, never `supported`. (Codex H3)
6. Trailer `codex`, one pinned codex edit names one of three files, opencode names the other two →
   `supported` (actor equality is per commit, not per file); reconcile's per-file `misattributed`
   WARNs still fire for the two files. (v1 T2 refined)
7. Foreign-project, missing, newer, or cyclic `caused_by` → `caused_by.problem` recorded; status is
   decided by witnesses alone. (Codex M1)
8. `Retrace-Actor:` present but invalid, pinned copilot edits in window → `conflicting/malformed_claim`,
   withheld; the #2030 shape never seals as a human. (Codex M2)
9. Literal `\n` trailer block, no edits → `unresolved/malformed_claim`; `claim.source = malformed`. (M2)
10. Same `agent/codex` id from two credentials in one project → both witness; test documents that the
    classifier cannot distinguish them and that `sealed_by` differs in `witnesses[]`. (Codex M3)
11. (a) Hook then webhook, evidence appended between them → identical decisions because the webhook
    reuses the hook's stored context. (b) Webhook then hook → identical decisions because the hook reuses
    the webhook's stored context. Reconcile reports no disagreement in either order, given equal submitted
    facts and claims. (Codex H4, #2737 R1; NOOA v2 M6, L10)
12. Hook and webhook both `conflicting` → one `conflicting_claim`, no `producer_disagreement`. (H4)
13. Commit amended after the hook sealed it → a **different sha** is pushed: the hook's seal becomes
    `unreachable_seal`, the webhook's is a lone-producer `producer_disagreement`, as today. (Codex R8
    corrected v2.1's wording: an amend is never a same-sha pair.) A same-sha pair whose submitted `F` or
    parents differ is `facts_disagreement`. (R4)
14. Human-sealed amendment citing `claim_decision.decision.witnesses` for all files → effective; reconcile AMND;
    gate passes. (NOOA 6a)
15. Amendment citing an out-of-window or unstamped event → rejected by v7; an `assert:`-stamped in-window
    edit is accepted by v7 even though the classifier would not count it as a witness. (NOOA 6b; #2737 R5)
16. Claimed agent posts a `correction` on its own conflicting commit → not an acknowledgement. (H4)
17. Assert credential POSTs a commit-shaped event with `claim_decision` pre-filled → discarded and
    re-derived server-side. (H3)
18. Webhook store read exceeds 500 ms → `202 pending`, nothing sealed, row drained by the 5-minute cron;
    the drain's first classification creates the context (first-attempt semantics) and the seal records
    it. No equivalence with a hypothetical synchronous decision is asserted. (NOOA 1; Codex Q1, #2737 R1)
19. Three consecutive deadlines → breaker open → immediate `202 pending`; a `conflicting` outcome cannot
    be produced while the breaker is open. (NOOA 1)
20. Hook: Worker 503 → stderr line, non-zero exit, sha in `.git/retrace-pending-seal`; next hook run
    seals it first; doctor FAIL while pending. (NOOA 2)
21. Two live pinned credentials for one `{project, agent id}` → `retrace-admin` refuses the mint; `/status`
    reports `shared_actor_id`; gate FAIL. (NOOA v2 H1)
22. Harness: witnesses' clients all `cursor@…`, claim `opencode` supported by a pinned `opencode`
    credential → `harness.mismatch = true`, informational only. (NOOA 3)
23. Duplicate webhook delivery of a sealed push → dedup on `gh:push:` key, no second classification.
24. Local ledger (`RETRACE_DB`) → `unresolved/no_authenticated_ingress` for every agent claim.
25. Shadow mode: `conflicting` computed, actor still written, `shadow: true`; consumers report but do
    not fail. (§9 A)
26. Read-before-append race: first classifier reads head 100, a matching pinned edit lands at 101, first
    seal appends at 102; second producer reuses the stored context (U = 100) → identical decisions; two
    concurrent first classifiers → one context row wins, the other recomputes from it. (Codex R1)
27. Producer-signature round trip (`/2`): signed hook input → record/supported, record/unresolved,
    withheld, shadow → online and offline `verified` with `producer_signed_actor` = the claim; a `/1`
    legacy event verifies under the `/1` rule unchanged; a tampered `signed_actor` → `invalid`; a tampered
    `claim_decision.claim` → hash-chain failure (not a signature failure). (Codex R2, #2737 R2)
28. Hook payload with a chosen `F` omitting a disputed path → classification stands on the submitted
    facts; webhook seal of the same sha carries GitHub's `F` → `facts_disagreement` (fail). (Codex R4)
29. Retire `agent/codex` credential of principal Alice, request mint of `agent/codex` for principal Bob
    in the same project → refused; same principal → allowed. (Codex R6)
30. Webhook seals first (primary), human amends it to the evidenced agent, hook seal arrives later →
    primary unchanged, `resolved_status = supported` on every consumer without a second amendment.
    (Codex R5)
31. Agent A's pinned edits, agent B commits with A's trailer → `supported`, `actor = A` written; test
    documents this as the known gap (§4) and asserts nothing else claims to catch it. (Codex R3)
32. Selector injection: a signed non-commit event, or a commit seal whose stored actor is not the exact
    producer system actor, or whose `signed_actor` differs from the claim re-derived from the signed
    `raw_message`, or whose `claim_decision.claim` differs from `signed_actor` → verified against the
    stored actor → `invalid`. (#2737 N1)
33. Hook submits `F = {a}` for a commit whose Git diff is `{a, b}`; no webhook → reconcile `facts_mismatch`
    (fail); object missing locally → `facts_unknown` (warn), never clean. (#2737 R4)
34. Webhook-primary `conflicting` seal fully amended, hook seal absent → `resolved_status = supported`,
    `may_downgrade = false`, gate red; hook seal arrives with the same claim → `may_downgrade = true`.
    (#2737 R5)
35. First producer submits `F = {a}`, claim A; second submits `F = {a, b}`, claim B → both classified on
    their own inputs under one context; reconcile `facts_disagreement` + claim disagreement; neither
    producer's event is rewritten. (#2737 R8/N2)
36. Breaker: three failures for project X open X's breaker only; project Y deliveries still classify
    synchronously; after 5 min one X delivery probes half-open. Counters are read from the shared row, not
    process memory. (#2737 R7)
37. First producer submits `F = {a}`; second submits `F = {a, b}` → `lower(b)` derived at the snapshot head
    `U` and cached in the context; a pinned edit to `b` sealed after `U` is outside the window; a
    pre-`U` edit to `b` after its previous touch is inside. Both orders. (#2801 V23-4)
38. Old client: a `/1`-signed commit seal in shadow is stored byte-identical with no annotation and
    counted `legacy_client`; in enforce it is refused with 426, the hook queues it loudly, doctor reports
    the version gap; an unsigned commit seal is annotated in both phases. (#2801 V23-1)
39. Signed-actor derivation: agent trailer with author email → `signed_actor.on_behalf_of` re-derived
    from signed `author.email`; malformed trailer with human fallback → re-derived human actor; both
    verify; dropping `author` from the signed params → `invalid`. (#2801 V23-2)
40. Clean commit, two agreeing producers, `supported`, no amendment → passes the recorded-report rules
    without any certificate; `may_downgrade` is never consulted. (#2801 V23-3)

## 12. Open questions for v2 review

- **Q1 — closed.** Default for `unresolved` is `record` (Jordan, 2026-09-08, §4); `withhold` stays a per-project switch.
- **Q2 — closed:** a sha binds the immutable Git object, so two producers can never see different
  *commits* under one sha; they can, however, **submit different facts** (`F`, parents, message) about it,
  which is why §3.2 freezes the facts in the classification context and §5.1 adds `facts_disagreement`.
- **Q3 — closed:** dedicated `*/5 * * * *` drain for `pending_deliveries` (NOOA v2 answer; cost trivial on
  Workers Paid).
- **Q4 — moot:** the local pre-check and its marker table were removed in v2.1 (§5.2).

## 13. PR 19 (OpenCode)

Unchanged in effect: this design does not unblock PR 19. With v2 built, an OpenCode commit carrying a
copied `Retrace-Actor: codex` becomes `conflicting` **only if** OpenCode logged its edits through its
pinned credential; if it logged nothing, the copied trailer is `unresolved`, and under `record` the false
WHO is still written (labelled). So PR 19 needs both: Phase B live, and a measured run (Grok) showing the
OpenCode harness logs file edits for its commits at a coverage Jordan accepts — or the upstream
instruction-precedence fix. The two onboarding defects Codex found remain separate.

## 14. Review disposition

| Finding | Answer |
|---|---|
| Codex H1 empty peers permit false WHO | §4 `unresolved` is explicit; policy `record`/`withhold`; T2, T3 |
| Codex H2 any ancestor ≠ commit identity | §3.3 commit-file witnesses; §3.4 chain is secondary; T4 |
| Codex H3 peer eligibility / enforcement boundary | §3.3 pinned ingress only; §5.1 server-side for both producers; T5, T17 |
| Codex H4 correction lifecycle | §7.2 three-way comparison, ack accused = claim; §8; T11–T16 |
| Codex M1 chain completeness | §3.4, §3.5 bounded query, read head, `unavailable` ≠ `unresolved`; T7 |
| Codex M2 human fallback bypass | §3.1 claim source, §4 malformed rows; T8, T9 |
| Codex M3 principal binding | §10; witness provenance recorded; T10 |
| Codex Q1 sync vs async | §5.3 durable pending + 202, deadline, breaker; T18, T19 |
| Codex Q2 identity fields | §3.3 `{type,id}`; client is evidence (§6 `harness`) |
| Codex Q3 OpenCode | §13 |
| Grok: `/why` from root omits siblings | §3.3/§3.4 window evidence, not chain; T3 |
| Grok: hook cannot stamp system actor | §5.1 server-derived actor at ingestion |
| Grok: amendment needs canonical `repo:#` | §3.3 loose refs never corroborate; §8 pre-filled witnesses |
| NOOA 1 webhook timeout/breaker | §5.3; T18, T19 |
| NOOA 2 hook stall visibility | §5.2; T20 |
| NOOA 3 harness family | §6 `harness`, §7.1 mismatch finding; T22 |
| NOOA 4 conflict kind | §4/§6 `status` + `reason` |
| NOOA 5 harness trailer | declined, §10 (witness `location.client` covers the webhook) |
| NOOA 6 amendment round-trip | §8; T14–T16 |
| NOOA Q4 local pre-check | §5.2; T21 |

## 14b. v2 review disposition (NOOA/Nemotron 3 Ultra, run review_trailer_v2_20260909T035317Z)

*Historical record of how earlier findings were answered at the time. Where an answer below describes a
mechanism that later changed (e.g. "U = first seal's seq", "the context freezes F and the claim"), §3.2,
§5–§7 as currently written govern; the tables are not alternative implementation instructions.*

| Finding | Answer |
|---|---|
| H1 principal binding collapse | Accepted as a build prerequisite: issuance refuses duplicate `{project,type,id}`; `shared_actor_id` status/gate finding (§10; T21). Credential id is deliberately **not** part of actor equality. |
| H2 default `record` writes an unsupported WHO | **Owner decision, not folded.** Jordan chose `record` (§4, 2026-09-08) after the trade-off was put to him; NOOA's argument (consumers that read only `actor` see the claim) and the coordinator's (withholding erases coverage findings until every consumer changes) are both recorded here. Re-open only by Jordan. Mitigation kept: `claim_decision.decision` is hash-covered and every first-party consumer renders it (§7). |
| H3 local pre-check bypassable | Accepted: pre-check removed (§5.2). Markers remain evidence only. |
| M4 `loose_hints` under `record` | Accepted: clarified that `loose_hints` is diagnostic and never changes the actor written (§4). |
| M5 human commit with agent evidence → write the agent | **Declined.** A `committed` event's WHO is who performed the commit act; content authorship is what attribution amendments and reconcile express (v7 contract; precedent 0905a8e, Jordan committing cursor-agent's docs). Writing the witnessing agent as the committer would be a new falsehood. The evidence is recorded on the seal and surfaces as a reconcile finding. |
| M6 webhook-first race | Accepted as clarification: `U` = earliest existing seal in either order (§3.2); T11b added. |
| L7 breaker delays detection | Accepted as clarification: hook path unaffected; only the webhook's second seal is delayed (§5.3). Synchronous fallback under an open breaker declined (it re-creates the latency path the breaker exists to cut). |
| L8 merge commits unclassified | Partly accepted: both producers already emit the merge's changed files (first-parent diff), so merges are classified; `merge_unclassified` applies only when a producer emits no files, and is info-level. No change to §3.2. |
| L9 Tier-2 agent amendment for `unresolved` | **Declined.** v7 amendments are human-sealed by design (Tier 1 authority); an in-window witness that "arrives later" is by definition outside the window, which closed at the seal. The truthful record of a late log is a late log, linked by `caused_by`, not a re-attribution. |
| L10 T11 order assumption | Accepted: T11 split into (a)/(b). |
| Q1 → `withhold` | See H2. |
| Q2 → no | Agreed. |
| Q3 → 5-minute drain | Accepted: dedicated `*/5 * * * *` drain for `pending_deliveries` (§12 Q3 closed). |
| Q4 → hook owns the table | Moot: the pre-check and its table are removed; markers are evidence only. |

## 14c. v2.1 review disposition (Codex, #2716)

| Finding | Answer |
|---|---|
| R1 fixed `U` does not fix the first snapshot | Accepted: persisted classification context keyed by (project, repo, full sha), insert-if-absent, reused by every later classification; freezes `U`, per-path lowers, `F`, claim and policy digests (§3.2; T26). |
| R2 classification invalidates producer signatures | Accepted: `claim_decision` is a reserved server stamp (unsigned, distinct key from amendment params); withheld seals keep `signed_actor` and both verifiers substitute it (§6; T27). |
| R3 contribution evidence ≠ commit actor | Accepted, and it reframes the document: statuses renamed `supported` / `conflicting` / `unresolved` **of the contribution claim** (§2.7); the seal's `actor` is labelled producer testimony; the A-edits/B-commits gap is stated in §4 with T31; authenticated commit assertion named as v3. Withholding on `conflicting` is kept as a policy response and justified as such. |
| R4 Worker does not authenticate hook-selected facts | Accepted with a stated limit: hook sends the raw message + parents and the Worker re-derives the claim; webhook `F` is GitHub's; new `facts_disagreement`; a forged hook payload is caught by the second producer or reconcile, not the classifier (§5.1; T13, T28). |
| R5 no consistent amendment discharge rule | Accepted: shared `resolved_status` predicate for gate/reconcile/audit; primary = earliest seal by seq, never displaced; ACK distinguished from resolution; classifier excludes amended witnesses; v7's pinned-or-assert evidence rule stated correctly (§3.3, §7.0; T30). v2.1's T15 claim about v7 was wrong and is withdrawn. |
| R6 sequential principal reassignment | Accepted: immutable `principal` on credentials; an actor id is never re-issued to a different principal (§10; T29). |
| R7 pending/breaker recovery semantics | Accepted: five minutes everywhere; `received → leased → done | budget_failed` state machine, leases, per-commit progress, bounded retries, no starvation (§5.3). |
| R8 comparison matrix, T13, unresolved rendering, policy distribution | Accepted: context digests make "same decision" mean same inputs; `policy_divergence`; legacy pairing; T13 rewritten; `claim_status` on every verdict; stored project policy document with digest (§3.2, §7.2, §9). |
| H1 residual under `record` | Acknowledged as Jordan's accepted residual; unchanged. |

## 14d. v2.2 closure review disposition (Codex, #2737)

| Finding | Answer |
|---|---|
| R1 PARTIAL — leftovers said "first seal's seq"; deferred deliveries have no context | Accepted: the stored context is the sole upper-bound rule everywhere (§3.2, §5.3, T11); all inputs pinned to the saved head; deferred deliveries get first-attempt semantics, stated, and T18's equivalence promise is removed. |
| R2 PARTIAL / N1 HIGH — unsigned selector can redirect verification; historical-format risk; T27 overclaim | Accepted: format bump to `retrace-producer-sig/2`; strict withheld-verification rule (commit seal + trusted stamp + exact system actor + `signed_actor` equals the claim re-derived from the signed `raw_message` + claim consistency); `producer_signed_actor` exposed; T27 corrected, T32 added (§6). |
| R3 CLOSED | — |
| R4 PARTIAL — reconcile does not compare seal facts to Git today | Accepted: the false claim is withdrawn; new `facts_mismatch`/`facts_unknown` per-seal Git comparison specified; detection stated as conditional (§5.1; T33). |
| R5 PARTIAL — amendment can turn a seal green past the rule-4 veto; T15 stale; earliest must be trusted | Accepted: `resolved_status` narrowed to amendment effectiveness on the current final ledger; separate mandatory `may_downgrade` with rule 4, facts checks and Git-context availability; primary = earliest **trusted** seal; reconcile's hook-first selection migrates; witnesses are candidates; T15 fixed, T34 added (§3.3, §7.0, §7.3, §8). |
| R6 CLOSED | Noted: a team principal identifies the team, not its members. |
| R7 PARTIAL — breaker state/scope; durable insert failure; per-commit outcomes | Accepted: shared per-project breaker row with half-open probe; durable insert failure → 500; per-commit `outcomes` persisted (§5.3; T36). |
| R8 PARTIAL / N2 HIGH — shared context would overwrite producer testimony | Accepted: context is evaluation-only; each producer classified on its own submitted facts and claim; first producer's digests recorded for reference; policy used vs policy drift separated; policy documents retained and exported (§3.2, §6, §9; T35). |
| N3 LOW — stale `attribution.*` names, legacy definition | Accepted: fixed (§4, §10). |
| v3 note | Refined per review: tree for intent, full OID + principal/session + replay for completion, execution observer for "executed" (§2.7). |
| Owner policy | `record` kept; rationale rewritten to the compatibility/presentation trade-off (§4). |

## 14e. v2.3 closure review disposition (Codex, #2801)

| Finding | Answer |
|---|---|
| R1, R4, R7, N1, N2, N3 CLOSED | Implementation notes carried into §3.2 (retry reuses context), §5.3 (atomic probe, expiring leases), §15. |
| R2 PARTIAL / V23-1 HIGH — annotation surface and old-client rollout | Accepted: complete `/2` reserved annotation list; version bound in signed bytes; `producer_signed_actor` derived, not echoed; `/1` old-client ingress defined for shadow (byte-preserving, `legacy_client`) and enforce (426, queued loudly) (§6 rules 1, 4, 5; T27, T38). Prerequisite before shadow (§15 step 1). |
| V23-2 MEDIUM — derivation inputs; selector path | Accepted: signed `author` + `raw_message`; full-actor comparison incl. `on_behalf_of`; single selector path `claim_decision.decision.actor_written` (§6 rules 2–3; T39). |
| R5 PARTIAL / V23-3 MEDIUM — predicate scope, `facts_unknown`, ACK | Accepted: `may_downgrade` limited to amendment transformations; `facts_unknown` vetoes promotion with mandatory WARN; two ACK kinds distinguished, audit outcome defined (§7.0; T40). |
| V23-4 MEDIUM — new path without saved lower bound | Accepted: deterministic derivation at snapshot head `U`, cached in context (§3.2; T37). |
| R8 PARTIAL — comparison order, policy drift | Accepted: inputs compared first, outcomes only on matching inputs+context; one policy-used per sha, drift separate (§7.2). |
| Cleanup | Open interval `(U, firstSeal.seq)`; subset qualified by evaluation head; §14b–d marked historical. |
| Buildability | Codex: bounded implementation PR is supported; not approved for live shadow *unchanged* because of V23-1. v2.4 folds V23-1..4; §15 orders the build so the signed-format contract lands and is round-trip-tested before the shadow flag is ever on. |

## 15. Acceptance, build order and tracked notes

**Accepted with notes (2026-09-09).** Reviewed across four rounds by Codex (v1, v2.1, v2.2, v2.3), NOOA/Nemotron
3 Ultra (v1, v2) and Grok (v1). No reviewer requests further redesign; the remaining items are
implementation contracts and fixtures, listed here so the builder and the reviewer of the code share one list.
Grok's review of v2.4 (from 2026-09-11) is welcome and may reopen this section; it does not block step 1.

**Build order (each step is its own PR, Codex reviews the code, Claude reviews last):**

1. **Signed-format contract** (§6): `retrace-producer-sig/2` with the reserved annotation constant and
   version-in-payload; hook signs `/2` with `raw_message` + `author` + parents; verifier dispatch (`/1`
   unchanged, absent = `/1`, unknown = fail closed); `producer_signed_actor` derived; old-client ingress
   for shadow and enforce; T27, T32, T38, T39 as tests. **Must merge and deploy before step 3.**
2. **Credential `principal`** and never-reissue rule (§10; PR 27 follow-up); `RETRACE_GITHUB_PROJECTS`
   → stored project policy document with digest (§9); `npm run migrate` switched to the query endpoint.
3. **Classifier in shadow** (§3–§6, `RETRACE_TRAILER_POLICY=shadow`): classification-context table with
   insert-if-absent and lower-bound derivation (T26, T37); evidence read via `eventsReferencingArtifacts`;
   `claim_decision` on `/2`-signed and unsigned commit seals only; `/1` seals byte-preserved and counted.
   Webhook pending path and per-project breaker (§5.3; T18, T19, T36). No actor rewriting.
4. **Consumers** (§7): `resolved_status`, `may_downgrade`, `claim_status` on every verdict,
   `conflicting_claim`, `facts_disagreement`, `facts_mismatch`/`facts_unknown`, three-way comparison with
   inputs compared first, ACK rules, audit alignment; gate `pending seals` already landed (PR 26).
5. **Phase A measurement** ≥ 7 days (Grok): status histogram on `retrace` and `boxing-rpg`; every
   `conflicting` case read by hand; `legacy_client` count must be zero before step 6; **cost profile**
   published (tracked note below).
6. **Enforce** (`RETRACE_TRAILER_POLICY=enforce`): withhold on `conflicting`; 426 for `/1` commit seals;
   `unresolved` stays `record` (Jordan's decision) with the per-project `withhold` switch.

**Tracked notes (not blocking acceptance; each must be closed by the PR that touches its area):**

- Breaker: atomic half-open claim, lease expiry, failure-window persistence, drain/breaker interaction (§5.3).
- `facts_mismatch` diff profile: root commits, copies/renames, first-parent merges, incomplete webhook parent data (§5.1).
- Fixture set: T35 different-`F` in both orders; T37 boundary for the new path; T11 both orders under one context.
- Reconcile's hook-first primary selection migrates to earliest-trusted in the step-4 PR, with a test on an existing repo export.
- §14b–d are historical; a builder who finds prose contradicting §3–§7 follows §3–§7 and files the discrepancy.
- Known, accepted limits (not defects): the A-edits/B-commits gap (§4); hook-selected facts until an independent comparison (§5.1); `record` writes labelled, unsupported testimony (§4); local ledgers are always `unresolved` (§5.4).
- **Cost profile (added 2026-09-09, from outside review; measured in step 5, Grok).** The scheme is
  unmeasured on what it costs the agents that feed it, and "log every changed file" raises granularity.
  Report, per project over the Phase A window: `retrace_log` calls per commit (from the ledger:
  agent events between consecutive commit seals, by actor); tokens per call (tool input bytes at the
  MCP boundary, counted not estimated, plus the `retrace` tool-schema bytes each harness loads at
  handshake — a fixed per-session context cost); hook wall-clock p50/p95 from commit to sealed
  response, and the pending-seal retry count; Worker classification time per seal (§5.3 deadline
  budget). Publish the numbers with the histogram even if they are unflattering; a cost we cannot state
  is a claim we cannot make. No target is set here — Jordan reads the numbers before step 6, like the
  `unresolved` policy (§9 Phase C).
- v3 candidates, out of scope: authenticated commit assertion (§2.7); harness-native trailers as named claim sources (`Agent-Logs-Url`, `Made with Cursor`, `Claude-Session`, `Assisted-by:`) — verified to exist at scale on 2026-09-08 (see ledger #2777).
