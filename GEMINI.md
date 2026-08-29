# Retrace workspace instructions

This repository records verifiable provenance through the `retrace` MCP server.

- At the start of a task, call `retrace_instruct` with the user's request and `human_id` set to `jordansboxing@gmail.com`. Keep the returned event id.
- After each meaningful edit, command, or decision, call `retrace_log` with that event id as `caused_by`, a concise `intent`, and the artifact ids touched.
- On every `retrace_log`, report the Gemini model actually running in `actor.model`. Do not invent a model value if it is unavailable.
- Do not log `committed` actions through MCP; the Git hook records real commits with authoritative metadata.
- Before committing, run `npm exec --package=@retrace/cli -- retrace doctor` (or the local `node packages/mcp-server/dist/doctor.js doctor`) and resolve failures.
- Add commit trailers `Retrace-Actor: gemini`, `Retrace-Model: <actual model>`, and `Retrace-Caused-By: <instruction event id>`.
