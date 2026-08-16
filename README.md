# Retrace

Provenance ledger for mixed human + AI work. Every event records **who** (person or agent) did **what**, **when**, **where**, **why**, and **how** — sealed in a tamper-evident hash chain, with causal links from each agent action back to the human instruction that triggered it.

```
packages/core        schema (zod), hash chain, verify, "why" chain, renderers   — runs in Node, Workers, browsers
packages/mcp-server  MCP server (stdio) so Claude Code / Claude Desktop / Cursor log natively
apps/worker          Cloudflare Worker + D1 REST API
```

## Quick start (local, no cloud needed)

```bash
npm install
npm run build
npm test
```

Add the MCP server to Claude Code (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "retrace": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/retrace/packages/mcp-server/dist/index.js"],
      "env": {
        "RETRACE_PROJECT": "boxing-rpg",
        "RETRACE_ACTOR": "claude-code",
        "RETRACE_ACTOR_MODEL": "claude-fable-5",
        "RETRACE_ON_BEHALF_OF": "jordansboxing@gmail.com"
      }
    }
  }
}
```

Same block works in Claude Desktop's `claude_desktop_config.json`. Events go to `~/.retrace/retrace.db` (override with `RETRACE_DB`).

### Tools the agent gets

| tool | purpose |
|---|---|
| `retrace_instruct` | log a human instruction — the root of a causal chain; returns an id |
| `retrace_log` | log any action (created/edited/deleted/executed/approved/sent/…) with `caused_by` |
| `retrace_history` | timeline, filter by artifact / actor / action / time / text |
| `retrace_why` | walk `caused_by` links back to the originating human intent |
| `retrace_verify` | recompute the hash chain and report integrity |
| `retrace_projects` | list projects |

Suggested instruction to put in your project's `CLAUDE.md` so agents log automatically:

> At the start of each task call `retrace_instruct` with my request. After each file edit, command run, or decision, call `retrace_log` with `caused_by` set to the instruction id, a one-sentence `intent`, and the artifact ids you touched.

## Cloud mode (Cloudflare Worker + D1)

D1 database `retrace-db` (`ae8ebc52-9784-4109-b421-f63676972dfe`) already exists in your account with the schema applied.

```bash
cd apps/worker
npx wrangler login
npx wrangler secret put RETRACE_TOKEN     # pick a long random string
npx wrangler deploy                        # prints https://retrace-api.<you>.workers.dev
```

Then point the MCP server at it by adding to its `env`:

```json
"RETRACE_URL": "https://retrace-api.<you>.workers.dev",
"RETRACE_TOKEN": "<same token>"
```

REST API: `POST /events`, `GET /events/:id`, `GET /events/:id/why`, `GET /projects`, `GET /projects/:p/events?artifact_id=&actor_id=&since=&text=`, `GET /projects/:p/head`, `GET /projects/:p/verify`.

## Event shape (short)

```jsonc
{
  "project": "boxing-rpg",
  "actor": { "type": "agent", "id": "claude-code", "model": "claude-fable-5", "on_behalf_of": "jordan" },   // WHO
  "action": "edited", "artifacts": [{ "id": "repo:rpg#src/fight.ts", "kind": "file" }],                    // WHAT
  "change": { "summary": "add jab counter", "after_hash": "…" },
  "timestamp": "2026-08-16T19:21:54Z",                                                                    // WHEN
  "location": { "path": "src/fight.ts", "system": "claude-code", "environment": "local" },                // WHERE
  "intent": "implement jab counter", "caused_by": "evt_…",                                                // WHY
  "method": { "tool": "Edit", "automated": true, "tokens": 1200 },                                        // HOW
  "seq": 1, "prev_hash": "…", "hash": "…"                                                                 // integrity
}
```

## Status / next

Done: core schema + chain (tested), MCP server (tested via in-memory MCP client), Worker + D1 store (smoke-tested locally with `wrangler dev`, live D1 schema applied).
Next: deploy Worker, timeline UI (per-artifact scrubber + why panel), Git hook adapter, signed export.
