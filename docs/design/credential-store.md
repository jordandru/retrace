# Credential store — contract (credentials out of the Worker secret)

**Status:** DRAFT v1.2, 2026-09-12, author grok (architect). Not built. v1 `b2f2751`; v1.1 `3c4ae79`
(Nemotron). v1.2 folds the first Codex design review (Astra, high, `evt_5f5d6d4464f842b59ce8c1e5d86f2f6a`,
rejected): one-way cutover after import; D1-only-writer threat accepted not equated; remint-all at
import; live-pin uniqueness in the store transaction; local SQLite bootstrap as it actually is.
Round-3 instruction `evt_e91b070246a94d849ae2639846c6fce1`. Not a claim that anything here runs.
Jordan's item 13 in the 13 → 3 → 4 order. Design gate: Codex re-read of this head; Nemotron landed;
Claude last. Companion to `producer-signing-plan.md` rung 5, `commit-trailer-consistency.md` §10,
`credential-status.ts` (T21, T29). **This note does not change the hash chain or the seal format.**
If a reviewer finds that it must, the build stops.

No live token, no live JWK `d`, and no production `kid` appears in this file or in any fixture it
requires. Tests use the existing `tok-` / in-memory JWK pattern.

## 0. Why, and what this is not

Today every per-actor credential is a JSON object in the Worker secrets `RETRACE_CREDENTIALS` and
`RETRACE_CREDENTIALS_EXTRA`, parsed in full on every `fetch` (`allCredentials` in
`apps/worker/src/index.ts`). The local mirror is `~/.retrace/worker-credentials.json` (and
`-extra.json`). Mint, retire, and `set-principal` write that file and print `wrangler secret put`.
The secret has a few-KB ceiling — that is why EXTRA exists — and a leaked or dumped secret is the
plaintext of every seat's token plus every registered public key.

This design moves **per-actor credentials** into the ledger's existing store (D1 on the Worker,
SQLite on `retrace-serve`). The owner token (`RETRACE_TOKEN`) stays a Worker secret: it is the
bootstrap and the break-glass, and putting it in the same table would make a D1 outage indistinguishable
from "no owner". Producer **private** keys stay on disk, mode 0600, never in this store (ops custody
rule; stays).

This is not self-serve signup, not a password hash for humans, not a change to `sealed_by`, not a
change to `producer_sig` bytes, and not packed-CLI work (ops 3 and 4).

## 1. Principles

1. **Fail closed.** An unreadable store, a failed lookup, a dual-source config, or cutover without
   a completed import marker is `503` on every authenticated write and on credential-gated reads. It
   is never open, never owner-inferred, never "fall back to the secret".
2. **One source of truth.** After cutover the two credential secrets are unset. If they are set
   while the store is D1, the Worker refuses to start serving writes (`503`, dual-source). The secret
   retires; it does not linger as a fallback.
2a. **D1-write is minting.** An INSERT of a `credentials` row whose `token_hash` is SHA-256 of a
   token the attacker knows authenticates without the owner token. v1.2 does not MAC or owner-sign
   rows. This is an **additional** threat vs secret-write, not the same permission. See §2.1.
3. **Hashed tokens, public keys, no private keys.** Compromise of the store must not yield a usable
   bearer token or a producer private JWK.
4. **Kid binds to the credential, not to `event.actor`.** `producerSigCheck` already verifies
   `producer_sig.kid` against the public key **on the authenticating credential** (`producer-sig.ts`:
   `unknown_kid` if the kid is not that key's). The store must preserve that: lookup is by token
   hash; the row that authenticated is the row whose `public_key` is checked. Never select a key by
   `event.actor`.
5. **Never-reissue survives.** An actor `{type,id}` once bound to a principal in a project is never
   issued to a different principal, live or retired (T29, `refuseReissueIfBound`). The binding is a
   row that outlives the credential.
6. **Issuance is evidence.** Every mint, retire, rotate, and principal bind is a sealed ledger event.
   **Today they are not.** `retrace-admin retire-agent` writes `retired_at` on the local JSON file and
   prints `wrangler secret put`. Same for mint and `set-principal`. The belief that retire is already
   a sealed event is false; this design makes all four sealed. That is a correction, not a claim
   about the current code.
7. **No credential material in the ledger prose.** Issuance events name credential id, actor,
   principal, kid, trust, projects. They do not name the token, the token hash, or a private key.

## 2. Decision 1 — where they live

**Decision: a D1 table (SQLite locally), global to the Worker, looked up by token hash.**
Overrule: Jordan, one instructed event.

### Options, with numbers

| | Worker secrets (today) | D1 table | KV | Per-project encrypted rows |
|---|---|---|---|---|
| Ceiling | few KB per secret; EXTRA is the overflow. Live deploy reports 11 credentials on `GET /api`. | D1 row limit is not the constraint; the JSON secret is. Hundreds of seats fit. | Same size headroom as D1 for this payload. | Same, but auth happens *before* the project is known for `GET /projects` and for `POST /events` (project is in the body). A per-project row cannot be the primary lookup. |
| Consistency | Instant in the isolate after deploy. A `secret put` is a new Worker version. | Strong, transactional (`D1 batch` / SQLite `BEGIN IMMEDIATE`). Retire is gone in the same batch as the issuance event. | Eventually consistent (Cloudflare documents ~60 s). A retired token can authenticate after retire. That is a security defect for this object. | Transactional if the ciphertext lives in D1; encryption adds a key that is another secret. |
| Read per `POST /events` | `JSON.parse` of the whole secret **every fetch**, then linear `tokenEquals` (two SHA-256 per candidate, N≈11 today). CPU grows with N. | One SHA-256 of the presented bearer + one indexed `SELECT` by `token_hash`. I/O, not CPU. | One KV `get` by hash. Fast. Retire lag. | Must first know the project, which the bearer does not tell you. Needs a global index anyway → this option collapses to "D1 or KV plus encryption". |
| CPU vs the 10 ms cliff | The documented 503/error-1102 wall (2026-09-03, ~1.5k events) was **export CPU**, not auth. Auth at N=11 is cheap. Auth at stranger-install N (hundreds of `tokenEquals` + parse) is the cliff this move is for. Secrets keep all plaintext in isolate memory forever. | Point query. D1 wait is wall-clock, not Worker CPU. Unproven: p50/p95 of that wait on this account's region — v1 does not cache live-ness (a cache would delay retire). | Fast reads, wrong consistency. | Extra decrypt CPU for no lookup gain. |

KV is rejected because retire must take effect in the same request that seals the retire event, not
"within a minute". Per-project encrypted rows are rejected because bearer auth is not per-project:
the Worker must answer "who is this token?" before it knows which ledger the call is for. Encryption
at rest of D1 is a Cloudflare-account property, not a row design; it is not a third option here.

D1 is already the ledger's store (`events`, `project_policies`, `policy_routes`, checkpoints). Adding
`credentials` and `credential_bindings` keeps issuance transactional with the issuance event (same
batch as `appendEvent`). Local `retrace-serve` gets the same tables on SQLite so the contract is one
code path (`EventStore` grows credential methods; `MemoryEventStore` for tests).

### 2.1 D1-write is minting (v1.2)

v1 modelled a dump and not a write. v1.1 called D1-write **equivalent** to secret-write. That
premise is false as a Cloudflare capability, and **unproven** for this account's grants.

- D1 query (`d1/…/query`) is a D1 permission. Updating a Worker secret
  (`workers/scripts/…/secrets`) is Workers Scripts Write. They are distinct API permissions.
  `apps/worker/wrangler.toml` binding `DB = retrace-db` and `migrate.mjs` using the D1 query
  surface do not prove every D1 writer can `secret put`.
- A D1-only principal (dashboard editor, stolen D1-scoped token) can INSERT a row with a token
  they chose, an actor they chose, and a producer public key they hold. The honest Worker will
  authenticate that token and `producerSigCheck` will `verified` against **that row's** key.
  Existing producer signatures do not authenticate the registry row.

**Decision: v1.2 keeps no row MAC and no owner signature on read, and explicitly accepts the
D1-only-writer threat.** It does not claim that threat equals secret-write. Application mint
stays owner-token HTTP. Direct D1 writes are outside the application. Compensating, detective
not prevention: Cloudflare account ACL (this account's actual grants are **unproven** in this
note — inspecting tokens is forbidden); Cloudflare D1 audit logs; doctor **warn** on live rows
with null `mint_event_id` (T15). A later MAC is a new Jordan decision.

Overrule: Jordan.

### Read path per request (after cutover)

1. Read `Authorization: Bearer`. No bearer and no owner `?token=` on GET → unauthenticated (today's
   rule).
2. SHA-256 (UTF-8) the presented secret; hex encode (64 lowercase chars). This is `token_hash`.
3. `SELECT` the credential row `WHERE token_hash = ?`. **Store error (unreadable D1, decode
   failure, missing latch when `credential_store=d1`) → 503, fail closed, including for a presented
   owner token.** The owner secret is not a D1-outage bypass. Do not try the credential secrets.
   Do not try a stale cache.
4. No row, or `retired_at` set → if the presented secret was a **Bearer**, try owner
   `tokenEquals(presented, RETRACE_TOKEN)`. Match → owner. Miss → 401. **GET `?token=` is owner-only
   and is never hashed into credential lookup** (today credentials are bearer-only; keep that).
5. Row live → that credential is the principal. Actor resolution then `producerSigCheck(input,
   row.public_key)` — same order as `router.ts` today. The key is **this** row's. `event.actor` is
   not consulted for key selection. `unknown_kid` on a different key. `require_signature: true`
   and verdict ≠ `verified` → 401; optional-signature seats are not newly enforced by this move.
6. `/mcp` uses this **same** live-row / 503 decision, including `retired_at`. Today's
   `authenticateRemoteMcp` scans the secret and does not check `retired_at`; the replacement must
   not keep that hole.

Owner routes (DELETE project, PUT policy, share create, credential admin) still require the owner
token. A credential never becomes owner. These startup guards run before REST **and** MCP dispatch.

**Unproven:** D1 point-query wall-clock on this Worker. v1 ships **without** an isolate cache of
live-ness. If a later version adds `{token_hash → credential_id}` caching, it is **write-through**:
retire and rotate delete or replace the entry in the **same D1 batch** as the row change; a cache
miss falls back to D1; a cache hit that disagrees with D1 is discarded. Serving a stale live entry
after retire is a failed retire. The cache is not a second source of truth.

## 3. Decision 2 — what the Worker holds at runtime

**Decision: SHA-256(token) as `token_hash`, no salt; Ed25519 public JWK + kid; principal required on
every new row; never-reissue table that outlives the credential.**
Overrule: Jordan, one instructed event.

### Token hash

- Algorithm: SHA-256 over the UTF-8 bytes of the token, lowercase hex. The same digest
  `tokenEquals` already computes on each side (`router.ts`). After cutover the stored value *is* that
  digest; compare by SHA-256(presented) ⊕ stored (constant-time, same XOR loop). Do not SHA-256 a
  hash.
- No salt, no pepper. Salting is for low-entropy secrets (passwords). **Fact, from
  `packages/mcp-server/src/admin.ts` `mintToken`:** `rand(32).toString("base64url")` with
  `rand = node:crypto.randomBytes`. That is **32 CSPRNG bytes = 256 bits**, encoded as 43 base64url
  characters (the comment on that function says 43 chars; v1 wrongly called this 128 bits and
  hex). A rainbow table of SHA-256 is useless at 256 bits. A pepper would be another Worker secret
  and would not change Worker compromise. The no-salt conclusion stands; the arithmetic is
  corrected in v1.1.
- **Shape is not entropy (v1.2).** A 43-character base64url string of `A` decodes to 32 zero
  bytes, passes v1.1's shape check, and is guessed in one attempt from its hash. The Worker
  schema still permits any string of length ≥ 16 (`Credential.token`). Only tokens **actually
  produced by `mintToken` in this process** inherit the 256-bit `randomBytes` guarantee.
  Historical live tokens have **unknown CSPRNG provenance** from the Worker's point of view
  (no provenance field; this note does not inspect live tokens).

  **Decision: import does not hash existing tokens. Every imported seat is re-minted** with a
  fresh `mintToken()` in the admin process, the new hash is POSTed, and a `credential-rotated`
  (same id, new token, same public key unless the operator also rotates keys) or
  `credential-minted` event is sealed. Old tokens 401 after cutover. New 0600 onboarding files
  are the distribution path. Dump-resistance is claimed only for tokens this cutover (and later
  mints) produced via `mintToken`. Empty import is 400. Local `retrace-serve`'s ephemeral
  `randomBytes(24)` owner token is not a Worker credential and is not imported.

### Compromise of the store (D1 dump, SQLite file, replica)

Yields: credential id, actor `{type,id,model?,on_behalf_of?}`, trust, `allowed_actors`, `projects`,
principal, `public_key` (already public; export bundles carry producer keys), `kid`, `retired_at`,
issuance event ids, `token_hash`.

Does not yield: the bearer token, any producer private JWK (`d`), the owner token.

An attacker with the dump cannot authenticate **tokens produced by `mintToken` after this cutover**
(no preimage of a 256-bit CSPRNG hash). Dump-resistance is **not** claimed for any imported hash of
unknown provenance — v1.2 does not import those hashes. They can enumerate who is bound to whom.
They cannot change `sealed_by` on already-sealed events. **They can mint if they can WRITE D1**
(§2.1), including a D1-only principal who cannot `secret put`. A compromised Worker process can
still stamp `sealed_by`; `require_signature: true` still fail-closes producer sig. Bindings block
application-path re-issue (T29); a console INSERT authenticates until detected (T15).

### Public keys and kid → credential

Row columns `public_key` (Ed25519 public JWK, no `d`) and `public_key_kid` (`keyId(public_key)`,
the 16-hex kid already used on `producer_sig.kid`). Unique on `public_key_kid` among live rows.

`producerSigCheck` is unchanged. The server passes `registered = row.public_key` from the
token-hash lookup. If `producer_sig.kid !== keyId(row.public_key)` the verdict is `unknown_kid`.
Offline verify keeps using the bundle's `producers[]` list keyed by kid (`countProducerSigs`:
"`actor_id` is descriptive credential metadata, not an event-actor binding"). Export continues to
emit `{kid, public_key}` for every live row that has a key; it does not emit tokens or hashes.

Rotating a producer key is a new public JWK on the same credential id (or a new credential id if
we retire-and-mint). Kid changes. Old events still verify against the key list in the bundle that
was exported with them; a verifier that only has the live key will report those old kids
`unknown_kid` unless the export (or `--producers`) still carries the retired public key. **v1 keeps
retired public keys in the export producers list**, labelled retired, so history verifies. That is
an export behaviour, not a chain change.

### Principal + never-reissue

New table `credential_bindings`:

```
PRIMARY KEY (project, actor_type, actor_id)
principal_type, principal_id   -- immutable
first_bound_event_id, first_bound_seq
```

- Inserted in the same batch as the mint event that first binds `{project, actor}` to a principal.
- Never updated. A second mint for the same actor in that project must request the same principal
  (`refuseReissueIfBound`) or it is 409.
- Survives retire. T29's "retire-then-reissue to a different principal" stays refused.
- Missing principal on a historical imported row: the binding is not guessed from `on_behalf_of`
  (today's rule). Import of a row without `principal` is allowed only as `principal_missing`; mint
  of a *new* row without `principal` is 400. `set-principal` on missing-history rows is owner-only
  and writes the binding; it is the one-time escape already documented on T29.

`shared_actor_id` and `principal_conflicts` on `GET /projects/:p/status` are computed from these
tables, not from parsing a secret.

## 4. Decision 3 — who may mint, and how

**Decision: owner-only, via `retrace-admin` talking to the Worker (owner token). No self-serve mint
in v1. Mint, retire, rotate, and `set-principal` each append a sealed event. `RETRACE_CREDENTIALS_EXTRA`
retires with the main secret.**
Overrule: Jordan, one instructed event.

### Self-serve

Not in v1. A stranger-install bar does not require that a seat mint its own credential. It requires
that Jordan (or a team's owner token) can mint without editing a wrangler secret. Proof of a human
principal (email challenge, WebAuthn, OAuth) is a different product and is **unproven** here. Shipping
it as part of this move would smuggle an identity-provider into a store change.

### Audit trail

| Action | Today | After this |
|---|---|---|
| mint (`new-team`, `add-agent`) | Local JSON append + printed `secret put`. **No ledger event.** | Owner POST creates the row (hash only) and `appendEvent` in the same batch: `action: other`, `action_detail: "credential-minted"`, actor = owner, artifacts = `credential:<id>` (generated) + `actor:<type>/<id>` (used). Body carries actor, principal, trust, projects, kid — **not** token, **not** `token_hash`. |
| retire | Local `retired_at` + printed `secret put`. **No ledger event.** | Same batch: set `retired_at`, issuance event `credential-retired`. Binding stays. |
| rotate (new token and/or new public key) | Rewrite JSON + `secret put`. **No ledger event.** | `credential-rotated`. New `token_hash` and/or new `public_key`+kid on the same id, or retire+mint if the builder prefers two rows; v1 uses in-place rotate on the same id so `sealed_by` name is stable. Old kid remains exportable (Decision 2). |
| `set-principal` | Local field write + `secret put`. **No ledger event.** | Allowed only when principal is missing. Event `credential-principal-bound`. Binding row inserted. Immutable afterwards. |

Issuance events for a single-project credential go on **that** project. Unscoped (today's dogfood
credentials with `projects` unset) go on `RETRACE_OPS_PROJECT` (default `retrace`). The event is
owner-sealed (`sealed_by: owner`). It is ordinary `EventInput`; hash rule v2 applies unchanged.

The one-time plaintext token is shown to the operator the way onboarding docs already work: a 0600
file under `~/.retrace/`, not printed by the Worker, not stored, not logged. The Worker never sees
the token, only `token_hash` (admin hashes locally before POST).

### EXTRA, NOOA, producer-key rollout

`RETRACE_CREDENTIALS_EXTRA` exists to add an experimental credential without rewriting the vetted
main secret. After cutover that is just another INSERT. NOOA is `retrace-admin add-agent … --harness
nooa` (already a harness in `admin.ts`); it does not need a side secret. The producer-key rollout
stops being "edit JSON, `secret put`, hope the parse succeeds": `public_key` is a column, private
JWK stays a 0600 file referenced only on the local mirror's `producer_key_file` (zod still strips
that field at the Worker; the Worker schema never grows it).

The local mirror remains: the git hook and doctor still resolve `credential: "retrace-git"` from
`~/.retrace/worker-credentials.json`. After cutover that file holds **the operator's copy** of
metadata + `producer_key_file` paths + the plaintext token the hook needs to send. It is not
uploaded. Losing the mirror does not lose never-reissue (that is in D1); it does lose the hook's
token, which is a rotate.

**Residual (v1.1):** the Worker no longer stores plaintext tokens; the 0600 mirror (and every
harness env that holds `RETRACE_TOKEN` / `RETRACE_MCP_TOKEN`) still does. A bearer protocol
requires the client to hold the secret. Compensating controls, all already true and not new
crypto: mode 0600; `.retrace.json` names the credential *id* not the token; ops 14 (never print,
copy, or commit the file); rotate on machine compromise. Residual, stated: anyone who can read
that file can authenticate as the hook. That is the same residual as today, except after cutover
it is the *only* plaintext copy on the operator side of the Worker. v1 does not add a second
factor on the hook.

## 5. Store contract

### Tables (sketch; builder names columns in the PR)

`credentials` — one row per minted credential (live or retired):

- `id` (text, primary key, `crd_…`)
- `token_hash` (char 64, unique among **live** rows; retired hashes may remain for forensics)
- `actor_type`, `actor_id`, `actor_model`, `on_behalf_of`
- `trust` (`pinned` \| `assert`)
- `allowed_actors_json`, `projects_json`
- `public_key_jwk`, `public_key_kid`
- `require_signature` (integer 0/1)
- `principal_type`, `principal_id` (nullable only on imported pre-step-2 rows)
- `name` (operator bookkeeping; used in `sealed_by` as today: `pinned:<name>` / `assert:<name>`)
- `retired_at`, `created_at`
- `mint_event_id`, `retire_event_id`

`credential_keys` — durable producer-key history (T14). `(credential_id, kid)` primary key;
`public_key_jwk`; `retired_at` null for the live key. In-place rotate inserts a new live kid and
sets `retired_at` on the previous. Export `producers[]` emits **all** rows, live and retired, so a
newly generated export still verifies historical events. The `credentials.public_key_*` columns
are the live key only (denormalised for the auth read).

`credential_bindings` — Decision 2. Primary key `(project, actor_type, actor_id)`. Identity for
never-reissue is `{project, type, id}` → principal (trailer-consistency §10). `actor_model` and
`on_behalf_of` are **not** in the key. A 409 on a different principal is the rule working.

**Unscoped overlap:** a credential with `projects` unset covers every project
(`credentialCoversProject`). Bindings for unscoped history use `project = "*"` (sentinel, not a
ledger project name). Lookup: refuse re-issue if a binding exists for this `project` **or** for
`*`. Unscoped retired Alice blocks Bob in an existing project and in a later-created project.

**One live pin (T21), in the store transaction:** unique index on live pinned rows
`(coverage_project, actor_type, actor_id)` where `coverage_project` is each of `projects_json` or
`*` if unset. `assertMintBatch` + `batchPrincipalConflicts` + `refuseReissueIfBound` run inside
`mutateCredentialAndAppend`, not only in the CLI. Missing-principal history blocks **every** new
principal (T29). Two live pins for the same actor/project/principal with different tokens/kids
are 409. Two concurrent first mints: one commit, one 409.

`credential_store_state` — **exactly one row** (v1.1). Written in the **same D1/SQLite batch** as
the imported credential rows (and their bindings):

- `import_completed_at` (RFC 3339 UTC)
- `import_event_id` (the ops-project event `credential-store-imported`)
- `live_count_at_import` (integer, ≥ 1)

This is the cutover latch, not a defense against D1-write (an attacker who can INSERT credentials
can INSERT this row). It exists so `credential_store=d1` cannot serve auth against a partial or
unfinished import.

Indexes: unique live `token_hash`; unique live `public_key_kid`; unique live pinned
`(coverage_project, actor_type, actor_id)`.

### Admin HTTP (owner token only)

- `GET /credentials` — metadata only (no hash, no token). For `retrace-admin list-teams` against the
  Worker, not the file.
- `POST /credentials` — mint. Body: actor, trust, allowed_actors, projects, principal (required),
  public_key (optional), `token_hash`, name. Server does not accept a `token` field (400).
- `POST /credentials/:id/retire`
- `POST /credentials/:id/rotate` — new `token_hash` and/or new `public_key`.
- `POST /credentials/:id/set-principal` — missing principal only.
- `POST /credentials/import` — remint cutover. Body is new `token_hash` values plus metadata that
  must **equal** the live env credential set (actor/trust/principal/kid/projects). Fails if the
  table is non-empty, if the array is empty, if the set does not match env, on T21/T29/batch
  conflict. Does not accept a `token` field (400). Same batch: rows, bindings, key-history, latch,
  issuance events. `POST /credentials/import-abort` deletes them if still `credential_store=secret`.

All of the above are 403 for a per-actor credential. All fail closed on store errors (503).

`GET /api` grows `credential_store: "d1" | "secret"`, `credential_import: "done" | "pending"`, and
`credentials: <live count>` so doctor can see dual-source, missing latch, and empty-store without
dumping rows.

### `EventStore`

`getCredentialByTokenHash(hash)`, `getStoreState`, `listCredentials`, `getBinding`,
`mutateCredentialAndAppend(op, event)`. **One D1/SQLite batch** for the credential mutation
(insert/retire/rotate/bind/import), binding/key-history rows, latch if any, **and** `appendEvent`.
Today `appendEvent` → `store.insert` already opens its own D1 batch (`d1-store.ts`); awaiting
`insertCredential` then `appendEvent` is **not** one transaction. The builder supplies a single
batch primitive. Implementations: D1, SQLite, memory. The router stops taking
`opts.credentials: Credential[]` as the live set after cutover; tests construct a memory store.

## 6. Migration — the secret retires

No dual-source window in production. **Cutover is one-way after the latch.**

1. **Deploy** Worker code that implements the tables and the admin routes, still authenticating from
   the secret (`credential_store=secret`). Only `POST /credentials/import` writes D1 in this phase.
2. **Import = remint against the live env set, not a possibly-stale operator mirror.**
   `retrace-admin import-store` asks the Worker (still secret mode, owner token) for the live
   credential **metadata** set (actor, trust, principal, kid, projects — never tokens or hashes).
   Admin generates a new `mintToken` per live env credential and POSTs `{actor, kid, new_token_hash, …}`.
   The Worker requires that POST set of `{actor, trust, principal, kid, projects}` **equals**
   `parseCredentials(RETRACE_CREDENTIALS) ∪ EXTRA` (live only). Stale mirror, EXTRA omitted, or
   secret mutated since the operator started → 409, no latch. Same batch: new hashed rows,
   bindings, key-history (existing public keys copied), latch, `credential-store-imported` plus
   one `credential-rotated` per seat. Admin writes new 0600 onboarding. Old tokens remain valid
   **until cutover** (secret still serves).
3. **Freeze until cutover.** While the latch is set and `credential_store=secret`, every request
   (REST and MCP) compares the env live set to D1 metadata; drift → 503 `"import drifted"`.
   `retrace-admin` mint/retire/set-principal refuse locally ("cut over or `import-abort` first").
   `POST /credentials/import-abort` (owner, secret mode only) deletes D1 credential rows, keys,
   bindings, and latch in one batch. No credential-secret fallback.
4. **Cut over.** Set `RETRACE_CREDENTIAL_STORE=d1`. **Unset** both credential secrets. Deploy.
   Auth reads D1 only. Distribute the new tokens. Old tokens 401.
5. **Guards, 503, fail closed** (Worker `requireAuth` stays true):
   - `credential_store=d1` and either credential secret is non-empty → `"dual source"`.
   - `credential_store=d1` and latch missing → `"import not completed"` even if rows exist.
   - `credential_store=d1`, latch present, zero live rows → owner-token-only (all seats retired).
   - Store error → 503, including for a presented owner token (no D1-outage bypass).

**Rollback.** v1's "flip the var and restore the import-time mirror" is **withdrawn**. It revived
retired/rotated tokens whenever no *mint* had happened. **Once the latch is written, rollback to
secret is not a product operation.** Before the latch: still on secret; `import-abort` if needed.
After cutover: forward-fix. A failed cutover *deploy* is an ops incident: restore the **currently
serving** secrets (secret mode still up), not an older mirror.

### Local `retrace-serve` (v1.2 correction)

v1 claimed empty SQLite + no credentials already 503s under `requireAuth`. **False.**
`resolveServeConfig` generates a 24-byte ephemeral owner token when neither `RETRACE_TOKEN` nor
`RETRACE_CREDENTIALS` is set, and `startServer` does **not** pass `requireAuth`. There is no
credential table on that path today.

**Decision:** that local bootstrap stays. The import latch and 503-on-empty apply to the **Worker**
(`requireAuth: true`) and to local only when the operator sets `RETRACE_CREDENTIAL_STORE=d1` **and**
an explicit `RETRACE_TOKEN`. T12 tests the split; it does not assume a 503 that does not exist.

## 7. What this unlocks, and what it does not

Unlocks:

- Enabling Worker Streamable HTTP `/mcp` for every **pinned, single-project, `require_signature` not
  true** agent (today `authenticateRemoteMcp` linear-scans the secret). After this it looks up D1.
  Turning the flag on (`RETRACE_MCP_ENABLED`) and pointing seats at the Worker URL is a **separate
  deploy**, not this PR. OpenClaw already needs `require_signature !== true`; that constraint stays
  until OpenClaw can sign.
- Stranger install of a *hosted* Worker that has more seats than a few-KB secret can hold, without
  Jordan editing wrangler secrets per mint.
- NOOA and any later seat as ordinary `add-agent` rows, not EXTRA.

Does **not** retire (ops numbering from PR 40, `docs/agent-ops.md` at `503dc75`; Jordan's item 13
**is** that file's rule 15):

| Ops rule | After this |
|---|---|
| 1–2 shared checkout / `commit --only` | Unchanged (process / gate). |
| 3 hook runs primary checkout `dist` | **Not retired.** Packed CLI is item 3 in the 13 → 3 → 4 order, a later PR. |
| 4 worktree must `npm ci && npm run build` for MCP | **Not retired.** Packed CLI MCP is item 4. |
| 5 stale `dist` tests | Unchanged. |
| 6 stdio MCP dies mid-session | **Not retired.** HTTP `/mcp` is *unlocked*, not default. Harness respawn is vendor. |
| 7 restart after `dist` change | Unchanged (see 4). |
| 8 Cursor `envFile` | Unchanged (see 4). |
| 9 Copilot stdio / 402 / don't borrow tokens | HTTP `/mcp` may later cover the stdio half; **token-borrowing stays** (custody). |
| 10 hook vs scratch `RETRACE_DB` | Unchanged. |
| 11 doctor retry | Unchanged. |
| 12 coordinator merges | Unchanged. |
| 13 producer private JWK 0600, never in the Worker secret | **Stays.** This note reaffirms it. |
| 14 never print/commit credential files | **Stays.** The 0600 onboarding file still exists for the one-time token. |
| 15 credentials in Worker secrets / EXTRA | **Retired after cutover.** That is this note. |
| 16 one coordinator | Unchanged. |
| 17 review routing / Orca `--yolo` | Unchanged. |

Hash chain, `producer_sig` bytes, `sealed_by` strings, trailer-consistency classifier, and export
format `retrace-export/1` are unchanged. If implementing this requires a new hash field on events
other than ordinary issuance `EventInput`, **stop**.

## 8. Acceptance tests (adversarial first)

T1. Dual-source: `credential_store=d1` and `RETRACE_CREDENTIALS` set → every `POST /events` is 503,
    never 200, never a secret match.
T2. `credential_store=d1` and `credential_store_state` missing (no import latch), even if live
    credential rows exist → 503 `"import not completed"`, not 200.
T2b. Import of an empty array → 400; marker not written.
T3. Store throw (injected D1 error) on lookup → 503, not 401, not a secret fallback.
T4. Live row: presented token SHA-256-matches `token_hash` → principal is that credential;
    `producerSigCheck` uses **that row's** `public_key`. A signature whose kid is another
    credential's key is `unknown_kid` even if `event.actor` matches that other seat (kid →
    credential, not actor).
T5. Retired row: same token → 401. Binding still blocks re-issue to a different principal (T29).
T6. Mint without `principal` → 400. Mint with principal B when binding says A → 409, no row, no
    event.
T7. Retire+mint same actor to principal A → allowed; to principal B → 409. Binding row count stays 1.
T8. Import of a row with a `token` field (plaintext) → 400. Only `token_hash`.
T9. Issuance event body JSON-serialised in the test contains neither the fixture token nor
    `token_hash`. A fixture named `tok-` may exist in memory for hashing; it must not be in the
    sealed event.
T10. `GET /projects/:p/status` issuance (`shared_actor_id`, `principal_conflicts`) matches the
     tables, not a parsed secret, after cutover.
T11. Owner token still authenticates when D1 is up. A credential token never reaches owner routes
     (DELETE / PUT policy / POST /credentials).
T12. Local SQLite path: same T1–T11 against `retrace-serve` / `SqliteStore`.
T13. EXTRA unset after cutover: a credential that today lives only in EXTRA authenticates from D1
     after import; there is no EXTRA parse branch in the D1 auth path.
T14. Export `producers[]` includes retired kids; a historical event signed with a rotated key still
     verifies against that bundle.
T15. After cutover, a live row with null `mint_event_id` is a doctor **warn** (console INSERT, not
     an application mint). It still authenticates until retired — D1-write is minting (§2.1).
T16. Import never hashes a presented existing token. A 43-`A` fixture (shape-valid, 32 zero bytes)
     is not accepted as an imported hash; the seat is reminted via `mintToken`. After cutover the
     old string 401s and the new token 200s.
T17. Successful import writes `credential_store_state` in the same batch as the rows; a mid-batch
     failure leaves neither rows nor marker.
T18. Binding key is `(project, actor_type, actor_id)` only. Mint of the same actor with a different
     `actor_model` / `on_behalf_of` and a different principal is still 409.
T19. Import → latch → retire in D1 is impossible before cutover (secret still serves; D1 admin
     mint/retire refused). After cutover, retire then attempting documented v1 rollback (restore
     import-time secrets, `credential_store=secret`) is not a supported operation; the Worker with
     `credential_store=d1` and secrets restored is 503 dual-source. The retired token 401s on D1.
T20. Import body missing EXTRA's live credential that env has → 409, no latch. Secret `retire-agent`
     + `secret put` after latch, before cutover → 503 drift on the next request.
T21-store. Second live pin same actor/project/principal, different token/kid → 409, no row, no event.
     Two concurrent first mints: one live pin. Imported retired missing-principal history blocks
     Alice and Bob until one-time bind. Unscoped retired Alice blocks Bob in an existing and a new
     project.
T22. Fresh `retrace-serve`, empty env, no `RETRACE_CREDENTIAL_STORE`: ephemeral owner token, not 503.
     Same binary with `RETRACE_CREDENTIAL_STORE=d1` and no latch: 503 on credential writes.
T23. `mutateCredentialAndAppend` failure rolls back credential row, binding, key-history, latch, and
     event. Mint/retire/rotate/bind have idempotency tests.
T24. `/mcp` with a retired token is 401; with a store throw is 503. GET `?token=` equal to a
     credential token (not owner) does not authenticate as that credential.
T25. Two in-place key rotations then a **fresh** export: both retired kids verify historical events;
     retired credentials still 401.

## 9. Open questions

These do not block the three decisions. They wait for Jordan if a builder hits them.

Q1. In-place rotate vs retire+mint for producer keys. v1 says in-place on the same credential id so
    `sealed_by` names stay stable. A reviewer who wants a new id per key rotation should say so;
    that is a `sealed_by` string change for later events, not a chain change.
Q2. Whether unscoped dogfood credentials (no `projects`) are forced through a one-time
    `projects: ["retrace"]` at import. v1 imports them unscoped and writes issuance events to
    `RETRACE_OPS_PROJECT`. Tightening scope is a mint-time choice, not an import rewrite.
Q3. *(closed as constraint, v1.1)* Isolate-memory cache of live `token_hash → id` is out of v1.
    If a later version adds one after a measured D1 p95, it is write-through: invalidate or replace
    in the same batch as retire/rotate; miss falls back to D1; never serve a stale live entry.
    Not an open product question.

## 10. How to overrule

Jordan, explicitly, one instructed event at a time (agent-rules 13). Approval of this document is
not approval to deploy, mint, unset secrets, or enable `/mcp`. Each of those is its own go.

A change to Decision 1 (not D1), Decision 2 (salt, or lookup by actor), Decision 3 (self-serve
mint), the no-MAC D1-write acceptance, remint-at-import, or one-way cutover is a new version of
this note, not a builder call. Dispositions of design-review findings land in §11.

## 11. Dispositions

Codex Astra high, first design review of v1.1 (`3c4ae79`), verdict `evt_5f5d6d4464f842b59ce8c1e5d86f2f6a`
**rejected**. v1.2:

| # | Sev | Item | Disposition |
|---|---|---|---|
| C1 | P1 | Rollback after retire/rotate (no mint) restores revoked access | **Accepted.** Rollback-to-secret withdrawn once the latch is written. Dual-source 503 if secrets return. T19. |
| C2 | P1 | D1-write ≠ secret-write; D1-only principal is extra threat | **Accepted.** Equivalence claim withdrawn. D1-only-writer threat accepted; no MAC. Account grants unproven. |
| C3 | P2 | Latch ≠ authoritative snapshot; secret can drift pre-cutover | **Accepted.** Import must match live env set; freeze+drift 503 until cutover; `import-abort`. T20. |
| C4 | P2 | One-live-pin + T29 edges + unscoped overlap not in the store txn | **Accepted.** Unique live-pin index; guards inside `mutateCredentialAndAppend`; `*` bindings. T21-store. |
| C5 | P2 | Shape ≠ entropy; 43 A's | **Accepted.** Remint all at import via `mintToken`. Dump-resistance only for those tokens. T16. |
| C6 | P2 | Local 503 claim false; serve generates ephemeral owner token | **Accepted.** Documented as-is. Latch is Worker/`STORE=d1` only. T22. |
| — | — | Atomic mutation+event; key history; MCP shared auth; query-token | **Accepted** into §5/§2 read path. T23–T25. |

NOOA / Nemotron design read of v1 (`b2f2751`), coordinator-verified, round 2
(`evt_15f13661297146babad259fcfd5de839`):

| # | Sev | Item | Disposition |
|---|---|---|---|
| 1 | HIGH | D1 dump modelled, not D1 write; INSERT is minting | **Accepted.** §2.1: v1 treats D1-write as equivalent to secret-write. No row MAC, no owner signature on read. T15 detective on null `mint_event_id`. |
| 2 | HIGH | Import hashes 16-char tokens as-is; entropy unstated | **Accepted.** Facts: `mintToken` = `randomBytes(32).toString("base64url")` = 256 bits. Import accepts only that shape; anything else is refused and re-minted. Shape check is admin-side (Worker sees only hashes). |
| 3 | HIGH | `import done` marker never defined | **Accepted.** `credential_store_state` one row, same batch as import. Guard reads `import_completed_at`; missing latch → 503 even if rows exist. |
| 4 | MED | 32 bytes called 128 bits | **Accepted.** 256 bits. No-salt stands. |
| 5 | — | Extend never-reissue key with `actor_model` / `on_behalf_of` | **Rejected, no change.** Identity is `{project, type, id}` → principal (trailer-consistency §10). A 409 is the rule working. T18. |
| 6 | LOW | Post-cutover mirror still holds the hook plaintext | **Taken.** Residual stated; compensating controls named; no new factor in v1. |
| 7 | LOW | Future `token_hash` cache stale-after-retire | **Taken.** Q3 closed as a write-through constraint. v1 has no cache. |
