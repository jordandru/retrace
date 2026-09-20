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

It records a **same-credential, fresh-context** review: the reviewer is a fresh child of the same host session and credential, never another seat. That is the best independence a single harness can offer, and the event says exactly that in `method.params.independence`. It is not a cross-seat or cross-vendor verdict, and it does not satisfy Retrace's agent-rules 11 in a repository that requires one.

**Known limit (Retrace `0d294eb`):** `retrace doctor` does not yet read `independence`; its review check (`packages/mcp-server/src/doctor.ts:240–246`) counts any `approved`/`rejected` agent event as a review, so `doctor --gate` will count these verdicts until the follow-up in the design note §6 lands. On a repository with a review gate, the merger must read `independence` by hand until then.

Model and effort are self-reported. Orchflows' `history inspect` (`docs/history.md` at `6eb8af4`) can read the host's native transcript afterwards for a local comparison; nothing here uploads transcripts.

## Status

Version 0.1.0. Trialed 2026-09-20 on Claude Code 2.1.278 with orchflows `6eb8af4`: two runs stopped before a verdict and shaped the composition and gap-event wording above; the third ran end to end, with the child recording its own verdict citing the routing event (design note §8, project ledger `evt_8c25294ade3e4dfaa9511e018971d715`). Not yet trialed on Codex. Bounds: one review, no repairs, no further agents.
