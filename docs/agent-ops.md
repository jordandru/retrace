# Agent ops — environment rules (this laptop, this checkout, these harnesses)

**Status:** v1, 2026-09-12. Author claude-code. Binding on the seats that share this environment and on
no one else. Every rule here is a workaround for something the product or a harness does not yet do,
and each ends with **→ unnecessary when:** the change that would retire it. Read that way, this file is
the backlog for "a stranger can install Retrace and keep it honest" (Grok's assessment, 2026-09-12).
The provenance rules themselves are `docs/agent-rules.md`.

## Layout

- One clone: `/home/jordandrumiler/provenance/retrace` (WSL), Orca's primary worktree. The Windows
  clone was removed 2026-08-30 after the two drifted. The coordinator merges from
  `/home/jordandrumiler/provenance/retrace-main`, a detached worktree, so the primary checkout alone
  owns `main`.
- Packages: `@retrace-dev/core` and `@retrace-dev/cli`; the cli workspace folder is still
  `packages/mcp-server`.
- Seats sharing this checkout: claude-code (coordinator), codex, grok, github-copilot, cursor-agent.
  NOOA (auditor) runs from `~/nooa-retrace` and never touches the checkout. Gemini was retired
  2026-09-10; `agent/gemini` stays bound to its principal under never-reissue.

## Worktrees and the shared checkout

1. Work in your own Orca worktree, one branch per task, removed after merge. Run
   `git rev-parse --short HEAD` before starting. Never pull, reset, or check out a tree that carries
   another seat's uncommitted changes.
   → unnecessary when: the primary checkout is reserved for the coordinator and every seat starts from
   `orca worktree create`.
2. Commit only your own paths (`git commit --only <paths>`); never `git commit -a` or `git add -A`.
   Uncommitted work in a shared tree is swept into whoever commits next (bfe87c3, corrected c375ed4).
   → unnecessary when: rule 1 holds, or the `misattributed` reconcile finding becomes a hard gate.
3. Git runs hooks from the common `.git/hooks`, so every worktree's commits are sealed by the **primary
   checkout's** built `dist`. Never build or test in the primary checkout mid-session; rebuild its dist
   only after a hook change merges, and only when every pane is idle (aeab15b, 2026-09-09).
   → unnecessary when: the hook script runs the packed CLI pinned by version (`npx`) instead of a
   checkout's dist.
4. A fresh worktree cannot run the retrace MCP server until it is built: `.cursor/mcp.json` and the
   other harness configs launch `node packages/mcp-server/dist/index.js` relative to the worktree. Run
   `npm ci && npm run build` there before starting an agent that needs the tools (D1 pane, 2026-09-11,
   twice).
   → unnecessary when: harness MCP configs launch the packed CLI via `npx` pinned to a version.
5. Verify a pull-request head in an isolated worktree with `dist` cleared before building; a reused
   worktree carries the previous PR's compiled tests and reports false failures (2026-09-10).
   → unnecessary when: `npm test` cleans stale compiled tests itself.

## MCP servers

6. If the retrace tools vanish mid-session, the server **process** died: restart the session
   (`claude --continue`; Cursor: a fresh `cursor-agent`). A running session does not respawn a dead
   project-scoped server, the `/mcp` reconnect does not, and Cursor's `agent mcp enable` answers
   "already enabled" without respawning. Do nothing that needs logging until `retrace_instruct`
   succeeds.
   → unnecessary when: harnesses respawn dead stdio servers, or the Worker's Streamable HTTP `/mcp`
   endpoint replaces local processes (queued after credentials leave the Worker secret).
7. A running MCP server keeps the core it loaded at spawn. After `packages/mcp-server/dist` changes,
   restart the server before trusting new behaviour.
   → unnecessary when: same as 6.
8. Cursor Agent CLI does not interpolate `${workspaceFolder}` / `${userHome}` and does not load
   `envFile`, so `.cursor/mcp.json` launches via `bash -c` sourcing `~/.retrace/cursor.env` (token
   only). Tools can list while `RETRACE_TOKEN` is missing — that shows up as Worker 401.
   → unnecessary when: same as 4.
9. Copilot: the GitHub.com cloud coding agent cannot use stdio MCP; dogfood is Copilot CLI
   (`~/.copilot/mcp-config.json`) and VS Code Chat via the **user** MCP config — never a project
   `.vscode/mcp.json` (a renamed server key is still a label, and Cursor can start a workspace MCP
   file). CLI and Chat share the one `github-copilot` pin; never mint a second Copilot token. On HTTP
   402 `quota_exceeded`: stop; never borrow another seat's `RETRACE_TOKEN`.
   → unnecessary when: same as 6.

## Environment, tests, merges

10. Test-only environment — a scratch `RETRACE_DB`, empty `RETRACE_URL` / `RETRACE_TOKEN` — goes
    **inline** on the test command (`RETRACE_DB=… RETRACE_URL= RETRACE_TOKEN= npm test`), never
    exported in a shell that also commits or merges: the hook inherits the shell and sealed three
    merges into a scratch database on 2026-09-10.
    → unnecessary when: the hook refuses to seal to a local store while `.retrace.json` names a remote.
11. Doctor can flake on a WSL2 fetch timeout: one run, retried up to three times to READY
    (agent-rules 8).
    → unnecessary when: doctor retries its own Worker requests.
12. Merges are the coordinator's, from `retrace-main` detached at `origin/main`: `--no-ff`, the three
    trailers on the merge commit, the hook seal verified after each merge, tests at the merged tip,
    doctor READY, then push, then the webhook's second seal confirmed. A trailer-less merge seals as
    Jordan with `surface=agent`.
    → unnecessary when: the authenticated commit assertion (design v3) derives the merge actor from the
    session credential.

## Credentials and keys

13. Producer signing: when a seat's private JWK exists, set `RETRACE_PRODUCER_KEY_FILE` on that seat's
    MCP server, mode 0600. A private key never goes into the Worker secret. — custody rule; stays.
14. Never read, print, copy, or commit credential files: `~/.retrace/*.env`,
    `~/.retrace/worker-credentials*.json`, `~/.copilot/mcp-config.json`, or any token. — stays.
15. Registered credentials live in the Worker secrets `RETRACE_CREDENTIALS` and
    `RETRACE_CREDENTIALS_EXTRA` (a few-KB ceiling), mirrored in
    `~/.retrace/worker-credentials-extra.json`; minting and retiring is `retrace-admin`, owner only.
    → unnecessary when: credentials move out of the Worker secret (assessment priority 3).

## Coordination

16. One coordinator at a time dispatches builders and merges. Other seats' task boards are their own
    tracking — read by the coordinator, not duplicated. A seat that finds itself coordinating in
    parallel asks the coordinator to stand by and waits for the acknowledgement (2026-09-10, 09-12).
17. Reviewer effort is routed and recorded: before a review the coordinator logs a routing event
    (`method.tool = "routing"`, target agent/model/effort, the rule that fired); the review cites it
    (agent-rules 11). Cursor pins effort inside the model id
    (`cursor-agent --model gpt-5.6-sol-high`). An explicit Orca `terminal create --command` bypasses the
    launcher's `--yolo`; pass it explicitly or every shell command stalls on an approval.
