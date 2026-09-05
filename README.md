# Retrace

**A flight recorder for AI coding agents.** Every event records **who** (person or agent, server-stamped) did **what**, **when**, **where**, **why** — a `caused_by` chain back to the human instruction — and **how**, sealed in a tamper-evident hash chain that anyone can verify offline.

It exists because a commit in this repo named the wrong AI agent as its author. Six agents share one checkout; Claude Code left ~300 lines uncommitted, Codex was told "re-integrate" and committed them under its own name, and `git blame` had no way to know. Retrace's ledger did — see example 1 below. Every commit of building this tool is in its own public ledger.

## Start here

- **[Retrace by example](docs/examples.md)** — six real problems from this repo's ledger and what Retrace shows for each. Three minutes.
- **[Full reference](docs/reference.md)** — every adapter, the cloud Worker, team hosting, event shape, status and roadmap.
- **[SETUP-GUIDE](SETUP-GUIDE.md)** — the guided walkthrough: clone → MCP → Worker → GitHub/Drive.
- **Live ledger:** [browse](https://retrace-api.slcwitit.workers.dev/s/sh_ea81439e010abb1c0ec7167c) · [pre-verified snapshot](https://github.com/jordandru/retrace/releases/tag/ledger-2026-09-03) (bundle + checkpoints + witnesses + keys).

## What you get

- **Server-stamped identity.** A pinned credential decides the actor; agents cannot impersonate each other.
- **Causality.** Every agent event links to the human instruction behind it; a dangling link is rejected at write time, never silently stored.
- **Tamper-evident history.** Hash chain, hourly checkpoints witnessed in Sigstore's Rekor transparency log, and every commit sealed twice (git hook + GitHub push webhook).
- **Producer signatures.** Each agent signs its events with an Ed25519 key the server never holds; the Worker verifies and stamps the verdict.
- **Reconciliation + CI gate.** A changed file with no logged edit is `uncovered`; a file whose only logged edits are another agent's is `misattributed`; `retrace doctor --gate` fails the commit.
- **Works beyond the six harnesses.** [NOOA](https://github.com/NVIDIA-NeMo/labs-OO-Agents), NVIDIA Labs’ Object-Oriented Agents research preview, logs producer-signed provenance to the live ledger through the same MCP tools ([public share](https://retrace-api.slcwitit.workers.dev/s/sh_bd2ab621ad2454ceb9b9fdc7), verifies offline 4/4). `retrace-admin add-agent --harness nooa` onboards it.
- **Proof you can hand to a skeptic.** Signed exports, printable reports and read-only share links, all verifiable offline against the published key.

## Quick start (local, no cloud account)

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

Verify a ledger without trusting anyone's dashboard:

```bash
npx -y --package=@retrace-dev/cli retrace-export verify retrace.json \
  --pubkey https://retrace-api.slcwitit.workers.dev/.well-known/retrace-pubkey
```

Commits, GitHub PRs and Google Drive become events through adapters; the hosted mode is a Cloudflare Worker + D1 with per-team scoped credentials. All of it is in the [reference](docs/reference.md): [git adapter](docs/reference.md#git-adapter--commits-become-events-automatically) · [proof & exports](docs/reference.md#prove--signed-exports-printable-reports-share-links) · [cloud mode](docs/reference.md#cloud-mode-cloudflare-worker--d1) · [hosting teams](docs/reference.md#hosting-teams-on-one-worker) · [event shape](docs/reference.md#event-shape-short) · [status & roadmap](docs/reference.md#status--next).

## What it deliberately does not do

- It is **tamper-evident, not tamper-proof** — between hourly checkpoints there is a window in which an operator could rewrite; after a checkpoint, rewriting means rewriting Rekor.
- **Model names are asserted** by the agent and labeled as such; the identity and time are what's cryptographically bound.
- **Coverage is what producers log** — complete for commits (enforced by the gate), not keystrokes, prompts, the harness's system prompt, or the model's reasoning.
- **A wrong actor stays sealed.** Corrections are appended, never edited; a first-class attribution amendment is not built yet.
- **No line-level attribution** ("GPT wrote this function") — not a feature, not planned.

## Layout

```
packages/core        schema (zod), hash chain, verify, "why" chain, renderers   — runs in Node, Workers, browsers
packages/mcp-server  MCP server (stdio) + `retrace-serve` local UI/API server + CLIs (@retrace-dev/cli)
packages/core/ui     timeline UI (single self-contained HTML, embedded into core at build)
apps/worker          Cloudflare Worker + D1 — REST API + serves the same UI at /
```

Packages: `@retrace-dev/core` (library) and `@retrace-dev/cli`. Self-host free; hosted Team plan is how this becomes a business. Licensed under the [Apache License 2.0](LICENSE).
