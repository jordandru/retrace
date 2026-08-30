# Retrace workspace instructions

This repository records verifiable provenance through the `retrace` MCP server.

- At the start of a task, call `retrace_instruct` with the user's request and `human_id` set to `jordansboxing@gmail.com`. Keep the returned event id.
- After each meaningful edit, command, or decision, call `retrace_log` with that event id as `caused_by`, a concise `intent`, and the artifact ids touched.
- On every `retrace_log`, report the Claude model actually running in `actor.model`. Do not invent a model value if it is unavailable.
- Do not log `committed` actions through MCP; the Git hook records real commits with authoritative metadata.
- Before committing, run `npm exec --package=@retrace-dev/cli -- retrace doctor` (or the local `node packages/mcp-server/dist/doctor.js doctor`) and resolve failures.
- Add commit trailers `Retrace-Actor: claude-code`, `Retrace-Model: <actual model>`, and `Retrace-Caused-By: <instruction event id>`.
- These instructions are authoritative for Claude Code. Do not copy another agent's `Retrace-Actor` from `GEMINI.md`, `GROK.md`, or `.github/copilot-instructions.md`.
- Packages are `@retrace-dev/core` and `@retrace-dev/cli` (the workspace folder is still `packages/mcp-server`).

## Operational notes (multi-agent, multi-clone)

- **If the `retrace` MCP tools vanish mid-session, restart Claude Code** (`claude --continue`). A running session does not respawn a project-scoped MCP server that has died, and the `/mcp` dialog's reconnect does not either. The `~/.claude.json` entry is fine — it is the server *process* that dropped (consistent with WSL2 fetch/stdio flakiness). Confirmed by investigation 2026-08-29 (evt_130f6e9c): the config was present in every snapshot; only a restart brought the tools back.
- **One checkout now:** `/home/jordandrumiler/provenance/retrace` (WSL) is the only clone and Orca's primary worktree since 2026-08-30; the Windows clone (`C:\Users\drumi\orca\retrace`) was removed because the two drifted apart. Orca child worktrees inherit `.retrace.json` and the post-commit hook, so each one is a live ledger producer: one branch per worktree, commit only your own paths, PR to main, `worktree rm` when merged. Still: run `git rev-parse --short HEAD` before working, and never `pull`/`reset`/`checkout` a tree that carries another agent's uncommitted changes.
- **This checkout is shared by five agents.** Uncommitted work in the tree gets swept into whichever agent commits next (this happened — bfe87c3, corrected by c375ed4). Finish a task by committing only your own paths (`git commit --only <paths>`); never `git commit -a`/`git add -A` when another agent's changes are staged or unstaged in the tree.
