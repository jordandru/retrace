# Retrace — Laptop Setup Walkthrough (v0.7)

Work top to bottom. Each stage ends with a check so you know it worked before moving on. Commands assume macOS/Linux terminal; on Windows use WSL or Git Bash. Anything in `<angle brackets>` is yours to fill in.

---

## Stage 0 — Prerequisites (10 min)

You need: **Node.js 22.13 or newer** (`node -v`), **git**, and a **Cloudflare account** (free tier is fine — you already have one, since `retrace-db` lives in it). Optional but useful: the **GitHub CLI** (`gh`) and **Claude Code** or **Claude Desktop** for the MCP part.

If Node is older than 22.13, install the current LTS from nodejs.org (the local ledger uses Node's built-in SQLite, which needs ≥ 22.13).

---

## Stage 1 — Unzip, build, test (5 min)

1. Download `retrace-v0.7.zip` from our chat and unzip it somewhere permanent, e.g. `~/code/retrace`.
2. In a terminal:
   ```bash
   cd ~/code/retrace
   npm install
   npm run build
   npm test
   ```
   **Check:** you should see `# pass 10` (core) and `# pass 2` (mcp-server), `# fail 0` for both. Warnings about "SQLite is an experimental feature" are normal.

3. Note the absolute path — you'll paste it into configs:
   ```bash
   pwd        # e.g. /Users/jordan/code/retrace
   ```

---

## Stage 2 — See it working locally with demo data (5 min)

1. Seed a demo Boxing-RPG session into a scratch database and start the local server:
   ```bash
   RETRACE_DB=/tmp/demo.db node scripts/seed-demo.mjs
   RETRACE_DB=/tmp/demo.db npm run serve
   ```
2. Open http://localhost:7777 in your browser.
   **Check:** badge says "chain intact · 9 events". Click an event → detail panel shows WHO/WHAT/WHEN/WHERE/WHY/HOW and the causal chain. Toggle **Graph**. Try **Report** (opens printable page), **Export** (downloads signed JSON), **Share** (creates a `/s/…` link — open it in a private window to see the client view).
3. Optional extra demos while the server runs (new terminal, same `RETRACE_DB`):
   ```bash
   RETRACE_DB=/tmp/demo.db RETRACE_GITHUB_SECRET=hooksecret node scripts/simulate-github.mjs   # needs server started with RETRACE_GITHUB_SECRET=hooksecret too
   RETRACE_DB=/tmp/demo.db node packages/mcp-server/dist/gdrive-cli.js replay packages/core/test-fixtures/drive-activity.json --project boxing-rpg
   ```
4. Stop the server (Ctrl-C). Your real ledger will live at `~/.retrace/retrace.db` (the default when `RETRACE_DB` is unset) — the demo db is throwaway.

**Tell me:** anything that looked wrong or confusing here. This is the cheapest moment to change UI.

---

## Stage 3 — Signing key (1 min)

```bash
node packages/mcp-server/dist/export-cli.js keygen
```
Creates `~/.retrace/signing-key.json` (keep it private) and prints the `kid`. Every export you or the local server produce is now signed. Run it again with `--print-private` later when you deploy the Worker (Stage 5) — you'll paste that value as a secret.

---

## Stage 4 — Hook up your Boxing RPG repo (10 min)

### 4a. Git commits → Retrace
```bash
cd <path to your boxing rpg repo>
node <abs path>/retrace/packages/mcp-server/dist/git-hook.js install --project boxing-rpg
node <abs path>/retrace/packages/mcp-server/dist/git-hook.js backfill      # imports existing history; safe to re-run
git add .retrace.json && git commit -m "Add Retrace config"
```
**Check:** `npm run serve` (in the retrace folder, no `RETRACE_DB`) → http://localhost:7777 → project `boxing-rpg` shows your commits, and the commit you just made appears automatically (the hook logged it).

### 4b. Claude Code / Claude Desktop → Retrace (the MCP server)
Add to `~/.claude.json` (Claude Code) or `claude_desktop_config.json` (Desktop) under `mcpServers`:
```json
"retrace": {
  "command": "node",
  "args": ["<abs path>/retrace/packages/mcp-server/dist/index.js"],
  "env": {
    "RETRACE_PROJECT": "boxing-rpg",
    "RETRACE_ACTOR": "claude-code",
    "RETRACE_ACTOR_MODEL": "claude-fable-5",
    "RETRACE_ON_BEHALF_OF": "jordansboxing@gmail.com"
  }
}
```
Restart Claude Code. Then add these two lines to the RPG repo's `CLAUDE.md` so the agent logs without being asked:
```
Provenance: at the start of each task call retrace_instruct with my request; after each edit/command/decision call retrace_log with caused_by (the instruction id), a one-sentence intent, and the artifact ids touched.
When committing, add trailers: Retrace-Actor: claude-code / Retrace-Model: <your model> / Retrace-Caused-By: <instruction event id>.
```
**Check:** in Claude Code type `/mcp` — `retrace` should be connected with 9 tools. Do one small real task; then refresh http://localhost:7777 → you should see the instruction (amber) followed by agent edits (blue) linked by "caused by".

---

## Stage 5 — Deploy the Cloudflare Worker (15 min) — unlocks GitHub, Google Drive, and remote mode

```bash
cd <abs path>/retrace/apps/worker
npx wrangler login                     # opens browser
npx wrangler secret put RETRACE_TOKEN          # paste a long random string; SAVE IT — it's your API password (owner token)
npx wrangler secret put RETRACE_CREDENTIALS    # optional, JSON array of per-actor tokens: [{"token":"<32+ chars>","actor":{"type":"agent","id":"claude-code","model":"claude-fable-5","on_behalf_of":"<your email>"}}]
                                               # give each agent its own pinned token as RETRACE_TOKEN in its MCP config — the Worker then stamps WHO, the agent can't; add "trust":"assert" only for the git hook / Drive forwarder
npx wrangler secret put RETRACE_SIGNING_KEY    # paste output of: node ../../packages/mcp-server/dist/export-cli.js keygen --print-private  (the JSON only)
npx wrangler secret put RETRACE_GITHUB_SECRET  # another random string; you'll reuse it in GitHub
npx wrangler deploy
```
The last line prints your URL, like `https://retrace-api.<you>.workers.dev`. The D1 database (`retrace-db`) is already created and migrated; `wrangler.toml` already points at it.

**Check:** open `<url>/api` → `{"ok":true,"auth":true,"signing":true}`. Open `<url>/?token=<RETRACE_TOKEN>` → the same UI, empty for now. `<url>/.well-known/retrace-pubkey` shows your public key.

Optional: set `RETRACE_ISSUER` (e.g. `SLC WIT' IT`) and `RETRACE_PUBLIC_URL` under `[vars]` in `wrangler.toml` and redeploy, so reports name you as issuer.

### Point local tools at the cloud (optional but recommended)
Add to the MCP `env` block from 4b and to your shell profile:
```
RETRACE_URL=https://retrace-api.<you>.workers.dev
RETRACE_TOKEN=<your token>
```
With those set, the MCP server, git hook, and CLIs write to the cloud ledger instead of `~/.retrace/retrace.db`. (Re-run `git-hook.js backfill` once to copy history up.) You can also put `url`/`token` in the repo's `.retrace.json` — but don't commit the token to a public repo; env is safer.

---

## Stage 6 — GitHub PRs (5 min)

```bash
node <abs path>/retrace/packages/mcp-server/dist/github-cli.js setup <owner>/<repo> --url https://retrace-api.<you>.workers.dev --project boxing-rpg
```
It prints the exact webhook settings — either paste them into GitHub → repo → Settings → Webhooks (Payload URL, content type `application/json`, secret = the `RETRACE_GITHUB_SECRET` value, events: Pull requests, Pull request reviews, Issue comments, Workflow runs) or run the printed `gh api` one-liner with `RETRACE_GITHUB_SECRET` exported.

Import existing PRs:
```bash
GITHUB_TOKEN=<a personal access token with repo read> RETRACE_URL=... RETRACE_TOKEN=... \
node <abs path>/retrace/packages/mcp-server/dist/github-cli.js backfill <owner>/<repo> --project boxing-rpg
```
**Check:** GitHub → Webhooks → Recent Deliveries shows a green ping. Open a test PR → it appears in the cloud UI within seconds. Put `Retrace-Caused-By: evt_…` (an instruction id from `retrace_instruct`) in a PR body and watch it link.

---

## Stage 7 — Google Docs / Drive (5 min)

Follow `adapters/google-apps-script/README.md`: new project at script.google.com → paste `Code.gs` → add services **Drive Activity API** and **Peopleapi** → Script properties `RETRACE_URL`, `RETRACE_TOKEN`, `RETRACE_PROJECT` (e.g. `slc-witit-gym` for business docs, or `boxing-rpg`), optionally `RETRACE_FOLDER` → run `setup` and authorize.

**Check:** the execution log says "backfilled N activities … polling every 5 min". Edit a doc, wait ~5–10 min, refresh the cloud UI.

---

## Stage 8 — Domain check (2 min)

At your registrar (Cloudflare Registrar is convenient since you're already there): check `retrace.app`, `retrace.dev`, `getretrace.com`, `retrace.io`. If the good ones are taken, tell me and we'll brainstorm — no code depends on the name.

---

## Stage 9 — Dogfood for a week

Just work on the RPG normally. Once a day glance at the timeline and the graph. Keep a note of: events that are missing, events that are noise, "why" chains that broke, anything a client couldn't understand in the report. Send me that list — that's the next build.

---

## If something goes wrong

- `npm test` fails → send me the output.
- Hook didn't log → run `node .../git-hook.js commit` in the repo and read the error; usually a path or Node version issue.
- Cloud UI shows nothing → check `<url>/api`; confirm you're using `?token=` or the header; check `wrangler tail` for live logs.
- Chain badge says BROKEN → don't panic; export first, then send me the export. That's the feature working.
- Anything else: paste the command and the error to me.
