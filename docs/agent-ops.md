# Agent ops — environment rules (this laptop, this checkout, these harnesses)

**Status:** v1, 2026-09-12. Author claude-code. Binding on the seats that share this environment and on
no one else. Every rule here is a workaround for something the product or a harness does not yet do,
and each ends with **→ unnecessary when:** the change that would retire it. Rules that are not
workarounds — key and token custody — are provenance rules and live in `docs/agent-rules.md` (rule 13). Read that way, this file is
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
   → unnecessary when: non-coordinator credentials cannot write the primary tree at all — a bare
   primary, or Orca refusing agent sessions on it — rather than a convention that we start from
   `orca worktree create`.
2. Commit only your own paths (`git commit --only <paths>`); never `git commit -a` or `git add -A`.
   Uncommitted work in a shared tree is swept into whoever commits next (bfe87c3, corrected c375ed4).
   → unnecessary when: the `misattributed` reconcile finding becomes a hard gate — it does not prevent
   the sweep, it makes it cost a red build instead of a correction after the fact.
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
   → unnecessary when: the Worker's Streamable HTTP `/mcp` endpoint replaces local processes for every
   seat — which waits on 13 (credentials out of the Worker secret). Harnesses respawning dead stdio
   servers would also retire it, but that is a vendor change, not ours.
7. A running MCP server keeps the core it loaded at spawn. After `packages/mcp-server/dist` changes,
   restart the server before trusting new behaviour.
   → unnecessary when: 4 (the packed CLI is the server, so a checkout's dist is irrelevant) or 6.
8. Cursor Agent CLI does not interpolate `${workspaceFolder}` / `${userHome}` and does not load
   `envFile`, so `.cursor/mcp.json` launches via `bash -c` sourcing `~/.retrace/cursor.env` (token
   only). Tools can list while `RETRACE_TOKEN` is missing — that shows up as Worker 401.
   → unnecessary when: 4 **and** credentials no longer come from process env (13), or Cursor fixes
   `envFile` — the packed CLI alone is necessary, not sufficient.
9. Copilot: the GitHub.com cloud coding agent cannot use stdio MCP; dogfood is Copilot CLI
   (`~/.copilot/mcp-config.json`) and VS Code Chat via the **user** MCP config — never a project
   `.vscode/mcp.json` (a renamed server key is still a label, and Cursor can start a workspace MCP
   file). CLI and Chat share the one `github-copilot` pin; never mint a second Copilot token. What to do
   on HTTP 402 `quota_exceeded` — stop, never borrow another seat's token — is custody, agent-rules 13.
   → unnecessary when: 6 (HTTP `/mcp`) — for the stdio half only; the custody half stays.
## Environment, tests, merges

10. Test-only environment — a scratch `RETRACE_DB`, empty `RETRACE_URL` / `RETRACE_TOKEN` — goes
    **inline** on the test command (`RETRACE_DB=… RETRACE_URL= RETRACE_TOKEN= npm test`), never
    exported in a shell that also commits or merges: the hook inherits the shell and sealed three
    merges into a scratch database on 2026-09-10.
    → unnecessary when: the hook refuses to seal to a local store while `.retrace.json` names a remote.
11. Doctor can flake on a WSL2 fetch timeout: one run, retried up to three times to READY
    (agent-rules 8).
    → unnecessary when: doctor retries its own Worker requests.
12. Merges run from `retrace-main`, a worktree detached at `origin/main`, so the primary checkout
    never carries a merge in progress: `--no-ff`, hook seal verified after each merge, tests at the
    merged tip, doctor READY, push, then the webhook's second seal confirmed. Who merges and that only
    merge commits land directly on main is agent-rules 12 and `docs/team-roles.md`, not this file. A
    trailer-less merge seals as Jordan with `surface=agent`.
    → unnecessary when: the authenticated commit assertion (design v3) derives the merge actor from
    the session credential — that retires the trailer hazard; the detached-worktree mechanics retire
    with 1.
## Credentials and keys

13. Registered credentials live in the Worker secrets `RETRACE_CREDENTIALS` and
    `RETRACE_CREDENTIALS_EXTRA` (a few-KB ceiling), mirrored in
    `~/.retrace/worker-credentials-extra.json`; minting and retiring is `retrace-admin`, owner only.
    Custody of keys and tokens is agent-rules 13.
    → unnecessary when: credentials move out of the Worker secret into a store designed for them
    (assessment priority 3). The design must answer: where they live (a D1 table or KV), what the
    Worker holds at runtime (hashed tokens only, never plaintext), and who may mint (self-serve per
    seat, or still owner-only). Until those three are answered this line is a direction, not a plan.
## Coordination

14. One coordinator at a time dispatches builders and merges. Other seats' task boards are their own
    tracking — read by the coordinator, not duplicated. A seat that finds itself coordinating in
    parallel asks the coordinator to stand by and waits for the acknowledgement (2026-09-10, 09-12).
    → unnecessary when: merging and `retrace-admin` are gated to one merger credential and Orca's task
    dispatch is the only way a builder session starts — then two coordinators cannot both act, and the
    rule becomes an enforced fact instead of an agreement.
15. Cursor pins effort inside the model id (`cursor-agent --model gpt-5.6-sol-high`); an explicit Orca
    `terminal create --command` bypasses the launcher's `--yolo`, so pass it explicitly or every shell
    command stalls on an approval. (That reviewer effort is routed and recorded is provenance —
    agent-rules 11 — not an environment rule.)
    → unnecessary when: Orca's `terminal create` inherits the worktree's approval policy, and the
    routing skill launches reviewers itself with the routed model id.

## Build order (Grok's read, PR 40, evt_1626b03aea8d4911ae1c7523c94903d9)

For priority 3 and the stranger-install bar: **13** (credentials out of the Worker secret, with the store
specified) → **3** (the hook runs the packed CLI) → **4** (MCP configs launch that same packed CLI). 6 waits
on 13. 10 and 11 are real and cheap but move neither bar; they are the next pair after 13, 3, 4.
