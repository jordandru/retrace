# Producer-side signing — tamper-evident roadmap rung 5

*Plan for Jordan's approval, 2026-09-01. Author: claude-code. Status: PROPOSED — not built.*

## The claim this rung earns

Today WHO is exactly as strong as the Worker's credential store: `sealed_by` is the Worker's own stamp, and README's attribution note says it plainly — agent events' WHO is producer testimony the Worker fixes via credentials. A compromised Worker (or a leaked `RETRACE_CREDENTIALS` secret) can seal any actor onto any event, and nothing offline can tell. After rung 5, every client-side producer signs its events with an Ed25519 key **the Worker never holds**; the signature is a top-level field of the event and therefore sealed inside the hash (the v2 digest covers every field except `hash` — no `hash_v` bump needed); `verify` re-checks it offline against public keys registered with the credentials. A Worker compromise can then still drop or delay events — checkpoints (rung 2) and reconciliation (rung 4) bound that — but it cannot *fabricate* an event as claude-code, codex, grok, gemini, github-copilot, cursor-agent, or the git hook without their private key files.

**Never claim:** this does not prove the model (still asserted; excluded from the signed payload on purpose), does not retroactively protect pre-rollout events (they count as `none`, like `legacy_hash_events`), and does not cover server-side adapters — `/hooks/github` runs *on* the Worker, so its trust remains GitHub's HMAC-verified delivery, stated as such; the Drive forwarder is the signable party there, deferred.

## Threat model

| threat | before | after |
|---|---|---|
| Worker / credential secret compromised; attacker seals events as any agent | undetectable offline | fabricated events carry `producer_sig` none/invalid — offline verify names and counts them |
| stolen producer token (but not the key file) | full impersonation | the key file is a second factor; on a `require_signature` credential the write is rejected |
| stolen token + key file (the producer machine itself) | — | out of scope: the machine is the identity; rotate via a new credential |
| Worker strips or swaps a signature after sealing | — | `producer_sig` is inside the sealed hash → chain break at next verify |
| replay of a signed body into another project / as another key | — | the payload signs `project` and `idempotency_key`; the kid must match the credential's registered key |
| signature laundering: sign as yourself, submit on someone else's credential | — | verdict requires the signed `actor.id` to equal the resolved (pinned) actor — mismatch is `invalid` |

## Design

### The signed payload — an explicit list, never "everything"

The server *legitimately* mutates parts of an event before sealing: `markCausedByUnverified` appends a tag and a `method.params` note; the router stamps `sealed_by`/`relayed_by` into `method.params`, drops `location.client` unless relayed, and on pinned credentials rewrites `actor` (keeping caller `display_name`/`version`/`model`). A signature over the whole body would break on every one of those. So `producer-sig.ts` (core) defines:

```
producerSignedPayload(input) = canonicalize({
  v: "retrace-producer-sig/1",
  project, actor: { type, id, on_behalf_of },   // never display_name/version/model — model stays asserted
  action, action_detail, artifacts, change,
  timestamp, duration_ms, intent, caused_by, idempotency_key,
})   // absent fields omitted; location, tags, method excluded (server-annotated territory)
```

Rules: a signing producer MUST set `timestamp` itself (else the server fills it and the offline rebuild diverges) and SHOULD set `idempotency_key`. The event gains one top-level field, `producer_sig: { kid, sig }` (schema addition to `EventInput`; `schemaSurface()` exposes it automatically). Sign/verify reuse `signCanonical`/`verifyCanonical`/`keyId` from `signing.ts` verbatim — kid is a pure function of the public key.

### Worker verification and the verdict

`Credential` (router.ts) gains `public_key?: JsonWebKey` and `require_signature?: boolean` (zod ignores unknown fields, so old Workers tolerate new credential files). In `POST /events`, after `safeParse` and `resolveActor`, before `stampSealedBy`:

- no `producer_sig` → verdict `none` (401 if the credential has `require_signature`)
- kid ≠ the credential's registered key's kid → `unknown_kid` (401 under `require_signature`)
- signature fails over the submitted payload, or the signed `actor.type/id` ≠ the resolved actor → `invalid` (401 under `require_signature`)
- else `verified`

The verdict is stamped as `method.params.producer_sig_verdict` — the `sealed_by` precedent: server wins (a caller-supplied value is stripped like `sealed_by` is today), hash-covered, visible to every reader (D1 stores events as `body` JSON; a side column would be invisible to `all()`/`get()` and outside the hash — rejected). Owner-token and webhook writes are exempt (no credential key to check; verdict `none` with no enforcement).

### Key distribution — private keys never near the Worker secret

- `retrace-export producer-keygen [--out ~/.retrace/producer-keys/<actor>.jwk]` mints a keypair (0600/0700, `keys.ts` pattern) and prints the **public** JWK + kid for pasting into the credential record. Deliberately a different file than `signing-key.json` (that's the export-issuer role).
- `retrace-admin new-team` mints one keypair per member×harness credential and for the git hook: `public_key` goes into the credentials JSON (which becomes `RETRACE_CREDENTIALS`); **private keys are written as separate files** (`producer-keys/<credential-name>.jwk`, 0600) and referenced in the onboarding doc — they must never enter the file that gets uploaded as the Worker secret. Onboarding env blocks gain `RETRACE_PRODUCER_KEY_FILE`.
- MCP server: signs every `remote.append` (`retrace_log`, `retrace_amend`, `retrace_instruct` — uniform; the signature attests the producer process, not the human) when `RETRACE_PRODUCER_KEY_FILE`/`RETRACE_PRODUCER_KEY` is set. Refuses to start signing against a Worker whose `GET /api` schema lacks `producer_sig` (zod would silently strip it — the existing `deployment schema` doctor check also catches this).
- Git hook: key file resolved beside the token in `resolveHookToken` precedence (env `RETRACE_HOOK_KEY_FILE`, else a `producer_key_file` path field on the credentials-file entry — a path, never key material, so the mirror file stays uploadable); signing failures go to `.git/retrace-hook.log` (the hook discards stdio).

### Offline verification

The export bundle gains `producers?: [{ kid, public_key, actor_id, name? }]` — the public halves, supplied by the Worker from its credential store. `verifyExportBundle` adds a per-event check in the existing hash loop: recompute the payload from the stored event's signed fields, verify against the bundle's (or a `--producers <file>` trusted) key for that kid, and require the event's sealed actor to match the signed actor. New verdict fields mirror `legacy_hash_events`: `producer_signed`, `producer_invalid` (any > 0 ⇒ problem entries), `producer_unsigned_agent_events`. `exportVerdictOk` is unchanged for now (decision C); `verify` prints the counts, `status`/`doctor` surface them. Trust note: bundle-carried producer keys are self-attested the same way the bundle issuer key is — the trusted path is the credentials you hold or a committed `producers.json`, and the check with bundle-carried keys still proves internal consistency plus hash-sealing.

### What reconcile gets later (not this rung)

A `covered-and-signed` distinction (an edit event that is producer-signed is stronger testimony than an unsigned one) — noted in `docs/reconciliation-plan.md` as the rung-5 tie-in; wired only after all six agents sign.

## Build plan

**Phase A — core + Worker (one session).**
1. `packages/core/src/producer-sig.ts` (+test): payload builder, `signProducer(input, privJwk)`, `verifyProducerSig(event, pubJwk)`, verdict type. Schema: `producer_sig` on `EventInput`.
2. Router: credential fields, verification + verdict stamp + `require_signature` 401s; strip caller-supplied verdicts. Tests incl. adversarial: forged sig; kid swap; sign-as-self-submit-as-other (actor mismatch); replay into another project; caller-supplied verdict stripped; stripped-after-seal = chain break (chain.test).
3. Export: `producers` list, per-event checks, counts; export-cli prints them; `--producers` trusted-file flag. Tests.
4. Worker deploy notes (schema gate: deploy before any producer signs). npm 0.1.5 after.

**Phase B — producers + admin (one session).**
5. MCP server signing (all three append sites, one helper); git hook signing; `producer-keygen`; admin minting + onboarding; SETUP-GUIDE/README/CLAUDE.md ("set RETRACE_PRODUCER_KEY_FILE").
6. Rollout on this repo: mint keys for the six agents + hook; Jordan updates `RETRACE_CREDENTIALS` (wrangler secret put) and each harness config; watch a day of `verified` stamps; then flip `require_signature: true` per credential — agents without keys get 401s from that moment, which is the point.

Estimate: ~2 sessions. Files are claude-code's or shared-by-convention (router.ts is Grok's — the POST /events hunk will be coordinated with Grok like the security-fix hunks were, or handed to Grok with this spec).

## Decisions for Jordan

- **A. Verdict lives in `method.params.producer_sig_verdict`** (hash-covered, `sealed_by` precedent) — stated, not really open; the alternative (D1 column) is invisible to readers and outside the hash.
- **B. New `retrace-admin` teams: `require_signature: true` from day one** — *recommended yes* (greenfield teams should never run unsigned; this repo migrates gradually).
- **C. `exportVerdictOk` unchanged for now** — *recommended yes*; add `--require-producer-sigs` (fail-closed flag) once all six agents here sign, then consider making it the default.
- **D. Uniform signing including `retrace_instruct`** — *recommended yes*; the signature attests the producer process; `relayed_by`/`sealed_by` continue to say the rest.

Reply "go rung 5" with any changes to B–D and phase A gets built.
