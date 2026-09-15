# Retrace AI — a read-only ledger digest (document revision v1.4)

**Status:** document revision **v1.4**, 2026-09-15, author claude-code (coordinator), on Jordan's
instruction `evt_6518ef63686942cfbd3570bdfbc0b59f` (idea: `evt_48c9bbb11210437cb965c338f04a2db6`).
Revisions: v1 `07ae033`; v1.1 `c04f9c0` (Codex round 1, review 5205506130); v1.2 `e89602b` (Codex
round 2, review 5205804395); **v1.3 folds Codex round 3's nits (approval, review 5205892320,
`evt_5a3e0d08dfda47d691be3605cae850d9`) and the Nemotron pass (NOOA run
`review_pr49_v12_20260915T053722Z`, routing `evt_91e23ae85d2640d281c7e4d12b822e55`); v1.4 folds the
reassigned last review's one blocking finding (cursor-agent, GitHub review 5206011343)** — see §13.
Product stages are named **stage 1, 1.1, 1.2, 1.3, 2** (§10) to keep them apart from document
revisions. Class (a): governs behaviour of a new seat. Design gate: Codex (approved), Nemotron (done),
last review reassigned by Jordan to a non-author seat. Not built. Corrections are appended in place with
a date (agent-rules 10).

## 1. Problem

The ledger is large: 4,400+ events across five seats, and every finding surface we have is a raw list
nobody reads unless it is red. `GET /projects/:p/status` reports integrity, capture and causality
aggregates; `retrace-export reconcile` prints one line per commit with eight finding kinds plus a
separate "pending edits" list; doctor prints prose READY/WARN/FAIL findings; NOOA seals an hourly
audit verdict (PASS, FAIL or INCONCLUSIVE); checkpoint PRs carry a reconcile block. The question a
project owner actually asks is *what matters today, and what proves it*. Nothing answers that.

## 2. Decision in one paragraph

Retrace AI stage 1 is a **read-only, fully deterministic digest with no model in it**. A **runner**
(code) reads the existing finding surfaces through their public interfaces, pins what it read, normalises
every finding into a versioned **Finding record** with typed evidence, ranks the records with a versioned
rubric, and **renders the report from templates**. Every sentence in the report is produced by code from
a Finding record. The runner seals **one terminal event per run** (digest, degraded or failed) under the
digest's own seat, citing the retained inputs and output by hash and every ledger event it names as
`used`. Stage 1 writes nothing else and makes **zero model calls**. A model enters only in stage 1.1
(§10), and then only to choose among closed, code-owned phrasings for a finding — never to write a
sentence.

## 3. Why these constraints

- **The ledger is the truth; the digest is a view with interpretive scope, not authority.** It ranks and
  phrases; it never decides. Every tier-1 finding must be independently verifiable from its cited
  evidence without trusting the digest's classification (Nemotron). A summary that cannot be traced back
  would be a new place for a false claim to live (Jordan's standing rule, 2026-09-07).
- **A citation proves identity, not entailment, and no validator over free text can prove entailment**
  (Codex rounds 1–2). So stage 1 contains no free text from a model at all. "Cannot invent, cannot
  promote" is then a property of the renderer, which tests can establish (§9).
- **Detection before action.** Grok's assessment (2026-09-12): the design surface is growing faster than
  the user base. Stage 1 detects; action is promoted one narrow step at a time (§10).
- **It serves the third bar.** "A stranger can install Retrace and keep it honest" currently requires
  reading raw reconcile output.

## 4. Inputs, pinned

The runner reads only public interfaces and retains the raw bytes of every read, hashed, in the run's
selection manifest. Nothing new is captured.

| Source | Interface | What is pinned | Finding kinds it yields |
| --- | --- | --- | --- |
| status | `GET /projects/:p/status` | response bytes + hash, `generated_at`, and the export head (seq, hash) it was read under | aggregate counts only: **count findings** (§5), never per-event findings |
| reconcile | `retrace-export reconcile` over a verified export, Git range from the saved Git watermark | export head seq/hash, Git range (repo, from-sha, to-sha), output bytes + hash | the eight `ReconcileFindingKind` values (missing, misattributed, producer-disagreement, unreachable-seal, uncovered, loose, non-agent, orphan paths); the "pending edits" list is **not** a finding and is reported only as a count |
| doctor | packed CLI; a structured output mode is implementation work (§11) — stage 1 parses the labelled lines and records the parser version | output bytes + hash, dist version | WARN/FAIL findings incl. the PR 35 review-routing advisories; informational and acknowledged findings map to tier 4 |
| NOOA audit | the latest `independent-audit` event(s) in the ledger under the export head | event ids, export head | PASS → nothing; FAIL → tier 1 (positive evidence of breakage); **INCONCLUSIVE** (an event exists with that outcome) → "source uncertain", header, tier 4 age; **no audit event within the expected interval → tier 1 "source unavailable: NOOA audit"** — absence is never downgraded to uncertainty (Nemotron 8) |
| checkpoints | `.retrace/checkpoints.jsonl` at a pinned Git sha + the export head | file hash, sha | checkpoint head absent from export → tier 1; age since last checkpoint → count finding |
| shadow classification | `claim_decision` on sealed commit events (PR 34, when `RETRACE_TRAILER_POLICY=shadow` is deployed and classifying) | event ids, export head | `conflicting` → tier 2 **shadow diagnostic** citing decision, read head, policy digest and witnesses; the bullet preserves `actor` vs `would_write` and never describes a rewrite or misconduct. Not deployed or not classifying → "unavailable", never "no conflicts" |
| PR 34 pending deliveries | none public today | — | **out of scope** until a listing surface exists |

**Snapshot and consistency.** Stage 1 uses a composite snapshot: each source is pinned separately, and
every ledger-backed source records the **export head (seq, hash)** it was read under in the selection
manifest. Rule: if any two ledger-backed sources in one run report different export heads, every finding
that depends on either is marked `incomplete` and a tier-1 **"snapshot inconsistent"** finding is
emitted citing both heads (Nemotron 3; T4). A single verified-export-derived snapshot for all
ledger-backed sources is a later build target; the composite form plus this rule is what stage 1 can
honestly claim.

**Watermarks and bounds.** The runner saves, per project, the last digest's export head seq and the Git
sha it reconciled to; the next run reconciles from those. First run: an explicit backfill window (default
7 days of Git history) stated in the manifest; the 7-day baselines in §6 are "unavailable" until the
runner has 7 days of its own saved observations. Per-source limits (rows, bytes, wall time) live in the
rules file; a source that exceeds a limit is "incomplete", and any finding that depends on it says so.

## 5. Finding record, identity, and evidence (versioned)

```
Finding {
  finding_version: "digest-finding/1",
  id: sha256(finding_version, project, repository ?? "_none_", source_name, rule_id, canonical_subject),
      // identity EXCLUDES pins, heads, ranges and clocks; repository uses a sentinel, never "",
      // so findings in different repositories never collide (Nemotron 6); a finding_version bump
      // is a deliberate migration recorded in the rules file
  source: { name, version, pin: <hash of retained bytes>, head?: {seq, hash}, git?: {repo, from, to} },
  rule_id: <adapter rule that produced it, e.g. "reconcile.misattributed">,
  project, repository?,
  subject: <typed and canonical: commit sha | event id | actor id | path | count key>,
  facts: <typed fields only>,
  evidence: [ {kind: "event", id, head:{seq,hash}} | {kind: "git", repo, sha} |
              {kind: "observation", source, pin, scope} ],
  newest_evidence: <seq or Git date of the newest evidence item; the recency key in §6>,
  completeness: "complete" | "incomplete" | "unavailable",
  tier: 1..4, mandatory: bool
}
```

The digest is **stateless per run**: findings are recomputed from the current sources every time, so a
finding whose evidence no longer supports it (a corrected misattribution, a seal that landed) is simply
not selected; there is no resolution state to maintain (Nemotron 2, field rejected; the test that
presence tracks truth is accepted, T13). Negative and count findings cite **observations** (the retained,
hashed source output and its scope), not ledger ids. Event references carry the export head they were
read under; Git references carry repo and full sha. The adapter mapping from each source's native kinds
to `rule_id` and tier is a versioned table in the rules file, including PR 35's advisories and
informational/acknowledged findings. **An unrecognised kind is loud:** it produces a tier-1
"adapter unknown kind" finding citing the source, pin and raw kind string, so a new critical check can
never be filed as hygiene (Nemotron 9).

## 6. Ranking rubric (deterministic)

Tiers by consequence; within a tier by `newest_evidence` (newest first), then count, then finding id as
the stable tie-breaker. The evaluation clock (the run's fixed `now` from the manifest) is used only for
ages and thresholds, never for ordering. Rubric and adapter table live in `digest-rules/1.json`, versioned
and digest-cited by every run.

| Tier | Meaning | Rule ids (source) |
| --- | --- | --- |
| 1 — integrity | positive evidence the chain or a witness disagrees, or a source that would prove it is unavailable or inconsistent | status integrity not ok; checkpoint head absent from export; reconcile producer-disagreement; NOOA FAIL; source unavailable (incl. absent NOOA audit); snapshot inconsistent; adapter unknown kind |
| 2 — attribution | a record says who and evidence says otherwise | reconcile misattributed; shadow `conflicting` (labelled shadow); doctor FAIL on identity/credential checks |
| 3 — coverage | a record is missing where one should exist | reconcile missing on main; uncovered on a governing path (rule 12 class a paths); unlinked-commit count above baseline; instructions without follow-up older than 24h |
| 4 — hygiene | nothing wrong, something stale | unreachable-seal, orphan paths, loose, non-agent, agent events without model, unverified links, NOOA INCONCLUSIVE age |

**Tier 1 and tier 2 are never truncated**: every selected finding renders (Nemotron Q2 — attribution
findings are positive evidence of a false record and must not be pushed into a tail). Tier 3 is capped
at ten with an "and N more" line rendered from the count; tier 4 is a summary line unless a count crossed
a rules-file threshold since the last digest. The renderer checks membership and count against the
selection manifest.

## 7. Rendering, the two manifests, and the order of operations

1. The runner produces the **selection manifest**: run id (§8), rules digests, adapter-table version,
   evaluation clock, every source pin and export head, and the ordered Finding list with tiers, counts
   and evidence. It is a pure function of the retained inputs, the clock and the rules (T10).
2. The **renderer** produces `report.md` from templates, one bullet per Finding: *rule label → typed
   facts → evidence references → next step from a fixed per-rule phrase table*. Untrusted fields (paths,
   actor ids, intents) are escaped and never interpolated into instructions. With no model in stage 1, the
   report is also a pure function of the selection manifest.
3. The runner writes `inputs/*`, the selection manifest and `report.md` to the seat's immutable
   artifacts directory under the run id.
4. It then computes the **publication artifact** from the written files: their hashes and (from stage
   1.1) the recorded model response.
5. It then **freezes the terminal envelope** (§8), which includes the publication artifact's hash.
6. Only then does it publish (Nemotron 11: the order is explicit so the envelope can never be frozen
   before the publication artifact exists).

## 8. One terminal event per run, frozen before publication, and the writer

**Run id:** a UUIDv7 generated at run start and persisted in the selection manifest; the idempotency key
is `digest:<project>:<run id>`; two concurrent runs for one project therefore never share a key
(Nemotron 7; T7).

The runner is the only component that holds the seat's credential and producer key. Before the first
publication attempt it **freezes the terminal envelope**: `action: other`, `tags: ["digest"]`,
`method.tool: "retrace-ai"`, `method.params.outcome ∈ {digest, degraded, failed}`, the idempotency key,
artifacts: selection manifest, publication artifact and `report.md` as `generated` with sha256, every
ledger event cited in the selection manifest as `used`, rules and adapter digests. Every retry publishes
**exactly the frozen envelope**; publication-error state is kept beside it and never rewrites the outcome
(an attempted `digest` is never converted into `failed`). A response lost after a successful seal is
recovered by the idempotency key. After any successful publication the runner **re-reads the sealed
event by id and asserts full payload equality** with the frozen envelope, not only hashes (Nemotron 12;
T7): a runtime guard, because the store's idempotency path returns the existing event without comparing
payloads (§11). If the ledger is unreadable at run start, the run is `failed` with the reason; if it is
unwritable at publication, the frozen envelope waits locally and is published, unchanged, on the next run.
A run never has two terminal events.

**Enforcement, stated honestly:** today no credential can restrict *what* an actor may write;
`allowed_actors` constrains who, and `POST /events` is a general append. Stage 1 therefore relies on the
trusted writer: a small program whose only network call is that one POST with a schema-validated
envelope. **Threat model, stated:** the seat's credential is a write-capable credential until server-side
restrictions exist; whoever holds it can append arbitrary events. Stage 1 detects rather than prevents:
after publication the runner lists every event by the seat's actor within the run window (from the run's
start export head to the head observed after publication) and asserts exactly one, its own. **This run's
outcome is never changed by that audit** — the envelope is frozen and sealed by then (T7). Any other
event by the seat is recorded in the run's local audit record and becomes a mandatory tier-1 "seat wrote
outside its envelope" finding in the **next** run, citing both events (Nemotron 1; last review 5206011343;
T9b). The hourly NOOA audit is asked to add the
same check (§11). **Server-enforced per-credential action/tag restrictions are a prerequisite for stage
2 and a queued design item** (§11); until they exist the seat's authority is "trusted writer + audit",
not "cannot". `retrace-admin` must learn a `retrace-ai` harness entry (§11).

## 9. Acceptance tests (the note is not built until these pass)

Contract and coverage
- **T1 no model.** Stage 1 makes no model call: the runner has no inference client and no model
  credential; a run's report is byte-reproducible from the selection manifest alone.
- **T2 exact membership.** The rendered bullets equal the selection manifest's findings, same order,
  same count; an omitted mandatory finding, a duplicate, an extra heading, or a reordered bullet fails;
  tier-1 and tier-2 findings are never truncated.
- **T3 no free text.** Every byte of `report.md` is produced by a template or a typed field; a test
  renders a manifest whose typed fields contain instruction-like text and asserts it appears escaped
  inside its field and nowhere else.
Evidence and snapshot
- **T4 typed evidence and consistent heads.** Every event reference carries the export head it was read
  under and resolves there; wrong project, wrong prefix, or two ledger-backed sources under different
  heads → dependent findings marked incomplete, a tier-1 "snapshot inconsistent" finding, and the run
  degraded, never silently passed.
- **T5 negative findings cite observations.** A missing seal and an unavailable source produce findings
  whose evidence is a retained observation with hash and scope; no ledger id is required or invented.
- **T6 publication artifact binds bytes.** It lists the hashes of `inputs/*`, the selection manifest and
  `report.md`; the sealed event's `used` set equals the selection manifest's cited event ids.
Failure and publication
- **T7 one frozen terminal event.** Crash between writing files and sealing → next run publishes the
  retained envelope once, unchanged; response lost after seal → retry finds the sealed event by key and
  asserts full payload equality; two concurrent runs → two run ids, two keys; ledger unreadable at start
  → `failed` with reason; ledger unwritable at publish → frozen envelope published next run. Exactly one
  terminal event per run id in every case.
- **T8 unavailable is loud.** Any source unavailable → a tier-1 "source unavailable" finding with the
  source and error, and every dependent finding marked incomplete; NOOA INCONCLUSIVE renders as
  uncertain; an absent NOOA audit renders as unavailable, tier 1.
Authority
- **T9 seat authority.** (a) The runner's envelope validator refuses any event that is not the frozen
  terminal envelope (other actions, amendment or correction tags, arbitrary artifacts, other projects) —
  a runner-side test, labelled as such until server-side restriction exists. (b) After publication the
  runner lists the seat's events in the run window and asserts exactly one; an injected extra event by
  the same credential leaves this run's sealed outcome untouched and produces a mandatory tier-1 finding
  in the next run citing both events; the local audit record survives a crash between the two runs.
Determinism, identity and truth-tracking
- **T10 selection determinism.** Same retained inputs, clock and rules → identical selection-manifest
  bytes; the tie-breaker is the finding id.
- **T11 stable identity.** The same logical finding observed in two runs with different pins, heads and
  ranges has the same `id`; the same subject in two repositories has two ids; changing `finding_version`
  changes it, and the migration is recorded.
- **T12 incomplete history is labelled.** A watermark gap or a source over its limit → "window
  incomplete since …" in the header, never a false "no change".
- **T13 presence tracks truth.** Inject a misattribution, run, assert selected; apply the correcting
  event, run again, assert not selected (Nemotron 2).
- **T14 adapter contract.** A fixed set of raw source outputs with known kinds, fed through the adapter
  and rubric, yields the exact expected `rule_id` and tier for each; an unknown kind yields the tier-1
  "adapter unknown kind" finding; the adapter-table digest is part of the fixture (Nemotron 4, 9).

## 10. What stage 1 does NOT do, and the promotion path

Stage 1 does not: call any model; open PRs or issues; write correction or amendment events; change
policy, credentials, or deploys; read projects its credential does not cover; read diffs or intents into
prose; replace reconcile, doctor, or the NOOA audit; read PR 34's pending-delivery queue.

- **Stage 1.1 — closed-selection phrasing.** A model may choose, per finding, one phrasing id from a
  code-owned table for that rule (and nothing else); code validates the id belongs to that finding's
  rule and renders it. The model is a **remote inference endpoint**; the runner's client (trusted code)
  sends only the selection manifest and receives only ids; no tool, no credential, no local model code.
  **The endpoint identity is pinned** in the rules file (URL plus certificate fingerprint or key hash),
  cited by the selection manifest; the runner refuses any endpoint that does not match, and the actual
  endpoint used is recorded in the publication artifact (Nemotron 5). One bounded request per run — the
  provider is selected **before** the sole request, there is no fallback attempt, and a failure degrades
  deterministically; planned and attempted model ids are both recorded. Tests: chosen ids validated per
  finding; unknown or cross-finding id rejected and the run degraded; exact request payload and tool
  configuration (none) asserted; endpoint mismatch refused.
- **Stage 1.2 — publish** the report as a GitHub comment on the latest checkpoint PR (read-only on the
  ledger).
- **Stage 1.3 — propose:** open a *draft* PR for a documented in-place correction it can prove by
  citation; builder rules apply, a reviewer is routed, the coordinator merges.
- **Stage 2 —** anything that writes a ledger event other than its own terminal event; requires the
  server-side write restriction (§8).

Promotion evidence for each step: a window of 14 daily runs in which (a) every tier-1 and tier-2 finding
was confirmed by a human or a reviewer seat with the confirmation events cited, **and** (b) a recall
audit — a reviewer seat, given the run's retained `inputs/*` bytes and selection manifest (the same
inputs, by hash; no re-read of live sources is needed), lists the findings it expected and any the digest
omitted counts against it (Nemotron 10: replay is from retained bytes, not a new at-head reader),
**and** (c) source coverage was complete on every run. **Failed or degraded runs count against
readiness**, not outside it: a digest that cannot observe the system is not ready (Nemotron Q4). Quiet
days are not evidence.

## 11. Implementation items this note creates (not part of stage 1's claims)

- `retrace-admin`: a `retrace-ai` harness entry (mint a pinned credential + producer key, principal
  Jordan, never-reissue applies).
- Doctor: a structured output mode or a stable line grammar with a version.
- A public listing for PR 34's pending deliveries (only if the digest should report them).
- Credential-store follow-up: server-enforced per-credential action/tag restrictions (prerequisite for
  stage 2).
- `appendEvent` idempotency returns the existing event without comparing payloads (Codex N1); the T7
  re-read assertion is the digest's runtime guard until the store compares.
- NOOA hourly audit: add the "one event per digest run by the retrace-ai seat" check (§8).

## 12. Cadence, cost, priority

Daily at a fixed hour plus on demand (`retrace digest`). Stage 1 cost is compute and D1 reads only: zero
model calls. Priority: below shadow→enforce and the boxing-rpg live window (Grok's 1 and 2) and below the
credential store (3). Build after PR 42's design lands and while the step-5 measurement window runs, so
the first digests cover a live window. Prior-art research (Jordan, Perplexity) is untrusted input and
will be folded as dated additions.

## 13. Revision history (document revisions)

- **v1.4 (2026-09-15)** — reassigned last review (cursor-agent, GPT-5.6 Sol, GitHub review 5206011343):
  the post-publication seat audit could not make an already-sealed `digest` outcome `failed` without
  breaking T7's frozen envelope. Resolved by the reviewer's second option: the audit stays after
  publication, never changes this run's outcome, and an extra seat event becomes a mandatory tier-1
  finding in the next run, citing both events (§8, T9b). Everything else in that review passed.
- **v1.3 (2026-09-15)** — Codex round 3 nits: T11→T10 reference in §7; "document revision" vs "product
  stage" labelling throughout. Nemotron pass (NOOA, Nemotron Ultra): **1** trusted-writer threat model
  stated and a post-publication seat audit added (§8, T9b) — accepted; **2** resolution state — field
  rejected (stateless per run), presence-tracks-truth test accepted (§5, T13); **3** cross-source head
  drift → per-source export head recorded, inconsistency is a tier-1 finding (§4, T4) — accepted; **4**
  adapter/rubric contract test (T14) — accepted; **5** stage-1.1 endpoint identity pinned and recorded
  (§10) — accepted; **6** repository sentinel in the id (§5, T11) — accepted; **7** UUIDv7 run id and
  concurrency test (§8, T7) — accepted; **8** absent NOOA audit is unavailable (tier 1), INCONCLUSIVE is
  uncertainty (§4, T8) — accepted; **9** unknown adapter kinds are tier-1 loud (§5, §6, T14) — accepted;
  **10** recall audit replays from retained bytes; a new at-head reader command rejected (§10); **11**
  explicit order of operations (§7) — accepted; **12** post-publication payload re-read (§8, T7) —
  accepted, store fix stays a follow-up (§11). Nemotron Q1 (verifiability of tier-1 without trusting the
  digest) — accepted (§3); Q2 (never truncate tier 2) — accepted (§6, T2); Q3 — same as 3; Q4 (failed and
  degraded runs count against readiness) — accepted (§10). Recency key defined as `newest_evidence`,
  not the clock (§5, §6).
- **v1.2 (2026-09-15)** — Codex round 2: no model in stage 1; two manifests; frozen envelope; identity
  tuple; no fallback attempt; T1–T12.
- **v1.1 (2026-09-15)** — Codex round 1: F1–F6, Q1–Q4 folded.
- **v1 (2026-09-15)** — initial draft, `07ae033`.
