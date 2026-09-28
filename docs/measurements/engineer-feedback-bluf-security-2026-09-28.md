# Measurement — engineer feedback, 2026-09-28: BLUF verification and keys/back-end security

**Class (b)** under agent-rules 12: a dated measurement. It changes no rule and implements nothing. Recommendations below are labelled as recommendations for Jordan and the coordinator to route later.

**v2, 2026-09-28 16:42 MDT / 22:42Z — corrections from Codex round 1** (`evt_99bf82bb25ca414aa940e2ece0835fcd`, COMMENT 5345375860; copy sha256 `7864f9d0984b1bdd7a79e93407d8fbb98e9d8acf9c4f682c05467d6de30fc1f8`). Applied in place on Jordan's go `evt_511861e335784a82b34c2d0f90417fe6`, routing `evt_4beb9bba8593461bb34db176684c241d`, this seat's instruct `evt_9328a087f3544b968cd0cba919414277`. Findings applied: R1-M1, R1-M2, R1-M3, R1-L1, R1-L2, R1-L3, R1-L4, R1-L5. Earlier v1 text stays visible where a claim changed (agent-rules 10).

**Provenance.** Grok seat (`GROK.md`), measurer. Jordan's signed instruction `evt_10f46239a3ce47088847f83020b0ef1f`. Coordinator routing `evt_6813fa8969854e83bae4dd0be8e0bc43`. Sent pointer `evt_741a0415a6ea4db1aafd3faf01e9889e` (verified, `evt_9c92ed5f9c5143bf8624247d0515e4dc`). This seat's instruct `evt_48eef6caeed745bc93e9c9518a9dac13`. Session `01a0e990-dc1c-70f2-9fce-4c6f61db2478`. Model displayed: `Grok 4.6 (high)` (`harness-display`); `method.params.reasoning_effort`: `high`. Worktree `jordandru/grok-bluf-security-assessment` at main `b54b47d8`. Brief `~/.retrace/ops-2026-09-28/brief-grok-engineer-feedback.md` sha256 `96455ef19cf6177c22fbcc089cad65167d3e501f0fc2435bc199fc238d0df533`. v2 session `01a0ea2a-5ce4-7aa2-9a81-40c65b351cb2`; same displayed model and effort.

Weekly budget: TUI `/usage` is not reachable from this agent tool loop; `grok usage 01a0e990-dc1c-70f2-9fce-4c6f61db2478` reported no recorded totals; remaining credits unobserved.

A third line in the source thread ("How do you market it?") is out of scope.

Times below are Mountain first (MDT, UTC−6), UTC alongside. `date -u` / `date` immediately before this file was written: **14:06:38 MDT / 20:06:38Z 2026-09-28**. v2 corrections written **16:42:57 MDT / 22:42:57Z 2026-09-28**. Command times are the `date -u` taken next to that command.

---

## A. Point 1 — is verification "super simple", BLUF-first?

Question asked: does a verdict come first (one line: VERIFIED / NOT VALID, what that covers, what it does not cover, where to dig)? Surfaces run as a stranger would. First three lines of each command's combined terminal output are quoted verbatim, including the Node SQLite experimental warning when it printed. Correction 2026-09-28 (Codex r1 **R1-L2**): those SQLite warning lines are stderr, not stdout. Separate captures print VALID/VERIFIED first on stdout and after the warnings in the terminal. The BLUF's "first" means the first verdict words, with that qualification. The command verdicts themselves match.

### A.1 `retrace-export verify` — live `GET /projects/retrace/export` with `--pubkey`

Landing-page command shape (`site/landing/index.html:122`):

```
npx -y --package=@retrace-dev/cli retrace-export verify retrace-ledger.json --pubkey https://retrace-api.slcwitit.workers.dev/.well-known/retrace-pubkey
```

Fetch (13:57:58 MDT / 19:57:58Z), grok credential, curl to `https://retrace-api.slcwitit.workers.dev/projects/retrace/export`:

| header | value |
|---|---|
| HTTP | 200 |
| `x-retrace-export-cache` | `stale` |
| `x-retrace-export-cached-head` | `7697` |
| `x-retrace-export-generated-at` | `2026-09-24T18:07:55.197Z` |
| `x-retrace-export-live-head` | `8940` |
| body | 15,434,198 bytes; `chain.total_events` 7698 |

`docs/reference.md:111` already names `stale` / cached-head / live-head. Issue **#132** (OPEN) is this same cache: generated 2026-09-24T18:07:55Z, head #7697. Live head at fetch was #8940; status later in this session counted 8941–8945 as writes continued.

Verify of that file (13:59:49–14:00:25 MDT / 19:59:49–20:00:25Z), first three lines:

```
(node:3803630) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
VALID — signature: valid (kid 51f6ac4c7ba7be66, trusted key from --pubkey https://retrace-api.slcwitit.workers.dev/.well-known/retrace-pubkey); events intact: true; links: true; chain ok at export: true; coverage: complete — 7698 of 7698 events; 996 legacy-hash events (received_at not provably covered); producer sigs: 4271 verified · 1 INVALID · 1697 unsigned agent events
```

Fourth line named coverage as a full export (contiguous from #0, head is the issuer's claim). A later line named event **#5589**: `producer signature does not verify — signed fields altered, or the wrong key`. Exit 0, overall `VALID`.

Correction 2026-09-28 (Codex r1 **R1-M3**; this session GET `/events/evt_d04b7cc9dd054246a475386c622b4c4d`): #5589 records actor `openclaw`, `producer_sig_verdict` `unknown_kid`, `producer_sig.kid` `e0c4934645522e62` (NOOA's kid), `sealed_by` `pinned:retrace · openclaw for jordansboxing@gmail.com`. Codex's offline check (`evt_99bf82bb25ca414aa940e2ece0835fcd`): changing only `actor.id` to `nooa` makes `verifyProducerSig` pass; adjacent #5588 with the same ingestion stamp verifies unchanged. `producer-sig.ts:403–420` recomputes against bundle keys independently of the ingestion stamp. This is issue **#96**'s Worker identity rewrite (NOOA's signature sealed under the bearer-resolved actor), not a forged signature. The quoted INVALID line and the overall VALID stand.

What the first verdict line covers: signature against the published key, content hashes, prev_hash links, omission (v1 wrote `1585/7698 present`; Correction 2026-09-28, Codex r1 **R1-L1**: this live bundle is **7698/7698** present, contiguous from #0; 1585 is the snapshot's `chain.total_events` in A.2). What it does not: the live head past #7697 (the bundle is a complete signed export of a stale claim); the 996 legacy-hash events whose `received_at` is not provably covered (`docs/reference.md:113`); the one INVALID producer signature still inside a VALID bundle (#5589 / #96, above); head-rewrite between checkpoints (`docs/reference.md:115`).

### A.2 Same command on the pre-verified snapshot (`ledger-2026-09-03`)

`gh release download ledger-2026-09-03 --repo jordandru/retrace` (13:58:20 MDT / 19:58:20Z): `retrace-ledger.json` 2,243,741 bytes, `chain.total_events` 1585, `generated_at` 2026-09-03T18:07:48.627Z. Assets also included `checkpoints.jsonl`, `witnesses.jsonl`, `checkpoint-public.jwk`, `rekor-public.pem`.

Landing command run from that directory (13:59:49 MDT / 19:59:49Z), first three lines:

```
(node:3803308) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
VALID — signature: valid (kid 51f6ac4c7ba7be66, trusted key from --pubkey https://retrace-api.slcwitit.workers.dev/.well-known/retrace-pubkey); events intact: true; links: true; chain ok at export: true; coverage: complete — 1585 of 1585 events; 996 legacy-hash events (received_at not provably covered); producer sigs: 0 verified · 0 INVALID · 1127 unsigned agent events
```

Exit 0. The landing-page command does **not** pass `--checkpoint` / `--checkpoint-pubkey` / `--witnesses`, even though the release ships those files. Adding them (14:02:59 MDT / 20:02:59Z):

```
npx -y --package=@retrace-dev/cli retrace-export verify retrace-ledger.json \
  --pubkey https://retrace-api.slcwitit.workers.dev/.well-known/retrace-pubkey \
  --checkpoint checkpoints.jsonl --checkpoint-pubkey checkpoint-public.jwk --witnesses witnesses.jsonl
```

Checkpoint line: `checkpoint #1337 (2026-09-02T05:21:31.030Z, signature valid, kid 99a723c89eaa02fb, trusted key from --checkpoint-pubkey checkpoint-public.jwk): EXTENDS — bundle contains the checkpointed head #1337 unchanged and continues to #1584`. Witness line: `witnessed by Rekor log index 2683576008 at 2026-09-02T05:21:31.000Z`. Exit 0.

Without `--checkpoint-pubkey`, the same checkpoint printed `NOT VERIFIED — no trusted checkpoint key` and the process exited 2, **after** the bundle line still said `VALID`. A stranger who copies only line 122 of the landing page never sees EXTENDS / Rekor.

### A.3 `retrace status` / `retrace_status`

MCP `retrace_status` project `retrace` (13:58:55 MDT / 19:58:55Z), first three lines of the allowlisted view:

```
«retrace» — VERIFIED
8941 events · 98.1% causal coverage · 103/1053 unlinked commits · 344 unverified links · 10 legacy-client seals
557/5636 agent events missing model (2 declared none · 555 no source recorded) · 177/1769 instructions without follow-up · 113/26808 artifact refs missing role
```

CLI, this checkout's `doctor.js status` from the worktree (14:02:59 MDT / 20:02:59Z), first three lines:

```
(node:3808574) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
«retrace» — VERIFIED
```

`npx -y --package=@retrace-dev/cli retrace status retrace`, first three lines:

```
(node:3808819) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
retrace — VERIFIED
```

Health word is `VERIFIED` when `integrity.ok` (`packages/core/src/status.ts:264`). The same line's body already lists unlinked commits, unverified links, unstamped seals (`947 unstamped` on the MCP JSON), and `1526/5636 agent events not pinned`. Verdict comes first on this surface. Scope is chain integrity plus capture/causality aggregates. It does not prove the live export cache is current (#132), and it does not name VALID/NOT VALID the way `verify` does.

### A.4 `retrace doctor` and `doctor --gate`

Command: `node /home/jordandrumiler/provenance/retrace/packages/mcp-server/dist/doctor.js doctor` from this worktree (13:57:55 MDT / 19:57:55Z), first three lines:

```
(node:3798482) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
PASS  object store — no empty loose objects; HEAD is a readable commit; origin/main is a readable commit
```

Last line: `READY — 15 passed, 2 warnings, 0 failures`. The verdict is printed at `packages/mcp-server/src/doctor.ts:1004`, after every finding.

`doctor --gate`, same binary, first run (13:58:31 MDT / 19:58:31Z), first three lines:

```
(node:3798755) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
PASS  object store — no empty loose objects; HEAD is a readable commit; origin/main is a readable commit
```

That run ended `FAIL  HEAD delivery — fetch failed` / `NOT READY — 9 passed, 0 warnings, 1 failures` (exit 1). Retry (14:05:17 MDT / 20:05:17Z) ended `READY — 15 passed, 137 warnings, 0 failures`, with capture coverage naming `signed cache through #7697; chain-verified tail #7698..#8944 verified against signed live head`. Agent-ops 11 already records doctor flake on WSL2 fetch timeout; this is that shape on `--gate` HEAD delivery.

A stranger's first three lines are PASS rows, not READY/NOT READY.

### A.5 `retrace_why` / `retrace_history` for the merge of PR 130 (`b54b47d8`)

`retrace_history` action `merged`, text `b54b47d8`, limit 5. First three lines of the allowlisted view:

```
attribution amendments: 1 effective · 0 ineffective · 0 superseded
#8702 2026-09-26T06:46:49.000Z  «claude-code» [agent: «claude-fable-5-1»] on behalf of «jordansboxing@gmail.com» merged «jordandru/retrace@b54b47d» (out), «docs/design/github-owner-login-attribution.md» (out) @ «/home/jordandrumiler/provenance/retrace-main» via «git» — why: «Merge PR #130: docs(design): GitHub owner-login attribution v1.4 — P1 note (#82, #69), class (a) Design note for evaluation plan P1: stop sealing agents' gh actions as the human owner. Gate complete at fbaf1bcf: Codex approved evt_8e8e44861d2f4c21be7c1cd2d034564c (round 5, one Low R5-L1 open for the next touch), NOOA approved evt_c8a9b71b16ca45cd857ee541f18c23d3 (round 5), Grok seat (cursor-agent, Jordan's reassignment evt_cd9d5b806e574250bfa6069f14fd280f) approved evt_6aea643f7dd74cc099f4d5bd4df56f1a (round 2). Gate check evt_f5f80e2e5b4040efa62049e26e1c6666. Merge go evt_d59b55206e2948f9b28f318bdbc47821.»
#8704 2026-09-26T06:48:30Z  «jordandru» merged «PR #130 docs(design): GitHub owner-login attribution v1 — P1 note (#82, #69), class (a)» (in), «jordandru/retrace@b54b47d» (out) @ «https://github.com/jordandru/retrace/pull/130» via «github» — why: «## What `docs/design/github-owner-login-attribution.md` v1 — the P1 design note of `docs/design/evaluation-response-plan-2026-09-24.md` (§4 P1; issues #82, #69). **Class (a)** under agent-rules 12: it governs how the Worker writes the WHO of GitHub webhook events, adds project-policy fields (`gith…»
```

JSON in the same payload named hook seal `evt_188ad0905aa6418ab81943751ed45083` (seq 8702). `retrace_why` on that id, first two human lines (the chain is two events):

```
#8702 2026-09-26T06:46:49.000Z  «claude-code» [agent: «claude-fable-5-1»] on behalf of «jordansboxing@gmail.com» merged «jordandru/retrace@b54b47d» …
  ↳ because #8701 2026-09-26T06:46:06.865Z  «jordansboxing@gmail.com» instructed … «Go merge PR 130 — Jordan's go …»
```

No VERIFIED / NOT VALID line. The tools are an allowlisted view without ids or hashes in the prose (agent-rules 15); they are not the verification surface.

### A.6 `retrace-export reconcile --limit 20`

Observed invocation from this checkout (`npm view` 14:04:44 MDT / 20:04:44Z) `npx -y --package=@retrace-dev/cli@0.2.0 retrace-export --help` first line:

```
retrace-export <keygen|export <project>|verify <bundle.json>|share <project>> [--artifact id] [--out f] [--report f.html] [--pubkey jwk|url] [--label s] [--days n]
```

`npx -y --package=@retrace-dev/cli@0.2.0 retrace-export reconcile --limit 20` printed that usage line and did not run the check (exit 0). This laptop also has `/home/jordandrumiler/.nvm/versions/node/v22.23.2/bin/retrace-export` on PATH with the same old usage. v1 read that as published 0.2.0 lacking `reconcile`. Related: issues **#85–#89** (stranger-install rough edges, OPEN).

Correction 2026-09-28 (Codex r1 **R1-M1**; re-measured 16:40:49 MDT / 22:40:49Z). The same npx invocation from this checkout resolves `command -v retrace-export` to `/home/jordandrumiler/.nvm/versions/node/v22.23.2/bin/retrace-export`, the **global** `@retrace-dev/cli` **0.1.1** (symlink to `../lib/node_modules/@retrace-dev/cli/dist/export-cli.js`; `package.json` version 0.1.1). That is the binary whose help is quoted above. From a clean directory `/tmp/retrace-pr134-fix-r1`, the same `npx -y --package=@retrace-dev/cli@0.2.0 -c 'command -v retrace-export'` resolves to `/home/jordandrumiler/.npm/_npx/e938bbef1fba64a7/node_modules/.bin/retrace-export`; its `package.json` is `@retrace-dev/cli` **0.2.0**; its help first line is:

```
retrace-export <amend-attribution|render <bundle.json>|keygen|producer-keygen|export <project>|verify <bundle.json>|checkpoint <project>|witness <project>|reconcile|share <project>> [--artifact id] [--out f] [--report f.html] [--pubkey jwk|https-url] [--allow-self-attested] [--checkpoint f.jsonl] [--checkpoint-pubkey jwk|https-url] [--bundle f.json] [--label s] [--days n] [--actor id]
```

Running that published 0.2.0 binary from this worktree (`/home/jordandrumiler/.npm/_npx/e938bbef1fba64a7/node_modules/.bin/retrace-export reconcile --limit 20`, 16:41:22 MDT / 22:41:22Z): `20 commits, 20 sealed — 0 missing, 0 misattributed, 1 producer-disagreement, 13 unreachable-seal, 1 uncovered, 0 loose, 0 non-agent, 11 orphan paths, 3 pending → OK`. Published 0.2.0 ships `reconcile`. The v1 "stranger on npm 0.2.0 never sees this" was PATH shadowing of npx by the global 0.1.1 binary, not the published package.

This checkout's dist (primary `packages/mcp-server/dist/export-cli.js`) first three lines (14:04:44–14:05:37 MDT / 20:04:44–20:05:37Z):

```
(node:3810611) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
reconcile jordandru/retrace: 20 commits, 20 sealed — 0 missing, 0 misattributed, 1 producer-disagreement, 13 unreachable-seal, 1 uncovered, 0 loose, 0 non-agent, 9 orphan paths, 2 pending → OK
```

The summary line ends `→ OK` and already names counts. Footer: `signed cache through #7697; chain-verified tail #7698..#8945 verified against signed live head`. WARN rows follow (uncovered `docs/owner-protocol.md`, producer_disagreement on `a39cf918e070`, thirteen unreachable_seal). The local dist's 9 orphan / 2 pending and published 0.2.0's 11 / 3 need not match: later ledger, different HEAD.

### A.7 Checkpoint / witness

Did not run `retrace-export witness <project>`: that submits to Rekor (an outward write, agent-rules 14). Observed `verify --checkpoint --witnesses` instead.

| bundle | git/snapshot checkpoint | result |
|---|---|---|
| snapshot `ledger-2026-09-03` + its `checkpoints.jsonl` + `checkpoint-public.jwk` + `witnesses.jsonl` | #1337 @ 2026-09-02T05:21:31Z | `VALID` + `EXTENDS` to #1584 + Rekor index **2683576008** |
| live stale export + worktree `.retrace/checkpoints.jsonl` + `.retrace/checkpoint-public.jwk` + `.retrace/witnesses.jsonl` | last git checkpoint **#4098** @ 2026-09-14T05:07:57.778Z | `VALID` + `EXTENDS` to #7697 + Rekor index **2830817671** @ 2026-09-14T12:49:34Z |

Worktree `.retrace/checkpoints.jsonl` has 17 lines; last is seq 4098 / 2026-09-14. `gh pr list` for "checkpoint" (14:04:11 MDT / 20:04:11Z): v1 wrote ten OPEN PRs, newest **#124** "Checkpoint retrace head #7697" opened 2026-09-25T11:53:10Z, then #120 (#7677, 09-24), #106, #102, #100, #94, #81, #75, #70, #64. Correction 2026-09-28 (Codex r1 **R1-L4**; re-listed 16:41:22 MDT / 22:41:22Z): there are **eleven** open checkpoint PRs, the listed ten plus **#52** "Checkpoint retrace head #4602" opened 2026-09-15T11:45:55Z, before this measurement. An unrestricted `gh pr list --search checkpoint --state open` also returns this measurement PR #134 and the unrelated credential-store PR #42. The stale/unmerged-anchor conclusion is unchanged. Daily git-anchor PRs are open and unmerged; they re-checkpoint the stale cache head #7697, which is issue **#132**.

Issue #132 also says the Worker hourly D1 checkpoint cron was healthy through 2026-09-27 (this session did not query D1). The git-committed checkpoint file this worktree carries is 14 days behind live head.

### A.8 README quick start and `docs/examples.md` (read, not run)

README.md first three lines:

```
# Retrace

**A flight recorder for AI coding agents.** Every event records **who** (person or agent, server-stamped) did **what**, **when**, **where**, **why** — a `caused_by` chain back to the human instruction — and **how**, sealed in a tamper-evident hash chain that anyone can verify offline.
```

The first screen does not say what a green `VALID`/`VERIFIED`/`READY` proves. Hosted verify with `--pubkey` is at README.md:61–64. Local quick start (README.md:52–58) is `--allow-self-attested`.

`docs/examples.md` first three lines:

```
# Retrace by example — the problem, then the proof

Retrace is a provenance ledger for AI coding agents. Every event records **who** did **what**, **when**, **where**, **why** (a `caused_by` chain back to the human instruction) and **how**, sealed in a hash chain that anyone can verify offline.
```

§6 (`docs/examples.md:104–109`) shows a `VALID` transcript claiming `coverage: complete — 4 of 4 events` for the public NOOA share. Issue **#88** (OPEN) records that the same command today yields 6 of 6 plus `context_missing`. The first screen of examples.md tells the reader the snapshot exists; it does not lead with a verdict.

Landing CTA (v1 cited `site/landing/index.html:108`; Correction 2026-09-28, Codex r1 **R1-L3**: the command is at **`:107`**, `:108` is `</div>`) is `npx -p @retrace-dev/cli retrace doctor`, whose READY line is last (A.4). The prove-it transcript (`site/landing/index.html:156–162`) is labelled as a later 2,646-event export that is **not** the downloadable snapshot (`:154`).

Related queued design, not this measurement: `docs/design/retrace-ai-digest.md` (read-only digest; not built). Public-claim sweep: issue **#74** (OPEN).

### A.9 Recommendation (not a change)

One-line BLUF contract per surface, for Jordan/coordinator to route:

| surface | recommended first line | file it would touch |
|---|---|---|
| `retrace-export verify` | `VALID`/`NOT VALID` · signature · coverage (complete \| scoped) · named gaps (legacy-hash, INVALID producer sig, stale cache) · next flag (`--checkpoint-pubkey`) | `packages/mcp-server/src/export-cli.ts` (and suppress the SQLite warning on this bin); landing `site/landing/index.html:122` to add `--checkpoint checkpoints.jsonl --checkpoint-pubkey checkpoint-public.jwk --witnesses witnesses.jsonl` |
| `retrace status` / `retrace_status` | already `VERIFIED`/`BROKEN` first (`packages/core/src/status.ts:264`); add one clause for export-cache stale vs live head | `packages/core/src/status.ts`; MCP renderer |
| `retrace doctor` / `--gate` | print `READY`/`NOT READY` as line 1, then findings (`packages/mcp-server/src/doctor.ts:1004`) | `packages/mcp-server/src/doctor.ts` |
| `retrace_why` / `retrace_history` | one line `chain: rooted \| broken \| unverified-link` before the dump | MCP `why`/`history` renderer in `packages/mcp-server` |
| `retrace-export reconcile` | keep `→ OK`/`NOT OK` on line 1 of the summary. v1: "ship that subcommand on npm (0.2.0 help lacks it)". Correction 2026-09-28 (Codex r1 **R1-M1**): published `@retrace-dev/cli@0.2.0` already ships `reconcile` (A.6). Recommend documenting that `npx --package=@retrace-dev/cli@0.2.0` from a directory whose PATH contains an older global `retrace-export` (this laptop: 0.1.1) runs the global binary. | `packages/mcp-server/src/export-cli.ts`; stranger-install issues **#85–#89**; no new publish required for `reconcile` |
| README / examples / landing first screen | one sentence: green `VALID` with `--pubkey` proves signature+hashes+links+omission of **that bundle's claimed head**; it does not prove the live head or a checkpoint | `README.md`, `docs/examples.md`, `site/landing/index.html` |

Do not fold this into `docs/design/retrace-ai-digest.md`; that is a ranked digest of findings, a different product.

---

## B. Point 2 — keys and back end: what is done, what is open, stated honestly

### B.1 In place (file:line or event, and a live command where this session ran one)

- **Ed25519 producer signatures, verified server-side.** `packages/core/src/producer-sig.ts:1–28` (server never holds the private key; verdict stamped). `packages/core/src/router.ts:842–849` `producerSigCheck` then `require_signature` 401. Live: snapshot verify `producer sigs: 0 verified · 0 INVALID · 1127 unsigned agent events`; live stale export `4271 verified · 1 INVALID · 1697 unsigned` (the INVALID is event #5589). Correction 2026-09-28 (Codex r1 **R1-M3**, A.1): #5589 is `evt_d04b7cc9dd054246a475386c622b4c4d`, actor `openclaw`, ingestion stamp `unknown_kid`, NOOA's kid `e0c4934645522e62`; changing only `actor.id` to `nooa` verifies. Issue **#96**'s identity rewrite, not a forged signature. Adjacent #5588 with the same stamp verifies. Overall VALID stands.
- **Pinned per-seat credentials and `sealed_by` stamps.** `packages/core/src/router.ts:291–300` `sealedBy` / `stampSealedBy` (server wins). MCP status this session: `sealed by: 5658 pinned · 426 assert · 1853 webhook · 57 owner-asserted · 0 unauthenticated · 947 unstamped; 1526/5636 agent events not pinned`.
- **`hash_v: 2` and `received_at` in the hash.** `packages/core/src/chain.ts:42–57` (`HASH_VERSION = 2`; stripping the marker is tampering). Verify lines above count `996 legacy-hash events (received_at not provably covered)`.
- **HMAC-verified GitHub webhook.** `packages/core/src/github.ts:28–37` `verifyGithubSignature` (HMAC-SHA256, constant-time compare). Status integrations: `github` 1893 events, last 2026-09-28T19:49:22Z.
- **Hourly D1 checkpoints witnessed in Rekor.** `packages/core/src/checkpoint.ts:1–13`, `docs/reference.md:117`. This session verified a git-committed witness (Rekor 2830817671 for checkpoint #4098, 2026-09-14) and the snapshot witness (2683576008). Did not query D1. Issue #132 reports the hourly cron still writing through 2026-09-27.
- **Key custody rules.** Agent-rules 13 (keys stay with the seat). Agent-ops 16 terminal boundary. Agent-ops 17 Docker is root. This measurement used the grok MCP token from process config for GET /events and GET /export and did not print it.
- **`retrace-serve` default-closed.** `packages/mcp-server/src/serve.ts:46` `DEFAULT_HOST = "127.0.0.1"`; `:61–65` `RETRACE_OPEN=1` refused off loopback. `docs/reference.md:264`.
- **2026-08-30 security assessment fixes.** `docs/reference.md:261`: signatures `self_attested` without a trusted key; `checkpoint` requires one; `hash_v: 2`; full bundle missing the checkpointed seq is `CONFLICT`. Observed: verify without `--pubkey` is documented as NOT VALID / self_attested (`site/landing/index.html:157`); this session always passed `--pubkey`.
- **Workers Paid after the 503 CPU-limit incident.** Instruction `evt_2a889f251e1e414186bf83ea5040d3d8` (seq 1996) records Jordan upgraded to Workers Paid 2026-09-06 (~11:05 MDT), ledger **#1979**; commit `44a42dd` / `evt_dfa39a045e16488592aa0901c8194b02` (seq 1982) enables Workers Logs "now that the account is on Workers Paid". `docs/reference.md:111` names the 2026-09-03 503/error-1102 wall at ~1.5k events. This session's GET /export was HTTP 200 (stale cache, O(1)).

### B.2 Open, by issue

- **#96 OPEN** — a producer signature whose kid belongs to another credential is accepted (`unknown_kid`, sealed as the bearer). `router.ts` `producerSigCheck` against that one credential's key. `require_signature` (`router.ts:847`) is the live-path close for seats that have it; evaluation-plan P8 / §6 Q11, Jordan's decision pending.
- **#97 OPEN** — `retrace-admin retire-agent` retires a record, not a secret; mirror/deployment drift. This session `GET /api` (14:04:11 MDT / 20:04:11Z) returned `credentials: 12`. Issue text (2026-09-20) was 13 mirrored vs 11 deployed. Did not read `~/.retrace/worker-credentials*.json` (agent-rules 13).
- **#69 OPEN** — four live agent credentials unscoped across projects (claude-code, codex, grok, github-copilot). Client `RETRACE_PROJECT_LOCK` is not the Worker. P1 note `docs/design/github-owner-login-attribution.md` is on main (`b54b47d8`); it does not close the Worker scope.
- **#82 OPEN** — owner `gh` login shared by every seat; webhook seals those actions as `human` `github:jordandru`. Status this session: `human/github:jordandru` 673 events. The merged P1 note (`docs/design/github-owner-login-attribution.md:368–378`, §6 step 5) is the design for per-seat GitHub Apps; not built.
- **#61 OPEN** — Drive adapter has no agent branch (`packages/core/src/gdrive.ts`); activity seals as the account owner. Status integrations: `google-drive` 12 events, last 2026-08-29T21:52:03.863Z.
- **#132 OPEN** — export cache stale since 2026-09-24T18:07:55Z; daily checkpoint re-checkpoints head #7697; Rekor 409 misread. **Reproduced this session** (A.1, A.7): `x-retrace-export-cache: stale`, cached-head 7697, live-head 8940 at fetch; open PR #124 "Checkpoint retrace head #7697".
- **#131 OPEN** — `events?since=` compares the raw `timestamp` string; push-webhook commit seals with offset-bearing times are missed (`packages/core/src/store.ts` / `d1-store.ts`). Not re-run here.
- **Agent-ops 13** — credentials live in Worker secrets `RETRACE_CREDENTIALS` / `RETRACE_CREDENTIALS_EXTRA`. v1 called this a **direction**, not a plan, until where they live, what the Worker holds at runtime, and who may mint are answered. Correction 2026-09-28 (Codex r1 **R1-M2**): that store is an **unmerged design**, not an unanswered direction. PR **#42** is OPEN at `8979b0294f677a208165f97c764442bbbc38d98f` with the 561-line `docs/design/credential-store.md`. Evaluation-plan P8 (`docs/design/evaluation-response-plan-2026-09-24.md:491–493`) routes #42 through the class-(a) gate, then build, and says it answers agent-ops 13's three questions. None of it is built.
- **Evaluation-response plan P8 and §6 Q11** (`docs/design/evaluation-response-plan-2026-09-24.md:488–515, :620–624`) — mandatory producer signatures on every pinned seat; Jordan's decision pending. Recommendation in that note: refuse another credential's kid first, then mandate signatures seat by seat.

### B.3 What "super secure" would additionally require

Name them plainly. None of these are built, and this note does not promise them. Correction 2026-09-28 (Codex r1 **R1-M2**): v1's heading said "that is not on the plan" and treated every item as absent from the plan. Distinguish unmerged design / planned owner actions / pending recommendation / genuinely new. None being implemented does not make all of them absent from the plan.

- An **independent external audit** — **pending recommendation.** Evaluation-plan §6 Q8 (`docs/design/evaluation-response-plan-2026-09-24.md:606–608`): pause the paid Team offer or state the open defects until P1 and P8 land, then commission an independent assessment. Not scheduled.
- **Per-seat GitHub identities** — **planned owner actions**, not built. P1 note §6 step 5 (`docs/design/github-owner-login-attribution.md:368–378`): one GitHub App per seat. Owner actions, one go each. Until then #82 stands.
- A **credential store** — **unmerged design**, not built. PR **#42** OPEN (`8979b029`, 561-line `docs/design/credential-store.md`). Evaluation-plan P8 `:491–493` routes it through review then build. Agent-ops 13's three questions are the questions that design answers.
- A **key rotation cadence** — **genuinely new** (no merged policy names how often producer keys or Worker tokens rotate).
- A **threat model document** — **genuinely new** (none in `docs/design/` under that name; the 2026-08-30 assessment fixes are listed in `docs/reference.md:261`, not a threat model).

Docker-as-root (agent-ops 17) and terminal-boundary (agent-ops 16) are environment rules on this laptop, not product guarantees a stranger gets.

### B.4 BLUF for Jordan (≤ 120 words)

**v2 (Codex r1):** A stranger gets VALID/VERIFIED first on `verify --pubkey` and `status` (stderr SQLite warnings print first). Doctor prints READY last. Snapshot EXTENDS #1337 (Rekor 2683576008) with `--checkpoint-pubkey`; landing CTA `site/landing/index.html:107` omits that flag. Live export cache sits at #7697 (2026-09-24) while live was ~#8945 (#132). In place: Ed25519 producer sigs, pinned sealed_by, HMAC webhook, hash_v:2, loopback retrace-serve, Workers Paid (seq 1979). The 1 INVALID is #5589 (`evt_d04b7cc9dd054246a475386c622b4c4d`): actor `openclaw`, `unknown_kid`, NOOA's kid; changing only `actor.id` to `nooa` verifies — #96's identity rewrite, not a forged signature; overall VALID. Open: #96, #97, #69, #82. Planned, none built: PR #42 credential store (unmerged), per-seat GitHub Apps (P1 §6 step 5), independent assessment (eval-plan §6 Q8). New: rotation cadence, threat model.

**v1 (kept):** A stranger gets VALID/VERIFIED first on `verify --pubkey` and `status`. Doctor prints READY last. Snapshot EXTENDS #1337 (Rekor 2683576008) with `--checkpoint-pubkey`; the landing one-liner omits that flag. Live export cache sits at #7697 (2026-09-24) while live is ~#8945 (#132). In place: Ed25519 producer sigs, pinned sealed_by, HMAC webhook, hash_v:2, loopback retrace-serve, Workers Paid (seq 1979). Open: #96, #97, #69, #82. Super-secure still needs an independent audit, per-seat GitHub Apps, a credential store, rotation cadence, and a threat model.

---

## C. Record

Instruct `evt_48eef6caeed745bc93e9c9518a9dac13`. Received `evt_9c92ed5f9c5143bf8624247d0515e4dc`. Measurement execute `evt_43c6c0825b984588b9e996f17c15b8ea`. Routing `evt_6813fa8969854e83bae4dd0be8e0bc43`.

v2 instruct `evt_9328a087f3544b968cd0cba919414277`. v2 received `evt_eeb76ae0cf054febbeb099d6be7789a6`. v2 execute `evt_1d6fd6ca949e4e4b87e868abf3eb1736`. Routing `evt_4beb9bba8593461bb34db176684c241d`. Codex r1 `evt_99bf82bb25ca414aa940e2ece0835fcd`. Jordan go `evt_511861e335784a82b34c2d0f90417fe6`.

| when (MDT / UTC) | what | quoted / sealed |
|---|---|---|
| 13:52:55 / 19:52:55Z | `sha256sum` brief; pointer text sha256 | brief `96455ef19cf6177c…`; text `716c247c495bf18d…` |
| 13:53:59 / 19:53:59Z | `GET /events/evt_741a0415…` | action `sent`, actor `claude-code`, `sealed_by` `pinned:claude-code MCP (pinned) (signing)`, `producer_sig_verdict` `verified`, hashes match |
| 13:56:04 / 19:56:04Z | `retrace_log` received | `evt_9c92ed5f9c5143bf8624247d0515e4dc` seq 8939 |
| ~13:56 / ~19:56Z | `retrace_instruct` | `evt_48eef6caeed745bc93e9c9518a9dac13` |
| 13:57:58 / 19:57:58Z | `GET /projects/retrace/export` | stale, cached-head 7697, live-head 8940, generated 2026-09-24T18:07:55.197Z |
| 13:57:55–13:58:31 / 19:57:55–19:58:31Z | `doctor` / `doctor --gate` | READY 15/2/0; gate FAIL HEAD delivery fetch |
| 13:58:20 / 19:58:20Z | `gh release download ledger-2026-09-03`; `gh issue view` 96,97,69,82,61,132,131,74,85–89 | snapshot 1585 events; issues OPEN as filed |
| 13:58:55 / 19:58:55Z | MCP `retrace_status` | `«retrace» — VERIFIED`, 8941 events |
| 13:59:49–14:00:25 / 19:59:49–20:00:25Z | npx verify snapshot + live | both `VALID` (A.1, A.2) |
| 14:02:07–14:03:40 / 20:02:07–20:03:40Z | verify `--checkpoint --witnesses` | snapshot EXTENDS #1337 Rekor 2683576008; live EXTENDS #4098 Rekor 2830817671 |
| 14:02:59 / 20:02:59Z | CLI `retrace status` | `«retrace» — VERIFIED` / `retrace — VERIFIED`, 8943 events |
| 14:04:11 / 20:04:11Z | `GET /api`; `gh pr list` checkpoint | credentials 12; PR #124 OPEN head #7697. v1 also assigned the gate retry to this timestamp (Codex r1 **R1-L5**); A.4's 14:05:17 / 20:05:17Z is the retry. Split here. |
| 14:04:44–14:05:37 / 20:04:44–20:05:37Z | reconcile `--limit 20` | v1: npm 0.2.0 old usage (PATH global 0.1.1); local dist: `→ OK` |
| 14:05:17 / 20:05:17Z | `doctor --gate` retry | READY 15/137/0 (A.4; Codex r1 **R1-L5**) |
| 14:07:25 / 20:07:25Z | `retrace_log` executed | `evt_43c6c0825b984588b9e996f17c15b8ea` seq 8952 |
| 14:06:38 / 20:06:38Z | `date` before writing this file | this section's clock |
| 16:39:54 / 22:39:54Z | v2 `retrace_log` received | `evt_eeb76ae0cf054febbeb099d6be7789a6` seq 9073 |
| ~16:40 / ~22:40Z | v2 `retrace_instruct` | `evt_9328a087f3544b968cd0cba919414277` |
| 16:40:49 / 22:40:49Z | **R1-M1** re-measure npx 0.2.0 from checkout vs `/tmp/retrace-pr134-fix-r1` | checkout → global 0.1.1 `/home/jordandrumiler/.nvm/versions/node/v22.23.2/bin/retrace-export`; clean dir → npx 0.2.0 `/home/jordandrumiler/.npm/_npx/e938bbef1fba64a7/node_modules/.bin/retrace-export`, help includes `reconcile` |
| 16:41:22 / 22:41:22Z | **R1-M1** published 0.2.0 `reconcile --limit 20`; **R1-L4** `gh pr list`; **R1-M2** `gh pr view 42` | 20/20 sealed, 11 orphan, 3 pending `→ OK`; eleven checkpoint PRs including #52; PR 42 OPEN `8979b029`, 561-line `credential-store.md` |
| 16:41 / 22:41Z | **R1-M3** GET `evt_d04b7cc9dd054246a475386c622b4c4d` | seq 5589, actor `openclaw`, `unknown_kid`, kid `e0c4934645522e62` |
| 16:42 / 22:42Z | **R1-L1** coverage 7698/7698; **R1-L2** stderr vs stdout; **R1-L3** landing `:107`; **R1-L5** gate retry 14:05:17 | applied in this file |
| 16:42:57 / 22:42:57Z | `sha256sum` of v1 file before v2 edit | `23f0f512d64b3fa083881728cb631cc87e3ce3853a46b6c18ff071d1be74b318` |

Edit and commit-hook seal of this file are additional rows once they exist (rule 9: log the edit, then commit).
