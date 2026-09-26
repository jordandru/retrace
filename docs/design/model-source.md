# Model claims: source, omission, verification — design note v1 (agent-rules 4, v2)

**Status:** DRAFT v1.7, 2026-09-26 (v1 2026-09-20; v1.1, v1.2, v1.3 2026-09-23; v1.3 merged `6c208d9`; v1.4 merged `4c6443d`; v1.6 merged `cb91dd6`), author claude-code (coordinator, `claude-fable-5-1`), on Jordan's instruction
`evt_3f1973b9b8234267aeea0d238af89483`, from his rule audit `evt_376a8fc8ba4b48c3a38624f38b4335cf` ("true
provenance means making a true claim and avoiding omission") and the coordinator's decision
`evt_e7a318017ace472ab641e6940f7d5607`. **Class (a)** under agent-rules 12: it rewrites rule 4 and the
model line of every identity file. Design gate: Codex → NOOA (Nemotron, pinned) → Grok's seat; the author does not sit. Round 1 (head `45a44b0`):
Codex rejected, one High and three Medium (`evt_107148b1745d483dace12bd8535e681a`); all four applied in v1.1. Round 2
(head `c261aab`): Codex approved, NOOA approved with one Medium and three Lows, the Grok seat (cursor-agent) rejected
with one Medium and one Low; all applied in v1.2. Round 3 (head `8cdba1a`): Codex approved, NOOA approved, the Grok
seat rejected with one Medium (§4.4 not updated with the §4.1 change) and one Low; both applied in v1.3 (§8). Round 4 (head `99616bd`):
all three seats approved; merged. **v1.4 (round 5):** a dated correction to §4.1 and §7 step 2, found by the coordinator preparing
the step-2 build (`evt_f450c07129944f6d98cee30d6be9e5fc`): the resolver's displaced model pair cannot live inside the
producer-signed `method.params`; second claims move to `actor.model_claims` (§8 item 13). Companion to
`commit-trailer-consistency.md` (a claim is classified against evidence, never trusted), `effort-model-routing.md`
§5 (`models.json`, self-reported effort) and `orchflows-integration.md` §7 (the transcript witness). **Not built** (v1–v1.4).
**v1.5 (round 6): §7 step 2 is built and deployed** — PR 114 (builder cursor-agent) merged as `84095ed` 2026-09-24 04:59Z, Worker version
`798c1b7e` 05:03Z, doctor READY `evt_f340c19e24e44bf99bef5efb4aeccbcf`; steps 3–5 are not built. v1.5 records what was built where
it differs from or adds to the design (§4.1 "as built", A7, §7, §8 round 6).
**v1.6 (round 7): §7 step 3 is built — 3a (code) merged, 3b (this pull request) adopts rule 4 v2.** PR 118 (builder
cursor-agent, class S; Codex rounds 1–3, claude-code last) merged as `1bbb5a7` 2026-09-24 10:11Z (`evt_f5f75ea824704571b446e8e5d6100179`);
**not deployed** at the time of writing (Worker still `798c1b7e` from step 2). Two coordinator decisions Jordan accepted
before the build (proposal `evt_a11a4e3f…`, go `evt_835a645d3f924ebeb383670945063259`) are recorded in §4.3 as dated corrections
(Decisions A and B); §4.1's known limit is closed; §4.6 records the adoption; §7 step 3 records what was built; §8 round 7 lists
the dispositions; §8 round 8 records this pull request's own gate. v1.5 merged `38c58b0`.
**v1.7 (round 9, author claude-code on `claude-opus-5-5`): §7 step 4 is built, merged and deployed.** PR 123 (builder cursor-agent,
class S; Codex rounds 1–5 and two claude-code last-seat reviews) merged as `3c85e37` 2026-09-25 21:12Z
(`evt_2038999674ea4eefa7fe66078b2562ec`); Worker version `ce4b496b` 21:20Z (`evt_192f943fe4a64d08a1a3da7e1dbe26a7`). Its landing-page
sentence needed a footer entry first — PR 125, `cf2ee7b` — and went live as Pages `d57c3fa6` (`evt_7abd96da683b4d7693297cfa663b2411`).
Codex's round-1 F3 (the routing skill's registry-reading text) was split into PR 126 by Jordan's decision
(`evt_b145eabbf8a6462e89446fab17853476`), merged `29d4bc8` 2026-09-26 00:20Z. v1.7 appends what was built where it differs from the
design (§4.3, §4.4, §7 step 4) and the dispositions (§8 round 9); no earlier text is changed. Step 5 is not built.
Corrections before merge are made in place (Jordan, `evt_9dc98206`); after merge, appended (agent-rules 10).

## 1. The problem

Rule 4 today: "`actor.model` is the exact string your harness reports for the running session … If the harness
exposes nothing, omit the field; never pin a value and never guess." Omission was chosen as the least-false
option. It is not the truest, because a blank collapses at least four different facts into one absence:

1. the harness exposes no identifier anywhere;
2. the harness shows one (a status bar, a settings label) and the seat did not count that as "reporting";
3. the harness reports one the seat has reason to distrust (earlier Codex sessions wrote `gpt-5` under newer models,
   which `AGENTS.md` lines 10–12 record as the reason Codex omits; which harness source produced `gpt-5` is not
   recorded there — see §4.2);
4. a producer defect dropped the field.

A reader of the ledger cannot tell these apart, and the number is not small. Counted on 2026-09-20 ~10:00Z by
paging `GET /projects/retrace/events?actor_id=<seat>&limit=1000` over the live project (`retrace_status`'s
own `agent_events_without_model` read 368 at 05:14Z the same day; the difference is events sealed since and the
status window):

| seat | agent events | no `actor.model` | share |
|---|---|---|---|
| codex | 1,216 | 321 | 26% |
| grok | 405 | 67 | 17% |
| claude-code | 1,131 | 26 | 2% |
| gemini | 7 | 2 | — |
| cursor-agent, github-copilot, nooa, claude-cowork, openclaw | 856 | 0 | 0% |

Two live examples of fact 2 and fact 3 from this very week; whether the remaining 65 Grok blanks share this cause
is unknown from the ledger (NOOA round 2, `evt_bc1cd0f7`). Grok Build's status bar reads `Grok 4.6 (xhigh)`
and its verdicts on PR 73 and PR 90 carry no model (`evt_9bcc587e…`, `evt_08be04d4…`): a harness string
existed and was not recorded. This session's own harness hands the coordinator `claude-fable-5-1` at runtime
while its settings file names `claude-fable-5-1[1m]`, and the previous coordinator pane recorded
`claude-opus-5[1m]`: two harness sources, two spellings, and today the ledger cannot say which kind of source a
value came from.

## 2. What is true today, from the code at `0d294eb`

*v1.5, 2026-09-24: this section is the dated snapshot at `0d294eb` that the design was written against. The schema, resolver
and MCP facts below changed when step 2 shipped (`84095ed`); the as-built state is in §4.1.*

- **Schema.** `Actor.model` is `z.string().optional()` with no source field (`packages/core/src/schema.ts:14–25`).
  `Actor` has no `catchall`, so an unknown key on the actor is **stripped silently** by the deployed Worker
  ("a producer running newer code than the deployment loses those fields with no error", `schema.ts:196`). Any
  new actor field must be deployed server-side before a producer sends it. `method.params` does round-trip.
- **Who fixes the model: nobody.** For a pinned credential the Worker stamps `actor.type`/`id`/`on_behalf_of`
  from the credential and takes `model` from the request body when the credential names none
  (`packages/core/src/router.ts:370–375`: "A pinned credential fixes WHO is acting, not WHICH MODEL ran"). So
  `actor.model` is **producer testimony**, server-recorded, never server-verified. This note does not change
  that; it makes the testimony say what kind of testimony it is.
- **MCP server.** `RETRACE_ACTOR_MODEL` pins a value; when unpinned, the caller's runtime model is accepted
  (`packages/mcp-server/src/index.ts:69, 204–207`). No harness config on this machine sets the pin (removed
  2026-08-30 because it overrode the real model).
- **Git.** `Retrace-Model:` is a trailer claim parsed by `commit-actor.ts:107`; `Co-Authored-By` yields a
  family and sometimes a slug (`:66–74`). Rule 6 already classifies trailers as claims.
- **Consumers.** `status.ts:113` counts agent events without a model; `doctor.ts:267–336` warns when a review
  event's model is missing or not in `routing-rules/models.json`, and when it differs from the routed model.
  `models.json` aliases display strings to ids (`"Grok 4.6"`, `"GPT-5.6 Sol"`, `"claude-opus-4.8"`).
- **Identity files disagree.** `.cursor/rules/retrace-provenance.mdc:13–16` says report Cursor's display
  string verbatim "even when it is a display name"; `AGENTS.md:10–12` and `.github/copilot-instructions.md:10`
  say omit; `GROK.md` allows "the literal string in front of you" and Grok omitted anyway. Whether the 65 other blank
  Grok events had the same display is unverified from the ledger.

## 3. Principle

**Record what is known and how it is known. Make the unknown loud. Name the check that would close it.** This is
the same shape the trailer-consistency design gave commit claims and `effort-model-routing` gave effort
(`reasoning_effort: not_exposed` is already a sourced non-answer). A model claim becomes: a value, a source, and
later a witness.

## 4. Design

### 4.1 `actor.model_source`

A new optional enum beside `actor.model`:

| value | meaning | example |
|---|---|---|
| `harness-runtime` | the identifier the harness hands the running session programmatically | Claude Code's session context; Codex's runtime API |
| `harness-config` | a configured value the harness uses for this session | `~/.claude/settings.json` `model`; `RETRACE_ACTOR_MODEL` |
| `harness-display` | a label the harness shows the operator for this session | Grok Build's status bar; Cursor's model picker name |
| `self-report` | the model's own statement about what it is, with no harness source | a model answering "which model are you" |
| `operator-stated` | a human told the seat which model runs | Jordan's statement recorded in an `instructed` event |
| `none` | nothing available anywhere; `model` is absent | a harness that exposes no identifier and shows none |

**Rules of use.**

- One value in `model`, one source in `model_source`. Precedence when several exist: `harness-runtime` >
  `harness-config` > `harness-display` > `operator-stated` > `self-report`. The seat records the highest
  available, **except** that a source it has documented reason to distrust is recorded in second place, never
  first (§4.2). `self-report` alone never fills `model`: it goes in `model_claims` and `model_source` is `none`.
- Every other claim the seat holds goes in `method.params.model_claims: [{ "value", "source", "note"? }]`. This
  field round-trips today, so it can be used before the schema deploys.
  *Correction, 2026-09-24 01:45Z (2026-09-23 19:45 MDT; source `evt_f450c07129944f6d98cee30d6be9e5fc`, see the
  pins bullet below): after the step-2 deploy, second claims live on the actor, `actor.model_claims: [{ "value",
  "source", "note"? }]`, a schema field added in that deploy. `method.params.model_claims` stays what it was chosen
  for — the interim carrier that round-trips before the deploy — and a consumer reads both, the actor field first.*
  *As built (v1.5; PR 114 `84095ed`; sources: Codex round 1 `evt_b156f9428eba43208d0d823d6d495fe9` (design
  assessment), Codex round 3 `evt_7388157112ac4057a22af1c01d916851` (approval, no findings), claude-code
  `evt_9bff330286f34259b47806c57e3ce683`): a claim is `{ value, source?, note? }` with `value` non-empty and `source`
  **optional** — a displaced legacy value that carried no `model_source` is recorded without one rather than with an
  invented one (Codex round 1: "displaced legacy values must not acquire an invented source"); a consumer counts a
  source-less claim as legacy. (v1.5.1: the quotation is cited to the round-1 verdict where it appears; round 3 records the
  approval — NOOA Low 1 `evt_d4eda292`, Codex Low 1 `evt_1c722c8d`.)*
- **Omission becomes a fact.** An agent event with no `model` carries `model_source: "none"`. A blank with no
  source is, after adoption, a producer defect — which is what fact 4 in §1 always was.
- **A displayed string is a report, recorded whole.** Grok records exactly what its status bar shows — `Grok 4.6
  (xhigh)`, effort suffix included — with `harness-display`; Cursor already records its display name. The seat never
  trims, splits or normalises the string (rule 4 unchanged on that). Splitting it is the registry's job: `models.json`
  gains, per model, an optional `display_pattern` — for `grok-4.6`, `^Grok 4\.6(?: \((low|medium|high|xhigh)\))?$` —
  that `doctor` and the routing skill apply after the exact-alias lookup; a captured level fills `reasoning_effort`
  only when the event reports none, and a value the event does report wins. A display string that matches neither an
  alias nor a pattern is unregistered and `doctor` warns as it does today. (v1.2, cursor-agent F1 in the Grok seat,
  `evt_daa3354bdc984a978edacfae868e333a`: v1.1's A2 asked for `Grok 4.6`, which the registry aliases, while §4.6 asked
  for the exact display, and a pane showing `Grok 4.6 (xhigh)` could not do both.)
- **Pins resolve value and source together** (v1.1, Codex F2). Two places can replace the value a producer sent: a
  credential that names a model (`router.ts:365–376`, `resolveActor`, which today copies only `display_name`,
  `version` and a body `model` onto the pinned actor) and the MCP server's configured model
  (`packages/mcp-server/src/index.ts:204–207`). Each is itself a source — a seventh value, `credential-pinned`, for the
  first; `harness-config` for the second — and whichever replaces the value replaces the source **in the same
  operation**, pushing the displaced `{value, source}` into `model_claims`. A value from one origin paired with a source
  from another is never produced by a conforming resolver; a consumer that meets one (a `model_source` that cannot have
  produced the value beside it) reports `source: inconsistent` and counts the event with the source-less ones. When
  both `actor.model_source` and the interim `method.params.model_source` (§7 step 2) are present, the actor field is
  the value of record and a disagreement is a producer defect that `doctor` lists.
  *Correction, 2026-09-24 01:45Z (2026-09-23 19:45 MDT; source: the coordinator's step-2 preparation,
  `evt_f450c07129944f6d98cee30d6be9e5fc`, from `packages/core/src/producer-sig.ts` lines 11–20 and 78–90 at `6c208d9`):
  "pushing the displaced `{value, source}` into `model_claims`" cannot mean `method.params.model_claims` when the Worker's
  resolver does the pushing. The producer signature covers `method.params` minus the server's reserved list (`sealed_by`,
  `producer_sig_verdict`, `relayed_by`, `caused_by_problem`; on /2 also `claim_decision`, `producer_signed_actor`), and
  that list is fixed per signature format — adding a name is `retrace-producer-sig/3`. A server that wrote into
  `method.params` after resolution would make every producer-signed event sealed on a model-pinning credential verify
  `invalid`. The signature deliberately does not cover `actor.model`, `display_name` or `version`, so the actor object is
  the surface the server already rewrites. Therefore the displaced pair goes to `actor.model_claims` (previous bullet),
  in the same operation as before; nothing is dropped. Scope today: the credentials mirror (read 2026-09-24 01:40Z,
  names and the presence of a `model` key only) lists nine pinned credentials and none names a model, so the
  `credential-pinned` branch is exercised by tests until an operator pins one. The MCP server's `harness-config`
  replacement happens client-side before signing and is unaffected. The v1.3 sentence above stays visible (rule 10).*
  *As built (v1.5; PR 114 `84095ed`, three review rounds, §8 round 6).* **Refinement.** `Actor` and the MCP tool input
  schema carry a presence-based rule: `model_source` other than `none` requires `model`; `none` requires `model` absent. A
  body that violates it is an invalid event — 400 at `POST /events`, a refusal at the tool boundary of the local and the
  hosted MCP servers before any write — never repaired into a sealed contradiction (Codex F1). Legacy forms (model only;
  neither) stay valid. **Worker resolver** (`router.ts` `resolveActor`): a credential that names no model copies
  `model`, `model_source` and `model_claims` as sent, inventing nothing; a credential that names a model stamps
  `model_source: credential-pinned` and, only when the body's model is non-empty and differs, appends the displaced pair
  `{ value, source? (the body's), note }` to `actor.model_claims`; an empty-string legacy model is treated as absent for
  displacement — no claim is built from it and the legacy string contract is unchanged (Codex F4). **MCP server**
  (`index.ts`): `RETRACE_ACTOR_MODEL` carries `harness-config`; with the actor lock on the configured model is
  authoritative and a differing caller pair is displaced onto the actor before signing; with the lock off model and
  source resolve together — a caller override never inherits `harness-config`, and an explicit caller `none` is kept when
  no configured model replaces it (Codex F2 and follow-up). **Hosted MCP** (`apps/worker/src/mcp.ts`): the adapter
  forwards the credential's identity (`type`, `id`, `on_behalf_of`) plus the caller's fields exactly as sent and never
  the credential's model, so the router remains the one place that pins a model (Codex F3, re-raised once; scope grew by
  this file). **Advertised surface:** `schemaSurface()` gains an `actor` group so doctor's "would drop" check sees an
  older Worker (`doctor.ts` `missingSchema`). **Known limit (Low, claude-code `evt_9bff3302`):** an empty-string
  `model` paired with a non-`none` source passes the presence-based refinement because the string is defined, so an
  unpinned path can store `model: ""` with a source; no wrong belief follows and pinned paths already treat `""` as
  absent (`packages/core/src/router.ts:385` `body.model !== ""`; `packages/mcp-server/src/index.ts:205`
  `callerActor.model !== ""`, both at `84095ed`; cited in v1.5.1 for NOOA Low 4). Step 3 treats `""` as absent in the
  refinement or the resolvers when producers begin sending sources.
  *Closed in step 3 (v1.6; PR 118 `1bbb5a7`, 2026-09-24): the refinement in `schema.ts`, its mirror in `audit-mcp.ts` and
  both resolvers treat `""` as absent. The resolver halves were found by Codex, not by the build: round 1
  (`evt_f3075806b5244ebcbaee9303b50389fb`) F1 — an empty configured model with the actor lock off re-acquired
  `harness-config` and the refinement then refused the seat's own logs — and F2 — an empty credential pin acquired
  `credential-pinned` and every write on that credential returned 500; round 2 (`evt_316307aaee59460bb9d0297ab81078ac`)
  re-raised F2 for the credential's `model_source: none` inherited by a source-less caller model. Both are fixed at
  `fb431c3` (`evt_3e05f3a34b2542848b8389ec4e25b254`): a credential with no model pin contributes identity only, and
  the sealed actor carries the caller's `model` / `model_source` / `model_claims` exactly as sent.*

### 4.2 The Codex case, as far as the evidence goes

`AGENTS.md` lines 10–12 record that earlier Codex sessions wrote `gpt-5` under newer models. They do **not** record
which harness source produced `gpt-5`, what the pane displayed at the time, or that the mechanism was family-versus-model
reporting (v1 asserted all three; Codex F3, `evt_107148b1`). So the origin of the historical `gpt-5` values is unknown and
is not asserted here. The rule is stated conditionally: **if** a session observes two harness sources disagreeing — say a
runtime string `X` and a displayed string `Y` — and records that observation in the session, the event carries
`model: "Y"`, `model_source: "harness-display"`, and `model_claims: [{ "value": "X", "source": "harness-runtime",
"note": "<what was observed, and where>" }]`, with the distrusted source in second place per §4.1. Two true statements
replace one blank. Once the sources agree again the precedence applies unchanged and `model_claims` is empty. No
historical event is re-attributed by this section.

### 4.3 Git trailers

A fourth trailer, `Retrace-Model-Source: <value>`, parsed by `commit-actor.ts` beside `Retrace-Model`. When
`Retrace-Model` is absent, `Retrace-Model-Source: none` is **required** on an agent commit.

**Model completeness is a separate finding from contribution classification** (v1.1, Codex F1, `evt_107148b1`). The
trailer-consistency classifier decides `supported` / `conflicting` / `unresolved` from the actor claim against pinned
edit evidence alone (`classify.ts` `decideFromTable`, ~line 738), and `wouldWrite` (~line 701) withholds `conflicting`
under every policy and `unresolved` only under `withhold`. Whether the commit names a model, and how, never enters that
decision: a commit whose `Retrace-Actor` the evidence contradicts stays `conflicting` and withheld with or without a
model trailer, and a supported actor stays `supported`. Beside the claim decision the hook and classifier record a
**model completeness** result — `model_claim: complete` (both trailers) | `source-missing` (`Retrace-Model` without a
source) | `none` (`Retrace-Model-Source: none`, no model) | `absent` (neither) — and `absent` is a producer defect after
adoption, listed by `doctor` and counted by `status`, never a change of the actor's status.
*Decision A (v1.6; coordinator proposal `evt_a11a4e3f…` accepted by Jordan `evt_835a645d3f924ebeb383670945063259`,
2026-09-24; built in PR 118): a fifth value, `inconsistent`, for a pair the resolver cannot pair — `Retrace-Model-Source:
none` beside a model, a source other than `none` with no model, or a source value outside the seven. An inconsistent pair
sets **no** `actor.model_source` (the actor still passes the presence-based refinement and the commit seals, never a 400)
and is reported as `model_claim: inconsistent`; the original trailer text stays in `method.params.raw_message` (both
git producers preserve the whole message; `ClaimRecord.raw_trailers` holds only `retrace-actor` and `co-authored-by` —
PR 119 round 1, Codex F4 `evt_752b8e82…`). Reason: a producer defect in a
trailer must not cost the seal that records it, and the value must not be silently coerced into one of the four.* v1 said a commit with
neither trailer "is classified `unresolved` … exactly as a commit with no trailer is today"; that was wrong twice: it
would have let omission turn a `conflicting` (withheld) claim into an `unresolved` one that the `record` policy
writes, and a commit with no trailer at all is not uniformly `unresolved` today (a human-authored commit with no
agent evidence is `no_agent_evidence`, `classify.ts` ~line 745).
`Co-Authored-By`-derived models get `model_source: "harness-config"` only when the harness wrote the line
itself (VS Code, Copilot); a hand-written co-author line is `operator-stated`.
*As built (v1.7; the `model claim absent` listing, PR 123): the producers record `model_claim: absent` on **every** commit that
yields no model from any source and carries no `Retrace-Model-Source` — a human's hand merge and the checkpoint bot's commits included
(`commit-actor.ts` applies the completeness table to every resolved actor). A model taken from an agent `Co-Authored-By` line is not
absent: it is `source-missing` (Decision B below). "A producer defect after adoption" holds for an agent commit, so `doctor` reads the claim and the agent
evidence only from the commit's own **seals** — events that record a string `model_claim` and name the commit through a `commit:`
artifact with role `generated` (today the hook and the webhook's push handler); reads, reviews, CI runs and GitHub's PR-merge event
never count. Evidence is (a) an agent actor on a seal or (b) `location.surface: agent` on the hook's seal, which means the committing
git process had **no controlling terminal** (`ttySurface`, `git-hook.ts:241`) — true of agent sessions and also of a human's
IDE-button commit, which the finding says in words. Absent commits without that evidence are reported as a count "not counted as
defects", stating only the evidence (the one live case is a `retrace-checkpoint[bot]` system commit, `evt_262efc88`). The listing counts
distinct commits (`status` counts agent events — a different figure). (PR 123 claude-code last seat M1, L1; Codex rounds 3–4, M1 and M3.)*

*Decision B (v1.6; same proposal and go as Decision A; built in PR 118): the sentence above is withdrawn as a resolver
rule. A `Co-Authored-By`-derived model carries **no** `model_source` and completeness `source-missing`, unless a
`Retrace-Model-Source` trailer is present, in which case the trailer rule applies. Reason: the commit message alone cannot
tell a harness-written co-author line from a hand-written one, and a resolver that guessed between `harness-config` and
`operator-stated` would seal a source it has no evidence for — the v1 error in a new place. The distinction stays a
consumer's question (§4.4) for a harness that states it.*

### 4.4 Consumers

- `status`: `agent_events_by_model_source` per actor, and `agent_events_without_model` split into
  `source none` vs `no source recorded` (legacy).
- `doctor`: the existing `review model` finding reads the source: `none` → WARN as today; `self-report` only →
  WARN "model is the reviewer's own word"; `harness-display` with a registry alias **or a `display_pattern` match** (§4.1) → PASS (v1.3, cursor-agent round 3,
  `evt_52b36fe4`: v1.2 left this line alias-only, so a pane showing `Grok 4.6 (xhigh)` passed A2 but not §4.4). Under `--gate`, a
  review whose model source is `none` or `self-report` counts as no model, which is what R1/R3 already need.
- Landing page and README: the count of agent events without a model becomes a sentence with its cause split, not
  a footnote.

*As built (v1.7; step 4, PR 123 `3c85e37`, where it differs from the lines above):*
- *`status` counts `agent_events_by_model_source` over the whole project, not per actor — the build brief asked for the project-wide
  split, and A5 is met by it; a per-actor split is not built. `agent_events_without_model_by_cause` partitions the old count exactly
  (`source_none` + `no_source_recorded`), an empty-string model counting as absent. Live after the deploy: 557 of 5,223 agent events
  without a model — 2 declared `none`, 555 with no source recorded (`evt_192f943f`).*
- *`doctor`'s `review model` finding: `none` and `self-report` as specified; a registered model with **no** `model_source` field
  (legacy) warns in its own bucket, distinct from an unregistered model (Codex PR 123 round 1, F1). Under `--gate` the same findings
  apply as warnings; the `opts.gate` parameter the build added is not read, so "counts as no model" means the same advisory warning,
  not a gate failure.*
- *§4.3's "counted by `status`" for `model_claim: absent` is not built; the listing is `doctor`'s only (next item).*

### 4.5 Verification (v2)

The credential cannot verify the model (`router.ts:370`), and the server never will. What can: the host's own
record. Orchflows' `history inspect` (pinned at `6eb8af4`, `orchflows-integration.md` §7) reads model metadata
from Claude Code's native transcript, children included; for Codex that note records that delegation bodies are
"encrypted and reported `unavailable`", so the Codex witness is limited to whatever `inspect` exposes for the host
session and is unverified until trialed (NOOA round 2, `evt_bc1cd0f7`, finding 4). A local doctor advisory compares the
event's `model` with the transcript's, records `method.params.model_witness: { "source": "native-transcript",
"match": true|false, "value": "<what the transcript says>" }` on an appended, not amended, event, and never
uploads the transcript (a credential sink, `evt_c21df545`). Where no transcript exists (Grok Build, Cursor),
the claim stays a claim and the ledger says so.

### 4.6 Rule 4, proposed text (v2)

> **Report the model and how you know it.** `actor.model` is the exact string your harness reports, configures
> or displays for the running session — not shortened, not normalised, not a nicer name — and
> `actor.model_source` says which of those it was (`harness-runtime`, `harness-config`, `harness-display`,
> `credential-pinned`, `operator-stated`; a harness source outranks `operator-stated`, which outranks the model's
> own statement). A harness label you can see counts as a report. A source you have documented reason to
> distrust is recorded as a second claim, never as the first. When nothing is available, `model` is absent and
> `model_source` is `none`: the unknown is recorded, never silent. The model's own statement about itself is
> never the sole source. Aliasing spellings to ids is the routing registry's job, not yours.

Identity files change with it: `AGENTS.md:10–12`, `.github/copilot-instructions.md:10`, `GROK.md` (the "no env,
no config, no API" sentence becomes "the status bar is the source: `harness-display`"), `CLAUDE.md`, and
`.cursor/rules/retrace-provenance.mdc` (already compliant; gains the source word).
*Adopted (v1.6, 2026-09-24, step 3b): the boxed text is now `docs/agent-rules.md` rule 4 v2, with its v1 text kept
visible in the rule; rule 6 gains the `Retrace-Model-Source` trailer sentence (`none` when `Retrace-Model` is omitted;
`model_claim` completeness recorded by hook and webhook). The five identity files changed with it; each names the source
that is true for its harness: `claude-code` `harness-runtime`; `codex` `harness-runtime` — its session's native
rollout `turn_context`, found by Codex itself while reviewing this pull request (`evt_75c70d32ffe84cd3a5d74cc3bea8e4ba`;
first review verdict after that discovery to record the model, `evt_752b8e82101a4618955e11d4e38d5c40`), which retires the "runtime exposes nothing"
sentence the first draft of this PR carried; `grok` and `cursor-agent` `harness-display`; `github-copilot` whichever of
the three harness sources is true for the session. Rule 6's omission condition changed with it (Codex F1): a trailer
is omitted only when no usable source exists, not merely when the runtime exposes none.*

## 5. What is not claimed, and the limits

- `model_source` is itself producer testimony. It makes the testimony legible; only §4.5 checks it.
- Nothing here says what model a vendor's API actually served. That is outside every harness's evidence.
- **The 416 existing blank events are not bulk-amended.** Sealed events are corrected by amendment on evidence
  (rule 10), and for most of them the evidence is gone with the pane. They are reported as legacy (no source
  recorded) and stay counted. Where evidence exists **per event** — a Grok event whose session is identified and
  whose display at the time is attested (a dated screenshot, a `sent`/`received` event quoting the status bar, or
  Jordan's scoped operator statement naming the seq range he witnessed) — a single appended correction event citing
  that evidence and the exact seq set is the honest maximum, and it is Jordan's seal (rule 14). v1 asserted that all
  67 blank Grok events came from panes displaying `Grok 4.6`; the cited evidence is two examples in §1 and aggregate
  counts, not a per-event mapping (Codex F4, `evt_107148b1`). The correction is restricted to the proven subset; the
  rest remain legacy unknowns.
- Effort already follows this pattern (`not_exposed`, `unset`). This note changes effort in one place only: when a
  displayed model string carries an effort suffix and the event reports no `reasoning_effort`, the registry's
  `display_pattern` fills it (§4.1); a reported value always wins.

## 6. Acceptance for v1

- A1 Every agent event sealed after adoption carries either a `model` with a `model_source`, or `model_source:
  none` — status reports zero source-less agent events after the adoption seq.
- A2 Grok's next verdict carries its exact status-bar string (e.g. `Grok 4.6 (xhigh)`) with `harness-display`, and
  doctor's `review model` check passes it through the registry's alias or `display_pattern` for `grok-4.6`.
- A3 A session that observes two harness sources disagreeing, and records the observation, carries both claims as in
  §4.2; no historical `gpt-5` event is re-attributed.
- A4 An agent commit with no `Retrace-Model` and no `Retrace-Model-Source: none` carries `model_claim: absent` and is
  listed by `doctor`; its contribution status (`supported` / `conflicting` / `unresolved`) is unchanged by that.
- A5 `status` shows the per-source split; the landing page's sentence about missing models names the causes.
- A6 No sealed event is edited; corrections are appended (rule 10).
- A7 (v1.4) A producer-signed event sealed on a credential that names a model, whose body reports a different model,
  verifies `verified` after resolution and carries the displaced pair in `actor.model_claims`; a test in
  `producer-sig.test.ts` or `server.test.ts` shows it.
  *Met at `8557981e` (PR 114): `packages/core/src/router.test.ts` "credentials: A7 producer-signed body whose model
  differs from the credential stays verified with the displaced pair on actor.model_claims" — through `POST /events`
  with a producer-signed body on a model-pinning credential, beside the resolver fixture (cursor-agent's round-5 Low,
  `evt_8b40023e632c41d5814a2d727b492a23`, resolved there rather than in the files this line named).*

## 7. Build order

1. This note (gate).
2. Schema: `Actor.model_source` (`schema.ts`, class S in the routing rules) **and, in the same deploy, the resolver**:
   `resolveActor` (`router.ts:365–376`) copies `model_source` onto the pinned actor and, when the credential replaces
   the model, sets `model_source: credential-pinned` and pushes the displaced pair into `method.params.model_claims`
   (§4.1) — *corrected 2026-09-24 (`evt_f450c071…`, §4.1): into `actor.model_claims`, a second optional `Actor` field
   added in this step, because the signature covers `method.params`; the interim carrier below is unchanged*; the MCP server does the same for its configured model (`index.ts:204–207`, source `harness-config`). Until
   that deploy, producers write `method.params.model_source` **and** `method.params.model_claimed` (the value the source
   describes); a consumer reads the interim source only when `model_claimed` equals the sealed `actor.model`, and
   otherwise reports `source: inconsistent` (§4.1) — because today the credential can replace the value while
   `method.params` passes through unchanged (`router.ts:782–798`).
   *Built and deployed (v1.5): PR 114, merge `84095ed` (2026-09-24 04:59Z), Worker `798c1b7e` (05:03Z), doctor READY
   `evt_f340c19e`. Two `Actor` fields shipped (`model_source`, `model_claims`), both resolvers, the hosted MCP adapter and
   the `schemaSurface` actor group. Doctor's deployment-schema check failed by design from the first commit until the
   deploy (a build ahead of the Worker; owner exception `evt_a8c6b96b3fe54db18cf95ae287d472c7`, precedent 2026-09-10);
   issue #113 asks doctor to record that acknowledged gap itself instead of relying on a human to remember. Interim
   `method.params` carrier: no repository producer implemented it, and a ledger text search for `model_claimed` on
   2026-09-24 05:19Z returned only prose about this note (its edit, commit and review events), not a producer write
   (Codex's own repository and ledger searches found the same, `evt_1c722c8d`); that is a prose search, not a field-level
   census of historical `method.params`. It stays defined for producers that predate the schema (§4.1). (v1.5.1 wording
   for NOOA Low 2 and Codex Low 2; v1.5.2 describes the returned events accurately, Codex round-2 Low `evt_06953aa6`.)*
3. Producers: MCP server (`RETRACE_ACTOR_MODEL_SOURCE`, and the caller's runtime source), git hook and
   `commit-actor.ts` (trailer), identity files, rule 4 text.
   *Built (v1.6). 3a, code — PR 118, merge `1bbb5a7` (2026-09-24 10:11Z, `evt_f5f75ea8…`): `commit-actor.ts` parses
   `Retrace-Model-Source` beside `Retrace-Model` and exposes the five-value `modelClaim` (Decisions A and B); `classify.ts`
   records `ClaimRecord.model_claim` and the decision table is untouched (a test drives all five values through
   `decideFromTable` and `wouldWrite`); `git-hook.ts` and `github.ts` carry `actor.model_source` from the resolver and
   `method.params.model_claim` in parity; `index.ts` validates `RETRACE_ACTOR_MODEL_SOURCE` at startup; the empty-string
   limit above is closed. 622 tests. 3b, docs — this pull request. Not deployed: the Worker at `798c1b7e` runs step 2;
   the hook that sealed PR 118's own commits ran the pre-3a dist, so those commits carry no `model_claim`.*
4. Consumers: status split, doctor source-aware `review model` and a listing of `model_claim: absent` commits as
   producer defects (§4.3), `models.json` `display_pattern` (a class-S path under the routing skill), landing/README
   sentence.
   *Built (v1.7). PR 123, builder cursor-agent from the coordinator's brief (sha256 `14ec2042…`), merged `3c85e37`
   (2026-09-25 21:12Z): `status.ts` per-source split and cause split (and the embedded viewer, every server value escaped);
   `models.json` `display_patterns` (list; a singular `display_pattern` folded in) on `grok-4.6`, and a `claude-opus-5-5` row with
   levels to `max`; `resolveRoutingModel` exact key → alias → pattern with a captured level; `doctor`'s source-aware review model
   and the seal-based absent listing (§4.3, §4.4 as built); README and landing sentence. Tests at the merged tip 361 / 238 / 36.
   Worker `ce4b496b` deployed 21:20Z: `check-deploy` current, `/status` returns the split, `/ui` byte-identical to the merged viewer.
   Landing footer entry PR 125 (`cf2ee7b`), Pages `d57c3fa6`. The routing skill's step 5 now reads the registry the same way
   (PR 126, `29d4bc8`). Not built: a per-actor split; §4.3's "counted by `status`" for
   absent claims (the listing is `doctor`'s only).*
5. Witness (§4.5), after the orchflows note's §9 answer or a by-hand read of `history inspect` output.

## 8. Dispositions

Round 1, head `45a44b0`, Codex (`gpt-6-astra`, high; routing `evt_10ecb7f819c045b6899e8500f7f9c830`): **rejected**
`evt_107148b1745d483dace12bd8535e681a`, 2026-09-23 22:47Z.

1. **F1 High — keep model completeness separate from contribution classification.** Accepted. §4.3 and A4 rewritten:
   the trailer decision is untouched by model trailers; a `model_claim` completeness result is recorded beside it; the
   false "uniformly `unresolved` today" sentence withdrawn.
2. **F2 Medium — bind the interim source to the model that survives actor resolution.** Accepted. §4.1 gains the
   pins-resolve-together rule and the `credential-pinned` source; §7 step 2 puts the resolver in the schema deploy and
   adds `model_claimed` to the interim carrier with an `inconsistent` outcome.
3. **F3 Medium — do not promote an unexplained old model value into runtime evidence.** Accepted. §1 fact 3 and §4.2
   rewritten as a conditional example; A3 no longer re-attributes history.
4. **F4 Medium — require evidence covering the entire Grok correction set.** Accepted. §5 restricts the correction to
   events with per-event display evidence or scoped operator testimony.

Codex also recorded: class (a) correct; §2 citations match the base; displaying a model does not conflict with rule 6;
the §4.6 wording still excludes guessing. Those are unchanged.

Round 2, head `c261aab` (v1.1). Codex re-check (medium; routing `evt_19e239af`): **approved**
`evt_f58f5e90802540fe9b1fff651a3ae757`, F1–F4 resolved, no new findings. Grok seat, held by cursor-agent on Jordan's
reassignment `evt_c4695784` (Cursor Grok 4.6, high; routing `evt_60806132`): **rejected**
`evt_daa3354bdc984a978edacfae868e333a`, 2026-09-23 23:14Z.

5. **F1 Medium — a Grok pane cannot jointly satisfy §4.6 and A2.** Accepted. §4.1's display bullet now records the
   string whole and gives the registry a `display_pattern` that yields the effort level; A2 restated; §7 step 4 lists
   the registry change.
6. **F2 Low — the boxed §4.6 omits `credential-pinned`.** Accepted; added.

cursor-agent also measured: §2 citations match; `decideFromTable` and `wouldWrite` never read the model; the §1 table is
a dated snapshot (live 501 of 4,414 without a model at review time); class (a) correct.

NOOA (Nemotron 3 Ultra, witness seat; routing `evt_f95bc45c`): **approved** `evt_bc1cd0f73d0449abb601822cc1eff095`,
2026-09-23 23:41Z, with four findings it called non-blocking; all applied because a Medium left standing would block
under team-roles rule 8.

7. **Medium — §1/§2 present the two Grok examples as if they characterise all 67 blanks.** Accepted; the two
   qualifying sentences NOOA proposed are added.
8. **Low — where `operator-stated` sits is in §4.1's precedence but not in the §4.6 rule text.** Accepted; one clause.
9. **Low — §7 step 4 did not name doctor's listing of `model_claim: absent`.** Accepted; added.
10. **Low — §4.5 claimed `history inspect` reads Codex's native transcripts.** Accepted: the cited orchflows note itself
    records that Codex delegation bodies are encrypted and reported unavailable; §4.5 now says so.

Round 3, head `8cdba1a` (v1.2). Codex re-check (medium; routing `evt_069bd460`): **approved**
`evt_c8546fa5ba7f46ee99534ce626538c0a`, no findings. NOOA (routing `evt_83357fb5`): **approved**
`evt_5d58ba90820243a78a8bf6c959d4f7f7`, no new Medium/High per its sealed summary (full text read after the host key is
reloaded). Grok seat, cursor-agent (medium; routing `evt_1f500953`): **rejected** `evt_52b36fe4998d480aa46fc9f9fd900aac`,
2026-09-23 23:59Z.

11. **Medium — §4.4's doctor PASS path was still alias-only, so a Grok pane showing `Grok 4.6 (xhigh)` could pass A2
    but not §4.4.** Accepted: §4.4 now reads alias or `display_pattern`. The round-2 fix had not been propagated there.
12. **Low — §5 still said this note does not touch effort.** Accepted: §5 now names the one place it does.

Round 5, v1.4, after merge (`6c208d9`). Coordinator's own finding while preparing the step-2 build
(`evt_f450c07129944f6d98cee30d6be9e5fc`, 2026-09-24 01:45Z), on Jordan's go `evt_9677a658d78a49bd9dc314cd8da9ec8e`.

13. **Design gap — the resolver's displaced pair would land inside the producer-signed `method.params`.** Corrected in
    place, dated and sourced, in §4.1 and §7 step 2: second claims move to `actor.model_claims` (a second `Actor` field in
    the step-2 deploy); the interim `method.params` carrier is unchanged; A7 names the test that closes it. Gate: Codex →
    NOOA → Grok seat (cursor-agent, Jordan's reassignment `evt_9677a658`) → claude-code last.

Round 6, v1.5, after the step-2 build (PR 114, builder cursor-agent on Jordan's decision `evt_9677a658`; brief
`~/.retrace/handoff-2026-09-23/brief-cursor-build-step2.md`). Class S code gate: Codex first, claude-code last; Grok's
seat skipped (capped; the builder cannot review its own PR).

14. **Codex round 1 (`4fe6f445`, high; routing `evt_95ff412d`): rejected `evt_b156f9428eba43208d0d823d6d495fe9`, four
    Medium.** F1 the MCP tool input repaired an inconsistent body instead of rejecting it; F2 lock-off inherited
    `harness-config` for a caller model; F3 the hosted MCP adapter dropped `model_source`/`model_claims` (the build brief
    had missed `apps/worker/src/mcp.ts`; scope amended, `evt_df5ca9c7`); F4 an empty legacy model became a 500. All
    applied (`d380739b`).
15. **Codex round 2 (`d380739b`, high; routing `evt_78f5be04`): rejected `evt_53a7033aa5bd4d7890d39fc29c74db2a`, two
    Medium re-raises** — F3: the adapter still spread the credential's model before the caller's source; F2 follow-up: the
    rebuilt lock-off branch dropped an explicit `none`. Stop rule met; Jordan's go `evt_9514ca0b` for a second fix round;
    both applied (`8557981e`). F1 and F4 closed.
16. **Codex round 3 (`8557981e`, medium; routing `evt_c0932287`): approved `evt_7388157112ac4057a22af1c01d916851`, no
    findings.** claude-code last seat (routing `evt_bf1d2e53`): approved `evt_9bff330286f34259b47806c57e3ce683`, one Low
    (the empty-string limit above, carried to step 3). Both coordinator's decisions from the brief (optional claim
    `source`; presence-based refinement) endorsed by Codex and recorded as built in §4.1. Gate check `evt_d9e696ca`;
    merge `84095ed` (`evt_eb99d293`); deploy `798c1b7e` (`evt_c53a506e`, verified `evt_f340c19e`).

Round 7, v1.6, after the step-3a build (PR 118, builder cursor-agent on Jordan's go `evt_570d8fb2170b4793a558a8c9630a44af`;
brief `~/.retrace/handoff-2026-09-23/brief-cursor-build-step3a.md` sha256 `0a33840b…`). Class S code gate: Codex first at
high, claude-code last; Grok's seat vacant by Jordan's decision `evt_6742fc9cc1dd401da2e65a82da6eeb3d` (the builder
cannot review its own PR; PR 114 precedent).

17. **Codex round 1 (`d02c3999`, high; routing `evt_e2df6066e8374a5b9d86981986f032d8`): rejected
    `evt_f3075806b5244ebcbaee9303b50389fb`, two Medium.** F1 an empty configured model with the actor lock off re-acquired
    `harness-config` and the refinement refused the seat's logs; F2 an empty credential pin acquired `credential-pinned`
    and `POST /events` returned 500. Both reproduced by a scratch probe; Decisions A/B, parity and the decision table
    confirmed clean across 60 trailer combinations. Root cause recorded in the gate check `evt_894536f5…`: the build
    brief's claim that the resolvers already treated `""` as absent was true for displacement and false for the
    source-fallback branches. Fix round on Jordan's go `evt_1f0440c7…` (`8cfc941`).
18. **Codex round 2 (`8cfc941`, high; routing `evt_e6aae3cd151f411a9006ae59df2c636f`, stop rule "F1 or F2 re-raised at
    Medium or higher, or two or more new findings"): rejected `evt_316307aaee59460bb9d0297ab81078ac`** — F1 closed; F2
    re-raised at Medium on the residual case (a credential pinned `{model:"", model_source:"none"}` plus a source-less
    caller model inherited `none` through the stamped actor). Stop rule met; Jordan chose one more fix round scoped to F2
    (`evt_dd91f36c8edf4796b14bd4e20fa854ff`; `fb431c3`: the no-pin branch drops the credential's model, source and claims
    together and copies the caller's fields as sent, with a signed `createHandler` regression).
19. **Codex round 3 (`fb431c3`, high; routing `evt_8b16136993bb4a79b0481d497b272424`): approved
    `evt_3e05f3a34b2542848b8389ec4e25b254`, no findings** — F2 closed (24/24 on its own probe under both signature formats);
    the dropped credential-level `model_claims` implements §4.1's no-pin rule (credentials *can* carry claims by schema,
    the admin factories never emit them). claude-code last seat (routing `evt_30ba9b85…`): approved
    `evt_b2df13ec55854a98b8809f0b842794ab`, two Lows — L1 a cosmetic indentation in `git-hook.ts:229`; L2 on the
    coordinator's own record, that its routing events were not in doctor's `method.tool: "routing"` shape. Gate check
    `evt_bfee5327…`; merge `1bbb5a7` (`evt_f5f75ea8…`). Codex's verdicts again carry no `actor.model` ("exact runtime
    model identifier not exposed"); the `codex` identity file now says what to record instead (§4.6, adopted).
    *(Superseded in round 8: Codex's next verdict carries `gpt-6-astra` / `harness-runtime`.)*

Round 8, v1.6, the step-3b pull request (PR 119, author claude-code; class (a) design gate: Codex → NOOA → Grok seat;
the author does not review).

20. **Codex round 1 (`4d19f35`, high; routing `evt_f23e627c9de44618bfc1dc0514cc3a1a`): rejected
    `evt_752b8e82101a4618955e11d4e38d5c40`, three Medium and one Low, all applied in place (unmerged draft).** F1 rule 6's
    v1 omission condition contradicted rule 4 v2 for a displayed or configured model — changed to "no usable source",
    v1 text kept. F2 rule 4's added sentence overstated the credential-pin case — the second claim exists only when the
    caller's non-empty model differs from the pin. F3 `GROK.md` claimed `display_pattern` reads the effort suffix — it is
    unbuilt (step 4) and doctor resolves aliases only; the file now says so. F4 Decision A named `raw_trailers` for the
    preserved text — it is `method.params.raw_message`. **And the finding that was not a finding:** the brief asked Codex
    whether its runtime exposes an identifier it can read. It does — the native rollout file named by `CODEX_THREAD_ID`
    carries a `turn_context` with the model and effort of the current turn — so this verdict is the first review
    verdict after that discovery to record the model from the native `turn_context` (`gpt-6-astra`, `harness-runtime`,
    effort `high`), the earlier "not exposed" statements were
    corrected by an appended event (`evt_75c70d32ffe84cd3a5d74cc3bea8e4ba`), and `AGENTS.md` records the source and
    its discovery instead of the omission rule the first draft carried.

Round 9, v1.7, the step-4 build and its two follow-ups (PR 123 builder cursor-agent on Jordan's go; class S code gate: Codex first,
claude-code last; PRs 125 and 126 author claude-code).

21. **PR 123, Codex round 1 (`ef41439`, high): rejected `evt_931793a819394ee9a6f822f392bea5ca`, three Medium.** F1 a registered
    legacy model passed the source warning; F2 the absent listing was skipped without a routing registry; F3 the routing skill's text
    rejected the new patterns. Jordan: F1–F2 in place, F3 to its own class (a) PR, and a `claude-opus-5-5` registry row
    (`evt_b145eabbf8a6462e89446fab17853476`). Round 2 (`14d4f11`, medium): approved `evt_28d7db6aea8e4003ae83306effb000c4` with two
    Lows — a test fixture that used an alias where the PR body said pattern, and a stale effort in the PR's test plan —
    both disposed of as PR-body text.
22. **PR 123, claude-code last seat (`14d4f11`): rejected `evt_bd76fc0eb25548b491c08a77dadeaafb`.** M1 human commits were listed as
    producer defects (the producers record `absent` for every trailer-less commit); M2 two new `/status` values rendered raw into the
    viewer's `innerHTML`, reachable from a crafted `?api=` link on the Worker's own origin where ledger tokens persist, no CSP
    (shown by rendering the template, not executed in a browser; never deployed); L1 events counted as commits. Fixed in `500a4e8`.
23. **PR 123, Codex rounds 3–5.** Round 3 (`500a4e8`) rejected `evt_d608b7c9a6d44a33a02247752bf68cd5`: M1 re-raised — the round-3
    brief took agent evidence from "any event" naming the commit, so an agent's read made a human commit a defect; fixed by the seal
    rule (`fe5559a`). Round 4 rejected `evt_88f05080486a4dd891f1f28df45c2369`: M3, the uncounted line asserted "human-authored, or an
    agent commit whose hook seal is missing" for what was a system bot's commit; fixed by evidence-only text (`6fff398`). Round 5
    approved `evt_b3447f5100da4009bf48f58212ce89b2`, no findings; claude-code re-check approved `evt_e5dcdcbe4bb84eb99ca2302d23e1708b`.
    PR 123 was rejected four times (Codex rounds 1, 3 and 4, and the claude-code last seat); each gate check
    traces a finding in that rejection to the coordinator's briefs.
24. **PR 125** (the landing footer entry the Pages deploy was held for, `evt_d69d3fedc2ba4d8cbb3ebbe8417152f9`): class (b), cursor-agent
    approved `evt_54b868c90a46483194b72d4d98753fcc`, no findings; merged `cf2ee7b`.
25. **PR 126** (F3): Codex round 1 rejected `evt_0c253a1d8e1f4cd7b630b73370ed65ae`, F1 Medium — the new text said the loader refuses
    unanchored patterns; it checks compilation and group count only. Text fixed (`c3b5170`); Codex approved
    `evt_04b23bba64f04de2961fbadb41291fd7`, NOOA approved `evt_82423948840e47fca39e2677a0d9aff8`, cursor-agent (Grok seat) approved
    `evt_3adc2ae9726f4f65b7a0def7b9d82974`; merged `29d4bc8`.
