# Cloud seat B2 — builder brief (hook proxy mode, issuance, restricted capture, principal rule, one-run stamp flag, cloud scripts, push guard)

**Status:** v1, 2026-10-03, by claude-code (coordinator and spec author, `claude-fable-5-1`, model source harness-runtime), on
Jordan's signed go `evt_a7881da7f61140f2a542461f95bf4e0c` ("Go on B2"). **Not built.** Builds `docs/design/cloud-seat.md` **v2**
(merged `3354b3ed`, PR 159; cited below as **N§**) §2.2, §3.1–§3.5, §4, §5, §6 and §8 row B2. The note's text wins over this
brief wherever they differ, **except the extensions this brief lists as its own** (§1.3's per-path touch model, §1.3's rule 0 from
Grok G-L1 and issue #166, §1.4's known-address constant, §1.6's committed `.mcp.json` shape, §6's gate items); those go in the
code pull request's body and the build continues. Any other difference: file the discrepancy on the pull request and stop.

**Gate.** This brief is **class (a)** (it governs behaviour) and takes the design gate: Codex, NOOA, Grok, then the coordinator;
merge on Jordan's go. The code pull request it specifies is **class S** (`.claude/skills/review-effort/routing-rules/1.json`: it
touches `producer-sig.ts`, `commit-actor.ts`, `router.ts`-adjacent resolution, `reconcile.ts`, `capture.ts`, `attribution-context.ts`)
**and class (a)** (it adds a committed `.claude/settings.json` hook and a `.mcp.json` entry, which govern what a session may do), so
the higher gate applies (agent-rules 12): the full code order with Codex first, NOOA and Grok, then the coordinator. §7 says who sits.

**Companions:** the note (N§); `docs/design/commit-trailer-consistency.md` §4 (the decision table D2 does not change);
`docs/design/project-policy-document.md` (the frozen policy form B2 does not change, §6 item b); `docs/agent-rules.md` 7, 13, 15;
`docs/agent-ops.md` 16, 18, 19; `docs/owner-protocol.md` §5, §8; issue #166.

## 0. What B2 is, and is not

Build, in one pull request on a branch from main, with every change in §1 and every test in §2:

1. **Hook proxy mode** (N§3.1–§3.2): `RETRACE_AUTH=proxy` makes the git hook send no `Authorization` header and never sign.
2. **Issuance of `claude-code-cloud`** (N§2.2): a pinned agent credential with no producer key, no `public_key`, no
   `require_signature`, and a cloud-specific onboarding output that contains no token.
3. **The restricted capture policy** (N§3.5): `restricted_hook_stamps` under `reconcile` and under
   `attribution.repositories[]`, applied in `reconcile` and in the shared capture code with per-path boundaries, plus the
   rule that an ineligible event contributes no paths (Grok G-L1; issue #166).
4. **D2, the principal rule** (N§4): an agent's author address is never `on_behalf_of`; producers add an authenticated principal;
   the change is versioned with `principal_rule: "agent-address/1"` and a compatibility fixture.
5. **The one-run stamp flag** `retrace-export reconcile --restricted-hook-stamp <stamp>=<actor>` (N§3.2, N§7 Q6).
6. **The cloud scripts** (N§3.1, N§5): the environment setup script, the stdio MCP wrapper, and the `.mcp.json` entry `retrace-cloud`.
7. **The `PreToolUse` push guard** (N§6): a committed Claude Code hook that refuses `git push` to `main` when `CLAUDE_CODE_REMOTE=true`.

Not in B2: publishing the CLI (B3), deploying the Worker (B3b), minting the credential or touching any Worker secret or cloud
environment (B4), the owner-protocol change (B4b), P3 (B5), the agent-rules amendment, `restricted_hook_stamps` in this repository's
`.retrace.json`, `CLAUDE.md`/team-roles/agent-ops entries marking the seat live, and `disabledMcpjsonServers` (B6). B2 changes no
project policy document (§6 item b) and seals no correction of `evt_f8166fcc` (N§4.3). Nothing in B2 makes the seat live.

**Adoption is configuration, not code.** After B2 merges, nothing changes for any seat until B3–B6 run: the hook's default mode is
unchanged, `restricted_hook_stamps` is empty everywhere, D2 applies only to events that carry the discriminator, and the push guard
only fires when `CLAUDE_CODE_REMOTE` is `true`, which no laptop session sets.

## 1. Inputs, in the order the code should be built

### 1.1 Hook proxy mode (`packages/mcp-server/src/git-hook.ts`, `remote-store.ts`)

Today `loadCfg` (`git-hook.ts:155–172`) calls `resolveHookToken` (`:69–84`), which throws when `.retrace.json` names a `credential`
that is not in the credentials file; this repository's `.retrace.json` names `retrace-git`. The remote store sends the resolved token in
`retraceHeaders` (`remote-store.ts:42–48`), which already omits `authorization` when the token is undefined.

- Read `RETRACE_AUTH` in `loadCfg`. Value `proxy`: skip `resolveHookToken` and `resolveHookProducerKeyFile` entirely; `cfg.token` is
  undefined; the hook sends no `Authorization` header and attaches no producer signature. Value unset: today's behaviour. **Any other
  value is an error** (`retrace-git: RETRACE_AUTH must be unset or "proxy"`), never a fallback to the file or the environment token.
- Proxy mode **refuses to run when `RETRACE_URL` is unset** (there is no proxy to authenticate a local store write), with an error.
- `allowRemote` is unchanged: a repository with no `.retrace.json` still refuses the ambient `RETRACE_URL` (`:260–277`).
- `RETRACE_ENV` and `RETRACE_DEVICE` already override `location.environment` and `location.device` (`:165`, `:222`); no change, but
  T1 asserts both reach the sealed body under proxy mode.
- The hook log line on a 401 under proxy mode names the mode (`proxy mode: the egress proxy did not authenticate this host`) and
  carries no token (`appendHookLog`, `:97–99`).
- `retrace-git --probe` (`:373–376`) is unchanged.

### 1.2 Issuance (`packages/mcp-server/src/admin.ts`)

- `HARNESSES` (`:41`) gains `"claude-code-cloud"`; `DEFAULT_HARNESSES` (`:40`) does not (new teams do not get a cloud seat by default).
- `shouldMintProducerKey` (`:79–84`) returns false for `actor.id === "claude-code-cloud"`, beside `openclaw` and `ci-*`, so
  `add-agent` (`:520`) issues no `public_key`, no `require_signature` and no local key file. **No private key is ever written for
  this seat, anywhere.**
- `planAgentCredential` (`:286–296`) is unchanged: the result is `trust: "pinned"`, actor
  `{type: "agent", id: "claude-code-cloud", on_behalf_of: <member>}`, `projects: [project]`, `principal: {type: "human", id: <member>}`,
  no model pin (N§2.2 final shape).
- `HARNESS_CONFIG` (`:45`) gains an entry (label `Claude Code cloud`, file `the cloud environment's API credentials dialog`,
  instructions `CLAUDE.md`), and `renderAgentOnboarding` (`:299`) gains a `claude-code-cloud` branch that prints **no token**: it names
  the dialog (type Bearer, header `Authorization`, prefix `Bearer`, allowed website = the Worker host), lists the five non-secret
  environment variables of N§3.1 with their values, names the setup script path from §1.6, and says the token is delivered by the
  B4 step script, not by this document. It writes no MCP environment block. The generic branch's "This document contains one secret"
  line is replaced for this harness by "This document contains no secret".
- The `add-agent` usage line (`:618`) lists the new harness.

### 1.3 The restricted capture policy (`packages/core/src/capture.ts`, `reconcile.ts`, `attribution-context.ts`; `packages/mcp-server/src/reconcile.ts`)

**Policy shape.** `.retrace.json` gains, under `reconcile` and under each `attribution.repositories[]` entry, an optional
`restricted_hook_stamps: [{ "stamp": "<exact sealed_by>", "actor": { "type": "agent", "id": "<actor id>" } }]`. `ReconcileCfg`
(`mcp-server/reconcile.ts:17`), `reconcileOptionsFrom` (`:86–88`) and `AttributionPolicy.repositories[]` (`attribution-context.ts:51–53`)
carry it; `CapturePolicy` (`capture.ts:56–59`) gains `restrictedStamps?: { stamp: string; actor: { type: string; id: string } }[]` and
`webhookSeals?: Map<sha12, { actor; files: string[] }>`, the HMAC-stamped push seals the caller already holds. The stamp is **never**
read from `hook_sealed_by`: a stamp listed in both lists is a configuration error that reconcile reports and attribution-context
throws on (`context_conflict: stamp is both general and restricted`).

**Eligibility of a restricted event** (N§3.5 rules 1–3), decided in one function `restrictedSealEligibility(e, policy, webhookSeals)`
that returns `{ eligible: true, paths: string[] }` or `{ eligible: false, reason }`:
1. **identity:** `e.idempotency_key === "git:<full sha>"`, `e.method.params.sha` is that full sha, and `e` has exactly one `commit:`
   artifact whose reference resolves to the same sha (the 12-character prefix of the full sha); otherwise `no_key`, `key_mismatch`
   or `commit_mismatch`;
2. **authorship:** `webhookSeals` holds a `webhook:github` push seal for that sha whose resolved actor equals the entry's actor
   (`sameActor`); otherwise `no_webhook` or `actor_mismatch`;
3. **paths:** `paths` = the event's `repo:` artifact ids whose canonical path is in the webhook seal's file list; paths outside the
   list are dropped and returned as `dropped` for reporting.

**Boundary, per path (N§3.5 rule 4; Codex PR 159 r2).** An eligible restricted event **never joins a commit key's grouped seal**:
`captureSeals` (`capture.ts:84–98`) keeps grouping genuine seals by key as today, and returns restricted events as separate entries
`{ key, seq, event, paths: <intersected>, restricted: true }`. Consumers build touches from entries, so a restricted entry is one touch
`{ seq, paths }` that bounds only its intersected paths, and a key's grouped `seq` (the minimum over genuine seals, used for `before`
at `classify.ts:398` and `attribution-context.ts:132`) never takes a restricted event's seq. The first-eligible-event-per-key rule and
the paths union per key apply to genuine seals only.

**Rule 0, the ineligible event (this brief's extension; Grok G-L1 `evt_79a8ed07`; issue #166).** An event that is not an eligible seal,
restricted or general, **contributes no paths to any seal's union and no touch**. In `prepareAttributionContext` the union at
`attribution-context.ts:119–120` loops over every commit event naming the key; it must loop over the events `captureSealEligible` (or
restricted eligibility) accepted under the same policy and `firstStampedSeq`, keeping the per-event historical `canonicalArtifact`
mapping. That closes #166 in the same change, because the loop is the same loop (§6 item a).

**In `reconcile` (`core/reconcile.ts`):** `isHookSeal` (`:194–201`) stays as it is for general stamps. A committed event whose stamp
is restricted is classified by `restrictedSealEligibility`: eligible → it is the hook witness for that sha in the dual-witness
comparison (`:316–326`), so a cloud commit the webhook attributes to the same actor clears `producer_disagreement`, and its touch
carries the intersected paths only; ineligible → it goes to `claimedBySha` (`:191`) and is reported as a claim with its reason, and it
bounds nothing. `reconcileOptionsFrom` passes the list and the flag of §1.5.

**In the shared capture code:** `captureSealEligible` (`capture.ts:73–82`) returns false for a restricted stamp (it is not in
`hookSealedBy`); `captureSeals` takes the restricted entries from `restrictedSealEligibility`. `classifierCaptureSeals`
(`classify.ts:334–363`) is **unchanged in B2**: the live owner-login path reads `PolicyBody.trusted_hook_stamps` only, so a restricted
event is not a seal there (§6 item b states the consequence).

### 1.4 D2, the principal rule (`packages/core/src/commit-actor.ts`, `github.ts`, `producer-sig.ts`; `git-hook.ts`)

- **A constant** `KNOWN_AGENT_AUTHOR_ADDRESSES = ["noreply@anthropic.com"]` in `commit-actor.ts` (this brief's extension: the note
  says "exactly what was observed"; any addition needs a sealed commit that shows the address, cited in the change).
- **`resolveCommitActor`** (`commit-actor.ts:130–166`) gains an option `principalRule?: "agent-address/1"`. Under it, the `agentId` and
  `coauthorActor` branches leave `on_behalf_of` **absent** when the author email is in the constant; the `[bot]` branch is unchanged
  (it already records a system actor). Without the option, today's behaviour, byte for byte.
- **The hook** (`git-hook.ts:215`, "always the author email") applies the same rule under the option, and sets
  `method.params.principal_rule = "agent-address/1"` on every seal it produces once B2 ships (the laptop hook too: its author is a
  human address, so nothing changes in its output except the discriminator). Under proxy mode the Worker stamps `on_behalf_of` from
  the pinned credential (`router.ts`, `resolveActor`), which is the cloud hook's principal (N§4.1).
- **The webhook** (`github.ts:146–165`, the push mapping) sets `principal_rule: "agent-address/1"` in `method.params` and, when the
  resolved actor is an agent with `on_behalf_of` absent and `payload.sender.type === "User"`, records `on_behalf_of: "github:<sender.login>"`
  (the form `githubActor` uses, `:42`). The webhook's copy is server-stamped like the rest of the seal.
- **The verifier contract** (`producer-sig.ts`): `rederiveCommitClaim` (`:182–196`) reads `method.params.principal_rule` from the signed
  payload (`producerSignedPayload`, `:128–133`, already signs `method`): value `"agent-address/1"` → re-derive with the option; absent →
  legacy re-derivation, unchanged; **any other value → no substitution**, verification proceeds against the stored actor and the result is
  reported (T9). `sameSignedActor` (`:169–171`) is unchanged.
- **The ledger count** of withheld, `/2`-signed commit seals whose author address is in the constant is measured from a fresh export and
  recorded in the pull request body as local migration impact (N§4.2); it is not a condition.

### 1.5 The one-run stamp flag (`packages/mcp-server/src/export-cli.ts`, `reconcile.ts`)

`retrace-export reconcile` gains `--restricted-hook-stamp <stamp>=<actor id>` (repeatable). `reconcileOptionsFrom` merges the flag
entries with the file's list (flags win on a duplicate stamp). The actor type is `agent`. A malformed value is a usage error. The flag
exists so N§7 Q6 can run before B6 makes the configuration permanent.

### 1.6 The cloud scripts (`scripts/cloud/`, `.mcp.json`)

- **`scripts/cloud/setup.sh`**, the environment setup script, byte-for-byte what B4 pastes into the dialog: pins and installs
  `@retrace-dev/cli` at the version B3 publishes (a placeholder version string is a stop; the version is filled in B3's go), writes the
  two hook scripts `hookScript("post-commit")` and `hookScript("post-merge")` produce (`git-hook.ts:367`) into a system hooks
  directory, and runs `git config --system core.hooksPath <dir>` (N§3.1, Q4). It sets no variable and contains no secret; the five
  variables are dialog entries, listed in a comment. Its sha256 is printed by the script itself at the end.
- **`scripts/cloud/retrace-mcp-cloud.sh`**, the path-B stdio wrapper: exits 0 silently unless `CLAUDE_CODE_REMOTE=true`, then runs
  the packed CLI's `retrace-mcp` with `RETRACE_URL` from the environment and no token.
- **`.mcp.json`** at the repository root with one entry `retrace-cloud`, **path A** (this brief's extension: the note leaves the choice
  to P3; committing A first means P3's Q5 edits one line to try B): `{"type": "http", "url": "<RETRACE_URL>/mcp"}` with no headers.
  Laptop sessions see this entry; their own `retrace` server is local-scoped and wins on its name (N§5); disabling it locally is B6.

### 1.7 The `PreToolUse` push guard (`.claude/settings.json`, `scripts/cloud/guard-push-main.sh`)

A committed `.claude/settings.json` with one `PreToolUse` hook on `Bash` that runs `scripts/cloud/guard-push-main.sh`. The script
reads the tool input from stdin, and **only when `CLAUDE_CODE_REMOTE=true`** and the command is a `git push` whose refspec or branch
resolves to `main` (explicit `main`, `HEAD:main`, `refs/heads/main`, or a bare `git push` while on `main`), exits 2 with the message
`refused: a cloud session never pushes main (docs/design/cloud-seat.md §6)`. Everything else exits 0. On the laptop it is inert.
It is a bypassable policy control, and the brief and the script's header say so (N§6).

## 2. Tests — every test lands, each named in a `test(...)` title with its id

- **T1** hook proxy mode: with `RETRACE_AUTH=proxy`, `RETRACE_URL` set and `.retrace.json` naming `retrace-git` with no credentials file
  present, the hook builds the event, sends it with no `authorization` header and no `producer_sig`, and the sealed body carries
  `location.environment` and `location.device` from `RETRACE_ENV` / `RETRACE_DEVICE`. Unset `RETRACE_AUTH` → today's path (token
  resolved, header sent). `RETRACE_AUTH=anything-else` → error, nothing sent. Proxy mode with `RETRACE_URL` unset → error.
- **T2** issuance: `add-agent … --harness claude-code-cloud` writes a credential with `trust: pinned`, agent `claude-code-cloud`,
  `on_behalf_of` the member, no `public_key`, no `require_signature`, no key file on disk; the onboarding text contains no
  43-character base64url run; and the router accepts an **unsigned** `POST /events` on that credential (stamped `pinned:…`, verdict
  `none`) while rejecting a human actor on it.
- **T3** restricted eligibility, each rule: no key; key for another sha; two commit artifacts; no webhook seal; webhook resolves another
  actor; paths outside the webhook list dropped and reported; the all-pass case.
- **T4** Codex's sequence (N§3.5), through `reconcile` **and** `prepareAttributionContext`: Codex edits x; genuine hook and webhook seals
  for B by Codex touch y; a restricted-stamped event names B and x with no key; genuine seals for A by claude-code touch x. Expected:
  A `misattributed:fail`, `reconcile.ok` false, the restricted event moves no boundary. Variant with `idempotency_key: git:<B>`: still
  ineligible (webhook resolves B to Codex).
- **T5** per-path boundary: a cloud commit C the webhook attributes to `claude-code-cloud`, restricted seal listing x and an extra z;
  expected eligible, x bounded by C's seq, z dropped and reported, and C's grouped key seq taken from the webhook seal, not the
  restricted event.
- **T6** rule 0 (issue #166): an ineligible `committed` event from an ordinary pinned credential naming B and x adds no path to B's union
  in `prepareAttributionContext`; two eligible genuine seals of one key still union their paths.
- **T7** a restricted seal with no webhook seal: reported as a claim; dual witness unchanged.
- **T8** D2 producers: the hook with the option leaves `on_behalf_of` absent for `noreply@anthropic.com` and sets the discriminator;
  the laptop case (human author address) is byte-identical except the discriminator; the webhook adds `github:<login>` for a `User`
  sender and nothing for a non-`User` sender.
- **T9** the verifier contract: an old withheld `/2`-signed seal with author `noreply@anthropic.com` and no discriminator verifies with
  legacy re-derivation and the original `on_behalf_of` (N§4.2's compatibility fixture, built from a sealed event's recorded shape); a
  new seal with `agent-address/1` verifies with the new rule; an unknown value yields no substitution and a reported mismatch.
- **T10** the one-run flag: parses, merges with the file list, flags win on a duplicate stamp, malformed value is a usage error; Q6's
  shape runs with the flag and an empty file list.
- **T11** the push guard: refuses the four `main` forms under `CLAUDE_CODE_REMOTE=true`; allows a feature-branch push; is inert without
  the variable. Run the script directly with synthetic stdin.
- **T12** the stamp-in-both-lists error, in reconcile and attribution-context.
- **T13** the setup script is self-describing: it prints its own sha256 and contains no 43-character base64url run (the Q3 shape).

## 3. Acceptance, in order

1. `npm run build`, then the **full** suite with the scratch environment inline on every run: `RETRACE_DB=<tmp> RETRACE_URL= RETRACE_TOKEN= npm test`
   (and the worker suite after `rm -rf apps/worker/.test-dist`, issue #161).
2. Doctor READY from the worktree (`node <primary>/packages/mcp-server/dist/doctor.js doctor`), retried to READY on a transient fetch failure.
3. The pull request body states: class S and (a); the ledger count of §1.4; the sha256 of `scripts/cloud/setup.sh`; the answer to §6's
   items the builder had to decide; every T id and its file.
4. Commits carry the builder seat's trailers in one final paragraph; every changed file is logged as an edit before its commit (agent-rules 3, 9).

## 4. What the builder must not do

- No minting, no `retrace-admin` against the live Worker, no `wrangler`, no deploy, no publish, no change to any cloud environment, no
  secret in any file, output or transcript. The B4 step script is the coordinator's, written later under agent-ops 16.
- No change to `docs/agent-rules.md`, `docs/owner-protocol.md`, `CLAUDE.md`, `docs/team-roles.md`, `docs/agent-ops.md`, this repository's
  `.retrace.json`, or any project policy document.
- No `git commit -a`, no `git add -A`; `git commit --only <paths>` (agent-ops 2). No push to main. No pull request merge.
- No Task sub-agents on other models; the model the events claim is the model that did the work. Scratch environment inline on every test
  or script run (copilot-cli-builder-lessons). Never send into another pane.
- No edit to merged design notes; a discrepancy with the note goes on the pull request and stops the line it affects.

## 5. Sequencing

B2 merges on its gate → B3 (Jordan publishes the CLI; the setup script's version placeholder is filled in that go) → B3b (Jordan deploys
the Worker with the new resolver and reads the version back) → B4 (minting and the environment, step scripts outside Orca) → B4b
(owner-protocol §8) → B5 (P3, N§7) → B6. Nothing in B2 is live until B6. If P3 fails Q1 or Q2, D1 is not buildable as designed and
the question goes back to Jordan (N§8).

## 6. Open items the gate should settle (each with the coordinator's position)

- **(a) Issue #166 inside B2.** Position: yes. The union loop at `attribution-context.ts:119–120` is the loop B2 must change for
  restricted events anyway; one change, one gate, one test (T6). Against: it widens a class (a) build. If the gate says no, T6 and
  rule 0 move to a separate class S pull request and B2 keeps only the restricted-event restriction of that loop.
- **(b) The live owner-login path.** B2 leaves `PolicyBody.trusted_hook_stamps` and `classifierCaptureSeals` unchanged, so a cloud
  restricted seal is not a seal for owner-login capture windows and cloud commits are agent commits seen by the webhook there.
  Position: correct for v1; a restricted list in the policy document is its own class (a) change after P3.
- **(c) The builder.** Position: **github-copilot** (Copilot CLI, `gpt-5.6-sol`, effort high) in a fresh built worktree, launched without
  allow-all, `wrangler` and `gh pr merge` denied (as `~/launch-copilot-132.sh`), with Codex as first reviewer; cursor-agent is capped
  until 2026-10-30 and Codex is the reviewer the gate needs. Jordan may reassign.
- **(d) `.mcp.json` path A committed first** (§1.6). Position: yes; P3's Q5 edits one line to try B.
- **(e) The known-address constant** (§1.4). Position: a constant in code, not a policy field, until a second address is observed.
- **(f) The hook's discriminator on laptop seals.** Position: every hook seal carries `principal_rule` once B2 ships; laptop output is
  otherwise unchanged (T8). A reviewer may prefer the discriminator only where the rule changed the result; the gate decides.

## 7. Roles

Author of this brief and merger: claude-code (coordinator). Gate for the brief: Codex (first), NOOA, Grok, then the coordinator's
merge-readiness; Jordan's merge go. Builder: §6 (c). Gate for the code pull request: Codex first, NOOA and Grok, then the coordinator's
last review (not merge-readiness: the coordinator did not author the code). Publish, deploy, minting and the environment: Jordan (B3, B3b, B4).

## 8. Record

| what | event |
|---|---|
| Cloud-seat note v2 merged (`3354b3ed`, PR 159) | hook `evt_2e734683d333439199d28838c219c1ee`, outcome `evt_a00c87df7f7f44cc91f0d9d3a3170c47` |
| PR 159 gate: Codex r2, NOOA r2, Grok r1 (G-L1) | `evt_5c68b86113354b95b4d0bb95b86b948d`, `evt_9cf1dd1966bb421ab19ea9189919a2a1`, `evt_79a8ed07639346798b5697511a419126` |
| Gate check and G-L1 disposition | `evt_ad155d96c96e4059b5366861bd5a3243` |
| Issue #166 filed | `evt_8ea284e1cc1149c8a2cae5f52e27205b` |
| Go for this brief | `evt_a7881da7f61140f2a542461f95bf4e0c` |
