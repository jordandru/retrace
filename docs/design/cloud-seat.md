# Claude Code cloud seat: a second witness and a true principal for hosted commits (design note v1)

**Status:** v1, 2026-10-02, by claude-code (coordinator seat, spec author; `claude-opus-5-5`, model source
harness-runtime), on Jordan's signed go `evt_8e27cbf5b429419fa9b0fa7546e0ddfb` ("Go on your recommendations for 1 & 2, respectively", received
16:28 MDT / 22:28Z). **Not built.** Class (a) under agent-rules 12: it defines a new seat, a credential's custody and a
change to how commit actors are resolved. The pilot that produced the evidence below is in
`~/.retrace/cloud-credit-2026-10-02/` (REPORT.md, HANDOFF.md, the probe prompts and their outputs).

## 0. What this note decides, and what it leaves to the gate

Jordan has a one-time $250 credit for Claude Code cloud sessions (claimed 2026-10-02; unused balance expires
2026-11-04; root instruction `evt_c2957044986c4875800ee40ce04b2661`, assessment `evt_59a39e87b08144ebad63b60ad1c05a41`).
A cloud session runs on an Anthropic-managed VM, clones the GitHub repository, and pushes through Anthropic's GitHub
proxy. Two pilot probes showed what Retrace records for such a session today (§1). Jordan then took two decisions,
both on the author's recommendation:

- **D1, second witness:** cloud commits get a git hook inside the VM, sealing with a credential the session never sees,
  instead of an exemption from the dual-witness check.
- **D2, principal:** an agent's author address is never recorded as the human the agent worked for. The principal
  comes from an authenticated source, or is absent.

Jordan also reported the claude.ai connectors (Gmail, Google Drive, Google Calendar, Cloudflare) disabled for cloud
sessions on 2026-10-02, recorded as his statement in `evt_8e27cbf5b429419fa9b0fa7546e0ddfb`. This note designs the seat around D1 and D2. The
reviewers decide whether the design is sound; the open questions in §7 are answered by a third probe before any code
is trusted.

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
  The trailer path works end to end for a hosted agent.
- **`on_behalf_of` was recorded as `noreply@anthropic.com`.** `resolveCommitActor` copies the commit author's email into
  `on_behalf_of` (`packages/core/src/commit-actor.ts`, the `agentId` branch and `coauthorActor`). The principal is Jordan.
- `retrace-export reconcile --since d8822dc` over that one commit: `ok: false`. Its only failure is
  **`producer_disagreement`**: an agent commit sealed only by the webhook fails by default (`reconcile.ts`, the
  dual-witness branch, `opts.dualWitness ?? "fail"`), because no git hook ran on the committing machine. The predicted
  `uncovered` warning also appeared, since no edit event covers the file. (Report sha256 prefix `d2ec24adc4a625b7`;
  signed scoped export `9d574c71fe0c676f`, two events, chain intact.)

Two findings are therefore real: a hosted agent's commits have one witness, and its principal is recorded wrong.

## 2. The seat

### 2.1 A new actor id: `claude-code-cloud`

A cloud session is the same harness as the laptop seat, but it cannot be the same seat. Agent-rules 13 allows one
credential per seat and forbids copying a token. Putting the laptop seat's token into Anthropic's credential store
would copy it, and minting a second token for `claude-code` would break the one-credential rule. So the cloud
session is its own seat with its own pinned credential, and its own actor id. The admin onboarding text says "The runtime
or sandbox is not a separate actor." (`packages/mcp-server/src/admin.ts`, `renderAgentOnboarding`). That holds for a harness
with one credential. Here the separate actor follows from custody, not from the sandbox.

### 2.2 The credential and where it lives

- Minted by Jordan with `retrace-admin add-agent retrace --member jordansboxing@gmail.com --harness claude-code-cloud
  --url https://retrace-api.slcwitit.workers.dev`. This needs `claude-code-cloud` added to `HARNESSES` in `admin.ts` (B2). The minted shape is fixed by
  `planAgentCredential`: `trust: "pinned"`, actor `{type: agent, id: claude-code-cloud, on_behalf_of:
  jordansboxing@gmail.com}`, `projects: ["retrace"]`, principal human `jordansboxing@gmail.com`, no model pin, no
  `public_key`.
- It lives in the Worker secret, like every credential (agent-ops 13), and in the cloud environment's **API credentials**
  (Max plan): type Bearer, header `Authorization`, prefix `Bearer`, allowed website `retrace-api.slcwitit.workers.dev`.
  Anthropic's agent proxy attaches it to requests for that host after they leave the VM. Per Anthropic's documentation,
  the value never reaches the model, its commands, or the session's environment. That is a vendor claim, and P3 checks the
  part a session can observe.
- It never goes in the environment's variables, its setup script, the repository, or a transcript. The variables and the
  script are readable by the session and by anyone who uses the environment.
- **One credential for the host.** The cloud docs say the proxy sends only one of two credentials whose hosts overlap
  without matching exactly, and they do not describe two credentials for the same host. So the seat's MCP traffic and
  its git hook share this single credential. §3.3 states what that costs.
- The minting step puts a secret value in play, so it runs under agent-ops 16 as a script the coordinator writes and Jordan
  types outside Orca. The token then has to reach the environment dialog, a browser form, without being printed. The step
  script copies it to the Windows clipboard, waits for Jordan's paste, and clears the clipboard. The clipboard is a known
  sink (agent-ops 16), and Windows clipboard history and sync keep copies, so the step requires both off and holds the
  value for that one paste only. `add-agent` also writes a `0600` onboarding file that holds the token (`docs/reference.md`, the OpenClaw section),
  which the step script shreds after the paste. This step is the weakest point of the design, and the reviewers should
  test it.

### 2.3 Tier: pinned identity, no producer signature

The VM can hold no private key that the model cannot read, and the proxy attaches a bearer header but cannot sign.
So the seat has **no producer key**. Every event it writes is server-stamped `sealed_by: pinned:<credential name>` with
`producer_sig_verdict: none`. That is a stated departure from agent-rules 7 ("one credential, one producer key"), and it
is the same tier the OpenClaw pilot accepted for the Worker's `/mcp` endpoint ("server-stamped pinned identity and does not
claim producer signatures", `admin.ts`). Consequences:

- The seat cannot send agent-rules 15 pane messages: a receiver must refuse a sender whose verdict is not `verified`.
  It has no pane to send from anyway.
- In v1 the seat builds only. It neither reviews nor merges, because its verdicts would carry no producer signature.

### 2.4 The identity block

A cloud session loads the repository's `CLAUDE.md` automatically (P1). Today that file would tell it to be `claude-code`.
This pull request adds one clause to `CLAUDE.md`: when `CLAUDE_CODE_REMOTE` is `true`, the session is not the
`claude-code` seat and must not adopt its id or trailers. Until step B6 in §8 marks the seat live, it reads and reports only, unless
the owner's signed instruction in that session names the branch it may push. The variable is set by the harness and
observed in P1, so the selection rests on harness-runtime evidence, not on the model's judgment. Agent-rules 7 says a
harness that can only load another seat's identity file does not join. Here the harness loads its own family's file,
and the block is chosen by a variable the harness sets. Once the seat is live, the server
pin enforces the id whatever the model writes, and a hook seal with a wrong `Retrace-Actor` disagrees with the webhook (§3.4).

## 3. D1: the second witness

### 3.1 Mechanism

The environment's setup script (cloud docs: runs as root before Claude Code launches, result cached as a disk snapshot
for about seven days) installs the packed CLI at a pinned version and points git at Retrace's hooks system-wide
(`git config --system core.hooksPath <dir>`, the same `post-commit` and `post-merge` scripts `retrace-git install`
writes). `core.hooksPath` is used because the order of the clone and the setup script is not documented (§7, Q4).
The environment's variables, none of them secret:

| Variable | Value | Why |
|---|---|---|
| `RETRACE_URL` | `https://retrace-api.slcwitit.workers.dev` | the Worker |
| `RETRACE_PROJECT` | `retrace` | |
| `RETRACE_AUTH` | `proxy` | new (B2): the egress proxy authenticates, so the hook sends no token |
| `RETRACE_ENV` | `claude-cloud` | the hook stamps `location.environment` from this; the default would claim `local` |
| `RETRACE_DEVICE` | `claude-cloud` | otherwise the VM's hostname is sealed into hash-covered bodies (`docs/reference.md`, the `device` row) |

The setup script's text lives in the repository (B2) and is pasted into the dialog byte-for-byte. Its sha256 goes on the
ledger event that records the configuration, so the record says what the VM ran.

### 3.2 Code this needs (B2)

- **`RETRACE_AUTH=proxy` in the hook.** Today `resolveHookToken` throws when `.retrace.json` names a credential that is
  not on disk (`git-hook.ts`, the "named-but-missing credential is an error" rule), and this repository's `.retrace.json`
  names `retrace-git`. Under `RETRACE_AUTH=proxy` the hook skips the credential lookup and sends no `Authorization`
  header. It refuses that mode when `RETRACE_URL` is unset, and it does not sign: `resolveHookProducerKeyFile` already
  returns nothing when the credentials file is absent. The remote-write guard is unchanged, because `.retrace.json` is
  present. Any other value of `RETRACE_AUTH` is an error, never a fallback.
- The MCP client needs no change for this. `retraceHeaders` already omits `Authorization` when no token is set
  (`packages/mcp-server/src/remote-store.ts`).
- `HARNESSES += "claude-code-cloud"` in `admin.ts`.
- After minting: the credential's exact stamp, `pinned:retrace · claude-code-cloud for jordansboxing@gmail.com`, added to
  `.retrace.json` under `reconcile.hook_sealed_by` and `attribution.repositories[].hook_sealed_by`. Reconcile counts a
  commit event as a hook seal only on an exact configured stamp plus the git shape (`reconcile.ts`, `isHookSeal`).
- A CLI release carrying the above (B3). The published `@retrace-dev/cli` is 0.2.0 (2026-09-25), which has none of it.

### 3.3 What the cloud hook seal proves, and what it does not

- It proves that a process in the VM sealed this sha at commit time, with the files, parents, model trailer and
  `caused_by` the commit carried. Under the pinned credential, the Worker stamps the agent id and principal itself.
- It is **not independent of the model.** The proxy attaches the credential to every request for the Worker host from
  any process in the VM. So the model could post a hook-shaped `committed` event with `curl`, and it would carry the same
  stamp. On the laptop the hook's token sits in a file every seat is forbidden to read (agent-rules 13). That is policy,
  not prevention, but it is a boundary the cloud seat does not have.
- The GitHub webhook stays the only witness independent of the VM. What the pair adds is the comparison: an amend or
  rebase after the hook ran, a hook that did not run, and a trailer that names the wrong seat all become findings.
- Sharing one credential between MCP logs and hook seals means a `committed` event from the MCP side would also look
  like a hook seal. Agent-rules 5 already forbids logging a commit through MCP. A finding that tells the two apart needs
  a marker the model cannot set, which the design does not have. This is stated, not solved.

### 3.4 Expected reconcile result once live

The hook seal, stamped `claude-code-cloud`, and the webhook seal, resolved from `Retrace-Actor: claude-code-cloud`, agree
on type and id. So `producer_disagreement` clears. `uncovered` clears only when the seat's MCP server logged the edits
before the commit (agent-rules 9). A cloud commit that still says `Retrace-Actor: claude-code` fails as
`producer_disagreement`, because the hook seal is stamped `claude-code-cloud`. That is the intended alarm.

## 4. D2: the principal

### 4.1 Rule

An address known to be an agent's is never recorded as `on_behalf_of`. The resolver leaves `on_behalf_of` absent for
such an author, and each producer adds a principal only from what it authenticated:

- **Webhook:** `github:<sender.login>` when the push delivery's `sender.type` is `User`. The delivery is HMAC-verified and
  `sender` is inside it. This matches the existing human id form for GitHub-attested users (`githubActor`, `github.ts`).
- **Cloud hook:** the pinned credential's `on_behalf_of`, which the Worker stamps (`router.ts`, `resolveActor`, the
  pinned branch). The hook sends none.
- **Otherwise absent.** An unknown principal is recorded as absent, never filled from the author line.

The known agent addresses start with exactly what was observed: `noreply@anthropic.com`, the cloud default author in P2.
Authors whose name carries `[bot]` already resolve to a system actor when no trailer names an agent. Under D2 their
address is never the principal either. Any further address is added only with a
sealed commit that shows it. No address is added on a vendor's description alone.

### 4.2 The constraint: the resolver is also a verification contract

`resolveCommitActor` runs in the hook, the webhook, the trailer classifier (`classify.ts`) and offline verification.
`rederiveCommitClaim` (`producer-sig.ts`) re-derives a withheld commit's actor from its signed `raw_message` and
`author`, and `sameSignedActor` requires `on_behalf_of` to match exactly before it substitutes the signed actor back. A
resolver change therefore changes re-derivation for every sealed event whose author is now treated as an agent address.
Such a mismatch fails closed, keeping the stored actor, but it would still change what verification reports for
history. Before the change merges, the builder measures and records the number of sealed events that both carry a
withheld claim decision and have an agent-address author. Zero means the change ships unversioned. Any other number means it ships
behind a profile version, the way `retrace-attribution/1` and `hash_v` are versioned. The measurement is a ledger query,
and its event is cited in the pull request.

### 4.3 What D2 does not fix

- **Two ids for one person.** Laptop commits record `jordansboxing@gmail.com`; GitHub-attested events record
  `github:jordandru`. Linking them is an existing gap (no login-to-principal map exists; `policy.ts` maps logins to
  seats only). This note does not close it.
- **A trailer-less cloud commit** would still seal as a human with id `noreply@anthropic.com` (`claimSource:
  human-author`). Treating that address as evidence of an agent changes the trailer-consistency decision table
  (`docs/design/commit-trailer-consistency.md` §4). That is a separate design question, left open. Under the cloud seat,
  the pinned hook seal would reject such a commit, because a pinned agent credential may not record a human actor, so
  the failure is visible.
- **The sealed record.** `evt_f8166fcc` keeps `noreply@anthropic.com`. A correction seal is Jordan's (agent-rules 14),
  and this note does not request one.

## 5. MCP in the cloud

Two paths. P3 decides between them, and both keep the credential out of the VM.

- **A, the Worker's HTTP endpoint.** A repository `.mcp.json` entry of type `http` for `<worker>/mcp`, with no headers.
  The endpoint is lit (`RETRACE_MCP_ENABLED = "1"`) and accepts exactly this credential type: pinned, agent, one project
  (`docs/reference.md`, the OpenClaw section). There is nothing to build in the VM. The risk is that Claude Code's own
  connection may not pass through the agent proxy: the cloud docs say the telemetry export Claude Code sends itself does
  not. If it does not, there is no credential and the server answers 401.
- **B, a stdio wrapper.** A repository script that exits unless `CLAUDE_CODE_REMOTE=true`, then runs the packed CLI's
  `retrace-mcp` (installed by the setup script) with `RETRACE_URL` and no token. As a command the session runs, its
  traffic should pass through the proxy, if Node's fetch in the VM uses the proxy at all (§7, Q2).

Either entry is also visible to laptop Claude Code sessions, because `.mcp.json` is project-scoped. The laptop seat's
own `retrace` server is local-scoped and wins on its name. The cloud entry is named `retrace-cloud` and is listed in
the laptop's `disabledMcpjsonServers`, so laptop panes never start it. Under path B it would exit at once anyway.

## 6. Guardrails

- **Network stays Trusted.** An API credential opens its own host, so the environment needs no Custom allowlist. Full
  network is never used.
- **Connectors stay off** (Jordan, 2026-10-02). With them on, a session could act in Gmail, Drive or Calendar under
  Jordan's OAuth. The Drive adapter maps Drive activity to the Google account that performed it
  (`packages/core/src/gdrive.ts`), so it would record Jordan himself.
- **No pushes to main.** The GitHub proxy blocks branch deletion but "doesn't limit which branches a push can update",
  and the push arrives as Jordan's account (P2's pusher). Nothing on GitHub stops that account from pushing to main: the
  coordinator pushes every merge commit to main under it. The `CLAUDE.md` clause forbids it. A
  repository `PreToolUse` hook refuses `git push` to `main` when `CLAUDE_CODE_REMOTE=true` (B2). That is bypassable, and
  the webhook seal on `refs/heads/main` with actor `claude-code-cloud` is the detection. A doctor finding for it is
  future work.
- **No GitHub writes besides pushes to its own branches in v1:** no pull-request comments and no Auto-fix. Auto-fix
  replies post under Jordan's account, and agent-ops 19 requires a declaration the seat can make only once its MCP works.
  Pull requests are opened by a laptop seat, or by the cloud seat once P3 shows its declarations land.
- **The credit buys work only after §8 marks the seat live.** Until then cloud sessions are probes run on Jordan's signed
  instruction.

## 7. P3: the probe that answers the open questions

P3 runs in `retrace-pilot` after B2 and B3 ship and the credential is added (B4). Each line is a question, its check
and the result that passes.

| | Question | Check | Passes when |
|---|---|---|---|
| Q1 | Does the proxy attach the credential? | `curl` `GET /projects/retrace/head` with no header | 200, not 401 |
| Q2 | Does Node's fetch use the proxy? | the same request from `node -e` with built-in `fetch` | 200 |
| Q3 | Is the value invisible to the session? | the session prints the sha256 of every environment value and of every word in the setup script; the laptop compares them with the credential's sha256 without printing either (agent-ops 16 form) | no match |
| Q4 | Do the hooks run in the session's clone? | `git config --show-origin core.hooksPath` and one commit | the hook seal exists |
| Q5 | Which MCP path works? | `retrace_instruct` and `retrace_log` through path A, then B | the raw event shows actor `claude-code-cloud`, `sealed_by: pinned:…`, the harness-runtime model |
| Q6 | Do the producers agree? | reconcile over the P3 commit with the new stamp configured | no `producer_disagreement`; `uncovered` only if no edit was logged |
| Q7 | Is the principal right? | the raw webhook and hook seals | `github:jordandru` and `jordansboxing@gmail.com`; never `noreply@anthropic.com` |

A failed line stops the build at that line, and the result goes in a dated correction to this note (agent-rules 10).

## 8. Build order

| Step | What | Who | Gate |
|---|---|---|---|
| B1 | this note and the `CLAUDE.md` clause | claude-code | class (a): Codex, NOOA, Grok, then the coordinator; merge on Jordan's go |
| B2 | hook proxy mode, `HARNESSES`, the D2 resolver and producer change with the §4.2 measurement, the setup and wrapper scripts, the `PreToolUse` guard, tests | a builder from a brief the coordinator writes | code order; brief class (a) |
| B3 | publish `@retrace-dev/cli` with B2 | Jordan | publish |
| B4 | mint the credential, update the Worker secret, add the API credential and the variables to the environment | Jordan, by step scripts outside Orca | credential and secret changes, one go each |
| B5 | P3 | Jordan pastes the probe; claude-code verifies | — |
| B6 | the stamp in `.retrace.json`; `CLAUDE.md`, `team-roles` and agent-ops entries marking the seat live; `retrace-cloud` in the laptop's `disabledMcpjsonServers` | claude-code | class (a); the laptop setting is local |

Nothing past B1 starts without the gate. If B5 fails Q1 or Q2, D1 is not buildable as designed, and the question goes
back to Jordan.

## 9. What this note does not claim

- That Anthropic's credential store keeps the token from the model. The vendor documents it; Q3 checks only what a
  session can see.
- That a cloud hook seal is independent evidence. It is the seat attesting its own commit (§3.3).
- That the cloud seat's events are producer-signed. They are not (§2.3).
- That any of §3, §4 or §5 works. Nothing here is built.
