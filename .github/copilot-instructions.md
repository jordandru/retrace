# Retrace workspace instructions for GitHub Copilot

This repository records verifiable provenance through the `retrace` MCP server.

- At the start of a task, call `retrace_instruct` with the user's request and `human_id` set to `jordansboxing@gmail.com`. Keep the returned event id.
- After each meaningful edit, command, or decision, call `retrace_log` with that event id as `caused_by`, a concise `intent`, and the artifact ids touched.
- On every `retrace_log`, use actor id `github-copilot` and report the model actually running in `actor.model`. Do not invent a model value if it is unavailable.
- Do not log `committed` actions through MCP; the Git hook records real commits with authoritative metadata.
- Before committing, run `npm exec --package=@retrace-dev/cli -- retrace doctor` (or the local `node packages/mcp-server/dist/doctor.js doctor`) and resolve failures.
- Add commit trailers `Retrace-Actor: github-copilot`, `Retrace-Model: <actual model>`, and `Retrace-Caused-By: <instruction event id>`. Do not rely on `Co-Authored-By: Copilot` alone.
- This checkout is shared. Commit only your own paths (`git commit --only <paths>`); never `git commit -a` / `git add -A`.
- Never read, print, copy, or commit `~/.copilot/mcp-config.json`, `~/.retrace/cursor.env`, or other credential files.
- After `packages/mcp-server/dist/` changes, restart the Retrace MCP server in this Copilot session.
- If the model returns HTTP 402 `quota_exceeded`, stop. Do not reuse another harness's `RETRACE_TOKEN` to keep working.
- GitHub.com Copilot coding agent cannot use this repo's local stdio MCP; dogfood is Copilot CLI (`~/.copilot/mcp-config.json`) and VS Code Copilot Chat (`.vscode/mcp.json`).
- These instructions are authoritative for Copilot identity. Do not copy `Retrace-Actor` from `CLAUDE.md`, `GEMINI.md`, `GROK.md`, `AGENTS.md`, or `.cursor/rules/retrace-provenance.mdc`.
- CLI dogfood 2026-08-31: verify instruct `evt_b1419fbeefc144329a25510fd5eafb89` sealed as `github-copilot` (`gpt-5.6-sol`).
