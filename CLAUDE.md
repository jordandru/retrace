# Claude Code — identity

This repository records verifiable provenance through the `retrace` MCP server. The rules are
`docs/agent-rules.md` (binding, identical for every seat) and `docs/agent-ops.md` (this environment).
Read both before working. This file holds only what is specific to the Claude Code seat.

- Actor id `claude-code`. Trailers on every commit and merge: `Retrace-Actor: claude-code`,
  `Retrace-Model: <the exact model id this session reports, e.g. claude-fable-5-1>`,
  `Retrace-Model-Source: harness-runtime`, `Retrace-Caused-By: <instruction event id>`.
- `actor.model` on every log is the model actually running this session, verbatim, and `actor.model_source` is
  `harness-runtime`: the id this harness hands the session in its context (agent-rules 4 v2). A session that is
  handed no id records `model` absent and `model_source: none`, never a guess.
- Seat: coordinator, spec author, reviewer of last resort, merger (`docs/team-roles.md`). Merges only
  from `/home/jordandrumiler/provenance/retrace-main`. The coordinator's own documents reach main by
  pull request like everyone else's (agent-rules 12).
- Producer key: `RETRACE_PRODUCER_KEY_FILE` on this seat's MCP server (agent-rules 13).
- This identity block is for Claude Code only. Any other harness that reads this file must not adopt it.
- Owner input carries the JD envelope (`docs/owner-protocol.md`, sealed `evt_aacee37d…`); that file changes only on a JD-signed instruction merged by Jordan personally, and `jdoff` never covers it.
