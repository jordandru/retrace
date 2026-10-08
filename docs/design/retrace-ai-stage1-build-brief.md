# Retrace AI stage 1 — build brief (github-copilot)

**Status:** DRAFT v1, round 4 (2026-09-23), author claude-code (coordinator), on Jordan's instruction
`evt_42add0579bc94fb6a99c8714e3ae0099`. The revision history at the end lists the changes in each later
round and the rejection each answers. Builder: **github-copilot**
(`docs/team-roles.md`). Spec: `docs/design/retrace-ai-digest.md` (document revision v1.4, 2026-09-15 —
reviewed, approved, unbuilt). Class (a) under agent-rules 12: this brief governs how a seat does bounded
work, so it takes the design gate. **Not started**, and not startable yet — see §7.

*Correction 2026-10-05 (agent-rules 10): this status line is stale. The brief merged as PR #78, merge
`54c5e1e`, 2026-09-23; it is no longer a round-4 draft. The spec is unchanged: v1.4. See "Correction
2026-10-05" at the end; the text above is left as written.*

## 0. Read this first

This brief routes three items to the Copilot builder seat. Two are buildable (§2, §3); the third is
explicitly deferred to a question-and-answer, no code (§4).

It also draws a boundary (§1) around a proposal that must not be built. That section is not throat
clearing: on 2026-09-18 the boundary was stated to Microsoft Copilot Desktop in a prompt that named every
forbidden element, and Desktop returned the forbidden proposal near-verbatim (recorded in Jordan's instruction
`evt_42add0579bc94fb6a99c8714e3ae0099`). The boundary is restated
here because the record shows it does not survive one hop.

## 1. The boundary: why CPIL is not being built

On 2026-09-17 Microsoft Copilot proposed a "Copilot Provenance Intelligence Layer" (CPIL): LLM semantic
lineage with a 0–10 risk score, an LLM anomaly detector, an LLM **tamper reasoner**, and LLM-authored
provenance narratives, under `retrace/cpil/`.

**It is refused on design, not on taste.** `retrace-ai-digest.md` §2–§3 settled this question through
Codex rounds 1–3, a Nemotron pass, and a reassigned last review. The governing finding, from Codex
rounds 1–2: *a citation proves identity, not entailment, and no validator over free text can prove
entailment.* A model-authored risk score bound to a real commit sha is a claim ahead of evidence
(agent-rules 0) carrying the ledger's authority. Stage 1 therefore makes **zero model calls** and contains
**no free text from a model** (T1, T3).

Tamper is the worst available target for a model. Chain verification answers it with certainty today; a
probabilistic layer above that can only subtract. A false negative says a real tamper is fine. A false
positive accuses a named person or agent, with evidence attached.

CPIL also assumed a repository that does not exist. Verified 2026-09-18 at `0d294eb`:

| CPIL assumed | Verified |
| --- | --- |
| provenance graphs, SBOM fragments, execution traces | no `sbom` and no `ProvenanceGraph` anywhere in the tree; Retrace is a hash-chained append-only **event** ledger with Ed25519 producer signatures, a Cloudflare Worker and D1 |
| code under `retrace/cpil/` | npm workspaces: `packages/core` (`@retrace-dev/core`), `packages/mcp-server` (**`@retrace-dev/cli`** — there is no `packages/cli`), `apps/worker` (`@retrace/worker`). `retrace/cpil/` would nest the repo inside itself |
| Jest | `node --test` over compiled `dist/*.test.js`; no Jest is to be added |
| per-file license headers | no source file carries one; Apache-2.0 sits at the repo root |
| `retrace cpil scan \| audit \| narrate` | no command of that shape exists |

None of the above is to be reintroduced. If a deliverable below appears to need one, that is a signal to
ask in the pull request, not to build.

## 2. Deliverable 1 — the stage-1 digest runner

Build what `docs/design/retrace-ai-digest.md` v1.4 specifies. **The note is the contract**; where this
brief and the note disagree, the note wins. The anchors that must be honoured exactly:

- **§4** inputs, pinned, with a per-source export head and the snapshot-inconsistency rule.
  *Correction, 2026-10-05 (digest v1.5; cross-check finding L2-5, at `6190d5f`):* the status response
  carries no export head (packages/core/src/status.ts:40-85). Digest §4 now pins status by bracketing
  the status read between two unsigned `GET /projects/:p/head` reads. A mismatch is retried up to a
  limit set in `digest-rules/1.json`, then falls back to the snapshot-inconsistency outcome. T4 gains a
  negative case on an injected store (cross-check finding L4-F8), and T4 is added to the list of tests
  below that need a negative case that actually trips. The list itself is left as written.
  *Added 2026-10-05 (design-gate gap, binding condition; the text above stays):* "Digest §4 now pins
  status" means digest v1.5 §4. This correction binds only once digest v1.5 merges. Until then v1.4 §4
  stays the builder's contract, and T4's new negative case is notice, not contract.
- **§5** the Finding record, its `id` derivation (identity excludes pins, heads, ranges and clocks), and
  the loud unknown-adapter-kind rule.
- **§6** the deterministic ranking rubric. Tiers 1 and 2 are **never** truncated.
- **§7** the two manifests and the six-step order of operations.
- **§8** one terminal event per run, frozen **before** publication, plus the trusted-writer threat model
  stated honestly rather than papered over.
  - **Correction (2026-10-05; source: cross-check finding L3-3, verified at `6190d5f`):** v1.4's
    post-publication re-read asks for "full payload equality" with the frozen envelope. Built literally, it
    fails on every successful run, because the Worker strips and stamps `sealed_by`,
    `producer_sig_verdict`, `relayed_by` and other reserved params (`packages/core/src/router.ts:834-844`,
    `:869-870`, `:917-927`). Build the comparison as digest v1.5 §8 defines it: sign under
    `retrace-producer-sig/2` (passed explicitly; `signProducer` defaults to /1,
    `packages/core/src/producer-sig.ts:377`), compare `producerSignedPayload`
    (`producer-sig.ts:128`), and require an equal `producer_sig` and a `verified` verdict, with the frozen
    envelope carrying its own `timestamp`. T7's negative cases are listed in digest v1.5 T7. Until v1.5
    merges, this is an open question for the pull request, not a semantic to invent.
- **§9** acceptance tests **T1–T14**. The note is not built until these pass.
- *Correction 2026-10-05 (agent-rules 10), source: retrace-ai cross-check finding L3-2, at `6190d5f`;
  the lines above stay.* For the seat audit only (§8 and T9b), the contract is digest document revision
  **v1.5**: its dated L3-2 corrections to §8 and T9 (b). They supersede v1.4 on this point, so the
  "note wins" rule above points at v1.5 here. This line takes effect only once digest v1.5 is merged. On
  every other point the binding stays v1.4. In short: the audit counts any event in the run window whose
  actor id is `retrace-ai`, or whose `method.params.sealed_by` matches the runner's own sealed event, or
  whose `relayed_by` is `retrace-ai`. A v1.4 actor-only audit does not meet the contract. T9b's negative
  case for a human-actor `instructed` event sealed by the seat's credential must trip. See also §5.6.
- *Correction 2026-10-05 (agent-rules 10), source: v1.5 design-gate gap "`sealed_by` key in the terminal
  mismatch case"; the line above stays.* "Matches the runner's own sealed event" is replaced by: matches
  the configured `pinned:<credential name>`, a required runner configuration field (digest v1.5 §8). In
  the T7 mismatch case the re-read event's `sealed_by` is evidence, never a key. The credential name is
  Jordan's mint decision; fixtures use a placeholder. Binds only once digest v1.5 merges.
  *Added 2026-10-05 (design-gate gap, spec pointer settled; the lines above stay):* "On every other point
  the binding stays v1.4" holds only until digest v1.5 merges. From that merge the whole spec is digest
  v1.5 ("Correction 2026-10-05" item 2, option (c)).
- **§10** what stage 1 does not do.

Ship the tests under `node --test`. A test that cannot fail is not a test: **T2, T3, T7, T9b, T10, T13
and T14 each need a negative case that actually trips**. Where the note names a fixture — the adapter
contract table in T14 — build the fixture.

*Correction 2026-10-05 (agent-rules 10; source: crosscheck 2026-10-05, findings L3-9, L3-4, L4-F9; base
`6190d5f`).* T7's negative case had no expected outcome, and T9b had no truncation case. Digest v1.5 §8
and §9 (draft) give both. **This correction changes rules**: it adds a mandatory T9b negative case and
new runner behaviour (no republish, a local `terminal mismatch` record, a non-zero exit). Under
agent-rules 12 it is therefore class (a) and takes the design gate; it is not a class (b) correction.
**It binds only once digest v1.5 merges.** Until then the spec pins in the status line and §2 name v1.4,
the note wins, and the text below is notice, not contract:
- **T7:** when the post-publication re-read returns a foreign event (another actor's) or a different one
  (the seat's, not equal to the frozen envelope over the field set item L3-3 fixes, which cannot include
  the annotations the Worker stamps on every seal), the outcome is not rewritten, nothing is republished,
  `terminal mismatch` is recorded locally, the runner exits non-zero, and the next run renders a tier-1
  "terminal event mismatch" finding. The store dedupes on (project, key) alone
  (`packages/core/src/store.ts:1054-1059`). Add a positive control where only stamped annotations differ.
- **T9b:** a second negative case, for truncation. `GET /projects/:p/events` returns the newest `limit`
  matches with no lower seq bound (`packages/core/src/router.ts:1020-1039`, `store.ts:25-50`). The audit
  walks `next_before_seq` to the start head, or filters a `fresh=1` export (never the cache) whose last
  event is at or above the post-publication head, and records its coverage; an audit that cannot show
  coverage yields a tier-1 "seat audit incomplete" finding, never a pass. The seat selector is the three
  keys of the L3-2 correction above (actor id, `sealed_by`, `relayed_by`), so the walk pages without an
  `actor_id` filter. An earlier run's retained envelope published in the window counts as expected.

Open questions are expected. Raise them in the pull request body; do not resolve them by inventing a
semantic.

## 3. Deliverable 2 — `retrace doctor` structured output

`retrace-ai-digest.md` §11 creates this item. Today the digest would have to parse doctor's prose with a
recorded parser version, which §4 already flags as a fragility.

Verified state, `packages/mcp-server/src/doctor.ts` at `0d294eb`:

- line 14 already exports `type Finding = { level: "pass" | "warn" | "fail"; label: string; detail: string }`.
- line 794 flattens each finding to `` `${f.level.toUpperCase()}  ${f.label} — ${f.detail}` ``.
- line 796 prints `READY | NOT READY — N passed, N warnings, N failures`.
- line 113 parses `--json`, but only `retrace status` honours it (line 697). **`retrace doctor --json`
  currently does nothing.**

Re-verified 2026-09-23 at `1636bac`, current main when round 2 was written: the same four facts hold, now
at line 14 (`Finding`), line 849 (the flattened line), line 851 (the `READY` / `NOT READY` summary) and
line 168 (`--json` is parsed; only `retrace status` uses it, line 752). What changed in between is PR 92
(`1fca5dc`, `32993c6`; merge `30fc384`; issue #84): doctor now **probes each hook's target**. A
`post-commit` or `post-merge` PASS names the probed command and what answered
(`<path> → <command> (retrace-git <version>)`, or `older retrace-git, no --probe`). An installed hook
whose target cannot run is a **FAIL** for both hooks: the target exited non-zero, did not finish within
the probe budget (`RETRACE_DOCTOR_PROBE_TIMEOUT_MS`), or the hook carries the mark but no `commit --hook`
line. **The compatibility baseline is current `main` at the head the builder starts from, not
`0d294eb`.** The builder re-verifies these lines there and names that head in the pull request.

*Correction 2026-10-05 (agent-rules 10): these anchors have drifted again. They were re-measured at `6190d5f`,
and three finding labels were added after `1636bac`. See "Correction 2026-10-05" items 3–4 at the end.*

Two defects to fix:

1. **`label` is a free-form display string doing double duty as identity.** Any consumer keying on it
   breaks the moment the prose is reworded.
2. **The line grammar is not parseable in general** — `detail` can itself contain the `" — "` separator.

Constraints on the fix:

- The existing human output is the default and **its bytes do not change**. The push gate depends on this
  command (`.github/workflows/retrace-gate.yml` runs `doctor --gate`).
- The exit-code contract is unchanged: 1 on any failure, 0 otherwise.
- The schema carries an explicit **version**, so a consumer can refuse a version it does not understand
  rather than mis-parse it.
- Stable keys come from an explicit list in the versioned schema and are **never** derived from the label or
  detail text, so rewording a message keeps its key.
- Tests: every finding a run can emit carries a stable key; the human output is byte-identical to the
  baseline; a version bump is visible to a consumer. Fixtures cover the hook branches PR 92 added — target
  probed OK, target exited non-zero, probe timed out, no `commit --hook` line — for both hooks, with probe
  behaviour and exit results unchanged.

Propose the schema in the pull request body before assuming it. Do not silently redefine what
`pass`/`warn`/`fail` mean.

## 4. Deliverable 3 — deferred, no code

Jordan's instruction `evt_42add0579bc94fb6a99c8714e3ae0099` includes, as a deferred item, the stage-1.1
pinned-endpoint client with **GitHub Models** as the vendor. It would give
Retrace a third independent inference vendor alongside Anthropic and NVIDIA, which is a cross-vendor
independence claim we can presently only half make (`team-roles` rule 3). It is gated behind deliverable 1
landing. **Write no code for it.**

Answer two questions as prose, from what is actually known:

1. Can a GitHub Models endpoint be pinned by certificate fingerprint or public key hash, such that a
   client refuses any endpoint that does not match — and does that pin survive normal certificate
   rotation? §10 requires the pin be recorded in the run's publication artifact.
2. Can a request be made with **no tool configuration at all**, and is the served model id returned in the
   response, so the planned and actually-served model ids can both be recorded?

"I do not know" is an acceptable answer and a better one than a guess, because a wrong answer here would
be designed against.

*Correction 2026-10-06 (agent-rules 10; source: GitHub's documentation, docs.github.com/en/github-models, read
2026-10-05: "As of July 30, 2026, GitHub Models has been fully retired"; re-checked by claude-code). The text
above stays as written.* GitHub Models was retired on 2026-07-30, before this brief's round 4 (2026-09-23).
The vendor this section names no longer exists, so its two questions are moot as written. The deferred item
stands: stage 1.1 still needs a pinned endpoint, and its vendor is open (digest v1.5 §10).

## 5. Binding constraints

1. **No claims ahead of evidence** (agent-rules 0).
2. **Stage 1 makes zero model calls and emits no model-authored text.** T1 and T3. Not negotiable.
3. **Every change to main arrives by pull request** (agent-rules 12). Own worktree, one pull request per
   deliverable, commit only your own paths. The builder does not merge and does not review its own work
   (`team-roles` rule 1); the coordinator classifies and routes (rule 11).
4. **Attribution is per seat, not per sub-task.** However the work is decomposed internally, every commit
   carries `Retrace-Actor: github-copilot`, `Retrace-Model: <the exact model id the runtime reports>`,
   `Retrace-Caused-By: <instruction event id>` — except that when the runtime exposes no model identifier,
   the `Retrace-Model` trailer and `actor.model` are omitted, never guessed (agent-rules 4 and 6).
   `Co-Authored-By: Copilot` alone is not provenance
   (`.github/copilot-instructions.md`). Anonymous sub-agent commits under one seat are an attribution
   failure, and in this repository that is the failure we exist to catch.
5. **Name every file changed** on the log for that change (agent-rules 3), and log before committing, in
   sequence.
6. **Credentials** (agent-rules 13): the seat's token reaches its configured process through the
   environment and is never echoed; the seat's producer signing key stays file-backed
   (`RETRACE_PRODUCER_KEY_FILE`, mode 0600). Any step in which a secret value is in play — minting,
   rotating or provisioning a credential — is Jordan's, in the terminal flow of agent-ops 16; the builder
   does none of it. Test presence with `${VAR:+SET}`, never `${VAR:-default}` — agent transcripts are a
   credential sink. On HTTP 402 `quota_exceeded`, stop, and never borrow another seat's token
   (agent-rules 13).
   *Correction 2026-10-05 (agent-rules 10), source: retrace-ai cross-check finding L3-2, at `6190d5f`.*
   A pinned credential with `on_behalf_of` can seal `instructed` events as the human
   (`packages/core/src/router.ts:347-364`). `retrace-admin` sets `on_behalf_of` on every pinned agent
   credential it mints (`packages/mcp-server/src/admin.ts:156`, `:293`). Jordan decided on
   2026-10-06 that the retrace-ai credential carries none (`evt_40d1e828ec654a2f96bd945453d86136`; digest v1.5
   §11). The builder does not mint. The audit consequence and the T9b case are in the §2 correction; both
   still hold, because they catch a credential minted the default way by mistake.

## 6. Review routing

Class **(a)**. This brief and deliverable 1 both govern behaviour, so each goes to all three other Core
Four seats — **Codex → NOOA → Grok**, Claude last — per `team-roles` rule 2, with Claude recused as
reviewer on this brief (author). **Deliverable 2 is not routed by file type.** It changes `retrace doctor`,
the executable provenance gate (`.github/workflows/retrace-gate.yml` runs `doctor --gate`), and it changes
the `Finding` contract and adds an output path. That makes it a security/build control, class (a) under
agent-rules 12, which assigns the gate by consequence and applies the higher gate when the class is
uncertain. Under agent-rules 12 the coordinator classifies each deliverable's pull request by consequence
before review; the routing registry's surface class for `doctor.ts` (C) sets review effort only, not the
rule-12 class. The routing event records the class and the head sha (agent-rules 11 and 12), and a push
after classification re-opens the gate against the new head (agent-rules 12). NOOA must be pinned to
**nemotron-3-ultra**, the model `team-roles` names for its reviews (rule 3 keeps Nemotron primary in that
seat); the review harness's own default is `claude-sonnet-5` (`review_agent.py` line 30,
`os.getenv("NOOA_MODEL", "claude-sonnet-5")`, read on the auditor host on 2026-09-23).

## 7. Priority, and what blocks the start

`retrace-ai-digest.md` §12 places this **below** shadow→enforce, the boxing-rpg live window, and the
credential store (Grok's 1, 2 and 3), and says to build after PR 42's design lands and while the step-5
measurement window runs, so the first digests cover a live window. Nothing here changes that order.

The work therefore starts on two conditions, both Jordan's to release (`team-roles` rule 4): this brief
merges, and the §12 predecessors clear. Deliverable 2 is small, self-contained and unblocks the digest's
doctor adapter, so it is the sensible first move inside the window — **not** a reason to start early.

*Correction 2026-10-05 (agent-rules 10): this section's start conditions can be read as internally
inconsistent (see Q1), and what "PR 42's design lands" requires is ambiguous (see Q2). Both are Jordan's to
settle. They are recorded as open questions in "Correction 2026-10-05" item 5 at the end. Until Jordan
rules, nothing here is released.*

## 8. The channel finding (recorded, not incidental)

The `github-copilot` seat is Copilot CLI and VS Code Chat on the one pinned credential, driven by
`.github/copilot-instructions.md` in this repository. That seat works: the export tail (PR 12), the
object-store doctor (PR 14, 17), the stranger fixes (PR 20, 22), release prep (PR 25), and the stranger
test that found the broken install command.

**Microsoft Copilot Desktop is not that seat.** It has no repository access, no pinned credential, no
model self-report and no ability to honour the pull-request gate, and on 2026-09-18
(`evt_42add0579bc94fb6a99c8714e3ae0099`) it reproduced the CPIL
proposal against a prompt that forbade each of its elements individually, opening with "assume ... SBOMs
... exist" after being handed evidence that they do not. The prompt carried a trip-wire — *if the design
note was not attached, say so and stop* — and Desktop neither said so nor stopped, proceeding to instruct
that code be committed. Output from that surface carries no actor id and no trailers; it cannot be sealed
as seat work and must not be treated as it. Briefs go to the seat, in the repository, where the note is
readable from the tree.

---

## Revision history

- **2026-09-18, v1** (head `42cde95`): author claude-code on `claude-opus-5[1m]`.
- **2026-09-23, round 2**: author claude-code on `claude-opus-5-5[1m]`, answering Codex's rejection
  `evt_c264b94754be4c908e34081909e9be90` (routing `evt_4e715c7ae4b243dba9ef4f27debc7520`).
  - M1, §6: deliverable 2 changes the executable gate and takes class (a), classified by consequence at its
    head.
  - L1, §3: current main is the compatibility baseline, re-verified at `1636bac`, and PR 92's hook
    branches join the fixture requirement.
  - L2, §5.4: the omit-when-unavailable model exception is restated.
  - L3, §5.6: the credential wording is scoped to tokens, the file-backed signing key and agent-ops 16 are
    named, and the 402 rule is cited where current main keeps it (agent-rules 13).

  Fixed in place because this brief is an unmerged draft (Jordan's ruling, 2026-09-16,
  `evt_9dc982064d3c432bbd85ff9a64f049da`).
- **2026-09-23, round 3**: author claude-code on `claude-opus-5-5[1m]`, answering NOOA's rejection
  `evt_9393972f5a64481fb49253ae452f304d` (routing `evt_ad8a983b1eca41418e3c67c891144a2c`).
  - Adopted: F3, §3 stable keys now a testable constraint; F4, §4 sources the deferred GitHub Models item to
    Jordan's instruction; F9, §0 and §8 cite that instruction for the Copilot Desktop account.
  - Not adopted: F1, the digest note was printed in full in NOOA's review packet, and its anchors were measured
    at `1636bac` by the Grok-seat review `evt_6415461667a140fb8ac75d6af9f83699`; F2, packet scope, and §3
    already requires re-verification at the head the builder starts from.
- **2026-09-23, round 4**: author claude-code on `claude-opus-5-5[1m]`, answering NOOA's rejection
  `evt_e3309ccd5dc841dfaff4ecbbe384c61a` (routing `evt_5edbcd605e95476bb7cb9cfe2a61c40b`).
  - Medium, status line: it still said round 2 after round 3; it now gives the current round and points to
    this history instead of naming a single rejection.
  - Low, §6: the NOOA pin now cites its sources, `team-roles` for the review model and `review_agent.py`
    line 30 on the auditor host, read 2026-09-23, for the harness's default.
  - Low, §6: the classification, routing-record and re-open sentences cite agent-rules 11 and 12, which
    they restate.

*Corrections to this brief are appended in place with a date (agent-rules 10).*

- **2026-10-05, correction (finding L3-5, Opus-pane cross-check at `6190d5f`).** §2 tells the builder
  not to resolve open questions "by inventing a semantic". Digest v1.4 §8 asks for artifacts "as
  `generated` with sha256" and "rules and adapter digests", and gives `action: other` no `action_detail`.
  `ArtifactRef` has no hash field (`packages/core/src/schema.ts:146-155`). As written, the builder would
  have had to invent the field, the artifact file names and the detail value. Digest v1.5 §8 proposes
  them: artifacts `selection-manifest.json`, `report.md` and `publication.json`, with ids
  `digest:<project>:<run id>/<file name>`; their sha256 values in `method.params.artifact_sha256`; the
  rules digests in `method.params.rules_sha256`, keyed by rules file path; the adapter-table version in
  `method.params.adapter_table_version`; `action_detail` always `"digest"`, refused otherwise by T9a; T6
  extended to check each hash against the retained file. The spec named in this brief's header stays
  digest v1.4 until v1.5 passes the design gate (class (a)) and merges. Once it has, build against
  v1.5 §8 and §9. Until then these points are open and must not be built by invention. No schema change
  is in scope for stage 1. It changes what the builder builds, so it is class (a) under agent-rules 12
  and takes the design gate with digest v1.5.

- **Correction, 2026-10-05** (cross-check of HEAD `6190d5f`, finding L3-7; agent-rules 10). **Class (a)
  under agent-rules 12** (`docs/agent-rules.md:105-110`): it changes what the builder must build, so it
  takes the design gate and is not routed as a (b) correction. §2 and §5.4: the digest's terminal event
  had no `caused_by` field through v1.4 (`retrace-ai-digest.md` v1.4 §8, lines 156-159 at `6190d5f`), and neither the digest
  nor this brief named the root instruction of a scheduled or on-demand run (digest v1.4 §12, line 281 at `6190d5f`).
  §5.4's `Retrace-Caused-By` governs the builder's commits, not the runner's sealed digest events. Digest
  v1.5 §8 adds the field, a `timestamp` equal to the run's evaluation clock, the root check (run at the
  start of digest §7 step 1, before the selection manifest and `report.md`, per the v1.5 §7 correction),
  and the root choice, decided by Jordan on 2026-10-06 (`evt_40d1e828ec654a2f96bd945453d86136`): a standing
  instruction per covered project, cited by every run (option A1); digest v1.5 §9 adds the T7 root-check sub-case. For
  this item only, digest v1.5 §7's correction, v1.5 §8 and the T7 sub-case supersede the v1.4 pin in the status line and §2; the rest of the contract
  stays v1.4 unless another dated correction says otherwise. The T7 root-check sub-case is among the
  negative cases §2 requires to trip. The builder implements the field, the check and the sub-case for
  the decided option (A1), refuses a `--caused-by` argument, and does not pick which event is a project's
  standing instruction; that stays Jordan's. The text
  above is left as written.

- **2026-10-05, correction (source: crosscheck finding L4-F7, read at `6190d5f`).** The pinned status
  source cannot compute digest §6's tier-3 rule "instructions without follow-up older than 24h". Status
  exposes only an all-time count with no ages (packages/core/src/status.ts:61-62, :163). Proposed digest
  v1.5 re-sources the rule to a full-project verified export. The runner reads it itself, by the path
  reconcile uses against a remote store (packages/mcp-server/src/reconcile.ts:4, :110-113). It pins the
  bundle, the chain-verified tail and the live head the events reach (verified-events.ts:142-182,
  :200-212), and takes the age at the run's evaluation clock (digest v1.5 §4, §6). This is a second read,
  not reconcile's own. On a ledger taking writes the two reads usually land on different heads. Under the
  digest's chain-prefix rule (v1.5 §4, revised 2026-10-06; this sentence updated in fix round 1, 2026-10-08)
  that is consistent when both heads lie on the run's reference chain; only a head off that chain raises
  the tier-1 "snapshot inconsistent" finding and a degraded run (digest §4). T14's fixture gains four
  follow-up rows. One, the status-count row, is another T14 negative case that must trip, under the
  existing §2 requirement (this brief, §2). v1.5 is proposed, not approved. Until v1.5 passes the design
  gate and merges (agent-rules 12), v1.4 stays the builder's contract. If this correction and v1.5 land
  in one pull request, they take the gate together. Once v1.5 merges, read v1.5 wherever this brief
  points the builder at v1.4 §4, §6 or T14.

- **Correction, 2026-10-05 (Omarchy cross-check, findings L2-3 and L2-4; read at `6190d5f`).** Class (a): it
  adds requirements to deliverable 2, so it changes a rule and is not a class (b) correction (agent-rules 12).
  It lands in one pull request with digest v1.5 and takes the design gate with it. Facts: §3 re-verified doctor
  at `1636bac`. Since then doctor has gained three finding labels: `export-cache` (`ce04f90`;
  `packages/mcp-server/src/doctor.ts:907`), `model claim absent` (`ef41439`, `14d4f11`; doctor.ts:488, :496,
  :523) and `owner-login` (`50340a8`; doctor.ts:236, :243, :254, :1015, :1028). None appears in doctor.ts at
  `1636bac`. `pin/session` (:301) and `owner-login` change level with `--gate`. Doctor levels remain
  `pass`/`warn`/`fail` (doctor.ts:13); there is no informational or acknowledged level. Requirements, binding
  only once that pull request merges: deliverable 2's key list includes the three labels; `owner-login` gets one
  stable key per case (policy load error, digest mismatch, incomplete history, shared-login seals); the test
  fixtures cover both `--gate` modes; deliverable 2 adds no level. When that pull request merges, digest v1.5's
  §6 doctor rule governs how deliverable 1 tiers doctor findings; on this point only, §2's "the note wins"
  reads v1.5. Whether the whole spec moves to v1.5 is open ("Correction 2026-10-05" item 2 below). Until then
  the spec stays v1.4.
  *Added 2026-10-05 (design-gate gap, spec pointer settled; the text above stays):* the open point above is
  settled by "Correction 2026-10-05" item 2: option (c). From the merge of the joint pull request the whole
  spec is digest v1.5.
  *Added 2026-10-05 (design-gate gap, untiered doctor labels):* digest v1.5 §6 now has a doctor label table:
  all 37 labels doctor.ts emits at `6190d5f`, each with a tier per level, and the rule that produced it.
  The three labels above are three of its rows. Deliverable 2's key list covers all 37 (§3 already requires
  a key for every finding). The builder invents no tier. T14 rows (l)-(n) cover it; row (n) is another
  negative case that must trip (§2). Same class and gate as this correction.

- **Correction, 2026-10-05** (source: the 2026-10-05 crosscheck, findings L2-6 and L2-7, at `6190d5f`;
  drafted for the coordinator on a non-seat machine by `claude-opus-5-5`). For the reconcile and
  shadow-classification adapters, §2's §4 anchor reads digest v1.5, not v1.4: the reconcile kind-name table
  and the two blocks after it. The reconcile adapter reads `--json` (`retrace-reconcile/1`), keys on the
  code names in `packages/core/src/reconcile.ts:33`, and never parses the text summary line.
  `restricted_hook_stamps` (`5a86d1a`) is counted and yields no finding. The shadow adapter keys on
  `method.params.claim_decision` alone, so an owner-login `conflicting`
  (`packages/core/src/owner-login-record.ts:9`) is never a shadow diagnostic. Whether owner-login decisions
  become a source is open: see digest v1.5, "OPEN QUESTION FOR JORDAN: owner-login decisions as a digest
  source". T14's fixture covers the three cases. This correction adds builder requirements, so it is not a
  12(b) correction that changes no rule. It is class (a) under agent-rules 12 and takes the design gate
  together with digest v1.5.
  *Added 2026-10-05 (design-gate gap, reconcile acknowledged/amended/`info`):* digest v1.5 §4 now has a
  third block after the kind-name table, "Acknowledged, amended and `info`", between the
  `restricted_hook_stamps` block and the second-`conflicting` block. "The two blocks after it" above reads
  "the three blocks after it". The reconcile adapter reads `commits[].findings` and applies that block's
  ordered rule: a malformed shape is tier-1 "adapter unknown kind"; `amended`
  (`packages/core/src/reconcile.ts:47`) yields no finding and is counted; `acknowledged` (:48) yields a
  tier-4 `reconcile.acknowledged` finding; any other finding takes its kind's tier, and `level` (:34) is
  not part of the lookup. T13 and T14 rows (e)-(h) cover it. Row (h) is another negative case that must
  trip (§2). Same class and gate as the paragraph above.
  *Added 2026-10-05 (design-gate gap, untiered reconcile cases):* the kind-name table no longer carries
  v1.4's untiered cases. Reconcile runs from the saved watermark to main's head, so every
  `missing_commit` is tier 3. `uncovered` is tier 3 when its `file` matches `reconcile.governing_paths`,
  a new required field of `digest-rules/1.json` whose stage-1 value digest v1.5 §4 gives, and tier 4
  otherwise. The builder invents no tier and no path list. T14 rows (i)-(k) cover it; row (k) is another
  negative case that must trip (§2). Same class and gate as the paragraph above.

## Correction 2026-10-05 (agent-rules 10)

Measured at HEAD `6190d5f`. Source: the 2026-10-05 Retrace AI cross-check, findings F, L2-2, L2-3, L4-F5
and gaps A, B, D and E. Drafted off-seat on the Omarchy PC, which is not a Retrace seat, so it is not
sealed. The pull request that carries this correction supplies the author of record and `Retrace-Caused-By`.
The text above stays as written. This block changes no rule. It updates facts and records questions.
*Added 2026-10-05 (critic pass; the sentence above stays):* item 2's dated addition re-points the spec to
digest v1.5 on merge. That changes what this brief governs, so this block is class (a) and takes the design
gate with digest v1.5 in the same pull request. "Changes no rule" holds for items 1 and 3-6 only.
*Added 2026-10-06 (claude-code, coordinator; the text above stays):* the author of record is claude-code, on
Jordan's instructions `evt_52f6dae68acc4f66ab39fab04f00ee4f` and `evt_40d1e828ec654a2f96bd945453d86136`. Every
fact in this block was re-checked at `27f4264`. Items 7 and 8 are new.

1. **Status line (:3).** "DRAFT v1, round 4 (2026-09-23)" is stale. The brief merged as PR #78, merge
   `54c5e1e`, on 2026-09-23. Its text has not changed since (`git log 54c5e1e..6190d5f` on this file is empty).
   "Not started" still holds. No local ref carries deliverable-1 or deliverable-2 work. A `git log --all`
   search for retrace-ai, `doctor --json` and digest runner finds only `42cde95`, this brief's routing commit.
   "Not startable yet" stands until Jordan releases the start (item 5).
2. **Spec.** The spec is still digest document revision v1.4 (`06034b7`, PR #49), as the status line and §2
   say. A v1.5 draft of the digest exists. It has not merged and has not been reviewed. This correction does
   not re-point the spec. Re-pointing it would change what this class-(a) brief governs, so it needs its own
   reviewed change under the design gate (agent-rules 12). **OPEN QUESTION (Jordan or the coordinator):** once
   v1.5 merges, (a) this brief keeps v1.4 as its spec; (b) a class-(a) revision of this brief re-points it to
   v1.5; (c) v1.5 states its own effect on this brief and passes the design gate on that basis.
   *Added 2026-10-05 (design-gate gap, undecided spec pointer; the text above stays):* this is not a
   Jordan-reserved item, so it is decided here: option (c). Digest v1.5 lands in one pull request with this
   brief's 2026-10-05 corrections, and they take the design gate together (agent-rules 12). v1.5's status
   line states that effect. Each correction binds its own point when that pull request merges. This holds
   for every 2026-10-05 correction, including those that state no binding condition of their own (L3-7,
   L2-6/L2-7). From that merge the spec is digest v1.5, and the joint pull request is the reviewed change
   that re-points it. No separate class-(a) revision of this brief follows. Until that merge, v1.4 stays the
   spec, as the status line and §2 say. Open question 19 in the side file is settled by this addition.
3. **§3 doctor anchors, re-measured at `6190d5f`** (`packages/mcp-server/src/doctor.ts`). The facts hold in
   substance. Every line number except `Finding` has moved:
   - `Finding` is still at :14, and `Level` at :13 is still `"pass" | "warn" | "fail"`.
   - `--json` is parsed at :169, not :168. Only `retrace status` honours it, at :950, not :752.
     **`retrace doctor --json` still does nothing.**
   - The flattened finding line is at :1058, not :849.
   - The `READY` / `NOT READY` summary is at :1060, not :851.

   Seven commits touched doctor.ts after `54c5e1e`: `ef41439`, `14d4f11`, `500a4e8`, `fe5559a`, `6fff398`,
   `50340a8` and `ce04f90`. The re-verification rule in §3 still binds: the baseline is main at the builder's
   start head, not `6190d5f`.
4. **New doctor labels.** Three finding labels absent at `1636bac` are emitted at `6190d5f`:
   - `export-cache` (`ce04f90`; :907);
   - `model claim absent` (`ef41439`, `14d4f11`; :488, :496, :523);
   - `owner-login` (`50340a8`; :236, :243, :254, :1015, :1028).

   §3's constraint already requires a stable key for every finding a run can emit, so deliverable 2 must
   give each of these an explicit key. A schema built from the `1636bac` snapshot would miss them. The
   digest's doctor adapter would then report them as tier-1 unknown kinds (digest §5).
5. **§7: OPEN QUESTIONS FOR JORDAN.** No answer is chosen here.
   - **Q1. What does "the §12 predecessors clear" mean for shadow→enforce?** §7 makes the predecessors a
     start condition. It also repeats digest §12's "build ... while the step-5 measurement window runs"
     (digest:283-284). The step-5 Phase A window is the shadow window
     (`docs/measurements/step5-phase-a/window-start.md:1`, :9-11), and enforce comes after it
     (`docs/design/evaluation-response-plan-2026-09-24.md:461-465`). If "clear" means enforce is reached,
     the window has already closed, so the "while it runs" condition can never hold. Under other readings
     there is no conflict. The third Phase A window is paused (`b6b984f`).
     Options: (a) "clear" means the shadow window has restarted (a fourth Phase A start), and the build runs
     inside it; (b) "clear" means enforce is reached, and the "while the window runs" clause is dropped or
     moved to a later window; (c) another reading Jordan states.
   - **Q2. Does the credential-store condition need a design merge or a build?** Digest §12 asks only that
     "PR 42's design lands" (:283). That reads as merging one design document. The design branch
     `origin/grok/credential-store-design`, head `8979b02` (2026-09-12), is not an ancestor of `6190d5f`.
     §7's "below ... the credential store (Grok's ... 3)" can also be read as the store being built.
     Options: (a) the PR 42 design merges; (b) the credential store is built; (c) the design merges and the
     store is built.
   - **Q3. Is the boxing-rpg live window a start condition or only a priority?** Digest §12 separates
     "Priority: below ..." (:282-283) from "Build after ... and while ..." (:283-284). §7 turns both into
     start conditions. Options: (a) every predecessor named under priority gates the start; (b) only the
     "Build after / while" clauses gate it, and the rest is ordering.
   - **Q4. In what order do deliverable 2 and the BLUF doctor change land?**
     `docs/measurements/engineer-feedback-bluf-security-2026-09-28.md:226` recommends printing
     `READY`/`NOT READY` as doctor's first line. Its doctor.ts:1004 anchor is stale; the summary is now at
     :1060. §3 requires byte-identical human output against the baseline. Options: (a) the BLUF change
     lands first, and deliverable 2 baselines on it; (b) deliverable 2 lands first, and the BLUF change
     re-baselines the fixtures; (c) the BLUF change is declined.

   The release itself stays Jordan's (`team-roles` rule 4). Merging this correction releases nothing.
6. **Unassigned §11 items.** This brief routes only deliverables 1-3 to github-copilot. Two items digest §11
   creates have **no owner** at `6190d5f`:
   - the `retrace-admin` `retrace-ai` harness entry (digest:269-270). At `6190d5f`,
     `packages/mcp-server/src/admin.ts:41` lists `HARNESSES` without `retrace-ai`.
   - the NOOA hourly-audit "one event per digest run by the retrace-ai seat" check (digest:277). Its code
     lives on the auditor host, outside this repository.

   This correction only records that they are unowned. Routing work is the coordinator's (agent-rules 12;
   `docs/team-roles.md`). Minting the `retrace-ai` credential and choosing its scope is Jordan's (§5.6;
   agent-ops 16); he decided on 2026-10-06 that it carries no `on_behalf_of`. Related, inferred, and not decided here: `SETUP-GUIDE.md:330` says not to add "a sixth
   agent" while completeness and attribution are weak. Whether a `retrace-ai` entry is that step is part of
   the mint decision, which is Jordan's.
7. **Deliverable 3's vendor** (added 2026-10-06). GitHub Models was fully retired on 2026-07-30; see the §4
   correction. The deferred item stands without a vendor.
8. **Issue #79** (added 2026-10-06). The build issue was opened on 2026-09-18 and has not changed since: no
   assignee, no comment. It predates this brief's rounds 2-4 and still says "deliverable 2 is code", where §6
   makes deliverable 2 class (a). It also names v1.4 as the contract, the GitHub Models client, and doctor line
   numbers that item 3 re-measures. The coordinator refreshes its text after this pull request merges, as a
   declared GitHub write (agent-ops 19). Assignment stays the go signal, and it stays Jordan's.
