# Retrace AI — a read-only ledger digest (DRAFT v1)

**Status:** DRAFT v1, 2026-09-15, author claude-code (coordinator), on Jordan's instruction
`evt_6518ef63686942cfbd3570bdfbc0b59f` (idea: `evt_48c9bbb11210437cb965c338f04a2db6`). Class (a): governs
behaviour of a new seat. Design gate: Codex first, Nemotron, Claude last (`docs/team-roles.md`). Not built.
Corrections are appended in place with a date (agent-rules 10).

## 1. Problem

The ledger is complete and therefore dense: 4,300+ events across five seats, and every finding surface
we have is a raw list nobody reads unless it is red. `retrace_status` reports integrity, capture and
causality numbers; reconcile prints one line per commit with nine finding classes; doctor prints
READY/WARN/FAIL; NOOA seals an hourly audit verdict; checkpoint PRs carry a reconcile block. Jordan's
words: "the ledger is dense" — the question a project owner actually asks is *what matters today, and
what proves it*. Nothing answers that.

## 2. Decision in one paragraph

Retrace AI is a **read-only digest**. It reads the finding surfaces that already exist, ranks findings by
consequence with a **deterministic rubric that runs before any model is involved**, and writes a short
report in which **every sentence is generated from a finding record and carries that record's event ids
or commit shas**. The model writes prose over a fixed, machine-ranked list; it cannot add a finding,
promote one, or cite an id it was not given. The digest is sealed as an event under the digest's own
seat, citing every event it names as `used`, so a wrong digest is itself auditable. V1 never modifies
anything: no writes to the ledger other than its own digest event, no commits, no PRs, no deploys. It
may *propose* a change in prose; the proposal goes to a human or a builder seat and through the normal
gates (agent-rules 11, 12, 14).

## 3. Why these constraints

- **The ledger is the truth; the digest is a view.** A summary that cannot be traced back to sealed
  events would be a new place for a false claim to live (Jordan's standing rule, 2026-09-07). Mandatory
  citation is the whole design, not a feature of it.
- **Detection before action.** Grok's assessment (2026-09-12): the design surface is growing faster than
  the user base. A seat that acts on the ledger is a new surface with real blast radius. V1 detects;
  action is promoted one narrow step at a time, only after digests have been right for a measured period
  (§9).
- **The model must not be able to hallucinate a finding.** Ranking and selection are code; the model
  only phrases. This is stricter than "cite your sources" and cheaper to test (§8, T1–T3).
- **It serves the third bar.** "A stranger can install Retrace and keep it honest" currently requires
  reading raw reconcile output. A digest is the first thing such a stranger would use.

## 4. Inputs (all existing; nothing new is captured)

| Source | What it yields | Exists today |
| --- | --- | --- |
| `GET /status` (`retrace_status`) | integrity ok/legacy count, capture gaps (unlinked commits, events without model, instructions without follow-up, unverified links), sealed_by mix, causality coverage, actors, integration freshness | yes |
| reconcile (`retrace reconcile`, also in checkpoint PR bodies) | per-commit: missing, misattributed, producer-disagreement, unreachable-seal, uncovered, loose, non-agent, orphan paths, pending | yes |
| doctor | READY/WARN/FAIL findings, including review-routing advisories once PR 35 lands | yes |
| NOOA hourly audit | PASS/FAIL verdict event with reasons | yes |
| checkpoints (`.retrace/checkpoints.jsonl`) | latest witnessed head; gap since last checkpoint | yes |
| classification decisions (step 3, shadow) | per-commit `would_write` disposition and status (`supported` / `conflicting` / `unresolved`) once `RETRACE_TRAILER_POLICY=shadow` is deployed | from PR 34 |
| recent event tail (bounded, last N) | context for the above; never a finding source on its own | yes |

The digest reads these through the public API and the packed CLI, never through a store. It holds no
credential beyond its own seat's read token.

## 5. Ranking rubric (deterministic, runs before the model)

Findings are tiered by consequence, then ordered within a tier by recency and count. The rubric is a
data file (`digest-rules/1.json`, versioned, digest-cited like the routing rules in PR 35).

| Tier | Meaning | Finding classes (source) |
| --- | --- | --- |
| 1 — integrity | the chain or a witness disagrees | integrity not ok (status); checkpoint head not in export; producer-disagreement (reconcile); NOOA audit FAIL |
| 2 — attribution | a record says who, and evidence says otherwise | misattributed (reconcile); `conflicting` classification (shadow); doctor FAIL on identity/credential checks |
| 3 — coverage | a record is missing where one should exist | missing seal on main (reconcile); uncovered on a governing file (rule 12 class a paths); unlinked commits above the 7-day baseline; instructions without follow-up older than 24h |
| 4 — hygiene | nothing is wrong, something is stale | unreachable-seal, orphan paths, loose, pending older than the drain window, agent events without model, unverified links |

Rules: a tier-1 finding always appears; tiers 2–3 are capped at ten each with an explicit "and N more"
line that cites the count's source; tier 4 is a single summary line unless a count crossed a threshold
since the last digest. Thresholds and caps live in the rules file, not in prose. The digest states the
rubric version and the rules-file digest it used (rule 10 lineage; same pattern as PR 35 R4).

## 6. Output and sealing

- **One digest per run**: a Markdown file (`artifacts/digest-<project>-<run id>.md` under the digest
  seat's home, the NOOA audit pattern) with sections per tier, each bullet of the form
  *finding → consequence → what proves it (ids) → suggested next step (if any)*.
- **Sealed as one event**: `action: other`, `tags: ["digest"]`, `artifacts`: every cited event id and
  commit as `used`, the digest file as `generated` with its sha256, `method.params`: rubric version,
  rules digest, input snapshot (status `generated_at`, head seq/hash, reconcile window), model id verbatim
  (rule 4), token/cost if the harness reports them.
- **No other write.** The digest event is the only write the seat is allowed. Its credential's
  `allowed_actors` is exactly its own id (agent-rules 13); a project policy may further restrict it.
- **Delivery**: the file plus the event id. A GitHub issue or PR comment copy is v1.1, not v1 (§9).

## 7. Seat

Option A: a new `retrace-ai` credential and producer key, minted by `retrace-admin`, principal Jordan
(never-reissue applies). Option B: run under `nooa`, which already holds a producer key and an audit
harness. **Recommendation: A.** The audit's value is that NOOA is an *independent witness* of the chain;
a digest that ranks and phrases is a different role, and mixing the two would let a digest error look
like a witness error. Cost of A is one mint (Jordan's go, rule 14) and one systemd unit.

## 8. Acceptance tests (the note is not built until these pass)

- **T1 citation-or-drop.** Every bullet in the output maps to exactly one finding record; a bullet the
  model emits without a record id is dropped and counted in a "dropped: N" line. Test: inject a model
  reply with an invented finding → absent from output, counter = 1.
- **T2 no promotion.** The model cannot change a tier or an order. Test: model reply reorders → output
  keeps rubric order.
- **T3 ids are real.** Every cited id resolves in the ledger at the input snapshot's head; a non-resolving
  id fails the run (no digest sealed, a `digest_failed` event with the reason instead).
- **T4 fail closed on inputs.** Any input unavailable (Worker 503, reconcile error, audit missing) → the
  digest says so in tier 1 and does not silently omit the tier that depends on it.
- **T5 sealed with everything used.** The digest event's `used` set equals the set of ids cited in the
  file; the file hash matches.
- **T6 read-only.** Under a credential with `allowed_actors: [retrace-ai]` and no write scope beyond
  `POST /events`, an attempt by the digest code path to call any other mutating endpoint is a test
  failure; the seat's credential is never granted `retrace-admin`.
- **T7 incomplete history is labelled.** When the bounded event tail does not reach the last digest's
  head, the output says "window incomplete since seq N", never a false "no change" (the PR 35 F4 lesson).
- **T8 determinism.** Same inputs → same finding list and order (prose may differ; the list is compared).

## 9. What v1 does NOT do, and what promotion requires

V1 does not: open PRs or issues; write correction or amendment events; change policy, credentials, or
deploys; run on other projects than the ones its credential covers; summarize event *content* beyond
the finding record (no reading of diffs or intents into prose); replace reconcile, doctor, or the NOOA
audit (it consumes them).

Promotion path, each step its own design note: **v1.1** post the digest as a GitHub comment on the
latest checkpoint PR (still read-only on the ledger). **v1.2** open a *draft* PR for a documented
correction (a dated in-place correction to a design note it can prove wrong by citation) — builder seat
rules apply, a reviewer is routed, the coordinator merges. **v2** anything that writes a ledger event
other than its own digest. The condition for each promotion: a measured window (proposed: 14 daily
digests) in which every tier-1 and tier-2 finding was confirmed by a human or a reviewer seat, with the
confirmation events cited in the promotion note.

## 10. Cadence and cost

Daily at a fixed hour plus on demand (`retrace digest`). Inputs are bounded: status once, reconcile over
the window since the last digest, the last 500 events. Model: NIM Nemotron (as the audit) with a Haiku
fallback; both report their id verbatim. Budget: one model call per run, prompt ≤ 20k tokens; a run that
would exceed it fails closed (T4) rather than truncating findings.

## 11. Priority and sequencing

Below shadow→enforce and the boxing-rpg live window (Grok's priorities 1 and 2, which this does not
move) and below the credential store (priority 3, a known weakness). It serves the stranger-install bar
and is the surface Jordan would use daily. Build after PR 42's design lands and while the step-5
measurement window runs, so its first digests cover a live window. Prior-art research (transparency-log
monitors, citation-enforced reporting, advisor-agent governance) is being gathered separately by Jordan
via Perplexity; it is untrusted input and will be folded here as dated additions, not as claims.

## 12. Open questions for the gate

Q1. Seat A vs B (§7): does the reviewer agree the witness and digest roles must not share a key?
Q2. Should shadow classification decisions count as findings before enforce (they are `would_write`,
not written)? Proposed: yes, tier 2, labelled "shadow" in the bullet.
Q3. Is "dropped: N" (T1) enough signal, or should any drop fail the run?
Q4. Where does the daily file live long-term: the digest seat's artifacts directory (like audits), or the
repo under `docs/digests/` by PR (which would make v1.1 a PR-opener, contradicting §9)?
