# Retrace AI — a read-only ledger digest (DRAFT v1.2)

**Status:** DRAFT v1.2, 2026-09-15, author claude-code (coordinator), on Jordan's instruction
`evt_6518ef63686942cfbd3570bdfbc0b59f` (idea: `evt_48c9bbb11210437cb965c338f04a2db6`). v1 `07ae033`; v1.1
`c04f9c0` folded Codex round 1 (review 5205506130); v1.2 folds Codex round 2 (review 5205804395, routing
`evt_7f4ac3450dc5457b98295e954ecadc6f`): the F1 residual, T10, T6/T11, F5 fallback, N1, N2 — see §13.
Class (a): governs behaviour of a new seat. Design gate: Codex first, Nemotron, Claude last
(`docs/team-roles.md`). Not built. Corrections are appended in place with a date (agent-rules 10).

## 1. Problem

The ledger is large: 4,400+ events across five seats, and every finding surface we have is a raw list
nobody reads unless it is red. `GET /projects/:p/status` reports integrity, capture and causality
aggregates; `retrace-export reconcile` prints one line per commit with eight finding kinds plus a
separate "pending edits" list; doctor prints prose READY/WARN/FAIL findings; NOOA seals an hourly
audit verdict (PASS, FAIL or INCONCLUSIVE); checkpoint PRs carry a reconcile block. The question a
project owner actually asks is *what matters today, and what proves it*. Nothing answers that.

## 2. Decision in one paragraph

Retrace AI v1 is a **read-only, fully deterministic digest with no model in it**. A **runner** (code)
reads the existing finding surfaces through their public interfaces, pins what it read, normalises every
finding into a versioned **Finding record** with typed evidence, ranks the records with a versioned
rubric, and **renders the report from templates**. Every sentence in the report is produced by code from
a Finding record. The runner seals **one terminal event per run** (digest, degraded or failed) under the
digest's own seat, citing the retained inputs and output by hash and every ledger event it names as
`used`. V1 writes nothing else and makes **zero model calls**. A model enters only in v1.1 (§10), and
then only to choose among closed, code-owned phrasings for a finding — never to write a sentence.

## 3. Why these constraints

- **The ledger is the truth; the digest is a view.** A summary that cannot be traced back would be a new
  place for a false claim to live (Jordan's standing rule, 2026-09-07).
- **A citation proves identity, not entailment, and no validator over free text can prove entailment**
  (Codex rounds 1 and 2: "f_metadata was caused by a stolen credential" cites a real id, no number, no
  severity word, and is invented). So v1 contains no free text from a model at all. "Cannot invent,
  cannot promote" is then a property of the renderer, which tests can establish (§9).
- **Detection before action.** Grok's assessment (2026-09-12): the design surface is growing faster than
  the user base. V1 detects; action is promoted one narrow step at a time (§10).
- **It serves the third bar.** "A stranger can install Retrace and keep it honest" currently requires
  reading raw reconcile output.

## 4. Inputs, pinned

The runner reads only public interfaces and retains the raw bytes of every read, hashed, in the run's
selection manifest. Nothing new is captured.

| Source | Interface | What is pinned | Finding kinds it yields |
| --- | --- | --- | --- |
| status | `GET /projects/:p/status` | response bytes + hash, `generated_at`, and the head seq/hash from a separate verified export read in the same run | aggregate counts only: **count findings** (§5), never per-event findings |
| reconcile | `retrace-export reconcile` over a verified export, Git range from the saved Git watermark | export head seq/hash, Git range (repo, from-sha, to-sha), output bytes + hash | the eight `ReconcileFindingKind` values (missing, misattributed, producer-disagreement, unreachable-seal, uncovered, loose, non-agent, orphan paths); the "pending edits" list is **not** a finding and is reported only as a count |
| doctor | packed CLI; a structured output mode is implementation work (§11) — v1 parses the labelled lines and records the parser version | output bytes + hash, dist version | WARN/FAIL findings incl. the PR 35 review-routing advisories; informational and acknowledged findings map to tier 4 |
| NOOA audit | the latest `independent-audit` event(s) in the ledger | event ids, verified head | PASS → nothing; FAIL → tier 1 (positive evidence of breakage); **INCONCLUSIVE → "source uncertain"**, shown in the header, never as a chain failure |
| checkpoints | `.retrace/checkpoints.jsonl` at a pinned Git sha + the export head | file hash, sha | checkpoint head absent from export → tier 1; age since last checkpoint → count finding |
| shadow classification | `claim_decision` on sealed commit events (PR 34, when `RETRACE_TRAILER_POLICY=shadow` is deployed and classifying) | event ids, verified head | `conflicting` → tier 2 **shadow diagnostic** citing decision, read head, policy digest and witnesses; the bullet preserves `actor` vs `would_write` and never describes a rewrite or misconduct. Not deployed or not classifying → "unavailable", never "no conflicts" |
| PR 34 pending deliveries | none public today | — | **out of scope** until a listing surface exists |

**Snapshot.** V1 uses a composite snapshot: each source is pinned separately (bytes, hash, and where
applicable head seq/hash or Git sha), and the selection manifest records all of them plus the evaluation
clock. Findings that depend on two sources record both pins. A single verified-export-derived snapshot
for all ledger-backed sources is a later build target; the composite form is what v1 can honestly claim.

**Watermarks and bounds.** The runner saves, per project, the last digest's export head seq and the Git
sha it reconciled to; the next run reconciles from those. First run: an explicit backfill window (default
7 days of Git history) stated in the manifest; the 7-day baselines in §6 are "unavailable" until the
runner has 7 days of its own saved observations. Per-source limits (rows, bytes, wall time) live in the
rules file; a source that exceeds a limit is "incomplete", and any finding that depends on it says so.

## 5. Finding record, identity, and evidence (versioned)

```
Finding {
  finding_version: "digest-finding/1",
  id: sha256(finding_version, project, repository ?? "", source_name, rule_id, canonical_subject),
      // identity EXCLUDES pins, heads, ranges and clocks: the same logical finding keeps its id
      // across runs; a finding_version bump is a deliberate migration recorded in the rules file
  source: { name, version, pin: <hash of retained bytes>, head?: {seq, hash}, git?: {repo, from, to} },
  rule_id: <adapter rule that produced it, e.g. "reconcile.misattributed">,
  project, repository?,
  subject: <typed and canonical: commit sha | event id | actor id | path | count key>,
  facts: <typed fields only>,
  evidence: [ {kind: "event", id, head:{seq,hash}} | {kind: "git", repo, sha} |
              {kind: "observation", source, pin, scope} ],
  completeness: "complete" | "incomplete" | "unavailable",
  tier: 1..4, mandatory: bool
}
```

Negative and count findings cite **observations** (the retained, hashed source output and its scope),
not ledger ids, because a missing seal has no event and an unavailable source has no id. Event references
carry the verified head they were read under; Git references carry repo and full sha. The adapter
mapping from each source's native kinds to `rule_id` and tier is a versioned table in the rules file,
including PR 35's advisories, informational/acknowledged findings, and an explicit "unknown kind → tier
4, labelled unknown" row.

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
output; the renderer checks membership and count against the selection manifest.

## 7. Rendering and the two manifests

1. The runner produces the **selection manifest**: rules digests, adapter-table version, evaluation
   clock, every source pin, and the ordered Finding list with tiers, counts and evidence. It is a pure
   function of the retained inputs, the clock and the rules (T11).
2. The **renderer** produces `report.md` from templates, one bullet per Finding: *rule label → typed
   facts → evidence references → next step from a fixed per-rule phrase table*. Untrusted fields (paths,
   actor ids, intents) are escaped and never interpolated into instructions. With no model in v1, the
   report is also a pure function of the selection manifest.
3. The **publication artifact** binds what was actually published: the selection manifest hash, the
   `report.md` hash, the retained `inputs/` hashes, and (from v1.1) the recorded model response. Replay
   of a publication takes the recorded response as an explicit input; replay of selection does not.
4. All bytes are written to the seat's immutable artifacts directory under the run id **before** any
   publication attempt (§8).

## 8. One terminal event per run, frozen before publication, and the writer

The runner is the only component that holds the seat's credential and producer key. Before the first
publication attempt it **freezes the terminal envelope**: `action: other`, `tags: ["digest"]`,
`method.tool: "retrace-ai"`, `method.params.outcome ∈ {digest, degraded, failed}`,
`idempotency_key: digest:<project>:<run id>`, artifacts: selection manifest, publication artifact and
`report.md` as `generated` with sha256, every ledger event cited in the selection manifest as `used`,
rules and adapter digests. Every retry publishes **exactly the frozen envelope**; publication-error
state is kept beside it and never rewrites the outcome (an attempted `digest` is never converted into
`failed`). A response lost after a successful seal is recovered by the idempotency key; the retained
envelope's hashes must equal the sealed event's (T7). If the ledger is unreadable at run start, the run
is `failed` with the reason; if it is unwritable at publication, the frozen envelope waits locally and is
published, unchanged, on the next run. A run never has two terminal events.

**Enforcement, stated honestly:** today no credential can restrict *what* an actor may write;
`allowed_actors` constrains who, and `POST /events` is a general append. V1 therefore relies on the
trusted writer: a small program whose only network call is that one POST with a schema-validated
envelope. In v1 there is no other process to isolate from it. **Server-enforced per-credential
action/tag restrictions are a prerequisite for v2 and a queued design item** (§11); until they exist the
seat's authority is "trusted writer + audit", not "cannot". `retrace-admin` must learn a `retrace-ai`
harness entry (§11).

## 9. Acceptance tests (the note is not built until these pass)

Contract and coverage
- **T1 no model.** V1 makes no model call: the runner has no inference client and no model credential;
  a run's report is byte-reproducible from the selection manifest alone.
- **T2 exact membership.** The rendered bullets equal the selection manifest's findings, same order,
  same count; an omitted mandatory finding, a duplicate, an extra heading, or a reordered bullet fails.
- **T3 no free text.** Every byte of `report.md` is produced by a template or a typed field; a test
  renders a manifest whose typed fields contain instruction-like text and asserts it appears escaped
  inside its field and nowhere else.
Evidence and snapshot
- **T4 typed evidence.** Every event reference carries the verified head it was read under and resolves
  there; wrong project, wrong prefix, moving head between reads → the finding is marked incomplete and
  the run degraded, never silently passed.
- **T5 negative findings cite observations.** A missing seal and an unavailable source produce findings
  whose evidence is a retained observation with hash and scope; no ledger id is required or invented.
- **T6 publication artifact binds bytes.** It lists the hashes of `inputs/*`, the selection manifest and
  `report.md`; the sealed event's `used` set equals the selection manifest's cited event ids.
Failure and publication
- **T7 one frozen terminal event.** Crash between writing files and sealing → next run publishes the
  retained envelope once, unchanged; response lost after seal → retry finds the sealed event by key and
  asserts outcome and hashes equal; ledger unreadable at start → `failed` with reason; ledger unwritable
  at publish → frozen envelope published next run. Exactly one terminal event per run id in every case.
- **T8 unavailable is loud.** Any source unavailable → a tier-1 "source unavailable" finding with the
  source and error, and every dependent finding marked incomplete; NOOA INCONCLUSIVE renders as
  uncertain, never as FAIL.
Authority
- **T9 forbidden writes through `POST /events`.** The runner's envelope validator refuses any event that
  is not the frozen terminal envelope (other actions, amendment or correction tags, arbitrary artifacts,
  other projects); these are runner-side tests and are labelled as such until server-side restriction
  exists.
Determinism and identity
- **T10 selection determinism.** Same retained inputs, clock and rules → identical selection-manifest
  bytes; the tie-breaker is the finding id.
- **T11 stable identity.** The same logical finding observed in two runs with different pins, heads and
  ranges has the same `id`; changing `finding_version` changes it, and the migration is recorded.
- **T12 incomplete history is labelled.** A watermark gap or a source over its limit → "window
  incomplete since …" in the header, never a false "no change".

## 10. What v1 does NOT do, and the promotion path

V1 does not: call any model; open PRs or issues; write correction or amendment events; change policy,
credentials, or deploys; read projects its credential does not cover; read diffs or intents into prose;
replace reconcile, doctor, or the NOOA audit; read PR 34's pending-delivery queue.

- **v1.1 — closed-selection phrasing.** A model may choose, per finding, one phrasing id from a
  code-owned table for that rule (and nothing else); code validates the id belongs to that finding's
  rule and renders it. The model is a **remote inference endpoint**; the runner's client (trusted code)
  sends only the selection manifest and receives only ids; no tool, no credential, no local model code.
  Tests: the chosen ids are validated per finding; an unknown or cross-finding id is rejected and the run
  degraded; the exact request payload and tool configuration (none) are asserted; one bounded request
  per run — the provider is selected **before** the sole request, there is no fallback attempt, and a
  failure degrades deterministically; planned and attempted model ids are both recorded.
- **v1.2 — publish** the report as a GitHub comment on the latest checkpoint PR (read-only on the ledger).
- **v1.3 — propose:** open a *draft* PR for a documented in-place correction it can prove by citation;
  builder rules apply, a reviewer is routed, the coordinator merges.
- **v2 —** anything that writes a ledger event other than its own terminal event; requires the
  server-side write restriction (§8).

Promotion evidence for each step: a window of 14 daily runs in which (a) every tier-1 and tier-2 finding
was confirmed by a human or a reviewer seat with the confirmation events cited, **and** (b) a recall
audit — a reviewer seat lists findings it expected from the same inputs and any the digest omitted
counts against it — **and** (c) source coverage was complete on every run, with failed or degraded runs
excluded from the count and listed. Quiet days are not evidence.

## 11. Implementation items this note creates (not part of v1's claims)

- `retrace-admin`: a `retrace-ai` harness entry (mint a pinned credential + producer key, principal
  Jordan, never-reissue applies).
- Doctor: a structured output mode or a stable line grammar with a version.
- A public listing for PR 34's pending deliveries (only if the digest should report them).
- Credential-store follow-up: server-enforced per-credential action/tag restrictions (prerequisite for
  v2).
- `appendEvent` idempotency returns the existing event without comparing payloads (Codex N1); the T7
  hash-equality assertion is the digest's own guard until the store compares.

## 12. Cadence, cost, priority

Daily at a fixed hour plus on demand (`retrace digest`). V1 cost is compute and D1 reads only: zero model
calls. Priority: below shadow→enforce and the boxing-rpg live window (Grok's 1 and 2) and below the
credential store (3). Build after PR 42's design lands and while the step-5 measurement window runs, so
the first digests cover a live window. Prior-art research (Jordan, Perplexity) is untrusted input and
will be folded as dated additions.

## 13. Revision history

- **v1.2 (2026-09-15)** — Codex round 2 (review 5205804395): **F1 residual** the overview could still
  invent a claim → v1 has no model at all; the model returns in v1.1 as closed per-finding phrasing
  selection only (§§2–3, §7, §10; T1, T3). **F2/T10** an empty environment is not isolation → v1 has no
  process to isolate; v1.1 defines the model as a remote endpoint with a trusted client and tests the
  payload (§8, §10). **F3/T6–T11** the publication manifest cannot also be deterministic under model
  output → selection manifest and publication artifact separated (§7; T6, T10). **F5** fallback
  contradicted "one call" → v1 zero calls; v1.1 one bounded request, provider chosen before it, no
  fallback attempt, planned and attempted ids recorded (§10). **N1** freeze the terminal envelope before
  the first publication attempt; retries publish it unchanged; publication-error state separate; T7
  asserts outcome and hash equality (§8; T7). **N2** identity excludes pins/heads/ranges; explicit
  version migration (§5; T11). Implementation item added for `appendEvent` payload comparison (§11).
- **v1.1 (2026-09-15)** — Codex round 1 (review 5205506130): F1–F6, Q1–Q4 folded; twelve tests.
- **v1 (2026-09-15)** — initial draft, `07ae033`.
