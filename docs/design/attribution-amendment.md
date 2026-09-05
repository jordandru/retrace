# Attribution amendment — design

**Status:** draft for review (Codex, Grok), 2026-09-05. Author: claude-code, at Jordan's request
(ledger evt_243a9442). Nothing here is built yet.

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
   effective actor, with the amendment that links them.
3. Fail closed. An amendment that does not meet the rules is sealed (it is history) but
   **ineffective**, and status says why — exactly how `ineffective_amendments` works today.
4. An agent cannot launder its own record. The rules below are written against the attacks we
   have actually seen (#1227: the accused model re-pinned as another harness).

Non-goals

- Editing or hiding the sealed event. The recorded actor stays visible forever.
- Re-attributing the **human** principal of an `instructed` root, or changing `on_behalf_of`.
  Human identity is the credential's business, not an amendment's.
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

**Tier 2 — agent-relayed.** Sealed by a pinned agent through `retrace_amend`. Allowed only when the
relaying agent is a disinterested third party:

- its `actor.id` is neither `from.id` nor `to.id`;
- its `actor.model` differs from the target seal's model **and** from `to.model` when known;
- its `location.session` differs from the target seal's session;
- it is not listed as the covering actor being credited (that would be `to`).

This is the #1227 rule extended to both sides of the correction: neither the accused nor the
beneficiary, nor the same model wearing another badge, can seal it. Status labels it
`attribution amended (relayed by <agent>)`. Reviewers: see open question 1 on whether Tier 2
should ship at all in the first cut.

**Evidence rule (both tiers).** `evidence` must contain at least one ledger-native reference that
corroborates `to`, and core must be able to check it:

- an event in the same project whose actor is `to` and whose artifacts intersect the target's
  artifacts, sealed **before** the target (this is reconcile's covering-edit test, reused); or
- a `correction`-tagged event by a human that names the target's commit sha and `to.id`; or
- for a git seal, a commit whose trailers name `to.id` (`Retrace-Actor`) — weakest, flagged.

An amendment whose evidence refs do not exist, are not by `to`, or do not touch the target's
artifacts is sealed but ineffective with reason `uncorroborated`.

**Actor existence.** `to.id` must already appear in the project as a server-stamped actor
(`sealed_by` pinned/assert/webhook) at least once before the amendment. You cannot invent an actor
by amendment (`unknown_actor`).

**Ordering and supersession.** `target.seq < amendment.seq` (`not_older`), same project
(`wrong_project`), `from` equals the target's current effective actor (`stale_from`), and if an
effective attribution amendment already exists for the target, the new one must name it in
`supersedes` (`no_supersede`). Latest effective amendment wins; the chain stays readable.

**No-ops.** `to` equal to `from` is `no_op`.

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

## 6. Every consumer, and what it shows

| Surface | Today | With attribution amendments |
|---|---|---|
| `retrace_why` / explain.ts `describeActor` | recorded actor | `«claude-code» [agent] (recorded as «claude-fable-5»; attribution amended by #N, human: <reason>)` |
| `retrace_status` actors + capture | counts by recorded actor | counts by **effective** actor; new fields `attribution_amendments`, `attribution_amended_events`, `ineffective_amendments` reasons broken out; per-actor `amended_from` |
| reconcile `misattributed` | fail unless acknowledged | if the sealed commit's effective actor is in `coveringActors` → level `info`, new field `amended: {seq,id}` (distinct from `acknowledged`); `producer_disagreement` compares effective actors |
| lineage | actor node per recorded actor | node for the effective actor; dashed edge `recorded-as` to the recorded one |
| report / timeline UI | actor badge | badge `attribution amended`, hover shows recorded→effective and the amendment |
| export bundle | sealed events verbatim | unchanged bytes (the amendment events are already in the bundle); `retrace-export verify` prints `attribution amendments: N effective · M ineffective`; renderers take `--effective` |
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
4. Human-sealed, evidence is a covering edit by `to` → effective; status counters move; the target
   event's bytes unchanged (assert like status.test.ts:38).
5. Evidence event by someone else / touching other artifacts → `uncorroborated`.
6. `to.id` never server-stamped in the project → `unknown_actor`.
7. Second amendment without `supersedes` → `no_supersede`; with it → latest wins, `why` shows the
   chain.
8. Amendment sealed before target (pre-planted) → `not_older`.
9. Reconcile: misattributed commit + effective amendment to a covering actor → `info` with
   `amended`; an amendment to a **non**-covering actor does not downgrade the finding.
10. Export round-trip: bundle verifies; `--effective` render differs only in actor display.

## 9. Rollout on our own ledger

1. Land core + tests + MCP + CLI (one PR, reviewed by Codex and Grok, committed under the identity
   that wrote it — no bundling).
2. First real amendment, human-sealed by Jordan: seq 18 → `claude-code` (evidence: the adjacent
   claude-code edit events). Second: bfe87c3 → `claude-code`, evidence `c375ed4` and the edit
   events. Both become `docs/examples.md` material.
3. Flip the README, examples, reference and battle-card lines from "not built yet" to earned.

## 10. Open questions for review

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
