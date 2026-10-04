# @retrace-dev/core

Core schemas, hash-chain verification, causal status, signed exports, and human-readable renderers for [Retrace](https://github.com/jordandru/retrace).

Most users should install [`@retrace-dev/cli`](https://www.npmjs.com/package/@retrace-dev/cli) instead. This package is the runtime library for adapters and custom integrations.

## 0.3.0 — breaking changes and new shapes since 0.2.0

**Breaking for consumers of the exported API (each one a required change when upgrading):**

- **`mapGithubWebhook` and `mapGithubPullRest` are now `async`** (`github.ts`): both return `Promise<EventInput[]>` instead of `EventInput[]`.
  Every caller must `await` them (or `.then`); spreading or `Array.isArray`-testing the direct return value breaks at this version.
- **Artifact ids are validated** (`schema.ts`): `ArtifactRef.id` and every `derived_from` entry use the refined `ArtifactId` schema — a non-empty
  string with no NUL and well-formed Unicode (no lone surrogates). Inputs 0.2.0 accepted, such as `{ id: "a\u0000b" }`, `{ id: "\ud800" }` or
  `derived_from: [""]`, are rejected with `InvalidArtifactIdError` / a Zod issue; fix the input, nothing is sanitised. `ArtifactId` is a refined schema,
  so `ArtifactRef.shape.id` no longer exposes `ZodString` methods (`.min`, `.regex`); validate with `ArtifactId.parse` / `safeParse`.
- **Custom `EventStore` implementations** (`store.ts`): `PendingDelivery` gains a required `gh_event: string | null` (the GitHub event name of a
  pending delivery; `null` marks legacy push rows — the SQLite store migrates with `ALTER TABLE pending_deliveries ADD COLUMN gh_event TEXT`); and
  the amendment-capture read path uses the optional `captureIndexRows(q, now?, metrics?)` — a store that implements only
  `eventsReferencingArtifacts` makes those classifications return `store_error` (`classify.ts`). Implement `captureIndexRows` (the helper
  `captureIndexRowsFromEvents` derives it from a full event list) and add the column.
- **Policy body profile `retrace-project-policy/2` adds `github`** (`{ shared_logins: string[], identities: Record<string,string> }`, owner-login
  attribution). The policy body is validated strictly (`policy.ts` `rejectUnknown`), so **a 0.2.0 client refuses an export bundle whose policy is
  on `/2`** (`invalid export bundle: unknown field "github" in policy body`) — measured against the published 0.2.0 package. Any consumer that
  verifies exports of such a project must move to 0.3.0 (this is what made the NOOA hourly audit's status read fail on its 0.2.0 pin).

**New shapes and config keys (additive):**

- **Restricted hook witnesses** (cloud seat B2): `.retrace.json` may list `restricted_hook_stamps`; a hook seal carrying one is a restricted witness
  that lowers per-path capture boundaries only for the paths it names and only when an authenticated webhook seal by the same actor intersects it
  (`capture.ts`; ineligible events contribute nothing). The reconcile report gains an optional `restricted_hook_stamps` diagnostics array, present
  only when such a stamp was observed. **Byte-identity is a bounded claim:** with no restricted stamps the report matches the pre-B2 implementation
  at `28c7e854` for the genuine-only fixture of `reconcile.test.ts` T17 (golden `fixtures/reconcile-genuine-baseline.json`, reproduced by Codex
  against a rebuilt base over 11,988 real events). It is **not** a guarantee of identity with 0.2.0: diagnostics changed since 0.2.0 — for example
  the `uncovered` message now names the effective cutoff seq rather than the sealing event's seq (`x.ts: no edit event between #start and #10`
  where 0.2.0 printed `#20`). Do not compare serialised reports across these versions.
- **Two seal families carry classification fields — do not conflate them.** (1) *Commit push classification* (`classify.ts`, 500 ms budget): webhook
  and hook seals of commits record `method.params.principal_rule` (`agent-address/1`); under it `claim_decision.signed_actor.on_behalf_of` is
  annotated only from authenticated ingress (the webhook `User` sender mapping or a verified `signedActor`), never from a client-asserted
  `on_behalf_of`; legacy records decode as before; unknown discriminator values substitute nothing. (2) *Owner-login events* (`owner-login.ts`,
  1,000 ms budget): pull-request, review and issue-comment events mapped from GitHub carry `github_payload` (the HMAC-covered fields the owner-login
  classifier reads). `owner_login_decision` is attached **only** when the project policy is on profile `/2`, the payload names a login, and that
  login is mapped in `github.identities` or listed in `github.shared_logins` (`owner-login.ts` `classifyOwnerLogin`); on policy `/1`, an empty
  `/2` `github` block, or an unlisted login the event records no decision — read it as optional. A push commit event has neither field (an
  owner-login `push` action is a PR `synchronize`).
- **Export cache**: `GET /projects/:p/export?cached=1` serves the R2-cached bundle; `/status` reports the refresh outcome; a checkpoint refuses a
  stale bundle. Offline policy selection checks older policy versions only for activation-shaped events. New exports from `index.ts`: the capture
  types (`CapturePolicy`, `CaptureSeal`, `RestrictedStamp`, …) and the `owner-login*` modules.
- **CLI (`@retrace-dev/cli` 0.3.0)**: `RETRACE_AUTH` may be unset (0.2.0 behaviour) or `proxy` (the git hook sends no token and no signature, for a
  hosted session whose proxy attaches the credential; any other value is an error); `retrace-admin add-agent --harness claude-code-cloud` issues a
  pinned, keyless credential; `scripts/cloud/*` (setup, MCP wrapper, push guard) live in the repository, not in the package. The CLI pins this
  exact core version. Publish order: core first, then cli.

No environment variable became required.

## 0.2.0 — breaking changes for consumers of the exported schemas

- `Actor` is now a refined schema (a Zod `ZodEffects`, since model-source step 2, commit `4fe6f44`): it enforces that a
  `model_source` other than `none` comes with a `model`, and that `none` comes without one. A refined schema has no
  `.shape`, `.partial()` or `.extend()`; code that called those on `Actor` in 0.1.x breaks. Validate with `Actor.parse` /
  `Actor.safeParse`; the field names are available from `schemaSurface().actor`. New optional fields: `actor.model_source`
  (one of `harness-runtime`, `harness-config`, `harness-display`, `credential-pinned`, `operator-stated`, `self-report`,
  `none`) and `actor.model_claims[]`.
- `method.params.reasoning_effort` and `method.params.routing_event_id`, when present, must be non-empty strings
  (previously any value was accepted).
- `@retrace-dev/cli` 0.2.0 pins this exact version. Publish order: core first, then cli.

No environment variable became required; `RETRACE_ACTOR_MODEL_SOURCE` is optional and, when set, must pair correctly with
`RETRACE_ACTOR_MODEL`.
