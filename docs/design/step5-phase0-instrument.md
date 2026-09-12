# Step 5 Phase 0 — measuring instrument and baseline

**Status:** Phase 0 complete, 2026-09-11. Author: grok (measurer). Instruction `evt_0e0ca142fdde422caa70563949018bef`. HEAD at start of work: `3f55d64`. Branch: `grok/step5-phase0-measurement`.

This is the instrument and the before-picture. It is **not** the Phase A report. The ≥ 7-day shadow window has not started. Phase 1 starts only when the coordinator says the Worker reports `shadow` for both `retrace` and `boxing-rpg`.

Every number below is labelled **census**, **proxy**, **bench**, **missing**, or **per-machine**. A proxy published as a measurement is a defect in this work.

## 1. Baseline (census)

Taken from `GET /projects/:p/status` against `https://retrace-api.slcwitit.workers.dev` at **2026-09-12T03:51:20.210Z** (`retrace`) and **2026-09-12T03:51:22.413Z** (`boxing-rpg`). Worker `GET /api` at that moment advertised `attribution-v7` and `producer-sig/2`. `RETRACE_TRAILER_POLICY` is not on the public probe; capabilities do not include a classifier. Chain integrity `ok` on both.

Checked in:

- [`docs/measurements/step5-phase0/baseline-retrace.status.json`](../measurements/step5-phase0/baseline-retrace.status.json)
- [`docs/measurements/step5-phase0/baseline-boxing-rpg.status.json`](../measurements/step5-phase0/baseline-boxing-rpg.status.json)

| Field | retrace 09-10 brief | retrace now | boxing-rpg 09-10 brief | boxing-rpg now |
|---|---:|---:|---:|---:|
| events | ~3,3xx | **3532** | 137 | **137** |
| commits | 508 | **545** | 93 | **93** |
| agent events | 2185 | **2319** | 83 | **83** |
| sealed_by.pinned | 1571 | **1714** | 15 | **15** |
| sealed_by.assert | 194 | **210** | 24 | **24** |
| sealed_by.webhook | 549 | **604** | 7 | **7** |
| sealed_by.owner | 57 | **57** | 1 | **1** |
| sealed_by.unstamped | 947 | **947** | 90 | **90** |
| agent_events_not_pinned | (not quoted) | **1095** | (not quoted) | **75** |
| legacy_client | (not quoted) | **4** | (not quoted) | **0** |
| causal coverage | (not quoted) | **98.2%** | (not quoted) | **19%** |
| policy | live v1 | **v1 `97dc1469…`** | live v1 | **v1 `e2adcebe…`** |
| routing | — | `jordandru/retrace` | — | `jordandru/slc-wit-it` |
| last_event_at | — | 2026-09-12T03:47:06.810Z | — | 2026-09-10T13:27:51.937Z |

Kind: **census**. boxing-rpg is unchanged since the brief. retrace grew by 37 commits and 134 agent events in two days, all of the new sealed_by mass in pinned / assert / webhook (unstamped stayed 947).

`legacy_client = 4` on retrace is four **already-sealed** `/1` git commit seals. They will never gain `claim_decision` (§6 rule 5). The step-6 rule is zero **new** `/1` seals, not a rewrite of these four. boxing-rpg is already 0.

Attribution on both status documents is `unavailable: no_git_context` because the Worker has no repo. That is expected, not a capture hole.

### NOOA hourly audit gap (09-10 16:00–19:00 UTC)

The coordinator reported MCP timeouts on 2026-09-10 between ~16:00 and 19:00 UTC under heavy local build/test load. This baseline does not re-query the live API by hour (the instrument forbids that loop). When Phase 1 runs the harness against an export, the `logs_per_commit` by-actor split will show `nooa` as a drip; hours with no `nooa` event in that window are a coverage gap, not a classifier finding. Record 2026-09-10 16:00–19:00 UTC as a known gap on the pre-window ledger. `nooa` `last_seen` on this baseline is 2026-09-12T03:22:05.630Z, so the hourly seat is alive again as of this snapshot.

## 2. Histogram prediction (written before any classifier output)

This section was written from the baseline census above and from design §4, **before** running the harness on an export and **without** calling `classifyCommitClaim`. If a later number disagrees with this section, the later number is the measurement and this section is what it is being compared to.

Witnesses are **pinned** agent events only (`sealed_by` starts with `pinned:`). Assert, webhook, owner, unstamped, and local seals are never Wall. So:

```
pinned_agent_events ≈ pinned − (pinned humans/system, if any) ≤ sealed_by.pinned
```

On these snapshots almost all `pinned` mass is agent ingress. boxing-rpg has **15 pinned events and 93 commits**. retrace has **1714 pinned events and 545 commits**.

Shadow classifies **new** seals going forward. Existing seals are not retroactively annotated. The window histogram is therefore a prediction about **the next week of commits, at today's evidence density**, not a retrospective of the whole chain. A retrospective classify of all 545 / 93 historical commits would mix pre-capture history with current practice and is not what step 5 publishes.

### boxing-rpg — PREDICTION

Evidence density, not a classifier defect:

- Wall = ∅ on nearly every new commit. 15 pinned events cannot cover 93 commits' files except on the handful of paths those 15 events actually named, and only inside each path's window.
- If the commit carries an agent trailer (recorded WHO on recent boxing-rpg commits is often `agent:claude-code`): **`unresolved`**, reason `unrooted` / `root_only` / `loose_evidence_only` depending on `caused_by`. Causal coverage on this project is 19% with 83 unlinked commits of 93 — **census**, and it already says most commits have no rooted chain, so `unrooted` should dominate the unresolved reasons.
- If the commit is a human/bot author and Wall = ∅: **`no_agent_evidence`**.
- **`supported`**: rare. Requires C ∈ Wall, i.e. a pinned agent event covering this commit's files, and the trailer naming that same agent.
- **`conflicting`**: rarer still. Requires Wall ≠ ∅ **and** C ∉ Wall. At most the files touched by those 15 pinned events can even have a non-empty Wall. A non-zero conflicting count here would be interesting; a large one would be a surprise.
- **`merge_unclassified`**: merge commits that emit no files, if any occur in the window.
- Last ledger event is 2026-09-10. If boxing-rpg is quiet during the window, the histogram is small-n and must be published as small-n, not padded with history.

Ordering I will treat as the prediction:

**`(unresolved ∪ no_agent_evidence) ≫ supported ≥ conflicting ≥ merge_unclassified`**

A window that comes back mostly `supported` on boxing-rpg is either a capture change (pinned logging caught up) or a classifier surprise. It is not what today's density says.

### retrace — PREDICTION

Density is different: ~3.1 pinned events per commit, six live agent seats logging (codex 889, claude-code 661, grok 263, github-copilot 210, cursor-agent 160, nooa 117 — **census** of actor.events, which includes non-edit actions). The team rule is "commit only your own paths."

For **new** seals during the window, if agents keep logging pinned edits before they commit:

- **`supported`** should be the plurality of agent-trailer commits that were preceded by that agent's pinned edits on those files. I am not giving a percentage.
- **`unresolved`** remains a real share: trailer without pinned witness (assert-only work, missed `retrace_log`, root-only chains). It should be **lower in the window than a retrospective of all 545 historical commits**, because the early chain had no classifier and thinner pinning.
- **`conflicting`** is the number step 6 turns on. I predict it is **visible and non-zero**, not the mode. Sources: copied trailers, "commit only your own paths" misses, and the known A-edits/B-commits gap (§4, T31) which the classifier will call `supported` for A — that gap will **not** appear as `conflicting`. If conflicting is zero after seven active days, that is a finding (either the team is clean or the classifier is blind). If it is the mode, that is also a finding (or a capture/claim mismatch).
- **`human_claim_with_agent_evidence`**: Jordan's and `github:jordandru` commits on files agents touched.
- **`no_agent_evidence`**: checkpoint-style or docs-only human commits with empty Wall.
- The four `/1` seals stay `absent` forever and are outside the window.

Ordering I will treat as the prediction, for **window** seals only:

**`supported` and `unresolved` are the two large buckets; `human_claim_with_agent_evidence` next; `conflicting` a tail that must be read by hand; `no_agent_evidence` / `merge_unclassified` small.**

I have not counted trailers. The harness prints recorded `actor` on seals as a separate census so Phase 1 can see claim-mix without confusing it with `claim_decision.status`.

## 3. Harness

One script, committed, offline:

```sh
retrace-export export <project> --out /tmp/retrace-<project>.json
node scripts/phase-a-measure.mjs /tmp/retrace-<project>.json
# Phase 1:
node scripts/phase-a-measure.mjs /tmp/retrace-<project>.json \
  --since <window-start> --until <window-end> \
  --hook-log /path/to/.git/retrace-hook.log \
  --pending-seal /path/to/.git/retrace-pending-seal
```

Implementation: `packages/mcp-server/src/phase-a-measure.ts` (tested). It prints every brief §1 table except the by-hand conflicting review.

| Brief §1 table | Source in the script | Kind |
|---|---|---|
| Status histogram | `claim_decision.decision.status` on git commit seals; `absent` if the block is missing | census (once shadow writes it; pre-shadow this column is almost all `absent`) |
| Conflicting by hand | **not printed** | — |
| `legacy_client` | `isLegacyClientCommitSeal` (`/1`-signed git seals) | census |
| Hook producer-sig split | unsigned / `/1` / `/2` | census (design §6 asked for this in step 5) |
| `retrace_log` calls per commit, by actor | agent events strictly between consecutive git commit seals | census |
| `method.tokens` | stored field if present | census if present, else missing |
| Bytes per call | `canonicalize(stored event)` and producer-signed payload | **proxy** — stored JSON minus transport framing, not MCP-boundary bytes |
| Tool-schema bytes at handshake | in-process `tools/list` on this checkout's 11-tool MCP | census, constant per harness version |
| Hook wall-clock p50/p95 | `duration_ms` on git commit seals | missing today; census of hook-local elapsed **if D1 lands**; never commit-to-sealed-response (see §4) |
| Pending-seal retries | `--pending-seal` / `--hook-log` | per-machine |
| Worker classification time | `claim_decision.decision.classification_ms` | **census once shadow runs** (D2 decided and built in PR 34 at `94d38bb`; informational, never a selector) |

### §3 source table, updated for D2

The brief's 09-10 table listed Worker classification time as **missing**. That is stale.

| Metric | Source | Status as of Phase 0 |
|---|---|---|
| Status histogram | `claim_decision.decision.status` on each seal in the export | census — available once shadow runs |
| `conflicting` cases | same, plus `witnesses[]`, `claim`, `context` | census |
| `legacy_client` | `/status` capture block and the export | census |
| `retrace_log` calls per commit, by actor | ledger: agent events between consecutive commit seals | census |
| Tokens/bytes per call | no MCP-boundary byte counter | **proxy** — canonical stored JSON / producer-signed payload |
| Tool-schema bytes at handshake | 11 registered tool schemas | census — measured once per harness |
| Hook wall-clock p50/p95 | `duration_ms` unset; `retrace-hook.log` is failures only | **missing** — D1 still undecided (recommendation in §4) |
| Pending-seal retries | `.git/retrace-pending-seal` + `retrace-hook.log` + doctor | **per-machine** |
| Worker classification time per seal | `claim_decision.decision.classification_ms` (PR 34) | **census from the ledger once shadow runs**, not a Worker-log sample |

Handshake census, this checkout, `tools/list` after in-process MCP handshake (UTF-8 bytes of name + description + inputSchema):

| Tool | bytes | schema_bytes | kind |
|---|---:|---:|---|
| retrace_amend | 2040 | 1789 | census |
| retrace_export | 459 | 149 | census |
| retrace_history | 889 | 637 | census |
| retrace_instruct | 843 | 648 | census |
| retrace_lineage | 513 | 251 | census |
| retrace_log | 2751 | 2434 | census |
| retrace_projects | 325 | 90 | census |
| retrace_share | 525 | 340 | census |
| retrace_status | 410 | 117 | census |
| retrace_verify | 369 | 117 | census |
| retrace_why | 385 | 156 | census |
| **local MCP total (11)** | **9509** | — | census |
| **Worker audit subset (9)** | **6944** | — | census |

`retrace_log` is 29% of the local handshake. The Worker remote MCP does not load `retrace_amend` or `retrace_share`. This is a constant of the harness version, not of a project or a window.

## 4. D1 recommendation — hook wall-clock

**Recommend: yes, set `duration_ms` on the live hook path, and land it before the window opens.** Bring this to Jordan.

Why yes:

1. Step 5 asks for fleet p50/p95. A one-machine bench of N commits is not that, and the brief already says so. Without a field on the seal, the window cannot accumulate a census.
2. The field already exists (`schema.ts`) and is already inside the producer-signed set (`producer-sig.ts`). No schema change, no `/3`.
3. GitHub workflow and GDrive adapters already stamp `duration_ms`. The hook is the hole.

The constraint that decides *what the number may be called*:

`duration_ms` is producer-signed. The hook signs **before** `POST /events`. It cannot attest the round-trip or the Worker's classify. A value written after the response would not verify. Putting the full "commit-to-sealed-response" interval on this field would be a **proxy published as a measurement**.

So the honest split is:

| Interval | Where | Kind if D1 lands |
|---|---|---|
| Hook-local: `commitToEvent` + `sealForAppend` (process start → just before POST) | `duration_ms` on the live `--hook` path only, not backfill/replay | **census**, labelled hook-side |
| Worker classify | `decision.classification_ms` (D2, already built) | **census**, labelled Worker-side |
| Network RTT + Worker non-classify work | not on the event | **bench**, one machine, N commits, external timer around POST, if Jordan wants the sum |

Do not set `duration_ms` on backfill or `retrace-git commit <sha>` replay: that measures replay, not commit-to-seal.

I considered success lines in `retrace-hook.log` as the primary. That is the same class as pending-seal retries: per-machine, not in the export, not fleet. Useful as a supplement on this laptop; not the census.

If D1 does not land before shadow, Phase 1 will publish a **bench** ("one machine, N commits") for hook wall-clock and will say so. That is strictly worse for Jordan's step-6 read.

I am not implementing D1 in this PR. It is Jordan's decision.

## 5. boxing-rpg hook version (brief §2.4)

**Confirmation, not a change.** I did not re-run `retrace-git install` (it would not fix the live path, and this is another repo).

Facts, all **census** of the machine as of 2026-09-11:

| Item | Value |
|---|---|
| Repo | `/home/jordandrumiler/provenance/slc-wit-it` (`jordandru/slc-wit-it`), HEAD `295d26f` |
| `core.hooksPath` | `.githooks` — git looks **only** here |
| Live hooks | hand-written `.githooks/post-commit` and `post-merge`, mtime 2026-09-08 21:35, carry `HOOK_MARK` so doctor passes |
| What they exec | `$HOME/provenance/retrace/packages/mcp-server/dist/git-hook.js` (then `node_modules/@retrace-dev/cli`, which is absent) |
| That dist | package **0.1.9**, git HEAD `3f55d64`, signs `retrace-producer-sig/2`, mtime 2026-09-10 07:32 |
| `.git/hooks/post-commit` | stale `retrace-git install` from 2026-09-08 pointing at `retrace-main` dist; **unreachable** because of `core.hooksPath` |
| Global `npm` CLI | `@retrace-dev/cli@0.1.1` — unused by the live hook |
| Published npm | `@retrace-dev/cli@0.1.9` |
| `legacy_client` on boxing-rpg | **0** |

So: the **next** boxing-rpg commit will run a 0.1.9 workspace dist that signs `/2`. It is **not** a packed 0.1.9 from `npm i -g`, and it is **not** the generated hook from `retrace-git install`. A re-run of `retrace-git install` writes `.git/hooks/`, which this repo will not execute until `core.hooksPath` is unset.

Risk: boxing-rpg's hook is whatever `~/provenance/retrace` last built. If that checkout goes stale or dirty, boxing-rpg silently follows it. The brief's `/1` concern is not the current live path, but the coupling is real.

Operator options, none taken here:

1. Leave `.githooks` as-is and keep `~/provenance/retrace` built at 0.1.9+ `/2`.
2. Point `.githooks` at the packed CLI after `npm i -g @retrace-dev/cli@0.1.9` (global is currently 0.1.1).
3. Unset `core.hooksPath` and `retrace-git install` into `.git/hooks/` — that is a boxing-rpg repo change, not this PR.

For step 6, `legacy_client` on **new** boxing-rpg seals should stay 0 if option 1 or 2 holds.

retrace's own hook (main checkout) still points at `/home/jordandrumiler/provenance/retrace/packages/mcp-server/dist/git-hook.js` via `.git/hooks/` and is the same 0.1.9 `/2` dist. Four historical `/1` seals remain.

## 6. What Phase 0 did not do

- Did not review PR 34.
- Did not start the 7-day clock.
- Did not implement D1.
- Did not classify the existing ledgers locally (that would be a measurement pretending to be a prediction).
- Did not check in export bundles (they are large, signed, regenerable). Reproduce with `retrace-export export`.

Phase 1 waits for the coordinator: Worker reports `shadow` for both projects, deploy version and first sealed sha recorded, then ≥ 7 days, then this harness with `--since/--until`, then every `conflicting` by hand.

## 7. Instrument smoke (pre-shadow exports)

Kind: **census** of what the ledger stores today, plus **proxy** byte sizes. This is **not** a classifier histogram and does not revise §2.

Bundles (not checked in; regenerate with `retrace-export export`):

| project | bundle generated_at | events | git commit seals | claim_decision present | classification_ms | duration_ms | legacy_client | unsigned / `/1` / `/2` |
|---|---|---:|---:|---:|---|---|---:|---|
| boxing-rpg | 2026-09-12T04:00:28.163Z | 137 | 91 | 0 | missing | missing | 0 | 91 / 0 / 0 |
| retrace | 2026-09-11T19:07:33.274Z (cached; live head at baseline was 3532) | 3527 | 510 | 0 | missing | missing | 4 | 467 / 4 / 39 |

Git commit seals (`method.tool = "git"`) are fewer than `/status` `capture.commits` (93 and 545), which counts every `committed`/`merged` regardless of tool. The harness follows the classifier's seal shape.

Recorded WHO on those seals (still not `claim_decision`):

- boxing-rpg: 70 agent (claude-opus-5 32, claude-code 30, claude-fable-5 8) / 21 human. Combined with 15 pinned events, this is why §2 puts `unresolved` above `no_agent_evidence` for that project.
- retrace: 482 agent / 16 human / 12 system. Window seats will mostly be agent-trailer claims.

`retrace_log` calls per commit (census of agent events between consecutive git seals):

- boxing-rpg: p50 **0**, p95 **1**, mean **0.14**, max **4**, **91.2%** of commits have zero agent events in the interval. by_actor: claude-code 13.
- retrace: p50 **1**, p95 **13.5**, mean **3.58**, max **161**, **44.1%** zero. by_actor: codex 838, claude-code 387, grok 236, github-copilot 164, nooa 109, cursor-agent 85, gemini 7, claude-cowork 1.

Bytes per those agent events (proxy): boxing-rpg stored canonical p50 1302 / p95 2135 (n=13); retrace p50 1455 / p95 2385 (n=1827). `method.tokens` is **missing** on both (0 present). Do not publish the proxy as a token count.

Hook producer-sig: boxing-rpg's 91 seals are all unsigned (historical). The `retrace-git` credential on this machine now has `producer_key_file` pointing at an existing 0600 JWK, and the live dist signs `/2`, so the **next** boxing-rpg commit should be `/2` if that path keeps working. retrace already has 39 `/2` seals. Unsigned is not `legacy_client`; `/1` is.

The instrument did what Phase 0 needed: every §1 table except the by-hand review prints, every number is labelled, and there is nothing to discover missing on day 7 except the classifier output itself (and D1, if Jordan says no).
