# Reconciliation — tamper-evident roadmap rung 4

*2026-09-01. Author: claude-code. Status: **BUILT (phase A)** with the recommended defaults (A warn, B daily workflow, C since last checkpoint commit, D no ledger logging). Refinements found by the first real run: `misattributed` is a commit-level **fail** only when every file has logged edits and none are the committer's (a complete, contradicting story); when the story is partial it is a per-file **warn** alongside the `uncovered` files. `human` in the table below is named `non_agent` in code (system actors are treated the same).*

*Hardened after Codex's review of `48d7914` (all four findings accepted): (1) a missing commit is always a **fail** — the only warn is a commit that is the head of a PR whose merge the server stamped `sealed_by: webhook:github`; git author strings are never consulted for levels. (2) An acknowledgement counts only if sealed after the commit's seal, by an actor other than the accused committer (humans always; agents unless `.retrace.json` `reconcile.ack_actors` restricts them), and never for an unsealed commit (a sha is computable before the commit exists). (3) Remote exports are consumed only after `verifyExportBundle` + `exportVerdictOk` against the trusted issuer key, in both the CLI and the gate — fail closed. (4) Consumption is tracked per (event, path), so an event naming A+B where only A was committed still reports B as an orphan. Adversarial tests cover each.*

*First run, last 120 commits: 119 sealed · 1 bot commit unsealed · 3 complete mis-attributions (bfe87c3 → acknowledged #258; 1bc76c1 → hand-off disclosed in its message, but claude-code's own correction #1181 is a self-ack and does not count — OPEN until grok or Jordan acknowledges; 10bfcc9 → OPEN, Grok's first commit with all ten files' edits logged by claude-code) · 216 uncovered files (claude-code 117, codex 74, grok 25 — mostly README/docs edits not logged per file) · 35 loose ids. Daily range (35 commits since the last checkpoint commit): OK, 4 per-file warns.*

## The claim this rung earns

Today the gate proves that HEAD **is in the ledger**, that its attribution is consistent, and that an agent commit is rooted in a human instruction. It proves nothing about the **edits behind the commit**: an agent that never calls `retrace_log` (Gemini CLI does not) produces commits that pass the gate as long as the git hook fired. "The ledger records what agents did" is therefore an assumption. Reconciliation turns it into a checked claim by comparing an independent source of truth — git history — against the ledger and reporting **capture windows**: files changed by a commit that no producer logged an edit for.

It also catches the incident this product was built on. `bfe87c3` was sealed as Codex; the edits to its three files were logged by Claude Code. Reconciliation flags that as `misattributed` from the ledger's own data — no human memory needed.

## Definitions

- **Commit facts** come from git, never from the ledger (a commit the hook missed must be visible): `sha, parents, files[{path, status A|M|D|R, from?}], author time, is_merge`. Reuse `commitToEvent()` from `git-hook.ts` — it already parses numstat and parents.
- **Window** for file `f` in commit `C`: ledger events with `seq` strictly between the `committed` event of the *previous commit that touched `f`* and the `committed` event of `C` (server-assigned `seq` orders the window; client timestamps are asserted and are not used). If `C` has no `committed` event, the window closes at the project head. This is why the uncommitted-work case works: Claude's edits landed long before Codex's commit, and the window reaches back to the last commit that touched those files.
- **Match**: an event with action `created|edited|deleted|renamed|moved` whose artifacts include `repo:<name>#<path>` (exact), or `file:<abs path under repo>` / a bare relative path normalised to it (`loose` match, counted but marked). Renames accept either id.
- **Covering actor(s)**: the set of `actor.id` on matching events in the window.

## Findings

| kind | condition | gate level (HEAD) | why |
|---|---|---|---|
| `missing_commit` | commit in git, no `committed`/`merged` event | fail | the hook or webhook missed it; today doctor only checks HEAD |
| `misattributed` | commit sealed as agent B; every covering edit is by agent A ≠ B | fail | the bfe87c3 case; the whole product's founding claim |
| `uncovered` | agent commit; a changed file has no matching event in its window | **warn** (see decision A) | a producer is silent for that file — Gemini today |
| `loose_match` | covered only via normalised ids | info | producer used `file:`/bare ids; nudge, not a fault |
| `orphan_edit` | edit events on a path no later commit touches | info | uncommitted or discarded work; capture, not fault |
| `human` | commit actor is human; coverage not evaluated | info | the ledger claims nothing about human keystrokes |

Merge commits are checked for `missing_commit` only (their diff is a union). A finding on a commit is **acknowledged** when a later ledger event references `commit:<sha>` and carries tag `correction` (this is what c375ed4 / the appended event did for bfe87c3): it stays in the report as `acknowledged`, never counts as a failure.

## What it does not prove — never claim

- A covering event proves an agent **claimed** the edit, not that the diff matches what it logged; edit events carry no per-file content hash today. (Rung 4b, later: producers log blob hashes; reconcile compares.)
- A silent agent whose work was committed by a logging agent shows as *covered by the wrong actor* only if the silent agent's files are disjoint from the logger's; if they overlap, the silent work is invisible. Producer signing (rung 5) narrows this.
- Human edits are outside the ledger by design.

## Build — phase A (this session)

1. `packages/core/src/reconcile.ts` (+ test) — pure, portable: `reconcile(commits: CommitFacts[], events: Event[], {repoName, uncovered: "warn"|"fail"}) → ReconcileReport` (`commits[]` verdicts, `orphans[]`, `summary` counts). Fixtures: covered, uncovered, misattributed (a bfe87c3 replay), rename, loose ids, missing commit, merge, acknowledged.
2. `packages/mcp-server/src/reconcile.ts` + `retrace-export reconcile [--repo .] [--since <ref>] [--limit N] [--json] [--gate]` — walks `git rev-list`, builds facts via `commitToEvent`, pulls one verified full export (`/projects/:p/export`), runs core, prints a table; exit 1 on any fail-level finding when `--gate`.
3. `doctor --gate`: one new finding, **capture coverage**, for HEAD only (cheap: HEAD's files, one export fetch). Levels per the table; `.retrace.json` may set `"reconcile": {"uncovered": "fail"}` per repo once its producers are complete.
4. `retrace-checkpoint.yml`: run `reconcile --since <last checkpointed commit>` daily and put the summary in the checkpoint PR body; the job fails on `misattributed`/`missing_commit`.
5. Acceptance: run it on this repo's history. Expected: bfe87c3 → `misattributed (acknowledged)`; Gemini's commits → `uncovered`; everything since the hook was installed → present. Those real numbers are the landing-page sentence — and are published only if they hold.

Estimate: ~400 lines including tests; one session. Files touched are all claude-code's (`doctor.ts`, `export-cli.ts`, workflows, new modules); `git-hook.ts` is imported, not edited.

## Later phases

- **B — GitHub vs hook** — **BUILT 2026-09-01**, awaiting two config steps. What changed: push events get their own key `gh:push:<repo>:<sha>` (the old `git:<sha>` collapsed both producers into one event); actor resolution moved to core `commit-actor.ts` so the webhook and the hook resolve the same actor from the same message (the old mapping stamped the git author as a human, so every agent commit would have "disagreed"); reconcile adds `producer_disagreement` — fail when hook and stamped webhook name different actors, warn when only one producer sealed a commit after both were active, and a push-shaped event without the server's `webhook:github` stamp seals nothing. Also fixed on the way: the gate's shallow checkout made HEAD's diff the whole repo (now fails closed; `fetch-depth: 2`). **Jordan's steps:** add `push` to the repo webhook's events; set `RETRACE_GITHUB_PUSH = "1"` in `apps/worker/wrangler.toml` `[vars]` and `npx wrangler deploy`.
- **C — Drive**: Drive change feed vs `google-drive` project events. Out of scope until a Drive user exists.

## Decisions for Jordan

- **A. Default gate level for `uncovered`** — *recommended: warn*. `fail` breaks every Gemini commit on day one; promote per repo via `.retrace.json` once producers are complete.
- **B. Where the full-history run lives** — *recommended: the daily checkpoint workflow*. Running it on every gate needs `fetch-depth: 0` and a full export per PR.
- **C. Base for the daily run** — *recommended: since the last checkpointed commit*, plus a one-time full backfill report in the first PR.
- **D. Log reconcile results to the ledger?** — *recommended: no*. The PR body carries the summary; acknowledgements already live in the ledger as `correction` events.

Reply "go" with any changes to A–D and I build phase A.
