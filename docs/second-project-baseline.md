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
