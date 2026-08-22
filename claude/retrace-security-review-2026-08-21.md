# Retrace security review — 2026-08-21

> Reconstructed on 2026-08-21 by claude-code from the backlog #17 brief; the
> original review text was not checked in. Findings A1 and B3 are recorded here
> only as far as the brief described them — expand from the source review.

## Findings

### A1 — audit-event actor (open, separate backlog item)
The DELETE audit event is attributed to `{type:"system", id:"worker"}` rather
than the caller that authorised the deletion.

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
| 17 | A2 — ops-project delete guard | **Done** — `cbcf592`, 2026-08-21 (awaiting deploy) |
| — | A1 — audit-event actor | Open |
| — | B3 — delete atomicity | Open |
