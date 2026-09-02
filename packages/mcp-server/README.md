# @retrace-dev/cli

Developer tooling for [Retrace](https://github.com/jordandru/retrace), a verifiable provenance ledger for AI-assisted software work.

```bash
npm exec --package=@retrace-dev/cli -- retrace doctor
npm exec --package=@retrace-dev/cli -- retrace status --json
npm exec --package=@retrace-dev/cli -- retrace-git install --project my-project
```

The package also installs `retrace-git`, `retrace-mcp`, `retrace-serve`, `retrace-export`, `retrace-github`, `retrace-gdrive`, and `retrace-admin` binaries. `retrace-admin add-agent <project> --member <email> --harness openclaw --url <https-worker>` provisions one pinned credential and a one-secret NemoClaw onboarding file for the experimental remote audit MCP pilot. Run the scoped `npm exec --package=@retrace-dev/cli -- retrace` form for doctor/status to avoid collisions with Android's unrelated `retrace` utility.

Node.js 22 or newer is required by the local SQLite-backed server. See the [repository README](https://github.com/jordandru/retrace#readme) for configuration and cloud deployment.
