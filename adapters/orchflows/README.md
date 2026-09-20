# retrace — an orchflows library

Records orchflows assignments and verdicts in a [Retrace](https://github.com/jordandru/retrace) ledger, so a later reader can see which review ran, at what settings, against which commit, and whether the verdict still applies.

One workflow: **`retrace-review`** — `orch-review` with a routing event recorded before the reviewer launches and the verdict recorded after, both bound to the inspected head. The event contract is [references/retrace-events.md](references/retrace-events.md). Design and rationale: `docs/design/orchflows-integration.md` in the Retrace repository.

## Dependencies

- orchflows core installed in the host (`orch-review`), pinned by commit when you cite it.
- A Retrace MCP server in the host exposing `retrace_instruct`, `retrace_log` and `retrace_history`, on a credential for the project. Without it the workflow reports a gap and stops.

## Install

From a Retrace checkout:

```sh
claude plugin marketplace add ./adapters/orchflows        # Claude Code
claude plugin install retrace@retrace-local --scope user
# Codex: codex plugin marketplace add ./adapters/orchflows; codex plugin add retrace@retrace-local
```

Start a new session, then:

> Use retrace:retrace-review on commit `<sha>`: acceptance criteria …, sources …, effort high.

## What it establishes, and what it does not

It records a **same-credential, fresh-context** review: the reviewer is a fresh child of the same host session and credential, never another seat. That is the best independence a single harness can offer, and the ledger says exactly that. It is not a cross-seat or cross-vendor verdict, and it does not satisfy Retrace's agent-rules 11 in a repository that requires one.

Model and effort are self-reported. Orchflows' `history inspect` can read the host's native transcript afterwards for a local comparison; nothing here uploads transcripts.

## Status

Version 0.1.0. Two trial runs on 2026-09-20 (Claude Code 2.1.278, orchflows `6eb8af4`) stopped before a verdict and produced the composition and gap-event wording above; a run that reaches a verdict is recorded in the design note §8 when it exists. Frontmatter proves no behaviour. Bounds: one review, no repairs, no further agents.
