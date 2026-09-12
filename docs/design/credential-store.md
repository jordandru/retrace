# Credential store — contract (credentials out of the Worker secret)

**Status:** DRAFT v1.1, 2026-09-12, author grok (architect). Not built. v1 was `b2f2751` (PR 42).
v1.1 folds the NOOA/Nemotron design read (coordinator-verified): D1-write as the relocated secret
trust boundary; import entropy floor from `mintToken`; `import_done` marker defined; 32 bytes = 256
bits. Round-2 instruction `evt_15f13661297146babad259fcfd5de839`. Not a claim that anything here
runs. Jordan's item 13 in the 13 → 3 → 4 build order (PR 40 `docs/agent-ops.md` rule 15). Design
gate: Codex (Astra, high) reviews this head after PR 34; Nemotron landed; Claude last. Companion to
`producer-signing-plan.md` rung 5, `commit-trailer-consistency.md` §10, and `credential-status.ts`
(T21, T29). **This note does not change the hash chain or the seal format.** If a reviewer finds
that it must, the build stops.

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
2a. **D1-write is the trust boundary the Worker secret used to be.** An INSERT of a `credentials`
   row whose `token_hash` is SHA-256 of a token the attacker knows *is minting*, and it does not
   go through the owner token. v1 does not MAC or owner-sign rows. See §2.1.
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

### 2.1 D1-write is minting (v1.1)

v1 modelled a **dump** (read of the table) and not a **write**. That was a hole. With credentials in
D1, anyone who can `INSERT` a row with `token_hash = SHA-256(token they chose)` has minted a live
credential without the owner token. Retire and rotate are the same: a `UPDATE` is the act.

**Decision: v1 accepts D1-write as equivalent to today's secret-write, and says so.** It does not
MAC rows and does not owner-sign them. The Worker does not verify a row signature on read.

Why equivalent, not weaker:

- Today's mint path that the Worker honours is `wrangler secret put RETRACE_CREDENTIALS`. That is
  Cloudflare-account (or API-token) write to this Worker's bindings. `wrangler d1 execute` / the
  D1 dashboard / a D1 API token scoped to this database are the **same account surface**. An
  attacker who can INSERT into this D1 could already replace the secret.
- The *application* mint path stays owner-token HTTP (`POST /credentials`). Direct D1 writes are
  outside the application, as direct secret edits are today. `retrace-admin` is not a second
  gate on wrangler; it never was.
- A row MAC or owner signature, verified on every auth read, would defend only the narrower case
  "D1 write without the MAC/signing key" (dashboard editor, stolen D1-only token). The MAC key
  or signing key would be another Worker secret — the class of object this move is shrinking —
  and Worker compromise (the threat that already stamps `sealed_by`) forges the MAC. v1 will not
  pretend that construction raises the bar that matters.

What a D1-write attacker gets that a dump attacker does not: a token they know, bound to an actor
they chose, until someone notices. Same as a secret-write attacker. Compensating: Cloudflare
account ACL, D1 audit logs (Cloudflare's, not Retrace's), and the issuance event that *application*
mints still write — a console INSERT will not have a matching `credential-minted` event. Doctor
can warn on live rows with null `mint_event_id` after cutover (T15). That is detective, not
prevention.

Overrule: Jordan. A later version that MACs rows is a new decision, not a builder extra.

### Read path per request (after cutover)

1. Read `Authorization: Bearer`. No bearer and no owner `?token=` on GET → unauthenticated (today's
   rule).
2. SHA-256 (UTF-8) the presented secret; hex encode (64 lowercase chars). This is `token_hash`.
3. `SELECT` the credential row `WHERE token_hash = ?`. **D1/SQLite error → 503, fail closed. Do not
   try the secret. Do not try a stale cache.**
4. No row, or `retired_at` set → try owner `tokenEquals(presented, RETRACE_TOKEN)` (the remaining
   secret). Match → owner principal. Miss → 401.
5. Row live → that credential is the principal. `producerSigCheck(input, row.public_key)` — the key
   on **this** row, identified by kid. `event.actor` is not consulted for key selection.
6. `require_signature: true` and verdict ≠ `verified` → 401, unchanged.

Owner routes (DELETE project, PUT policy, share create, credential admin) still require the owner
token. A credential never becomes owner.

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
- **Import entropy floor (v1.1), not hash-as-is for anything ≥ 16 chars.** Unsalted SHA-256 is
  sound only above an entropy floor. The Worker schema minimum (16 chars) is **not** that floor
  (16 base64url chars is 96 bits; 16 hex is 64). Import cannot see generation method — only the
  token string — and this note does not inspect live tokens.

  **Decision: import accepts a token only if it matches `mintToken`'s shape** (exactly 32 bytes
  when base64url-decoded; equivalently 43-char base64url). Those are treated as 256-bit CSPRNG
  outputs of `mintToken` or an equivalent `randomBytes(32)` and are hashed as-is. **Any other
  token is refused (400)**; the operator re-mints that seat (`rotate` / `add-agent`), which goes
  through `mintToken` and writes a `credential-rotated` / `credential-minted` event. Empty import
  is 400.

  Whether every live dogfood token matches that shape is **unproven here** (reading live tokens
  is forbidden). Import will name the rows that need rotation. Local `retrace-serve`'s ephemeral
  token (`randomBytes(24)` in `serve.ts`, 192 bits) is not a Worker credential and is not
  imported.

### Compromise of the store (D1 dump, SQLite file, replica)

Yields: credential id, actor `{type,id,model?,on_behalf_of?}`, trust, `allowed_actors`, `projects`,
principal, `public_key` (already public; export bundles carry producer keys), `kid`, `retired_at`,
issuance event ids, `token_hash`.

Does not yield: the bearer token, any producer private JWK (`d`), the owner token.

An attacker with the dump cannot authenticate (no preimage of a 256-bit `token_hash`). They can
enumerate who is bound to whom — `/status` issuance already reports a projection of that. They
cannot change `sealed_by` on already-sealed events. **They can mint if they can WRITE D1** (§2.1)
— dump is not write. A compromised *Worker process* can still stamp `sealed_by` on new events;
producer signatures still fail closed for seats with `require_signature: true`. That limit is
rung 5, not this note. Bindings still block application-path re-issue (T29); a console INSERT
can still create a row that authenticates until detected (T15).

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

`credential_bindings` — Decision 2. Primary key `(project, actor_type, actor_id)`. Identity for
never-reissue is `{project, type, id}` → principal (trailer-consistency §10). `actor_model` and
`on_behalf_of` are **not** in the key. A 409 on a different principal is the rule working.

`credential_store_state` — **exactly one row** (v1.1). Written in the **same D1/SQLite batch** as
the imported credential rows (and their bindings):

- `import_completed_at` (RFC 3339 UTC)
- `import_event_id` (the ops-project event `credential-store-imported`)
- `live_count_at_import` (integer, ≥ 1)

This is the cutover latch, not a defense against D1-write (an attacker who can INSERT credentials
can INSERT this row). It exists so `credential_store=d1` cannot serve auth against a partial or
unfinished import.

Indexes: unique live `token_hash`; unique live `public_key_kid`; `(actor_type, actor_id)`.

### Admin HTTP (owner token only)

- `GET /credentials` — metadata only (no hash, no token). For `retrace-admin list-teams` against the
  Worker, not the file.
- `POST /credentials` — mint. Body: actor, trust, allowed_actors, projects, principal (required),
  public_key (optional), `token_hash`, name. Server does not accept a `token` field (400).
- `POST /credentials/:id/retire`
- `POST /credentials/:id/rotate` — new `token_hash` and/or new `public_key`.
- `POST /credentials/:id/set-principal` — missing principal only.
- `POST /credentials/import` — one-shot cutover helper: array of rows already hashed. Fails if the
  table is non-empty. Fails if the array is empty (400). Fails closed on any T29 / batch conflict.
  Does not read Worker secrets. Does not accept a `token` field (400). **The Worker cannot see
  entropy from a hash**; the `mintToken` shape check is `retrace-admin`'s, on the plaintext, before
  POST. On success the same batch writes `credential_store_state` and one ops-project event
  `credential-store-imported`.

All of the above are 403 for a per-actor credential. All fail closed on store errors (503).

`GET /api` grows `credential_store: "d1" | "secret"`, `credential_import: "done" | "pending"`, and
`credentials: <live count>` so doctor can see dual-source, missing latch, and empty-store without
dumping rows.

### `EventStore`

`getCredentialByTokenHash(hash)`, `insertCredential`, `retireCredential`, `rotateCredential`,
`listCredentials`, `getBinding`, `insertBinding`, `getStoreState`, `completeImport`.
Implementations: D1, SQLite, memory. The router stops taking `opts.credentials: Credential[]` as
the live set after cutover; tests construct a memory store.

## 6. Migration — the secret retires

No dual-source window in production.

1. **Deploy** Worker code that implements the tables and the admin routes, still authenticating from
   the secret (`credential_store=secret`). Admin routes may write D1 while auth still reads the
   secret, **or** they may refuse until step 2; v1 refuses mint-to-D1 while auth is still secret so
   the two sources cannot diverge. Only `POST /credentials/import` writes D1 in this phase.
2. **Import.** Operator runs `retrace-admin import-store` from the local mirror: each token is
   checked against the `mintToken` shape **on the plaintext, locally**; matching tokens are
   hashed; others are listed by credential name/actor (never the token) and the POST is **not
   sent** until those seats are re-minted. POST `/credentials/import` (hashes only). The same
   D1 batch inserts the rows, the bindings, and `credential_store_state`. Confirm `GET /api`
   shows `credential_import: "done"` and the live count. Never logs a token. On conflict (T29,
   duplicate hash, duplicate kid, empty array) the import is 4xx and the secret stays
   authoritative. Partial failure rolls back the batch; the marker is not written.
3. **Cut over.** Set `RETRACE_CREDENTIAL_STORE=d1` (Worker var, not a secret). **Unset**
   `RETRACE_CREDENTIALS` and `RETRACE_CREDENTIALS_EXTRA`. Deploy. Auth reads D1 only.
4. **Guards, all 503, fail closed, no owner-open mode** (`requireAuth` stays true):
   - `credential_store=d1` and either credential secret is non-empty → `"credential store: dual source"`.
   - `credential_store=d1` and `credential_store_state.import_completed_at` is null →
     `"credential store: import not completed"` (**even if live rows exist** — unfinished or
     console-inserted rows without the latch).
   - `credential_store=d1`, marker present, zero live rows → owner-token-only. That is allowed
     (every seat retired). Import of zero rows is 400, so this state is post-retire, not
     pre-import.

Rollback is a Worker var flip back to `secret` **plus** restoring the secrets from the operator's
mirror, not "read both". A rollback after new D1-only mints would drop those mints from auth — so
rollback is only defined before the first post-import mint. After that, forward-fix. State that
limit in the builder PR.

Local `retrace-serve`: empty SQLite credentials table + no `RETRACE_CREDENTIALS` already 503s under
`requireAuth`. Dev continues to pass credentials via env until someone imports; that is local, not
the cloud cutover.

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
T16. `retrace-admin import-store` refuses a 16-char fixture token (below `mintToken` shape) without
     POSTing; a 43-char base64url 32-byte token is hashed and POSTed. The Worker never sees the
     plaintext.
T17. Successful import writes `credential_store_state` in the same batch as the rows; a mid-batch
     failure leaves neither rows nor marker.
T18. Binding key is `(project, actor_type, actor_id)` only. Mint of the same actor with a different
     `actor_model` / `on_behalf_of` and a different principal is still 409.

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

A change to Decision 1 (not D1), Decision 2 (salt, or lookup by actor), or Decision 3 (self-serve
mint) is a new version of this note, not a builder call. Dispositions of design-review findings
land in §11.

## 11. Dispositions

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
