# Project policy document — contract (trailer-consistency §15 step 2)

**Status:** DRAFT v2, 2026-09-10, author claude-code. v1 (d3aec24) was reviewed by Codex (design review,
commit comment 2026-09-10T03:16Z): *request changes* — direction right, five contract gaps (F1–F5).
v2 folds every finding; dispositions in §10. For Codex's second pass before build. Companion to
`commit-trailer-consistency.md` §3.2/§3.5 (snapshot and read budget), §6 rule 3 (trusted hook stamps),
§9 (policy distribution and drift) and §15 step 2. Nothing here changes a classification rule or Jordan's
`unresolved_claims: record` default; it defines where the Worker and the offline verifier get the
per-project policy they already require, and how a seal's `policy_digest` stays resolvable years later.

## 1. Why a stored document

The Worker does not read `.retrace.json` (§9). Step 1 shipped a verifier that substitutes a withheld actor
only for stamps in the project's **trusted hook stamps**, bound to a **named project** (PR 29). Today that
list reaches the verifier only from `.retrace.json` on the CLI side; the Worker passes none, and an export
bundle carries no policy. Step 3 needs the Worker to select a policy atomically with its evidence snapshot,
and every seal must record **which version** decided it. So the policy is a stored, append-only,
digest-addressed document on the Worker, set by the owner, exported with every bundle that references it.

## 2. Document: body and envelope

Two layers, hashed together. The **body** is what the owner writes; the **envelope** is what the server
adds. The digest identifies the *version* (body + envelope), not merely "equivalent settings" (Codex F1).

```
body (owner-supplied, validated):
  profile:             "retrace-project-policy/1"
  project:             "<ledger project>"                 // must equal the URL's :p
  trusted_hook_stamps: ["assert:git hook (assert)", …]  // exact sealed_by strings; sorted, unique, non-empty strings
  unresolved_claims:   "record" | "withhold"              // §9 Phase C; default "record" (Jordan)
  repositories:        [ { name: "<canonical repo>", aliases: ["…"] } ]   // artifact-name aliases only; sorted by name
  github_repos:        [ "<canonical repo>", … ]          // repositories routed to THIS project; sorted, unique

envelope (server-assigned, immutable):
  version:    <int ≥ 1, monotonic per project>
  created_at: "<ISO 8601 UTC, server clock>"
  set_by:     { type: "human" | "team", id: "<configured owner principal>" }
  supersedes: "<policy_digest of version-1>" | null

policy_digest = sha256( canonical_v1( { ...body, ...envelope } ) )    // everything above; hex
```

Canonical form `canonical_v1` is **frozen by this document**, not by a helper's name (Codex F1): JSON with
object keys sorted by UTF-16 code unit, no insignificant whitespace, strings as JSON escapes with `\u`
lower-case hex, integers only (no floats anywhere in a `/1` body), arrays in the order given — which the
validator has already forced to sorted/unique for every array in `/1`, so array order cannot vary. No
defaults are materialised into the hash: every `/1` field is **required** and the validator rejects a body
that omits one (so "absent" and "default" can never hash differently). Nested objects validate by the same
rules. Unknown fields anywhere → 400. **Golden vectors:** `packages/core/src/fixtures/policy-v1/*.json`
hold three bodies with their exact canonical bytes and digests; the test suite recomputes them on every
run, and `retrace-export verify` refuses a bundle whose policy profile it does not know.

`github_repos` entries are **canonical repository identities** — `owner/name` lower-cased as GitHub
reports `repository.full_name` — and the same canonicalisation is applied to the webhook payload before
routing (Codex F3). A body may only route repositories to its own `project`; there is no cross-project
field.

## 3. Endpoints (Worker and `retrace-serve`)

- `PUT /projects/:p/policy` — **owner authority only** (§9; Codex Q3). Body = the body layer only;
  `project` must equal `:p`. Optional header `If-Match: <expected current policy_digest>` (or `"none"` for
  the first version): a mismatch is `412` — the way a stale administrative update is rejected. The server
  validates, assigns the envelope, computes the digest, and **appends** in one transaction whose version
  assignment is `SELECT MAX(version)+1` under a write lock (D1: single statement with the uniqueness
  constraint; SQLite: `BEGIN IMMEDIATE`); a version collision retries once and then returns `409`.
  Identical body to the current version → `200` with the current document, nothing written (deterministic
  no-op, digest unchanged). Otherwise `201` with the new document. Documents are never updated or
  deleted.
  - **`set_by`** is the Worker's configured owner principal (`RETRACE_OWNER`, already the identity used
    for owner-only DELETE audits), never a request-supplied actor and never invented. Where the owner is
    a team, `RETRACE_OWNER` may be `team:<id>`; the schema records `{type:"team"}` honestly. Possession
    of the shared owner bearer identifies the owner principal, not an individual; the document says so.
  - `retrace-serve` (local): owner authority means the configured `RETRACE_TOKEN` bearer **and** a
    configured `RETRACE_OWNER`; a permissive/no-auth local server has no owner and `PUT` returns `403`
    with "no owner principal configured" — permissiveness never satisfies owner-only (Codex Q3).
- `GET /projects/:p/policy` — the current document. `GET /projects/:p/policy?digest=<hex>` — exactly that
  version, **constrained to `:p`**: a digest that belongs to another project is `404` (Codex F1).
  `?version=n` likewise. Readable by any credential scoped to the project.
- `GET /projects/:p/policy/history` — every version, newest first, bounded by `?limit=` (default 50).
- **Unique active routing** (Codex F3): a `PUT` whose `github_repos` claims a repository that another
  project's *current* document already routes is `409` naming the other project, unless the same request
  is an explicit reassignment (`?reassign=<other project>`), which the server applies atomically by
  recording the reassignment on both projects' histories. Routing is never resolved by iteration order.

## 4. Storage and read budget

D1 / SQLite:

```
project_policies (project TEXT, version INTEGER, digest TEXT UNIQUE, body TEXT, envelope TEXT,
                  created_at TEXT, PRIMARY KEY (project, version))
policy_routes    (repo TEXT PRIMARY KEY, project TEXT, digest TEXT, set_at TEXT)   -- current routing, one row per repository
```

`SCHEMA_SQL` gains both (`IF NOT EXISTS`); `npm run migrate` applies through the query endpoint
(`wrangler d1 execute --command`; the import API needs OAuth the CLI lacks). Every read the classifier
or verifier performs is a **single indexed point lookup** — `(project, digest)` or `(project, MAX(version))`
or `(repo)` — inside the §3.5 bounded operation; a failure is an explicit `unavailable`, never a scan of
history or of other projects' documents (Codex F4).

## 5. Selection versus retrieval (the precedence question, answered — Codex F2)

Two different questions, kept apart:

**A. Which version applies?**
| Situation | Version |
|---|---|
| A **new** classification context is being created for a sha (step 3) | the project's current document, read in the **same snapshot** as the evidence head `U` (§6 below); its digest is written into the context as `context.policy_digest` |
| An **existing** context / a seal that carries `context.policy_digest` — any later producer, retry, drained delivery, newly encountered path, amendment, or offline verification | **exactly** `(event.project, context.policy_digest)`. Never the latest, never a union of versions, never cwd config, never another project's document. If that version cannot be retrieved: `unavailable` (online) / `policy_missing` **invalid** (offline) — fail closed |
| A `/2` withheld seal being verified (rule 3) | the trusted stamps of the version named by the seal's `context.policy_digest`; a seal with no context (pre-step-3) has no substitution path — as today |
| Current document differs from the version a context used | **drift**, reported (doctor WARN `policy_drift` naming both digests); never applied retroactively. v1 trusts X, v2 removes X: a v1-context seal still reconstructs under v1. v2 adds X: a v1-context seal does not gain it |

**B. Where is that version retrieved from?**
| Consumer | Source |
|---|---|
| Worker (ingestion, verification, status) | `project_policies` by `(project, digest)` |
| Offline verify / export / report | `bundle.policies` — the bundle carries **every** `(project, digest)` referenced by any exported seal or context, retired versions included, placed **before** the issuer signature is computed; the verifier recomputes each digest, checks `profile` and `document.project == event.project == bundle.scope.project`, rejects conflicting definitions of one digest, and reports missing / corrupt / unsupported-profile policy per event (Codex F1) |
| CLI reconcile / doctor / attribution with a Worker configured | the Worker, by digest for existing contexts and current for drift |
| Local-only ledgers (`RETRACE_DB`, `retrace-serve`) | their own `project_policies` table, written by the local `PUT`; `.retrace.json` `reconcile.hook_sealed_by` is **only** the bootstrap source for the first local document — never verifier authority (Codex F5). Local classifications (always `unresolved / no_authenticated_ingress`, §5.4) still record the digest so they are reproducible |
| Legacy seals (no context) | no policy is manufactured for them; format-specific behaviour unchanged |

A content hash proves identity, not authorisation. The reference is authenticated by the seal it sits in
(hash chain, producer signature) and the enclosed document by the issuer-signed export — no separate
policy-signing scheme (Codex F1).

## 6. The atomic selection interface step 3 will call (Codex F4)

```
selectPolicyForContext(project, U): { digest, version } | unavailable
```
Reads the current document **in the same store snapshot** that produced the evidence head `U`
(`read_head_seq/hash`): on D1, one batched statement list reading head and current policy; on SQLite, one
`BEGIN` … `COMMIT`. The context row's insert-if-absent winner records `policy_digest` **and**
`policy_selected_at_seq = U`; every other producer, retry and new path resolves that context and uses its
digest (§3.2). A `PUT` that commits after `U` is drift for that context, not a change to it. Because the
context also stores `U`, the relationship "this policy was current at head `U`" is verifiable later from
the exported context plus `bundle.policies` (created_at and version alone do not establish it).

Recorded **separately** from the document (so `policy_digest` is not mistaken for a hash of every
execution setting): `classifier_profile: "trailer-consistency/1"`, `rollout_mode: off|shadow|enforce` at
selection, and the amendment snapshot the context used. All of these are exported with the context;
`/1`-signed events stay byte-preserved (§6 rule 5). Repository-mapping changes never cause an existing sha
to acquire a second context under another repository name: the context is keyed by
`(project, sha)`, and routing is resolved **before** context lookup using the routing recorded with the
pending delivery (below).

## 7. Webhook routing and the env fallback (Codex F3)

Order at delivery time: (1) canonicalise `repository.full_name`; (2) `policy_routes` lookup → project,
with the routing digest; (3) only if **no stored route exists for that repository** and the candidate
project from `RETRACE_GITHUB_PROJECTS` **has no document at all** (an unbootstrapped project), use the env
mapping; (4) otherwise `unroutable` → `202 pending` with reason, reported on `/status`. The resolved
`(project, routing source: "policy" | "env", digest)` is stored **with the pending delivery** and reused
on drain, so an env or policy change between receipt and drain cannot move a delivery into another trust
domain. Once a project has a document, removing a route never resurrects its env route (rule 3 above).
`/status` reports `routing: env_fallback` per repository still on env; the env is deleted after every
mapped project has a document (a later step). The fallback supplies **routing only** — never trusted
stamps, never a stand-in for a missing policy: an unbootstrapped project's commits are sealed but not
classified (`unavailable / policy_missing`).

## 8. Bootstrap (Codex F5)

`retrace-admin set-policy <project> --from <repo>/.retrace.json [--url] [--if-match <digest>|none]`
builds a body from the repo's `reconcile.hook_sealed_by`, `attribution.repositories`, and the Worker's
current env mapping for that project; prints the body and its would-be digest; PUTs on confirmation.
- If the file declares `project` and it differs from `<project>`: **refused**. `--cross-project-copy`
  is the explicit, printed override (the owner is copying A's list to B on purpose).
- If the file declares no `project`, the directory basename is shown as a **hint** only; the owner names
  the project on the command line. Basename is never verifier authority.
- Drift check for doctor: compare the local file's *settings* (stamps, aliases, unresolved) with the
  **body** of the current stored document — never with the envelope digest, which a local file cannot
  reproduce. Report as `local_config_drift` (WARN), distinct from `policy_drift` (context vs current) and
  from two-producer `policy_divergence` (§9, Codex #2737 R8).

## 9. Acceptance tests

P1 PUT authority: pinned/assert/admin-named credential → 403; owner → 201 v1; identical body → 200 same
digest; changed body → 201 v2 with `supersedes` = v1 digest; `If-Match` stale → 412; two concurrent
different PUTs → versions 2 and 3, both immutable, or one 409 — never a lost write; two concurrent
identical PUTs → one 201 one 200, same digest. Local serve without `RETRACE_OWNER` → 403.
P2 Validation: unknown field, missing field, float, unsorted/duplicate array, `github_repos` for another
project, non-canonical repo string → 400. Golden vectors reproduce byte-for-byte; key order does not change
the digest.
P3 Historical resolution: v1 trusts X; withheld seal with context under v1; v2 removes X → seal still
verifies under v1 (online and offline); v2 adds Y; a v1-context seal stamped Y → invalid; a seal whose
digest is absent from the bundle → `policy_missing` invalid; a tampered policy body in the bundle →
digest mismatch invalid; a digest belonging to another project → 404 online, invalid offline.
P4 Snapshot binding: context created at `U` with v1; PUT v2 commits at `U+1`; a second producer, a retry,
a new path and an amendment all resolve v1; `/status` shows drift for that context. P7 distinguishes
first-context creation from a later seal of the same sha after the update.
P5 Routing: stored route wins over env; env used only for an unbootstrapped project with no stored route;
route removal does not resurrect env; duplicate repository claim → 409; explicit reassignment atomic;
pending delivery drained after an env change keeps its recorded project.
P6 Bootstrap: declared-project mismatch refused; `--cross-project-copy` prints and proceeds; basename
shown as hint only; `local_config_drift` reported against the body, not the digest.
P8 Export: every referenced digest present before the issuer signature; omission or unknown profile
fails verification explicitly; `retrace-export verify` from A's cwd of B's bundle uses B's enclosed
policy (extends PR 29's two-project fixtures).
P9 Budget: every classifier/verifier policy read is one indexed lookup; a store failure yields
`unavailable`, not a partial decision.

## 10. v1 → v2 dispositions (Codex, 2026-09-10)

| Finding | Where answered |
|---|---|
| F1 (P2) freeze canonicalisation, golden vectors, version-envelope digest, export coverage, verifier recompute, digest constrained by project, no separate signing | §2, §5B, P2, P3, P8 |
| F2 (P1) precedence contradicts frozen policy-used; separate selection from retrieval; exact `(project, digest)`; drift only | §5A/§5B, P3, P4 |
| F3 (P1) env fallback: unbootstrapped-only, routing-only, provenance through pending retries, canonical repo identity, unique active routing | §2 (canonical repos), §3 (409/reassign), §7, P5 |
| Q3 owner-only correct; `set_by` from configured principal; team represented honestly; local serve explicit | §3 |
| F4 (P1) atomic historical selection bound to `U`; classifier profile and rollout mode recorded separately; indexed reads; context data exported | §4, §6, P4, P9 |
| F5 (P2) bootstrap declared-project mismatch; basename hint only; drift semantics | §8, P6 |
| Acceptance additions (a)–(f) | P1, P3, P4, P5, P6, P8 |

Out of scope, unchanged: credential `principal` / never-reissue (built in parallel), the classifier and
context table (step 3), removing the env mapping entirely (after bootstrap completes).
