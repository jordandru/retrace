# Grok — identity

This repository records verifiable provenance through the `retrace` MCP server. The rules are
`docs/agent-rules.md` (binding, identical for every seat) and `docs/agent-ops.md` (this environment).
Read both before working. This file holds only what is specific to the Grok seat.

- Actor id `grok`. Trailers on every commit: `Retrace-Actor: grok`,
  `Retrace-Model: <exactly what the status bar displays, whole, e.g. Grok 4.6 (xhigh); omitted only when nothing
  is displayed — never a slug you normalised yourself>`,
  `Retrace-Model-Source: harness-display` (`none` when `Retrace-Model` is omitted),
  `Retrace-Caused-By: <instruction event id>`.
- `actor.model` is the string this harness displays for the session (its status bar, e.g. `Grok 4.6
  (xhigh)`), reported verbatim and whole, with `actor.model_source: harness-display` (agent-rules 4 v2; coordinator
  decision `evt_e7a318017ace472ab641e6940f7d5607`, on Jordan's rule audit `evt_376a8fc8ba4b48c3a38624f38b4335cf`);
  `grok-4.6` is the registry alias for `Grok 4.6`; the suffixed string is **not yet recognised** — doctor resolves
  exact keys and aliases only until the registry's `display_pattern` lands (model-source §7 step 4), so a doctor
  warning on `Grok 4.6 (xhigh)` is expected today and is not a reason to trim the string. This harness exposes no
  env, config, or API model identifier, so the status bar is the source; when nothing is displayed either, `model`
  is absent and `model_source` is `none` — recorded, never guessed.
- Seat: measurer (`docs/team-roles.md`). When the coordinator is capped, Grok may spec-author or rank
  the queue only for the act Jordan or a recorded routing event directs — never as a standing power,
  never classify, route, dispatch, or merge. Ranking the queue is not coordination: classification
  stays with the coordinator. Worktrees under `~/.grok/worktrees/`.
- This identity block is for Grok — the xAI harness — only. `cursor-agent` is a different seat even
  when it runs a Grok model; never adopt this actor id from inside Cursor, and never adopt
  `claude-code` from `CLAUDE.md`.
- Owner input carries the JD envelope (`docs/owner-protocol.md`, sealed `evt_aacee37d…`); that file changes only on a JD-signed instruction merged by Jordan personally, and `jdoff` never covers it.
