# NOOA witness dispatch — packet builder and review wrapper

Plan item 2 of `~/.retrace/ops-2026-10-11/system-optimization/OPTIMIZATION-PLAN.md` (2026-10-11). The witness seat reads one
file and executes nothing (agent-ops 18, `docs/team-roles.md`), so whatever the packet leaves out becomes "unverifiable from
packet" and whatever is too long is not read. Measured that week: 4–5 of 18 rejections were packet-scope, two runs stalled on a
56 KB packet, and every packet was assembled by hand (FINDINGS.md M3, M6 procedure 5).

## `build-packet.mjs`

```
node scripts/nooa/build-packet.mjs --pr 222 --head <40 hex> --routing evt_<32 hex> --round r1 --rubric high --class a \
  --rules-file rules.md [--base <sha>] [--prev-head <sha>] [--context-file notes.md] [--instruction evt_…] \
  [--codex-routing evt_…] [--events evt_…,evt_…] [--files a.md,b.ts] [--ci] [--status] [--max-bytes 45000] [--out dir] [--repo path]
```

**The routing event is authenticated first.** Before anything else is read, the builder fetches `--routing` raw and refuses
to build unless it is a `routing` event (`method.tool`) by `agent/claude-code`, sealed under the pinned claude-code credential
(`params.sealed_by` names the seat) with `producer_sig_verdict: verified`, and its `pr`, `head_sha` (full 40 hex), `class`,
`round`, `reasoning_effort`, `seat`, `reviewer_actor` (both `nooa`) and `model` (the pinned witness model) each equal what the
command asks for. A routing event for another PR, head, class, round, effort, seat or model fails before any packet or
launcher is written, as does an unreadable one. There is no `--model` flag: the witness model is the constant `NOOA_MODEL`
(`nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b`) in the builder, in the routing event, and in the wrapper's refusal.

It writes `nooa-pr<N>-packet-<round>.md` and `launch-pr<N>-<round>.sh` and prints their sha256 and sizes. Into the packet, in
this order: the header (what is under review, author per the head's hook seal, the classification and what the builder
authenticated about the routing event, what the packet carries, what the verdict carries, the stop rule); the standard role
text; **your rules file verbatim** (the per-PR judgement rules are the coordinator's to write; the builder never invents them);
the optional context file (marked as a claim under test); the PR body and every commit message verbatim; the diff against base
(`-U3`) and, with `--prev-head`, the interdiff (`-U2`); the output contract with the three verdict lines; Appendix A, **selected
fields** of every full event id the text cites (routing, instruction, body, commits, rules, context, the diff and interdiff,
`--events`), each entry listing under `omitted` the top-level fields, method keys and params keys present in the event and not
carried, so that absence in the packet cannot be read as absence in the ledger; signature material is never carried; unreadable
ids are listed; Appendix B (`--ci`), the `retrace-gate` runs for the head and the gate step's READY/FAIL/PASS lines; Appendix C,
the agent-rules items the rules file names, verbatim at the head; Appendix D, the round's instruction (selected fields);
Appendix E (`--status`), a status snapshot. The head must equal the PR's head on GitHub, or it refuses.

The launcher carries, besides the packet name and the head, the routed `NOOA_CLASS` and a `NOOA_SURFACE` line (the class under
agent-rules 12 and the files under review); the wrapper seals both, so a class-(c) scripts review is sealed as one.

Budget: default 45,000 bytes (the host prints at most 50,000). Over budget it drops, in order, CI lines, status, rule texts,
the interdiff, the instruction, then clips event intents, and writes an "Omitted for size" section naming each cut and where
to get it. The core sections (header, role, rules, body, commits, diff, contract, events) are never dropped; if they alone
exceed the budget the exit code is 1 and the packet says so. It never splits into parts (a part that lacks a finding's text
re-raised it from quoted reviewer text on PR 193).

Reads: `gh` and `git` as subprocesses; the Worker with `RETRACE_URL`/`RETRACE_TOKEN` from the environment, in-process,
never on a command line. Writes nothing to the ledger. Pushing and launching stays `push-and-launch.sh`, whose `sent` event
records the hashes the host echoes back.

## `nooa-review-generic.py` (v2.1)

The canonical copy of the host wrapper. It reads **one anchored block at the very end** of the review — the last three
non-blank lines, bare, in order: `FINDINGS: high=<n> medium=<n> low=<n>`, `BLOCKING: yes|no`, `VERDICT: …` — and seals
`findings` and `blocking` in `method.params` (the verdict shape of `docs/design/dispatch-protocol.md` §2). The rules are the
ones `packages/core/src/review-verdict.ts` applies to every sealed verdict (team-roles rule 8): `blocking` is derived,
`high + medium > 0`; a BLOCKING line that disagrees with the counts is refused; `approved` with a High or Medium is refused;
`needs changes` with only Lows is sealed as a non-blocking rejection; there is no REASON line and no override. A second
FINDINGS, BLOCKING or VERDICT line anywhere in the review, text after the block, a bold or heading form, or a block in a code
fence is refused. Refusal seals nothing, keeps the text, and reports the error. `python3 scripts/nooa/nooa-review-generic.py
--selftest` runs its 20 cases without the host.

Before the run it checks every launcher value (PR number, full event id, full 40-hex head, round, rubric, class in a/b/c/S,
surface) and refuses unless `NOOA_MODEL` **equals** the pinned witness model; a prefix is not a pin. The sealed verdict carries
`class`, `review_surface` and `routing_binding`: the wrapper binds to the launcher's values, which the builder set after
authenticating the routing event raw, and it does not re-read the event on the host, because the host's MCP exposes no raw
event read. That limit is stated in the record rather than papered over.

`push-and-launch.sh` copies the wrapper from its own directory (`~/.retrace/handoff-2026-09-23/nooa/`), so after a merge copy
this file over that one and record the hash in the next `sent` event. Hand-written launchers from before the builder lack
`NOOA_CLASS` and `NOOA_SURFACE` and are refused.

## Tests

`node --test scripts/nooa/*.test.mjs` (also run by the root `npm test`): the pure functions, the routing-event authentication
and every refusal it makes (including PR 225's routing event offered for a PR 223 build, which fails before any other read), a
full build against a fake `git`/`gh`/Worker, ids that appear only in the diff or interdiff, the omitted-field enumeration, the
head-mismatch refusal, the size budget, the wrapper's self-test, and the wrapper's start-up refusals.
