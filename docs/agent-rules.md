# Agent rules — provenance (binding for every seat)

**Status:** v1, 2026-09-12. Author claude-code (coordinator), on Jordan's instruction to consolidate the
rules that were duplicated — and drifting — across `CLAUDE.md`, `AGENTS.md`, `GROK.md`,
`.github/copilot-instructions.md` and `.cursor/rules/retrace-provenance.mdc`. Those files now hold
identity only and point here.

These rules are identical for every seat, because the ledger measures every seat the same way. If a rule
here and a sentence in an identity file ever disagree, this file wins; for what gate a change takes,
this file also wins over `docs/team-roles.md` (rule 12). Rules that exist because of this
laptop, this shared checkout, or a harness quirk are **not** here: they live in `docs/agent-ops.md`, and
each one names the product change that would make it unnecessary.

0. **No claims ahead of evidence.** (Jordan, 2026-09-07.) Truthful, objective provenance outranks
   features, speed, money, and any agent's or harness's participation. Nothing is called proven,
   verified, covered, independent, or compatible until a sealed event or a merged commit shows it.

1. **Start every task with `retrace_instruct`** — `human_id` `jordansboxing@gmail.com`, the request as
   the instruction. Keep the returned event id: it is the `caused_by` of everything that follows. This
   is the WHY. Causal coverage is this rule working.

2. **Log every meaningful act** — edit, command, decision, review — with `retrace_log`, `caused_by` the
   instruction (or the act that directly caused it), and a concise `intent`.

3. **Name every file you changed** on the log for that change, as `repo:jordandru/retrace#<path>`.
   Reconciliation compares each commit's files against logged edits: a changed file with no logged edit
   is `uncovered`; a file whose only logged edits belong to another seat is `misattributed`. Files you
   only read go on as `role: used`.

4. **Report the model verbatim.** `actor.model` is the exact string your harness reports for the
   running session — not shortened, not normalised, not a nicer name. If the harness exposes nothing,
   omit the field; never pin a value and never guess. Spelling differences between harnesses
   (`gpt-5.6-sol` / `GPT-5.6 Sol`, `claude-opus-4-8` / `claude-opus-4.8`) are the routing registry's job
   to alias (`.claude/skills/review-effort/routing-rules/models.json`, PR 35), not yours to fix.

5. **Never log a commit through MCP.** The Git hook seals commits and merges with authoritative
   metadata, and the GitHub webhook seals them again. Two producers, one sha: that agreement is the check.

6. **Commit trailers are a claim, not the proof.** Every commit — merges included — carries
   `Retrace-Actor: <your seat>`, `Retrace-Model: <verbatim model>`, `Retrace-Caused-By: <instruction
   event id>`. `Retrace-Model` follows rule 4: when the runtime exposes no identifier the trailer is
   omitted, never guessed. The ledger classifies that claim against pinned edit evidence
   (`docs/design/commit-trailer-consistency.md`, §15 step 3 onward): a trailer the evidence does not
   support is recorded as unsupported, and after step 6 the actor it names is withheld.

7. **Identity is the pinned credential.** Each seat has one credential, one producer key, and one
   identity block in its own file. Never adopt another seat's `Retrace-Actor` or actor id, whatever file
   you happen to read; a harness that can only load another seat's identity file does not join (the
   OpenCode decision, PR 19).

8. **Doctor before every commit.** `node packages/mcp-server/dist/doctor.js doctor` (or the packed
   `retrace doctor`) must print `READY`; resolve every FAIL. One run, retried up to three times to READY
   on a transient fetch failure — never two independent runs treated as one result.

9. **Log, wait for the id, then commit.** A log that lands after the hook seal falls outside that
   commit's coverage window and reads as `uncovered` even though you logged it. Sequence; do not
   parallelise the log and the commit.

10. **Corrections are appended, never rewritten.** When a document, a number, or a claim is found
    wrong, the correction goes in place with its date and its source, and the earlier text stays
    visible. Sealed events are corrected by amendment, never edited.

11. **Reviews are evidence.** Whoever built a change does not review it. The verdict of record is the
    review's ledger event — `approved` or `rejected`, tag `review`, every file reviewed as `used` — which
    self-reports `method.params.reasoning_effort` from the reviewer's own configuration and cites the
    coordinator's routing decision as `method.params.routing_event_id`. The GitHub review is a copy of
    that verdict and is a COMMENT: `gh` runs as the repository owner for every seat, and GitHub refuses
    request-changes on the owner's own pull request.

12. **Every change to main arrives by pull request** — design notes and briefs included, the
    coordinator's included. The only direct commits to main are the merger's merge commits. The review a
    pull request needs is decided by **consequence, not file type**: (a) anything that governs behaviour
    — a design note or brief, these rules or an identity file, a security, build, deploy, or runbook
    control — takes the design gate in `docs/team-roles.md`, whatever its extension; (b) documents that
    govern nothing — measurements, snapshots, references, dated in-place corrections that change no rule
    — merge on one non-author review; (c) code follows the code order in `docs/team-roles.md`. When a
    gate seat is capped, absent, or the author, the coordinator routes a substitute and records the
    routing (rule 11); Jordan may reassign any seat, including for an emergency fix, and the
    reassignment is recorded. `docs/team-roles.md` says who sits where; this file says what gate a
    change takes; where they disagree, this file wins and `team-roles` is corrected.

13. **Keys and tokens stay with the seat that owns them.** Never read, print, copy, or commit a
    credential file (`~/.retrace/*.env`, `~/.retrace/worker-credentials*.json`,
    `~/.copilot/mcp-config.json`) or any token. A seat's private signing key is set on that seat's own
    MCP server (`RETRACE_PRODUCER_KEY_FILE`, mode 0600) and never placed in a shared secret. Never borrow
    another seat's token to keep working.

14. **Outward actions are Jordan's.** Merge, deploy, publish, credential minting or rotation, secret
    changes, webhook changes, and correction seals wait for an explicit go, one at a time; approval in
    one context does not carry to the next.

Roles, review order, and budgets: `docs/team-roles.md`. This environment: `docs/agent-ops.md`.
