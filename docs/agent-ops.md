# Agent ops — environment rules (this laptop, this checkout, these harnesses)

**Status:** v1, 2026-09-12. Author claude-code. Binding on the seats that share this environment and on
no one else. Every rule here is a workaround for something the product or a harness does not yet do,
and each ends with **→ unnecessary when:** the change that would retire it, tagged **[specific]** when
that change is a concrete, buildable item and **[direction]** when it names the goal but the design is
not yet written (Nemotron's point, PR 40: a backlog must not dress a direction as a plan). Rules that are not
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
   → unnecessary when [direction]: non-coordinator credentials cannot write the primary tree at all — a bare
   primary, or Orca refusing agent sessions on it — rather than a convention that we start from
   `orca worktree create`.
2. Commit only your own paths (`git commit --only <paths>`); never `git commit -a` or `git add -A`.
   Uncommitted work in a shared tree is swept into whoever commits next (bfe87c3, corrected c375ed4).
   → unnecessary when [direction]: a **pre-commit** check refuses to stage any path this seat has no logged
   edit for — prevention, bound to authenticated edit evidence. A hard `misattributed` gate (detection)
   does not retire this rule: it makes a sweep cost a red build, and the manual rule still has to stop it.
3. Git runs hooks from the common `.git/hooks`, so every worktree's commits are sealed by the **primary
   checkout's** built `dist`. Never build or test in the primary checkout mid-session; rebuild its dist
   only after a hook change merges, and only when every pane is idle (aeab15b, 2026-09-09).
   → unnecessary when [specific]: the hook script runs the packed CLI pinned by version (`npx`) instead of a
   checkout's dist.
4. A fresh worktree cannot run the retrace MCP server until it is built: `.cursor/mcp.json` and the
   other harness configs launch `node packages/mcp-server/dist/index.js` relative to the worktree. Run
   `npm ci && npm run build` there before starting an agent that needs the tools (D1 pane, 2026-09-11,
   twice).
   → unnecessary when [specific]: harness MCP configs launch the packed CLI via `npx` pinned to a version.
5. Verify a pull-request head in an isolated worktree with `dist` cleared before building; a reused
   worktree carries the previous PR's compiled tests and reports false failures (2026-09-10).
   → unnecessary when [specific]: `npm test` cleans stale compiled tests itself.

## MCP servers

6. If the retrace tools vanish mid-session, the server **process** died: restart the session
   (`claude --continue`; Cursor: a fresh `cursor-agent`). A running session does not respawn a dead
   project-scoped server, the `/mcp` reconnect does not, and Cursor's `agent mcp enable` answers
   "already enabled" without respawning. Do nothing that needs logging until `retrace_instruct`
   succeeds.
   → unnecessary when [direction]: the Worker's Streamable HTTP `/mcp` endpoint replaces local processes for every
   seat — which waits on 13 (credentials out of the Worker secret). Harnesses respawning dead stdio
   servers would also retire it, but that is a vendor change, not ours.
7. A running MCP server keeps the core it loaded at spawn. After `packages/mcp-server/dist` changes,
   restart the server before trusting new behaviour.
   → unnecessary when [specific]: 4 (the packed CLI is the server, so a checkout's dist is irrelevant) or 6.
8. Cursor Agent CLI does not interpolate `${workspaceFolder}` / `${userHome}` and does not load
   `envFile`, so `.cursor/mcp.json` launches via `bash -c` sourcing `~/.retrace/cursor.env` (token
   only). Tools can list while `RETRACE_TOKEN` is missing — that shows up as Worker 401.
   → unnecessary when [direction]: 4 **and** credentials no longer come from process env (13), or Cursor fixes
   `envFile` — the packed CLI alone is necessary, not sufficient.
9. Copilot: the GitHub.com cloud coding agent cannot use stdio MCP; dogfood is Copilot CLI
   (`~/.copilot/mcp-config.json`) and VS Code Chat via the **user** MCP config — never a project
   `.vscode/mcp.json` (a renamed server key is still a label, and Cursor can start a workspace MCP
   file). One credential per seat (CLI and Chat share the `github-copilot` pin) and what to do on HTTP
   402 — stop, never borrow another seat's token — are provenance rules, agent-rules 7 and 13, not
   this file's.
   → unnecessary when [specific]: 6 (the Worker's HTTP `/mcp` endpoint) — this rule is only the stdio mechanics.
## Environment, tests, merges

10. Test-only environment — a scratch `RETRACE_DB`, empty `RETRACE_URL` / `RETRACE_TOKEN` — goes
    **inline** on the test command (`RETRACE_DB=… RETRACE_URL= RETRACE_TOKEN= npm test`), never
    exported in a shell that also commits or merges: the hook inherits the shell and sealed three
    merges into a scratch database on 2026-09-10.
    → unnecessary when [specific]: the hook refuses to seal to a local store while `.retrace.json` names a remote.
11. Doctor can flake on a WSL2 fetch timeout: one run, retried up to three times to READY
    (agent-rules 8).
    → unnecessary when [specific]: doctor retries its own Worker requests.
12. Merges run from `retrace-main`, a worktree detached at `origin/main`, so the primary checkout
    never carries a merge in progress: `--no-ff`, hook seal verified after each merge, tests at the
    merged tip, doctor READY, push, then the webhook's second seal confirmed. Who merges and that only
    merge commits land directly on main is agent-rules 12 and `docs/team-roles.md`, not this file. A
    trailer-less merge seals as Jordan with `surface=agent`.
    → unnecessary when [direction]: the authenticated commit assertion (design v3) derives the merge actor from
    the session credential — that retires the trailer hazard; the detached-worktree mechanics retire
    with 1.
## Credentials and keys

13. Registered credentials live in the Worker secrets `RETRACE_CREDENTIALS` and
    `RETRACE_CREDENTIALS_EXTRA` (a few-KB ceiling), mirrored in
    `~/.retrace/worker-credentials-extra.json`; minting and retiring is `retrace-admin`, owner only.
    Custody of keys and tokens is agent-rules 13.
    → unnecessary when [direction]: credentials move out of the Worker secret into a store designed for them
    (assessment priority 3). The design must answer: where they live (a D1 table or KV), what the
    Worker holds at runtime (hashed tokens only, never plaintext), and who may mint (self-serve per
    seat, or still owner-only). Until those three are answered this line is a direction, not a plan.
16. **Terminal boundary.** A step in which a secret *value* is in play — minting, retiring or listing
    credentials with `retrace-admin`, `wrangler secret put` / `wrangler login`, filling or editing the auditor
    host's secret files, handling producer key files, rotating the owner token, shredding secret material —
    runs in a plain non-admin Ubuntu (WSL) terminal **outside Orca**, as a script the coordinator wrote to disk
    (`~/.retrace/<dir>/stepN-<what>.sh`, `chmod 700`, `read -p` gate before any outward change) that Jordan
    types by hand (`bash ~/stepN.sh`). The script prints record names, counts, byte sizes, sha256 prefixes,
    OK/FAILED and exit codes only; values pass through stdin or the environment, never argv, and are never printed.
    Everything else — build, test, git, review, ledger reads, review runs on the host, coordination — stays in Orca panes.
    Never hand Jordan a fenced code block to paste into a terminal: in the 2026-09-21T02:28Z incident (2026-09-20
    evening MDT, evt_6bfe5f18) bash read the triple backticks of the pasted fences as command substitutions, each
    opened a nested shell, and each fenced body ran on `exit` — a `wrangler secret put` and a `shred` ran
    unintended. After any rotation every open pane is stale until restarted; check a pane with
    `printf '%s' "$RETRACE_TOKEN" | sha256sum | cut -c1-12` (the value goes into the pipe; only a twelve-character
    hash prefix is printed) before running anything in it. The sinks this guards: agent transcripts capture pane
    output (owner token leaked 2026-09-16, evt_c21df545); a pane's environment keeps a rotated-away token; the
    clipboard executes.
    → unnecessary when [direction]: 13 retires the Retrace-credential half (credentials out of process env and
    out of the Worker secret, so no token ever passes through a shell); the other half — ssh keys, the auditor
    host's secret files, `wrangler login` — retires only when harness transcripts redact secret-shaped strings
    at write time, a vendor change. Until both, some part of this rule stands.
17. **Docker is root.** Two routes reach Docker Desktop's engine from this account without a password. The Linux
    socket: this distro's WSL integration is on (Jordan enabled it 2026-09-21 for the Omarchy trial,
    evt_d387fa54) and `jordandrumiler` is in the `docker` group (`/var/run/docker.sock` is `root:docker`, 0660), a
    group the Omarchy manual calls "effectively passwordless root". And the Windows CLI: `docker.exe` is on the
    Windows PATH (evt_d387fa54), WSL interop lets any process here launch it, and Docker documents it reaching the
    same engine without distro integration (a documented route, not tested here). Whenever the engine runs, every
    process in this account, each agent pane, MCP server and hook included, can start a root container that
    bind-mounts `~/.retrace`, `~/.ssh` or the files that hold the owner token and reads them whatever their mode;
    a container handed this shell's `RETRACE_*` environment holds the owner token, which may append events to the
    live ledger under any actor (`packages/core/src/router.ts`: an owner write keeps the actor as sent, stamped
    `sealed_by` owner); `docker inspect` without `--format` prints a container's environment into the transcript;
    and a container with a restart policy comes back whenever Docker Desktop starts. The NemoClaw sandbox did on
    2026-09-21, its OpenClaw configuration recorded as holding
    the retired shared token the laptop had already shredded (evt_e660b499; stopped on Jordan's go, evt_0f756347).
    That is a fourth credential sink beside the three rule 16 names. So: Docker Desktop runs only while a
    container task Jordan approved is in progress, and stays quit otherwise. The only `docker` or `docker.exe`
    commands an agent runs without a go are three reads: `docker version`; `docker ps` with a `--format` naming
    only `.Names`, `.Status` and `.Image`; and `docker inspect --format` naming only `.Name`, `.State.Status`,
    `.HostConfig.RestartPolicy.Name`, `len .Mounts` and `len .HostConfig.Binds`. Every other `docker` or
    `docker.exe` command needs a signed go naming the exact command and its arguments: `run`, `create`, `start`,
    `exec`, `cp`, `logs`, `update`, `stop`, `rm`, `compose`, `inspect` without `--format`, and `inspect --format`
    naming any field outside that list (`.Config` holds the environment, command and labels). Any of them that
    passes a secret in the environment, mounts a credential file or writes to the ledger must also satisfy rules
    13 and 16. A container's only bind mount is a scratch directory created for that
    task, named in the go and holding nothing secret: never an ancestor of it (`/`, `/home`, `$HOME`, `/mnt`,
    `/mnt/c`) and never a path that resolves, through a symlink or alias, into `~/.retrace`, `~/.ssh`, a shell
    startup file or a repository checkout. Before the container starts, the agent runs `realpath` on each mount
    source and on every symlink inside the directory it resolves to
    (`find "$(realpath <source>)" -type l -exec realpath {} +`) and confirms that none resolves to or under
    `~/.retrace`, `~/.ssh`, a shell startup file or a repository checkout. A container never
    runs `--privileged`, with the Docker socket or with host namespaces; never receives `RETRACE_*` or any other
    secret in its environment; uses images pinned by digest; and runs with `--rm` or restart policy `no`.
    → unnecessary when [specific]: no Docker engine endpoint answers this account without a password, shown from
    a pane running as `jordandrumiler` (the account every seat runs under) while Docker Desktop runs, endpoint by
    endpoint, with each command naming its endpoint instead of relying on the selected context. The Linux socket:
    `docker -H unix:///var/run/docker.sock version` fails with
    permission denied or no such socket (this distro's WSL integration off and `jordandrumiler` out of the `docker`
    group, Omarchy's own default). The Windows named pipe: `docker.exe -H npipe:////./pipe/docker_engine version`
    is refused, or `docker.exe` cannot be launched because interop is disabled for this distro. Any TCP endpoint:
    Docker Desktop's "Expose daemon on tcp://localhost:2375" is off and `docker -H tcp://localhost:2375 version`
    is refused. Every other endpoint named by `docker context ls`, `docker.exe context ls`, `DOCKER_HOST` or
    `DOCKER_CONTEXT` is checked the same way. An error about an unrelated endpoint, a missing client or a
    configuration problem proves nothing. These checks are the evidence the condition requires, not a proof of it:
    an endpoint found later that they miss means the condition was never met. Until that evidence exists, every
    guard above stands.
## Coordination

14. One coordinator at a time dispatches builders and merges. Other seats' task boards are their own
    tracking — read by the coordinator, not duplicated. A seat that finds itself coordinating in
    parallel asks the coordinator to stand by and waits for the acknowledgement (2026-09-10, 09-12).
    → unnecessary when [direction]: a **coordinator lease** held in the Worker — dispatch, merge and
    `retrace-admin` actions require holding it, and a second session cannot take it while it is held.
    A single merger credential is identity, not mutual exclusion: two sessions can use one credential.
15. Cursor pins effort inside the model id (`cursor-agent --model gpt-5.6-sol-high`); an explicit Orca
    `terminal create --command` bypasses the launcher's `--yolo`, so pass it explicitly or every shell
    command stalls on an approval. (That reviewer effort is routed and recorded is provenance —
    agent-rules 11 — not an environment rule.)
    → unnecessary when [direction]: Orca's `terminal create` inherits the worktree's approval policy, and the
    routing skill launches reviewers itself with the routed model id.

## Build order (Grok's read, PR 40, evt_1626b03aea8d4911ae1c7523c94903d9)

For priority 3 and the stranger-install bar: **13** (credentials out of the Worker secret, with the store
specified) → **3** (the hook runs the packed CLI) → **4** (MCP configs launch that same packed CLI). 6 waits
on 13. 10 and 11 are real and cheap but move neither bar; they are the next pair after 13, 3, 4.
