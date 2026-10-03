# Claude Code cloud seat: a second witness and a true principal for hosted commits (design note v2)

**Status:** v2, 2026-10-03, by claude-code (author session `6ae38fcd`, spec author; `claude-opus-5-5`, model source
harness-runtime). **Not built.** Class (a) under agent-rules 12: it defines a new seat, a credential's custody, a
restricted capture policy and a change to how commit actors are resolved.
- v1, 2026-10-02, on Jordan's signed go `evt_8e27cbf5b429419fa9b0fa7546e0ddfb` ("Go on your recommendations for 1 & 2,
  respectively", received 16:28 MDT / 22:28Z); PR 159 at `45309af9`.
- v2, 2026-10-03, the fix round on Jordan's go `evt_be6f7cb96342473baebcc310865ee961` (item 2), relayed by the coordinator's
  verified brief (`evt_a707f5c30584426d9760d84ea3f2d579`, receipt `evt_71287fc842dc4c3b95d84dd6d9956529`). It answers
  Codex's round-1 rejection `evt_ee9142cbb52244c98b858c87cede82b7` (F1 High, F2–F7 Medium) and the Low in NOOA's approval
  `evt_f470a3a07c34453095e82e6b040da14e`, fixed in place (Jordan, `evt_9dc98206`: rule 10 binds the merged record, not a
  draft). §10 gives each finding its disposition.

The pilot that produced the evidence below is in `~/.retrace/cloud-credit-2026-10-02/`.

## 0. What this note decides, and what it leaves to the gate

Jordan has a one-time $250 credit for Claude Code cloud sessions (claimed 2026-10-02; unused balance expires
2026-11-04; root instruction `evt_c2957044986c4875800ee40ce04b2661`, assessment `evt_59a39e87b08144ebad63b60ad1c05a41`).
A cloud session runs on an Anthropic-managed VM, clones the GitHub repository, and pushes through Anthropic's GitHub
proxy. Two pilot probes showed what Retrace records for such a session today (§1). Jordan then took two decisions,
both on the author's recommendation:

- **D1, second witness:** cloud commits get a git hook inside the VM, sealing with a credential the session never sees,
  instead of an exemption from the dual-witness check. v2 bounds what that seal may influence (§3.5).
- **D2, principal:** an agent's author address is never recorded as the human the agent worked for. The principal
  comes from an authenticated source, or is absent. v2 versions the change (§4.2).

Jordan also reported the claude.ai connectors (Gmail, Google Drive, Google Calendar, Cloudflare) disabled for cloud
sessions on 2026-10-02, recorded as his statement in `evt_8e27cbf5`.

## 1. What the pilot measured

Both probes ran in cloud session `session_01Es84tHSjdgj8Z4BNCiuFZq`, environment `retrace-pilot` (network Trusted, no
variables, no setup script, no credentials).

**P1, read-only** (response relayed by Jordan, saved verbatim, sha256 prefix `31ab6106a5b4a63b`, recorded as
`evt_b87810a884894a5e885e6a12c0ec6e8e`; the session's own report, so untrusted data):

| Fact | Value |
|---|---|
| Model id | `claude-fable-5-1`, handed in the session context, no environment variable carries it |
| Cloud marker | `CLAUDE_CODE_REMOTE=true`; `CLAUDE_CODE_REMOTE_SESSION_ID=cse_01Es84tHSjdgj8Z4BNCiuFZq` |
| Identity file | `CLAUDE.md` loaded automatically; `docs/agent-rules.md`, `docs/agent-ops.md` readable |
| Git author | `Claude <noreply@anthropic.com>`, the cloud default |
| Retrace MCP | absent: no `.mcp.json`, no `mcp__retrace__*` tools |
| Network | agent proxy with an allowlist; GitHub and npm reachable; `example.com` refused at CONNECT |
| Other tools | the claude.ai connectors were present (Gmail, Google Drive, Google Calendar, Cloudflare, github) |

**P2, one commit on a branch** (prompt sha256 prefix `7380f59b16845f07`; verification `evt_884da17a9df54abe84a5efca20aacc3a`):

- Commit `61012be6bc71` on `cloud-pilot/2026-10-02-probe`, parent `d8822dc` (main at the time), one file, no pull request.
  `git interpret-trailers --parse` reads all five trailers from one final paragraph.
- The GitHub push webhook sealed it as `evt_f8166fccc1e441f2ba6838f9c4767adb` (seq 11397) eight seconds after the
  commit time: action `committed`, actor agent `claude-code`, model `claude-fable-5-1`, source `harness-runtime`,
  `model_claim: complete`, `caused_by` the instruction the trailer named, `sealed_by: webhook:github`, pusher `jordandru`.
- **`on_behalf_of` was recorded as `noreply@anthropic.com`.** `resolveCommitActor` copies the commit author's email into
  `on_behalf_of` (`packages/core/src/commit-actor.ts`, the `agentId` branch and `coauthorActor`). The principal is Jordan.
- `retrace-export reconcile --since d8822dc` over that one commit: `ok: false`. Its only failure is
  **`producer_disagreement`**: an agent commit sealed only by the webhook fails by default (`reconcile.ts`, the
  dual-witness branch), because no git hook ran on the committing machine. The predicted `uncovered` warning also
  appeared. (Report sha256 prefix `d2ec24adc4a625b7`; signed scoped export `9d574c71fe0c676f`.)

**A limit of the pilot itself.** Both probe prompts carried `JD … JD` and were pasted by Jordan into the cloud prompt
box. Owner-protocol §1 scopes the envelope to Orca panes and §5 recognises only a pane's direct input, so that text was
not a recognised owner envelope in the cloud session. The probes are evidence of what the cloud harness records. They
are not a precedent for a cloud instruction channel, which §2.4 leaves undefined.

## 2. The seat

### 2.1 A new actor id: `claude-code-cloud`

A cloud session is the same harness as the laptop seat, but it cannot be the same seat. Agent-rules 13 allows one
credential per seat and forbids copying a token. Putting the laptop seat's token into Anthropic's credential store
would copy it, and minting a second token for `claude-code` would break the one-credential rule. So the cloud session is
its own seat, with its own pinned credential and its own actor id. The admin onboarding text says "The runtime or
sandbox is not a separate actor." (`packages/mcp-server/src/admin.ts`, `renderAgentOnboarding`). That holds for a harness
with one credential. Here the separate actor follows from custody, not from the sandbox.

### 2.2 The credential and where it lives

- **Issuance needs code, not only a harness name (B2).** `add-agent` builds the token-only shape in
  `planAgentCredential`, then calls `mintProducerKeys`, and `shouldMintProducerKey` returns true for any pinned agent
  except `openclaw` and `ci-*`. Unchanged, minting `claude-code-cloud` would add a `public_key`, `require_signature: true`
  and a local private-key path, and every unsigned write would get a 401. B2 therefore:
  - adds `claude-code-cloud` to `HARNESSES` and to the no-key exception in `shouldMintProducerKey`, beside `openclaw`;
  - issues it with no `public_key` and no `require_signature`;
  - gives it its own onboarding output that names the cloud environment's API-credential dialog, writes no token into
    any MCP environment block, and contains no token at all;
  - tests the final credential `add-agent` writes, and an unsigned `POST /events` accepted on it, not only
    `planAgentCredential`.
  No private key is ever copied into the VM.
- Final shape: `trust: "pinned"`, actor `{type: agent, id: claude-code-cloud, on_behalf_of: jordansboxing@gmail.com}`,
  `projects: ["retrace"]`, principal human `jordansboxing@gmail.com`, no model pin, no `public_key`, no `require_signature`.
- It lives in the Worker secret, like every credential (agent-ops 13), and in the cloud environment's **API credentials**
  (Max plan): type Bearer, header `Authorization`, prefix `Bearer`, allowed website `retrace-api.slcwitit.workers.dev`.
  Anthropic's agent proxy attaches it to requests for that host after they leave the VM. Per Anthropic's documentation,
  the value never reaches the model, its commands, or the session's environment. That is a vendor claim. Q3 checks
  only the bytes a session can inspect.
- It never goes in the environment's variables, its setup script, the repository, or a transcript.
- **One credential for the host.** The cloud docs say the proxy sends only one of two credentials whose hosts overlap
  without matching exactly, and they do not describe two for the same host. So the seat's MCP traffic and its git hook
  share this single credential. §3.3 and §3.5 state what that costs and how it is bounded.
- **The minting step (B4)** puts a secret value in play, so it runs under agent-ops 16 as a script the coordinator writes
  and Jordan types outside Orca. The token reaches the environment dialog, a browser form, through the Windows clipboard.
  The script:
  - takes nothing secret on argv and passes the value through stdin;
  - disables shell tracing;
  - checks that Windows clipboard history and sync are off before copying, and stops if it cannot tell;
  - asks Jordan not to let the browser save the field;
  - clears the clipboard and shreds the `0600` onboarding file on success, on failure and on cancel.

  Shredding one file does not erase every copy: filesystem snapshots, scrollback, process memory and browser form state
  are possible sinks. Their existence is stated, not evidence that a leak happened. This step is the weakest point of
  the design.

### 2.3 Tier: pinned identity, no producer signature

The VM can hold no private key that the model cannot read, and the proxy attaches a bearer header but cannot sign.
So the seat has **no producer key**. Every event it writes is server-stamped `sealed_by: pinned:<credential name>` with
`producer_sig_verdict: none`. This is a departure from agent-rules 7 ("one credential, one producer key"). A design note
does not enact it: agent-rules win over identity files and team-roles. **B6 includes an agent-rules amendment (class a)**
that enacts a bounded exception for this one seat:
- it builds only;
- it never reviews or merges;
- it sends no agent-rules 15 pane messages (a receiver must refuse an unverified sender anyway);
- its only GitHub writes are pushes to non-main branches (§6).

### 2.4 The identity block and the instruction channel

A cloud session loads the repository's `CLAUDE.md` automatically (P1), and today that file would tell it to be
`claude-code`. This pull request adds one clause: when `CLAUDE_CODE_REMOTE` is `true`, the session must not adopt the
`claude-code` identity. Until the seat is live, it reads and reports only. It makes no commit, no push to any branch
(main included), no pull request and no GitHub comment, and the clause has **no exception**.

`CLAUDE_CODE_REMOTE` is a selector the harness sets (observed in P1), not authentication. Once the seat is live, the
identity boundary is the server pin, which stamps `claude-code-cloud` whatever the model writes.

**The cloud instruction channel is undefined, and v2 does not define it.** Owner-protocol §1 and §5 recognise the
envelope only on an Orca pane's direct input. Any cloud write, including P3's probe commit, needs a channel by which the
owner's instruction reaches the cloud session with authority. That is an owner-protocol change, and it can be made only
through §8: a JD-signed instruction, the class (a) gate, and Jordan merging personally. It is step **B4b**. Until it
merges, the clause stays read and report only. When it merges, any branch exception it grants is limited to the
specific commit and push it authorises, on a named non-main branch.

## 3. D1: the second witness

### 3.1 Mechanism

The environment's setup script (cloud docs: runs as root before Claude Code launches, cached as a disk snapshot for
about seven days) installs the packed CLI at a pinned version and points git at Retrace's hooks system-wide
(`git config --system core.hooksPath <dir>`, the same `post-commit` and `post-merge` scripts `retrace-git install`
writes). `core.hooksPath` is used because the order of the clone and the setup script is not documented (Q4). The
environment's variables, none of them secret:

| Variable | Value | Why |
|---|---|---|
| `RETRACE_URL` | `https://retrace-api.slcwitit.workers.dev` | the Worker |
| `RETRACE_PROJECT` | `retrace` | |
| `RETRACE_AUTH` | `proxy` | new (B2): the egress proxy authenticates, so the hook sends no token |
| `RETRACE_ENV` | `claude-cloud` | the hook stamps `location.environment` from this; the default would claim `local` |
| `RETRACE_DEVICE` | `claude-cloud` | otherwise the VM's hostname is sealed into hash-covered bodies (`docs/reference.md`, the `device` row) |

The setup script's text lives in the repository (B2) and is pasted into the dialog byte-for-byte. Its sha256 goes on the
ledger event that records the configuration.

### 3.2 Code this needs (B2)

- **`RETRACE_AUTH=proxy` in the hook.** Today `resolveHookToken` throws when `.retrace.json` names a credential that is
  not on disk, and this repository's `.retrace.json` names `retrace-git`. Under `RETRACE_AUTH=proxy` the hook skips the
  credential lookup and sends no `Authorization` header. It refuses that mode when `RETRACE_URL` is unset, and it does not
  sign. Any other value of `RETRACE_AUTH` is an error, never a fallback.
- The MCP client needs no change: `retraceHeaders` omits `Authorization` when no token is set (`remote-store.ts`).
- The issuance changes in §2.2.
- **The restricted capture policy in §3.5**, in reconcile and in the shared capture code, with its tests.
- The D2 change in §4, versioned.
- A CLI flag that supplies a restricted stamp for one run (`--restricted-hook-stamp <stamp>=<actor>`), so P3's Q6 can
  run before B6 makes the configuration permanent.

### 3.3 What the cloud hook seal proves, and what it does not

- What is authenticated is **the credential's assertion**: a holder of the cloud credential said this sha was committed,
  with these files, parents, trailers and `caused_by`. It does not prove that a hook executed, or when; the timestamp is
  the sender's. Under the pinned credential, the Worker stamps the agent id and principal itself.
- It is **not independent of the model.** The proxy attaches the credential to every request for the Worker host from
  any process in the VM, so the model could post a hook-shaped `committed` event with `curl`. On the laptop the hook's
  token sits in a file every seat is forbidden to read (agent-rules 13). That is policy, not prevention, but it is a
  boundary the cloud seat does not have.
- The GitHub webhook stays the only witness independent of the VM. What the pair adds is the comparison: an amend or
  rebase after the hook ran, a hook that did not run, and a trailer that names the wrong seat all become findings.
- **v1 overstated what this seal could safely be trusted with** (Codex F1). Trusted as a general hook stamp, the
  assertion could name another seat's commit and an unrelated path, and move that path's capture window. §3.5 is the fix.

### 3.4 Expected reconcile result once live

For a cloud-authored commit, the restricted seal and the webhook seal agree on sha and on the actor
`claude-code-cloud`, so `producer_disagreement` clears. `uncovered` clears only when the seat's MCP server logged the
edits before the commit (agent-rules 9). A cloud commit whose trailer names another seat gets no eligible restricted
seal under §3.5 rule 2. It reads as an agent commit seen only by the webhook, which fails by default.

### 3.5 The restricted capture policy (F1)

The cloud stamp is **never** added to `reconcile.hook_sealed_by` or `attribution.repositories[].hook_sealed_by`. It goes
in a new, separate list, `restricted_hook_stamps`, under both. Each entry pairs one exact stamp with the one actor it may
seal for:
`{ "stamp": "pinned:retrace · claude-code-cloud for jordansboxing@gmail.com", "actor": { "type": "agent", "id": "claude-code-cloud" } }`.

A committed event carrying a restricted stamp counts as a hook seal only when all of these hold:

1. **Identity.** Its `idempotency_key` is exactly `git:<full sha>`, and that sha equals the commit its single `commit:`
   artifact names. A missing key, or a key for another sha, is ineligible.
2. **Authorship, checked against GitHub.** An HMAC-stamped `webhook:github` push seal exists for the same sha in the
   same snapshot, and the actor the webhook resolved is the entry's actor. A restricted seal for a commit that GitHub
   attributes to another seat, or that GitHub never delivered, is not a seal. It is reported as a claim.
3. **Paths, checked against GitHub.** The paths it contributes are the intersection of its own path artifacts and the
   webhook seal's file list. Paths the webhook does not list are ignored and reported.
4. **Boundary.** Its seq may set the commit's capture boundary only for those intersected paths.

These rules apply in both consumers:
- **`reconcile`**, through `isHookSeal` and the seal maps;
- **the shared capture code**, through `captureSealEligible` and `captureSeals` in `capture.ts`, which
  `attribution-context` uses for attribution windows.

`attribution-context` also unions paths from every event that names a sealed commit. For restricted seals that union
must take only rule 3's paths. The general union is an existing concern Codex noted, and it is out of scope here.

**Regression tests (B2), synthetic events only:**
- **Codex's sequence.** Codex edits x. Genuine hook and webhook seals for commit B by Codex touch y. A cloud-stamped
  event names B and x with no idempotency key. Genuine hook and webhook seals for commit A by claude-code touch x.
  Expected: A still reports `misattributed:fail`, and `reconcile.ok` is false. The restricted event moves no boundary.
- The same restricted event, given `idempotency_key: git:<B>`. Expected: still ineligible, because the webhook resolves
  B to Codex.
- A cloud-authored commit C whose webhook resolves `claude-code-cloud`, and a restricted seal listing one extra path.
  Expected: eligible, with the extra path dropped and reported.
- A restricted seal with no webhook seal. Expected: reported as a claim.
- Every case above, run through `attribution-context` as well as `reconcile`.

## 4. D2: the principal

### 4.1 Rule

An address known to be an agent's is never recorded as `on_behalf_of`. Under the new rule the resolver leaves
`on_behalf_of` absent for such an author, and each producer adds a principal only from what it authenticated:

- **Webhook:** `github:<sender.login>` when the push delivery's `sender.type` is `User`. The delivery is HMAC-verified and
  `sender` is inside it. This matches the existing human id form for GitHub-attested users (`githubActor`, `github.ts`).
- **Cloud hook:** the pinned credential's `on_behalf_of`, which the Worker stamps (`router.ts`, `resolveActor`).
- **Otherwise absent.**

The known agent addresses start with exactly what was observed: `noreply@anthropic.com`, the cloud default author in P2.
Authors whose name carries `[bot]` already resolve to a system actor when no trailer names an agent, and under D2 their
address is never the principal either. Any further address is added only with a sealed commit that shows it.

### 4.2 The verifier contract, versioned (F4)

`resolveCommitActor` runs in the hook, the webhook, the trailer classifier and offline verification. For a withheld
commit, `reconstructWithheldPayload` calls `rederiveCommitClaim` and `sameSignedActor`, which requires `on_behalf_of` to
match exactly. If substitution fails, verification tries the stored system actor, and a genuine `/2` signature then
**fails**. So changing the resolver unversioned changes a cryptographic verification result, not only a displayed
principal. And because B3 publishes the verifier, the contract covers other installations and every exported bundle,
not only this ledger.

Therefore:
- **Legacy re-derivation stays** for every event that does not carry the new discriminator. The resolver keeps its
  current behaviour as the default.
- **A versioned discriminator selects the new rule.** Producers that apply D2 put `principal_rule: "agent-address/1"`
  in `method.params`. The hook's copy is inside the signed payload, and the webhook's is server-stamped.
  `rederiveCommitClaim` applies the new rule only when that value is present, and the legacy rule otherwise. An
  unknown value fails closed: no substitution, reported.
- **A compatibility fixture (B2):** an old, withheld, `/2`-signed commit seal whose author is `noreply@anthropic.com`,
  without the discriminator. A newly built verifier must still verify it, with legacy re-derivation and the original
  `on_behalf_of`.
- **The ledger count** of withheld seals with an agent-address author measures local migration impact only. It is
  recorded in the B2 pull request, and it is not a condition for shipping.

### 4.3 What D2 does not fix

- **Two ids for one person.** Laptop commits record `jordansboxing@gmail.com`; GitHub-attested events record
  `github:jordandru`. Linking them is an existing gap (`policy.ts` maps logins to seats only).
- **A trailer-less cloud commit** would still seal as a human with id `noreply@anthropic.com`. Treating that address as
  evidence of an agent changes the trailer-consistency decision table (`docs/design/commit-trailer-consistency.md` §4).
  That stays open. A pinned agent credential may not record a human actor, so the cloud hook's write is refused, and the
  failure is visible.
- **The sealed record.** `evt_f8166fcc` keeps `noreply@anthropic.com`. A correction seal is Jordan's (agent-rules 14),
  and this note does not request one.

## 5. MCP in the cloud

Two paths. P3 chooses between them, and both keep the credential out of the VM.

- **A, the Worker's HTTP endpoint.** A repository `.mcp.json` entry of type `http` for `<worker>/mcp`, with no headers.
  The endpoint is lit (`RETRACE_MCP_ENABLED = "1"`) and accepts exactly this credential type: pinned, agent, one project
  (`docs/reference.md`, the OpenClaw section). There is nothing to build in the VM. The risk is that Claude Code's own
  connection may bypass the agent proxy: the cloud docs say the telemetry export Claude Code sends itself does.
- **B, a stdio wrapper.** A repository script that exits unless `CLAUDE_CODE_REMOTE=true`, then runs the packed CLI's
  `retrace-mcp` (installed by the setup script) with `RETRACE_URL` and no token. As a command the session runs, its
  traffic should pass through the proxy if Node's fetch in the VM uses the proxy (Q2).

The entry is named `retrace-cloud`. Laptop Claude Code sessions also see a project `.mcp.json`. The laptop seat's own
`retrace` server is local-scoped and wins on its name, and `retrace-cloud` goes in the laptop's
`disabledMcpjsonServers` (B6).

## 6. Guardrails

- **Network stays Trusted.** An API credential opens its own host. Full network is never used.
- **Connectors stay off** (Jordan, 2026-10-02). The Drive adapter maps Drive activity to the Google account that
  performed it (`packages/core/src/gdrive.ts`), so a cloud session using them would be recorded as Jordan himself.
- **Pushes to main.** The GitHub proxy blocks branch deletion but "doesn't limit which branches a push can update". The
  push arrives as Jordan's account (P2's pusher), and nothing on GitHub stops that account: the coordinator pushes every
  merge to main under it. Until the seat is live, the clause forbids every push. Once live, the agent-rules exception
  allows non-main pushes only. A repository `PreToolUse` hook refuses `git push` to `main` when `CLAUDE_CODE_REMOTE=true`
  (B2). It is a bypassable policy control, not a block. A webhook seal on `refs/heads/main` naming the cloud actor is
  evidence a reader of the ledger can notice. No automated alert exists, and a wrong trailer also defeats that filter.
  A doctor finding for it is future work.
- **GitHub writes in v1 are pushes to non-main branches only.** No pull requests, comments, reviews or Auto-fix. Pull
  requests for cloud work are opened by the signed laptop seat. The cloud seat's push declarations under agent-ops 19
  are logged through its MCP. They are unsigned, so they cannot satisfy `declarationPinned` (`owner-login.ts`, pinned and
  `verified`), and the push's account attribution stays `unresolved`. That is separate from the commit-trailer
  attribution, which the restricted policy governs. `declarationPinned` is not weakened. A cloud mechanism for pull
  requests would be its own design and gate.
- **The credit buys work only after B6 marks the seat live.**

## 7. P3: the probe that answers the open questions

P3 runs in `retrace-pilot` after B2, B3, B3b, B4 and B4b. Each line is a question, its check and the exact observation
that passes it. A failed line stops the build at that line, except as Q5 states, and the result goes in a dated
correction to this note.

| | Question | Check | Passes when |
|---|---|---|---|
| Q1 | Does the proxy attach the credential? | `curl` `GET /projects/retrace/head` with no header | 200, not 401 |
| Q2 | Does Node's fetch use the proxy? | the same request from `node -e` with built-in `fetch` | 200 |
| Q3 | Is the credential absent from the bytes the session can inspect? | see below | the exact observation below |
| Q4 | Do the hooks run in the session's clone? | `git config --show-origin core.hooksPath` and one authorised commit | a restricted seal exists for that sha |
| Q5 | Which MCP path works? | `retrace_instruct` and `retrace_log` through path A, then path B | A passes: A is used. A fails and B passes: B is used, a pass. Both fail: stop |
| Q6 | Do the producers agree, within the restriction? | reconcile over the P3 commit with `--restricted-hook-stamp` set to the minted stamp and `claude-code-cloud` | no `producer_disagreement`; `uncovered` only if no edit was logged; the §3.5 regression cases reproduce against the live configuration |
| Q7 | Is the principal right? | the raw webhook and restricted seals | `github:jordandru` with `principal_rule: agent-address/1`, and `jordansboxing@gmail.com`; never `noreply@anthropic.com` |

**Q3, redesigned (F5).** The session never holds the credential, so it cannot search for it. Two checks run instead:
- **Outside Orca, on the laptop**, Jordan's step script scans the approved setup script and the environment variables'
  values (both non-secret, copied byte-for-byte from the dialog) for the credential as a substring. It checks the raw
  value and its URL-encoded form, and prints only `found` or `not found` per file.
- **Inside the session**, a script takes every environment value and the inspected files. It extracts every maximal run
  of base64url characters 43 or more long, the shape of a minted token (`mintToken`: 32 random bytes, base64url). It
  prints the sha256 of every 43-character window of each run, never the run. The laptop script compares those hashes
  with the credential's sha256.
- Both scripts are tested first with dummy tokens: a quoted assignment `export X='TOKEN'`, `Authorization: Bearer
  TOKEN`, a URL `?token=TOKEN&x=1`, and a token adjacent to other base64url characters.
- **The pass observation:** "no 43-character base64url window in the inspected bytes hashes to the credential, and the
  laptop scan found no substring". It says nothing about bytes the session cannot inspect.

## 8. Build order

| Step | What | Who | Gate |
|---|---|---|---|
| B1 | this note and the `CLAUDE.md` clause | claude-code | class (a): Codex, NOOA, Grok, then the coordinator; merge on Jordan's go |
| B2 | hook proxy mode; issuance (§2.2); the restricted capture policy and its tests (§3.5); D2 with its discriminator and fixture (§4.2); the one-run stamp flag; setup and wrapper scripts; the `PreToolUse` guard | a builder from a brief the coordinator writes | code order; brief class (a) |
| B3 | publish `@retrace-dev/cli` with B2 | Jordan | publish |
| B3b | deploy the Worker with B2, so the webhook runs the new resolver; read back the deployed version (`npm run check-deploy` against `GET /api`, and the version id) | Jordan | deploy, its own go |
| B4 | mint the credential, update the Worker secret, add the API credential and the variables to the environment | Jordan, by step scripts outside Orca | credential and secret changes, one go each |
| B4b | owner-protocol change defining the cloud instruction channel (§2.4) | JD-signed instruction; Jordan merges personally | owner-protocol §8 |
| B5 | P3 | Jordan; claude-code verifies | — |
| B6 | the agent-rules amendment enacting the exception (§2.3); `restricted_hook_stamps` in `.retrace.json`; `CLAUDE.md`, `team-roles` and agent-ops entries marking the seat live; `retrace-cloud` in the laptop's `disabledMcpjsonServers` | claude-code | class (a); the laptop setting is local |

Nothing past B1 starts without its gate. If P3 fails Q1 or Q2, D1 is not buildable as designed, and the question goes
back to Jordan.

## 9. What this note does not claim

- That Anthropic's credential store keeps the token from the model. The vendor documents it; Q3 checks only inspected
  bytes.
- That a cloud seal proves a hook ran, or when. It is the credential's assertion (§3.3).
- That the cloud seat's events are producer-signed. They are not (§2.3).
- That the pilot's `JD` prompts were a recognised owner channel. They were not (§1).
- That any of §3, §4 or §5 works. Nothing here is built.

## 10. Changes in v2

| Finding | Disposition |
|---|---|
| Codex F1 (High), cloud stamp as a repository-wide hook | **Applied.** Never in the general lists. A restricted policy (§3.5) validates identity, authorship and paths against the webhook seal, in reconcile and in `capture.ts` / `attribution-context`. Codex's sequence and foreign-seat cases are regression tests. §3.3 now says the credential's assertion, not "sealed at commit time" |
| Codex F2, minted shape | **Applied.** §2.2 names the no-key exception, the absent `require_signature`, a token-free onboarding output, and tests of the final credential and an unsigned write |
| Codex F3, cloud pull requests | **Applied.** No cloud pull requests in v1, and the contradiction is removed (§6). Push declarations are logged, and their unresolved status is stated separately. `declarationPinned` is unchanged |
| Codex F4, verifier contract | **Applied.** Versioned discriminator `principal_rule: agent-address/1`, legacy fallback, unknown values fail closed, old-fixture test; the count is local impact only (§4.2) |
| Codex F5, Q3 false pass | **Applied.** Laptop substring scan plus in-session window hashing, dummy-token tests, pass renamed to the exact observation (§7) |
| Codex F6, Worker deploy | **Applied.** B3b deploy with version readback; Q6's one-run stamp flag; Q5's A-to-B fallback (§7, §8) |
| Codex F7, binding rules and channel | **Applied.** B6 names the agent-rules amendment (§2.3). The clause stays read and report only with no exception, and the channel is B4b under owner-protocol §8 (§2.4). Non-main scope is stated (§6) |
| NOOA Low, exception before the seat exists | **Applied** by dropping the exception (§2.4) |
| Codex review note, detection wording | **Applied.** §6 says a reader can notice; no automated alert exists |
| Codex review note, B4 script sinks | **Applied.** §2.2 lists stdin, tracing, clipboard checks, browser save, and clean-up on failure and cancel |
