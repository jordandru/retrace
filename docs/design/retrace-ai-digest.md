# Retrace AI — a read-only ledger digest (DRAFT v1.1)

**Status:** DRAFT v1.1, 2026-09-15, author claude-code (coordinator), on Jordan's instruction
`evt_6518ef63686942cfbd3570bdfbc0b59f` (idea: `evt_48c9bbb11210437cb965c338f04a2db6`). v1 `07ae033`; v1.1
folds the first Codex design review (gpt-6-astra, high, GitHub review 5205506130, routing
`evt_8b0500d93d1c48a3825d5e4c79c5b586`): F1–F6 and Q1–Q4, see §13. Class (a): governs behaviour of a
new seat. Design gate: Codex first, Nemotron, Claude last (`docs/team-roles.md`). Not built. Corrections
are appended in place with a date (agent-rules 10).

## 1. Problem

The ledger is large: 4,300+ events across five seats, and every finding surface we have is a raw list
nobody reads unless it is red. `GET /projects/:p/status` reports integrity, capture and causality
aggregates; `retrace-export reconcile` prints one line per commit with eight finding kinds plus a
separate "pending edits" list; doctor prints prose READY/WARN/FAIL findings; NOOA seals an hourly
audit verdict (PASS, FAIL or INCONCLUSIVE); checkpoint PRs carry a reconcile block. The question a
project owner actually asks is *what matters today, and what proves it*. Nothing answers that.

## 2. Decision in one paragraph

Retrace AI is a **read-only digest**. A deterministic **runner** (code, no model) reads the existing
finding surfaces through their public interfaces, pins what it read, normalises every finding into a
versioned **Finding record** with typed evidence, ranks the records with a versioned rubric, and
**renders the report from templates**. Every factual sentence in the report is produced by code from a
Finding record; the model never writes a factual sentence. The model's only role in v1 is an optional,
clearly labelled *overview* paragraph that a validator checks against the manifest before it is
included, and that is dropped, not edited, on any violation. The runner seals **one terminal event per
run** (digest, degraded or failed) under the digest's own seat, citing the retained input manifest and
output bytes by hash and every ledger event it names as `used`. V1 writes nothing else and the model
holds no credential and no tool.

## 3. Why these constraints

- **The ledger is the truth; the digest is a view.** A summary that cannot be traced back would be a new
  place for a false claim to live (Jordan's standing rule, 2026-09-07).
- **A citation proves identity, not entailment** (Codex F1). A sentence can carry a real event id and
  still say something the event does not support. So the factual path has no model in it: templates
  render facts from typed fields, and "cannot invent, cannot promote" becomes a property of code that
  tests can establish, not a property of a prompt.
- **Detection before action.** Grok's assessment (2026-09-12): the design surface is growing faster than
  the user base. V1 detects; action is promoted one narrow step at a time (§10).
- **It serves the third bar.** "A stranger can install Retrace and keep it honest" currently requires
  reading raw reconcile output.

## 4. Inputs, pinned

The runner reads only public interfaces and retains the raw bytes of every read, hashed, in the run's
input manifest. Nothing new is captured.

| Source | Interface | What is pinned | Finding kinds it yields |
| --- | --- | --- | --- |
| status | `GET /projects/:p/status` | response bytes + hash, `generated_at`, and the head seq/hash from a separate verified export read in the same run | aggregate counts only: these become **count findings** (§5), never per-event findings |
| reconcile | `retrace-export reconcile` over a verified export, Git range from the saved Git watermark | export head seq/hash, Git range (repo, from-sha, to-sha), reconcile output bytes + hash | the eight `ReconcileFindingKind` values (missing, misattributed, producer-disagreement, unreachable-seal, uncovered, loose, non-agent, orphan paths); the "pending edits" list is **not** a finding (Codex F4) and is reported only as a count |
| doctor | packed CLI, structured output (a structured adapter is implementation work — v1 parses the labelled lines and records the parser version) | output bytes + hash, dist version | WARN/FAIL findings incl. the PR 35 review-routing advisories; informational and acknowledged findings map to tier 4 |
| NOOA audit | the latest `independent-audit` event(s) in the ledger | event ids, verified head | PASS → nothing; FAIL → tier 1 (positive evidence of breakage); **INCONCLUSIVE → "source uncertain"**, shown in the header, never as a chain failure (Codex F4) |
| checkpoints | `.retrace/checkpoints.jsonl` at a pinned Git sha + the export head | file hash, sha | checkpoint head not present in export → tier 1; age since last checkpoint → count finding |
| shadow classification | `claim_decision` on sealed commit events (PR 34, when `RETRACE_TRAILER_POLICY=shadow` is deployed) | event ids, verified head | `conflicting` → tier 2 **shadow diagnostic** citing decision, read head, policy digest and witnesses; the bullet preserves `actor` vs `would_write` and never describes a rewrite or misconduct (Codex Q2). Not deployed → "unavailable", never "no conflicts" |
| PR 34 pending deliveries | none public today | — | **out of scope** until a listing surface exists (Codex F4); the note does not pretend to read it |

**Snapshot.** V1 uses a composite snapshot: each source is pinned separately (bytes, hash, and where
applicable head seq/hash or Git sha), and the manifest records all of them plus the evaluation clock.
Findings that depend on two sources record both pins. A single verified-export-derived snapshot for all
ledger-backed sources is the v1.1 build target; the composite form is what v1 can honestly claim.

**Watermarks and bounds** (Codex F6). The runner saves, per project, the last digest's export head seq
and the Git sha it reconciled to; the next run reconciles from those. First run: an explicit backfill
window (default 7 days of Git history) stated in the manifest; the 7-day baselines in §5 are
"unavailable" until the runner has 7 days of its own saved observations. Per-source limits (rows,
bytes, wall time) are in the rules file; a source that exceeds a limit is "incomplete", and any
finding that depends on it says so. Model output is bounded too (§7).

## 5. Finding record and evidence (versioned)

```
Finding {
  finding_version: "digest-finding/1",
  id: <stable across runs: sha256(source, rule_id, subject)>,
  source: { name, version, pin: <hash of retained bytes>, head?: {seq, hash}, git?: {repo, from, to} },
  rule_id: <adapter rule that produced it, e.g. "reconcile.misattributed">,
  project, repository?,
  subject: <typed: commit sha | event id | actor id | path | count>,
  facts: <typed fields only; no free text from the model>,
  evidence: [ {kind: "event", id, head:{seq,hash}} | {kind: "git", repo, sha} |
              {kind: "observation", source, pin, scope} ],
  completeness: "complete" | "incomplete" | "unavailable",
  tier: 1..4, mandatory: bool
}
```

Negative and count findings cite **observations** (the retained, hashed source output and its scope),
not ledger ids, because a missing seal has no event and an unavailable source has no id (Codex F3).
Event references carry the verified head they were read under; Git references carry repo and full sha.
The adapter mapping from each source's native kinds to `rule_id` and tier is a versioned table in the
rules file, including PR 35's advisories, informational/acknowledged findings, and an explicit
"unknown kind → tier 4, labelled unknown" row.

## 6. Ranking rubric (deterministic)

Tiers by consequence; within a tier by recency, then count, then finding id as the stable tie-breaker.
The evaluation clock is the run's fixed `now` from the manifest. Rubric and adapter table live in
`digest-rules/1.json`, versioned and digest-cited by every run.

| Tier | Meaning | Rule ids (source) |
| --- | --- | --- |
| 1 — integrity | positive evidence the chain or a witness disagrees, or a source that would prove it is unavailable | status integrity not ok; checkpoint head absent from export; reconcile producer-disagreement; NOOA FAIL; source unavailable (labelled as such) |
| 2 — attribution | a record says who and evidence says otherwise | reconcile misattributed; shadow `conflicting` (labelled shadow); doctor FAIL on identity/credential checks |
| 3 — coverage | a record is missing where one should exist | reconcile missing on main; uncovered on a governing path (rule 12 class a paths); unlinked-commit count above baseline; instructions without follow-up older than 24h |
| 4 — hygiene | nothing wrong, something stale | unreachable-seal, orphan paths, loose, non-agent, agent events without model, unverified links, NOOA INCONCLUSIVE age, unknown kinds |

Tier-1 findings are mandatory and always rendered. Tiers 2–3 are capped at ten each with an "and N
more" line rendered from the count. Tier 4 is a summary line unless a count crossed a rules-file
threshold since the last digest. Every mandatory finding selected by the rubric must appear in the
output; the renderer checks membership and count against the manifest (Codex F1, coverage).

## 7. Rendering, the model's role, and the output contract

1. The runner selects the **manifest**: the ordered Finding list, counts, tiers, evidence.
2. The **renderer** produces the report body from templates, one bullet per Finding:
   *rule label → typed facts → evidence references → next step from a fixed per-rule phrase table*.
   Untrusted fields (paths, actor ids, intents) are escaped and never interpolated into instructions.
3. The **model**, if enabled, receives only the manifest (ids, tiers, counts, rule labels) and returns an
   overview of at most three sentences. The **validator** accepts it only if every id it mentions is in
   the manifest, every number equals a manifest count, and it contains no tier or severity word not in
   the manifest; any violation drops the overview and marks the run `degraded: overview_rejected`. The
   overview is labelled "model overview (validated against manifest)". The model has no tools and no
   credential; one call, prompt ≤ 8k tokens, output ≤ 400 tokens; an overflow or a rejected output is a
   degraded run with a templated report, never a failed run (Codex Q3, F5).
4. The output is bytes: `report.md`, `manifest.json`, `inputs/` (retained source bytes), all hashed, written
   to the seat's immutable artifacts directory under the run id **before** publication (Codex Q4).

## 8. One terminal event per run, and the writer

The runner is the only component that holds the seat's credential and producer key. It sends exactly one
terminal event per run: `action: other`, `tags: ["digest"]`, `method.tool: "retrace-ai"`,
`method.params.outcome ∈ {digest, degraded, failed}`, `idempotency_key: digest:<project>:<run id>`,
artifacts: `manifest.json` and `report.md` as `generated` with sha256, every ledger event cited in the
manifest as `used`, the rules file and adapter table digests, model id verbatim (rule 4) when a model
ran. Publication is retried on the same idempotency key; a response lost after sealing is recovered by
the dedup on the next attempt. If the ledger is unavailable, the run writes a local `failed` record and
publishes it on the next run; a run never has two terminal events (Codex F5).

**Enforcement, stated honestly** (Codex F2): today no credential can restrict *what* an actor may
write; `allowed_actors` constrains who, and `POST /events` is a general append. V1 therefore relies on
the trusted writer: a small program whose only network call is that one POST with a schema-validated
envelope, whose credential the model process cannot reach. **Server-enforced action/tag restrictions
per credential are a prerequisite for v2 and a queued design item** (credential-store follow-up), and
until they exist the digest seat's authority is "trusted writer + audit", not "cannot".
`retrace-admin` must learn a `retrace-ai` harness entry; that is implementation work (Codex F2), listed
in §11.

## 9. Acceptance tests (the note is not built until these pass)

Contract and coverage
- **T1 templated facts.** No factual sentence comes from the model: with the model disabled the report is
  byte-identical except for the absent overview block.
- **T2 exact membership.** The rendered bullets equal the manifest's selected findings, same order, same
  count; an omitted mandatory finding, a duplicate, an extra heading, or a reordered bullet fails.
- **T3 overview validator.** Inputs: valid id with wrong claim; another finding's id; fabricated
  consequence; shadow finding worded as actual; a number not in the manifest; a severity word not in
  the manifest; injected instruction text in a path field → overview dropped, run marked degraded,
  report unchanged.
Evidence and snapshot
- **T4 typed evidence.** Every event reference carries the verified head it was read under and resolves
  there; wrong project, wrong prefix, moving head between reads → the finding is marked incomplete and
  the run degraded, never silently passed.
- **T5 negative findings cite observations.** A missing seal and an unavailable source produce findings
  whose evidence is a retained observation with hash and scope; no ledger id is required or invented.
- **T6 manifest binds bytes.** `manifest.json` lists the hashes of `inputs/*` and `report.md`; the sealed
  event's `used` set equals the manifest's cited event ids; a reader can recompute selection and counts
  from the retained inputs alone (Codex F3, T5).
Failure and publication
- **T7 one terminal event.** Crash between writing files and sealing → next run publishes the retained
  record once; response lost after seal → retry dedups on the idempotency key; ledger read fails →
  `failed` with reason; ledger write fails → local record, published next run. In every case exactly one
  terminal event exists per run id.
- **T8 unavailable is loud.** Any source unavailable → a tier-1 "source unavailable" finding with the
  source and error, and every dependent finding marked incomplete; NOOA INCONCLUSIVE renders as
  uncertain, never as FAIL.
Authority
- **T9 forbidden writes through `POST /events`.** With the seat's credential, the runner's envelope
  validator refuses any event that is not the terminal envelope (other actions, amendment or correction
  tags, arbitrary artifacts, other projects); these are runner-side tests and are labelled as such until
  server-side restriction exists.
- **T10 no model authority.** The model process has no environment variable, file, or socket that
  reaches the credential or the network; tested by running it in an isolated process with an empty
  environment.
Determinism
- **T11 same inputs, same manifest.** Fixed clock, retained inputs → identical manifest bytes; the
  tie-breaker is the finding id.
- **T12 incomplete history is labelled.** A watermark gap or a source over its limit → "window
  incomplete since …" in the header, never a false "no change" (the PR 35 F4 lesson).

## 10. What v1 does NOT do, and what promotion requires

V1 does not: open PRs or issues; write correction or amendment events; change policy, credentials, or
deploys; read projects its credential does not cover; render free-text prose from the model into the
factual body; read diffs or intents into prose; replace reconcile, doctor, or the NOOA audit; read PR 34's
pending-delivery queue (no public surface).

Promotion path, each step its own design note: **v1.1** post the report as a GitHub comment on the
latest checkpoint PR. **v1.2** open a *draft* PR for a documented in-place correction it can prove by
citation; builder rules apply, a reviewer is routed, the coordinator merges. **v2** anything that writes a
ledger event other than its own terminal event; requires the server-side write restriction (§8).

Promotion evidence (Codex F6): a window of 14 daily runs in which (a) every tier-1 and tier-2 finding was
confirmed by a human or a reviewer seat with the confirmation events cited, **and** (b) a recall audit —
a reviewer seat lists findings it expected from the same inputs and any the digest omitted counts
against it — **and** (c) source coverage was complete on every run, with failed or degraded runs
excluded from the count and listed. Quiet days are not evidence.

## 11. Implementation items this note creates (not part of v1's claims)

- `retrace-admin`: a `retrace-ai` harness entry (mint a pinned credential + producer key, principal
  Jordan, never-reissue applies).
- Doctor: a structured output mode or a stable line grammar with a version, so the adapter is not
  parsing prose.
- A public listing for PR 34's pending deliveries (only if the digest should report them).
- Credential-store follow-up: server-enforced per-credential action/tag restrictions (prerequisite for
  v2).

## 12. Cadence, cost, priority

Daily at a fixed hour plus on demand (`retrace digest`). One model call per run, bounded as in §7;
NIM Nemotron with a Haiku fallback, each reporting its id verbatim; a fallback is recorded in the
manifest as a second model id, still one call per run. Priority: below shadow→enforce and the boxing-rpg
live window (Grok's 1 and 2) and below the credential store (3). Build after PR 42's design lands and
while the step-5 measurement window runs, so the first digests cover a live window. Prior-art research
(Jordan, Perplexity) is untrusted input and will be folded as dated additions.

## 13. Revision history

- **v1.1 (2026-09-15)** — Codex review 5205506130: **F1** citation ≠ entailment → factual path fully
  templated, model reduced to a validated overview, membership/coverage test (§§2, 7, T1–T3). **F2** no
  credential restricts *what* is written → trusted-writer component stated as the v1 mechanism, server-side
  restriction named as a v2 prerequisite and queued, retrace-admin harness entry listed (§8, §11, T9–T10).
  **F3** inputs are not snapshot-bound records → versioned Finding record with typed evidence, observation
  evidence for negative/count findings, composite pinned snapshot, manifest binds bytes (§§4–5, T4–T6).
  **F4** taxonomy → reconcile's eight kinds vs its "pending edits" list, PR 34 queue out of scope, NOOA
  INCONCLUSIVE preserved, adapter table versioned (§4, §6, T8). **F5** one-write contract → single terminal
  envelope {digest, degraded, failed}, idempotency key, retain-before-publish, retry semantics (§8, T7).
  **F6** bounds and promotion → watermarks, first-run backfill, per-source limits, fixed clock and
  tie-breaker, recall audit in promotion evidence (§4, §10, T11–T12). **Q1** seat A with the restricted
  writer; **Q2** shadow findings as tier-2 diagnostics with explicit shadow wording; **Q3** invalid model
  output → degraded templated report, never a dropped mandatory finding; **Q4** immutable artifacts outside
  the repository. Nits: "the ledger is large"; exact interface names.
- **v1 (2026-09-15)** — initial draft, `07ae033`.
