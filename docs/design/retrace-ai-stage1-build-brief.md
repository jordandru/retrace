# Retrace AI stage 1 — build brief (github-copilot)

**Status:** DRAFT v1, 2026-09-18, author claude-code (coordinator), on Jordan's instruction
`evt_42add0579bc94fb6a99c8714e3ae0099`. Builder: **github-copilot** (`docs/team-roles.md`). Spec:
`docs/design/retrace-ai-digest.md` (document revision v1.4, 2026-09-15 — reviewed, approved, unbuilt).
Class (a) under agent-rules 12: this brief governs how a seat does bounded work, so it takes the design
gate. **Not started**, and not startable yet — see §7.

## 0. Read this first

This brief routes three items to the Copilot builder seat. Two are buildable (§2, §3); the third is
explicitly deferred to a question-and-answer, no code (§4).

It also draws a boundary (§1) around a proposal that must not be built. That section is not throat
clearing: on 2026-09-18 the boundary was stated to Microsoft Copilot Desktop in a prompt that named every
forbidden element, and Desktop returned the forbidden proposal near-verbatim. The boundary is restated
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
- **§5** the Finding record, its `id` derivation (identity excludes pins, heads, ranges and clocks), and
  the loud unknown-adapter-kind rule.
- **§6** the deterministic ranking rubric. Tiers 1 and 2 are **never** truncated.
- **§7** the two manifests and the six-step order of operations.
- **§8** one terminal event per run, frozen **before** publication, plus the trusted-writer threat model
  stated honestly rather than papered over.
- **§9** acceptance tests **T1–T14**. The note is not built until these pass.
- **§10** what stage 1 does not do.

Ship the tests under `node --test`. A test that cannot fail is not a test: **T2, T3, T7, T9b, T10, T13
and T14 each need a negative case that actually trips**. Where the note names a fixture — the adapter
contract table in T14 — build the fixture.

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

Two defects to fix:

1. **`label` is a free-form display string doing double duty as identity.** Any consumer keying on it
   breaks the moment the prose is reworded.
2. **The line grammar is not parseable in general** — `detail` can itself contain the `" — "` separator.

Constraints on the fix:

- The existing human output is the default and **its bytes do not change**. The push gate depends on this
  command.
- The exit-code contract is unchanged: 1 on any failure, 0 otherwise.
- The schema carries an explicit **version**, so a consumer can refuse a version it does not understand
  rather than mis-parse it.
- Stable keys are assigned deliberately and are **not** derived from display prose.
- Tests: every finding a run can emit carries a stable key; the human output is byte-identical to before;
  a version bump is visible to a consumer.

Propose the schema in the pull request body before assuming it. Do not silently redefine what
`pass`/`warn`/`fail` mean.

## 4. Deliverable 3 — deferred, no code

The stage-1.1 pinned-endpoint client with **GitHub Models** as the vendor is wanted: it would give
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

## 5. Binding constraints

1. **No claims ahead of evidence** (agent-rules 0).
2. **Stage 1 makes zero model calls and emits no model-authored text.** T1 and T3. Not negotiable.
3. **Every change to main arrives by pull request** (agent-rules 12). Own worktree, one pull request per
   deliverable, commit only your own paths. The builder does not merge and does not review its own work
   (`team-roles` rule 1); the coordinator classifies and routes (rule 11).
4. **Attribution is per seat, not per sub-task.** However the work is decomposed internally, every commit
   carries `Retrace-Actor: github-copilot`, `Retrace-Model: <the exact model id the runtime reports>`,
   `Retrace-Caused-By: <instruction event id>`. `Co-Authored-By: Copilot` alone is not provenance
   (`.github/copilot-instructions.md`). Anonymous sub-agent commits under one seat are an attribution
   failure, and in this repository that is the failure we exist to catch.
5. **Name every file changed** on the log for that change (agent-rules 3), and log before committing, in
   sequence.
6. **Credentials** (agent-rules 13): environment variables only, never echoed. Test presence with
   `${VAR:+SET}`, never `${VAR:-default}` — agent transcripts are a credential sink. On HTTP 402
   `quota_exceeded`, stop (agent-ops 9).

## 6. Review routing

Class **(a)**. This brief and deliverable 1 both govern behaviour, so each goes to all three other Core
Four seats — **Codex → NOOA → Grok**, Claude last — per `team-roles` rule 2, with Claude recused as
reviewer on this brief (author). Deliverable 2 is code: it follows the code order, Codex first. The
coordinator records the class and the head sha in the routing event before each review (rule 11); a push
after classification re-opens the gate against the new head. NOOA must be pinned to **nemotron-3-ultra**;
an unpinned NOOA review defaults to an Anthropic model and would be Anthropic reviewing Anthropic under
an NVIDIA badge (`team-roles` rule 3).

## 7. Priority, and what blocks the start

`retrace-ai-digest.md` §12 places this **below** shadow→enforce, the boxing-rpg live window, and the
credential store (Grok's 1, 2 and 3), and says to build after PR 42's design lands and while the step-5
measurement window runs, so the first digests cover a live window. Nothing here changes that order.

The work therefore starts on two conditions, both Jordan's to release (`team-roles` rule 4): this brief
merges, and the §12 predecessors clear. Deliverable 2 is small, self-contained and unblocks the digest's
doctor adapter, so it is the sensible first move inside the window — **not** a reason to start early.

## 8. The channel finding (recorded, not incidental)

The `github-copilot` seat is Copilot CLI and VS Code Chat on the one pinned credential, driven by
`.github/copilot-instructions.md` in this repository. That seat works: the export tail (PR 12), the
object-store doctor (PR 14, 17), the stranger fixes (PR 20, 22), release prep (PR 25), and the stranger
test that found the broken install command.

**Microsoft Copilot Desktop is not that seat.** It has no repository access, no pinned credential, no
model self-report and no ability to honour the pull-request gate, and on 2026-09-18 it reproduced the CPIL
proposal against a prompt that forbade each of its elements individually, opening with "assume ... SBOMs
... exist" after being handed evidence that they do not. The prompt carried a trip-wire — *if the design
note was not attached, say so and stop* — and Desktop neither said so nor stopped, proceeding to instruct
that code be committed. Output from that surface carries no actor id and no trailers; it cannot be sealed
as seat work and must not be treated as it. Briefs go to the seat, in the repository, where the note is
readable from the tree.

---

*Corrections to this brief are appended in place with a date (agent-rules 10).*
