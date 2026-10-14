# @retrace-dev/cli

Developer tooling for [Retrace](https://github.com/jordandru/retrace), a verifiable provenance ledger for AI-assisted software work.

```bash
npm exec --package=@retrace-dev/cli -- retrace doctor
npm exec --package=@retrace-dev/cli -- retrace status --json
npm exec --package=@retrace-dev/cli -- retrace-git install --project my-project
```

The package also installs `retrace-git`, `retrace-mcp`, `retrace-serve`, `retrace-export`, `retrace-github`, `retrace-gdrive`, and `retrace-admin` binaries. `retrace-export producer-keygen` mints a producer Ed25519 key (not the export issuer key at `signing-key.json`). `retrace-admin add-agent <project> --member <email> --harness openclaw --url <https-worker>` provisions one pinned credential and a one-secret NemoClaw onboarding file for the experimental remote audit MCP pilot. Secret-bearing onboarding documents default to `~/.retrace/`; an explicit `--out` inside a Git worktree emits a warning. Run the scoped `npm exec --package=@retrace-dev/cli -- retrace` form for doctor/status to avoid collisions with Android's unrelated `retrace` utility.

Node.js 22 or newer is required by the local SQLite-backed server. See the [repository README](https://github.com/jordandru/retrace#readme) for configuration and cloud deployment.

**0.4.0** tracks `@retrace-dev/core` 0.4.0 (exact pin). The CLI already calls core functions that core 0.3.0 does not have, so the two ship
together; see the [core README](https://www.npmjs.com/package/@retrace-dev/core) for the core changes (the timestamp grammar, `Retrace-Caused-By`
parsing, `kid_mismatch`). In the CLI:

- **New MCP tools `retrace_send` and `retrace_verify_send`** (PR 222), the signed pane messages of agent-rules 15. `retrace_send` runs `orca-ide`
  and sends only to a pane listed as an agent pane in `RETRACE_PANES_FILE` (default `~/.retrace/panes.json`); `retrace_verify_send` binds the
  receiver to `RETRACE_TERMINAL` or, failing that, `ORCA_TERMINAL_HANDLE`. Both variables are optional.
- **`retrace_log` refuses a review verdict that is incomplete** (PR 222): an agent's `approved` or `rejected` event tagged `review` must carry
  `findings {high, medium, low}`, `routing_event_id`, a 40-hex `reviewed_head`, and a `blocking` equal to `high + medium > 0`. `retrace_log` and
  `retrace_instruct` apply core's timestamp grammar, and `retrace_history` answers an invalid `since`/`until` with an error result (PR 203).
- `serverInfo.version` is the package version (PR 206); `retrace doctor` prints READY / NOT READY first (PR 204).
- `retrace-admin add-agent` gains the `claude-code-openshell` harness, and `new-team` refuses the `claude-code-cloud` and `claude-code-openshell`
  harnesses (PR 196). `retrace-export checkpoint` refuses a bundle whose `generated_at` does not parse (PR 200). `retrace-git reconcile --json`
  adds `attribution` (PR 198).
- The git hook keeps a seal queued when its target never ran and bounds npx's network wait (PR 202). The hook script is written at install, so an
  existing repository gets those two changes when `retrace-git install` is run again.
- The remote store retries an idempotent GET once after a socket-level failure (PR 210).

No binary was added or removed, and no environment variable became required.

**0.3.1** keeps the exact pin on `@retrace-dev/core` 0.3.0 (core is unchanged) and fixes one message: `retrace-export verify` and
`retrace-export render` run outside a recorded repository with no `--policy` now report the attribution evaluation as unavailable with
`no_repository_context` and how to supply the repository, instead of a raw `ENOENT`. Verdicts, policy handling and exit codes are unchanged.

**0.2.0** tracks `@retrace-dev/core` 0.2.0 (exact pin). The core release changes the exported `Actor` schema and tightens two
`method.params` fields; see the [core README](https://www.npmjs.com/package/@retrace-dev/core) for the migration notes (0.3.0: policy `/2` `github` field, restricted hook witnesses, `principal_rule`, `RETRACE_AUTH=proxy`; 0.2.0: `Actor` schema). The CLI
commands, binaries and environment variables are unchanged; `RETRACE_ACTOR_MODEL_SOURCE` is new and optional.
