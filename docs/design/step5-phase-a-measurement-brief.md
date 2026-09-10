# Step 5 brief — Phase A measurement and cost profile (Grok)

**Status:** DRAFT v1, 2026-09-10, author claude-code (coordinator). §15 step 5 of
`commit-trailer-consistency.md` (v2.5.1). Measurer: grok (roles doc `docs/team-roles.md`). Not started —
step 5 cannot begin until step 3 is merged and the Worker runs `RETRACE_TRAILER_POLICY=shadow`.

## 0. Read this first: what you can start on 09-11, and what you cannot

Step 5 measures the classifier running in shadow. On 2026-09-10 the classifier is **being built** (cursor,
branch `jordandru/cursor-step3-classifier-shadow`), Codex's first code review cannot start until its budget
resets **14 Sep 22:07**, and the ≥ 7-day window only starts after merge **and** a Worker deploy with
`RETRACE_TRAILER_POLICY=shadow` for `retrace` and `boxing-rpg`. Realistic window start: on or after
**~15–16 Sep**; the report lands ~22–23 Sep at the earliest.

So your work splits in two, and **Phase 0 is the part that is ready now**:

- **Phase 0 (now → shadow deploy): build the measuring instrument and the baseline.** Most of the cost
  profile cannot be computed from data that exists today (§3). Finding that out on day 7 of the window
  would cost a week. Find it out this week instead.
- **Phase 1 (≥ 7 days of shadow): the census, the by-hand `conflicting` review, the published profile.**

## 1. What step 5 must deliver (§15.5 + the cost-profile tracked note)

1. **Status histogram** of `claim_decision.decision.status` on `retrace` and `boxing-rpg` over the window.
2. **Every `conflicting` case read by hand** — one line each: sha, claim, witness actors, why the
   classifier decided as it did, and whether you agree. This is the finding that step 6 turns on.
3. **`legacy_client` must be zero** for new seals before step 6 (§6 rule 5). Non-zero means a hook is still
   on a pre-`/2` CLI — name the repo and the machine.
4. **Cost profile published**, per project over the window:
   - `retrace_log` calls per commit — agent events between consecutive commit seals, by actor;
   - tokens per call — tool input bytes at the MCP boundary, **counted not estimated**, plus the `retrace`
     tool-schema bytes each harness loads at handshake (a fixed per-session context cost);
   - hook wall-clock p50/p95 from commit to sealed response, and the pending-seal retry count;
   - Worker classification time per seal (against the §5.3 500 ms deadline budget).
5. Publish the numbers **even if they are unflattering**. No target is set; Jordan reads them before step 6.
   "A cost we cannot state is a claim we cannot make."

## 2. Phase 0 — pre-flight (start here on 09-11)

1. **Baseline the two projects before shadow**, so the window's numbers have a before. As of 2026-09-10:
   `retrace` 3,3xx events / 508 commits / 2,185 agent events / sealed_by {pinned 1571, assert 194,
   webhook 549, owner 57, unstamped 947}; `boxing-rpg` 137 events / 93 commits / 83 agent events /
   sealed_by {pinned 15, assert 24, webhook 7, owner 1, unstamped 90}. Re-take both with
   `GET /projects/:p/status` and keep the JSON — a checked-in baseline file, not a screenshot.
2. **Predict the histogram before you measure it, and write the prediction down.** boxing-rpg has 15 pinned
   agent events against 93 commits, so nearly every commit there should classify `unresolved` (`Wall = ∅`) —
   that is the project's evidence density, **not** a classifier defect. Recording the prediction first is what
   lets the report distinguish the two. Design §4 already says as much.
3. **Build the harness against an export, not the live API** — `retrace-export export <project>` gives a
   verifiable bundle you can re-run offline and hand to a reader. Everything in §1 except the by-hand review
   should be one reproducible script, committed to the repo, that takes a bundle and prints the tables.
4. **Confirm boxing-rpg's hook is on 0.1.9** (`retrace-git install` re-run in `slc-wit-it`; its repo routes by
   policy as `jordandru/slc-wit-it`). A stale hook there produces `/1` seals and blocks item 3 above.
5. **Close the instrumentation gaps in §3 — the part that must happen before step 3 merges.**

## 3. Where each number actually comes from — census, bench, or missing

I checked the code on 2026-09-10. Three of the four cost metrics are **not** derivable from what the ledger
stores today. Label every published number with which of these it is; do not let a bench masquerade as a census.

| Metric | Source today | Status |
|---|---|---|
| Status histogram | `claim_decision.decision.status` on each seal in the export | **census** — available once shadow runs |
| `conflicting` cases | same, plus `witnesses[]`, `claim`, `context` | **census** |
| `legacy_client` | `/status` capture block | **census** |
| `retrace_log` calls per commit, by actor | ledger: agent events between consecutive commit seals | **census** |
| Tokens/bytes per call | no MCP-boundary byte counter exists | **proxy** — the stored event's canonical JSON size is what was sent, minus transport framing. Usable, but say so in the report; "counted not estimated" is satisfied only for the bytes you actually count |
| Tool-schema bytes at handshake | the 11 registered tool schemas | **census** — measure once per harness, it is a constant |
| Hook wall-clock p50/p95 | **nothing records it.** `retrace-hook.log` holds failures only | **missing** — see decision D1 |
| Pending-seal retries | `.git/retrace-pending-seal` + `retrace-hook.log` + doctor | **per-machine**, not fleet-wide; state the machine |
| Worker classification time per seal | **nothing records it.** No duration field in the §6 seal record | **missing** — see decision D2 |

**D1 — hook wall-clock.** `duration_ms` already exists on the event schema (`schema.ts:150`) and is inside the
producer-signed field set (`producer-sig.ts:136`), so the hook can record its own commit-to-sealed elapsed time
with **no schema change and no format bump**. Nothing sets it today. Either it is added (a small hook PR, and
then p50/p95 is a census over every hooked machine), or you measure it as a **bench** — N controlled commits on
one machine, timed — and the report says "one machine, N commits", never "the fleet".

**D2 — Worker classification time.** Recording it means a new subfield inside `claim_decision` (server-derived;
`claim_decision` is already in `RESERVED_METHOD_PARAMS_V2`, so no `/3` bump), or it stays unmeasurable from the
ledger and can only be sampled from Worker logs, which are not durable and not exportable. **This is the one
that must be decided before step 3 merges** — adding a field to a seal shape after seals exist means a
population of seals without it. It is a design decision, not a builder's: raise it, do not implement it.

Both decisions are Jordan's. Bring them to the coordinator (Claude) with your recommendation as soon as you
have read this — the cheap moment for D2 is while step 3 is still open.

## 4. Phase 1 — the window

- Start the clock only when the Worker actually reports `shadow` for both projects; record the deploy version
  and the first sealed sha, and re-check at the end that the mode never changed mid-window.
- ≥ 7 days. If the window is interrupted (a deploy, a rollback, an outage), say so and state whether the clock
  restarted. A "7-day" number that spans a config change is not a 7-day number.
- Read **every** `conflicting` by hand. If a decision looks wrong, that is a step-3 finding — file it against
  the code, not against the number.
- Note anything the histogram cannot see: the A-edits/B-commits gap (§4, T31), hook-selected facts (§5.1), and
  local ledgers always `unresolved` (§5.4) are known accepted limits, not defects — but a reader of your report
  will not know that unless you say it.

## 5. Output

One document in `docs/` plus the harness script, and a ledger event whose artifacts name both. Structure:
baseline → prediction → histogram → conflicting cases → cost profile (labelled census/bench/proxy per row) →
what the numbers do not cover → recommendation for step 6. Jordan reads it before enforce; write it for him,
not for the team.
