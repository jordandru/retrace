# Retrace security review — 2026-08-21

> Reconstructed on 2026-08-21 by claude-code from the backlog #17 brief; the
> original review text was not checked in. Finding B3 is recorded here only as
> far as that brief described it — expand from the source review. A1/B4 were
> updated 2026-08-21 from the backlog #16 brief.

## Findings

### A1 + B4 — MCP-server actor authentication (backlog #16) — **DONE 2026-08-21**
`packages/mcp-server/src/index.ts` resolved the actor from caller input with no
authentication. `retrace_log` passed `actor` through verbatim whenever
`actor.type` was `"human"`/`"system"`, so any agent could write a
human-approved event (A1); in the agent branch `{...defaultActor, ...args.actor}`
let the caller override `id`/`model`/`on_behalf_of` (B4). `retrace_instruct`
hardcoded `{type:"human", id: args.human_id}` for any string, forging the
human-origin root of a causal chain.

**Fix:** commit `57e33ea` (`packages/mcp-server/src/index.ts`), Option A —
mirrors the `RETRACE_PROJECT_LOCK` / `RETRACE_COMMIT_LOCK` pattern.
- `RETRACE_ACTOR_LOCK` (default **on**) / `opts.actorLock` in `buildServer`.
- `resolveActor()`: locked → `actor.type` `"human"`/`"system"` throws; identity
  (`id`, `model`, `on_behalf_of`) comes from env and cannot be overridden —
  the caller may only set `display_name`/`version`.
- `resolveHuman()`: locked → `retrace_instruct` attributes to a human only when
  `human_id === RETRACE_ON_BEHALF_OF`; unset `RETRACE_ON_BEHALF_OF` is rejected
  with a configure-it message.
- `RETRACE_ACTOR_LOCK=0` restores the old behaviour (backfill / trusted
  contexts). Known limitation: cross-actor assertion (e.g. a `claude-cowork`
  event from a server configured as `claude-code`) now needs the escape hatch;
  the credentialed per-actor version is backlog #6.
- Tests in `packages/mcp-server/src/server.test.ts` (in-memory store, env
  stripped/restored per 3c4b3e5): forged human/system `retrace_log` rejected
  with nothing written; agent-branch `id`/`on_behalf_of`/`model` come from env;
  `retrace_instruct` with mismatched `human_id` rejected, matching succeeds,
  unset `RETRACE_ON_BEHALF_OF` rejected; `RETRACE_ACTOR_LOCK=0` restores
  overrides for both tools. `npm test`: 22/22 core, 10/10 mcp-server.
- Provenance: instruction `evt_fdbbf98c93544ce3af01d3e8df40c5dd` → edit
  `evt_b62afac84c894d60b9f936f6b66261d4` → tests
  `evt_453b7d38205e4880bf1bb83b1411ab41` → push
  `evt_c63268f9ec584923b4e2811a1b8a156a`.
- Status: merged to `main`. MCP server is local-only — no deploy; takes effect
  on the next MCP server restart, which needs `RETRACE_ON_BEHALF_OF` set.
- Out of scope, still open: the Worker's `POST /events` path (`router.ts`) is a
  separate trust boundary, tracked as #6.

### Audit-event actor (open, separate backlog item)
The DELETE audit event is attributed to `{type:"system", id:"worker"}` rather
than the caller that authorised the deletion. (The #17 reconstruction labelled
this "A1"; per the #16 brief, A1 is the MCP actor-forging finding above.)

### A2 — ops-project delete guard (backlog #17) — **DONE 2026-08-21**
`DELETE /projects/:p` had no guard against deleting the ops/audit project.
`DELETE /projects/retrace?confirm=retrace` wiped every event in "retrace"
(including all prior delete-audit events), then appended the new audit event to
the now-empty ops project, so `appendEvent` read `head=null` and `sealEvent`
restarted at seq 0 / `GENESIS_HASH`. The chain was destroyed and re-seeded, and
`GET /projects/retrace/verify` still returned `ok:true`. Secondly, the audit
event for a normal delete recorded only row counts, so a genesis-restart of the
deleted project elsewhere would have been undetectable.

**Fix:** commit `cbcf592` (`packages/core/src/router.ts`)
- After the 501/confirm/404 gates: `project === (opts.opsProject ?? "retrace")`
  → `403 {"error":"refusing to delete the ops/audit project"}`. Nothing is
  deleted and no audit event is appended.
- `store.head(project)` is captured before deletion; the audit event carries
  `change.before_hash = <head hash>` and a summary ending
  `at head <hash> seq <n>`.
- Tests in `packages/core/src/router.test.ts`: ops delete → 403 with ops chain
  hashes byte-identical (both `opsProject:"ops"` and default `"retrace"`);
  normal delete still succeeds and the audit event matches the pre-delete head;
  existing confirm-gate / 404 / 501 cases unchanged. `npm test`: 22/22 core,
  5/5 mcp-server.
- Provenance: instruction `evt_2de1eee6cc0241e5bf8ee9e173844b59` → edit
  `evt_373512eacf67417b968605058549fc59` → push
  `evt_91fbe198b17d401eb5b0f9be5a07d283`.
- Status: merged to `main`, **not yet deployed** (Jordan deploys after review).

### B3 — delete atomicity (open, separate backlog item)
`store.deleteProject` and the subsequent ops `appendEvent` are not atomic; a
failure between them leaves a deletion with no audit record.

## Backlog

| # | Finding | Status |
|---|---------|--------|
| 16 | A1 + B4 — MCP-server actor authentication | **Done** — `57e33ea`, 2026-08-21 (local MCP, no deploy) |
| 17 | A2 — ops-project delete guard | **Done** — `cbcf592`, 2026-08-21 (awaiting deploy) |
| 6 | Worker `POST /events` actor trust / credentialed per-actor | Open |
| — | Audit-event actor | Open |
| — | B3 — delete atomicity | Open |
