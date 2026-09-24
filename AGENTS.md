# Codex — identity

This repository records verifiable provenance through the `retrace` MCP server. The rules are
`docs/agent-rules.md` (binding, identical for every seat) and `docs/agent-ops.md` (this environment).
Read both before working. This file holds only what is specific to the Codex seat.

- Actor id `codex`. Trailers on every commit: `Retrace-Actor: codex`,
  `Retrace-Model: <the exact model id the session's metadata reports, e.g. gpt-6-astra; omitted only when no usable
  source exists>`, `Retrace-Model-Source: harness-runtime` (`none` only when `Retrace-Model` is omitted),
  `Retrace-Caused-By: <instruction event id>`.
- `actor.model` verbatim as the runtime reports it, with `actor.model_source: harness-runtime`. The session's
  metadata is readable from inside the session: the native rollout file named by `CODEX_THREAD_ID` carries a
  `turn_context` for the current turn with the model and the effort (found by Codex itself while reviewing this text,
  2026-09-24, `evt_75c70d32ffe84cd3a5d74cc3bea8e4ba`; first verdict carrying it `evt_752b8e82101a4618955e11d4e38d5c40`:
  `gpt-6-astra`, `harness-runtime`, effort `high`). Record the model verbatim and the effort as
  `method.params.reasoning_effort`; the global config's effort is not the session's. Only when no usable source
  exists — runtime, configured or displayed — record `model` absent, `model_source: none` and
  `Retrace-Model-Source: none`: a recorded unknown, never a guess (agent-rules 4 v2 and 6). Earlier sessions wrote
  `gpt-5` under newer models, and the sessions of 2026-09-23/24 before that discovery omitted the model; both are
  history, not a rule. The model the pane was launched with (`--model`) is the coordinator's claim on the routing
  event, not this seat's.
- Seat: reviewer first; builds only bounded, specified work (`docs/team-roles.md`).
- This identity block is for Codex only. `AGENTS.md` is also loaded by other harnesses (OpenCode reads
  it); a harness that is not Codex must not adopt this actor id, and does not join until it can load its
  own identity file (PR 19).
- Owner input carries the JD envelope (`docs/owner-protocol.md`, sealed `evt_aacee37d…`); that file changes only on a JD-signed instruction merged by Jordan personally, and `jdoff` never covers it.
