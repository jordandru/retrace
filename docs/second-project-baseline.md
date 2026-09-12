# Second-project capture baseline

Measured 2026-09-07 against project `boxing-rpg`, repository `jordandru/slc-wit-it`,
HEAD `11f370faaafe293563fabaf55e2fd4655fadd6f6`, ledger head #112. This is a baseline,
not a sustained-coverage demonstration. No historical edit claims were backfilled.

The repository configuration names credential `retrace-git` but lacks
`reconcile.hook_sealed_by`. The credential metadata identifies its exact server stamp
as `assert:git hook (assert)`. Supplying that stamp explicitly gives this result:

| Measurement | Result |
|---|---:|
| Recent commits inspected | 30 |
| Authenticated commit seals | 11 |
| Missing authenticated commit seals | 19 |
| Evaluated file transitions with covering edits | 11 / 68 (16.2%) |
| Uncovered evaluated file transitions | 57 |
| Orphan edits | 1 |
| Misattributions / producer disagreements | 0 / 0 |

File coverage excludes commits for which no trusted seal bounds the window. The
16.2% figure is not coverage of all changes in those 30 commits. The reconciliation
verdict is failing because of the missing seals.

Reproduce with an explicit project environment; the shell's `RETRACE_PROJECT` can
otherwise override repository configuration:

```sh
RETRACE_PROJECT=boxing-rpg retrace-export reconcile \
  --repo /path/to/slc-wit-it --limit 30 \
  --hook-sealed-by 'assert:git hook (assert)' --json
```

Next, commit the exact hook stamp configuration through that repository's normal
review process, verify hook/push capture on real work, and measure a new range after
this HEAD. Record the Git range and ledger head with each result. Sustained coverage
requires consecutive real changes to carry edit events before their commit seals;
another snapshot of this unchanged history cannot establish it.

## 2026-09-12 snapshot (wiring vs live coverage)

Measured from `/home/jordandrumiler/provenance/slc-wit-it` HEAD
`295d26fb97d2291ab757fc582437f7ebbdd07e74` (`v0.11.26`, 2026-09-09), ledger
`boxing-rpg` 137 events verified. This is still not a sustained-coverage
demonstration. It records that the Sep 7 wiring gap closed, and that edit
capture did not.

| Check | 2026-09-07 | 2026-09-12 |
|---|---|---|
| `.retrace.json` `reconcile.hook_sealed_by` | missing | `assert:git hook (assert)` |
| `retrace doctor` | not recorded here | READY, 15 passed, 0 warnings, 0 failures |
| HEAD in ledger | — | `commit:jordandru/slc-wit-it@295d26fb97d2` is event #134 |
| Causal coverage (`retrace_status`) | — | 19% (83/93 unlinked commits) |
| Last 20 commits sealed | — | 20/20 (`missing_commit` 0) |
| Uncovered file transitions (last 20) | 57 of 68 on last 30 | 137 |
| Misattributions / producer disagreements | 0 / 0 | 0 / 0 |
| Last Claude Code activity on this project | — | 2026-09-04 |

Reproduce:

```sh
cd /home/jordandrumiler/provenance/slc-wit-it
RETRACE_PROJECT=boxing-rpg retrace-export reconcile \
  --repo . --limit 20 \
  --hook-sealed-by 'assert:git hook (assert)' --json
```

`CLAUDE.md` already requires `retrace_instruct` / `retrace_log` with every
changed file as `repo:jordandru/slc-wit-it#<path>`. Project `.mcp.json` pins
only `claude-code` to `boxing-rpg`. Other harnesses are not a producer here
until they have a project-scoped credential.

### Live window (the 95% bar)

Historical uncovered counts cannot be repaired by another snapshot of the
same commits. The metric that can still be earned:

1. Record `start_sha` = current HEAD (`295d26fb97d2`) and ledger seq at start.
2. Do real `slc-wit-it` work with a logging producer. Do not invent game
   features for the sake of the number.
3. After N agent commits (`N ≥ 5`, consecutive, no backfill), reconcile
   `--since <start_sha>` and compute
   `covered / (covered + uncovered)` over evaluated file transitions.
4. Pass: that ratio ≥ 0.95, `missing_commit` 0, `misattributed` 0.
5. Fail: a silent producer, a commit with no per-file `retrace_log`, or
   work logged to the wrong project.

Grok measures. Jordan (or a named next feature he authorizes) supplies the
commits. Agents must not spawn on this repo without `RETRACE_PROJECT=boxing-rpg`.
