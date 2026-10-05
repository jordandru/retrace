# Retrace

**A flight recorder for AI coding agents.** Every event records **who** (person or agent, server-stamped) did **what**, **when**, **where**, **why** — a `caused_by` chain back to the human instruction — and **how**, sealed in a tamper-evident hash chain that anyone can verify offline.

It exists because a commit in this repo named the wrong AI agent as its author. Six agents share one checkout; Claude Code left ~300 lines uncommitted, Codex was told "re-integrate" and committed them under its own name, and `git blame` had no way to know. Retrace's ledger did — see example 1 below. Every commit of building this tool is recorded in its own ledger, and the [2026-09-03 snapshot](https://github.com/jordandru/retrace/releases/tag/ledger-2026-09-03) of it — 1,585 events, seq 0–1584 — is public and verifies offline. Live browsing of the ledger beyond that snapshot is paused until export redaction is designed and built ([#67](https://github.com/jordandru/retrace/issues/67)).

## Start here

- **[Retrace by example](docs/examples.md)** — eight real problems from this repo's ledger and what Retrace shows for each. Three minutes.
- **[Full reference](docs/reference.md)** — every adapter, the cloud Worker, team hosting, event shape, status and roadmap.
- **[SETUP-GUIDE](SETUP-GUIDE.md)** — the guided walkthrough: clone → MCP → Worker → GitHub/Drive.
- **Live ledger:** read-only public browsing is paused until export redaction is designed and built ([#67](https://github.com/jordandru/retrace/issues/67)); the [pre-verified snapshot](https://github.com/jordandru/retrace/releases/tag/ledger-2026-09-03) (bundle + checkpoints + witnesses + keys) is public and verifies offline against the published key.

## What you get

- **Server-stamped identity.** On a pinned credential the Worker, not the agent, writes the actor; an `assert`-trust credential (the git hook) records the actor the body names, limited to its allowed list; and every event carries which kind sealed it (`sealed_by`). Who holds a credential is custody, not identity: ten events in the public snapshot (seq 178–194) carry `claude-code` although Grok was at the keyboard of that session (issue #74, item 6).
- **Causality.** Agent events link to the human instruction behind them: in this repository's own ledger, 98.3% of eligible events root in a human instruction (`retrace_status`, 2026-10-05). On the MCP path (`retrace_log`) a dangling link is rejected at write time; every other write path (REST `POST /events`, the git hook, the GitHub and Drive adapters) keeps the claimed link and seals it tagged `caused_by:unverified` with the reason (`missing`, `wrong_project` or `not_older`), so a bad link is never silently stored.
- **Tamper-evident history.** Every setup gets a hash chain. Hosted setups with the push webhook also get hourly Rekor-witnessed checkpoints and two commit seals (git hook + GitHub push webhook); the local quick start seals each commit once with the git hook.
- **Producer signatures.** Each agent signs its events with an Ed25519 key the server never holds; the Worker verifies and stamps the verdict.
- **Reconciliation + CI gate.** A changed file with no logged edit is `uncovered`; a file whose only logged edits are another agent's is `misattributed`; `retrace doctor --gate` fails the commit.
- **Works beyond the six harnesses.** [NOOA](https://github.com/NVIDIA-NeMo/labs-OO-Agents), NVIDIA Labs’ Object-Oriented Agents research preview, logs producer-signed provenance to the live ledger through the same MCP tools ([public share](https://retrace-api.slcwitit.workers.dev/s/sh_bd2ab621ad2454ceb9b9fdc7), verifies offline 4/4). `retrace-admin add-agent --harness nooa` onboards it.
- **Proof you can hand to a skeptic.** Hosted setups produce signed exports verifiable against a separately trusted published key. Local quick-start exports are self-attested and require an explicit `--allow-self-attested`; printable reports and read-only shares work in both modes.

## Quick start (local, no cloud account)

**Your own repo, no checkout of this one.** Two commands from the published package, run inside the repository you want recorded:

```bash
npx -y -p @retrace-dev/cli@0.3.0 retrace-git install --project <project>   # writes .retrace.json and the post-commit / post-merge hooks
npx -y -p @retrace-dev/cli@0.3.0 retrace doctor                            # READY when the ledger, hooks and project agree
```

Then give your agent the MCP server from the same package — Claude Code shown (`~/.claude.json` or the repository's `.mcp.json`):

```json
{
  "mcpServers": {
    "retrace": {
      "command": "npx",
      "args": ["-y", "-p", "@retrace-dev/cli@0.3.0", "retrace-mcp"],
      "env": {
        "RETRACE_PROJECT": "<project>",
        "RETRACE_ACTOR": "claude-code",
        "RETRACE_ON_BEHALF_OF": "<your email>",
        "RETRACE_PRODUCER_KEY_FILE": "/home/<you>/.retrace/producer-keys/claude-code.jwk"
      }
    }
  }
}
```

The producer key file is the same one described under the contributor path below; the agent still has to be told to call the tools (see [SETUP-GUIDE](SETUP-GUIDE.md)). This block answers [#83](https://github.com/jordandru/retrace/issues/83).

**Contributing to this repository** (a clone):

```bash
npm install && npm run build && npm test
npm run serve            # local timeline at http://127.0.0.1:7777 (prints a one-time token)
```

Give your agent the MCP server — Claude Code shown (`~/.claude.json` or the project's `.mcp.json`); other harnesses use the same block with their own actor and config file, listed in the [reference](docs/reference.md#quick-start-local-no-cloud-needed):

```json
{
  "mcpServers": {
    "retrace": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/retrace/packages/mcp-server/dist/index.js"],
      "env": {
        "RETRACE_PROJECT": "retrace",
        "RETRACE_ACTOR": "claude-code",
        "RETRACE_ON_BEHALF_OF": "<your email>",
        "RETRACE_PRODUCER_KEY_FILE": "/home/<you>/.retrace/producer-keys/claude-code.jwk"
      }
    }
  }
}
```

Leave `RETRACE_ACTOR_MODEL` unset so the agent reports the model it actually ran. `RETRACE_PRODUCER_KEY_FILE` is the agent's private signing key (mode 0600, minted by `retrace-export producer-keygen`); only the public half ever goes on a credential. Locally, events land in `~/.retrace/retrace.db`; for the hosted Worker add `RETRACE_URL` and a scoped `RETRACE_TOKEN` (never another agent's).

Export and verify a local ledger. Local exports are signed with a locally generated key, so verification labels them
self-attested and requires explicit acceptance:

```bash
npx -p @retrace-dev/cli retrace-export export <project> --out retrace.json
npx -p @retrace-dev/cli retrace-export verify retrace.json --allow-self-attested
```

For a hosted ledger, pass a separately trusted issuer key. This repository's hosted ledger is one example:

```bash
npx -p @retrace-dev/cli retrace-export verify retrace.json \
  --pubkey https://retrace-api.slcwitit.workers.dev/.well-known/retrace-pubkey
```

Commits, GitHub PRs and Google Drive become events through adapters; the hosted mode is a Cloudflare Worker + D1 with per-team scoped credentials. All of it is in the [reference](docs/reference.md): [git adapter](docs/reference.md#git-adapter--commits-become-events-automatically) · [proof & exports](docs/reference.md#prove--signed-exports-printable-reports-share-links) · [cloud mode](docs/reference.md#cloud-mode-cloudflare-worker--d1) · [hosting teams](docs/reference.md#hosting-teams-on-one-worker) · [event shape](docs/reference.md#event-shape-short) · [status & roadmap](docs/reference.md#status--next).

## What it deliberately does not do

- **Instruction roots are the agent's testimony.** An `instructed` event records what the agent says the human said; the pinned credential proves which seat sealed it and when, not that the quote is faithful ([owner-protocol §7](docs/owner-protocol.md)).
- It is **tamper-evident, not tamper-proof** — between hourly checkpoints there is a window in which an operator could rewrite; after a checkpoint, rewriting means rewriting Rekor.
- **Model names are asserted** by the agent and labeled as such; the identity and time are what's cryptographically bound. Agent events missing a model are counted as declared none (`model_source: none`) or no source recorded (legacy events with no `model_source` field).
- **Coverage is what producers log** — complete for commits (enforced by the gate), not keystrokes, prompts, the harness's system prompt, or the model's reasoning.
- **A wrong actor stays sealed.** Tier 1 human-sealed attribution amendments shipped in 0.1.7; the first real one is ledger #2543 (`evt_51c4a8ad2b3b450788ebc8f7b69969fe`): commit `5d7290f`, recorded as `codex`, with seven files under `packages/mcp-server` amended to `cursor-agent` on stamped evidence #1647/#1648. The recorded actor stays visible.
- **No line-level attribution** ("GPT wrote this function") — not a feature, not planned.

## Layout

```
packages/core        schema (zod), hash chain, verify, "why" chain, renderers   — runs in Node, Workers, browsers
packages/mcp-server  MCP server (stdio) + `retrace-serve` local UI/API server + CLIs (@retrace-dev/cli)
packages/core/ui     timeline UI (single self-contained HTML, embedded into core at build)
apps/worker          Cloudflare Worker + D1 — REST API + serves the same UI at /
```

Packages: `@retrace-dev/core` (library) and `@retrace-dev/cli`. Self-host free; hosted Team plan is how this becomes a business. Licensed under the [Apache License 2.0](LICENSE).
