# Attribution amendment — design

**Status:** draft v4, 2026-09-05. Author: claude-code, at Jordan's request (ledger evt_243a9442).
v2 folded in Grok's review (six findings); v3 NOOA on Sonnet 5 (two, #1852); v4 NOOA on NVIDIA
Nemotron 3 Ultra (six, #1873) — see §11. Awaiting Codex. Nothing here is built yet.

**Decisions so far:** v1 ships **Tier 1 (human-sealed) only**; evidence is the **capture-window** rule;
export stays render-time; no model-only amendments. Tier 2 stays designed, not built.

## 1. The problem, in the ledger's own words

Retrace exists because a commit named the wrong agent as its author. Today the ledger can
*detect* that (reconcile's `misattributed` finding, the `correction`-tagged acknowledgement) and
it can *annotate* it (an appended note), but it cannot *say who actually did it* in a way the
tooling understands. `retrace_why`, `retrace_status`, lineage, the report and the export all keep
showing the recorded actor. Our own ledger carries two live cases:

- **seq 18** — a day-one commit seal whose actor id is a model name (`claude-fable-5`) instead of
  an actor id.
- **bfe87c3 / c375ed4** — Codex committed ~300 lines Claude Code wrote; the correction exists only
  as commit `c375ed4` and a note.

`retrace_amend` (packages/mcp-server/src/index.ts:254) already supports two append-only
corrections — a missing artifact role and a missing causal root — with the right shape: a normal
event, `action:"other"`, `action_detail:"amended"`, target named by `method.params.target_event_id`
and an `event:<id>` artifact ref, rooted in a human `instructed` event, re-derived from sealed data
by `collectProvenanceAmendments` (packages/core/src/amendment.ts). This design adds a third kind,
**attribution**, on the same rails, and teaches every consumer to show it.

## 2. Goals and non-goals

Goals

1. A human-authorized, evidence-carrying statement: *event T recorded actor A; the actor was B;
   here is why* — appended, never edited, hash-covered like every other event.
2. Every place that displays or decides on an actor shows **both**: the recorded actor and the
   effective actor, with the amendment that links them. Where a surface cannot show the pair
   (a bundle rendered without the effective view), it must at least say that amendments exist.
3. Fail closed. An amendment that does not meet the rules is sealed (it is history) but
   **ineffective**, and status says why — exactly how `ineffective_amendments` works today.
4. An agent cannot launder its own record. The rules below are written against the attacks we
   have actually seen (#1227: the accused model re-pinned as another harness).

Non-goals

- Editing or hiding the sealed event. The recorded actor stays visible forever.
- Re-attributing the **human** principal of an `instructed` root, or changing `on_behalf_of`.
  Human identity is the credential's business, not an amendment's. In v1 this extends to the
  beneficiary: `to.type` must be `agent` or `system`. Crediting a human (a commit the hook sealed
  as an agent but the operator made by hand) is a real case, but it needs a beneficiary rule that
  compares credentials rather than models (NOOA/Nemotron, finding 3); it waits for v2.
- Line-level attribution, bulk amendment, or amending events in another project.

## 3. Shape on the ledger

Same event shape as today's amendments, one new params block:

```jsonc
{
  "action": "other",
  "action_detail": "amended",
  "tags": ["amendment", "attribution"],
  "artifacts": [
    { "id": "event:evt_<target>", "kind": "event", "label": "amends event #18", "role": "used" },
    { "id": "event:evt_<evidence-1>", "kind": "event", "role": "used" },        // corroboration
    { "id": "commit:jordandru/retrace@c375ed4…", "kind": "commit", "role": "used" } // optional
  ],
  "intent": "<reason — the human-readable evidence statement>",
  "caused_by": "evt_<human instructed root, or a rooted follow-up>",
  "method": {
    "tool": "retrace_amend",
    "automated": false,
    "params": {
      "target_event_id": "evt_<target>",
      "attribution": {
        "from": { "type": "agent", "id": "claude-fable-5" },          // must equal target.actor (type,id)
        "to":   { "type": "agent", "id": "claude-code", "model": "claude-fable-5" },
        "evidence": ["evt_…", "evt_…"],                                  // ledger-native refs, ≥1
        "supersedes": "evt_<previous attribution amendment>"             // required if one exists
      }
    }
  }
}
```

Why `from` is repeated even though the target already carries it: the amendment must bind to the
actor it is correcting. If a future amendment changed the target's effective actor, an older one
that no longer matches becomes ineffective (`stale_from`) instead of silently re-applying.

No schema migration. `method.params` is already `z.record(z.unknown())`, the hash covers it
(chain.ts:36), and the Worker treats the event like any other `POST /events`.

## 4. Who may amend — the authorization rules

Two tiers, both computed from sealed data only, both requiring the existing root rule
(`causalRootState(caused_by) === "rooted"`).

**Tier 1 — human-sealed (default, recommended).** The amendment event's own `actor.type` is
`human`. Today only the owner token or an assert credential can seal a human actor for a
non-`instructed` action (router.ts:254-284), so this is literally "the operator said so, under a
credential that can speak as the operator". Path: a new CLI `retrace-export amend-attribution`
(owner token) and, later, a button in the UI. Status labels it `attribution amended (human)`.

**Tier 2 — agent-relayed. Designed, NOT in v1.** Sealed by a pinned agent through `retrace_amend`,
only when a project has opted in (`attribution_relay: true` on the credential set — the switch must
exist before the code path does) and only when the relaying agent is a disinterested third party on
**both** sides:

- accused side: relayer `actor.id ≠ from.id`; relayer `model ≠` the target seal's model; relayer
  `location.session ≠` the target seal's session (the #1227 rule as it exists today);
- beneficiary side: relayer `actor.id ≠ to.id`; relayer `model ≠` **every** model `to.id` has ever
  used in this project (not just `to.model`, which may be omitted); relayer `session ≠` any
  session on `to`'s evidence events;
- a relayed amendment can never supersede a human-sealed one.

Without the beneficiary-side rules, cursor-agent on grok-4.6 could credit `grok` from grok's own
session by simply omitting `to.model` — #1227 worn on the credit-receiving side (Grok, finding 3).
Status labels a relayed amendment `attribution amended (relayed by <agent>)`. v1 refuses any
attribution amendment whose sealing actor is not human, with reason `relay_disabled`.

**Evidence rule (both tiers).** `evidence` must contain at least one ledger-native reference that
corroborates `to`, and core must be able to check it against sealed data. **Exactly one arm is
sufficient on its own** — the covering-window edit, because it is the only one anchored to a fact
that existed before anyone wanted the correction. The other two are corroborating flags:

- **Covering-window edit** (primary). An event in the same project whose **recorded** actor is
  `to`, that edits a file the target commit touched, and whose `seq` lies **strictly inside that
  file's capture window** — after the previous sealed touch of that path and before the target
  seal — exactly reconcile's `prevTouchSeq` loop, reused, not re-implemented. "Sealed before the
  target" is not enough: a year-old edit by `to` on the same path would corroborate a commit `to`
  did not write (Grok, finding 2).
- **Structured human correction (flag only).** A `correction`-tagged event whose actor is human,
  that names the target's commit sha as an artifact (as #1219/#1220 do) **and** carries `to.id`
  in a structured field — `method.params.attributed_to` or an artifact `actor:<id>` — never in
  prose. Core does not scrape `intent`; it is untrusted text (Grok, finding 6). It adds a
  `human_corroborated` flag and is **never sufficient alone**: it is the human's own claim
  restated, and a human-sealed amendment already carries that claim in `intent`. Letting it stand
  as evidence would let one person be witness and notary in the same breath — seal the
  "correction" at N and cite it at N+1 (NOOA, finding 1).
- **Trailer flag** (never sufficient alone). A **sealed** `committed` event (not a bare git
  object) whose trailers name `to.id`. Trailers are written by whoever commits, so anyone with
  push access can mint one after the fact; this arm only adds a `trailer_corroborated` flag on top
  of one of the two arms above (finding 4).

For a non-git target (an MCP-logged event), the covering-window arm degrades to: an event by `to`
on the same artifact within the window between the previous sealed touch of that artifact and
the target's seq.

An amendment whose evidence refs do not exist, are not by `to`, fall outside the window, or rest
on the flag arms alone is sealed but ineffective with reason `uncorroborated`. Consequence,
accepted: an event whose true author never logged an edit in the window (a silent producer)
cannot be re-attributed effectively. That gap stays visible as `uncovered`, which is the honest
finding; the design does not trade it for a rule an attacker can satisfy with two events.

**Recorded, not effective, everywhere the rules look.** Covering-edit sets, evidence checks and
the dual-seal comparison (`producer_disagreement`) always use the **recorded** actor of the events
they examine. Otherwise two amendments launder in two steps — amend the edit events to B, then the
commit "looks covered" by B — and a single amendment of only the hook seal would manufacture a
producer disagreement on a correctly dual-sealed commit (finding 5). Effective actors are for
display and for the one downgrade in §6, nothing else.

**Actor existence.** `to.id` must already appear in the project as a server-stamped actor
(`sealed_by` pinned/assert/webhook) at least once before the amendment. You cannot invent an actor
by amendment (`unknown_actor`).

**Ordering and supersession.** `target.seq < amendment.seq` (`not_older`), same project
(`wrong_project`), `from` equals the target's current effective actor (`stale_from`), and if an
effective attribution amendment already exists for the target, the new one must name it in
`supersedes` (`no_supersede`). Latest effective amendment wins; the chain stays readable.

**No-ops.** `to` equal to `from` is `no_op`.

**Targets.** The target must be an ordinary event. An attribution amendment may not target another
amendment (`action_detail: amended`) — otherwise a chain could be laundered by re-attributing the
amendment that fixed it (`target_is_amendment`). Corrections to an amendment are made by
superseding it, never by amending it.

Every rejection reason above is a new value in the existing rejected-amendment vocabulary
(`unrooted | missing_target | wrong_project | not_older` today).

## 5. Core API

New module `packages/core/src/attribution.ts`:

```ts
export interface AttributionAmendment {
  amendment_id: string; seq: number;
  target_id: string;
  from: ActorRef; to: ActorRef;           // {type,id,model?}
  tier: "human" | "relayed"; relayed_by?: string;
  evidence: string[]; reason: string;
  supersedes?: string;
}
export function collectAttributionAmendments(events: Event[], isRooted: (e: Event) => boolean)
  : { effective: Map<string /*target id*/, AttributionAmendment>; rejected: RejectedAmendment[] };
export function effectiveActor(e: Event, amendments: Map<string, AttributionAmendment>)
  : { actor: Actor; recorded: Actor; amended?: AttributionAmendment };
```

`collectProvenanceAmendments` stays as is; `status.ts` calls both.

The rules in §4 live in **one** pure function, `checkAttributionAmendment(candidate, events)`,
returning `{ ok: true, tier, flags } | { ok: false, reason }`. `collectAttributionAmendments` calls
it over sealed events; the MCP handler and the CLI call it over the candidate before sealing. Two
copies of the rules would drift (NOOA/Nemotron, finding 5).

## 6. Every consumer, and what it shows

| Surface | Today | With attribution amendments |
|---|---|---|
| `retrace_why` / explain.ts `describeActor` | recorded actor | `«claude-code» [agent] (recorded as «claude-fable-5»; attribution amended by #N, human: <reason>)` |
| `retrace_status` actors + capture | counts by recorded actor | counts by **effective** actor; new fields `attribution_amendments`, `attribution_amended_events`, `ineffective_amendments` reasons broken out; per-actor `amended_from` |
| reconcile `misattributed` | fail unless acknowledged | commit-level fail downgrades to `info` with `amended: {seq,id}` (distinct from `acknowledged`) **only if `to.id` is in the covering set of every file that produced the fail** — the same bar the fail was computed with; the union `coveringActors` is not enough (Grok, finding 1: amend to whoever covered README and the whole commit goes green while `src/` is still someone else's). Files `to` did not cover stay per-file `misattributed: warn`. `producer_disagreement` keeps comparing **recorded** actors |
| lineage | actor node per recorded actor | node for the effective actor; dashed edge `recorded-as` to the recorded one |
| report / timeline UI | actor badge | badge `attribution amended`, hover shows recorded→effective and the amendment |
| export bundle | sealed events verbatim | unchanged bytes (the amendment events are already in the bundle); `retrace-export verify` prints `attribution amendments: N effective · M ineffective`; the **default** render prints the same count as a banner and marks each amended event `attribution amended → <to>` next to its recorded actor; `--effective` swaps the display to the effective actor with the recorded one in parentheses and prints an unsuppressable first line `effective view — recorded actors in parentheses; N amendments applied` (so a piped consumer cannot strip the pairing without stripping the header). A default render that hid the existence of amendments would break goal 2 (NOOA, finding 2) |
| git hook / Worker stamping | fixes WHO at seal time | unchanged — amendments never touch sealing |

The rule for every surface: **never show the effective actor without the recorded one within
reach.** The product's promise is that the wrong record stays visible; the amendment is added
context, not a replacement.

## 7. Tooling changes

- `retrace_amend` (MCP): add optional `attribution: { actor: {type,id,model?}, evidence: string[],
  supersedes?: string }`. Mutually exclusive with `artifact_roles`/`attest_causal_root` in one call
  (one amendment, one kind). Handler pre-checks the same rules core will re-derive, so a bad
  call fails loudly before sealing an ineffective event; core remains the source of truth.
- `retrace-export amend-attribution --target <evt> --to <actor> --evidence <evt,…> --reason "…"
  --caused-by <evt>` — the human-sealed path, owner token, prints the sealed event id.
- `retrace_status`/`retrace_why` output text updated per §6; `docs/reference.md` tool table row for
  `retrace_amend` updated; README/examples "not built yet" lines flipped only when merged and
  demonstrated on seq 18.

## 8. Tests (adversarial first, following reconcile.test.ts conventions)

1. Accused amends itself away (Tier 2, relayer = `from`) → ineffective `self_interested`.
2. Beneficiary amends to itself (relayer = `to`) → `self_interested`.
3. Relayer shares model with target seal (#1227 shape) → `self_interested`.
4. Human-sealed, evidence is a covering-window edit by `to` → effective; status counters move; the
   target event's bytes unchanged (assert like status.test.ts:38).
5. Evidence event by someone else / touching other artifacts / **outside the capture window
   (older edit on the same path)** → `uncorroborated`. Trailer-only evidence → `uncorroborated`
   even when the trailer names `to`.
5b. Human correction with `to.id` only in `intent` → no flag; with `method.params.attributed_to`
   → `human_corroborated` flag — and, with no covering-window edit, still `uncorroborated`.
5d. Same actor and session seal a structured correction at N and the amendment at N+1 with no
   other evidence → `uncorroborated` (witness-and-notary test).
5c. Non-human sealing actor in v1 → `relay_disabled` (and, once Tier 2 exists: relayer sharing
   any model `to` has used, or a session on `to`'s evidence, → `self_interested`).
6. `to.id` never server-stamped in the project → `unknown_actor`.
7. Second amendment without `supersedes` → `no_supersede`; with it → latest wins, `why` shows the
   chain.
7b. Two amendments to the same target sealed back-to-back, neither naming the other → the first is
    effective, the second `no_supersede`; seq order is the tiebreak, there is no "pending" state.
7c. An amendment whose target is itself an amendment → `target_is_amendment`.
7d. `to.type === "human"` in v1 → `human_beneficiary_unsupported`.
8. Amendment sealed before target (pre-planted) → `not_older`.
9. Reconcile: misattributed commit + effective amendment to the actor that covered **every**
   failing file → `info` with `amended`; an amendment to an actor that covered only some files
   leaves the commit failing on the rest (per-file warns), and the gate stays red.
9b. Two-step laundering: amend the covering edit events to B, then check the later commit — the
   covering set must still use recorded actors, so the commit is **not** covered by B.
9c. Amend only the git-hook seal of a dual-sealed commit → no `producer_disagreement`.
9d. Amend only the webhook seal of a dual-sealed commit so the two *effective* actors agree while
    the recorded ones differ → `producer_disagreement` is still reported (it reads recorded actors).
10. Export round-trip: bundle verifies; the default render shows the amendment banner and per-event
    markers; `--effective` differs only in which actor leads the display.

## 9. Rollout on our own ledger

1. Land core + tests + MCP + CLI (one PR, reviewed by Codex and Grok, committed under the identity
   that wrote it — no bundling).
2. First real amendment, human-sealed by Jordan: seq 18 → `claude-code` (evidence: the adjacent
   claude-code edit events). Second: bfe87c3 → `claude-code`, evidence `c375ed4` and the edit
   events. Both become `docs/examples.md` material.
3. Flip the README, examples, reference and battle-card lines from "not built yet" to earned.

## 10. Open questions — Grok's leans recorded, Codex to confirm

Grok (2026-09-05): Q1 no Tier 2 in v1 and never let a relay supersede a human amendment; Q2 strict
capture window; Q3 render-time only ("a derived table that is not inside the event hash will get
treated as sealed"); Q4 out of v1 ("a successful amendment would look like a stronger claim than
the original seal"). All four match the author's leans and are adopted as v2 decisions pending
Codex.

1. **Ship Tier 2 at all?** Human-sealed only is simpler and closes the door on relay games
   entirely; the cost is that agents cannot fix attribution mid-session without the operator.
   My lean: ship Tier 1 first, keep Tier 2 designed but behind a per-project opt-in
   (`attribution_relay: true` on the credential set), same pattern as `ackActors`.
2. **Evidence strictness.** Require the covering-window match (strict, may reject true
   corrections for silent producers) or accept any prior edit by `to` on the same artifact (looser)?
   Lean: strict, because a loose rule is the one an attacker meets first.
3. **Effective view in the export.** Render-time only (bundle bytes unchanged), or add a derived
   `attribution` table to the bundle so third-party consumers do not re-implement §4? Lean:
   render-time only in v1; the verifier prints counts so a consumer knows amendments exist.
4. **Model re-attribution.** Should an amendment be allowed to correct only `actor.model`
   (Codex's `gpt-5` vs `gpt-5.6-sol`)? It fits the same rails; keep it out of v1 to keep the
   evidence rule crisp, revisit with the model self-report work.

## 11. Review log

- **Grok, 2026-09-05 (six findings, all accepted, all folded into v2):** (1) High — §6 downgrade
  used the union covering set; now per-file. (2) High — §4 evidence said "sealed before the
  target"; now strictly inside the capture window. (3) Medium — Tier 2 beneficiary side leaked
  when `to.model` was omitted; Tier 2 moved out of v1 and hardened on paper. (4) Medium — trailer
  evidence could stand alone; now a flag only, and the commit must be a sealed event. (5) Medium —
  covering sets and `producer_disagreement` must use recorded actors; now stated and tested.
  (6) Low — human-correction evidence must not parse `intent`; now a structured field.
- **NOOA, 2026-09-05 (peer review sealed under its own identity, #1852, producer-signed; model
  claude-sonnet-5; two findings, both accepted, folded into v3):** (1) High — the structured
  human-correction arm was sufficient alone with no independence constraint (witness and notary in
  the same breath); now a flag only, covering-window is the sole sufficient arm, test 5d added.
  (2) Medium — goal 2 promised "both actors everywhere" while the export default hid that
  amendments existed; default render now prints the count banner and per-event markers, goal 2
  reworded. NOOA also confirmed Q1–Q4 leans and listed five rules it verified sound.
- **NOOA on NVIDIA Nemotron 3 Ultra (550B, via NVIDIA's inference API), 2026-09-05, sealed #1873,
  producer-signed; six findings, all accepted, folded into v4:** (M1) test 9d — amend the other
  seal of a dual-sealed commit, disagreement must persist; (M2) amendments may not target
  amendments (`target_is_amendment`, test 7c); (M3) Tier 2's beneficiary rule is vacuous for human
  beneficiaries → v1 restricts `to.type` to agent/system (test 7d); (L4) `--effective` carries an
  unsuppressable header; (L5) one shared `checkAttributionAmendment` for handler and core; (L6)
  back-to-back amendments resolve by seq (test 7b). First review of this design by a model from a
  vendor other than the one that wrote it.
- **Codex:** pending (returns 2026-09-07).
