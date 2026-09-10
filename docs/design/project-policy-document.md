# Project policy document — contract (trailer-consistency §15 step 2)

**Status:** DRAFT v1, 2026-09-09, author claude-code. For Codex review before build. Companion to
`commit-trailer-consistency.md` §9 (policy distribution), §6 rule 3 (trusted hook stamps) and §15 step 2.
Nothing here changes a classification rule; it defines where the Worker and the offline verifier get the
per-project policy they already require.

## 1. Why a stored document

The Worker does not read `.retrace.json` (§9). Step 1 shipped a verifier that substitutes a withheld
actor only for stamps in the project's **trusted hook stamps**, bound to a **named project** (PR 29, Codex
rounds 3–5). Today that list reaches the verifier only from `.retrace.json` on the CLI side; the Worker
passes none and therefore never substitutes online, and an export bundle carries no policy at all. Step 3
(classifier shadow) needs the Worker to know the policy, and every seal must record **which** policy
decided it (`policy_digest` in §6's `claim_decision.decision.context`). So the policy becomes a stored,
versioned, digest-addressed document on the Worker, set by the owner, included in exports.

## 2. Document shape

```
{
  profile: "retrace-project-policy/1",
  project: "<ledger project>",
  version: <int, 1-based, monotonic per project — server-assigned>,
  created_at: "<ISO, server-assigned>",
  set_by: { type: "human", id: "<owner principal>" },        // server-assigned from the bearer
  trusted_hook_stamps: ["assert:git hook (assert)", ...],   // exact `sealed_by` strings; no patterns
  unresolved_claims: "record" | "withhold",                  // §9 Phase C; default "record" (Jordan)
  repositories: [ { name: "jordandru/retrace", aliases: ["retrace"] } ],   // artifact-name aliases only
  github_repos: { "jordandru/retrace": "retrace" },          // replaces RETRACE_GITHUB_PROJECTS for this project
  policy_digest: "<sha256 hex of the canonical JSON of every field above except policy_digest>"
}
```

Rules:
- `trusted_hook_stamps` are **exact strings**, compared with `===` (PR 29 contract). No substring, no case
  folding, no patterns. `webhook:github` is never listed — it is the verifier's one built-in.
- `repositories[].aliases` are repository/artifact names (the existing `attribution.repositories` shape);
  they are **not** ledger-project trust domains (Codex PR 29 round 4).
- `github_repos` maps only to **this** document's `project`; a mapping to another project is rejected.
- Canonicalisation for the digest is `canonicalize()` from `signing.ts` (the same function the hash chain
  and producer signatures use), so key order cannot change the digest.
- Unknown top-level fields are rejected (fail closed), so a `/2` profile can add fields without ambiguity.

## 3. Endpoints (Worker and `retrace-serve`)

- `PUT /projects/:p/policy` — **owner token only** (403 for every credential, including admin-scoped
  pinned ones). Body = the document without `version`, `created_at`, `set_by`, `policy_digest`;
  `project` must equal `:p`. The server assigns `version = previous + 1`, `created_at`, `set_by`, computes
  the digest, and **appends** a row. Documents are never overwritten or deleted; setting an identical
  body to the current version is a no-op returning the current document (idempotent).
- `GET /projects/:p/policy` — current document. `?version=n` or `?digest=<hex>` return a specific one.
  Readable by any credential scoped to the project (the digest is recorded on seals, so it is not secret).
- `GET /projects/:p/policy/history` — all versions, newest first.
- Export bundle gains `policies: [ <every version of this project's documents> ]`, so a retired alias
  table or stamp list can be reconstructed offline; **a digest alone is not enough** (§9).

## 4. Storage

D1 / SQLite table `project_policies (project TEXT, version INTEGER, digest TEXT UNIQUE, body TEXT,
set_by TEXT, created_at TEXT, PRIMARY KEY (project, version))`. `SCHEMA_SQL` gains it; `npm run migrate`
applies it through the query endpoint (`wrangler d1 execute --command`, not `--file`: the import API needs
OAuth the CLI does not have — handoff note 2026-09-09).

## 5. Who reads it, and precedence

| Consumer | Source of policy | Behaviour when absent |
|---|---|---|
| Worker ingestion (step 3 classifier; step 1 verifier substitution) | current stored document for `:p` | **no substitution, no classification** (`unavailable`), `/status` reports `policy: none`; step 3 refuses to enter shadow for that project |
| Worker webhook project mapping | `github_repos` of every project's current document, then `RETRACE_GITHUB_PROJECTS` **env as fallback** | env fallback is reported by `/status` as `policy: env_fallback` (WARN) until the document exists; env is removed in a later step |
| Offline verify / export / report (`retrace-export`) | `bundle.policies` matching `bundle.scope.project`, **never cwd** | no policy in bundle → no substitution (fail closed); doctor WARN `policy: bundle has none` |
| CLI reconcile / doctor / attribution (local repo present) | stored document via `GET /projects/:p/policy` when a Worker is configured; `.retrace.json` `reconcile.hook_sealed_by` only for a local-only ledger | if both exist and differ → doctor WARN `policy_divergence` naming both digests (§9 drift) — the Worker document wins for verification |

Precedence in one line: **Worker document > export bundle copy > `.retrace.json` (local-only ledgers)**.
The digest of the document *used* is what step 3 records in every classification context; drift between
that and the *current* document is reported, never silently applied (§9, Codex #2737 R8).

## 6. Bootstrap

`retrace-admin set-policy <project> --from .retrace.json [--url]` builds the first document from the
repo's existing `reconcile.hook_sealed_by`, `attribution.repositories` and the Worker's current
`RETRACE_GITHUB_PROJECTS` entry for that project, prints it, and PUTs it with the owner token. For
`retrace` and `boxing-rpg` Jordan runs it once; the resulting digests are recorded in §15.

## 7. Acceptance tests

- P1 PUT with a pinned/assert credential → 403; owner → 201 with version 1; same body again → 200, same
  version and digest; changed body → version 2, new digest; digest is identical for two key orders.
- P2 `github_repos` naming another project → 400. Unknown field → 400. Pattern-looking stamp (`assert:*`)
  is stored as the literal string and matches nothing (documented, not rejected).
- P3 Export bundle carries every version; offline `retrace-export verify` of a withheld `/2` seal uses the
  bundle policy for `bundle.scope.project` and ignores cwd's `.retrace.json` (extends PR 29's
  two-project fixtures: A's cwd, B's bundle with B's policy inside → B's rules apply).
- P4 Worker with no document for `:p`: verifier never substitutes; `/status` `policy: none`.
- P5 Webhook mapping: document present → its `github_repos` wins; absent → env fallback + `env_fallback`
  status; document naming a repo the env maps elsewhere → document wins, drift reported.
- P6 doctor `policy_divergence` when `.retrace.json` stamps differ from the stored document.
- P7 Digest recorded: a seal produced after this ships carries `context.policy_digest` equal to the
  document current at read time (step 3 asserts it; step 2 exposes the value on `/status`).

## 8. Out of scope here

Credential `principal` / never-reissue (§10; built in the same step but independent of this document),
the classifier (step 3), and removing the `RETRACE_GITHUB_PROJECTS` env entirely (after every mapped
project has a document).
