# NOOA witness dispatch — packet builder and review wrapper

Plan item 2 of `~/.retrace/ops-2026-10-11/system-optimization/OPTIMIZATION-PLAN.md` (2026-10-11). The witness seat reads one
file and executes nothing (agent-ops 18, `docs/team-roles.md`), so whatever the packet leaves out becomes "unverifiable from
packet" and whatever is too long is not read. Measured that week: 4–5 of 18 rejections were packet-scope, two runs stalled on a
56 KB packet, and every packet was assembled by hand (FINDINGS.md M3, M6 procedure 5).

## `build-packet.mjs`

```
node scripts/nooa/build-packet.mjs --pr 222 --head <40 hex> --routing evt_<32 hex> --round r1 --rubric high --class a \
  --rules-file rules.md [--base <sha>] [--prev-head <sha>] [--context-file notes.md] [--instruction evt_…] \
  [--codex-routing evt_…] [--events evt_…,evt_…] [--ci] [--status] [--max-bytes 45000] [--out dir] [--repo path]
```

It writes `nooa-pr<N>-packet-<round>.md` and `launch-pr<N>-<round>.sh` and prints their sha256 and sizes. Into the packet, in
this order: the header (what is under review, author per the head's hook seal, classification, what the packet carries, what
the verdict carries, the stop rule); the standard role text; **your rules file verbatim** (the per-PR judgement rules are the
coordinator's to write; the builder never invents them); the optional context file (marked as a claim under test); the PR
body and every commit message verbatim; the diff against base (`-U3`) and, with `--prev-head`, the interdiff (`-U2`); the
output contract with the three verdict lines; Appendix A, a raw read of **every** full event id the text cites (routing,
instruction, body, commits, rules, context, `--events`), signature material removed, long strings clipped, unreadable ids
listed; Appendix B (`--ci`), the `retrace-gate` runs for the head and the gate step's READY/FAIL/PASS lines; Appendix C, the
agent-rules items the rules file names, verbatim at the head; Appendix D, the round's instruction raw; Appendix E
(`--status`), a status snapshot. The head must equal the PR's head on GitHub, or it refuses.

Budget: default 45,000 bytes (the host prints at most 50,000). Over budget it drops, in order, CI lines, status, rule texts,
the interdiff, the instruction, then clips event intents, and writes an "Omitted for size" section naming each cut and where
to get it. The core sections (header, role, rules, body, commits, diff, contract, events) are never dropped; if they alone
exceed the budget the exit code is 1 and the packet says so. It never splits into parts (a part that lacks a finding's text
re-raised it from quoted reviewer text on PR 193).

Reads: `gh` and `git` as subprocesses; the Worker with `RETRACE_URL`/`RETRACE_TOKEN` from the environment, in-process,
never on a command line. Writes nothing to the ledger. Pushing and launching stays `push-and-launch.sh`, whose `sent` event
records the hashes the host echoes back.

## `nooa-review-generic.py` (v2)

The canonical copy of the host wrapper. v2 reads the review's last lines — `FINDINGS: high=<n> medium=<n> low=<n>`,
`BLOCKING: yes|no`, optional `REASON: …`, `VERDICT: …` — and seals `findings`, `blocking` and the reason in
`method.params` (the verdict shape of `docs/design/dispatch-protocol.md` §2). It refuses to seal a review whose last lines
are missing or disagree (`needs changes` needs a High/Medium or a REASON; `approved` with a High/Medium needs a REASON), keeps
the text, and reports the error. `python3 scripts/nooa/nooa-review-generic.py --selftest` runs its 11 cases without the host.
`push-and-launch.sh` copies the wrapper from its own directory (`~/.retrace/handoff-2026-09-23/nooa/`), so after a merge copy
this file over that one and record the hash in the next `sent` event.

## Tests

`node --test scripts/nooa/*.test.mjs` (also run by the root `npm test`): the pure functions, a full build against a fake
`git`/`gh`/Worker, the head-mismatch refusal, the size budget, and the wrapper's self-test.
