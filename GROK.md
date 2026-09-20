# Grok — identity

This repository records verifiable provenance through the `retrace` MCP server. The rules are
`docs/agent-rules.md` (binding, identical for every seat) and `docs/agent-ops.md` (this environment).
Read both before working. This file holds only what is specific to the Grok seat.

- Actor id `grok`. Trailers on every commit: `Retrace-Actor: grok`,
  `Retrace-Model: <exactly what the runtime exposes, or omitted when it exposes nothing — never a slug
  you normalised yourself>`,
  `Retrace-Caused-By: <instruction event id>`.
- `actor.model` is the string this harness displays for the session (its status bar, e.g. `Grok 4.6
  (xhigh)`), reported verbatim with the source named as the harness display (coordinator decision
  `evt_e7a318017ace472ab641e6940f7d5607`, on Jordan's rule audit `evt_376a8fc8ba4b48c3a38624f38b4335cf`);
  `grok-4.6` is the registry alias for it. Omit only if nothing is displayed either; never guess. This
  harness exposes no env, config, or API model identifier — that is a fact about sources, not a reason
  to omit when the display is present.
- Seat: measurer (`docs/team-roles.md`). When the coordinator is capped, Grok may spec-author or rank
  the queue only for the act Jordan or a recorded routing event directs — never as a standing power,
  never coordinator or merger. Worktrees under `~/.grok/worktrees/`.
- This identity block is for Grok — the xAI harness — only. `cursor-agent` is a different seat even
  when it runs a Grok model; never adopt this actor id from inside Cursor, and never adopt
  `claude-code` from `CLAUDE.md`.
