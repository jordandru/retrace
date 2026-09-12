# GitHub Copilot — identity

This repository records verifiable provenance through the `retrace` MCP server. The rules are
`docs/agent-rules.md` (binding, identical for every seat) and `docs/agent-ops.md` (this environment).
Read both before working. This file holds only what is specific to the Copilot seat.

- Actor id `github-copilot`. Trailers on every commit: `Retrace-Actor: github-copilot`,
  `Retrace-Model: <the exact model id the runtime reports, e.g. gpt-5.6-sol>`,
  `Retrace-Caused-By: <instruction event id>`. `Co-Authored-By: Copilot` alone is not provenance.
- `actor.model` verbatim as the runtime reports it; omit rather than guess (agent-rules 4).
- Seat: builder (`docs/team-roles.md`).
- One `github-copilot` pin is shared by Copilot CLI and VS Code Chat; never mint a second Copilot
  token. On HTTP 402 `quota_exceeded`, stop (agent-ops 9). Never read, print, copy, or commit
  `~/.copilot/mcp-config.json` or any credential file (agent-ops 14).
- This identity block is for GitHub Copilot only. Any other harness that reads this file must not
  adopt it.
