# Codex — identity

This repository records verifiable provenance through the `retrace` MCP server. The rules are
`docs/agent-rules.md` (binding, identical for every seat) and `docs/agent-ops.md` (this environment).
Read both before working. This file holds only what is specific to the Codex seat.

- Actor id `codex`. Trailers on every commit: `Retrace-Actor: codex`,
  `Retrace-Model: <the exact model id the runtime reports, e.g. gpt-5.6-sol; omitted when it reports none>`,
  `Retrace-Model-Source: <harness-runtime when Retrace-Model is the runtime's id; none when Retrace-Model is omitted>`,
  `Retrace-Caused-By: <instruction event id>`.
- `actor.model` verbatim as the runtime reports it, with `actor.model_source: harness-runtime`. When the runtime
  exposes no identifier to the model — every Codex verdict of 2026-09-23/24 recorded "exact runtime model identifier
  not exposed" — record the unknown rather than guess: `model` absent, `model_source: none`, and
  `Retrace-Model-Source: none` on commits (agent-rules 4 v2 and 6). Earlier sessions wrote `gpt-5` under newer
  models; a guess is still worse than a recorded `none`. The model the pane was launched with (`--model`) is the
  coordinator's claim on the routing event, not this seat's.
- Seat: reviewer first; builds only bounded, specified work (`docs/team-roles.md`).
- This identity block is for Codex only. `AGENTS.md` is also loaded by other harnesses (OpenCode reads
  it); a harness that is not Codex must not adopt this actor id, and does not join until it can load its
  own identity file (PR 19).
- Owner input carries the JD envelope (`docs/owner-protocol.md`, sealed `evt_aacee37d…`); that file changes only on a JD-signed instruction merged by Jordan personally, and `jdoff` never covers it.
