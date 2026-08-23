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

### Worker `POST /events` actor trust (backlog #6) — **DONE 2026-08-21** (deployed; `RETRACE_CREDENTIALS` set 2026-08-22)
One shared `RETRACE_TOKEN` authorised every owner route and `POST /events`
stored the body's `actor` verbatim (`packages/core/src/router.ts`). Every token
holder — MCP server, git hook, Apps Script forwarder, the UI's `?token=`, curl —
could assert any actor, human included; the #16 lock only constrains the MCP
server's own process, not a caller that hits the Worker directly.

**Fix:** Option A (decided by Jordan 2026-08-21): `RETRACE_CREDENTIALS` secret,
legacy `RETRACE_TOKEN` kept as the owner token.
- `Credential` schema + `parseCredentials()` in `router.ts`: JSON array of
  `{token (≥16 chars), name?, actor, trust: "pinned" | "assert"}`; malformed
  config throws at parse time.
- `authenticate()`: owner token via Bearer or `?token=` (UI); credentials Bearer
  only. Unknown token → 401.
- `resolveActor()` on `POST /events`: pinned credential → actor stamped from the
  credential (body may add `display_name`/`version`; a different `actor.type`
  → 403, nothing written) — mirrors the MCP `RETRACE_ACTOR_LOCK`. Assert
  credential and owner → body actor verbatim (git hook / forwarders relay other
  people's actions).
- Scope: credentials may `POST /events` and read; `DELETE`, `POST …/share` →
  403. `POST /hooks/gdrive` accepts owner or assert credentials only.
- Wired in `apps/worker/src/index.ts` (`RETRACE_CREDENTIALS`) and
  `packages/mcp-server/src/serve.ts`; `/api` reports `credentials: n`.
- Tests in `packages/core/src/router.test.ts` (MemStore): pinned human/system
  → 403 nothing written; pinned agent override → stamped; assert/owner
  verbatim; query-string credential → 401; reads ok; DELETE/share/gdrive → 403
  for pinned; parse validation. `npm test`: 27/27 core, 10/10 mcp-server.
- Rollout: code deployed 2026-08-21 (Worker version 0490ceaa).
  `RETRACE_CREDENTIALS` set 2026-08-22 (Worker version 401f6410, secret
  change) with three credentials — pinned `agent/claude-code`
  (`on_behalf_of` Jordan), assert `system/retrace-git`, assert
  `system/gdrive-forwarder`; tokens kept in
  `~/.retrace/worker-credentials.json` (mode 600, not in the repo).
  `/api` → `credentials: 3`.
- Clients (2026-08-22): `RETRACE_URL`/`RETRACE_TOKEN` (owner token) are set
  in Jordan's shell env, so the MCP server and git hook were already writing
  to the Worker — as owner, actor asserted verbatim. The claude-code MCP entry
  in `~/.claude.json` now sets `RETRACE_URL` + its **pinned** credential as
  `RETRACE_TOKEN` (config env overrides the shell's). Verified by spawning the
  server with a wrong `RETRACE_ACTOR_MODEL`: stored event `seq 78` carries
  the credential's actor (`claude-fable-5`), not the body's. Still on the
  owner token: the git hook (shell env; `.retrace.json` is tracked, so its
  assert token can't go there — use `RETRACE_TOKEN` in the hook's env) and
  the Drive forwarder (Apps Script property). The owner token keeps working
  unchanged.
- Still open: signed per-actor requests (non-repudiation) were considered
  (Option C) and deferred.

### Audit-event actor — **DONE 2026-08-21** (deployed with `RETRACE_OWNER` set)
The DELETE audit event was attributed to `{type:"system", id:"worker"}` rather
than the caller that authorised the deletion — it said only that *the server*
did it. (The #17 reconstruction labelled this "A1"; per the #16 brief, A1 is
the MCP actor-forging finding above.)

**Fix:** commit `862335f`
- Since #6 the route is owner-token-only, so the owner token is given an
  identity: `RouterOptions.ownerActor` — `RETRACE_OWNER=<email>` in the Worker
  (`[vars]`) and local server → `{type:"human", id}`.
- The audit event is attributed to that actor, carries
  `method {tool:"http", automated:false, params:{route:"DELETE /projects/:p",
  principal:"owner"}}`, `location {url, system:"retrace-api"}`, and an optional
  `?caused_by=evt_…` so `/events/:id/why` walks from the deletion back to the
  instruction that asked for it.
- Unset `RETRACE_OWNER` → previous `system/worker` actor, now marked
  `automated:true`, so the gap is visible rather than silent.
- Tests in `router.test.ts`: owner attribution + route/location + `why` chain;
  fallback. `npm test`: 32/32 core, 12/12 mcp-server.
- Status: merged to `main`, **deployed 2026-08-21 (Worker version 0490ceaa)**.

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
- Status: merged to `main`, **deployed 2026-08-21 (Worker version 0490ceaa)**.

### B3 — delete atomicity — **DONE 2026-08-21** (deployed)
`store.deleteProject` and the subsequent ops `appendEvent` were two separate
writes; a failure between them left a deletion with no audit record (and the
retry/ordering made the reverse — an audit event for a deletion that never
committed — possible too).

**Fix:** commit `7f481b0`
- `EventStore.deleteProject(project, audit: Event)` — the store must delete the
  project's rows AND insert the already-sealed audit event in one transaction.
- Router (`packages/core/src/router.ts`): seals the audit event against the ops
  head *before* deleting, hands it to the store, and re-seals/retries (≤5×) if a
  concurrent ops write takes its seq (the whole transaction rolls back, so
  nothing is half-applied). Summary is now
  `deleted project "<p>" (<n> events) at head <hash> seq <n>` — per-table
  counts stay in the HTTP response (they aren't knowable before the delete and
  the audit body is hashed at seal time).
- `D1Store.deleteProject`: deletes + audit insert in one `db.batch` (atomic in
  D1). `SqliteStore.deleteProject` added (`BEGIN … COMMIT/ROLLBACK`) so the
  local server serves `DELETE /projects/:p` too and the guarantee is tested on
  a real SQL engine.
- Tests: `router.test.ts` — audit sealed before deletion and passed into the
  store call (no separate insert); store failure → nothing deleted, no audit;
  concurrent ops write → retried onto the new head, chain verifies.
  `sqlite-store.test.ts` — happy path; stale audit seq → UNIQUE → deletes and
  share rolled back. D1 itself is not exercised locally (no wrangler harness) —
  its batch atomicity is a documented platform guarantee. `npm test`: 30/30
  core, 12/12 mcp-server.
- Status: merged to `main`, **deployed 2026-08-21 (Worker version 0490ceaa)**.

#### B3 follow-up — stale head in the audit record — **DONE 2026-08-23** (deployed)
Found by ultrareview of `1b26794..f5036b2`. The router read the target
project's head once, outside the retry loop, and baked it into
`change.summary` / `change.before_hash`. `DELETE FROM events WHERE project = ?`
is unconditional, so a `POST /events` that raced the delete (now an ordinary
workflow with pinned-credential agents, #6) was wiped with the audit still
claiming the pre-race count and hash; a losing concurrent DELETE likewise
re-sealed and committed an audit describing rows it never touched. B3's
"no deletion without an audit" held — the audit's `change` fields could lie.

**Fix:** compare-and-delete.
- `EventStore.deleteProject(project, audit, expectedHead)` — the store checks
  *inside* its transaction that the target head is still exactly
  `expectedHead` and throws `HeadMovedError` (new, exported from core)
  committing nothing otherwise. The audit has to be sealed before the
  transaction (its hash covers `before_hash`), so the store can't compute the
  head for the router; it verifies the one the router sealed from instead.
- Router: head read + `change` moved inside the retry loop; `HeadMovedError`
  is retried exactly like a UNIQUE collision (≤5×), re-reading both heads.
- `SqliteStore`: synchronous head read between `BEGIN` and the deletes.
- `D1Store`: a batch has no control flow, so the check is SQL — the audit row
  is `INSERT … SELECT … WHERE <head == expectedHead>` and every `DELETE` is
  `… AND EXISTS (SELECT 1 FROM events WHERE id = <audit.id>)`; zero rows from
  the audit insert after the batch ⇒ `HeadMovedError`. The statement shapes
  were verified against node:sqlite (same engine as D1).
- Tests: `router.test.ts` — a write to the target between head read and
  delete is retried and the audit records the 3-event head and the late
  event's hash; persistent `HeadMovedError` surfaces after the retry budget
  with nothing deleted. `sqlite-store.test.ts` — moved head ⇒
  `HeadMovedError`, deletes/share/ops untouched, retry with the fresh head
  succeeds. `npm test`: 34/34 core, 13/13 mcp-server.
- Status: commit `92a7c6a`, pushed to `main`, **deployed 2026-08-23 (Worker
  version fcad2060)**; ops chain verified live after deploy (88 events, ok).
  The D1 delete path itself has not been exercised against production — doing
  so writes a permanent ops audit event, so it is left for a deliberate
  throwaway-project delete.

## Backlog

| # | Finding | Status |
|---|---------|--------|
| 16 | A1 + B4 — MCP-server actor authentication | **Done** — `57e33ea`, 2026-08-21 (local MCP, no deploy) |
| 17 | A2 — ops-project delete guard | **Done** — `cbcf592`, 2026-08-21 (deployed 0490ceaa) |
| 6 | Worker `POST /events` per-actor credentials | **Done** — `6502813`, 2026-08-21 (deployed 0490ceaa; `RETRACE_CREDENTIALS` set 2026-08-22, version 401f6410) |
| — | Audit-event actor | **Done** — `862335f`, 2026-08-21 (deployed 0490ceaa, `RETRACE_OWNER` set) |
| — | B3 — delete atomicity | **Done** — `7f481b0`, 2026-08-21 (deployed 0490ceaa) |
| — | B3 follow-up — stale head in delete audit | **Done** — `92a7c6a`, 2026-08-23 (deployed fcad2060) |
