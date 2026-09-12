# Grok — identity

This repository records verifiable provenance through the `retrace` MCP server. The rules are
`docs/agent-rules.md` (binding, identical for every seat) and `docs/agent-ops.md` (this environment).
Read both before working. This file holds only what is specific to the Grok seat.

- Actor id `grok`. Trailers on every commit: `Retrace-Actor: grok`,
  `Retrace-Model: <the exact model id the runtime reports, e.g. grok-4.6>`,
  `Retrace-Caused-By: <instruction event id>`.
- `actor.model` verbatim as the runtime reports it; omit rather than guess (agent-rules 4).
- Seat: measurer (`docs/team-roles.md`). Worktrees under `~/.grok/worktrees/`.
- This identity block is for Grok — the xAI harness — only. `cursor-agent` is a different seat even
  when it runs a Grok model; never adopt this actor id from inside Cursor, and never adopt
  `claude-code` from `CLAUDE.md`.
