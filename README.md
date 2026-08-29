# Retrace

Provenance ledger for mixed human + AI work. Every event records **who** (person or agent) did **what**, **when**, **where**, **why**, and **how** — sealed in a tamper-evident hash chain, with causal links from each agent action back to the human instruction that triggered it.

```
packages/core        schema (zod), hash chain, verify, "why" chain, renderers   — runs in Node, Workers, browsers
packages/mcp-server  MCP server (stdio) + `retrace-serve` local UI/API server
packages/core/ui     timeline UI (single self-contained HTML, embedded into core at build)
apps/worker          Cloudflare Worker + D1 — REST API + serves the same UI at /
```

## Quick start (local, no cloud needed)

Walkthrough (clone → MCP → Worker → GitHub/Drive): [SETUP-GUIDE.md](SETUP-GUIDE.md). Published CLI: `npx @retrace-dev/cli` (`@retrace-dev/core` is the library).

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

Same block works in Claude Desktop's `claude_desktop_config.json`. Codex takes a matching `[mcp_servers.retrace]` in its `config.toml` with `RETRACE_ACTOR = "codex"`; Grok Build TUI takes the equivalent block in `~/.grok/config.toml` with `RETRACE_ACTOR = "grok"`. Each agent must use its own pinned token—never Claude's—or the Worker will seal events as the wrong actor. Events go to `~/.retrace/retrace.db` (override with `RETRACE_DB`).

### See the timeline

```bash
npm run serve            # → http://localhost:7777  (reads ~/.retrace/retrace.db, or RETRACE_DB)
node scripts/seed-demo.mjs   # optional: seed a demo Boxing-RPG session first (RETRACE_DB=/tmp/demo.db to keep it separate)
```

The UI shows a per-project timeline (humans amber ●, agents blue ■, system grey), the chain-integrity badge, filters by actor type / action / artifact / text, and a detail panel with WHO · WHAT · WHEN · WHERE · WHY · HOW, the causal chain back to the originating instruction, downstream consequences, and hashes. It auto-refreshes every 15 s. Click any artifact chip or actor name to filter. ⚙ lets you point it at a remote Worker (URL + token) or load a JSON export offline. Deep link: `/?project=boxing-rpg&api=https://…&token=…`.

### Git adapter — commits become events automatically

```bash
cd /path/to/your/repo
node /ABSOLUTE/PATH/retrace/packages/mcp-server/dist/git-hook.js install --project boxing-rpg
node /ABSOLUTE/PATH/retrace/packages/mcp-server/dist/git-hook.js backfill      # optional: log existing history (idempotent, safe to re-run)
npm exec --package=@retrace-dev/cli -- retrace doctor                         # read-only preflight; exits nonzero when capture is not ready
npm exec --package=@retrace-dev/cli -- retrace status                         # human-readable integrity + capture + causality status
npm exec --package=@retrace-dev/cli -- retrace status retrace --json          # the identical canonical model for automation/agents
```

`install` writes `.git/hooks/post-commit` and a committable `.retrace.json` (`{ "project", "environment", optional "db" | "url" + "token" | "credential" }`). `"credential": "retrace-git"` makes the hook send that scoped assert credential's token (looked up by `actor.id` in `RETRACE_CREDENTIALS_FILE`, default `~/.retrace/worker-credentials.json`) instead of `RETRACE_TOKEN`, so the repo never carries the owner token; without it the precedence is unchanged (`RETRACE_HOOK_TOKEN` > `RETRACE_TOKEN` > file). Hook failures (a 401/403 from a fail-closed credential, config errors) are appended to `.git/retrace-hook.log` — re-log with `retrace-git commit <sha>`. Every commit is then logged: WHO = the author (human), or an **agent** when the commit carries trailers `Retrace-Actor: claude-code` / `Retrace-Model: …` or a `Co-Authored-By:` naming Claude/Copilot/Codex/Grok/etc. (the human author becomes `on_behalf_of`); WHAT = `commit:<repo>@<sha>` plus one `repo:<repo>#<path>` artifact per changed file with `+ins −del`; WHY = the commit message, and `caused_by` from a `Retrace-Caused-By: evt_…` trailer, `RETRACE_CAUSED_BY` env, or `.git/retrace-caused-by`. Merge commits log as `merged`. Idempotency key is the sha, so backfills never duplicate.

`retrace doctor` checks the repository marker and hook, resolves the scoped credential without printing its token,
confirms the actor on `HEAD` is authorized, compares the live Worker's schema with this build, verifies the project hash
chain, and confirms that `HEAD` reached the ledger. Every failure includes the command or configuration to repair it.

**Remote-write guard.** Writing to a *remote* ledger needs a `.retrace.json` in the repo root — the committed marker
that says this repo logs somewhere. Without it, an ambient `RETRACE_URL` in your shell would silently make any scratch
repo write to production under a project named after its directory; that is how four junk projects reached the live
Worker on 2026-08-28. `retrace-git` now refuses, naming the ledger, the repo, the project it would have created, and
the ways out: `retrace-git install` (writes the file), `RETRACE_DB=<path>` to write locally, or `--allow-remote` /
`RETRACE_ALLOW_REMOTE=1` for env-only setups such as CI backfill. Local writes are not gated — a stray row in a SQLite
file is cheap to discard; a sealed event in a shared append-only ledger costs a `DELETE /projects/:p`.

Tip for agents (put in `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` / `GROK.md`): *when committing, add trailers `Retrace-Actor: <your harness id>`, `Retrace-Model: <model>`, and `Retrace-Caused-By: <instruction event id>`.* Do not copy another harness's actor id.

### GitHub PR adapter — PRs, reviews, comments, CI runs become events

Point a GitHub webhook at `POST /hooks/github?project=<name>` (Worker or `retrace-serve`), secret = `RETRACE_GITHUB_SECRET`. Deliveries are HMAC-verified; each becomes an event: PR opened → `created`, new commits → `edited`, review → `approved` / `rejected`, comment → `sent`, merge → `merged` (with the merge commit as an artifact derived from the PR), Actions run → `executed` (system actor). Bots become `system` (Copilot/Claude-style bots become `agent`). Artifact ids line up with the git adapter (`pr:<owner/repo>#n`, `commit:<owner/repo>@<sha>`), and a `Retrace-Caused-By: evt_…` line in the PR body links the PR — and its reviews — back to the originating instruction. Redeliveries dedupe by delivery id.

```bash
node packages/mcp-server/dist/github-cli.js setup slcwitit/rpg --url https://retrace-api.<you>.workers.dev --project boxing-rpg   # prints webhook settings / gh api one-liner
node packages/mcp-server/dist/github-cli.js backfill slcwitit/rpg --project boxing-rpg --token $GITHUB_TOKEN                     # import existing PRs + reviews (idempotent)
node packages/mcp-server/dist/github-cli.js replay payload.json --event pull_request                                             # test with a saved payload
RETRACE_GITHUB_SECRET=hooksecret node scripts/simulate-github.mjs                                                                # fake a whole PR lifecycle against a local server
```

### Google Docs / Drive adapter — docs, sheets, slides, comments, sharing

Zero-infra path: paste `adapters/google-apps-script/Code.gs` into a new Apps Script project, enable the Drive Activity + People services, set `RETRACE_URL` / `RETRACE_TOKEN` / `RETRACE_PROJECT` (optional `RETRACE_FOLDER` to scope to one folder), run `setup`. It backfills the last 7 days and then polls every 5 minutes, forwarding Drive Activity to `POST /hooks/gdrive` where Retrace maps it: create → `created`, edit → `edited` (one event per co-editor, with the edit-session duration), comment → `sent`, share → `other:shared` (with who got what role), rename/move/trash/restore. Artifacts are `gdoc:<fileId>` (kind doc/sheet/slides/form/file), `gfolder:<id>`. Google doesn't expose comment text via this API, only that a comment happened. Full instructions in `adapters/google-apps-script/README.md`.

```bash
node packages/mcp-server/dist/gdrive-cli.js replay packages/core/test-fixtures/drive-activity.json --project boxing-rpg   # try the mapping locally
node packages/mcp-server/dist/gdrive-cli.js backfill --token "$(gcloud auth print-access-token)" --folder <id> --since 2026-08-01  # direct API backfill
```

### Prove — signed exports, printable reports, share links

Every export is a JSON bundle (events in scope + causal ancestors + full-chain verdict at export time) signed with an **Ed25519** key; the issuer's public key is embedded and also published at `/.well-known/retrace-pubkey`. Anyone can verify offline.

```bash
node packages/mcp-server/dist/export-cli.js keygen                       # ~/.retrace/signing-key.json (auto-created on first export too)
node packages/mcp-server/dist/export-cli.js export boxing-rpg --artifact "repo:rpg#src/ui/JabCounter.tsx" --out jab.json --report jab.html
node packages/mcp-server/dist/export-cli.js verify jab.json              # VALID / NOT VALID + reasons; --pubkey <jwk.json|url> to pin a trusted key
node packages/mcp-server/dist/export-cli.js share boxing-rpg --label "Jab counter — client review" --days 30
```

In the UI: **Report** opens the printable report (Print → Save as PDF), **Export** downloads the signed bundle, **Share** creates a read-only link (`/s/<id>`, optional artifact scope + expiry) that serves the timeline, chain verify, signed export and report **without a token**. Agents get the same via MCP tools `retrace_export` and `retrace_share`. Set `RETRACE_ISSUER="SLC WIT' IT"` to name the issuer; for the Worker put the private JWK in `wrangler secret put RETRACE_SIGNING_KEY` (print it with `keygen --print-private`) and set `RETRACE_PUBLIC_URL` if behind a custom domain.

### Lineage graph — which artifacts came from which

Toggle **Graph** in the UI (or `?view=graph`). Nodes are artifacts, laid out left→right by lineage depth; edges are **derived_from** (purple, explicit — e.g. commit → child commit, or `{derived_from: [...]}` on any artifact), **causal flow** (an event caused by another touched a different artifact: instruction → file → PR), and, with "show people & agents", dashed **touched** edges from actors. Click a node to highlight its neighbourhood and filter the timeline; artifacts with no links yet are packed in a grid below. Buttons export Graphviz DOT or copy Mermaid. API: `GET /projects/:p/lineage?artifact_id=&format=json|dot|mermaid&actors=1` (also `/s/:id/lineage`). MCP: `retrace_lineage`.

### Tools the agent gets

| tool | purpose |
|---|---|
| `retrace_instruct` | log a human instruction — the root of a causal chain; returns an id |
| `retrace_log` | log any action (created/edited/deleted/executed/approved/sent/…) with `caused_by` |
| `retrace_history` | timeline, filter by artifact / actor / action / time / text |
| `retrace_why` | walk `caused_by` links back to the originating human intent |
| `retrace_verify` | recompute the hash chain and report integrity |
| `retrace_status` | integrity, causal coverage, capture gaps, actors and integration freshness |
| `retrace_export` | signed JSON bundle (+ optional HTML report file) for a project/artifact |
| `retrace_share` | create a read-only share link (project or artifact scope, optional expiry) |
| `retrace_lineage` | artifact lineage (text / DOT / Mermaid / JSON) |
| `retrace_projects` | list projects |

Suggested instruction to put in your project's `CLAUDE.md` so agents log automatically:

> At the start of each task call `retrace_instruct` with my request. After each file edit, command run, or decision, call `retrace_log` with `caused_by` set to the instruction id, a one-sentence `intent`, and the artifact ids you touched.

## Cloud mode (Cloudflare Worker + D1)

D1 database `retrace-db` (`ae8ebc52-9784-4109-b421-f63676972dfe`) already exists in your account with the schema applied.

```bash
cd apps/worker
npx wrangler login
npx wrangler secret put RETRACE_TOKEN     # pick a long random string (owner token: UI, DELETE, share)
                                          # set RETRACE_OWNER=<your email> under [vars] so owner-only actions (DELETE) are audited as you, not as "worker"
npx wrangler secret put RETRACE_CREDENTIALS   # optional: per-actor tokens, e.g. '[{"token":"<32+ chars>","actor":{"type":"agent","id":"claude-code","model":"claude-fable-5","on_behalf_of":"you@example.com"}}]'
                                          # pinned (default) tokens get their actor stamped by the Worker; add "trust":"assert" for the git hook / forwarders
npx wrangler deploy                        # prints https://retrace-api.<you>.workers.dev
```

Then point the MCP server at it by adding to its `env`:

```json
"RETRACE_URL": "https://retrace-api.<you>.workers.dev",
"RETRACE_TOKEN": "<same token>"
```

REST API: `POST /events`, `GET /events/:id`, `GET /events/:id/why`, `GET /projects`, `GET /projects/:p/events?artifact_id=&actor_id=&since=&text=`, `GET /projects/:p/head`, `GET /projects/:p/verify`, `GET /projects/:p/status`.

### Where an event came from — session, terminal, IDE

`location` records more than a path. Six fields are **server-stamped**: `retrace_log` silently drops
`session`, `device`, `client`, `ide`, `workspace` and `surface` if a caller sends them, because they are evidence *about*
the writer and an agent that could assert them could forge the thing they exist to prove — the same reasoning, and the
same place of enforcement, as `RETRACE_ACTOR_LOCK` (both live in the MCP server; the Worker's `POST /events` trusts
whatever a scoped credential sends, as it always has). `path`, `url`, `environment` and `system` stay caller-wins: the
agent knows the file it edited better than the server, which only knows its own cwd.

| field | what it is | where it comes from |
|---|---|---|
| `session` | the harness session, shared across everything one agent run touches | `CLAUDE_CODE_SESSION_ID` or `GROK_SESSION_ID` (the harness passes it to MCP subprocesses and to shells, so the **git hook stamps the same value** and a commit joins that run's events). `RETRACE_SESSION` overrides; an MCP client with no session gets a `run_…` id. A human's own `git commit` gets **none** — no fallback, because an id that is always present cannot discriminate. |
| `client` | which MCP client wrote it, `name@version` | the MCP `initialize` handshake — e.g. `claude-code@2.1.250`, `cursor-vscode@1.7.3`, `grok-shell-retrace@1.0.13` |
| `system` | the tool the event came from | the same handshake (`cursor-vscode` → `cursor`, `grok-shell-retrace` → `grok`). It used to be hardcoded `claude-code` for every client. `RETRACE_SYSTEM` overrides, and unlike the six above a caller may still set it — an adapter legitimately knows its own system. |
| `ide` / `workspace` | the IDE hosting the agent, and the isolated workspace inside it | the IDE's own environment. [Orca](https://www.onorca.dev/) sets `ORCA_PANE_KEY` / `ORCA_TAB_ID` / `ORCA_WORKTREE_ID` on every agent pane; `ORCA_WORKTREE_ID` is what tells N parallel agents apart. `RETRACE_IDE` / `RETRACE_WORKSPACE` override for an IDE we cannot detect. |
| `surface` | `tty` (a human typed it) or `agent` (a harness ran it) | git hook only, from `/proc/self/stat` field 7 — not `isatty()`, which the hook's own `>/dev/null 2>&1` destroys. Linux-only; absent elsewhere. |
| `device` | the machine | `os.hostname()`, or `RETRACE_DEVICE` to override — a hostname is sealed into hash-covered bodies that share links serve pre-auth, and no later redaction is possible, so capture time is the only control point. |

On the git side `session`, `ide`, `workspace` and `surface` describe **the process that produced the commit**, so only the live post-commit hook stamps
them: `retrace-git backfill` and `retrace-git commit <sha>` replay commits the running process did not make, and
stamping there would seal today's session, IDE and terminal onto someone else's 2024 commit. The hook marks itself with
a `--hook` flag, so **re-run `retrace-git install` in repos hooked before this change** — an older hook script keeps
working and simply records none of the four.

Nothing is guessed: an IDE that does not name itself gets no `ide`, and terminal-emulator identity is deliberately **not**
recorded — inside WSL there is none to read (`TERM_PROGRAM`, `WT_SESSION`, `ITERM_SESSION_ID` are all absent and `TERM` is
identical everywhere), and stamping a guess would break the rule that a producer records only what it authoritatively knows.

**Orca + WSL:** Orca sets its vars on the Windows side and forwards only `HISTFILE` and the git-credential vars through
`WSLENV`, so they do not reach a WSL pane. To capture them there, add a user-level Windows
`WSLENV=ORCA_PANE_KEY/u:ORCA_TAB_ID/u:ORCA_WORKTREE_ID/u` — Orca appends to whatever `WSLENV` already holds, so yours
survives. Native macOS/Linux panes need nothing. In the UI, click a session or workspace value to search for it.

## Event shape (short)

```jsonc
{
  "project": "boxing-rpg",
  "actor": { "type": "agent", "id": "claude-code", "model": "claude-fable-5", "on_behalf_of": "jordan" },   // WHO
  "action": "edited", "artifacts": [{ "id": "repo:rpg#src/fight.ts", "kind": "file", "role": "both" }],     // WHAT · role = PROV used | generated | both (optional; absent = unspecified)
  "change": { "summary": "add jab counter", "after_hash": "…" },
  "timestamp": "2026-08-16T19:21:54Z",                                                                    // WHEN
  "location": { "path": "src/fight.ts", "system": "claude-code", "environment": "local",                  // WHERE
                "session": "e09a0ccf-…", "client": "claude-code@2.1.250",                                 //   who/where it ran (server-stamped)
                "ide": "orca", "workspace": "wt_feature_x", "surface": "agent" },                         //   IDE pane · isolated worktree · no tty
  "intent": "implement jab counter", "caused_by": "evt_…",                                                // WHY
  "method": { "tool": "Edit", "automated": true, "tokens": 1200 },                                        // HOW
  "seq": 1, "prev_hash": "…", "hash": "…"                                                                 // integrity
}
```

## Status / next

Done: core schema + chain (tested), MCP server (tested via in-memory MCP client), Worker + D1 store (smoke-tested locally with `wrangler dev`, live D1 schema applied), timeline UI (served locally and by the Worker; verified with Playwright incl. tamper detection), Git post-commit adapter (tested on a temp repo + dogfooded on this repo), Ed25519-signed exports + offline verify + printable report + read-only share links (tested incl. tamper/wrong-key), artifact lineage graph (core + UI + API + MCP; git commits now carry derived_from → parent commit), GitHub PR adapter (HMAC-verified webhook + backfill/replay CLI; simulated full PR lifecycle end-to-end), Google Docs/Drive adapter (Apps Script forwarder + POST /hooks/gdrive mapping + CLI; fixture-tested and simulated end-to-end), PROV artifact roles (`role: used | generated | both` stamped by every adapter, defaulted by verb on `retrace_log`, shown as in/out markers in the UI, report and event text; deployed 2026-08-25), run context on WHERE (`location.client` from the MCP handshake, `ide`/`workspace` from the IDE's own env — Orca panes and worktrees — `surface` tty/agent from the git hook, and `session` now the harness's real session id so MCP events and the commits they drive share one key; server-stamped and caller-proof on the MCP path, live-hook-only on the git path).
Deployed: Worker version `649243a7-a304-4bfb-b3db-f99447f6611d` on 2026-08-28; schema compatibility verified against all 44 fields/verbs. Claude Code, Codex, Gemini CLI, Grok, and GitHub Copilot now have separate scoped identities, and the git-hook credential allows commits from all five.

⚠ Ship order for any new `location`/event field: **core → `npm run build` at the root → deploy the Worker → producers → UI.**
`POST /events` re-parses with `EventInput.safeParse` and Zod strips unknown keys, so a field stamped before the Worker is
deployed is silently dropped from every remote-sealed event — accepted, sealed and hashed without it, with no error
anywhere. That has happened twice (`location.session`, `bacabed`; the run-context fields, 2026-08-28). Respawn the MCP
server afterwards — it captures its session id at spawn and keeps its old `dist` until it is restarted.

You no longer have to remember: `GET /api` publishes the schema surface a deployment understands, derived from the zod
shapes so it cannot drift from the code, and

```bash
npm run check-deploy                 # or: npm run check-deploy https://retrace-api.<you>.workers.dev
```

diffs it against the local build — exit 0 if the deployment understands every field you send, exit 1 listing the ones it
would silently drop. No token, no writes; run it after every deploy, and in CI if you add one.
Licensed under the [Apache License 2.0](LICENSE).
