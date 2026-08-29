# Retrace identity for Grok

Grok auto-loads `CLAUDE.md` via Claude compatibility. That file's `Retrace-Actor: claude-code` trailer is for Claude Code only.

This harness is Grok. Follow `GROK.md`:

- `retrace_instruct` at task start (`human_id`: `jordansboxing@gmail.com`)
- `retrace_log` after each edit/command/decision with `caused_by`, `intent`, and artifact ids
- Report the actual Grok model in `actor.model`
- Do not log `committed` via MCP
- Commit trailers: `Retrace-Actor: grok`, `Retrace-Model: <actual model>`, `Retrace-Caused-By: <instruction event id>`
