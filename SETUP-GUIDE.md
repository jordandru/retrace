# Retrace — setup walkthrough (v0.1.2)

Work top to bottom. Each stage ends with a check. Commands assume macOS/Linux or **Ubuntu WSL**. Fill in `<angle brackets>`.

This checkout already has a live Worker (`retrace-api.slcwitit.workers.dev`, D1 `retrace-db`) and pinned credentials for Claude, Codex, Gemini, Grok, and GitHub Copilot. The GitHub repo is **public**. Stages 1–4 still matter on a new machine; 5 is already done here.

Published packages: [`@retrace-dev/core`](https://www.npmjs.com/package/@retrace-dev/core) and [`@retrace-dev/cli`](https://www.npmjs.com/package/@retrace-dev/cli) (Apache-2.0). The CLI lives in `packages/mcp-server` in this repo. The Cloudflare Worker is **not** on npm.

The `retrace` binary name collides with Android’s R8 `retrace`. Prefer:

```bash
npm exec --package=@retrace-dev/cli -- retrace doctor
```

or a global `@retrace-dev/cli` install, not whatever `retrace` happens to be first on `PATH`.

---

## Stage 0 — Prerequisites

- **Node.js 22.13+** (`node -v`) — local SQLite needs ≥ 22.13
- **git**
- **Cloudflare account** (free tier is enough) for cloud mode
- Optional: `gh`, and at least one MCP client (Claude Code, Gemini CLI, Grok Build TUI, Codex, GitHub Copilot CLI)

---

## Stage 1 — Clone, build, test

```bash
git clone https://github.com/jordandru/retrace.git
cd retrace
npm install
npm run build
npm test
```

**Check:** both workspaces exit 0 (`@retrace-dev/core` and `@retrace-dev/cli`). SQLite “experimental feature” warnings are normal.

Note the absolute path for MCP configs:

```bash
pwd
```

Consumers who only need the CLI can skip the clone and use `npx @retrace-dev/cli` / `npm i -g @retrace-dev/cli@0.1.2`. Bundles sealed after 2026-08-30 need verify >= 0.1.2.

---

## Stage 2 — Local timeline (no cloud)

```bash
RETRACE_DB=/tmp/demo.db node scripts/seed-demo.mjs
RETRACE_DB=/tmp/demo.db npm run serve
```

Open http://localhost:7777.

**Check:** chain-intact badge, a short Boxing-RPG demo timeline. Click an event → WHO · WHAT · WHEN · WHERE · WHY · HOW. Toggle **Graph**. **Report** / **Export** / **Share** (`/s/…`, open in a private window).

Optional, same `RETRACE_DB`, while the server runs:

```bash
RETRACE_DB=/tmp/demo.db RETRACE_GITHUB_SECRET=hooksecret node scripts/simulate-github.mjs
# start serve with RETRACE_GITHUB_SECRET=hooksecret too
RETRACE_DB=/tmp/demo.db node packages/mcp-server/dist/gdrive-cli.js replay \
  packages/core/test-fixtures/drive-activity.json --project boxing-rpg
```

Stop the server (Ctrl-C). Throw away `/tmp/demo.db`. The real local ledger is `~/.retrace/retrace.db` when `RETRACE_DB` is unset.

---

## Stage 3 — Signing key

```bash
node packages/mcp-server/dist/export-cli.js keygen
# or: npx retrace-export keygen   (from @retrace-dev/cli)
```

Writes `~/.retrace/signing-key.json` (private). Prints `kid`. `--print-private` later for the Worker secret (Stage 5).

---

## Stage 4 — Wire a git repo

### 4a. Commits → ledger

```bash
cd <your-repo>
node <abs path>/retrace/packages/mcp-server/dist/git-hook.js install --project <project>
node <abs path>/retrace/packages/mcp-server/dist/git-hook.js backfill   # optional, idempotent
```

Commit `.retrace.json` (name only — no owner token). For a remote ledger, set `"credential": "retrace-git"` and keep the hook token in `~/.retrace/worker-credentials.json`.

**Check:**

```bash
npm exec --package=@retrace-dev/cli -- retrace doctor
```

READY. Failures name the repair. Hook misses go in `.git/retrace-hook.log`; re-log with `retrace-git commit <sha>`.

Without `.retrace.json`, `retrace-git` **refuses** a remote write so a stray `RETRACE_URL` cannot create junk projects on the live Worker.

Agent commits need trailers `Retrace-Actor: <id>`, `Retrace-Model: <model>`, `Retrace-Caused-By: evt_…`. Do not log `committed` through MCP.

### 4b. MCP — one pinned identity per harness

Each client gets its **own** `RETRACE_TOKEN` (pinned credential). Reusing Claude’s token seals Grok/Copilot/… as `claude-code`.

| Harness | `RETRACE_ACTOR` | Config |
|---|---|---|
| Claude Code / Desktop | `claude-code` | `~/.claude.json` / `claude_desktop_config.json` |
| Gemini CLI | `gemini` | `.gemini/settings.json` |
| Grok Build TUI | `grok` | `~/.grok/config.toml` |
| Codex | `codex` | Codex MCP + `AGENTS.md` |
| GitHub Copilot CLI | `github-copilot` | `~/.copilot/mcp-config.json` |

Claude example (`args` = absolute `packages/mcp-server/dist/index.js`):

```json
"retrace": {
  "command": "node",
  "args": ["<abs path>/retrace/packages/mcp-server/dist/index.js"],
  "env": {
    "RETRACE_PROJECT": "<project>",
    "RETRACE_ACTOR": "claude-code",
    "RETRACE_ON_BEHALF_OF": "<your email>",
    "RETRACE_URL": "https://retrace-api.<you>.workers.dev",
    "RETRACE_TOKEN": "<pinned claude-code token, not the owner token>"
  }
}
```

Leave `RETRACE_ACTOR_MODEL` unset so the agent reports the model it actually ran. After `dist/` changes, **respawn** the MCP server (it keeps old `dist` and session id until restart).

Per-harness notes: `CLAUDE.md`, `GEMINI.md`, `GROK.md`, `AGENTS.md` (Codex), `.github/copilot-instructions.md`. Grok also loads `.grok/rules/retrace.md` (it still auto-loads `CLAUDE.md` via compatibility).

**Check:** client shows Retrace tools (10). One real `retrace_instruct` → timeline shows an amber instruction, then blue agent events with `caused_by`.

This repo’s project name is `retrace` (see `.retrace.json`). Boxing-RPG is a separate project.

### 4c. CI gate

`retrace doctor` is a local preflight (hook installed, credential file). CI has neither. Use:

```bash
node packages/mcp-server/dist/doctor.js doctor --gate
# env: RETRACE_URL, RETRACE_TOKEN
```

`--gate` skips the hook and `~/.retrace` file. It **fails** if HEAD is not in the ledger. If HEAD is an **agent** commit (`Retrace-Actor` or agent `Co-Authored-By`), it also fails unless that event walks `caused_by` to a human `instructed` root. Human commits pass without a trailer.

This repo’s workflow is `.github/workflows/retrace-gate.yml`. GitHub secret `RETRACE_CI_TOKEN` is a Worker **assert** credential `system/retrace-ci` with empty `allowed_actors` (GET works; POST cannot seal an actor). It is not the owner token and not the git-hook token. Checkout uses the PR **head** SHA, not GitHub’s merge commit (that SHA is never in the ledger). Fork PRs do not receive the secret.

Ruleset **main gate** (active, default branch) requires the Actions check named `gate` and blocks force-pushes. Repository admins are **Exempt**, so `git push origin main` still works for the owner; everyone else needs a green `gate` to update `main`. There is no required-pull-request rule.

Omitting trailers still looks human and bypasses the instruct-root check. Do not skip `Retrace-Actor` / `Retrace-Caused-By` to go green.

---

## Stage 5 — Cloudflare Worker + D1

Already applied in this checkout (`apps/worker/wrangler.toml` → `retrace-db`). On a new account:

```bash
cd apps/worker
npx wrangler login
npx wrangler secret put RETRACE_TOKEN          # owner token: UI, DELETE, share
npx wrangler secret put RETRACE_CREDENTIALS    # JSON array of per-actor credentials
npx wrangler secret put RETRACE_SIGNING_KEY    # private JWK from keygen --print-private
npx wrangler secret put RETRACE_GITHUB_SECRET
npx wrangler deploy
npm run check-deploy                           # from repo root; no token, no writes
```

`RETRACE_CREDENTIALS`: pinned agents (Worker stamps WHO) plus `trust: "assert"` for `retrace-git` / Drive, with `allowed_actors`. After changing credentials, `wrangler secret put RETRACE_CREDENTIALS` again from `~/.retrace/worker-credentials.json`.

**Check:** `https://<url>/api` → `ok`, `auth`, `signing`. UI at `/?token=<owner>`. `/.well-known/retrace-pubkey` for exports.

Set `RETRACE_OWNER` under `[vars]` so DELETE is audited as you, not `system/worker`.

MCP / hook / CLI: `RETRACE_URL` + the **scoped** token, not the owner token on the git hook. npm publish to the public registry uses npm 2FA (passkey/web), not `RETRACE_TOKEN`.

---

## Stage 6 — GitHub PRs

```bash
node packages/mcp-server/dist/github-cli.js setup <owner>/<repo> \
  --url https://retrace-api.<you>.workers.dev --project <project>
```

Webhook: `POST /hooks/github?project=<name>`, secret = `RETRACE_GITHUB_SECRET`, events: PRs, reviews, issue comments, workflow runs.

```bash
GITHUB_TOKEN=<repo-read> RETRACE_URL=... RETRACE_TOKEN=... \
node packages/mcp-server/dist/github-cli.js backfill <owner>/<repo> --project <project>
```

**Check:** GitHub → Recent Deliveries green. A test PR appears in the UI. `Retrace-Caused-By: evt_…` in the PR body links reviews to the instruction.

---

## Stage 7 — Google Docs / Drive

This checkout already has a folder-scoped Apps Script (`retrace-gdrive`) on project **`retrace`**. The script token is the **gdrive-forwarder** assert credential (not the owner token, not `retrace-ci`). Drive Activity does not send document body; Retrace does not store Doc bytes.

Do **not** re-run `setup` here — that would backfill again. Updating `Code.gs` in the live project is enough.

### 7a. First-time (a new account)

`adapters/google-apps-script/README.md`: paste `Code.gs`, enable Drive Activity + People, properties `RETRACE_URL` / `RETRACE_TOKEN` / `RETRACE_PROJECT` (and `RETRACE_FOLDER` to stay folder-scoped). Run `setup`.

**Check:** execution log backfills, then polls ~5 min. An edit shows up in the cloud UI.

### 7b. Join new Drive edits to the current task (`caused_by`)

New forwarded events are roots unless you pass a parent at ingest time. Historical roots stay roots (`retrace_amend` / `attest_causal_root` can qualify one event after the fact — do not batch-amend).

When a task starts:

1. Call `retrace_instruct` and copy the instruction event id (`evt_…`).
2. Apps Script → **Project Settings → Script properties** → set `RETRACE_CAUSED_BY` to that id.
3. If the live `Code.gs` is older than this repo, paste `adapters/google-apps-script/Code.gs` over it. Do **not** run `setup` again.
4. Edit a Doc in the watched folder, wait a minute (Drive Activity lags), run **`testOnce`**. Already-forwarded activities **dedupe** — only a new edit becomes a new event.

When the task is done, **clear** `RETRACE_CAUSED_BY` (delete the property or set it empty) so later edits are not chained to a finished instruct.

**Check:** the new `gdoc:` event in the cloud UI shows `caused_by` → the instruct. Empty `RETRACE_CAUSED_BY` is today's behavior (the edit is a root). The Worker that receives `POST /hooks/gdrive` must be running this mapper; deploy it if the live Worker is older.

---

## If something goes wrong

| Symptom | What to do |
|---|---|
| `npm test` fails | Full TAP output |
| Hook didn’t log | `.git/retrace-hook.log`; `retrace-git commit <sha>` |
| `retrace doctor` NOT READY | Follow the named repair (schema deploy, allow-list, missing `.retrace.json`) |
| `retrace` = Android R8 | Use `npm exec --package=@retrace-dev/cli -- retrace` |
| Cloud UI empty | `/api`, `?token=`, `wrangler tail` |
| Badge BROKEN | Export first; that’s the detector working |
| Agent events sealed as the wrong WHO | That client reused another pin; give it its own `RETRACE_TOKEN` and respawn MCP |
| npm publish `EOTP` / `BROWSER` | Passkey is web-only; `export BROWSER='/mnt/c/Windows/System32/cmd.exe /c start'` in WSL, one package at a time |

---

## What this repo is not asking you to do next

Cursor is half-wired in code (`CLIENT_SYSTEM` / git families) and **not** on the git allow-list. Don’t mint a Cursor credential until a Cursor window is actually on this folder. Copilot CLI is pinned; if quota is exhausted, skip that tab until GitHub resets it.

Do not become C2PA, a trace viewer, or an identity provider. Do not add connectors, a sixth agent, an AI-BOM, or a compliance-deadline pitch while completeness (omission detection) and attribution (trailer-omit looks human; Drive `RETRACE_CAUSED_BY` is a global operator flag, not task evidence) are still weak. Do not re-run Apps Script `setup`.
