# CI — what a green build proves, and what it does not

**Status:** v1, 2026-09-16. Author claude-code (coordinator), on Jordan's instruction after a merge-readiness
check on PR #63 required reconstructing the gate's guarantees from workflow YAML, `doctor.ts` and a job log.
This file grants no permission and imposes no rule — the rules are `docs/agent-rules.md`, and this file only
says how much of rules 3, 6 and 11 a machine actually enforces. It is nonetheless class **(a)** under rule
12, because a reader who mis-trusts it can merge something the gate never checked.

**What this file deliberately is not.** It does not list the checks `retrace doctor --gate` runs. That list
lives in the tool and prints on every run, and a hand-maintained copy would drift — which is the failure
`docs/agent-rules.md` was written to end after the same rules drifted across five identity files. What
follows is the **trust boundary**: what a green build warrants, what it leaves to a human, and where it is
silent. Guarantees change far more slowly than mechanisms, and a reader who knows the boundary can read the
tool's own output for the rest.

Every claim below is checkable. Where something is inferred rather than observed, it says so.

## The three workflows

| | job | trigger | what it is for |
| --- | --- | --- | --- |
| `retrace-gate.yml` | `gate` | pull request; push to `main` | the provenance gate — the only check the ruleset names, though it never binds a merge (see below) |
| `local-walkthrough.yml` | `walkthrough` | pull request; push to `main`; manual | the stranger-install path, end to end, with the production Worker unreachable |
| `retrace-checkpoint.yml` | — | daily 06:17 UTC; manual | signs a checkpoint of the ledger head and opens a pull request; see its own header comment |

`retrace-gate` checks out `pull_request.head.sha`, **not** GitHub's synthetic merge commit, because that
commit is not in the ledger and never will be; `fetch-depth: 0` because capture coverage has to resolve every
sealed commit the ledger names. It then runs the suites, the Worker typecheck, and
`doctor.js doctor --gate` against the live Worker on `RETRACE_CI_TOKEN`.

`local-walkthrough` installs into a throwaway repository under a clean `HOME`, with
`retrace-api.slcwitit.workers.dev` pointed at `127.0.0.1` and the job failing outright if `RETRACE_URL` or
`RETRACE_TOKEN` are inherited — so the run cannot reach the production Worker, which is the hazard that made
four junk projects on 2026-08-28. It commits, merges, runs doctor, exports, and verifies the bundle offline.

## What a green `gate` warrants

Taken from run **#291** on `1d9b55e` (PR #63), which is a worked example, not a summary:

1. **The commit reached the ledger.** `HEAD delivery — commit:…@1d9b55ec84aa is event #5096`. Under
   `--gate` an absent head is a **failure**; locally it is only a warning (`doctor.ts:134`).
2. **The seal chains to a human instruction.** `instruct root — evt_1aa34b68… ← evt_a1111c27…`. This check
   exists **only** under `--gate`.
3. **The actor is evidenced on its own chain.** `pin/session — commit actor and session match MCP peers in
   the why-chain`.
4. **The trailers are not dressing a human commit over agent evidence.** `attribution — agent/claude-code
   has no agent-evidence mismatch`.
5. **Every file the commit changed has a logged edit by the actor claiming it** — rule 3, machine-checked:
   `capture coverage — 1 file covered by claude-code; 5086 events from a full export verified against
   …/.well-known/retrace-pubkey (kid 51f6ac4c…); signed cache through #5085; chain-verified tail
   #5086..#5100 verified against signed live head`. The evidence is verified against the published key, not
   merely fetched, and the tail beyond the signed cache is chain-verified against the signed live head —
   which is what stops a stale cached export from producing a false result, the failure of 2026-09-03 to
   09-05 (fixed in 8cbb837).
6. **Two producers sealed it.** `gateDualWitness` (`doctor.ts:127`) refuses `--local` under CI and fails on a
   commit only one producer sealed. The hook and the webhook agreeing is the check; CI requires it.

Plus the ordinary engineering: the build, the three workspaces' test suites, and the Worker typecheck.
(Run #291: 348 core, 210 CLI, 33 worker; 0 failures, 0 skipped. A count is a measurement of one run, not a
property of the gate.)

## Substantive passes and vacuous ones

A `PASS` line is not self-evidently strong. The same check prints two very different results:

```
PASS  pin/session — commit actor and session match MCP peers in the why-chain      ← evaluated
PASS  pin/session — no MCP peers in the why-chain to compare                        ← nothing to evaluate
```

The second is honest and correct — there was nothing to compare — but it warrants nothing. It is the normal
result on a merge commit. **Read the detail, not the verdict.** The same applies to `capture coverage — no
files changed`.

## `--gate` is strictly stronger than the local `doctor`

`retrace doctor` before a commit (agent-rules 8) and `doctor --gate` in CI are not the same instrument. The
gate turns several warnings into failures — head delivery (`:134`), attribution (`:179`), pin/session
(`:200`), attribution deployment (`:545`) — adds the instruct-root check, requires a credential and a URL,
and refuses `--local`. A local `READY` is a preflight, not a prediction of the gate.

Scope note, from experience rather than theory: `pin/session` can only evaluate a commit that already
exists, so it always arrives one commit late. Nothing at commit time warns that a trailer will orphan the
actor claim; only CI catches it.

## What a green gate does not cover

Four things, stated the way agent-rules 3 states its own gap — plainly, in place.

### 1. The ruleset does not gate the merge

Ruleset `21787665` ("main gate") is **active** on the default branch, requires the `gate` context, and
forbids non-fast-forward. It has not bound a single merge on this record. Its `bypass_actors` exempts
`RepositoryRole 5` (admin), and `gh` runs as the repository owner for every seat.

This is observed, not inferred. For **every** push to `main` GitHub still holds a rule-suite record of
(`bba3757`, `97a6a27`, `2cf7988`, all with actor `jordandru`) the evaluation reads:

```
required_status_checks : skipped
non_fast_forward       : skipped
```

**A trap in that API:** the suite's own top-level `result` field reads `pass` while the individual rules read
`skipped`. Read the per-rule results. (`secret_scanning` is separately active and genuinely evaluated.)

What enforces the gate in practice is therefore two things, neither of them the ruleset: the merger comparing
heads and checks before merging (agent-rules 11, 12), and `retrace-gate` re-running on push to `main`
afterwards. The second is **detection, not prevention** — it reports after the commit is on `main`. The loop
has held: the twelve most recent push-to-`main` runs, #226 through #277, are all green.

**Untested, and to be treated as such.** Whether the exemption could simply be removed is unknown. The
mechanism to check first: merge commits are pushed **directly** to `main`, and `retrace-gate` runs only on
`pull_request` and `push: main`, so the required check for a merge sha cannot have completed at the moment
the push is evaluated. If that is right, removing the exemption blocks the merge flow rather than securing
it, and the real fix is a change to how merges land. Nobody has tested it, and this note is not an argument
either way. Related: `strict_required_status_checks_policy` is `false`, so a branch behind `main` can carry
green from a state that no longer exists.

### 2. Reconciliation evaluates HEAD only

`doctor --gate` reconciles one commit — `commitFacts(repo, "HEAD")` (`doctor.ts:535`). In a multi-commit
pull request the intermediate commits are checked only where each was itself a head at the time some run
fired.

Worked example, PR #63: of its three commits, `b6b984f` was gated as a head (run #289) and `1d9b55e` as the
current head (#291), but **`ce9c4eb` has no workflow run at all** — it was pushed to a branch with no pull
request open, which triggers neither `pull_request` nor `push: main`. Its coverage does exist in the ledger
(hook `evt_eaf5da16`, webhook `evt_6f707cdd`, both naming the one file, role `generated`, actor
`claude-code`); no CI run ever checked it. A merge brings every commit onto `main`, so this is the merger's
to check by hand.

### 3. Merge commits are not coverage-checked

Already stated in agent-rules 3 and repeated here because it is a CI property: reconcile does not evaluate
file coverage on merge commits, so content introduced *inside* a merge — a conflict resolution, a manual
edit before committing — is uncovered by construction, and the post-merge run on `main` passes vacuously on
it. This is why merges are the merger's alone, `--no-ff`, with no manual edits.

### 4. CI does not check the review gate

Nothing in either workflow reads reviews. Whether a pull request has the reviews its class requires, whether
the reviewer is a non-author, and whether the verdict binds the current head are checked by a human
(agent-rules 11, 12). Run #291 completed at 14:38:22Z; the approval of record (`evt_4a8df4f5`) was sealed
nine minutes later at 14:47:25Z. **A green gate on a pull request with no review at all looks identical.**

The gate does emit review warnings — missing `routing_event_id`, unregistered `actor.model`, unreported
effort, routed-versus-ran mismatches — 45 of them on run #291. They are warnings by construction and never
fail the build.

## Reading a red gate

A failing `doctor --gate` names the check. Two recur:

- **`pin/session — commit actor agent/X is not among MCP peers agent/Y`.** The commit's `Retrace-Caused-By`
  cites an event logged by another seat. `mcpPeers` drops the commit and the `instructed` root from the
  why-chain, so a commit citing only another seat's event carries no evidence of its own actor on its own
  chain. **A builder's commit cites its own pre-commit log event, never a coordinator's dispatch** — the
  dispatch is that log's parent, so the chain survives either way. Finding
  `evt_4fbc6eebfe87477aa6ff2c95cf38c5ad`; it cost two rounds on PR #60.
- **`HEAD delivery` failing.** The seal did not reach the Worker — usually the WSL2 fetch drop
  (`docs/agent-ops.md` 11). Re-seal by sha; `.git/retrace-pending-seal` is the local record.

A red gate is not something to merge past and fix afterwards. It is the only automatic check on the claim a
commit makes about who wrote it.

## How this file goes stale, and what to trust instead

Authoritative, in this order:

```
node packages/mcp-server/dist/doctor.js doctor --gate     # the checks, and what they say today
cat .github/workflows/*.yml                                # what actually runs
gh api repos/jordandru/retrace/rulesets/21787665           # what is enforced on main
gh api "repos/jordandru/retrace/rulesets/rule-suites?ref=refs/heads/main"   # whether it bound a given push
```

Because this file states guarantees rather than the check list, adding or renaming a check does not
invalidate it. What does: a change to what `--gate` *fails* on, a change to the ruleset or its bypass list, a
change to how merges reach `main`, or reconciliation gaining commits beyond HEAD. Any of those means the
sections above are wrong until corrected.

Once merged, corrections here are appended with their date and source, and the earlier text stays visible
(agent-rules 10).
