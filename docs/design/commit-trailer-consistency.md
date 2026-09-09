# Commit trailer consistency — design note

**Status:** draft v2.1, 2026-09-08. Author: claude-code. Not built. v2 (ee9c889) was reviewed by NOOA/Nemotron
3 Ultra (evt_f787df612d0d413ba13f1b887f160fc5, run review_trailer_v2_20260909T035317Z): needs changes, 3 High / 3 Medium / 4 Low — dispositions in
§14b. Codex and Grok reviews of v2 pending.
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
| System seal + `attribution_conflict` marker. | Every commit seal carries `method.params.attribution` = **observer / claim / decision**, with `status`, `reason`, witnesses, read head and policy version. Contradicted claims get no agent WHO. | Codex H4; NOOA 4 |
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
5. **Never write a contradicted WHO. Never write an unavailable one.** Contradicted → withheld.
   Unavailable → pending, not sealed. `unresolved` is a recorded observation, not a failure and not
   agreement.
6. **One decision function, one place.** The classifier is a pure core function over (commit facts,
   claim, evidence rows, policy). The Worker runs it at ingestion for both producers. The gate, reconcile
   and the local hook path call the same function.

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
bound = `U` = the seq of the **earliest existing seal of this sha in the project** if one exists,
else the read head at classification time. Fixing `U` to the first seal makes the second producer's
decision reproduce the first's (§7.2), in either order: if the webhook classifies first, its seal becomes
`U` for the hook's later classification, so evidence appended between the two read heads is outside both
windows (NOOA v2 M6; T11a/T11b). Merge commits are classified on their own files only if the
producer emitted them; otherwise status `merge_unclassified` (info).

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

`W(p)` = set of witnessing actors for `p`; `Wits` = all witness event ids; `Wall` = ∪ W(p).

### 3.4 What the causal chain is for

`caused_by` is resolved with the existing exists/older/same-project rules. If it resolves, the root's id
and kind (`instructed` or otherwise) are recorded as `root`. It is **not** used to find witnesses (a
sibling edit under the same root is not in the ancestor chain; a foreign ancestor is not this commit).
Truncated or cyclic chains cannot produce `unresolved`, because `unresolved` is defined by `Wall = ∅`,
not by chain shape (Codex M1).

### 3.5 Read contract

Classification reads one bounded query: events in `(min lower, U]` referencing any `repo:R#p`, `p ∈ F`.
This needs an artifact index in D1 (`event_artifacts(project, artifact_key, seq, actor_type, actor_id,
role, sealed_by)`, backfilled once from the ledger) — a build prerequisite, not optional. Budget: 500 ms
and 20,000 rows per commit; over budget, or any store error → **`unavailable`**, which is not sealed
(§5). The seal records `read_head_seq` and `policy = "trailer-consistency/1"` so the decision is
reproducible offline from an export.

## 4. Decision table

`C` = claimed actor, `Cs` = claim source, `Wall` = witnessing actors over this commit's files.

| Case | `status` | `reason` | Recorded `actor` |
|---|---|---|---|
| `Cs` agent trailer/co-author, `C ∈ Wall` | `corroborated` | — | `C` |
| `Cs` agent, `Wall ≠ ∅`, `C ∉ Wall` | `contradicted` | `no_match` | **withheld** → producer system actor (`system/retrace-git` or `system/webhook:github`) |
| `Cs` agent, `Wall = ∅`, `loose_hints > 0` | `unresolved` | `loose_evidence_only` | policy (below) — `loose_hints` never changes the actor written; the reason is diagnostic only (NOOA v2 M4) |
| `Cs` agent, `Wall = ∅`, root resolves | `unresolved` | `root_only` | policy |
| `Cs` agent, `Wall = ∅`, no root / unverified `caused_by` | `unresolved` | `unrooted` | policy |
| `Cs` = `malformed`, `Wall ≠ ∅` | `contradicted` | `malformed_claim` | withheld |
| `Cs` = `malformed`, `Wall = ∅` | `unresolved` | `malformed_claim` | policy (fallback human is **not** written as agreement) |
| `Cs` human/bot author, `Wall ≠ ∅` | `human_claim_with_agent_evidence` | — | `C` (a human may commit an agent's work; coverage is a reconcile matter) |
| `Cs` human/bot author, `Wall = ∅` | `no_agent_evidence` | — | `C` |
| evidence read failed / over budget | `unavailable` | `store_error` / `deadline` / `budget` | **nothing sealed** — pending (§5) |

**Policy for `unresolved` (`.retrace.json` → `attribution.unresolved_claims`):**

- `"record"` — write `actor = C` **and** the status. The seal says, in hash-covered fields, "claimed by
  trailer, uncorroborated at read head N". Consumers show it as a claim (§7).
- `"withhold"` — write the producer system actor; the claim is preserved in `attribution.claim`.

**Decided (Jordan, 2026-09-08): `record` is the default for the first release.** Why: Today most Boxing-RPG
commits and a fair share of retrace commits are `unresolved` (their agents logged no file edits); a
silent flip to system seals would erase `uncovered` and `misattributed` from reconcile for all of them
unless every consumer is changed in the same release. `record` keeps every existing finding, adds the
truthful label everywhere the seal is shown, and the `withhold` switch exists from day one for a team
that wants it. Either value is implementable with the same code; to overrule, set
`attribution.unresolved_claims: "withhold"` per project, or change this default in a later release. `contradicted` is **always** withheld; there is no policy to write a
WHO the ledger itself refutes.

## 5. Where it runs

### 5.1 Worker ingestion (both producers)

`POST /events` from an **assert** credential with a commit-shaped input (`action ∈ {committed, merged}`,
a `commit:` artifact, `method.tool = "git"`), and every `push` commit in `POST /hooks/github`, go through
`classifyCommitClaim` before `appendEvent`. The Worker overwrites `actor` per §4 and writes
`method.params.attribution` (§6). This is a server stamp like `sealed_by`: the assert allow-list is
applied to the **claim** (`body.actor`), and the server-derived system actor is not a client assertion,
so the hook credential's `allowed_actors` need no `system/*` entry. A caller-supplied `attribution` is
discarded (server wins, hash-covered — Codex H3: markers are derived server-side, never trusted from the
caller). Pinned credentials cannot record commit-shaped events as seals today (v7: "pinned client commit
claims do not become hook seals"); unchanged.

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
  table** (delivery id, project, raw body, received_at). Then each commit is classified and sealed; on
  success the pending row is deleted; the response is `201` with the sealed ids.
- On `unavailable` for any commit, or deadline: seal nothing further, keep the pending row, return
  **`202 {pending: [shas]}`**. The hourly cron (`7 * * * *`, already present for the export cache)
  drains pending rows; a row older than 24 h raises the Worker's audit finding `pending_deliveries`
  (NOOA audit already reads `/status`).
- **Circuit breaker:** after 3 consecutive `deadline`/`store_error` outcomes within 5 min the webhook
  skips synchronous classification and goes straight to `202 pending` for 5 min. A breaker cannot force
  a `contradicted` or an `unresolved` outcome — those require a completed read (NOOA 1: latency must
  never be a catch-all). While the breaker is open the hook path is unaffected (it is a different route
  and budget), so a commit made on a hooked machine is still classified synchronously; only the webhook's
  second seal is delayed (NOOA v2 L7).
- Idempotency: `gh:push:<repo>:<sha>` unchanged; a pending row re-processed after a concurrent hook seal
  simply uses `U` = the hook seal's seq (§3.2) and dedups on its own key.

### 5.4 Local ledgers (`RETRACE_DB`, `retrace-serve`)

The hook calls `classifyCommitClaim` against the local store with the same budget rules. A local SQLite
ledger has no pinned ingress, so `Wall` is always empty there and every agent claim is `unresolved`
(`reason: no_authenticated_ingress`). That is the truth of a local ledger and is recorded as such.

## 6. Seal record

`method.params.attribution` on every commit seal produced after this ships (hash-covered; server-derived;
caller values discarded):

```
{
  policy: "trailer-consistency/1",
  observer: { producer: "git-hook" | "github-push", sealed_by: "<sealed_by value>" },
  claim: { type, id, source, model?, raw_trailers: { "retrace-actor"?: string, "co-authored-by"?: string[] } },
  caused_by: { id?, source: "trailer" | "env" | "file" | "none", root?: { id, action, actor: {type,id} }, problem? },
  decision: {
    status: "corroborated" | "contradicted" | "unresolved" | "human_claim_with_agent_evidence" | "no_agent_evidence" | "merge_unclassified",
    reason?: "no_match" | "malformed_claim" | "loose_evidence_only" | "root_only" | "unrooted" | "no_authenticated_ingress",
    actor_written: "claim" | "withheld",
    unresolved_policy: "record" | "withhold",
    read_head_seq, window: { upper_seq, per_path_lower: { [path]: seq } },
    witnesses: [ { id, seq, actor: {type,id}, paths: [..], sealed_by, producer_sig_verdict?, client?: "codex@x.y" } ],
    witness_actors: [ {type,id} ],
    loose_hints: n,
    harness: { marker?: "OPENCODE=1" | ..., marker_actor?: id, witness_clients: [ "opencode@1.18.29", ... ], mismatch: boolean }
  }
}
```

`actor` is `C` or the producer system actor per §4. `sealed_by` is unchanged (`assert:git hook (assert)`
/ `webhook:github`). `intent` keeps the commit subject/body verbatim; nothing about the trailer is
removed from the record. Older seals have no `attribution` block and are `legacy` to every consumer.

## 7. Consumers

### 7.1 Gate (`retrace doctor --gate`)

- `HEAD delivery`: FAIL when the head seal's `decision.status = contradicted`; WARN when `unresolved`
  under `record` (message names the missing evidence: "no pinned edit by agent/X names any of these N
  files between #a and #b"); FAIL when `pending seals` file is non-empty; INFO for
  `human_claim_with_agent_evidence`.
- `pin/session` keeps comparing against the verified ledger; it now uses `decision.witnesses`
  when present (same function), and reports `harness.mismatch` as a non-blocking finding.

### 7.2 Reconcile

- New kind `contradicted_claim` (fail): a seal with `status = contradicted`. Correction only by
  amendment (§8); an acknowledgement downgrades to acknowledged, never to attributed.
- `unresolved` is **not** a new kind: it annotates the existing `uncovered` findings (`CLAIM` prefix in
  the text output) so nothing is double-counted.
- **Producer comparison becomes a three-way comparison** (Codex H4): hook and webhook seals of one sha
  are compared on `claim` (must be equal — otherwise the pushed commit differs from the committed one:
  `producer_disagreement`, fail, as today), then on `decision.status`. Two `contradicted` seals whose
  actors are both system producers are **not** `producer_disagreement`; they are one `contradicted_claim`
  with two observers. A `corroborated` vs `unresolved` pair can only arise if the second producer read a
  different window — which §3.2's fixed `U` prevents; if it happens anyway it is reported as
  `producer_disagreement` with `reason: decision_divergence` and both read heads.
- Coverage for a withheld seal is evaluated against **the claim**, not the system actor, so `uncovered`
  and `misattributed` keep working when a team chooses `withhold` (otherwise all such commits would
  collapse into `non_agent`).
- `ackFor`: the accused is the **claimed** actor when a claim exists, plus the producer; a claimed agent
  cannot acknowledge its own contradicted or unresolved commit (Codex H4).

### 7.3 `status`, `why`, export UI, audit

`retrace_status`/`/status` count seals by `decision.status` for the last N commits (the number Grok
measures, §9). `why` and the export UI render `claim → decision` on commit seals ("claimed codex;
contradicted: pinned edits by opencode on 3/3 files"). The NOOA hourly audit fails on any
`contradicted_claim` in the window and on `pending_deliveries` older than 24 h.

## 8. Correction lifecycle

- A `contradicted` or `unresolved` seal is corrected only by a **Tier-1 human attribution amendment**
  targeting **that exact seal event** (v7), per scope (files), with a beneficiary that has a clean,
  strictly identified, in-window witness for every file in scope. The classifier's `decision.witnesses`
  are exactly the candidate evidence; the CLI pre-fills them (`amend-attribution --from-seal <evt>`),
  and the v7 evaluator still decides. Fabricated or out-of-window evidence is rejected by v7 as today.
- Two producers, two seals: the amendment targets the **primary** seal (hook if present, else webhook)
  and reconcile's downgrade rule 4 (no open `producer_disagreement`) is satisfied because matching
  decisions are not disagreements (§7.2). A second amendment on the other seal is permitted but not
  required.
- If no witness exists for the claimed agent (a copied trailer and *no* logged work), there is nothing
  to amend to: the truthful end state is the withheld seal with an acknowledged `contradicted_claim` or a
  labelled `unresolved`. The design does not invent a WHO to make the row green.
- Amendments never change `decision.*` on the original seal; consumers show "recorded → effective" as
  they do for every amendment.

## 9. Rollout and measurement

1. **Phase A — shadow.** Classify and record `attribution` on every seal; `actor` unchanged even for
   `contradicted` (`actor_written: "claim"`, `shadow: true`). Run ≥ 7 days on `retrace` and
   `boxing-rpg`. Grok reports the status histogram and every `contradicted` case by hand.
2. **Phase B — withhold contradicted.** Default on. Gate/reconcile/audit consumers live.
3. **Phase C — `unresolved` policy.** `record` by default; `withhold` available. Jordan decides per
   project after seeing Phase A numbers.

Overrule path: each phase is a Worker config flag (`RETRACE_TRAILER_POLICY = shadow | enforce`), and
the per-project `attribution.unresolved_claims` lives in `.retrace.json` beside the existing
`attribution` block.

## 10. Scope and limits (stated, not solved here)

- **Principal binding (Codex M3; NOOA v2 H1):** two humans holding `agent/codex` credentials in one
  project collapse to one `{type,id}`. v2.1 makes the issuance rule a **build prerequisite** rather than a
  note: `retrace-admin` refuses to mint a second pinned credential for the same `{project, type, id}`
  unless the existing one is retired, and `/status` reports any project where two live pinned credentials
  share an actor id (`shared_actor_id`, fail-level for the gate). The classifier keeps `{type,id}` as
  actor equality (a credential id in the actor key would make every rotation a new identity) and records
  each witness's `sealed_by` and `producer_sig_verdict` so a binding dispute can be audited. It never uses
  git author email, model, session or client name as identity.
- **Compromised or wrong-identity MCP credential:** out of scope (the rollout and admin tool own it).
- **Human commits:** never withheld; agent evidence in their window is recorded, not judged.
- **Legacy seals:** untouched; every consumer treats a seal without `attribution` as `legacy`.
- **Local ledgers:** always `unresolved / no_authenticated_ingress`; documented in the stranger walk.
- **Environment markers:** evidence only, hook only, and only for the local pre-check (§5.2). A
  `Retrace-Harness` trailer (NOOA 5) is **declined**: the post-commit hook cannot add trailers, and a
  trailer the agent writes is another self-claim; the witnesses' server-stamped `location.client`
  already gives the webhook harness evidence.

## 11. Acceptance tests (adversarial first; each names the finding it closes)

1. Trailer `codex`, pinned `opencode` edits name all files → `contradicted/no_match`, withheld;
   gate FAIL; reconcile `contradicted_claim`. (v1 T1; Grok scenario)
2. Trailer `codex`, root-only chain, no edits anywhere → `unresolved/root_only`; under `record` actor
   = codex **with** status; under `withhold` system actor; reconcile still reports `uncovered`. (Codex H1)
3. Trailer `codex`, sibling `opencode` edits under the same instruct root (not ancestors) →
   `contradicted`. (Codex H1, Grok)
4. Trailer `codex`, chain contains an old codex event that names none of this commit's files, pinned
   `opencode` edits name them → `contradicted`. (Codex H2)
5. Trailer `codex`, the only "codex" event in window is a prior **git seal** (trailer-derived,
   `assert:` stamp) → not a witness → `unresolved`, never `corroborated`. (Codex H3)
6. Trailer `codex`, one pinned codex edit names one of three files, opencode names the other two →
   `corroborated` (actor equality is per commit, not per file); reconcile's per-file `misattributed`
   WARNs still fire for the two files. (v1 T2 refined)
7. Foreign-project, missing, newer, or cyclic `caused_by` → `caused_by.problem` recorded; status is
   decided by witnesses alone. (Codex M1)
8. `Retrace-Actor:` present but invalid, pinned copilot edits in window → `contradicted/malformed_claim`,
   withheld; the #2030 shape never seals as a human. (Codex M2)
9. Literal `\n` trailer block, no edits → `unresolved/malformed_claim`; `claim.source = malformed`. (M2)
10. Same `agent/codex` id from two credentials in one project → both witness; test documents that the
    classifier cannot distinguish them and that `sealed_by` differs in `witnesses[]`. (Codex M3)
11. (a) Hook then webhook, evidence appended between them → identical decisions because `U` is the hook
    seal's seq. (b) Webhook then hook, evidence appended between them → identical decisions because `U`
    is the webhook seal's seq. Reconcile reports no disagreement in either order. (Codex H4; NOOA v2 M6, L10)
12. Hook and webhook both `contradicted` → one `contradicted_claim`, no `producer_disagreement`. (H4)
13. Pushed commit differs from committed (amended after hook) → claims differ → `producer_disagreement`
    as today. (H4)
14. Human-sealed amendment citing `decision.witnesses` for all files → effective; reconcile AMND;
    gate passes. (NOOA 6a)
15. Amendment citing an out-of-window or non-pinned event → rejected by v7. (NOOA 6b)
16. Claimed agent posts a `correction` on its own contradicted commit → not an acknowledgement. (H4)
17. Assert credential POSTs a commit-shaped event with `attribution` pre-filled → discarded and
    re-derived server-side. (H3)
18. Webhook store read exceeds 500 ms → `202 pending`, nothing sealed, row drained by cron, final seal
    identical to the synchronous one. (NOOA 1; Codex Q1)
19. Three consecutive deadlines → breaker open → immediate `202 pending`; a `contradicted` outcome cannot
    be produced while the breaker is open. (NOOA 1)
20. Hook: Worker 503 → stderr line, non-zero exit, sha in `.git/retrace-pending-seal`; next hook run
    seals it first; doctor FAIL while pending. (NOOA 2)
21. Two live pinned credentials for one `{project, agent id}` → `retrace-admin` refuses the mint; `/status`
    reports `shared_actor_id`; gate FAIL. (NOOA v2 H1)
22. Harness: witnesses' clients all `cursor@…`, claim `opencode` corroborated by a pinned `opencode`
    credential → `harness.mismatch = true`, informational only. (NOOA 3)
23. Duplicate webhook delivery of a sealed push → dedup on `gh:push:` key, no second classification.
24. Local ledger (`RETRACE_DB`) → `unresolved/no_authenticated_ingress` for every agent claim.
25. Shadow mode: `contradicted` computed, actor still written, `shadow: true`; consumers report but do
    not fail. (§9 A)

## 12. Open questions for v2 review

- **Q1 — closed.** Default for `unresolved` is `record` (Jordan, 2026-09-08, §4); `withhold` stays a per-project switch.
- **Q2:** window upper bound `U` = first existing seal of the sha (§3.2). Any case where the webhook
  legitimately sees a *different* commit under the same sha? (None known — sha binds content.)
- **Q3 — closed:** dedicated `*/5 * * * *` drain for `pending_deliveries` (NOOA v2 answer; cost trivial on
  Workers Paid).
- **Q4 — moot:** the local pre-check and its marker table were removed in v2.1 (§5.2).

## 13. PR 19 (OpenCode)

Unchanged in effect: this design does not unblock PR 19. With v2 built, an OpenCode commit carrying a
copied `Retrace-Actor: codex` becomes `contradicted` **only if** OpenCode logged its edits through its
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

| Finding | Answer |
|---|---|
| H1 principal binding collapse | Accepted as a build prerequisite: issuance refuses duplicate `{project,type,id}`; `shared_actor_id` status/gate finding (§10; T21). Credential id is deliberately **not** part of actor equality. |
| H2 default `record` writes an uncorroborated WHO | **Owner decision, not folded.** Jordan chose `record` (§4, 2026-09-08) after the trade-off was put to him; NOOA's argument (consumers that read only `actor` see the claim) and the coordinator's (withholding erases coverage findings until every consumer changes) are both recorded here. Re-open only by Jordan. Mitigation kept: `attribution.decision` is hash-covered and every first-party consumer renders it (§7). |
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
