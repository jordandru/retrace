# Project policy document — contract (trailer-consistency §15 step 2)

**Status:** DRAFT v3, 2026-09-10, author claude-code. v1 (d3aec24) and v2 (91eb0fb) were design-reviewed by
Codex (commit comments 2026-09-10T03:16Z and 03:23Z): both *request changes*. v2 closed F2 (selection ≠
retrieval), project-bound retrieval, export coverage, Q3 (owner authority), F5 (bootstrap, drift labels).
v3 folds the six remaining findings (V2-1…V2-6) and the §3/§8 clarifications; dispositions in §11.
Companion to `commit-trailer-consistency.md` §3.2/§3.5 (snapshot, context key, read budget), §5.3
(pending), §6 rules 3–5, §9 (policy distribution, drift) and §15 step 2. Nothing here changes a
classification rule or Jordan's `unresolved_claims: record` default.

## 1. Why a stored document

The Worker does not read `.retrace.json` (§9). Step 1's verifier substitutes a withheld actor only for
stamps in the project's **trusted hook stamps**, bound to a **named project** (PR 29); that list reaches the
verifier only from `.retrace.json` on the CLI side, the Worker passes none, and export bundles carry no
policy. Step 3 must select a policy atomically with its evidence snapshot and every seal must record
**which version** decided it — and that choice must be **recomputable from the exported ledger alone**,
not attested by a server. So: an append-only, digest-addressed document on the Worker, set by the owner,
whose every activation is itself a **ledger event** (§6), exported with every bundle that references it.

## 2. Document: body, envelope, and the frozen canonical form

Two layers, hashed together. The digest identifies the *version* (body + envelope), never "settings".

```
body (owner-supplied, validated):
  profile:             "retrace-project-policy/1"
  project:             "<ledger project>"                 // must equal the URL's :p
  trusted_hook_stamps: ["assert:git hook (assert)", …]  // exact sealed_by strings
  unresolved_claims:   "record" | "withhold"              // §9 Phase C; the bootstrap writes "record" explicitly
  repositories:        [ { name: "<canonical repo>", aliases: ["…"] } ]   // artifact-name aliases only
  github_repos:        [ "<canonical repo>", … ]          // repositories routed to THIS project

envelope (server-assigned, immutable):
  version:      <integer ≥ 1, monotonic per project>
  created_at:   "<RFC 3339 UTC, millisecond precision, 'Z'>"
  set_by:       { type: "human" | "team", id: "<configured owner principal>" }
  supersedes:   "<policy_digest of version-1>" | null
  activation:   { event_id: "<evt_…>", seq: <integer> }   // the ledger event that activated this version (§6)

policy_digest = sha256hex( canonical_v1( body ∪ envelope ) )
```

**`canonical_v1` is RFC 8785 (JSON Canonicalization Scheme), with these `/1` constraints** (Codex V2-1):
- Serialisation is exactly JCS: object members sorted by UTF-16 code units of the key; no whitespace;
  strings escaped per JCS §3.2.2.2 only (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, other control characters
  below U+0020 as `\u00xx` lower-case; **everything else literal**, so `"a"` and `"a"` have one
  canonical spelling and non-ASCII is emitted as UTF-8, never escaped). Output bytes are UTF-8.
- Numbers: **integers only** in `/1`, range `0 ≤ n ≤ 2^53−1`, serialised as decimal without sign, exponent
  or fraction. Any float, negative, or out-of-range integer → 400 (body) / internal error (envelope).
- Strings must be valid Unicode scalar sequences: a lone surrogate anywhere → 400. Strings are compared and
  sorted by **UTF-8 byte sequence**; every string array in `/1` (`trusted_hook_stamps`, `aliases`,
  `github_repos`) must arrive sorted by that comparator and unique, and `repositories` sorted by `name`;
  otherwise 400 — so array order can never vary between two representations of one document.
- All fields are **required**; nothing is defaulted into the hash; unknown fields at any depth → 400.
- Implementation: a dedicated `canonicalPolicyV1()` validated against the RFC 8785 test vectors; the
  hash chain's own `canonicalize()` (`chain.ts`) is not changed or relied on for this format.
- **Golden vectors** `packages/core/src/fixtures/policy-v1/*.json`: at least five complete
  **body + envelope** inputs with expected canonical bytes and digests — ASCII; non-ASCII stamp and alias
  (literal UTF-8); a string containing `"`, `\` and a control character; version 1 with `supersedes: null`;
  version ≥ 2 with `supersedes` set. The suite recomputes all of them every run.

`github_repos` entries are **canonical repository identities**: `owner/name`, lower-cased, exactly as
GitHub's `repository.full_name` after the same lower-casing, which the webhook applies before routing.
A body may only route repositories to its own `project`.

## 3. Endpoints (Worker and `retrace-serve`)

- `PUT /projects/:p/policy` — **owner authority only** (§9; Codex Q3). Body = the body layer; `project`
  must equal `:p`. Header `If-Match: <expected current policy_digest>` or `If-Match: none` (first
  version) is **required**. Everything below happens in **one atomic operation** (D1 batch / SQLite
  `BEGIN IMMEDIATE`), and the precondition is re-checked inside a collision retry (Codex §3 clarification):
  1. precondition: current digest ≠ `If-Match` → `412`, **even when the submitted body equals current**;
  2. validation (§2) → `400`; routing conflicts (§7) → `409`;
  3. no-op: body identical to current → `200` with the current document, nothing written;
  4. otherwise assign the envelope (`version = current + 1`, `created_at`, `set_by`, `supersedes`), append
     the **activation event** (§6) to the project's chain, write `project_policies` and every affected
     `policy_routes` row, return `201` with the document (which now carries `activation`).
  A version collision under contention retries once from step 1, then `409`. Documents are never updated
  or deleted.
  - `set_by` is the Worker's configured owner principal (`RETRACE_OWNER`; already the identity used for
    owner-only DELETE audits), never request-supplied, never invented; `team:<id>` is recorded as
    `{type:"team"}`. Possession of the shared owner bearer identifies the owner principal, not a person.
  - `retrace-serve`: owner authority requires the configured `RETRACE_TOKEN` bearer **and** a configured
    `RETRACE_OWNER`; without an owner principal `PUT` is `403` "no owner principal configured".
- `GET /projects/:p/policy` — current. `?digest=<hex>` / `?version=n` — that version, **constrained to
  `:p`** (another project's digest → `404`). Readable by any credential scoped to the project.
- `GET /projects/:p/policy/history?limit=` — versions newest first (default 50).
- `GET /projects/:p/routes` — this project's `policy_routes` rows including revoked ones (§7).

## 4. Storage and read budget

```
project_policies (project TEXT, version INTEGER, digest TEXT UNIQUE, body TEXT, envelope TEXT,
                  activation_seq INTEGER, created_at TEXT, PRIMARY KEY (project, version))
policy_routes    (repo TEXT PRIMARY KEY,                       -- canonical repository; rows are never deleted
                  state TEXT CHECK (state IN ('active','revoked')),
                  project TEXT, digest TEXT, activation_seq INTEGER, set_at TEXT)
```

`SCHEMA_SQL` gains both (`IF NOT EXISTS`); `npm run migrate` applies them through the query endpoint
(`wrangler d1 execute --command`). Every classifier/verifier read is a **single indexed point lookup** —
`(project, digest)`, `(project, activation_seq ≤ U)` via `activation_seq` index, or `(repo)` — inside the
§3.5 bounded operation; any failure is an explicit `unavailable`, never a history or cross-project scan.

## 5. Selection versus retrieval (Codex F2 — closed in v2, restated with v3's activation rule)

**A. Which version applies?**
| Situation | Version |
|---|---|
| A **new** classification context is created for `(project, R, sha)` at evidence head `U` | the version whose **activation event has the greatest `seq ≤ U`** — a pure function of the ledger up to `U` (§6). Its digest is written into the context as `context.policy_digest`, with `context.read_head_seq = U` |
| An **existing** context — any later producer, retry, drained delivery, new path, amendment, or offline verification | **exactly** `(event.project, context.policy_digest)`. Never latest, never a union, never cwd, never another project. Unretrievable → `unavailable` online / `policy_missing` **invalid** offline |
| A `/2` withheld seal under rule 3 | the trusted stamps of the version named by its `context.policy_digest`; a seal with no context has no substitution path (as today) |
| Current version ≠ the version a context used | **drift** (`policy_drift`, WARN naming both digests); never applied retroactively. v1 trusts X, v2 removes X → a v1-context seal still reconstructs under v1; v2 adds Y → a v1-context seal stamped Y is invalid |

**B. Where is it retrieved from?**
| Consumer | Source |
|---|---|
| Worker (ingestion, verification, status) | `project_policies` by `(project, digest)`; activations by `(project, activation_seq ≤ U)` |
| Offline verify / export / report | `bundle.policies` — **every** `(project, digest)` referenced by any exported seal or context, retired versions included, plus the activation events (they are ordinary events in the bundle), all placed **before** the issuer signature; the verifier recomputes each digest, checks `profile`, checks `document.project == event.project == bundle.scope.project`, recomputes "activation with greatest seq ≤ context.read_head_seq" and requires it to equal `context.policy_digest`, rejects conflicting definitions of one digest, and reports missing / corrupt / unsupported-profile / **mis-selected** policy per event |
| CLI reconcile / doctor / attribution with a Worker configured | the Worker, by digest for existing contexts; current only for drift |
| Local-only ledgers (`RETRACE_DB`, `retrace-serve`) | their own `project_policies`, written by the local `PUT` (activation events land in the local chain the same way); `.retrace.json` `reconcile.hook_sealed_by` is only the **bootstrap source** for the first local document, never verifier authority |
| Legacy seals (no context) | no policy is manufactured; format-specific behaviour unchanged |

**What authenticates what** (Codex V2-2): `claim_decision`, including `context.policy_digest`, is a
**server annotation outside the `/2` producer-signed bytes** (§6 rule 4). Producer-signature success
**never** authenticates the policy reference. The reference is covered by the server's **hash chain**, whose
authority rests on the existing checkpoint/issuer trust model; a context exported outside an event is
covered by the **issuer-signed bundle**; and the activation events are chain events like any other. Verified
producer testimony ("signed as A") and server policy-selection testimony ("selected v1 at U") stay
distinguishable in every consumer's output.

## 6. Activation events — the ordering record step 3 needs (Codex V2-3)

A policy version becomes **current** only when its **activation event** is appended to the project's
chain — inside the same atomic `PUT` (§3). Shape:

```
{ project, actor: <set_by principal>, action: "created",
  artifacts: [ { id: "policy:<project>@<policy_digest>", kind: "policy", role: "generated",
                 derived_from: ["policy:<project>@<supersedes digest>"]? } ],
  intent: "policy v<version> activated",
  method: { tool: "retrace-admin" | "retrace-api", params: { policy_profile, policy_version, policy_digest, supersedes,
            routes_changed: [ { repo, from_project?, to_project?, state } ] } },
  idempotency_key: "policy:<project>:<version>" }
```

Consequences:
- **Currentness is a pure function of the ledger.** "Current at `U`" = the version whose activation event
  has the greatest `seq ≤ U`. A `PUT` cannot change policy without moving the head, so two contexts with
  the same `read_head_seq` necessarily used the same version, and a mis-selected version is **detectable**
  offline from the exported events (Codex's counterexample cannot occur: C1 at head 100 selects v1; the
  `PUT` appends v2's activation at 101; C2 reads head 101 and selects v2; both are recomputable).
- **The API owns the snapshot.** `selectPolicyForContext` is not called with a bare number: the §3.2
  evidence read returns `{ U, events ≤ U, activations ≤ U }` from one snapshot (D1 batch / SQLite
  transaction), and selection is computed from that result. There is no second "read current" query.
- Recorded on the context **separately** from the document: `classifier_profile: "trailer-consistency/1"`,
  `rollout_mode` at selection, and the amendment snapshot used. Replay uses the **recorded** settings; a
  consumer that re-evaluates under a later mode labels the result as such. `/1`-signed events stay
  byte-preserved (§6 rule 5).
- The verifier relationship: exported context + exported events (activations included) + `bundle.policies`
  ⇒ the selection is **reconstructible**, not merely attested. Where a bundle lacks the activation events
  (a scoped export), the verifier reports `policy_selection_unverifiable` rather than passing.

**Context key** (Codex V2-4): the classification context is keyed by `(project, canonical repository R,
full sha)` exactly as §3.2 accepted — v2's `(project, sha)` was a regression and is withdrawn. Forks and
mirrors inside one project share Git objects but have different `repo:R#path` evidence and lower bounds,
so they get **different** contexts; aliases and renames map to one `R` (via `repositories[].aliases` of the
policy version in force) so one repository reached by an old and a new name gets **one** context. Routing
(§7) resolves `R` before context lookup, from the routing pinned to the delivery.

## 7. Webhook routing and the env fallback (Codex F3 → V2-5, V2-6)

`policy_routes` is an authoritative, **never-deleted** table: one row per canonical repository with
`state ∈ {active, revoked}`. Order at delivery time:
1. canonicalise `repository.full_name`;
2. `policy_routes(repo)`: `active` → that project (routing source `policy`, with the route's digest);
   `revoked` → **not routable by env**, go to step 4;
3. no row at all **and** the env candidate project has **no document** (unbootstrapped) → env mapping
   (source `env`);
4. otherwise **unroutable** → a durable `pending_deliveries` row with `routing_state = "unresolved"` is
   written **before** `202` is returned; `/status` lists it.

The resolved `{ repo, project, source, digest }` is stored on the pending delivery and reused on drain, so
neither an env change nor a policy change between receipt and drain can move a delivery between trust
domains. Rules:
- Removing a repository from a document (a new version without it) sets its route to **`revoked`**, not
  absent: a stale env route can **never** be resurrected by a revocation. Codex's A/B case: env maps
  `org/repo` → B (no document); A's document claims it (route active→A); A later drops it → `revoked`;
  B stays unbootstrapped and gets nothing. Only an explicit owner action re-enables the repo: a document
  from some project claiming it (`?reassign=` semantics below), or `retrace-admin release-route <repo>`
  which records a `released` activation on the owning project's chain and deletes nothing.
- **Reassignment is atomic across both projects.** `PUT …/A/policy?reassign=<from>` succeeds only if
  the route's current owner is exactly `<from>`; it appends a new version to **both** projects (`<from>`
  minus the repo, A plus it), two activation events, and the route row change, in one operation. A stale
  `?reassign=B` against a route now owned by C → `409`. Duplicate claims are never resolved by iteration.
- The env fallback supplies **routing only**, never trusted stamps and never a stand-in policy.
- **Missing policy is mode-dependent** (Codex V2-6): under `rollout_mode = off` an env-routed commit of an
  unbootstrapped project is sealed unclassified (`unavailable / policy_missing`, transitional). Under
  `shadow` or `enforce`, a required policy that is missing keeps the webhook delivery **durably pending**
  and the hook **queued and loud** (§3.5, §5.3, §5.2); nothing bypasses classification. All three modes
  are tested with a valid env route and no policy.
- `/status` reports per repository: `routing: policy | env_fallback | revoked | unresolved`. The env is
  removed after every mapped project has a document (a later step).

## 8. Bootstrap (Codex F5, closed; §8 clarification)

`retrace-admin set-policy <project> --from <repo>/.retrace.json [--url] --if-match <digest>|none`
builds a body from `reconcile.hook_sealed_by`, `attribution.repositories`, the Worker's current env
mapping for that project, and `unresolved_claims: "record"` **explicitly**; prints the proposed **body**
and a `body_preview_sha256` (labelled as a settings-only preview, **not** the policy digest); on
confirmation PUTs and prints the **authoritative** `policy_digest`, version and activation event id the
server returned.
- Declared `project` differing from `<project>` → **refused**; `--cross-project-copy` is the explicit,
  printed override.
- No declared `project` → the directory basename is shown as a **hint** only; the owner names the project.
- doctor `local_config_drift` (WARN) compares the local file's settings with the **body** of the current
  document — never the envelope digest — and is distinct from `policy_drift` (context vs current) and
  from two-producer `policy_divergence` (§9, Codex #2737 R8).

## 9. Acceptance tests

P1 Authority and atomicity: pinned/assert/"admin"-named credential → 403; owner → 201 v1 with an
activation event; identical body, correct `If-Match` → 200, nothing written; identical body, stale
`If-Match` → 412; changed body → 201 v2, `supersedes` = v1, second activation event; concurrent different
PUTs → versions 2 and 3 immutable (or one 409), never a lost write; concurrent identical PUTs with a valid
precondition → one 201 one 200, same digest; `retrace-serve` without `RETRACE_OWNER` → 403.
P2 Canonical form: golden body+envelope vectors byte-exact; `"a"` and `"a"` produce one digest;
non-ASCII literal; control-character escapes; unsorted/duplicate arrays, floats, negative or 2^53 integers,
lone surrogate, unknown nested field → 400.
P3 Historical resolution: v1 trusts X; withheld seal with a v1 context; v2 removes X → seal verifies under
v1 online and offline; v2 adds Y → v1-context seal stamped Y invalid; digest absent from bundle →
`policy_missing`; tampered body → digest mismatch; another project's digest → 404 online / invalid offline.
P4 Ordering (V2-3): C1 created at head 100 selects v1; `PUT` v2 → activation at 101; C2 at 101 selects v2;
export both; offline recompute reproduces both selections; a context claiming v2 with `read_head_seq =
100` → `policy_misselected`; a scoped bundle without the activation events → `policy_selection_unverifiable`.
Later producers, retries, new paths and amendments of C1 all resolve v1; drift shown for C1.
P5 Routing (V2-5): stored active route wins over env; env only for a no-row repo of an unbootstrapped
project; A claims env-B's repo then drops it → `revoked`, B gets nothing; `release-route` re-enables
explicitly; duplicate claim → 409; `?reassign=` atomic across both documents and the route row; stale
`?reassign=B` against C's route → 409; unroutable delivery has a durable unresolved row before 202;
drained delivery after an env change keeps its recorded project and repo.
P6 Bootstrap: declared-project mismatch refused; `--cross-project-copy` prints and proceeds; basename hint
only; preview hash labelled and unequal to the returned digest; `local_config_drift` against the body.
P7 Context key (V2-4): two repositories in one project sharing a sha with different evidence → two
contexts; one repository reached by old and new alias → one context.
P8 Missing policy by mode (V2-6): valid env route, no document: `off` → sealed unclassified;
`shadow`/`enforce` → webhook delivery pending, hook queued and loud, no seal.
P9 Export and authentication (V2-2): every referenced digest and activation event present before the
issuer signature; omission or unknown profile fails explicitly; a `/2` seal whose producer signature
verifies but whose `claim_decision` was altered → chain failure, and the consumer output still says
"signed as A" separately from "policy selection invalid"; A-cwd/B-bundle uses B's enclosed policy.
P10 Budget: every classifier/verifier policy read is one indexed lookup; store failure → `unavailable`.

## 10. Out of scope

Credential `principal` / never-reissue (PR 31, in parallel); the classifier and context table (step 3);
removing `RETRACE_GITHUB_PROJECTS` entirely (after bootstrap completes); `policy:write` permission for
team credentials (an authorisation extension, per Codex Q3).

## 11. Dispositions

| Round | Finding | Where answered |
|---|---|---|
| v1→v2 | F1 version-envelope, export coverage, project-bound fetch | §2, §5B, P3 |
| v1→v2 | F2 selection ≠ retrieval; drift never applied | §5A/B — **closed** (Codex v2) |
| v1→v2 | F3 env fallback routing-only, provenance | §7 |
| v1→v2 | Q3 owner authority, `set_by` | §3 — **closed** |
| v1→v2 | F4 atomic selection | §6 (superseded by v3's activation events) |
| v1→v2 | F5 bootstrap, drift labels | §8 — **closed** |
| v2→v3 | V2-1 (P2) serialisation under-specified; vectors need envelope | §2: RFC 8785, integer/Unicode/comparator rules, body+envelope vectors; P2 |
| v2→v3 | V2-2 (P2) producer signature does not authenticate the policy reference | §5 "What authenticates what"; P9 |
| v2→v3 | V2-3 (P1) `policy_selected_at_seq = U` proves nothing; API must own the snapshot | §6 activation events; selection = greatest activation `seq ≤ U`; P4 |
| v2→v3 | V2-4 (P1) context key dropped the repository | §6 key restored to `(project, R, sha)`; P7 |
| v2→v3 | V2-5 (P1) revocation resurrects env; reassignment atomicity; durable unresolved routing | §7 `revoked` state, atomic two-document reassign, unresolved row before 202; P5 |
| v2→v3 | V2-6 (P1) missing policy must stay pending in shadow/enforce | §7 mode-dependent rule; P8 |
| v2→v3 | §3 clarifications (one atomic op, recheck on retry, 412 even if equal) | §3 steps 1–4; P1 |
| v2→v3 | §8 digest preview honesty; explicit `record` | §8; P6 |
