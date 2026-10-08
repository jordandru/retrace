# Retrace AI — a read-only ledger digest (document revision v1.5)

**Status:** document revision **v1.5** (draft), 2026-10-06, author claude-code (coordinator), on Jordan's
instructions `evt_52f6dae68acc4f66ab39fab04f00ee4f` (author this revision) and
`evt_40d1e828ec654a2f96bd945453d86136` (his answers to the two questions that held it back). A first draft was
written on 2026-10-05 on the Omarchy PC by a Claude Code session (claude-opus-5-5) that is not a Retrace seat,
and relayed by Jordan. claude-code verified it, re-checked every claim it uses at `27f4264`, amended it (§13),
and answers for it. v1.5 answers the 2026-10-05 cross-check of HEAD `6190d5f` (see §13). Review round 1 at
`e43da144` (2026-10-07): Codex rejected it with four Mediums; Grok and NOOA approved. Fix round 1 (2026-10-08, on
Jordan's go `evt_7c055bb7e6f44599a0c8223e938cc47f`) answers the four (§13). Round 2 at `c83b43ec`: Codex re-raised
C-M1 and C-M2, and Grok approved. Fix round 2 (2026-10-08, Jordan's go `evt_054df4d9869b4f1bb1a9e117ebff1f60`)
answers both (§13). Round 3 at `81ccf050`: Codex kept C-M1 and C-M2 on one remaining case each, and Grok approved.
Fix round 3 (2026-10-08, Jordan's go `evt_9d49674669e04b9b98617b05018e316a`) removes the two claims behind those
cases (§13). It has not passed the design gate;
until it merges, v1.4 is the reviewed revision. The v1.4 status follows; only its leading label changed.
Effect on the build brief (added 2026-10-05): v1.5 lands in one pull request with the brief's 2026-10-05
corrections and takes the design gate with them. From that merge the brief's spec is v1.5, and each brief
correction binds its own point (brief, "Correction 2026-10-05" item 2).

v1.4: document revision **v1.4**, 2026-09-15, author claude-code (coordinator), on Jordan's
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
| status | `GET /projects/:p/status` | response bytes + hash, `generated_at`, and the export head (seq, hash) it was read under, **bracketed** by two `GET /projects/:p/head` reads (*Status head bracket*, below; v1.5) | aggregate counts only: **count findings** (§5), never per-event findings |
| reconcile | `retrace-export reconcile` over a verified export, Git range from the saved Git watermark to main's head (v1.5, 2026-10-05; below) | export head seq/hash, Git range (repo, from-sha, to-sha), output bytes + hash | the eight `ReconcileFindingKind` values, read by their code names from `--json` (`retrace-reconcile/1`) per the kind-name table below (v1.5); the "pending edits" list is **not** a finding and is reported only as a count; `restricted_hook_stamps` is a diagnostic, not a finding (below) |
| instruction follow-up (v1.5, L4-F7) | a full-project verified export the runner reads itself, by the path reconcile uses against a remote store (`fetchVerifiedRemoteEvents`, scope `{project}`; packages/mcp-server/src/reconcile.ts:4, :110-113). Against a local store reconcile reads `store.all(project)` instead (reconcile.ts:115), which is not a verified export | the signed bundle's bytes + hash and its head; the bytes + hash of the chain-verified tail `#bundleHead+1..#liveHead` that the path appends (packages/mcp-server/src/verified-events.ts:142-182, :200-212); the live head (seq, hash) the events reach, which is the export head this source records; the run's evaluation clock. The path returns events and a note, not bytes, so the runner keeps the bundle and tail bytes itself | tier 3 `export.instruction_without_followup`, one finding per instruction. An instruction is a `human` `instructed` event that no event in the export names in `caused_by`, and whose `timestamp` is older than the evaluation clock by more than the rules-file threshold (default 24h). This uses the status definition (packages/core/src/status.ts:99, :132, :163) and adds the age. `timestamp` is set by the writer when present (packages/core/src/schema.ts:244), so the age is producer testimony. This is a negative finding (§5): its evidence is the instruction event, cited with the live head, plus an observation of the pin above with scope `{project}`, which records that the absence was checked over the whole project through that head. The status field `instructions_without_followup` is an all-time count with no ages (status.ts:61-62, :163), so it is **not** this rule's source. The source is ledger-backed. It is a separate read from reconcile's, so on a ledger taking writes the two usually land on different heads. *Revised 2026-10-06:* under the chain-prefix rule below that is expected; only a head that is not on the run's reference chain is inconsistent |
| doctor | packed CLI; a structured output mode is implementation work (§11) — stage 1 parses the labelled lines and records the parser version | output bytes + hash, dist version, and whether `--gate` was passed (v1.5: §6 doctor rule); the Git sha of the checkout it ran in (v1.5, 2026-10-05: `doctor.gate: true`, §6); the verified ledger head (seq, hash) its ledger-derived labels read, which doctor prints under `--gate` (fix round 1, 2026-10-08: §6, *Doctor's ledger view*) | WARN/FAIL findings incl. the PR 35 review-routing advisories, tiered per (key, level) by the §6 doctor rule; PASS yields no finding. Doctor has no informational or acknowledged level (v1.5, 2026-10-05; `doctor.ts:13` at `6190d5f`) |
| NOOA audit | the latest `independent-audit` event(s) in the ledger under the export head | event ids, export head | PASS → nothing; FAIL → tier 1 (positive evidence of breakage); **INCONCLUSIVE** (an event exists with that outcome) → "source uncertain", header, tier 4 age; **no audit event within the expected interval → tier 1 "source unavailable: NOOA audit"** — absence is never downgraded to uncertainty (Nemotron 8) |
| checkpoints | `.retrace/checkpoints.jsonl` at a pinned Git sha + the export head | file hash, sha | checkpoint head absent from export → tier 1; age since last checkpoint → count finding |
| shadow classification | `claim_decision` on sealed commit events (PR 34, when `RETRACE_TRAILER_POLICY=shadow` is deployed and classifying) | event ids, export head | (v1.5) `method.params.claim_decision.decision.status` = `conflicting` (policy `trailer-consistency/1`) → tier 2 **shadow diagnostic** citing decision, read head, policy digest and witnesses; the bullet preserves `actor` vs `would_write` and never describes a rewrite or misconduct. Not deployed or not classifying → "unavailable", never "no conflicts" |
| PR 34 pending deliveries | none public today | — | **out of scope** until a listing surface exists |

**Reconcile kind names (v1.5, 2026-10-05).** v1.4 named the reconcile kinds by the labels of the text
summary line. The code names differ (`packages/core/src/reconcile.ts:33`, at `6190d5f`). The adapter reads
`retrace-export reconcile --json` (format `retrace-reconcile/1`, `reconcile.ts:75`, `:460`;
`packages/mcp-server/src/reconcile.ts:3`). It keys on the code name in each finding's `kind` field and in
`summary`. It never parses the text rendering. The summary-line labels are display only
(`reconcile.ts:467`). `rule_id` is `reconcile.<code name>`. The tier column restates §6 and adds nothing.

| Code name (`kind`, `summary` key) | v1.4 name (§4 row, §6) | `rule_id` | Tier (§6) |
| --- | --- | --- | --- |
| `missing_commit` | missing | `reconcile.missing_commit` | 3, for every `missing_commit` in the reconciled range (v1.5, 2026-10-05; below) |
| `misattributed` | misattributed | `reconcile.misattributed` | 2 |
| `producer_disagreement` | producer-disagreement | `reconcile.producer_disagreement` | 1 |
| `unreachable_seal` | unreachable-seal | `reconcile.unreachable_seal` | 4 |
| `uncovered` | uncovered | `reconcile.uncovered` | 3 when its `file` matches `reconcile.governing_paths`; 4 otherwise (v1.5, 2026-10-05; below) |
| `loose_match` | loose | `reconcile.loose_match` | 4 |
| `non_agent` | non-agent | `reconcile.non_agent` | 4 |
| `orphan_edit` | orphan paths | `reconcile.orphan_edit` | 4 |

Where §6 names no tier, this revision does not add one. That gap is carried as it stood in v1.4.

*Correction, 2026-10-05 (design-gate gap, untiered reconcile cases).* The sentence above left two cases
without a tier, and step 4 below tiers every remaining finding by this table, so it cannot stand. This
revision decides both. The sentence above is withdrawn.

- `missing_commit` is tier 3 for every commit in the reconciled range. The range is `<from-sha>..HEAD` of
  the checkout reconcile runs in (`packages/mcp-server/src/reconcile.ts:46-47`, `rev-list` from Git, not
  from the ledger). The runner runs it in a checkout of main, so to-sha is main's head and every commit
  in the range is reachable from main. "Missing on main" in §6 therefore covers every `missing_commit`
  stage 1 sees. The `warn` case (a pull-request head whose merge the webhook sealed; core
  `reconcile.ts:336`) is tier 3 too, because `level` is not in the lookup (step 4). The manifest records
  the ref the checkout was taken from. A run whose to-sha is not main's head at the reconcile read is
  "incomplete" (§5) for every reconcile finding, and says so.
- `uncovered` is tier 3 when its `file` matches a glob in `reconcile.governing_paths`, and tier 4
  otherwise. An `uncovered` finding with no `file` is tier 3: the pinned code always sets it (core
  `reconcile.ts:381`), and where the class is uncertain the higher gate applies (agent-rules 12). Off a
  governing path, an uncovered file is a missing record on a file that governs nothing, which is §6's
  tier-4 meaning "nothing wrong, something stale" more than tier 3's.
- `reconcile.governing_paths` is a required field of `digest-rules/1.json`, a list of globs matched
  against the repo-relative path. Stage 1 refuses a rules file without it, or with an empty list, at
  start. Agent-rules 12 classes by consequence, not file type, so no list in the repo exists to read. The
  list stands in for class (a) and is the rules file's, versioned and digest-cited like the rest of it.
  Agent-rules 12(a) names categories, not files (`docs/agent-rules.md:107-109`). The stage-1 value maps
  each category to the paths that hold it at `6190d5f`. It was checked against every path at `6190d5f` that is
  not source code or a test, and re-checked at `ce2a78cc` on 2026-10-08 (fix round 1, Codex r1 C-M4). Paths
  first present at `ce2a78cc` are marked †.
  - **Rules and identity files:** `docs/agent-rules.md`, `docs/agent-ops.md`, `docs/team-roles.md`,
    `docs/owner-protocol.md`, `CLAUDE.md`, `AGENTS.md`, `GROK.md`, `.hermes.md`†, `.claude/**`, `.cursor/**`,
    `.grok/**`.
  - **Design notes and briefs:** `docs/design/**`, plus the two plans kept outside it,
    `docs/producer-signing-plan.md` and `docs/reconciliation-plan.md`.
  - **Security, build, deploy and runbook controls:**
    - repository and agent configuration: `.github/**`, `.retrace.json`, `.retrace/**`, `.mcp.json`,
      `.gitattributes`, `.gitignore`;
    - scripts: `scripts/**`. This includes the cloud push guard `scripts/cloud/guard-push-main.sh`
      (`docs/design/cloud-seat.md:308-312`), its launcher and setup, and the deploy check;
    - Worker deploy and build: `apps/worker/*` (`wrangler.toml`, `schema.sql`, `migrate.mjs`, `migrate.d.mts`,
      `package.json`, `tsconfig.json`);
    - build: `package.json`, `package-lock.json`, `tsconfig.base.json`, `packages/*/package.json`,
      `packages/*/tsconfig.json`, `packages/*/scripts/**`;
    - seat controls: `packages/hermes-plugin/**`†, `hermes.retrace*.yaml`†, `sandbox/**`†;
    - adapters: `adapters/**` (plugin manifests, an agent skill, and the Drive adapter's OAuth manifest);
    - runbooks a user or operator follows: `SETUP-GUIDE.md`, `README.md`, `packages/*/README.md`,
      `docs/attribution-operator-guide.md`.

  Where a path's class is uncertain it is listed, because the higher gate applies (agent-rules 12). Left out,
  each for a stated reason:
  - source code and tests (`packages/*/src/**`, `apps/worker/src/**`, test fixtures). This list does not classify
    them (reworded in fix round 2, after a Codex r2 precision note).
    - Agent-rules 12 classes code by consequence too, so some code is class (a); the build brief treats the
      executable doctor gate that way.
    - The list names only paths whose location alone marks them as governing.
    - An uncovered change to source code is tier 4 under it, as it was before this revision;
  - `docs/measurements/**`, `docs/examples.md`, `docs/reference.md`, `docs/second-project-baseline.md`, `claude/**`
    (a working list and a review record) and the `LICENSE` files, which govern nothing (class (b));
  - `site/**` and `packages/core/ui/**`, a landing page and a viewer.

  A change to the list is a rules-file version bump and class (a).

`orphan_edit` is not a per-commit finding. It is the length of the report's `orphans` array
(`reconcile.ts:446`), so the adapter reads `orphans` for it. The JSON `range` carries `head_seq` but no
head hash (`reconcile.ts:77`); the head hash is the verified export's, already pinned in the reconcile row.

*Correction, 2026-10-05 (critic pass, reconcile head hash).* The last clause above is withdrawn. Reconcile
reads its export inside its own process (`fetchEvents`, `packages/mcp-server/src/reconcile.ts:110-113`), and
with `--json` it prints only the report (:144), so the runner never sees that export's head hash.
`range.head_seq` is the seq of the last event reconcile read (core `reconcile.ts:189`, :460). The runner
therefore brackets the reconcile read exactly as it brackets status: `GET /projects/:p/head` (unsigned) →
`H1`, run reconcile, `GET /projects/:p/head` → `H2`, bytes and hash of both retained. *Revised 2026-10-06 (claude-code; §4 "Snapshot and
consistency"):* the reconcile pin is the **interval** from `H1` to `H2`. It holds when `range.head_seq` lies
between `H1.seq` and `H2.seq` inclusive and both ends lie on the run's reference chain. When both reads are
`null` and `range.head_seq` is `null`, the pin is "no head". Otherwise the runner repeats the bracket, up to the
same bracket retry limit, and if no attempt holds the *Mismatch* outcome below applies to every
reconcile-derived finding (incomplete, tier-1 "snapshot inconsistent" citing `H1`, `H2` and `head_seq`, run
degraded). The draft's equality pin (`H1` = `H2` and `range.head_seq` = `H1.seq`) is withdrawn: a read-only
reconcile of 30 commits took 57 s on 2026-10-05, and on the measured write rate the head moves during a read
that long at about a third of start times. The report carries no head hash of its own, so the interval bounds
its read by two heads on the reference chain; it does not attest it (§11 asks reconcile's JSON for the hash).
The manifest records both head reads and the attempt count. T4 covers it.

**Attribution availability (v1.5, 2026-10-06; claude-code, measured).** Reconcile applies attribution
amendments only when its attribution context loads (`packages/mcp-server/src/reconcile.ts:126-133`). When it
does not load, reconcile carries on without it: the collector returns "unavailable" whenever amendments exist
(core `attribution.ts:153-157`), and no amendment then lowers a `misattributed` finding (core
`reconcile.ts:304`, `:399`). The text report says so in its closing note, "attribution evaluation unavailable:
<reason>" (mcp-server `reconcile.ts:130`, `:145`). The `--json` report does not: with `--json` reconcile prints
only the report object (`:144`), and the object carries no attribution state and no export head hash (core
`reconcile.ts:460`). At this head the context fails on every run. A read-only reconcile of the last 30
commits on 2026-10-05 at 22:12Z, and another at `27f4264` on 2026-10-06, ended "attribution evaluation
unavailable: context_missing: full commit identity commit:b96676bc29253fda3434b7f4c93240fb5802d8a8". The trigger
is one record: seq 10390, `evt_0e3d0382558f4b229b9d4bc6a5c14103`, a `merged` record for PR #60 that the
claude-code seat logged through MCP on 2026-09-30, whose commit artifact is that bare ref. The context treats a
commit or merge record's commit artifact as a seal identity and fails closed unless it reads
`commit:<repo>@<sha>` (core `attribution-context.ts:75-81`, `:99-106`). The same bare ref on two non-commit
events of that day (`evt_742cdd136bf24a588a8a8f7b28545119`, `evt_48a996bfe70941b0b7a8f07c41e1057b`) only yields
an `ignored` diagnostic (`:101-104`). A scan of all 14,192 events on 2026-10-06 found no other such record. The
ledger is append-only, so every later run inherits it (issue #195). A digest reading `--json` today would render corrected
misattributions as live tier-2 findings and could not tell. Stage 1 therefore treats reconcile's attribution
state as unknown until the JSON report states it, and marks every reconcile `misattributed` finding
`incomplete` while the state is unknown or unavailable; a reported "unavailable" is also a tier-1 "source
unavailable: reconcile attribution" finding (§6). Two §11 items are prerequisites for the first live run.

*Added 2026-10-08 (fix round 1; the coordinator's finding, not a reviewer's; measured).* The fix for the seq 10390
shape is in review (PR #198). That fix alone does not make the context load.
- The Git-facts adapter resolves the commit refs of every `committed` or `merged` record with `git rev-parse` in
  the reconciling checkout (`packages/mcp-server/src/attribution.ts:30-41` at `ce2a78cc`). When that fails, it falls
  back to a full OID the ledger supplies, a `git:` key or a full-length commit ref, if exactly one matches
  (`:36-39`). Otherwise it fails the whole context (precision from Codex r2, fix round 2).
- A webhook push seal names the pushed commit, whatever branch it is on.
- On 2026-10-07 the checkpoint bot's push seal at seq 14839 (`evt_55b573a57a5644f4be6f1198becf4459`) named commit
  `c47fee54d5b7`, which was on origin's `checkpoint/20261007-14837` only. A reconcile run from a clone that had
  not fetched that branch reported "attribution evaluation unavailable: context_missing: ambiguous or unknown
  full OID" for that ref, both at main `ce2a78cc` and at PR #198's head (Grok `evt_8c563fcee5cf4d8297dcaf971a0f2aba`;
  read `evt_4b301d3ee8ae430cb93506d48912a9cc`).

The runner therefore fetches the remote's branches and pull-request heads before the reconcile read, and it
records the fetch (remote, refspecs, time) in the selection manifest. A commit in neither, whose full OID the
ledger does not supply, still fails the context; the second §11 reconcile item covers that case.

**The shadow source while the trailer policy is off (v1.5, 2026-10-06; claude-code, measured).** The shadow row
above yields "unavailable" whenever the classifier is not classifying. On 2026-10-05, none of the 130 commit
and merge seals with a `timestamp` from 2026-10-04T00:00:00Z up to 2026-10-05T22:07:00Z carried
`claim_decision` (actions `committed` and `merged`, every producer: 94 committed, of which 39 asserted by the
git hook and 55 by the GitHub webhook, and 36 merged, of which 14 by the hook, 14 by the webhook and 8 logged
through MCP; re-measured 2026-10-07 for v2 after Grok's round-1 finding G-L2, `evt_a7a96c37cc47457488313bc9e986bff1`,
in `evt_df98b877719c4831af88da21a4fc407b`; v1.5 read 126, which is not reproduced; the count is the same
through the end of 2026-10-05), so the source is unavailable today. Under §6
every run would then carry a tier-1 "source unavailable" finding and fail §10's condition (c): no promotion
window can count while the policy is off. This revision keeps the rule, because "unavailable, never no
conflicts" is its point, and states the consequence instead: promotion waits for the trailer policy to be on,
which §12 already assumes (build "while the step-5 measurement window runs"). If Jordan releases the start
before the policy is on (build brief §7), the first runs are degraded for this reason and say so.

**`restricted_hook_stamps` (v1.5, 2026-10-05).** After v1.4 merged (`06034b7`), the report gained an
optional `restricted_hook_stamps` array (`5a86d1a`, `reconcile.ts:85-87`). It is absent when no
restricted stamp was observed (`reconcile.ts:460`). It is not a `ReconcileFindingKind` and has no `summary`
key (`reconcile.ts:88`). Each entry already feeds the per-commit kinds: an eligible stamp becomes the
commit's hook witness, and an ineligible one is treated as a client claim (`reconcile.ts:235-243`,
`:313-314`). Stage 1 therefore recognises the field and yields no finding from it. Like the pending list,
it is reported only as counts in the reconcile observation: entries, and entries with `eligible: false`.
It is not a kind, so the "adapter unknown kind" rule (§5) does not apply to it. T14's fixture includes a
report with the array present and one without it.

**Acknowledged, amended and `info` (v1.5, 2026-10-05; design-gate gap).** A reconcile finding has three
levels, `fail`, `warn` and `info` (`packages/core/src/reconcile.ts:34`), and two optional fields,
`amended` and `acknowledged` (:47-48). Reconcile rewrites the level when it sets either field. An
acknowledgement sets `acknowledged` and lowers `fail` or `warn` to `info` (:323). The original level is not
kept. An effective attribution amendment sets `amended` and lowers the level to `info`: a file-level
`misattributed` `warn` (:409-413) or the commit-level `misattributed` `fail`, whose certificate keeps
`original_level: "fail"` (:417-418). Neither field is set on a finding that already carries the other
(:398, :409). Native `info` findings are `non_agent` (:360), `loose_match` (:382), and `uncovered` when the
repo or `--uncovered` sets that level (:187, :381; `packages/mcp-server/src/reconcile.ts:17`, :139). An
acknowledgement never touches a native `info` finding (core `reconcile.ts:323`). The adapter reads each entry of
`commits[].findings` and applies, in order:

1. `level` is not `fail`, `warn` or `info`; or `amended` is present on a kind other than `misattributed`;
   or `amended` and `acknowledged` are both present → tier-1 "adapter unknown kind" (§5), citing the raw
   entry. The pinned code produces none of these shapes.
2. `amended` present → no finding. The record has been amended by an attribution correction that
   reconcile verified, which is the case §5 and T13 call a corrected misattribution. The reconcile
   observation counts it: `summary.amended`, absent when zero (:426), read as 0.
3. `acknowledged` present → one tier-4 finding, `rule_id` `reconcile.acknowledged`. Its subject is the
   commit sha, the code name and the file when present, so its id differs from the unacknowledged
   finding's (§5). `facts` carry the code name, the file and `acknowledged` (`seq`, `id`, `actor`).
   `facts` carry no original level, because the report does not keep it. Evidence is the commit (Git) and
   the acknowledging correction event, cited with the export head. An acknowledgement is testimony that
   the finding was seen. It does not change the record, so the finding stays visible, but it is no longer
   the kind's live finding. This restores v1.4's "acknowledged → tier 4" for reconcile only, keyed on
   this field. The doctor withdrawal in §6 stands.
4. Otherwise → the kind's tier from the kind-name table, whatever the level. Its subject is the commit sha
   and the file when present, so two file-level findings of one kind on one commit keep distinct ids (§5;
   added 2026-10-05). `level` is not part of the
   lookup. It is recorded in `facts`. Reconcile's level is repo policy (`--uncovered`, `--dual-witness`;
   core `reconcile.ts:187`, :351), and the digest's tier is the rules file's. A native `info` finding is tiered like a `warn`
   or `fail` of the same kind. Where the table names no tier for a kind, that gap is carried as above.
   *Correction, 2026-10-05:* the table now names a tier for every case (above), so step 4 has no gap. For
   `uncovered` the lookup key is the kind and whether `file` matches `reconcile.governing_paths`.

`summary[kind]` counts the per-commit findings of that kind, acknowledged and amended included (:426);
`orphan_edit` and `unreachable_seal` are set or added to later (:446, :454). It is
retained in the pin and never used to select or tier. The reconcile observation records
`summary.acknowledged` and `summary.amended` as counts. T14's fixture covers each step.

**The second `conflicting` (v1.5, 2026-10-05).** The owner-login work (`9e98243`, `50340a8`, after
`06034b7`) added `OwnerLoginStatus` with its own `conflicting` value
(`packages/core/src/owner-login-record.ts:9`). It lives in `method.params.owner_login_decision`
(policy `owner-login/1`, `owner-login-record.ts:5`, `:30`), not in `claim_decision`
(`packages/core/src/producer-sig.ts:47`; `packages/core/src/classify.ts:80`, `:127-139`). The
shadow-classification adapter keys on `claim_decision` alone. An owner-login `conflicting` is never a
shadow diagnostic and never counts toward one. §4 lists no owner-login source, so under this revision
owner-login decisions yield no finding. T14's fixture includes an event that carries
`owner_login_decision` with status `conflicting` and asserts that it yields nothing.

**OPEN QUESTION FOR JORDAN (v1.5, 2026-10-05): owner-login decisions as a digest source.** Options:
(a) keep them out of stage 1, as the text above records; (b) add them in a later digest revision as their
own source with their own `rule_id`s, through its own design gate; (c) add them to stage 1 now, which
widens the stage-1 scope before the build starts. This revision does not choose.

**Snapshot and consistency.** Stage 1 uses a composite snapshot: each source is pinned separately, and
every ledger-backed source records the **export head (seq, hash)** it was read under in the selection
manifest. Rule: if any two ledger-backed sources in one run report different export heads, every finding
that depends on either is marked `incomplete` and a tier-1 **"snapshot inconsistent"** finding is
emitted citing both heads (Nemotron 3; T4). A single verified-export-derived snapshot for all
ledger-backed sources is a later build target; the composite form plus this rule is what stage 1 can
honestly claim.

*Correction, 2026-10-06 (v1.5; claude-code; source: the planning pane's cross-check, re-measured on the
ledger in `evt_e4147e876bb0453aa3d36d48e4ebc867`). The paragraph above stays as written; this one replaces its
rule.* Read literally, the rule degrades most runs on a ledger that is taking writes. In the 48 hours from
2026-10-03T22:07:00Z to 2026-10-05T22:07:00Z (half-open; every event of project `retrace` whose `timestamp`,
parsed to UTC, falls in it; re-measured 2026-10-07 for v2 after Grok's round-1 finding G-L1,
`evt_a7a96c37cc47457488313bc9e986bff1`, in `evt_df98b877719c4831af88da21a4fc407b`; v1.5 read 1953 events, 108
"in the busiest tenth of hours", 31.5% and 41.5%, and that 108 was a 90th-percentile hour on another grid, not
reproducible as written) the ledger took 1951 events (seq 12106 to 14056): 40.6 an hour on average (1951/48);
115 in the busiest 60-minute bucket and 105 in the 90th-percentile bucket (nearest rank, the 44th of 48
ascending), both on a fixed grid of 60-minute buckets from the window start; 94 in the busiest 33 minutes (a
sliding window that starts at each event's timestamp). The head moved during a 60-second window at 31.2% of
start times and during a 120-second window at 41.6%: the start times are every 60 seconds on a fixed grid from
the window start, 2880 of them, and a start counts when at least one event's timestamp falls in
[start, start + length). A run reads its ledger-backed sources one after another over minutes, so two of
them rarely share a head, and §10 counts every degraded run against readiness. On an append-only chain,
different heads are not an inconsistency; a fork is.

**Rule (chain-prefix consistency, v1.5, 2026-10-06).** Every ledger-backed source records the head it was read
under, or, for status and reconcile, its bracket interval (below), or, for doctor, the ledger head it prints (§6,
*Doctor's ledger view*; fix round 1). After its last ledger-backed read the runner
takes one **reference chain**: a verified export plus the chain-verified tail to a signed head read after every
source, by the path reconcile uses against a remote store (`fetchVerifiedRemoteEvents`, scope `{project}`;
`packages/mcp-server/src/verified-events.ts:142-182`, `:200-212`). The instruction follow-up read serves when it
is the last ledger-backed read. Every recorded head (seq, hash), and both ends of every bracket, must lie on the
reference chain: the chain's event at that seq exists and carries that hash. Then the run is consistent, and
each finding cites the head its source was read under. Consistent is not current: each finding is stated as read
at its source's head. When a known superseding event lands after that head, the supersession check below reads the
source again and, if the event still applies, marks the finding `incomplete` (fix rounds 1 and 3). A recorded head that is not on the reference chain, or
a bracket whose counts fall outside it, is a tier-1 **"snapshot inconsistent"** finding citing the head and the
reference chain's event at that seq; every finding that depends on that source is `incomplete`, and the run is
degraded. A finding that compares values across sources names both heads, and no comparison is made across
different heads unless both values are computed from the reference chain. This meets v1.4's "later build
target" in part: the reference chain is the consistency check, not yet the source of every count. Nemotron 3
(v1.3, accepted) still holds: an inconsistency is tier 1. Only what counts as one is narrowed, to what the
chain can prove. T4 tests it.

**Supersession inside a run (fix round 1, 2026-10-08; Codex r1 C-M1).** The prefix rule proves that the run's
heads share one history. It does not prove that a finding read at an earlier head still holds at the reference
head. An acknowledgement or an effective attribution amendment can land after the reconcile read and before
the reference chain is taken, and reconcile applies both when it builds its findings (core `reconcile.ts:320-323`,
`:399-418`, at `6190d5f`, unchanged at `ce2a78cc`). A digest that rendered the earlier finding as live would
cite an interpretation the ledger has already superseded.

**What the check claims, and what it does not (fix round 3, 2026-10-08; Codex r3 C-M1).** The rows below list
the known ways a later event supersedes a finding. They are not every way a fresh read could differ.
- For example, the attribution context checks the repository reference of every event, not only seals (core
  `attribution-context.ts:98-111`, at `ce2a78cc`).
- So a later ordinary edit that names an expired repository alias makes a fresh context fail. The amendments a
  fresh reconcile would apply then go with it (`packages/mcp-server/src/reconcile.ts:128-132`).

The digest therefore never states a finding as current. Each finding is stated as read at its source's head, with
the known shapes checked through the reference head. This is the alternative Codex accepted in round 1: historical
(as-of) semantics, with the treatment of known supersession defined for completeness and promotion. That treatment:
- **Known supersession** is a match in the source's row that survives the second read. It makes the finding
  `incomplete` and the run degraded (below; §10 (c)).
- **A later event outside every row** changes neither the finding nor its completeness.
  - The finding is true as read.
  - The next run reads fresh (§5, stateless per run).
  - The recall audit replays from retained inputs, so it judges the digest against what its sources returned
    (§10 (b)).
- **The attribution state is stated as of `range.head_seq`**, like the findings that depend on it: `evaluated`,
  `unavailable` or unknown, as read (§4).

So after the reference chain is taken, the runner checks each source's **reference tail**. That is the
events on the reference chain after the last event the source actually read, up to the reference head, on both
passes (fix round 2, Codex r2 C-M1):
- for reconcile, after `range.head_seq`, the seq of the last event it read (above). A bracket end is never the
  start, because the read can end before `H2`: an acknowledgement sealed between `range.head_seq` and `H2` is
  in the tail. When `range.head_seq` is `null` (the "no head" pin), the tail is the whole reference chain;
- for doctor, after the ledger head it prints (§6, *Doctor's ledger view*);
- for the instruction follow-up, after the live head its read reached.

The tail is checked against the source's row in the **supersession table**:
- The table is a required part of `digest-rules/1.json`, versioned and digest-cited like the rest of the file.
  A change to it is a rules-file version bump and class (a).
- A row names the event shapes that the source's interpretation reads for a finding's subject.
- Where a row cannot tell whether an event concerns a finding, the event matches, because the higher gate
  applies.

Stage-1 rows:
- **reconcile**, for every per-commit finding (revised in fix round 2, Codex r2 C-M1: the round-1 row matched
  only records that name the finding's own commit). Any tail event of these shapes matches every reconcile
  per-commit finding, whichever commit it names:
  - a `committed` or `merged` record, for any commit, in the reconciled range or not (core `reconcile.ts:231-265`).
    A seal for another commit can change a finding's window. Coverage counts the edits between the previous
    capture boundary of another commit and the commit's own seal (`:368-372`). A later webhook seal can activate
    an earlier restricted witness for another commit (`capture.ts:9-22`, `:120-126`, `:191-203`). That moves the
    boundary below an in-range commit's seal, even when the webhook names a commit outside the range;
  - a `correction`-tagged event: reconcile's acknowledgement (`:157-171`, `:266-272`);
  - an attribution amendment, that is `action: other` with `action_detail: "amended"` (core `attribution.ts:56`).

  Edit events have no row.
  - An edit sealed after a commit's seal falls outside that commit's window: coverage skips every edit at or above
    the commit's own seal (`reconcile.ts:368-372`, at `ce2a78cc`).
  - An unsealed commit's finding reads only commit and merge records (`:326-337`).
  - An edit can still change whether a fresh read's attribution context loads (*What the check claims*, above). No
    row covers that, so the findings are stated as of `range.head_seq` instead of as current (fix round 3).
  - `orphan_edit` and the observation counts have no row either: they are counts read up to `range.head_seq` and are
    rendered as such.

  The cost, from the measured rate: the ledger took 130 commit and merge seals in 46 hours (§4, the shadow
  source), about three an hour. A tail of a few minutes seldom holds one. When it does, reconcile is read once
  more. A finding then ends `incomplete` only if a further seal lands during that second read and doctor's run.
  That takes about two minutes; a 30-commit reconcile read took 57 s (§4).
- **instruction follow-up**, for each finding. The subject is the instruction, and an event whose `caused_by`
  is that instruction matches. When this read serves as the reference chain, its tail is empty.
- **doctor**, for the ledger-derived labels (§6, *Doctor's ledger view*). Every tail event matches. Some of
  those labels (`owner-login`, the review-routing labels and `model claim absent`) read the whole verified
  export, not one subject, so stage 1 does not narrow the row. Doctor is read again instead: that costs seconds,
  where a reconcile read costs a minute.
- **NOOA audit**. An `independent-audit` event matches. Revalidation is not a re-read: the runner takes the
  latest audit at or below the reference head from the reference chain itself.
- **status**, **shadow classification** and **checkpoints** have no row.
  - Status yields counts and an integrity result. They are rendered as read between `H1` and `H2` (*Status head
    bracket*, below), never as present values.
  - A `claim_decision` is stamped on its seal, and no later event changes it.
  - The checkpoints source checks its head against the reference chain itself.

What a match does:
1. Every source with a match, except NOOA (above), is read once more, in a second pass.
   - Reconcile is re-read by a full bracket, under the bracket retry limit.
   - Whenever any source is read again, doctor, whose row matches every event, is also read again, last.
   - The new reads replace those sources' findings and pins.
   - The runner then takes the reference chain once more. It applies the prefix rule to every recorded head
     against that chain, and checks every source's tail against it, each from its latest read head.
2. A finding that still has a match after that is `incomplete`. It cites the matching tail events with the
   reference head, and the run is degraded. There is no third read. §10 counts the run like any other
   degraded run.
3. A tail with no match changes nothing, so unrelated appends do not degrade a run.
   - A finding with no match is stated as read. Its bullet names the head its source was read under, and says
     the known superseding shapes were checked through the reference head. It never says the finding is current
     (fix round 3).
   - A count is rendered as observed between its bracket ends.

The selection manifest records, per source:
- the tail range it checked;
- the matching event ids;
- any second read and its pins;
- both reference heads.

T4 (v) to (viii) test it.

**Status head bracket (v1.5, 2026-10-05; correction, cross-check finding L2-5).** v1.4 pinned status to
"the export head it was read under", but the status response carries no head. `ProjectStatus` has
`generated_at`, `integrity` (a `VerifyResult`: `ok`, `checked`, no hash) and `events.total`
(packages/core/src/status.ts:40-85, chain.ts:97-104, at `6190d5f`). Its optional `export_cache` block
(cached and live head seq, no hash; status.ts:85, export-cache.ts:59-66, added in `ce04f90`) describes the
export cache, not the status read. It is never used as the pin. The runner brackets the status read:

1. `GET /projects/:p/head` (unsigned) → `H1` (router.ts:959-961), bytes and hash retained;
2. `GET /projects/:p/status` → `S`;
3. `GET /projects/:p/head` (unsigned) → `H2`, bytes and hash retained.

*Revised 2026-10-06 (claude-code; chain-prefix rule above):* the status pin is the **interval** from `H1` to
`H2`. It holds when `H1.seq` is at or below `H2.seq`; `S.events.total` lies between `H1.seq + 1` and
`H2.seq + 1` inclusive; when `S.integrity.ok`, `S.integrity.checked` lies in the same range; and both ends lie
on the run's reference chain. The draft's equality pin (`H1` = `H2`, both counts = `H1.seq + 1`) is withdrawn:
on the measured write rate it fails at a large share of attempts. Seq starts at 0 with no gaps
(chain.ts:81; checkpoint.ts:80 uses the same `seq + 1`). Status
reads the event list twice (status.ts:96-97), so both counts are checked. The bracket uses the unsigned
head. For an empty project it returns `null` (router.ts:960-961); the bracket matches when both reads are
`null` and `events.total` is 0, and the pin is recorded as "no head". (The signed variant, `?signed=1`,
returns seq -1 and `GENESIS_HASH` for an empty project, router.ts:964-966, so `seq + 1` = 0 holds without a
special case. A runner that uses it records that variant in the manifest; the check is the same.) The
head is bracketed, not attested: the status bytes carry no hash. The manifest records both head reads and
the attempt count, and the digest never says status was read at a hash; it says status was read between two
heads.

**Mismatch.** If any condition fails, the runner repeats the whole bracket, up to the bracket retry limit
in `digest-rules/1.json` (default 3 attempts). Every attempt's bytes are kept in `inputs/`. If no attempt
holds, status has no pinned interval: every status-derived finding is marked `incomplete`, a tier-1
"snapshot inconsistent" finding is emitted citing `H1` and `H2` of the last attempt and any count that fell
outside them, and the run is degraded. Status is never paired with a head it was not read under (T4).
*Revised 2026-10-06:* a held interval enters the chain-prefix rule above through its two ends; it is not
compared for equality with any other source's head. A "no head" pin records an empty project when status was
read; an empty chain is a prefix of every chain, so it is consistent with any reference chain.

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
every doctor label the pinned dist version can emit (§6 doctor rule; v1.5 replaces "informational/acknowledged
findings", which doctor does not have). **An unrecognised kind is loud:** it produces a tier-1
"adapter unknown kind" finding citing the source, pin and raw kind string, so a new critical check can
never be filed as hygiene (Nemotron 9).

## 6. Ranking rubric (deterministic)

Tiers by consequence; within a tier by `newest_evidence` (newest first), then count, then finding id as
the stable tie-breaker. The evaluation clock (the run's fixed `now` from the manifest) is used only for
ages and thresholds, never for ordering. Rubric and adapter table live in `digest-rules/1.json`, versioned
and digest-cited by every run.

| Tier | Meaning | Rule ids (source) |
| --- | --- | --- |
| 1 — integrity | positive evidence the chain or a witness disagrees, or a source that would prove it is unavailable or inconsistent | status integrity not ok; checkpoint head absent from export; reconcile producer-disagreement; NOOA FAIL; source unavailable (incl. absent NOOA audit); snapshot inconsistent; adapter unknown kind; doctor `owner-login` WARN/FAIL while it has one key (v1.5, §6 doctor rule); the runner's own next-run findings: seat wrote outside its envelope, terminal event mismatch, seat audit incomplete, seat key mismatch (v1.5, 2026-10-05; §8 already names each as tier 1; listed here so the table is complete), and terminal event unknown (fix round 2, §8 withdrawal); every other doctor label at tier 1 in the §6 doctor label table (v1.5, 2026-10-05) |
| 2 — attribution | a record says who and evidence says otherwise | reconcile misattributed; shadow `conflicting` (labelled shadow); doctor FAIL on identity/credential checks, and their WARN where `--gate` alone sets the level (v1.5, §6 doctor rule); "identity/credential checks" are exactly the labels at tier 2 in the §6 doctor label table, at every level listed there (v1.5, 2026-10-05) |
| 3 — coverage | a record is missing where one should exist | reconcile missing on main, which is every `missing_commit` in the range (§4); uncovered on a governing path (rule 12 class a paths, read as `reconcile.governing_paths`, §4); unlinked-commit count above baseline; instructions without follow-up older than the rules-file threshold (default 24h), from the verified export (§4), never from the status count; the doctor labels at tier 3 in the §6 doctor label table (v1.5, 2026-10-05); the runner's own next-run finding "terminal event withheld" (root withdrawn before publication; fix round 1, §8) |
| 4 — hygiene | nothing wrong, something stale | unreachable-seal, orphan paths, loose, non-agent, uncovered off a governing path (v1.5, 2026-10-05; §4), agent events without model, unverified links, NOOA INCONCLUSIVE age; doctor WARN `export-cache` and `model claim absent` (v1.5); reconcile acknowledged, `reconcile.acknowledged` (v1.5, §4); the other doctor labels at tier 4 in the §6 doctor label table (v1.5, 2026-10-05) |

**Doctor rule (v1.5, 2026-10-05).** Doctor findings have three levels only: `pass`, `warn`, `fail`
(`packages/mcp-server/src/doctor.ts:13` at `6190d5f`). There is no informational level. "Acknowledged" is
not a doctor level or field. In doctor it is read only by `captureCoverageFinding`: :307 drops acknowledged
reconcile findings before the level is chosen (:308), so an acknowledged reconcile fail yields a `capture
coverage` PASS, and :313 notes the acknowledgement in that PASS detail. It is a structured field of reconcile
(`packages/core/src/reconcile.ts:48`), and only the reconcile adapter reads it, from there (§4,
*Acknowledged, amended and `info`*). v1.4's
"informational and acknowledged findings map to tier 4" (§4, §5) had nothing to key on in doctor and is
withdrawn for doctor. For reconcile, §4 keys tier 4 on the `acknowledged` field and tiers a native `info`
finding by its kind. The
doctor adapter applies, in order:

1. `pass` → no finding.
2. `warn` or `fail` → the tier the adapter table gives for that (key, level) pair. The lookup key is
   (key, level) and nothing else. The key is deliverable 2's stable key once that output exists; until then
   it is the label from the labelled-line parser, matched exactly against a list in the rules file. The table
   names every label the pinned dist version can emit, with a tier for each level that label can take. There
   is no default tier.
3. A key, or a (key, level) pair, absent from the table → tier-1 "adapter unknown kind" (§5).
4. `--gate` is not part of the lookup. It changes the level of some labels (`pin/session` doctor.ts:301;
   `owner-login` doctor.ts:236, :243, :254, and :1015 fails where :1028 warns), and for `owner-login` it
   also changes the input (verified export at :1013-1016, unsigned store at :1026-1029). So: for a label
   whose level `--gate` alone decides, the table gives WARN and FAIL the same tier, and the mode cannot move
   a finding between tiers. The runner's mode is a required rules-file field (`doctor.gate`, true or false,
   no default; the runner refuses to start without it), chosen at this note's design gate. The selection
   manifest records the mode the run used.
   *Value, 2026-10-05 (design-gate gap, `doctor.gate`):* `digest-rules/1.json` sets `doctor.gate: true`.
   The runner passes `--gate` and never `--local`. Stage 1 refuses a rules file whose `doctor.gate` is
   absent or is not `true`; `false` needs a rules-file version bump and its own design gate. Reasons, all
   at `6190d5f`:
   (a) With `--gate`, delivery, attribution, pin/session, instruct-root, `owner-login`, review routing,
   `model claim absent` and capture coverage are read from the verified signed export plus the
   chain-verified tail (`packages/mcp-server/src/doctor.ts:1008-1023`). Without it, the ones that run come
   from unsigned `/events`, `/why` and history (doctor.ts:499, :1024-1053); instruct-root and capture
   coverage do not run at all. §4 reads ledger facts from a verified export only; gate mode keeps doctor on
   the same footing.
   (b) The merge gate runs `node packages/mcp-server/dist/doctor.js doctor --gate`
   (`.github/workflows/retrace-gate.yml:28`). The digest then reports the levels the gate enforces, not a
   laxer local reading of the same check.
   (c) Without `--gate`, doctor probes the hooks of the checkout it runs in (doctor.ts:932-934) and checks
   the local credential against HEAD's actor (:956). Those describe the runner's host, not the project.
   (d) Without `--local`, capture coverage fails on a lone producer (doctor.ts:177-187), which is the
   reading a provenance digest wants.
   Costs, accepted: gate mode needs `RETRACE_URL` and `RETRACE_TOKEN` or emits FAIL (doctor.ts:874-877,
   :959), and it checks the HEAD of the repository it runs in. The runner runs doctor in a detached
   checkout of reconcile's to-sha (§4 reconcile row) and records that sha with the doctor pin. Under
   `--gate` the levels each label can take are: `owner-login` pass/fail (:236, :243, :254 with gate true; :1015);
   `pin/session` pass/fail (:300-301); `model claim absent` pass/warn (:488, :496); `export-cache` warn
   (:907, read at :980 in both modes). The table still names the WARN of each label whose level `--gate`
   alone sets, at the same tier as its FAIL, so the mode cannot move a finding between tiers if a later
   rules version changes it.

Three labels were added after the `1636bac` snapshot the build brief re-verified, and the table must carry
them: `export-cache` (warn only; doctor.ts:907; `ce04f90`) WARN → tier 4, a stale or failed export cache;
`model claim absent` (pass/warn; doctor.ts:488, :496, :523; `ef41439`, `14d4f11`) WARN → tier 4, the doctor
counterpart of "agent events without model"; `owner-login` (pass/warn/fail; doctor.ts:236, :243, :254,
:1015, :1028; `50340a8`) WARN and FAIL → tier 1 for now. One `owner-login` label carries four cases: a policy
load error (:1015, :1028), a policy history digest mismatch (:236), an incomplete policy history (:243), and
shared-login human seals after /2 adoption (:254). The first three are a source that is inconsistent or
unavailable, which is tier 1; the fourth is attribution, which is tier 2. A (label, level) key cannot tell
them apart, so the label takes the higher tier. When deliverable 2 gives each case its own stable key, the
seal case moves to tier 2 by a rules-file version bump. Source: Omarchy cross-check 2026-10-05, findings L2-3
and L2-4.

**Doctor label table (v1.5, 2026-10-05; design-gate gap, untiered doctor labels).** Step 2 requires a
tier for every label the pinned dist can emit, but the text above tiers only five of them. At `6190d5f`
`packages/mcp-server/src/doctor.ts` emits 37 labels. This table is the stage-1 value of the rules file's
doctor list. A dist version whose label set differs needs a rules-file version bump; until then its new
labels are tier-1 "adapter unknown kind" (step 3). The builder invents no tier.

How each tier was chosen, so a later version extends the table the same way:

- One category per emission site, by what the site checks. Tier 1, integrity/source: the chain, the
  export, the Worker deployment, the Git object store, or a read doctor needs failed. Tier 2,
  identity/credential: who acted, who may act, or which credential speaks for whom. Tier 3, coverage: a
  seal, hook or record that should exist does not. Tier 4, hygiene: stale state and advisory checks,
  including the PR 35 review-routing advisories, which doctor itself calls advisory (doctor.ts:340).
- A label whose sites span categories takes the highest tier among them (lowest number). This is the
  `owner-login` rule above. Only sites reachable under `--gate` count, since `doctor.gate: true` is the
  only mode stage 1 runs. A label or level reachable only without `--gate` still has a row, tiered by its
  own category, so the table names every label.
- Where `--gate` alone sets the level, WARN has the same tier as FAIL (step 4).

| Label | Levels (any mode) | Tier | Sites at `6190d5f` (doctor.ts) and reason |
| --- | --- | --- | --- |
| `object store` | fail | 1 | :32, :44, :80; the checkout's Git objects are unreadable, so Git-range reads are unsafe |
| `repository wiring` | fail | 1 | :925, :927; `.retrace.json` missing or invalid |
| `HEAD` | fail | 1 | :957; the checkout's commit could not be read |
| `deployment` | warn, fail | 1 | :959 (gate alone sets the level; no URL), :969 (Worker `/api` unreachable) |
| `deployment schema` | fail | 1 | :968; the Worker would drop fields |
| `attribution deployment` | warn, fail | 1 | :787 (gate alone sets the level); the Worker predates `attribution-v7` |
| `CLI version` | fail | 1 | :806; the pinned CLI is below the Worker's minimum |
| `ledger integrity` | fail | 1 | :974; `/verify` reports a failed chain |
| `ledger access` | fail | 1 | :975; `/verify` unreachable |
| `issuance` | warn, fail | 1 | :982 (gate alone sets the level); `/status` unreachable |
| `owner-login` | warn, fail | 1 | as above |
| `HEAD delivery` | warn, fail | 1 | :720 (not in the verified ledger, coverage) and :1023 (verified-export read failed, source); highest tier. :191, :194 and :1053 are reachable only without `--gate`; :194 is gate-alone |
| `capture coverage` | warn, fail | 1 | :318 carries the worst live reconcile finding for HEAD, which can be `producer_disagreement` at `fail` or `warn` (`packages/core/src/reconcile.ts:347`, :351-355); :1022 is a read failure; :306 has no commit; highest tier. The reconcile source still tiers each kind on its own (§4) |
| `attribution` | warn, fail | 2 | :272 (gate alone sets the level); a human seal carries agent evidence |
| `pin/session` | warn, fail | 2 | :301 (gate alone sets the level) |
| `instruct root` | fail | 2 | :200, :208, :209 under `--gate`; the commit's causal claim does not reach a human instruction in the verified ledger. :1051 is reachable only without `--gate` |
| `credential` | warn, fail | 2 | :877 under `--gate` (no `RETRACE_TOKEN`); :881 and :892 only without `--gate` |
| `actor authorization` | fail | 2 | :865, :869; only without `--gate` (:956) |
| `shared_actor_id` | fail | 2 | :826; one actor id live on several pinned credentials |
| `principal_conflicts` | warn, fail | 2 | :837 (live), :843 (historical, none live) |
| `principal` | warn | 2 | :851; credentials with no principal |
| `pending seals` | fail | 3 | :161; runs in both modes (:922) |
| `post-commit hook` | fail | 3 | :142, :148; only without `--gate` (:932-934) |
| `post-merge hook` | warn, fail | 3 | :142, :152; only without `--gate` (:932-934) |
| `export-cache` | warn | 4 | as above |
| `model claim absent` | warn | 4 | as above |
| `review routing` | warn | 4 | :394, :398, :442 (PR 35 advisory); :523 and :1031 only without `--gate` |
| `review routing history` | warn | 4 | :347; only without `--gate`, since the gate call passes no scope (:1017), so :346 never holds there |
| `review routing intent` | warn | 4 | :413 |
| `review head mismatch` | warn | 4 | :405 |
| `review agent mismatch` | warn | 4 | :417; routing is intent and the review event is the record of what ran (:340) |
| `review model mismatch` | warn | 4 | :423 |
| `review effort mismatch` | warn | 4 | :427 |
| `review model` | warn | 4 | :443-447 |
| `review reasoning effort` | warn | 4 | :448 |
| `review routing registry` | warn | 4 | :930; an invalid registry only switches off the review advisories (:1017) |
| `local_config_drift` | warn | 4 | :989, :1000, :1004. The :1004 policy read failure is also reported at tier 1 in the same gate run, as `owner-login` FAIL (:1003, :1015), or as `HEAD` FAIL (:957) or `HEAD delivery` FAIL (:1023) when :1015 is not reached, so it does not raise this label |

A (label, level) pair not in the table is tier-1 "adapter unknown kind" (step 3), for example `principal`
FAIL or `export-cache` FAIL. The gate-alone labels, whose WARN and FAIL share a tier, are `HEAD delivery`,
`attribution`, `pin/session`, `owner-login`, `attribution deployment`, `deployment` and `issuance`. The
adapter parses the stdout finding lines (doctor.ts:1058) only. One more labelled line exists: `FAIL
repository` goes to stderr before any finding when the checkout is not a Git repository (:920), and doctor
exits 1. That case, and any run with no `READY`/`NOT READY` summary line on stdout (:1060), yield the
tier-1 "source unavailable" finding for doctor, not a table row.

**Doctor's ledger view (fix round 1, 2026-10-08; Codex r1 C-M3).** Under `--gate`, doctor derives some of its
findings from the verified signed export plus the chain-verified tail it reads (`gateRemoteAuthorization` and
the calls after it, `packages/mcp-server/src/doctor.ts:1008-1023` at `6190d5f`, unchanged at `ce2a78cc`). These are
the **ledger-derived labels**:
- `HEAD delivery`, `attribution`, `pin/session`, `instruct root`, `owner-login`, `capture coverage` and
  `model claim absent`;
- the review-routing labels: `review routing`, `review routing intent`, `review head mismatch`,
  `review agent mismatch`, `review model mismatch`, `review effort mismatch`, `review model` and
  `review reasoning effort`.

Doctor's output names no head for that read (doctor.ts:1058-1060), so these findings had no pin. This design
gives them one:
- **Contract.**
  - Under `--gate`, doctor prints one more line to stdout, after its finding lines and before the summary line:
    `ledger head <seq> <hash>`. It names the head of the chain its ledger-derived labels read.
  - The line has no level, so it is not a finding line, and the doctor label table does not change.
  - Deliverable 2's structured output carries the same pair.
  - This is a §11 prerequisite for the first live run.
- **Use.**
  - The pin is the doctor source's recorded head under the chain-prefix rule (§4). It must lie on the
    reference chain, and the supersession check applies to its tail (§4, doctor row).
  - Output under `--gate` with no such line, or with more than one, leaves the ledger-derived findings
    unpinned. They are then `incomplete`, a tier-1 "snapshot inconsistent" finding names the missing pin, and
    the run is degraded.
  - A pin that is not on the reference chain gets the prefix rule's mismatch outcome.
- **The other labels are external observations.**
  - The rest of the table checks the checkout, the Worker's endpoints, the credential listing or local
    configuration, not ledger events.
  - They are pinned as before (output bytes and hash, dist version, mode, checkout sha). The runner also
    records its clock before and after the doctor run, and the digest renders them as observed during that
    run.
  - They have no ledger head, so the prefix rule and the supersession check do not apply to them, and they
    cannot make a run inconsistent.
  - Their completeness is the doctor source's: complete when doctor printed its summary line, otherwise the
    "source unavailable" finding above.

T4 (ix) and (x) test the pin.

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

**Correction (v1.5, 2026-10-05; L3-7 follow-up, design-gate gap "root check vs §7 order").** The v1.5 §8
root check can fail the run. Placed before freeze but after step 3, it would leave a `report.md` that
describes a clean digest under an envelope that says `failed`. The six steps stay as written, with step 1
read as follows. Step 1 begins with the **root check** (§8). It runs after the run-start ledger reads, so
the run's start export head exists, and before the selection manifest is written. The root event bytes
it reads, or the read's error, are retained under `inputs/*`, so step 1 stays a pure function of the
retained inputs, the clock and the rules (T10). The selection manifest records the envelope `timestamp`,
the configured root id or its absence, the check's result (`ok`, `not_configured`, or the problem and
whether the configured option accepts it), and the run's outcome (`digest`, `degraded` or `failed`). In
step 2 the renderer states that outcome and the root-check result in `report.md`'s header; a
`caused_by_problem` failure is stated with its problem and the root id. Step 5 copies the outcome,
`timestamp` and `caused_by` from the selection manifest into the envelope. It decides nothing. In stage 1,
which has no model, no step after step 1 changes the outcome. Stage 1.1's model failure degrades the run
after the manifest exists (§10); placing that outcome change in this order is part of stage 1.1's design,
not stage 1's. The order is still six steps; §8's "pre-freeze root check" means this
point in step 1.

## 8. One terminal event per run, frozen before publication, and the writer

**Run id:** a UUIDv7 generated at run start and persisted in the selection manifest; the idempotency key
is `digest:<project>:<run id>`; two concurrent runs for one project therefore never share a key
(Nemotron 7; T7).

The runner is the only component that holds the seat's credential and producer key. Before the first
publication attempt it **freezes the terminal envelope**: `action: other`, `tags: ["digest"]`,
`action_detail: "digest"`, `method.tool: "retrace-ai"`, `method.params.outcome ∈ {digest, degraded, failed}`,
`caused_by` (the run's causal root, its project's standing instruction: decided by Jordan on 2026-10-06,
below; added v1.5), `timestamp` (the run's evaluation clock, set
once at run start and recorded in the selection manifest, §7 step 1; added v1.5), the idempotency key, artifacts: selection manifest, publication artifact and `report.md` as
`generated` (their sha256 values in `method.params.artifact_sha256`, below), every ledger event cited in
the selection manifest as `used`, the rules digests and the adapter-table version. Every retry publishes
**exactly the frozen envelope**; publication-error state is kept beside it and never rewrites the outcome
(an attempted `digest` is never converted into `failed`). A response lost after a successful seal is
recovered by the idempotency key. After any successful publication the runner **re-reads the sealed
event by id and asserts full payload equality** with the frozen envelope, not only hashes (Nemotron 12;
T7): a runtime guard, because the store's idempotency path returns the existing event without comparing
payloads (§11). If the ledger is unreadable at run start, the run is `failed` with the reason; if it is
unwritable at publication, the frozen envelope waits locally and is published, unchanged, on the next run.
A run never has two terminal events.

**Correction (v1.5, 2026-10-05; source: cross-check finding L3-3, verified at `6190d5f`): what "full
payload equality" covers.** The sentence above stays as written. Read literally, it fails on every
successful run, because the Worker owns part of every sealed event. The equality covers the
producer-signed payload, not the stored event. Exactly:

- **Signature format: `retrace-producer-sig/2`.** The compared set depends on the format
  (`reservedMethodParams`, `packages/core/src/producer-sig.ts:83-85`). `signProducer` defaults to /1
  (`producer-sig.ts:370-377`), so the runner passes `{ format: "retrace-producer-sig/2" }` explicitly.
  Under /1, `claim_decision` and `producer_signed_actor` would be signed params kept as submitted
  (`router.ts:839-844`); under /2 they are Worker stamps. The sets below are the /2 sets.
- **Compared (the runner owns these).** `producerSignedPayload(sealed)` deep-equals
  `producerSignedPayload(frozen)` (`packages/core/src/producer-sig.ts:128-144`). That payload is `v`,
  `project`, `actor.{type, id, on_behalf_of}`, `action`, `action_detail`, `artifacts`, `change`,
  `timestamp`, `duration_ms`, `intent`, `caused_by`, `idempotency_key`, `tags` minus any `caused_by:` tag,
  `method` minus the reserved params, and `location` minus `client`. The frozen envelope is signed with
  the seat's producer key (the runner already holds it, above). The sealed `producer_sig` equals the
  frozen one, and the sealed `method.params.producer_sig_verdict` is `verified`.
- **Not compared (the Worker owns these).** `method.params.sealed_by` and `producer_sig_verdict`: client
  copies stripped, then stamped (`packages/core/src/router.ts:834-838`, `:917-922`). `relayed_by`:
  stripped (`:836`), stamped on relayed writes (`:926-927`). `claim_decision` and
  `producer_signed_actor`: stripped for unsigned and /2 events (`:839-844`). `producer_signed_actor` is
  stamped on a verified /2 signature (`:869-870`). `claim_decision` is stamped only on the shadow-trailer
  path for git commit seals (`:885-900`), which a digest envelope never takes. `caused_by_problem` and a
  `caused_by:` tag: added by `appendEvent` when a cited parent fails its check
  (`packages/core/src/store.ts:1047-1053`). `location.client`: dropped unless relayed (`router.ts:916`).
  `actor.model`, `model_source`, `model_claims`: may be rewritten by a credential pin
  (`router.ts:392-411`). The seal fields `id`, `seq`, `prev_hash`, `hash`, `hash_v`, `received_at`
  (`packages/core/src/chain.ts:84-94`). The method-param part of this list is
  `RESERVED_METHOD_PARAMS_V2` (`producer-sig.ts:66-81`). The runner imports that constant and
  `producerSignedPayload`; it does not restate them.
- **The frozen envelope carries its own `timestamp`.** It is the run's evaluation clock, the one value
  set once at run start and recorded in the selection manifest (§7 step 1); the root check below and the
  freeze both use that value, and nothing sets it again. If it is absent, the seal fills it
  with `received_at` (`chain.ts:88`), and the signed payload of the sealed event would differ from the
  frozen one on every run. `signProducer` already refuses an envelope without `timestamp`
  (`producer-sig.ts:378`); the runner relies on that refusal and does not sign by other means.

This is still the guard §11 names. `appendEvent` returns an existing event for the key without comparing
it (`store.ts:1054-1060`). Anyone holding the seat credential can append (threat model, above), so an
event another writer sealed under the same key may carry the same `actor.id`. It differs in the signed
payload or in `producer_sig`, and the comparison above catches it. What the runner does when the
comparison fails is a separate v1.5 item (L4-F9). The envelope cites a `caused_by` (L3-7;
decided 2026-10-06, below), so `caused_by` is inside the compared payload and a `caused_by_problem` stamp is
outside it.

**OPEN QUESTION FOR JORDAN (credential scope, rule 16):** is the `retrace-ai` credential minted with
`require_signature`? (a) Yes: the Worker refuses an unsigned or badly signed envelope with 401
(`router.ts:866-868`), before any seal. (b) No: the `verified` verdict check above is the only place a
missing or bad signature is caught, after the seal. The equality rule is the same either way.

**When the re-read does not match** (correction 2026-10-05, v1.5; crosscheck L3-4, L4-F9). The store
dedupes on (project, idempotency key) alone: it returns whatever event already holds the key, whoever
wrote it, without comparing actor or payload, and the POST answers 200 with `deduped: true`
(`packages/core/src/store.ts:1054-1059`, `packages/core/src/router.ts:931`). The `digest:` prefix is not
reserved the way `git:`, `gd:`, `gh:` and `policy:` are (`store.ts:924-946`). So the re-read can return a
**foreign** event (another actor's) or a **different** one (the seat's, not equal to the frozen envelope).
Equality is the L3-3 correction above: the producer-signed payload, an equal `producer_sig` and a
`verified` verdict. That set excludes the annotations the Worker strips and stamps on every seal
(`sealed_by`, `producer_sig_verdict` and the others L3-3 lists; `router.ts:834-844`, `:916-922`), or every
successful run would land here. In either case:
- this run's `method.params.outcome` is not rewritten; the frozen envelope stays as frozen;
- the runner does not republish, under that key or any other: the key is part of the frozen envelope, and
  every retry would dedupe to the same event;
- the publication state beside the frozen envelope records `terminal mismatch`, with the returned event's
  id, seq and actor and the fields that differ within that set; this record survives a crash, and the
  retained envelope is marked so the next run's unwritable-ledger path does not publish it;
- the runner exits non-zero;
- the next run renders a mandatory tier-1 "terminal event mismatch" finding citing the returned event and
  the frozen envelope's hash.
That run then has no terminal event of its own in the ledger. The finding says so; it is never silent.
The seat audit below counts this case as stated there. The UUIDv7 run id makes planting the key in
advance impractical; the finding states what was observed and does not guess a cause. Reserving `digest:`
server-side would be defence in depth, not a stage-1 control: reservations check only fields the writer
declares (`action`, `method.tool`, `tags`; `store.ts:921`, `:932`; `policy:` is refused outright,
`:943-944`), so they would not stop a holder of the seat's credential. Whether to queue it is an OPEN
QUESTION FOR JORDAN, with its options, in §11.

**Where the hashes live (v1.5, 2026-10-05; finding L3-5).** v1.4 read "`report.md` as `generated` with
sha256" and "rules and adapter digests", and named no field for either. `ArtifactRef` has no hash field:
it holds only `id`, `kind`, `label`, `derived_from` and `role` (`packages/core/src/schema.ts:146-155` at
`6190d5f`). Stage 1 makes no schema change. The three `generated` artifacts are exactly these files in
the run's artifacts directory: `selection-manifest.json` (the selection manifest, §7 step 3), `report.md`
(§7 step 3) and `publication.json` (the publication artifact, §7 step 4). `inputs/*` are not `generated`
artifacts; their hashes are in the publication artifact (T6). Each artifact id is
`digest:<project>:<run id>/<file name>`. The sha256 values live in `method.params.artifact_sha256`: an
object whose keys are exactly those three ids, each value the lowercase hex sha256 of the exact bytes
written. The rules digests are `method.params.rules_sha256`: an object keyed by the repo-relative path of
each rules file, each value that file's sha256. In stage 1 its only key is `digest-rules/1.json` (§6). The
adapter table lives in that file (§6), so that digest covers it; the envelope also carries
`method.params.adapter_table_version`, the version §7 step 1 records. `MethodParams` accepts extra keys
(`schema.ts:218-223`). `method` is inside the producer-signed payload except the server's stamp keys
(`producer-sig.ts:11-16`). The GitHub adapter already carries sha256 values under
`method.params.github_payload` (`github.ts:84-85`, placed in `method.params` at `:94`). Not used:
`change.after_hash` holds one value, not three (`schema.ts:184`); a hash inside the artifact id would make
the id differ per content and break lookup by run id. The envelope validator (T9a) refuses an envelope
whose `artifact_sha256` keys differ from its `generated` ids. T6 checks each value against the retained
file.

**What `action_detail` holds (v1.5, 2026-10-05; finding L3-5).** Always the literal `"digest"`; v1.4 gave
none. The schema documents `other` as requiring `action_detail` (`schema.ts:66`), but that is a comment:
`schema.ts:241` makes the field optional and nothing enforces it. The runner's validator does. The value
must never be `"amended"`: the store indexes `action: other` with `action_detail: "amended"` as amendment
candidates (`store.ts:720`), and `amendment.ts:26` and `attribution.ts:56` read that pair as an amendment.

**Causal root (added v1.5, 2026-10-05; cross-check of `6190d5f`, finding L3-7).** Agent-rules 1-2
(`docs/agent-rules.md:18-23`) root every act in a Jordan instruction through `caused_by`. Through v1.4 the
envelope above carried no `caused_by`, and no document named the instruction a scheduled or on-demand
run descends from: §12 gives cadence only. `evt_42add0579bc94fb6a99c8714e3ae0099` is the instruction to
write the build brief. It is not a cadence instruction.

What the store does with the field at `6190d5f`. `appendEvent` reads the claimed parent
(`packages/core/src/store.ts:1047-1053`). `causedByProblem` (:890-899) reports `missing` if the parent is
absent, `wrong_project` if it is in another project, and `not_older` if the event carries a timestamp and
the parent is newer than it (:897; `EventInput.timestamp` is optional, `schema.ts:244`). The store does not
refuse such an append. It seals the event with the tag `caused_by:unverified` and
`method.params.caused_by_problem` added (`markCausedByUnverified`, :912-919). A valid parent is sealed with
no `caused_by` stamp. `status` counts stamped events as `unverified_links` (`status.ts:172`). Both stamps
are in the server's reserved annotation surface (`producer-sig.ts:66-67`), so they do not by themselves
break T7's re-read: the L3-3 correction above compares the producer-signed payload, which excludes that
surface.

**Pre-freeze root check (added v1.5).** *Revised 2026-10-06, with the root decided (below):* every run has
a root. Each covered project's standing instruction id is a required field of the runner's configuration, and
a configuration without it fails validation at load, before any ledger read, as the `sealed_by` value does
(below). The runner reads the root at the run's start export head and applies the store's three tests itself:
present, in the run's project, not newer than the envelope `timestamp` (the evaluation clock, above). It
runs at the start of §7 step 1, before the selection manifest and `report.md` are written, and its result
and the outcome are recorded in both (§7 correction). A problem
the configured option does not accept makes the run `failed`, with reason `caused_by_problem: <problem>`.
The envelope is still frozen carrying the configured id, so the sealed event keeps its claimed root and
the store stamps it; no run under a configured root is sealed without `caused_by`. The reason for the
check is its own, not T7: a stamped link is an unverified link, and a run whose root is unverified must
say so in its outcome rather than seal as a clean `digest`. The event and its key are per project
(`digest:<project>:<run id>`), so a root outside the run's project is `wrong_project` under the store's
rule (:895-896).

**The causal root of scheduled and on-demand runs: decided (Jordan, 2026-10-06,
`evt_40d1e828ec654a2f96bd945453d86136`): a standing instruction in each covered project, option (A) with
(A1).** Every run, scheduled or on demand, cites its project's standing instruction as `caused_by`, and the
root check accepts no problem. The runner takes no `--caused-by` argument and refuses one at start. Which event
is each project's standing instruction stays open until the first live run; Jordan issues or designates it.
The options the draft laid out stay below for review. Only (A) with (A1) is live; the A2, A3 and B branches
are not built.
- **(A) A standing instruction in each covered project.** Jordan issues, or designates, an instruction in
  each project the seat covers that authorises the daily and on-demand digest. Every run's envelope cites
  its project's one as `caused_by`; the root check accepts no problem. Sub-choice for on-demand runs: (A1)
  always the standing id; (A2) the invoking instruction when an on-demand run is started under one in the
  same project, the standing id otherwise.
  *Added 2026-10-05 (critic pass; mechanism only, the choice stays Jordan's):* under A2 the invoking
  instruction reaches the runner as one argument, `retrace digest --caused-by <event id>`. The root check
  applies to it unchanged, and the manifest records whether the root came from the argument or the
  configuration. Under A1, A3 and B the runner refuses the argument at start.
- **(A3) One standing instruction for all covered projects.** A single instruction is cited by runs in
  every project. The store keeps the link and stamps every run outside the instruction's project
  `wrong_project` (store.ts:1052-1053 keeps, not refuses). The root check accepts `wrong_project` only.
  Cost: every such run counts in `status` `unverified_links` (`status.ts:172`), mixed with genuinely broken
  links, and is not counted as rooted.
- **(B) Excluded from causal coverage.** No root is configured; the envelope carries no `caused_by`. Rule 2
  states no exception today, so the exclusion would be written where the rules are (a class (a) change),
  and any causal coverage count must list these events as excluded rather than count them as gaps or as
  covered.

**Withdrawal of a standing instruction (fix round 1, 2026-10-08; Codex r1 C-M2).** A ledger instruction cannot be
removed, so a withdrawn one still passes the root check's three tests. Those tests establish a structurally valid
causal link, not continuing authorization. The runner's authorization for a project is therefore its
configuration, not the ledger: a project runs only while the configuration names a standing instruction for it.
- **Procedure.**
  - Jordan withdraws the digest for a project with a signed instruction (owner-protocol).
  - The configuration is then changed on the host that holds the seat's credential, by Jordan or by a seat acting
    on that instruction. The change is recorded as an event caused by it.
  - Removing the project's root is the stop. A configuration without it fails validation at load, before any
    ledger read (above), so no scheduled or on-demand run starts.
  - Replacing the root withdraws the old one and designates the new one.
  - Revoking the `retrace-ai` credential, which is Jordan's to do (§11), stops every project at once. It is the
    stop to use when the runner's host is not trusted.
- **Publication state** (fix round 2, Codex r2 C-M2). A frozen envelope's publication state is `unattempted`,
  `attempted` or `published`, or one of the outcomes `terminal mismatch`, `withdrawn` and `unknown`.
  - The runner writes `attempted` durably before it sends the first POST. A crash, or a response lost after
    sending, therefore leaves `attempted`, never `unattempted`.
  - It writes `published` only after the T7 re-read and equality check.
  - Every state survives a crash, as `terminal mismatch` does.
- **Checked again at publication.**
  - The runner reads the configuration again immediately before every publication attempt: this run's envelope
    at §7 step 6, and each retained envelope it would publish on the unwritable-ledger path above.
  - An envelope is published only if the configuration still names, for its project, the root the envelope cites
    as `caused_by`.
  - Otherwise no POST is ever sent for it again. A POST would dedupe to an existing event, but it would also
    seal the envelope if none exists, and that is a write the configuration no longer authorizes. What follows
    depends on the state:
    - `unattempted`: the runner never sent it, so it is not published. It is marked `withdrawn`.
    - `attempted`: the outcome is not known yet, and the runner resolves it read-only before it classifies
      anything. It looks for an event under the envelope's idempotency key in a verified read with proven
      coverage, from the start head of the envelope's run to the current head. The read is a fresh full
      export or the paged history walk, by the same methods and coverage rules as the seat audit below. The
      remote store's `byIdempotencyKey()` returns `null` (`packages/mcp-server/src/remote-store.ts:119-121` at
      `ce2a78cc`), so it is not that read. Then:
      - An event under the key passes the T7 equality check. The envelope was published: its state becomes
        `published`, the run has its terminal event, and nothing is withheld.
      - An event under the key fails the check. The `terminal mismatch` path above applies.
      - No event is under the key, even with coverage proven. The state becomes `unknown`, a provisional absence
        (revised in fix round 3, Codex r3 C-M2). The absence holds only through the read's head. A POST sent
        earlier may still seal after it: the Worker awaits the append inside that request (`router.ts:928-936`,
        `store.ts:1047-1065`, at `ce2a78cc`), and a separate read neither waits for it nor cancels it.
      - Coverage is not proven (a read error, a walk still truncated, a cached export). The state becomes
        `unknown` too.

      An `unknown` envelope settles only positively. A later read that finds an event under its key applies the
      two checks above: equal means `published`; different means the mismatch path. Absence never settles it. The
      runner never claims the envelope is absent and never sends it. Each later run tries the read-only resolution
      again. Only an `unattempted` envelope, which was never sent, becomes `withdrawn`. **OPEN QUESTION FOR JORDAN**
      (fix round 3): whether, and how, an owner decision may close an `unknown` envelope that never settles. This
      note does not decide it.
  - A change that lands after the configuration read cannot stop that one attempt. Every later attempt reads the
    configuration again.
- **Reported.**
  - The next run of that project, under a new root, renders a mandatory tier-3 "terminal event withheld" finding
    for each `withdrawn` envelope. The finding cites the run id and the envelope's hash.
  - For each `unknown` envelope, the next run renders a mandatory tier-1 "terminal event unknown" finding. It cites
    the run id, the envelope's hash and the last read attempted. A run that settles the state reports the
    settled outcome instead.
  - When the project has no new root there is no next run. The record of the configuration change then lists the
    `withdrawn` and `unknown` run ids, and an `unknown` envelope is resolved the same read-only way before that
    record is written.
  - A withheld run has no terminal event. T7's "exactly one" has this exception, as it has the mismatch case. An
    `unknown` run is stated as unknown, never as missing.
- **What stays.** Runs published under the withdrawn root stay rooted in it. That is true: they were authorized
  when they ran. The runner never reads the ledger to decide authorization.

T7 tests it.

Which projects "each covered project" means depends on the credential's project scope, which Jordan
sets at the mint (§11). **OPEN QUESTION FOR JORDAN:** which projects does the `retrace-ai` credential
cover? The root is decided (above); the scope fixes which projects need a standing instruction. This note presupposes no scope. The builder does not pick (build brief
§2: open questions are raised, not invented). The answer fixes T7's root fixtures. It does not change the
start conditions in build brief §7, which stay Jordan's.

**Enforcement, stated honestly:** today no credential can restrict *what* an actor may write;
`allowed_actors` constrains who, and `POST /events` is a general append. Stage 1 therefore relies on the
trusted writer: a small program whose only network call is that one POST with a schema-validated
envelope. **Threat model, stated:** the seat's credential is a write-capable credential until server-side
restrictions exist; whoever holds it can append arbitrary events. Stage 1 detects rather than prevents:
after publication the runner lists every event by the seat's actor within the run window (from the run's
start export head to the head observed after publication) and asserts exactly one, its own.
**The audit must prove it read the whole window** (correction 2026-10-05, v1.5; crosscheck L3-9). The
window is the seq range (start head seq, post-publication head seq], and the post-publication head is at
or above the sealed event's seq. "The seat's events" are selected by the three keys of the L3-2
correction below (actor id, `method.params.sealed_by`, `method.params.relayed_by`). They apply
whatever the mint: Jordan decided the seat carries no `on_behalf_of` (§11), and the keys still catch a
credential minted the default way by mistake. `GET /projects/:p/events` filters by actor only through `actor_id`
(its other filters are artifact, actor type, action, time and text; it has no `sealed_by` or `relayed_by`
parameter) and has no lower seq bound: each call returns the newest `limit` matches (default 100), ascending, with
`truncated` and `next_before_seq` (`packages/core/src/router.ts:1020-1039`;
`packages/core/src/store.ts:25-50`). Either method is acceptable. (1) Paged history: the first call
passes `before_seq` = post-publication head seq + 1, and the walk follows `next_before_seq`; coverage is
complete only when a page returns `truncated: false` or a page's oldest seq is at or below the start head
seq. The `sealed_by` and `relayed_by` keys cannot be filtered on this route, so the walk pages with no
`actor_id` filter and the runner applies the three keys itself. (2) A fresh full export (`fresh=1`, never the cache: without `fresh`, a cached bundle that
is only a prefix of the live chain is still served; `router.ts:433`, `:464-476`, `:1041-1050`). The
bundle records no head seq: beside the verify fields, `chain` holds `head_hash` and `total_events`
(`packages/core/src/export.ts:27`, `:70`). Its head is its last event, whose hash must equal
`chain.head_hash`, and that event's seq must be at or above the post-publication head seq. The export is
filtered by the seat selector and the seq range. Events outside the range are discarded, not counted.
The local audit record keeps the method and its coverage evidence: each page's `before_seq`, `limit`,
`truncated` and seq span, or the export's last event (seq, hash) and `chain.head_hash`. An audit that
cannot show coverage — a page still `truncated` when the walk stops, a page cap, a read error, a cached
export — is **incomplete**, never passed. It does not change this run's outcome; the next run renders a
mandatory tier-1 "seat audit incomplete" finding citing the window and the last page read.
**What the audit expects** (same correction). The expected seat events in the window are this run's own
terminal event, identified by the id the re-read returned, plus each earlier run's retained envelope that
this run published, identified by the ids in the publication state. Anything else is "seat wrote outside
its envelope". In the mismatch case above, this run has no own event to expect: the missing event is
reported by the "terminal event mismatch" finding, not by a second finding; a seat event the re-read
returned is cited by that finding and not counted again; any other seat event is still reported. **This run's
outcome is never changed by that audit** — the envelope is frozen and sealed by then (T7). Any other
event by the seat is recorded in the run's local audit record and becomes a mandatory tier-1 "seat wrote
outside its envelope" finding in the **next** run, citing both events (Nemotron 1; last review 5206011343;
T9b). The hourly NOOA audit is asked to add the
same check (§11). **Server-enforced per-credential action/tag restrictions are a prerequisite for stage
2 and a queued design item** (§11); until they exist the seat's authority is "trusted writer + audit",
not "cannot". `retrace-admin` must learn a `retrace-ai` harness entry (§11).

*Correction 2026-10-05 (agent-rules 10), source: retrace-ai cross-check finding L3-2, at `6190d5f`. The
v1.4 text above stays as written; this paragraph narrows it.* "Every event by the seat's actor" is not
enough. The audit counts an event as **by the seat** when it matches **any** of three keys: actor id
`retrace-ai`; `method.params.sealed_by` equal to the value on the runner's own sealed event as re-read
under T7 (`pinned:<credential name>`, `packages/core/src/router.ts:294-299`); or
`method.params.relayed_by` equal to `retrace-ai` (router.ts:926-927). The server sets both params and
strips client values (`producer-sig.ts:67`, router.ts:836-837), so they are trustworthy keys. Why the
actor key alone fails: a pinned agent credential that carries `actor.on_behalf_of` may seal
`action: instructed` events whose actor is that human, not the seat (router.ts:347-364). An audit keyed
on actor never sees them. `GET /projects/:p/events` filters on `actor_id` and has no `sealed_by`
parameter (router.ts:1028-1039). Its `text` filter is a substring match over the whole serialised event
(`packages/core/src/store.ts:18-24`), not an exact key. So the runner reads every event in the window
and compares the three keys itself. That is a design choice for exactness, not something the route
forces. Jordan decided on 2026-10-06 that the credential carries no `on_behalf_of` (§11); the three keys stay, for
the reason above.

*Correction 2026-10-05 (agent-rules 10), source: v1.5 design-gate gap "`sealed_by` key in the terminal
mismatch case". The L3-2 paragraph above stays; this one fixes where its `sealed_by` value comes from.*
"The value on the runner's own sealed event as re-read under T7" does not exist in the mismatch case
above: the re-read returned a foreign event, whose `sealed_by` is another credential's, or a different
one. The audit's `sealed_by` key is therefore the **configured expected value**, `pinned:<credential
name>`, a required field of the runner's configuration. The credential name is fixed at the mint, which is
Jordan's (§11; open question there). This note does not choose it. The configured value is the full
string the Worker stamps, compared exactly: `pinned:<name>` for a named pinned credential, and
`pinned:<actor type>/<actor id>` if the credential has no name (`packages/core/src/router.ts:294-299`).
- **Missing value.** A runner configuration without the field fails validation at load, before any
  ledger read, write or publication. The runner exits non-zero. No run id is minted, so §7's six steps do
  not start and are unchanged.
- **Re-read matches (the normal case).** The equality set excludes `sealed_by` (L3-3 above), so the match
  does not check it. The runner compares the re-read event's `sealed_by` with the configured value. Equal:
  the audit keys on that one value. Not equal: the audit keys on both values, never on the re-read value
  alone. The local audit record keeps both. The next run renders a mandatory tier-1 "seat key mismatch"
  finding citing the configured value, the observed value and the event id. This run's outcome is not
  changed (frozen and sealed, T7).
- **Re-read does not match (the mismatch case above).** The audit keys on the configured value only. The
  returned event's `sealed_by` is never a key: a foreign event's value would select another credential's
  events and miss the seat's. The `terminal mismatch` record keeps the returned event's `sealed_by` as
  evidence, and the "terminal event mismatch" finding cites it. A returned event that carries the
  configured value is the seat's and is counted as stated in "What the audit expects".
The NOOA check (§11) is configured with the same value, so both audits key on one source.

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
  degraded, never silently passed. *Correction, 2026-10-06 (v1.5; claude-code; §4 chain-prefix rule):* "two
  ledger-backed sources under different heads" in the sentence above now trips only when the heads do not
  lie on one chain; the sentence stays as written. *v1.5:* status and reconcile are pinned by bracket
  intervals (§4). Cases, all against an injected store, because the race cannot be forced against a live
  Worker (cross-check finding L4-F8): (i) positive: a store that appends between every pair of reads, so
  status, reconcile, the follow-up export and the NOOA read each see a different head, all on one chain →
  no "snapshot inconsistent", and each finding cites its own head; a runner that degrades this run fails
  the case. (ii) Must trip: a store that serves one source a head whose hash differs from the reference
  chain's event at that seq (a fork) → that source's findings `incomplete`, a tier-1 "snapshot
  inconsistent" citing both hashes, run degraded. (iii) Must trip: status counts outside the bracket
  interval, or a reconcile `range.head_seq` outside its bracket → the same result for that source; a
  runner that pins status or reconcile without the bracket fails this case. (iv) Must trip: a bracket end
  that is not on the reference chain. T4 joins the build brief's list of tests that need a negative case.
  *Correction, 2026-10-08 (fix round 1; Codex r1 C-M1, C-M3; §4 supersession, §6 doctor's ledger view).* In case
  (i), the appended events match no supersession row, and none lands after the doctor read. The cases below
  cover the rest.
  - (v) Intra-run acknowledgement. After the reconcile bracket and before the reference chain, the store appends
    a `correction`-tagged event that names the commit of a selected `misattributed` finding.
    - Expected: the runner re-reads reconcile, and the re-read reports the finding acknowledged. The run selects
      the tier-4 `reconcile.acknowledged` finding, not the tier-2 one, and is not degraded.
    - Variant that must trip: the store appends a second matching event after the re-read's bracket. The finding
      is then `incomplete`, cites that event, and the run is degraded.
    - A runner that renders the tier-2 finding with neither the second read's result nor the `incomplete` mark
      fails both.
  - (vi) Intra-run amendment. The same as (v), with an effective attribution amendment.
    - Expected: the re-read reports `amended`, no finding is selected, and the amended count rises.
    - The variant that must trip is the same as in (v).
  - (vii) Harmless appends. Twenty events are appended after the reconcile bracket and before the doctor read:
    edit events on other paths, CI `executed` events that name commits in the range, and a `review` verdict.
    - Expected: no second read, no `incomplete` finding, and the run is not degraded.
    - A runner that re-reads or degrades fails the case.
  - (viii) Doctor. One event is appended after the doctor read.
    - Expected: doctor is run again, last.
    - Must trip: one more event appended after the second run leaves doctor's ledger-derived findings
      `incomplete`, and the run is degraded.
  - (ix) Doctor's pin missing. The `--gate` output has no `ledger head` line, or has two.
    - Must trip: doctor's ledger-derived findings are `incomplete`, a tier-1 "snapshot inconsistent" finding
      names the missing pin, and the run is degraded.
    - The external-observation labels are tiered as before.
  - (x) Doctor's pin off the reference chain: a hash that is not the chain's event hash at that seq.
    - Must trip: the result of case (ii), for doctor's ledger-derived findings only.
  *Added in fix round 2 (2026-10-08; Codex r2 C-M1):*
  - (v-b), (vi-b) Inside the bracket. Cases (v) and (vi) are run again with the event inside the bracket:
    - `H1` = 100, reconcile reads through seq 100 and reports the unacknowledged finding;
    - the acknowledgement, or the amendment, seals at 101;
    - `H2` = 101, which is also the reference head.

    Expected: the tail (100, 101] holds the event, reconcile is read again, and the result is that of (v) or (vi).
    A runner that starts the tail after `H2` fails the case.
  - (xi) Out-of-range predecessor. The fixture's events:
    - commit B lies before the saved Git watermark;
    - an edit of `x` at seq 5;
    - B's restricted hook witness at 10, with its configured stamp;
    - the in-range commit A, which changes `x`, sealed at 20;
    - reconcile reads through 30;
    - a webhook seal for B that matches the witness lands at 31, before the reference chain.

    Expected: the reconcile row matches the webhook seal (any commit), reconcile is read again, and A's coverage
    is recomputed without edit 5. A runner whose row matches only seals that name A fails the case.
  - Case (vii) still holds: its edit events, CI runs and review verdict match no row.
  *Added in fix round 3 (2026-10-08; Codex r3 C-M1):*
  - (xii) A late edit with an expired alias. The fixture:
    - the policy maps alias `old` through seq 100;
    - reconcile reads through 100, its attribution context loads, and an amendment applies;
    - an ordinary `edited` event at 101 names `repo:old#x`.

    Expected:
    - no row matches, so there is no second read;
    - the reconcile findings and the attribution state are rendered as of seq 100 and stay complete;
    - no bullet or header line states them as current.

    A runner whose report claims them current fails the case. Truth-tracking: the next run's reconcile read
    includes seq 101, so its attribution state is `unavailable`, with the tier-1 finding (§4).
- **T5 negative findings cite observations.** A missing seal and an unavailable source produce findings
  whose evidence is a retained observation with hash and scope; no ledger id is required or invented.
- **T6 publication artifact binds bytes.** It lists the hashes of `inputs/*`, the selection manifest and
  `report.md`; the sealed event's `used` set equals the selection manifest's cited event ids. (v1.5,
  L3-5) Each `method.params.artifact_sha256` value equals the sha256 of the retained file it names (§8);
  a fixture with one byte changed in a retained file after the envelope is frozen fails.
Failure and publication
- **T7 one frozen terminal event.** Crash between writing files and sealing → next run publishes the
  retained envelope once, unchanged; response lost after seal → retry finds the sealed event by key and
  asserts full payload equality; two concurrent runs → two run ids, two keys; ledger unreadable at start
  → `failed` with reason; ledger unwritable at publish → frozen envelope published next run. Exactly one
  terminal event per run id in every case. Root check (added v1.5, §8): with a root configured, a fixture
  root that is absent, in another project, or newer than the envelope timestamp → `failed` with reason
  `caused_by_problem: <problem>`, the envelope still carries the configured id, and the sealed event bears
  the `caused_by:unverified` stamp; *revised 2026-10-06, root decided (§8):* the live branch is (A1),
  a standing root per project, so no problem is accepted; a configuration without the project's standing
  root fails at load, before any ledger read; a `--caused-by` argument is refused at start. The A2, A3 and
  B fixtures are not built. In each root-check fixture (§7 correction), the selection manifest and the
  `report.md` header state the same outcome and root-check result as the sealed envelope's
  `method.params.outcome`, and the envelope `timestamp` equals the manifest's evaluation clock. Negative
  case that trips: a runner that checks the root after writing `report.md`, so a `failed` envelope sits
  beside a report with no failure.
  **Correction (v1.5, 2026-10-05; L3-3):** "full payload equality" is the producer-signed payload
  equality §8 defines under `retrace-producer-sig/2`, plus equal `producer_sig` and a `verified` verdict.
  Worker-owned stamps are excluded. The re-read is tested against an event sealed through the real
  `POST /events` path, so the stamps are present. Positive case: the run passes with `sealed_by`,
  `producer_sig_verdict`, `producer_signed_actor` and the seal fields present. A whole-event comparison
  fails this case; that is why it is not the check. Negative cases that trip: an event already sealed
  under the run's key with another `actor.id`; one with the same `actor.id` but a changed artifact hash;
  one with an equal body but a different `producer_sig`; a sealed event whose verdict is not `verified`;
  an envelope signed under /1 (the format pin fails); an envelope frozen without `timestamp`, which
  `signProducer` refuses before publication.
  *Correction 2026-10-05 (v1.5; L3-4, L4-F9; §8):* one more case, and one exception. Key already held by
  a foreign or different event (negative cases: a store fake returns another actor's event, then the
  seat's event with one compared field changed; positive control: only Worker-stamped annotations differ,
  and the run passes) → no republish, outcome unchanged, `terminal mismatch` recorded locally and
  surviving a crash, the retained envelope never published, non-zero exit, tier-1 "terminal event
  mismatch" in the next run. In that case the run has no terminal event and the finding says so;
  "exactly one" holds in every other case.
  *Correction, 2026-10-08 (fix round 1; Codex r1 C-M2; §8 withdrawal):* withdrawal and pending publication.
  - (a) The configuration no longer names the project's standing root.
    - Expected: refused at load, and nothing is read or published (the existing case).
    - If the root was replaced instead, the run cites the new id, and the root check runs on it.
  - (b) The configuration changes between §7 step 5 and step 6.
    - Expected: the frozen envelope is not published, and its publication state records `withdrawn`.
    - The state survives a crash, and no later run publishes the envelope.
    - The next run under a new root renders the tier-3 "terminal event withheld" finding, citing the run id and
      the envelope hash.
  - (c) The ledger is unwritable at publication, so the envelope waits (the existing case). The root is then
    withdrawn and a new one configured.
    - Expected (revised in fix round 3): the next run sends no POST and resolves the envelope read-only.
    - Its POST was sent, so it is `attempted`. With no event under the key, its state is `unknown`, and the run
      renders the tier-1 "terminal event unknown" finding, not "withheld".
    - A later read that finds the event settles it, as in (d).
  - A runner that publishes either envelope fails the case. "Exactly one terminal event per run id" has this
    exception, as it has the mismatch case.
  - (d) *Added in fix round 2 (2026-10-08; Codex r2 C-M2).* A lost response, then withdrawal. The Worker seals
    the frozen envelope, its response is lost, and the state stays `attempted`. Then the root is replaced.
    - Expected: the next run sends no POST. It finds the event under the key in a verified read with proven
      coverage, the equality check passes, and the state becomes `published`. No "terminal event withheld"
      finding is rendered.
    - Must trip: a fake whose read cannot prove coverage (a walk still truncated). The state becomes `unknown`,
      a tier-1 "terminal event unknown" finding is rendered, and nothing claims the event is absent.
    - Must trip: an event under the key that differs in a compared field. The `terminal mismatch` path applies.
    - Must trip (fix round 3, Codex r3 C-M2): the earlier POST seals after the covered recovery read.
      - At the read the state is `unknown`, never `withdrawn`.
      - The next run's read finds the event and settles it: `published` when equal, the mismatch path otherwise.
      - A runner that marks the envelope `withdrawn` after a complete read with no event fails the case.
    - A runner that sends a POST after the withdrawal, or marks an `attempted` envelope `withdrawn`, fails the
      case. So does one that resolves it through the remote store's `byIdempotencyKey()`, which returns `null`.
- **T8 unavailable is loud.** Any source unavailable → a tier-1 "source unavailable" finding with the
  source and error, and every dependent finding marked incomplete; NOOA INCONCLUSIVE renders as
  uncertain; an absent NOOA audit renders as unavailable, tier 1.
Authority
- **T9 seat authority.** (a) The runner's envelope validator refuses any event that is not the frozen
  terminal envelope (other actions, an `action_detail` other than `"digest"`, `artifact_sha256` keys that
  differ from the `generated` ids, amendment or correction tags, arbitrary artifacts, other projects) —
  a runner-side test, labelled as such until server-side restriction exists. (b) After publication the
  runner lists the seat's events in the run window and asserts exactly one; an injected extra event by
  the same credential leaves this run's sealed outcome untouched and produces a mandatory tier-1 finding
  in the next run citing both events; the local audit record survives a crash between the two runs.
  *Correction 2026-10-05 (v1.5; L3-9; §8):* coverage and counting. A window holding more seat events than
  one page is read to coverage, and an extra event on an older page is found. Negative cases: a history
  fake that keeps `truncated: true` past the walk's cap, a runner that stops at the first page, or a
  cached (non-`fresh`) export offered as coverage → a tier-1 "seat audit incomplete" finding in the next
  run, never a pass. Counting: an earlier run's retained envelope published in this window is expected,
  not extra; in the T7 mismatch case the audit raises no second finding for the missing own event.
  *Correction 2026-10-05, source: cross-check finding L3-2; the (b) text above stays.* "The seat's
  events" in (b) means the three keys in the §8 correction (actor, `sealed_by`, `relayed_by`). The
  negative cases must include a fixture event with a human actor, `action: instructed`, and the seat
  credential's `sealed_by` and `relayed_by`. An audit keyed on actor alone passes it. This case must trip
  whatever the credential carries (Jordan decided none, §11).
  *Correction 2026-10-05, source: design-gate gap "`sealed_by` key in the terminal mismatch case" (§8);
  the text above stays.* The `sealed_by` key is the configured `pinned:<credential name>`. Fixtures use a
  placeholder name; the real one waits on the mint (§11). Negative cases that must trip: (i) the T7
  mismatch fixture where the re-read returns a foreign event with another credential's `sealed_by`, plus
  an injected extra event carrying the configured `sealed_by` under a human actor → the extra event is
  found and reported; an audit keyed on the re-read value misses it; (ii) a matched re-read whose
  `sealed_by` differs from the configured value → the audit keys on both values and the next run renders
  a tier-1 "seat key mismatch" finding; (iii) a runner configuration without the value → refused at
  load, non-zero exit, nothing read or published.
Determinism, identity and truth-tracking
- **T10 selection determinism.** Same retained inputs, clock and rules → identical selection-manifest
  bytes; the tie-breaker is the finding id. (v1.5, 2026-10-05) The retained inputs include the root
  read (§7 correction), so the root-check result and the outcome are in those bytes.
- **T11 stable identity.** The same logical finding observed in two runs with different pins, heads and
  ranges has the same `id`; the same subject in two repositories has two ids; changing `finding_version`
  changes it, and the migration is recorded.
- **T12 incomplete history is labelled.** A watermark gap or a source over its limit → "window
  incomplete since …" in the header, never a false "no change".
- **T13 presence tracks truth.** Inject a misattribution, run, assert selected; apply the correcting
  event, run again, assert not selected (Nemotron 2).
  *v1.5 (2026-10-05; §4 Acknowledged, amended and `info`):* the correcting event is an effective
  attribution amendment, so the second run's finding carries `amended` and none is selected. A
  `correction`-tagged acknowledgement instead makes the `reconcile.misattributed` finding not selected
  and selects a tier-4 `reconcile.acknowledged` finding with another id; the test asserts both.
- **T14 adapter contract.** A fixed set of raw source outputs with known kinds, fed through the adapter
  and rubric, yields the exact expected `rule_id` and tier for each; an unknown kind yields the tier-1
  "adapter unknown kind" finding; the adapter-table digest is part of the fixture (Nemotron 4, 9). The fixture adds four follow-up rows (v1.5, L4-F7), each at a fixed evaluation clock. (a) An instruction 25h old with no `caused_by` child is selected as tier 3 `export.instruction_without_followup`. Its evidence carries the instruction event and an observation of the export pin (bundle hash, tail hash, live head) with scope `{project}`. (b) One 23h old with no child is not selected. (c) One 25h old with a child is not selected. The child sits in the tail past the bundle head, so the row also trips if the tail is dropped. (d) A status response with `instructions_without_followup` > 0 and an export with no unanswered instruction yields no follow-up finding. Row (d) is the negative case that trips if the status count is used as the source.
  *v1.5 (L2-6, L2-7; §4):* the fixture also carries `retrace-reconcile/1` `--json` reports with every code
  name in the §4 kind-name table, read from `kind` and `summary`, with `orphan_edit` taken from `orphans`;
  one report with `restricted_hook_stamps` and one without it, each yielding the two counts and no finding;
  and an event whose `owner_login_decision` status is `conflicting`, which yields nothing.
  *v1.5 (2026-10-05; §4 Acknowledged, amended and `info`):* the fixture also carries, at a fixed export
  head: (e) a `misattributed` `fail` and a `producer_disagreement` `fail`, each with `acknowledged` and
  level `info` → one tier-4 `reconcile.acknowledged` finding each, ids distinct from the unacknowledged
  ones, evidence citing the correction event; (f) a commit-level `misattributed` with `amended`
  (`original_level: "fail"`) and a file-level one with `amended` (`seq`, `id`, `to`) → no finding, and
  the observation's amended count is 2; a report without `summary.amended` reads 0; (g) native `info`
  findings: `non_agent` and `loose_match` → tier 4, and `uncovered` at `info` on a governing path → tier
  3, the same tier as the same finding at `warn`; (h) negative cases that trip: a level `notice`, an
  `amended` on `uncovered`, and a finding with both `amended` and `acknowledged`, each → tier-1 "adapter
  unknown kind"; and a run whose adapter tiers by `level` or drops `acknowledged` findings fails row (e)
  or (g).
  *v1.5 (2026-10-05; design-gate gap, untiered reconcile cases; §4):* the fixture also carries, with a
  rules file whose `reconcile.governing_paths` is the §4 stage-1 value: (i) a `missing_commit` `fail` and a
  `missing_commit` `warn` (the webhook-merged pull-request head) in a range whose to-sha is main's head →
  tier 3 each; (j) `uncovered` at `warn` on `docs/agent-rules.md` → tier 3, and on `packages/core/src/status.ts` →
  tier 4, and the same two at `info` → the same tiers; `uncovered` at `warn` on the cloud push guard
  `scripts/cloud/guard-push-main.sh` → tier 3 (fix round 1, Codex r1 C-M4; a list without `scripts/**` fails this row); (k) negative cases that trip: a rules file without
  `reconcile.governing_paths`, and one with an empty list, are refused at start; a run whose to-sha is not
  main's head marks every reconcile finding "incomplete"; and an adapter that tiers every `uncovered` at 3,
  or that leaves either case untiered, fails row (i) or (j).
  *v1.5 (L2-3, L2-4; §6 doctor rule):* doctor output for `export-cache`, `model claim absent` and
  `owner-login` at every level each label takes, in both `--gate` modes, yields the tier the table gives,
  the same tier in both modes for a label whose level `--gate` alone sets; a (key, level) pair absent from
  the table yields "adapter unknown kind"; a rules file without `doctor.gate` is refused at start.
  *Correction, 2026-10-05 (design-gate gap, `doctor.gate`; §6 value):* the doctor fixtures are `--gate`
  output only, captured with `doctor.gate: true`: `owner-login` FAIL for each of its four cases (policy
  load error :1015, digest mismatch :236, incomplete history :243, shared-login seals :254) → tier 1;
  `owner-login` PASS → no finding; `model claim absent` WARN → tier 4 and PASS → no finding;
  `export-cache` WARN → tier 4; `pin/session` FAIL → tier 2 (an identity check, §6 tier-2 row). A table
  check asserts that `owner-login` and `pin/session` carry WARN at the same tier as FAIL. The manifest records `--gate` and the
  checkout sha. Refused at start: a rules file without `doctor.gate`, and one with `doctor.gate: false`.
  A runner that passes `--local`, or omits `--gate`, fails the row by the recorded mode. "In both `--gate`
  modes" above is replaced by this paragraph.
  *v1.5 (2026-10-05; design-gate gap, untiered doctor labels; §6 doctor label table):* the doctor fixture
  also carries, captured with `doctor.gate: true` except where noted: (l) one WARN or FAIL line for every
  (label, level) pair in the §6 doctor label table, 37 labels in all, each → the tier the table gives;
  pairs reachable only without `--gate` (`post-commit hook`, `post-merge hook`, `actor authorization`,
  `credential` WARN, `review routing history` WARN, and the WARN of each gate-alone label) are hand-written lines in doctor's line format
  (doctor.ts:1058), since the runner never produces them; (m) a table check: the rules-file doctor list
  equals the 37 labels at `6190d5f` exactly, every gate-alone label (`HEAD delivery`, `attribution`,
  `pin/session`, `owner-login`, `attribution deployment`, `deployment`, `issuance`) carries WARN at its
  FAIL tier, and no label lists a level the table does not give; (n) negative cases that trip:
  `principal` FAIL and `export-cache` FAIL → tier-1 "adapter unknown kind"; a run with only the stderr
  `FAIL  repository` line and no summary line → tier-1 "source unavailable" for doctor. An adapter that
  tiers by level alone fails row (l) at `principal_conflicts` WARN and `capture coverage` WARN; one with
  a default tier fails row (n).

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
  *Note, 2026-10-06 (v1.5; claude-code):* no vendor is chosen for this endpoint. The build brief named
  GitHub Models for its deferred deliverable 3, and GitHub Models was fully retired on 2026-07-30
  (docs.github.com/en/github-models); the brief's 2026-10-06 correction records it.
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

*Note, 2026-10-06 (v1.5; claude-code):* while the trailer policy is off, condition (c) fails on every run
(§4, the shadow source while the policy is off), so no window can count until the policy is on. While
reconcile's attribution state is unknown or unavailable (§4), every reconcile `misattributed` finding is
`incomplete`, so condition (c) fails for that reason too until the §11 reconcile items land.
*Added 2026-10-08 (fix round 1):* a finding left `incomplete` by the supersession check (§4) counts against (c)
like any other incomplete finding. A run whose envelope was withheld after a withdrawal (§8) has no terminal
event; it counts against readiness like a failed run. A run whose envelope's publication is `unknown` (§8, fix
round 2) counts the same way until a later run settles it.

## 11. Implementation items this note creates (not part of stage 1's claims)

- `retrace-admin`: a `retrace-ai` harness entry (mint a pinned credential + producer key, principal
  Jordan, never-reissue applies).
  - *Correction 2026-10-05, source: cross-check finding L3-2; the item above stays.* `retrace-admin`
    mints every pinned agent credential with `actor.on_behalf_of` set to the member
    (`packages/mcp-server/src/admin.ts:156` and `:293` at `6190d5f`). `set-principal --on-behalf-of`
    only selects a credential and cannot remove the field (admin.ts:576-582). A `retrace-ai` entry minted
    the default way would therefore carry `on_behalf_of` = Jordan. The Worker would then let it seal
    `instructed` events as Jordan, stamped `relayed_by: retrace-ai` (router.ts:347-364, :926-927).
  - **Decided (Jordan, 2026-10-06, `evt_40d1e828ec654a2f96bd945453d86136`): the `retrace-ai` credential
    carries no `on_behalf_of` (option A).** The Worker then refuses any human-actor event from it
    (router.ts:348-349). §2 says stage 1 writes one terminal event and nothing else, so stage 1 does not
    need such events. `retrace-admin` has no mint path that omits the field at `27f4264`, so the mint needs
    one: an admin change, placed inside this harness-entry item or filed as a separate gated change, or a
    credential written by hand in Jordan's terminal flow (agent-ops 16). **Still open for Jordan, before the
    mint:** which of those. Option (B), `on_behalf_of` = Jordan as the default mint sets it, was not chosen.
    The §8 audit and T9b keep the credential keys (`sealed_by`, `relayed_by`) beside the actor: they cost
    nothing and catch a credential minted the default way by mistake.
- Doctor: a structured output mode or a stable line grammar with a version.
  - *Added 2026-10-08 (fix round 1; Codex r1 C-M3; §6, Doctor's ledger view).* This one is a prerequisite for
    stage 1's first live run, and it comes before the structured mode if that lands later.
    - Under `--gate`, doctor prints `ledger head <seq> <hash>` for the verified chain its ledger-derived labels
      read. The line goes after its finding lines and before the summary line.
    - Tests: the line present; absent; and carrying a hash that is not the chain's at that seq (digest T4 (ix),
      (x)).
- A public listing for PR 34's pending deliveries (only if the digest should report them).
- Credential-store follow-up: server-enforced per-credential action/tag restrictions (prerequisite for
  stage 2).
- `appendEvent` idempotency returns the existing event without comparing payloads (Codex N1); the T7
  re-read assertion is the digest's runtime guard until the store compares.
- *Added 2026-10-06 (v1.5; claude-code):* reconcile, two changes, both prerequisites for stage 1's first
  live run (§4, attribution availability): (1) the `--json` report states whether attribution evaluation ran
  and, if not, why, and carries the export head hash it reconciled under; (2) the attribution context
  tolerates, or reports per event, a commit artifact it cannot resolve, so one event cannot disable the
  evaluation for every run (today the merged record at seq 10390, §4; issue #195).
- *Added 2026-10-06 (v1.5; claude-code):* rules. No agent-rule text covers a seat that runs no model.
  Agent-rules 1, 4, 7 and 13 assume a harness, and rule 4's `model_source: none` records an unknown model,
  not a seat with none by design. A class (a) rules change says how such a seat records itself before its
  first live write.
  - It was sequenced after PR 189, which edited rule 7. PR 189 merged on 2026-10-07
    (`4e65103848f4991b6ff6060baef62a85618717eb`), so nothing else orders it now (updated in fix round 1, Codex r1).
  - It remains Jordan's to direct, as a class (a) rules change before the digest's first live write.
  - It should tell a deliberate model absence from an unknown model, and say how a standing run's causality
    satisfies agent-rules 1.
- **OPEN QUESTION FOR JORDAN** (added 2026-10-05, v1.5; L3-4, L4-F9): reserve the `digest:` idempotency
  prefix server-side, in `adapterIdempotencyError` (`store.ts:924-946`), for events with
  `method.tool: "retrace-ai"` and the `digest` tag? It is defence in depth only: like every reservation it
  checks fields the writer declares, so it would not stop a holder of the seat's credential. Options:
  (a) queue it as its own gated server item; (b) do not queue it, and rely on the T7 re-read, the
  mismatch outcome (§8) and the UUIDv7 key; (c) defer until the per-credential action/tag restrictions
  above land, which would cover it. Not decided here.
- NOOA hourly audit: add the "one event per digest run by the retrace-ai seat" check (§8).
  - *Correction 2026-10-05, source: cross-check finding L3-2; the item above stays.* "By the retrace-ai
    seat" uses the same keys as the §8 correction. NOOA has no T7 re-read of the runner's event, so it
    cannot learn the `sealed_by` value that way. It keys on actor id `retrace-ai` and
    `relayed_by: retrace-ai`, and on `sealed_by` = `pinned:<credential name>` only once that name is
    configured for it. The name is fixed at the mint, which is Jordan's (open question above).
  - *Correction 2026-10-05, source: design-gate gap "`sealed_by` key in the terminal mismatch case"; the
    items above stay.* The runner has the same dependency: its seat audit keys on the configured
    `pinned:<credential name>`, not on the re-read event (§8). The runner and NOOA take that value from
    one source, the name fixed at the mint. The runner cannot start until it is configured.

## 12. Cadence, cost, priority

Daily at a fixed hour plus on demand (`retrace digest`). Stage 1 cost is compute and D1 reads only: zero
model calls. Priority: below shadow→enforce and the boxing-rpg live window (Grok's 1 and 2) and below the
credential store (3). Build after PR 42's design lands and while the step-5 measurement window runs, so
the first digests cover a live window. Prior-art research (Jordan, Perplexity) is untrusted input and
will be folded as dated additions.

## 13. Revision history (document revisions)

- **v1.5 (2026-10-05, amended 2026-10-06 and 2026-10-08)** — authored by claude-code (coordinator) on Jordan's instructions
  `evt_52f6dae68acc4f66ab39fab04f00ee4f` and `evt_40d1e828ec654a2f96bd945453d86136`, from a first draft written
  on the Omarchy PC by a Claude Code session (claude-opus-5-5) that is not a seat. Answers the 2026-10-05
  Retrace AI cross-check of HEAD `6190d5f` (Opus-pane findings, each verified by two skeptics). Reviewed in
  round 1, answered in fix round 1 (below); class (a), design gate pending. Every v1.4 sentence that a finding narrows stays visible, with a dated correction after it,
  except the §8 envelope sentence, §4 doctor/reconcile/shadow rows, §5/§6 doctor wording, the §6 tier-3
  row and the T9 (a) refusal list, which are revised in place and whose v1.4 wording is quoted here (T9 (a)
  v1.4: "(other actions, amendment or correction tags, arbitrary artifacts, other projects)"; §8 envelope
  v1.4: "the idempotency key, artifacts: selection manifest, publication artifact and `report.md` as
  `generated` with sha256, every ledger event cited in the selection manifest as `used`, rules and adapter
  digests"). Open questions are collected in each section and
  are Jordan's; two are decided (Q1 and Q7, below), the rest are not.
  - **J1, L3-3** (§8, T7): "full payload equality" defined as `producerSignedPayload` equality under
    `retrace-producer-sig/2` (format pinned explicitly), plus equal `producer_sig` and a `verified`
    verdict; Worker-owned stamps listed as not compared; the envelope carries its own `timestamp`. T7
    gains a positive case and six negative cases. Open question: `require_signature` on the credential.
  - **J2, L3-5** (§8, T6, T9a): v1.4's "as `generated` with sha256" and "rules and adapter digests"
    replaced by `method.params.artifact_sha256`, `rules_sha256` and `adapter_table_version`; the three
    artifact file names fixed; the envelope gains `action_detail: "digest"`. T6 and T9a extended.
  - **J3, L3-7** (§7, §8, T7, T10): the envelope gains `caused_by` (when a root is configured) and a
    `timestamp` equal to the evaluation clock, set once at run start; the root check runs at the start of
    §7 step 1, so the selection manifest, `report.md` and the envelope state one outcome; the store's unverified-parent stamp (`store.ts:1047-1053`, :890-899, :912-919), its
    per-project rule and its timestamp condition are stated; a pre-freeze root check, run only when a root
    is configured, fails the run on an unaccepted problem while keeping the claimed id; T7 gains the
    root-check sub-case. The root choice (A/A1/A2, A3, B) is an open question for Jordan. *Decided
    2026-10-06: (A) with (A1), below.*
  - **J4, L4-F7** (§4, §6, T14): the tier-3 instruction follow-up rule moves from the status count, which
    has no ages, to a full-project verified export the runner reads and pins (bundle, tail, live head) at
    the evaluation clock; its evidence includes a full-scope observation (§5). T14 gains four rows, one a
    negative case that trips on the status count. v1.4 tier-3 wording: "instructions without follow-up
    older than 24h".
  - **J5, L2-3, L2-4** (§4, §5, §6): a doctor tier rule replaces v1.4's "informational and acknowledged
    findings map to tier 4" (§4) and "informational/acknowledged findings" (§5), which doctor does not
    have; three new doctor labels tiered; `owner-login` at tier 1 until it has split keys; `doctor.gate`
    becomes a required rules-file field; tier-1, tier-2 and tier-4 rows amended.
  - **Design-gate gap, `doctor.gate` value** (§4, §6, T14): v1.5 said the mode was "chosen at this note's
    design gate" but gave no value. §6 now sets `doctor.gate: true` (verified-export reads, doctor.ts:1008-1023;
    the merge gate's own mode, retrace-gate.yml:28), refuses absent or `false`, runs doctor in a detached
    checkout of reconcile's to-sha and pins that sha (§4 doctor row). T14's doctor fixtures become
    gate-mode only. No v1.4 text removed.
  - **J6, L2-5, L4-F8** (§4, T4): status is pinned by an unsigned `GET /head` bracket with retry; a
    mismatch is "snapshot inconsistent"; T4 gains an injected-store negative case and joins the must-trip
    list. *Revised 2026-10-06, below.*
  - **J7, L2-6, L2-7** (§4): reconcile kind-name table (code names from `--json`); v1.4 row wording "(missing,
    misattributed, producer-disagreement, unreachable-seal, uncovered, loose, non-agent, orphan paths)"
    replaced by the table; `restricted_hook_stamps` counted, no finding; the shadow adapter keys on
    `claim_decision` only (v1.4 cell began "`conflicting` → tier 2"); owner-login as a source is an open
    question for Jordan.
  - **J8, L3-9, L3-4, L4-F9** (§8, T7, T9b, §11): the seat audit proves window coverage (paged walk or
    fresh export) and counts retained envelopes as expected; incomplete → tier-1 in the next run;
    re-read mismatch → no rewrite, no republish, `terminal mismatch` recorded locally, tier-1 in the next
    run; equality set per L3-3; the audit selects seat events by J9's three keys. Reserving `digest:`
    server-side is an open question for Jordan (§11).
  - **J9, L3-2** (§8, T9b, §11): dated corrections add credential keys (`sealed_by`, `relayed_by`) to the
    seat audit and to the NOOA check; whether the `retrace-ai` credential carries `on_behalf_of` is an
    open question for Jordan (§11). No v1.4 text removed. *Decided 2026-10-06: it does not, below.*
  - **Design-gate gap, `sealed_by` key** (§8, T9b, §11): the audit's `sealed_by` key is the configured
    `pinned:<credential name>`, required at config load; a matched re-read with another value adds a
    tier-1 "seat key mismatch"; in the mismatch case the returned event's value is evidence, never a key.
    The credential name stays Jordan's (§11).
  - **Design-gate gap, reconcile acknowledged/amended/`info`** (§4, §6, T13, T14): after v1.4's
    "acknowledged → tier 4" was withdrawn for doctor, no section handled reconcile's `acknowledged`,
    `amended` (reconcile.ts:47-48) or level `info` (:34). §4 now gives an ordered rule: malformed shape →
    tier-1 unknown kind; `amended` → no finding, counted; `acknowledged` → tier-4
    `reconcile.acknowledged`; otherwise the kind's tier, level not in the lookup. Tier-4 row amended; T13
    names its correcting event; T14 gains rows (e)-(h). No v1.4 text removed.
  - **Design-gate gap, untiered reconcile cases** (§4, §6, T14): the kind-name table left `missing_commit`
    off main and `uncovered` off a governing path without a tier, carried from v1.4, while step 4 tiers
    every remaining finding by the table. §4 now runs reconcile on main, so every `missing_commit` is tier
    3; `uncovered` is tier 3 on `reconcile.governing_paths` (a new required rules-file list, stage-1 value
    given) and tier 4 off it. Tier-3 and tier-4 rows amended; T14 gains rows (i)-(k). The v1.5 "carried as
    it stood" sentence stays visible, withdrawn by a dated correction.
  - **Design-gate gap, untiered doctor labels** (§6, T14): step 2 required a tier for every doctor label,
    but v1.5 tiered five and left "identity/credential checks" undefined. §6 now carries a 37-row label
    table at `6190d5f` and the rule that produced it (one category per site; highest tier across
    gate-reachable sites; gate-alone WARN = FAIL). Tier rows 1-4 point at it; tier 2's "identity/credential
    checks" are its tier-2 rows. T14 gains rows (l)-(n). No v1.5 text removed.
    *Correction, 2026-10-05 (review of this fix):* the `review routing history` row and T14 row (l) now
    say that label is reachable only without `--gate` (doctor.ts:346, :1017). The `local_config_drift` row
    now names every tier-1 finding a gate run reports for the :1004 failure, not `owner-login` alone.
  - **Critic pass, 2026-10-05** (§4, §8, T4): reconcile's `--json` report carries no head hash, so §4's
    "already pinned" clause had no source; the reconcile read is now bracketed by two `GET /head` reads like
    status, and T4 gains the matching case. The A2 on-demand root gets its input (`--caused-by`). The seat
    audit's description of the `/events` filters is made exact. No v1.4 text removed.
  - Header: title and status line moved to v1.5 (draft); the v1.4 status text is kept below it.
  - **Coordinator amendments, 2026-10-06** (claude-code; every claim re-checked at `27f4264`; ledger: decision
    `evt_498af27e7f6a4f81a8a44407c613ebab`, answers recorded `evt_cbbd4c7959cb40a0ae2be544d9f0aba5`):
    - **Jordan's answers.** Q1: the credential carries no `on_behalf_of` (§11, §8, T9b). Q7: a standing
      instruction per covered project roots every run (§7, §8, T7), recorded as (A1), the literal reading of
      the answer; (A2) was the coordinator's recommendation and is one paragraph away if Jordan wants it.
    - **J6 and the cross-source rule** (§4, T4): equal heads replaced by chain-prefix consistency against one
      reference chain; status and reconcile pinned to bracket intervals; T4 rewritten with one positive and
      three must-trip cases. The measured reason is in §4. Nemotron 3 keeps its tier; only what counts as
      inconsistent narrows. The draft's open question on accepting degraded runs from the follow-up read no
      longer arises.
    - **The planning pane's findings, re-checked at head** (the other PC pane's cross-check; not in the first
      draft): reconcile's attribution availability, with two §11 prerequisites (§4, §10, §11); the shadow
      source while the trailer policy is off (§4, §10); no rule for a seat that runs no model (§11); GitHub
      Models retired (§10 note, and the build brief's correction).
    - **Citations.** Every code citation in the draft was re-checked at head
      (`evt_29cf75a3189f4d23a4f05985b483308d`): three line ranges fixed (export-cache.ts :59-66; router.ts
      :866-868; router.ts :836-837) and one word removed (export.ts, "only"). No code claim was false.
    - **Before review, 2026-10-06** (Jordan's go to push, `evt_5e903888d5654a63b32c7f951835b0c6`): §4's attribution
      paragraph now names the actual trigger, the merged record at seq 10390, in place of two non-commit events
      that only yield diagnostics; issue #195 is cited in §4 and §11.
  - **Fix round 1, 2026-10-08.**
    - **Who and why.** Written by claude-code (coordinator session 31, `claude-opus-5-5`) on Jordan's go
      `evt_7c055bb7e6f44599a0c8223e938cc47f`, which came after the round-1 escalation; routing
      `evt_f91a998d6deb49108157260ec4832107`.
    - **Round 1.** Codex (`evt_55a8f4c9c6a14f88b49c46c38e5505fb`) rejected v2 at `e43da144` with four Mediums.
      Grok r2 and NOOA r1 approved.
    - **How the text was changed.** Text this PR added is edited in place (agent-rules 10 binds merged text;
      Jordan, `evt_9dc982064d3c432bbd85ff9a64f049da`). Merged text gets dated corrections.
    - **C-M1** (§4, §10, T4): a supersession table and check after the reference chain.
      - Each source has a row naming the event shapes that can change a finding read at an earlier head.
      - A match triggers one second read; a finding still matched after it is `incomplete`, and the run is
        degraded.
      - Unrelated appends change nothing.
      - T4 (i) is narrowed; (v) to (viii) are added.
    - **C-M2** (§8, §6, §10, T7): withdrawal of a standing instruction.
      - Withdrawal is a configuration change made on Jordan's signed instruction.
      - The configuration is read again before every publication.
      - A frozen envelope whose root is gone is withheld, never published, and reported by the next run as a
        tier-3 finding.
      - T7 gains three cases.
    - **C-M3** (§4, §6, §11, T4): doctor's ledger-derived labels get a pin.
      - The pin is a `ledger head` line under `--gate`, added as a §11 prerequisite.
      - A missing pin makes those findings `incomplete`, with a tier-1 finding.
      - The other labels are external observations, with their consequences stated.
      - T4 gains (ix) and (x).
    - **C-M4** (§4, T14): the governing-path list.
      - It was checked against every non-code path at `6190d5f` and re-checked at `ce2a78cc`.
      - `scripts/**` (the cloud push guard among them) and the other controls are added, and the exclusions are
        stated.
      - T14 row (j) gains the guard.
    - **Codex's advisories.**
      - The no-model rule's sequencing sentence is updated, since PR 189 merged (§11).
      - Q7 stays (A1), as Jordan recorded it. Codex's advice for (A2) on on-demand runs is left to him.
    - **Found by the coordinator, not a reviewer** (§4, attribution availability): the runner fetches the
      remote's branches and pull-request heads before the reconcile read. A seal can name a commit that a
      main-only checkout lacks (seq 14839, 2026-10-07).
  - **Fix round 2, 2026-10-08.**
    - **Who and why.** Written by claude-code (coordinator session 31, `claude-opus-5-5`) on Jordan's go
      `evt_054df4d9869b4f1bb1a9e117ebff1f60`, after the round-2 escalation `evt_49811392f3d04697b4b25ebdbe67122b`;
      routing `evt_27e26a97e8814aba903a8678cd38f51f`.
    - **Round 2 at `c83b43ec`.** Codex (`evt_1d3222badcd64901ab1c08b62f00362b`) re-raised C-M1 and C-M2, and
      resolved C-M3 and C-M4. Grok r3 (`evt_262101da6c5a4c8d9f9c2172fd696f61`) approved with no findings.
    - **C-M1** (§4 supersession, T4):
      - The tail starts after the last event a source actually read. For reconcile that is `range.head_seq`,
        never a bracket end, on both passes.
      - The reconcile row now matches every commit or merge record (any commit), every `correction`-tagged event
        and every attribution amendment, against every per-commit finding. The reason: a late webhook can
        activate an earlier restricted witness for another commit and move a window.
      - Edits stay out, with the code that excludes them cited.
      - T4 gains (v-b), (vi-b) inside the bracket and (xi), the out-of-range predecessor.
    - **C-M2** (§8 withdrawal, §6 tier 1, §10, T7):
      - Publication states: `unattempted`, `attempted`, `published`. `attempted` is written before the first
        POST.
      - After a withdrawal no POST is sent. An `attempted` envelope is first resolved by its key in a verified
        read with proven coverage: an equal event means it was published; a different one is the mismatch path;
        none, with coverage proven, means it is withheld.
      - Otherwise it is `unknown`, reported at tier 1 and never called absent.
      - T7 gains (d).
    - **Codex's precision notes.** The governing list no longer says all source code is class (c). The fetch
      note states the adapter's fallback to a unique full OID the ledger supplies.
  - **Fix round 3, 2026-10-08** (the last, as recommended).
    - **Who and why.** Written by claude-code (coordinator session 31, `claude-opus-5-5`) on Jordan's go
      `evt_9d49674669e04b9b98617b05018e316a`, after the round-3 escalation `evt_49194ae44ddc414b81e6a66b1045ad7b`;
      routing `evt_2c4fca9570394967a6fa48ebb6d689ee`.
    - **Round 3 at `81ccf050`.** Codex (`evt_9c35c8e1b27f45c7b39227560b2286a4`) accepted the round-2 repairs and
      kept C-M1 and C-M2 on one remaining case each. Grok r4 (`evt_4acd8d0ab5fe45fcbbc9b68f5ac3d5ec`) approved
      with no findings.
    - **The approach.** The first two rounds added rules, and each round found a case the rules missed. This
      round removes the two claims instead.
    - **C-M1** (§4 prefix rule, *What the check claims*, reconcile row, step 3; T4):
      - The digest no longer states any finding as current.
      - Each finding is stated as read at its source's head, with the known superseding shapes checked through
        the reference head. A known supersession makes it `incomplete`; a later event outside every row changes
        nothing.
      - This is Codex's round-1 alternative: as-of semantics, with known supersession defined for completeness
        and promotion.
      - The late edit with an expired alias is named and tested (T4 (xii)). T4 (v)'s failing runner is
        reworded.
    - **C-M2** (§8 withdrawal; T7):
      - An `attempted` envelope found absent stays `unknown`, because a POST sent earlier can still seal after
        the read. It settles only positively.
      - Only an `unattempted` envelope becomes `withdrawn`.
      - T7 (c) now expects `unknown`, and T7 (d) gains the delayed-seal case.
      - How an owner decision may close an `unknown` envelope is an open question for Jordan.

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
