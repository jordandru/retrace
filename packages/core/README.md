# @retrace-dev/core

Core schemas, hash-chain verification, causal status, signed exports, and human-readable renderers for [Retrace](https://github.com/jordandru/retrace).

Most users should install [`@retrace-dev/cli`](https://www.npmjs.com/package/@retrace-dev/cli) instead. This package is the runtime library for adapters and custom integrations.

## 0.3.0 — new exported shapes and config keys since 0.2.0

- **Policy body profile `retrace-project-policy/2` adds `github`** (`{ shared_logins: string[], identities: Record<string,string> }`, owner-login
  attribution, PR 135). Export bundles now carry it, and **a 0.2.0 client refuses such a bundle** (`invalid export bundle: unknown field "github" in
  policy body`) because the bundle's policy body is validated strictly (`policy.ts` `rejectUnknown`) and 0.2.0 does not know the field. Any consumer that verifies exports of a project whose policy is on `/2`
  must move to 0.3.0; this is the change that made the NOOA hourly audit's status read fail on the 0.2.0 pin.
- **Restricted hook witnesses** (cloud seat B2, PR 169): `.retrace.json` may list `restricted_hook_stamps`; a hook seal carrying one of them is a
  restricted witness that lowers per-path capture boundaries only for the paths it names and only when an authenticated webhook seal by the same
  actor intersects it (`capture.ts` eligibility, rule 0 for ineligible events). With no restricted stamps the reconcile report is byte-identical to
  0.2.0 (golden fixture `fixtures/reconcile-genuine-baseline.json`).
- **Principal rule on seals**: hook and webhook seals record `method.params.principal_rule` (`agent-address/1`); under it,
  `claim_decision.signed_actor.on_behalf_of` is annotated only from authenticated ingress (the webhook `User` sender mapping or a verified
  `signedActor`), never from a client-asserted `on_behalf_of`. Legacy records decode as before; unknown discriminator values substitute nothing.
- **Webhook seals carry `github_payload`** (the HMAC-covered push fields the owner-login classifier reads) and the classifier's
  `claim_decision` / capture outcome fields (PR 135 step 1, PR 138 timing, PR 146 budget 1,000 ms).
- **Export cache**: `GET /projects/:p/export?cached=1` serves the R2-cached bundle; `/status` reports the refresh outcome; a checkpoint refuses a
  stale bundle (PR 152). Offline policy selection checks older policy versions only for activation-shaped events (PR 154).
- **CLI (`@retrace-dev/cli` 0.3.0)**: `RETRACE_AUTH=proxy` makes the git hook send no token and no signature (for a hosted session whose
  proxy attaches the credential); `retrace-admin add-agent --harness claude-code-cloud` issues a pinned, keyless credential; new
  `scripts/cloud/*` (setup, MCP wrapper, push guard) ship in the repository, not in the package. The CLI pins this exact core version.
  Publish order: core first, then cli.

No environment variable became required. `RETRACE_AUTH` defaults to the 0.2.0 behaviour when unset.

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
