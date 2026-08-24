# Retrace — repo backlog notes

> Companion to the numbered backlog briefs in the Claude Project (not visible from this repo).
> Items land here when they're born in-repo; Jordan assigns them a number in the Project backlog.

## Worker redeploy so `location.session` survives remote sealing (follow-up to #15) — added 2026-08-24, unnumbered

- **What**: `npm run build && wrangler deploy` for apps/worker, picking up the rebuilt `@retrace/core` whose
  `Location` schema includes `session` (commit f29f207).
- **Why**: #15 stamps `location.session` on the MCP write path, but the deployed Worker's compiled `EventInput`
  (Zod strip) drops the unknown key during server-side sealing on `POST /events`. The redeploy was deliberately
  deferred on 2026-08-24, so remote-sealed events currently carry system/environment/path/device but no session.
- **Scope**: deploy only — no code change. The worker has no schema of its own; local sqlite sealing already keeps session.
- **Verify after deploy**: a real `retrace_log` through the Worker seals an event whose `location.session` matches
  `run_…` (or `RETRACE_SESSION`); `retrace_verify` stays ok; pre-existing hashes untouched (append-only).
- **Related but separate**: plumb the real Claude Code session id into the MCP subprocess instead of the per-process
  run-id proxy (see TODO in `packages/mcp-server/src/index.ts`).
