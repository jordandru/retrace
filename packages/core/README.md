# @retrace-dev/core

Core schemas, hash-chain verification, causal status, signed exports, and human-readable renderers for [Retrace](https://github.com/jordandru/retrace).

Most users should install [`@retrace-dev/cli`](https://www.npmjs.com/package/@retrace-dev/cli) instead. This package is the runtime library for adapters and custom integrations.

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
