# Model claims: source, omission, verification — design note v1 (agent-rules 4, v2)

**Status:** DRAFT v1, 2026-09-20, author claude-code (coordinator, `claude-fable-5-1`), on Jordan's instruction
`evt_3f1973b9b8234267aeea0d238af89483`, from his rule audit `evt_376a8fc8ba4b48c3a38624f38b4335cf` ("true
provenance means making a true claim and avoiding omission") and the coordinator's decision
`evt_e7a318017ace472ab641e6940f7d5607`. **Class (a)** under agent-rules 12: it rewrites rule 4 and the
model line of every identity file. Design gate: Codex (capped until 2026-09-21T21:05Z; a substitute is
recorded if it goes before then) → NOOA (Nemotron, pinned) → Grok; the author does not sit. Companion to
`commit-trailer-consistency.md` (a claim is classified against evidence, never trusted), `effort-model-routing.md`
§5 (`models.json`, self-reported effort) and `orchflows-integration.md` §7 (the transcript witness). **Not built.**
Corrections before merge are made in place (Jordan, `evt_9dc98206`); after merge, appended (agent-rules 10).

## 1. The problem

Rule 4 today: "`actor.model` is the exact string your harness reports for the running session … If the harness
exposes nothing, omit the field; never pin a value and never guess." Omission was chosen as the least-false
option. It is not the truest, because a blank collapses at least four different facts into one absence:

1. the harness exposes no identifier anywhere;
2. the harness shows one (a status bar, a settings label) and the seat did not count that as "reporting";
3. the harness reports one the seat has reason to distrust (Codex's runtime self-reported `gpt-5` while the
   pane ran a newer model — `AGENTS.md` lines 10–12 record this as the reason Codex omits);
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

Two live examples of fact 2 and fact 3 from this very week. Grok Build's status bar reads `Grok 4.6 (xhigh)`
and its verdicts on PR 73 and PR 90 carry no model (`evt_9bcc587e…`, `evt_08be04d4…`): a harness string
existed and was not recorded. This session's own harness hands the coordinator `claude-fable-5-1` at runtime
while its settings file names `claude-fable-5-1[1m]`, and the previous coordinator pane recorded
`claude-opus-5[1m]`: two harness sources, two spellings, and today the ledger cannot say which kind of source a
value came from.

## 2. What is true today, from the code at `0d294eb`

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
  say omit; `GROK.md` allows "the literal string in front of you" and Grok omitted anyway.

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
- **Omission becomes a fact.** An agent event with no `model` carries `model_source: "none"`. A blank with no
  source is, after adoption, a producer defect — which is what fact 4 in §1 always was.
- **A displayed string is a report.** Grok records `Grok 4.6` with `harness-display`. Cursor already does.
  Aliasing to an id stays the registry's job (`models.json`), never the seat's (rule 4 unchanged on that).

### 4.2 The Codex case, spelled out

Codex's runtime reported `gpt-5` while the pane showed `gpt-6-astra` (the defect `AGENTS.md` cites). Under this
note the event carries `model: "gpt-6-astra"`, `model_source: "harness-display"`, and
`model_claims: [{ "value": "gpt-5", "source": "harness-runtime", "note": "known defect — runtime reports the
family, not the model; AGENTS.md" }]`. Two true statements replace one blank. When the runtime is fixed, the
precedence flips back on its own and the note in `model_claims` stops appearing.

### 4.3 Git trailers

A fourth trailer, `Retrace-Model-Source: <value>`, parsed by `commit-actor.ts` beside `Retrace-Model`. When
`Retrace-Model` is absent, `Retrace-Model-Source: none` is **required** on an agent commit; a commit with neither
is classified `unresolved` by the trailer-consistency classifier exactly as a commit with no trailer is today.
`Co-Authored-By`-derived models get `model_source: "harness-config"` only when the harness wrote the line
itself (VS Code, Copilot); a hand-written co-author line is `operator-stated`.

### 4.4 Consumers

- `status`: `agent_events_by_model_source` per actor, and `agent_events_without_model` split into
  `source none` vs `no source recorded` (legacy).
- `doctor`: the existing `review model` finding reads the source: `none` → WARN as today; `self-report` only →
  WARN "model is the reviewer's own word"; `harness-display` with a registry alias → PASS. Under `--gate`, a
  review whose model source is `none` or `self-report` counts as no model, which is what R1/R3 already need.
- Landing page and README: the count of agent events without a model becomes a sentence with its cause split, not
  a footnote.

### 4.5 Verification (v2)

The credential cannot verify the model (`router.ts:370`), and the server never will. What can: the host's own
record. Orchflows' `history inspect` (pinned at `6eb8af4`, `orchflows-integration.md` §7) reads model metadata
from Claude Code's and Codex's native transcripts, children included. A local doctor advisory compares the
event's `model` with the transcript's, records `method.params.model_witness: { "source": "native-transcript",
"match": true|false, "value": "<what the transcript says>" }` on an appended, not amended, event, and never
uploads the transcript (a credential sink, `evt_c21df545`). Where no transcript exists (Grok Build, Cursor),
the claim stays a claim and the ledger says so.

### 4.6 Rule 4, proposed text (v2)

> **Report the model and how you know it.** `actor.model` is the exact string your harness reports, configures
> or displays for the running session — not shortened, not normalised, not a nicer name — and
> `actor.model_source` says which of those it was (`harness-runtime`, `harness-config`, `harness-display`,
> `operator-stated`). A harness label you can see counts as a report. A source you have documented reason to
> distrust is recorded as a second claim, never as the first. When nothing is available, `model` is absent and
> `model_source` is `none`: the unknown is recorded, never silent. The model's own statement about itself is
> never the sole source. Aliasing spellings to ids is the routing registry's job, not yours.

Identity files change with it: `AGENTS.md:10–12`, `.github/copilot-instructions.md:10`, `GROK.md` (the "no env,
no config, no API" sentence becomes "the status bar is the source: `harness-display`"), `CLAUDE.md`, and
`.cursor/rules/retrace-provenance.mdc` (already compliant; gains the source word).

## 5. What is not claimed, and the limits

- `model_source` is itself producer testimony. It makes the testimony legible; only §4.5 checks it.
- Nothing here says what model a vendor's API actually served. That is outside every harness's evidence.
- **The 416 existing blank events are not bulk-amended.** Sealed events are corrected by amendment on evidence
  (rule 10), and for most of them the evidence is gone with the pane. They are reported as legacy (no source
  recorded) and stay counted. Where evidence exists — Grok's 67 events all come from panes whose status bar
  showed `Grok 4.6`, per the harness's own display — a single appended correction event citing the display and
  the affected seq range is the honest maximum, and it is Jordan's seal (rule 14).
- Effort already follows this pattern (`not_exposed`, `unset`); this note does not touch it.

## 6. Acceptance for v1

- A1 Every agent event sealed after adoption carries either a `model` with a `model_source`, or `model_source:
  none` — status reports zero source-less agent events after the adoption seq.
- A2 Grok's next verdict carries `Grok 4.6` / `harness-display`, and doctor's `review model` check passes it
  through the registry alias.
- A3 A Codex event under the known runtime defect carries both claims as in §4.2.
- A4 An agent commit with no `Retrace-Model` and no `Retrace-Model-Source: none` is classified `unresolved`.
- A5 `status` shows the per-source split; the landing page's sentence about missing models names the causes.
- A6 No sealed event is edited; corrections are appended (rule 10).

## 7. Build order

1. This note (gate).
2. Schema: `Actor.model_source` (`schema.ts`, class S in the routing rules) → Worker deploy on Jordan's go.
   Until deployed, producers write `method.params.model_source` (round-trips today) and consumers read either.
3. Producers: MCP server (`RETRACE_ACTOR_MODEL_SOURCE`, and the caller's runtime source), git hook and
   `commit-actor.ts` (trailer), identity files, rule 4 text.
4. Consumers: status split, doctor source-aware `review model`, landing/README sentence.
5. Witness (§4.5), after the orchflows note's §9 answer or a by-hand read of `history inspect` output.

## 8. Dispositions

_Review findings and their dispositions go here, in the order received, with event ids._
