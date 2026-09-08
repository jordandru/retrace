# OPENCODE.md is authoritative for OpenCode identity.

OpenCode also auto-loads `AGENTS.md` (Codex's identity file) and combines it with this file; `instructions` in `opencode.json` adds files, it does not replace `AGENTS.md`. Do not copy another agent's Retrace-Actor from AGENTS.md, CLAUDE.md, GEMINI.md, GROK.md, .github/copilot-instructions.md or .cursor/rules/. Your actor.id is `opencode`.

# Retrace workspace instructions

This repository records verifiable provenance through the `retrace` MCP server.

- At the start of a task, call `retrace_instruct` with the user's request and `human_id` set to `jordansboxing@gmail.com`. Keep the returned event id.
- After each meaningful edit, command, or decision, call `retrace_log` with that event id as `caused_by`, a concise `intent`, and the artifact ids touched.
- On every `retrace_log`, report the OpenCode model actually running in `actor.model`. Do not invent a model value if it is unavailable.
- Do not log `committed` actions through MCP; the Git hook records real commits with authoritative metadata.
- Before committing, run `npm exec --package=@retrace-dev/cli -- retrace doctor` (or the local `node packages/mcp-server/dist/doctor.js doctor`) and resolve failures.
- Add commit trailers `Retrace-Actor: opencode`, `Retrace-Model: <actual model>`, and `Retrace-Caused-By: <instruction event id>`.
- These instructions are authoritative for OpenCode identity; do not copy another agent's Retrace-Actor from AGENTS.md, CLAUDE.md, GEMINI.md, GROK.md, .github/copilot-instructions.md or .cursor/rules/.
