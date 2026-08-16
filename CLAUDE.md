# Retrace — agent notes
Monorepo: packages/core (schema+chain), packages/mcp-server, apps/worker. Build: `npm run build`; test: `npm test`.
Provenance: at the start of a task call `retrace_instruct` with the user's request; after each edit/command/decision call `retrace_log` with `caused_by`, `intent`, and artifact ids.
Git: this repo has the retrace-git hook installed. When committing, add trailers `Retrace-Actor: claude-code`, `Retrace-Model: <your model>`, and `Retrace-Caused-By: <instruction event id from retrace_instruct>`.
