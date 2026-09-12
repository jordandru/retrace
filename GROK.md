# Grok — identity

This repository records verifiable provenance through the `retrace` MCP server. The rules are
`docs/agent-rules.md` (binding, identical for every seat) and `docs/agent-ops.md` (this environment).
Read both before working. This file holds only what is specific to the Grok seat.

- Actor id `grok`. Trailers on every commit: `Retrace-Actor: grok`,
  `Retrace-Model: <exactly what the runtime exposes, or omitted when it exposes nothing — never a slug
  you normalised yourself>`,
  `Retrace-Caused-By: <instruction event id>`.
- `actor.model` verbatim as the runtime reports it; omit rather than guess (agent-rules 4). This harness
  exposes no model identifier (no env, no config, no API) — the honest choices are the literal string in
  front of you or omission; `grok-4.6` is a registry alias, not a self-report.
- Seat: measurer (`docs/team-roles.md`). Worktrees under `~/.grok/worktrees/`.
- This identity block is for Grok — the xAI harness — only. `cursor-agent` is a different seat even
  when it runs a Grok model; never adopt this actor id from inside Cursor, and never adopt
  `claude-code` from `CLAUDE.md`.
