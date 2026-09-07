# Attribution amendment — design

**Status:** v7 implementation contract, 2026-09-07. Author: claude-code, at Jordan's request (ledger evt_243a9442).
v2 folded in Grok's review (six findings); v3 NOOA on Sonnet 5 (two, #1852); v4 NOOA on NVIDIA
Nemotron 3 Ultra (six, #1873); v5 the same reviewer re-run by Grok against v4 (seven, #1890); v6
Codex on GPT-5.6 Sol (four, #2046) — see §11. All four reviewers have reported; the Core Four
v6 review round is closed. B2/B3 inclusion in v1 awaits Jordan's decision; the v7 contract below defines this branch for review. Implementation is in progress on `codex/attribution-v1`; not released.

**Decisions so far:** v1 ships **Tier 1 (human-sealed) only**; evidence is the **capture-window**
rule, required for **every artifact in the amendment's scope** (v6); an amendment is **scoped to
artifacts** and changes the event-level effective actor only when its scope is the whole event
(v6); evidence is evaluated against the **final ledger** in target-seq order (v6); actor identity
is **{type,id}** everywhere (v6); export stays render-time; no model-only amendments. Tier 2 stays
designed, not built.


## V7 normative changes (implementation gate #2139)

This section supersedes conflicting v6 wording below. Source: Codex implementation gate
**#2139**, `evt_4f2bb7c1480f4766b88ad309fd5a797d`, reviewing `1d24ee8`.
The three blocking findings were B1 (eligible universe), B2 (scoped replay), and B3
(required capture inputs). The full gate contract is preserved in
[attribution-v7-contract.md](attribution-v7-contract.md); its scope/input, algorithm,
interfaces, rejection precedence, and test matrix are normative for this implementation.

1. **B1 — eligible contribution universe.** Scope means recorded output/invalidation
   claims, excluding commit/event/actor references, causal links, and input-only refs.
   Recorded `generated`/`both` roles qualify; absent roles fall back to change verbs
   (including commit/merge file references). Role amendments never expand this universe.
   Git units must correspond to verified changed-file transitions. Duplicate canonical
   units collapse. Omitted scope means the nonempty eligible universe; an explicit empty
   scope is invalid. `whole_event` requires a single amendment covering the entire
   universe AND every Git changed-file transition. Disjoint amendments never combine
   into a whole-event amendment. Context and input refs retain their recorded association.
   Effective identities preserve only `{type,id}` and the target's `on_behalf_of`;
   target model/display/version are not inferred from witnesses.
2. **B2 — scoped prefix-state replay.** Resolve targets by target seq, then attempts by
   amendment seq. `from` binds to every scoped artifact's effective identity immediately
   before that attempt. Zero overlapping active predecessors requires no `supersedes`;
   one requires that exact predecessor; multiple overlaps reject `no_supersede`.
   Admission removes the predecessor in full, so dropped scope returns to the recorded
   actor. Rejection changes no state. Admitted/superseded, active, rejected, and unavailable
   are distinct. Any active amendment on an evidence event excludes that entire event;
   another clean cited witness may still cover the artifact. Final-snapshot invalidation
   may reverse after later amendments: reactivation is legal. `no_supersede` precedes
   `stale_from`; withdrawn evidence precedes partial/zero coverage diagnostics.
3. **B3 — explicit reproducible capture context.** Authoritative derivation requires a
   verified complete project snapshot through an authenticated head plus a versioned
   policy and Git facts (aliases, exact hook stamps, diffs/renames, and ref reachability
   with a checkout horizon). Results name head, policy digest, and Git-facts digest.
   Missing required context means **unavailable**, never zero effective amendments or
   guessed history. All seals of one full commit OID share the earliest applicable
   cutoff; their own OID is excluded from preceding touches. Ordinary repository edits
   use those same commit boundaries. Other schemes require explicitly configured capture
   producers; ordinary edits do not close their windows. A witness satisfies
   `after < evidence.seq < before <= target.seq < amendment position`.
   Preflight uses an after-head candidate position, never a fabricated server seal;
   acceptance is advisory and the actual appended record must be re-evaluated.

Git-context-free surfaces retain recorded identities and show “attribution evaluation
unavailable” when that context is needed. Filtered views cannot infer effectiveness from
only their visible events. Optional blob matching never determines effectiveness.
Reconcile first computes its recorded-actor report; only a complete per-file certificate
for the exact selected seal may downgrade a commit-level misattribution failure. A partial
certificate leaves the original failure intact. Open producer disagreement vetoes that
downgrade; existing per-file warnings and independent acknowledgements keep their semantics.

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
- Proving **what code** an actor wrote. Every evidence arm in §4 is a server-stamped *claim* made
  under a credential before the dispute; none of them binds the claim to file content. v1 records
  a `content_bound` flag where that binding happens to exist (§4) and does not pretend the flag is
  the rule (Codex, finding 2).

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
        "to":   { "type": "agent", "id": "claude-code" },                    // v1: type+id only; model is derived, never asserted here
        "artifacts": ["repo:jordandru/retrace#packages/core/src/status.test.ts"], // scope: a subset of the target's artifacts; omitted = all of them
        "evidence": ["evt_…", "evt_…"],                                  // ledger-native refs, ≥1 per artifact in scope
        "supersedes": "evt_<previous attribution amendment>"             // required if an effective one overlaps this scope
      }
    }
  }
}
```

**Scope (v6).** An amendment names the artifacts it re-attributes. A commit that touched a
hundred files is a hundred attribution claims; evidence for one of them must not flip the other
ninety-nine on every surface (Codex, finding 1 — the §6 reconcile row was already per-file, but
`why`, `status`, lineage and the report changed the whole event's effective actor on one file's
evidence). With scope: the **event-level** effective actor changes only when the scope is every
artifact of the target and every one of them has covering evidence; otherwise the event is
**partially amended** — its effective actor stays the recorded one and each artifact in scope
carries its own effective actor. The real cases we have are partial: bfe87c3 swept another
agent's files into a commit that also carried the committer's own. Multi-actor attribution is
therefore several amendments on one target with **disjoint** scopes, not one amendment naming
several actors. Artifacts outside the target's own list are `scope_invalid`.

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
The operator's authority **selects** a corroborated correction; it does not manufacture one: a
human-sealed amendment with no qualifying covering-window evidence is sealed but `uncorroborated`,
exactly like any other. Honest limit, stated: when one person operates every agent (this repo),
Tier 1 independence is between the human and the ledger's evidence, not between two humans
(#1890, finding 2). `operator.id ≠ to.id` holds trivially for agent beneficiaries and is asserted
anyway.

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

**Evidence rule (both tiers).** `evidence` must contain, **for every artifact in the amendment's
scope**, at least one ledger-native reference that corroborates `to` on that artifact, and core
must be able to check it against sealed data. Missing evidence for any artifact in scope is
`partial_coverage`: the whole amendment is ineffective, never "effective for the files it could
prove" — the amender narrows the scope instead, so that what is claimed and what is proven stay
the same set (Codex, finding 1). **Exactly one arm is sufficient on its own** — the covering-window
edit, because it is the only one anchored to a *stamped claim* that existed before anyone wanted
the correction. Stated plainly, because a reviewer had to say it (Codex, finding 2): a server stamp
proves **when** an assertion arrived and **under which credential**. It does not prove that an
edit happened, or what it contained. A beneficiary holding a valid pinned credential can log an
"edited" event on the right path inside the window and thereby manufacture the sole sufficient
arm; what stands between that and an effective amendment is the operator's Tier 1 selection. The
rule is conservative, not logically sufficient, and not the only evidence that could ever exist —
a producer-signed edit carrying a tree or patch digest that matches the target commit would be
stronger, and is the v2 upgrade path. v1 records a **`content_bound`** flag when the evidence
event's `change.after_hash` equals the blob hash of that path in the target commit's tree; the
check runs where git is available (reconcile, doctor, the CLI), and core only carries the flag it
is handed. The flag is information for the reader; it is not required. The other two arms are
corroborating flags:

- **Covering-window edit** (primary). An event in the same project whose **recorded** actor is
  `to`, that edits a file the target commit touched, and whose `seq` lies **strictly inside that
  file's capture window** — after the previous sealed touch of that path and before the target
  seal — exactly reconcile's `prevTouchSeq` loop, reused, not re-implemented. "Sealed before the
  target" is not enough: a year-old edit by `to` on the same path would corroborate a commit `to`
  did not write (Grok, finding 2). The evidence event must itself be **server-stamped**
  (`sealed_by` pinned or assert — an unstamped edit is not evidence) and must carry **no effective
  attribution amendment of its own**: an edit already amended away from `to` cannot corroborate
  `to`, and an edit's recorded actor is trusted exactly as far as the credential that stamped it —
  the same assumption the original seal made, no further (#1890, finding 1).
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

**Actor existence.** `to` — as a **{type,id} pair**, never the id alone — must already appear in
the project as a server-stamped actor (`sealed_by` pinned/assert/webhook) at least once before the
amendment. You cannot invent an actor by amendment (`unknown_actor`). Actor ids are not unique
across types (`agent/x` and `system/x` can both exist), so every comparison in this design —
`from` against the target, `to` against covering sets, relayer against accused and beneficiary —
compares the pair (Codex, finding 4). Today's coverage code collapses to `actor.id`; the amendment-
aware paths must not inherit that.

**Ordering and supersession.** `target.seq < amendment.seq` (`not_older`), same project
(`wrong_project`), `from` equals the target's current effective actor (`stale_from`), and if an
effective attribution amendment already exists whose scope **intersects** this one's, the new one
must name **the latest effective one** in `supersedes` (`no_supersede`); superseding replaces that
amendment in full, not only the overlapping artifacts. Ineffective amendments are not links in the
chain: naming one as `supersedes` is `no_supersede` too, so a rejected amendment cannot be used as
a stepping stone (#1890, finding 4). Latest effective amendment wins; the chain stays readable.

**When the rules are evaluated (v6).** Effectiveness is a property of the **final ledger**, not of
the moment an amendment was sealed. The collector re-derives every amendment from scratch over the
events it is given, in this order: amendments sorted by their **target's** seq ascending, then by
their own seq. Evidence events are edits that precede the target, so an amendment that changes an
evidence event's actor always has a smaller target seq than the amendment that relied on it and is
resolved first. Consequences, stated so nobody is surprised (Codex, finding 3): a later amendment
that re-attributes an evidence event away from `to` makes the earlier amendment that cited it
ineffective, retroactively, with reason `evidence_amended`; an amendment whose `supersedes` names
one that is ineffective in the final state is itself `no_supersede`, so a knocked-out link takes
its successors with it. That cascade is the fail-closed choice: a chain whose foundation was
withdrawn must be re-sealed on new evidence, visibly, rather than stand on a link that no longer
holds. `status` reports every ineffective amendment with its reason, so a cascade is loud. The
pre-seal check in the handler and CLI runs the identical function over the ledger as it stands at
that moment; "accepted at seal time, ineffective later" is a legal state and the only honest one.

**No-ops.** `to` equal to `from` is `no_op`.

**Targets.** The target must be an ordinary event. An attribution amendment may not target another
amendment (`action_detail: amended`) — otherwise a chain could be laundered by re-attributing the
amendment that fixed it (`target_is_amendment`). Corrections to an amendment are made by
superseding it, never by amending it. Nor may it target an `instructed` event
(`target_is_instruction`): the actor of an instruction is the human principal, which §2 puts out
of scope (#1890, finding 7).

Every rejection reason above is a new value in the existing rejected-amendment vocabulary
(`unrooted | missing_target | wrong_project | not_older` today). Added in v6: `partial_coverage`,
`scope_invalid`, `evidence_amended`.

## 5. Core API

New module `packages/core/src/attribution.ts`:

```ts
export interface AttributionAmendment {
  amendment_id: string; seq: number;
  target_id: string;
  from: ActorRef; to: ActorRef;           // {type,id} — compared as the pair, never id alone
  artifacts: string[];                    // scope; equals the target's full artifact list when omitted
  whole_event: boolean;                   // scope covers every artifact of the target
  tier: "human" | "relayed"; relayed_by?: string;
  evidence: string[]; reason: string;
  flags: { human_corroborated?: boolean; trailer_corroborated?: boolean; content_bound?: boolean };
  supersedes?: string;
}
export function collectAttributionAmendments(events: Event[], isRooted: (e: Event) => boolean)
  : { effective: Map<string /*target id*/, AttributionAmendment[]>; rejected: RejectedAmendment[] };
  // several effective amendments per target are legal when their scopes are disjoint; evaluation
  // order is target.seq, then amendment.seq, over the final ledger (§4)
export function effectiveActor(e: Event, amendments: Map<string, AttributionAmendment[]>)
  : { actor: Actor; recorded: Actor; amended?: AttributionAmendment;          // event level: changes only for whole_event
      by_artifact: Map<string, { actor: Actor; amended: AttributionAmendment }> }; // partial amendments live here
```

`collectProvenanceAmendments` stays as is; `status.ts` calls both.

The rules in §4 live in **one** pure function, `checkAttributionAmendment(candidate, events)`,
returning `{ ok: true, tier, flags, whole_event } | { ok: false, reason }`. The `content_bound`
flag is an input to it (`{ content_bound_artifacts: string[] }` computed by the caller that has
git), never something core infers. `collectAttributionAmendments` calls
it over sealed events; the MCP handler and the CLI call it over the candidate before sealing. Two
copies of the rules would drift (NOOA/Nemotron, finding 5).

## 6. Every consumer, and what it shows

| Surface | Today | With attribution amendments |
|---|---|---|
| `retrace_why` / explain.ts `describeActor` | recorded actor | whole-event: `«claude-code» [agent] (recorded as «claude-fable-5»; attribution amended by #N, human: <reason>)`; partial: the recorded actor leads, followed by `attribution amended for 2 of 7 artifacts by #N: status.test.ts, admin.ts → «grok» [agent]` — the count is always shown so a partial amendment cannot read as a whole one |
| `retrace_status` actors + capture | counts by recorded actor | counts by **effective event-level** actor (partial amendments do not move event counts); new fields `attribution_amendments`, `attribution_amended_events`, `partially_amended_events`, `ineffective_amendments` reasons broken out (including `evidence_amended` cascades); per-actor `amended_from` |
| reconcile `misattributed` | fail unless acknowledged | commit-level fail downgrades to `info` with `amended: {seq,id}` (distinct from `acknowledged`) **only if `to` ({type,id}) is in the covering set of every file that produced the fail and every such file is inside the amendment's scope** — the same bar the fail was computed with; the union `coveringActors` is not enough (Grok, finding 1: amend to whoever covered README and the whole commit goes green while `src/` is still someone else's). Files `to` did not cover stay per-file `misattributed: warn`. The covering set used for this test is built from **recorded** actors (§4). A commit with an open `producer_disagreement` is **never** downgraded: if the two seals disagree about who committed, amending one of them settles nothing (#1890, finding 3). `producer_disagreement` itself keeps comparing recorded actors |
| lineage | actor node per recorded actor | node for the effective actor; dashed edge `recorded-as` to the recorded one; a partial amendment draws the artifact-level edge only, the event node keeps its recorded actor |
| report / timeline UI | actor badge | badge `attribution amended`, hover shows recorded→effective and the amendment |
| export bundle | sealed events verbatim | unchanged bytes (the amendment events are already in the bundle); `retrace-export verify` prints `attribution amendments: N effective · M ineffective`; the **default** render prints the same count as an unsuppressable first-line banner (stdout, and mirrored to stderr) and marks each amended event `attribution amended → <to>` next to its recorded actor; `--effective` swaps the display to the effective actor with the recorded one in parentheses and prints an unsuppressable first line `effective view — recorded actors in parentheses; N amendments applied` (so a piped consumer cannot strip the pairing without stripping the header). A default render that hid the existence of amendments would break goal 2 (NOOA, finding 2) |
| git hook / Worker stamping | fixes WHO at seal time | unchanged — amendments never touch sealing |

The rule for every surface: **never show the effective actor without the recorded one within
reach.** The product's promise is that the wrong record stays visible; the amendment is added
context, not a replacement.

## 7. Tooling changes

- `retrace_amend` (MCP): add optional `attribution: { to: {type,id}, artifacts?: string[],
  evidence: string[], supersedes?: string }`. Mutually exclusive with `artifact_roles`/`attest_causal_root` in one call
  (one amendment, one kind). Handler pre-checks the same rules core will re-derive, so a bad
  call fails loudly before sealing an ineffective event; core remains the source of truth.
- `retrace-export amend-attribution --target <evt> --to <type/id> [--artifacts <path,…>]
  --evidence <evt,…> --reason "…" --caused-by <evt>` — the human-sealed path, owner token, prints
  the sealed event id. It runs the shared check first and, for a git target, computes
  `content_bound` per artifact from the local tree; it refuses to seal a candidate the check
  rejects unless `--seal-anyway` is passed (the ledger may record a failed attempt, but not by
  accident).
- `retrace_status`/`retrace_why` output text updated per §6; `docs/reference.md` tool table row for
  `retrace_amend` updated; README/examples "not built yet" lines flipped only when merged and
  demonstrated on seq 18.

## 8. Tests (adversarial first, following reconcile.test.ts conventions)

1. Accused amends itself away (Tier 2, relayer = `from`) → ineffective `self_interested`.
2. Beneficiary amends to itself (relayer = `to`) → `self_interested`.
3. Relayer shares model with target seal (#1227 shape) → `self_interested`.
4. Human-sealed, evidence is a covering-window edit by `to` → effective; status counters move; the
   target event's bytes unchanged (assert like status.test.ts:38).
4b. Target touched three files; scope omitted (all three); covering evidence for one →
   `partial_coverage`, and `why`/`status`/lineage still show the recorded actor everywhere.
4c. Same target, scope = that one file → effective as a **partial** amendment: the event-level
   effective actor is unchanged, `by_artifact` carries `to` for that file, `why` prints
   "1 of 3 artifacts", status counts `partially_amended_events` and not `attribution_amended_events`.
4d. Scope names an artifact the target never touched → `scope_invalid`.
4e. Two partial amendments to one target with disjoint scopes → both effective; a third whose
   scope overlaps the first without `supersedes` → `no_supersede`.
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
7e. Target is an `instructed` event → `target_is_instruction`.
7f. `supersedes` names an ineffective amendment → `no_supersede`; the effective chain is unbroken.
7g. Amendment A (target commit C) cites edit E; a later amendment re-attributes E away from `to` →
    A becomes `evidence_amended` in the final state, whatever order the events were sealed in.
7h. Cascade: B superseded A; A is knocked out as in 7g → B is `no_supersede`; status lists both
    reasons; re-sealing B' with fresh evidence and no `supersedes` (nothing effective remains) →
    effective.
7i. Determinism: the same events shuffled in input order produce the identical effective set
    (the collector sorts by target seq, then amendment seq).
5e. Evidence edit is unstamped, or itself carries an effective attribution amendment → `uncorroborated`.
5f. Human-sealed amendment with no covering-window evidence → `uncorroborated` (Tier 1 does not
    bypass the evidence rule).
5g. Evidence edit whose `change.after_hash` equals the target commit's blob hash for that path →
    `content_bound` flag set; a mismatching or absent hash → same effectiveness, flag unset (the
    flag never decides).
5h. A beneficiary's own credential logs an in-window "edited" event on the right path, then a
    human seals the amendment citing it → **effective** (documented limit, §4); the test exists so
    the limit is visible in the suite, not to bless it.
9e. Target commit has an open `producer_disagreement` → never downgraded, whatever the covering set.
8. Amendment sealed before target (pre-planted) → `not_older`.
9. Reconcile: misattributed commit + effective amendment to the actor that covered **every**
   failing file → `info` with `amended`; an amendment to an actor that covered only some files
   leaves the commit failing on the rest (per-file warns), and the gate stays red.
9b. Two-step laundering: amend the covering edit events to B, then check the later commit — the
   covering set must still use recorded actors, so the commit is **not** covered by B.
9c. Amend only the git-hook seal of a dual-sealed commit → no `producer_disagreement`.
9d. Amend only the webhook seal of a dual-sealed commit so the two *effective* actors agree while
    the recorded ones differ → `producer_disagreement` is still reported (it reads recorded actors).
9f. `agent/x` and `system/x` both present; covering evidence by `system/x`; amendment `to`
    `agent/x` → `uncorroborated`, and the reconcile downgrade does not fire (pair comparison).
10. Export round-trip: bundle verifies; the default render shows the amendment banner and per-event
    markers; `--effective` differs only in which actor leads the display.

## 9. Rollout on our own ledger

1. Land core + tests + MCP + CLI (one PR, reviewed by Codex and Grok, committed under the identity
   that wrote it — no bundling).
2. First real amendment, human-sealed by Jordan: seq 18 → `claude-code` — **contingent on**
   server-stamped claude-code edit events existing inside seq 18's capture windows. Check before
   promising; if day-one edits were not logged in the window, the amendment seals `uncorroborated`
   and seq 18 stays an honest `uncovered` gap. That outcome is acceptable and must not be forced. Second, and the better first demo: bfe87c3, **scoped** to the swept files → their real author,
   evidence the in-window edit events (c375ed4's correction is a `human_corroborated` flag, not
   evidence). It is a partial amendment by construction — the committer wrote some of that commit —
   which is exactly why v6 has scope. Both become `docs/examples.md` material.
3. Flip the README, examples, reference and battle-card lines from "not built yet" to earned.

## 10. Open questions — closed

Grok (2026-09-05): Q1 no Tier 2 in v1 and never let a relay supersede a human amendment; Q2 strict
capture window; Q3 render-time only ("a derived table that is not inside the event hash will get
treated as sealed"); Q4 out of v1 ("a successful amendment would look like a stronger claim than
the original seal"). Codex (2026-09-06, #2046) confirmed all four, with one qualification adopted
in v6: Q2's strict window is not sufficient on its own — it must come with whole-scope coverage
(§4 `partial_coverage`) and the honest statement of what a stamp proves. The four questions are
closed; the leans below are the decisions.

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
- **NOOA on Nemotron 3 Ultra, re-run by Grok against v4 (2026-09-05, sealed #1890, producer-signed;
  seven findings, all accepted, folded into v5):** (H1) evidence edits must be server-stamped and
  themselves unamended; (H2) Tier 1 clarified — the evidence rule binds humans too, single-operator
  limit stated, test 5f; (M3) open `producer_disagreement` blocks the downgrade, test 9e; (M4)
  `supersedes` must name the latest *effective* amendment, test 7f; (L5) default banner
  unsuppressable; (L6) `to.model` dropped from the v1 shape; (L7) `instructed` events may not be
  targets, test 7e. Q1–Q4 unchanged. §9's seq-18 rollout made contingent on evidence existing.
- **Codex on GPT-5.6 Sol (high), 2026-09-06, sealed #2046 under its own identity (its event
  self-reports `gpt-5`; the pane showed Sol — the known model self-report defect, recorded here so
  the review log does not repeat the ledger's understatement); four findings, all accepted, folded
  into v6:** (H1) one qualifying file re-attributed a whole multi-file event on every surface but
  reconcile → amendments are now **scoped to artifacts**, evidence is required for every artifact
  in scope (`partial_coverage`), and the event-level effective actor moves only for whole-event
  scope; tests 4b–4e. (M2) a server stamp proves receipt of a claim under a credential, not that
  an edit occurred → stated in §2 and §4 as the design's limit, `content_bound` flag added as
  information, producer-signed content digests named as the v2 path; tests 5g, 5h. (M3) temporal
  and supersession semantics were unspecified → final-ledger evaluation in target-seq order,
  `evidence_amended`, cascading `no_supersede`, determinism; tests 7g–7i. (L4) coverage compared
  `actor.id` while identity is `{type,id}` → pair comparison everywhere; test 9f. Codex confirmed
  Q1–Q4 and named the recorded/effective split, recorded-actor evidence, the amendment and
  instruction target bans, rooted human authorization and the single shared checker as sound.
  Fourth reviewer, third vendor; the review round is closed.
