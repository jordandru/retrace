# OpenShell seat: a sandboxed Claude Code builder on the Omarchy PC (design note v2)

**Status:** v2, 2026-10-05, by `claude-code` (third session, "OpenShell S1"; `claude-fable-5-1`, model source harness-runtime,
effort xhigh). **Not built.** Class (a) under agent-rules 12: it defines a new seat, the custody of three credentials, a sandbox
image and network policy, and an instruction convention.
- Written on Jordan's signed `evt_2d28d89f704b4b19b2806a3c64fee316` ("Let's start the OpenShell process on Omarchy", 03:32Z) and
  his signed answer `evt_754812ee53de44a28fd3882777113224` ("JD Go JD", about 03:52Z) to the W1 decision sheet
  (`~/.retrace/openshell-2026-10-01/s1/DECISIONS-W1.md`, sha256 `372decbd…`, event `evt_bb9e3644…`). The seat read "Go" as the
  sheet's three recommendations as written and the go for this note; the reading is recorded as the seat's, with his words,
  in `evt_165a4983…`, and one signed line overrules any of the three before this note is routed.
- The coordinator's brief for the S1 pane is `~/.retrace/ops-2026-10-04/brief-openshell-s1-r1.md` (sha256 `4436078fa6ace764…`,
  on Jordan's `evt_5925fdda…`). The scope it follows is `IMPLEMENTATION-SCOPE.md` (sha256 `9350e0f8…`, on `evt_f996ea94…`).
- **v2, 2026-10-05** (the same session, about 07:0xZ): the round-1 fix, all findings resolved in one round on Jordan's decision
  `evt_c22d7d53215242e0936a6bf32f80ada4` ("Go on A for both"; his go on this pane `evt_1c0b732c…`), the coordinator's gate check
  `evt_de4fadb6…` and fix-round routing `evt_91e3176cbf4b41c78b0677c83851f008`. Resolved: Codex C-M1–C-M4 (`evt_85554085…`, Medium),
  Grok G-L1–G-L2 (`evt_e96ab2a7…`, Low), NOOA L1–L2 (`evt_1104114c…`, Low). Fixed in place: an unmerged draft (rule 10 binds the
  merged record, Jordan `evt_9dc98206`). §11 gives each finding its disposition.
- **Corrections with step W6a** (rule 10; the W6a pull request, `claude-code`, `claude-opus-5-5`), three, each marked in place
  below: (1) 2026-10-05, §2.4's identity clause belongs to W6a, not W7; (2) 2026-10-05, §7 Q9's control toward `main` becomes two
  checks that cannot push; (3) 2026-10-06, the seat's local scratch files and who runs Q3's in-sandbox half (§7, after Q9's).
- **Correction, 2026-10-07, O1 (b)** (rule 10; Jordan's choice `evt_9e097bccc3a448d38b165a69cf1bf3ad`): §6's host rules restated for
  the gateway's own Unix account, with the isolation condition W5-0 verifies and what ends a W5 or W6 session; marked in place under
  that bullet.
- It is step W2 of that scope. Stage 1 (`docs/measurements/openshell-stage1-omarchy-2026-10-04.md`, PR 174) measured the custody
  on the PC with fake and scratch tokens. Stage 2 (`docs/design/sandbox-credential-proxy.md`, PR 175) decided A1–A4, all yes
  (`evt_fb8166ff…`). The template is `docs/design/cloud-seat.md` v2: the same shape, with OpenShell on hardware Jordan owns in
  place of Anthropic's proxy.

## 0. What this note decides, and what it leaves to the gate

- **The seat, as designed.** One Claude Code session would run inside an OpenShell v0.1.2 sandbox on the Omarchy PC (rootless
  Podman 6.1.1, account `stranger`), under its own actor id, `claude-code-openshell`, with a keyless pinned Retrace credential held
  by an OpenShell provider. The sandbox would only ever hold placeholders; the proxy would substitute the real value at the one host
  each credential is bound to. An Anthropic API key (the model) and a GitHub fine-grained token (pushes) would be held the same way.
  None of this runs yet (§8).
- **The three decisions Jordan took on 2026-10-05** (§1.1): D-a, Claude Code on an Anthropic API key, Claude Opus 5.5 by default;
  D-b, the cloud seat's bound, build only; D-c, dispatch only, the brief carried in the ledger.
- **What it leaves to later gates:** the W3 code brief's exact text; the W4 image, profiles and policy files (outlined in §5, §6,
  written as files in their own pull request because they govern what the seat can reach); the W5 custody scripts, which are
  Jordan's typed steps; the W6 probe results, which go into a dated correction here; the W7 rule text.

### 0.1 What differs from the cloud seat, in one table

| | Cloud seat (`claude-code-cloud`) | This seat (`claude-code-openshell`) |
|---|---|---|
| Proxy | Anthropic's agent proxy, which **adds** the header for one host | OpenShell's sandbox proxy, which **substitutes a placeholder** the client already sends (Stage 1, tests 2–4) |
| Hook authentication | `RETRACE_AUTH=proxy`: the hook sends no header | the hook sends the placeholder from `RETRACE_HOOK_TOKEN`; no new hook mode (§3.1) |
| Host account | Anthropic's VM | `stranger` on a PC Jordan owns; any process of that account can read the store (Stage 1 observation 5; Stage 2 §4.3) |
| Model credential | the Max plan, included in the cloud session | an Anthropic API key behind a second provider, metered |
| GitHub | pushes through Anthropic's GitHub proxy as Jordan's account | pushes through a third provider holding a fine-grained token, as Jordan's account |
| Instruction channel | an owner-protocol §10 for the cloud prompt box, **proposed in PR 176 (open)**; at this head, at the base and at main, `owner-protocol.md` ends at §9 and `cloud-seat.md` §2.4 still calls the cloud channel undefined | dispatch only; no owner-protocol change (§2.4) |
| TLS | Anthropic's | terminated by OpenShell's per-sandbox CA; ledger and API traffic in clear inside the gateway's process on the PC (Stage 2 §4.6) |

## 1. Evidence

| Source | What it shows | Where |
|---|---|---|
| Stage 1, measured on the PC | Landlock ABI 10 inside the sandbox; the sandbox held only `openshell:re…` placeholders; the proxy swapped them at the bound endpoint only and refused elsewhere (`credential_endpoint_mismatch`); a scratch Retrace server sealed a placeholder-only POST under the pinned identity; a gateway restart stops every sandbox and kills in-flight processes; the store's key-encryption key sits in the same account | PR 174; `evt_fe1baad0`, `evt_9751dd20`, `evt_3820bd45`, `evt_0af2013c`, `evt_b87a9a78` |
| Stage 2, decided | A1 placement policy for sandboxed seats, conditional on the destination never reflecting the header (§4.5); A2 laptop unchanged; A3 Option P waits; A4 limits: no producer key, no seat-to-seat separation on one host, the host account reads the store | PR 175, `8d77bc08`; `evt_fb8166ff…` |
| The cloud seat, designed and partly built | issuance of a keyless pinned credential (§2.2, built as B2 in `@retrace-dev/cli` 0.3.0); the keyless tier and its bounded exception (§2.3); the restricted capture policy (§3.5, built); D2 the principal rule (§4, built); the probe P3 (§7, not yet run); the push guard | `docs/design/cloud-seat.md`; `packages/mcp-server/src/admin.ts` lines 40–41, 80–86; `packages/core/src/capture.ts`, `reconcile.ts`, `attribution-context.ts` line 56; `scripts/cloud/guard-push-main.sh` |
| The code at main `8d77bc08` | the hook's token precedence: `RETRACE_HOOK_TOKEN` first, then the credential named by `.retrace.json`, then `RETRACE_TOKEN` (`git-hook.ts` lines 69–83); a missing key path means the hook does not sign (lines 87–100); the MCP client sends `authorization: Bearer <token>` when a token is set (`remote-store.ts` line 47); the Worker stamps `sealed_by` as `pinned:<credential name>` server-side (`router.ts` lines 294–299); the Worker's `/mcp` accepts pinned single-project agent credentials without `require_signature` (`apps/worker/src/mcp.ts`, `authenticateRemoteMcp`, lines 61–75) and caps a request body at 128 KiB (`RETRACE_MCP_MAX_BODY_BYTES`, line 38, enforced at lines 238–240); the event schema puts no length on `intent` (`schema.ts` line 248) | the files named |
| OpenShell's documentation at commit `021400be` | the `claude-code` profile (`ANTHROPIC_API_KEY`/`CLAUDE_API_KEY` as `x-api-key` to `api.anthropic.com`, plus `statsig.anthropic.com` and `sentry.io`, "drop the last two if your policy forbids that traffic"); the `github` profile (bearer `authorization`; `api.github.com` read-only; `github.com` clone and fetch only, "push (git-receive-pack) stays denied"); a profile may list several env var names for one credential; `--from-existing` reads the named variables from the creating command's environment; the substitution table (header value; Basic auth decoded, resolved, re-encoded); `--env` values are readable by the agent, so "to hide a secret from the agent, attach it through a profile-backed provider"; `sandbox create --from <image>`, `--cpu`, `--memory`; `sandbox upload`, `sandbox exec`, `sandbox connect`; CA certificates among the baseline paths a networked sandbox gets; TLS terminated "using a per-sandbox ephemeral CA" | `providers/claude-code.yaml`, `providers/github.yaml`, `providers/codex.yaml`; `docs/how-it-works/providers/overview.mdx` (lines 44, 400–401); `docs/how-it-works/sandboxes/overview.mdx`; `docs/how-it-works/policies/default-policy.mdx`; `docs/security/best-practices.mdx`; `docs/tutorials/github-push-access.mdx` |
| Claude Code's documentation, read 2026-10-05 | `ANTHROPIC_API_KEY` is sent as `X-Api-Key`; `ANTHROPIC_AUTH_TOKEN` and the setup token as `Authorization: Bearer`; the host list (`api.anthropic.com` required; `downloads.claude.ai` for updates and plugins; telemetry hosts optional) and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_AUTOUPDATER`; `.mcp.json` expands `${VAR}` in `command`, `args`, `env`, `url` and `headers`; MCP scopes local, project, user; `~/.claude/CLAUDE.md` loads before the project's `CLAUDE.md` | `code.claude.com/docs/en/authentication`, `…/network-config`, `…/mcp`, `…/memory` |
| The W1 sheet and its research | the options for D-a, D-b, D-c with costs; OpenShell's `codex` profile injects OAuth tokens into the sandbox as values (the reason a3 was declined); OpenAI's guidance that automation belongs on an API key | `DECISIONS-W1.md` §1–§3 |

### 1.1 The decisions, as taken

| | Decision | Taken | Overrule |
|---|---|---|---|
| D-a | Claude Code, authenticated to Anthropic with an API key held by an OpenShell provider; Claude Opus 5.5 is the default model, recorded verbatim per session under agent-rules 4 | `evt_754812ee…`, read as sheet option a1 (`evt_165a4983…`) | one signed line naming a2, a3 or a4 |
| D-b | build only: edits, tests, commits and pushes to non-main branches; no pull requests, comments or reviews; never merges; sends no pane messages | read as b2 | b1 (probes only) or b3 (pull requests, its own design) |
| D-c | dispatch only: the seat acts on agent-rules 15 briefs from the coordinator, verified against the ledger; the brief's text travels inside the ledger (carrier A); no owner-protocol change | read as c2-A | c1 (an owner-protocol §8 section) or c2-B (the brief uploaded by hand) |

## 2. The seat

### 2.1 A new actor id: `claude-code-openshell`

The sandbox runs the same harness as the laptop seat, and it cannot be the same seat. Agent-rules 13 allows one credential per seat
and forbids copying a token, so the laptop seat's token does not go into the PC's gateway store, and a second token for
`claude-code` would break the one-credential rule. The cloud seat settled this question (cloud-seat §2.1): a separate actor
follows from custody, not from the sandbox. The name follows the harness and the host, as `claude-code-cloud` does.

### 2.2 The credential and where it lives

- **Issuance needs code (W3), the same three edits B2 made for the cloud seat:** `claude-code-openshell` joins `HARNESSES` and the
  no-key exception in `shouldMintProducerKey` (`admin.ts` lines 41, 81); `HARNESS_CONFIG` gets an entry whose `file` is "an
  OpenShell provider on the PC's gateway"; `renderAgentOnboarding` gets a branch that names the provider type, the environment
  variable names in §2.2.3 and the non-secret variables in §3.1, writes no token into any configuration block and contains no
  token at all; tests cover the final credential `add-agent` writes and an unsigned `POST /events` accepted on it.
- **Final shape:** `trust: "pinned"`, actor `{type: agent, id: claude-code-openshell, on_behalf_of: jordansboxing@gmail.com}`,
  `projects: ["retrace"]`, no model pin, no `public_key`, no `require_signature`. The Worker stamps every event it writes
  `sealed_by: pinned:<the credential's name>` with `producer_sig_verdict: none`.
- **Where it lives:** in the Worker secret, like every credential (agent-ops 13), and in the OpenShell gateway's credential store
  on the PC, encrypted under a key-encryption key that sits in the same Unix account (Stage 1 observation 5). It never goes into
  the sandbox's environment, files or arguments, into the image, into the repository or into a transcript. The sandbox sees an
  `openshell:…` placeholder (Stage 1 test 2).
- **How it reaches the PC (W5, Jordan's hands).** The token is minted on the laptop by a typed script outside Orca (agent-ops 16,
  the B4 pattern: value on stdin, never argv, tracing off, the `0600` onboarding file shredded at the end). It does not touch the
  clipboard: the cloud seat's first token burned at exactly that step (`evt_8fc5c456…`), and the PC hand-off rule says the
  clipboard is not a channel. It travels once, over SSH, inside the same script: the laptop side pipes the value into an `ssh`
  command whose remote side reads it from standard input into a variable and runs
  `openshell provider create --name retrace-seat --type retrace-worker --from-existing` with that variable exported for that
  one command. `--from-existing` reads the profile's named variables from the creating command's environment (OpenShell
  `providers/overview.mdx` line 44), so the value is never an argument and never a file on the PC. SSH is on for that session and
  off after it (the G5 and G9 pattern Stage 1 ran). The script prints the provider name, the token's sha256 prefix and OK or
  FAILED, nothing else. The gateway store is the token's home on the PC.
- **2.2.3 The provider profile, `retrace-worker.yaml` (W4, kept in the repository):**

  | Field | Value | Why |
  |---|---|---|
  | `id` | `retrace-worker` | |
  | `credentials[0].env_vars` | `[RETRACE_TOKEN, RETRACE_HOOK_TOKEN]` | one credential, two names (the `claude-code` profile lists two names the same way): the MCP server reads `RETRACE_TOKEN`; the hook reads `RETRACE_HOOK_TOKEN` first (§3.1) |
  | `auth_style` / `header_name` | `bearer` / `authorization` | the shape `remote-store.ts` sends, and the shape Stage 1 measured |
  | `endpoints` | `retrace-api.slcwitit.workers.dev`, port 443, protocol rest, read-write, enforce | the one host the token is for |
  | `binaries` | `node` (the harness's MCP server and the hook) and `curl` (the raw verification reads of §2.4) at the paths the image installs them | least privilege: no other process reaches the Worker with the credential |

  The same file pattern holds for the other two providers (§5.2).

### 2.3 Tier: pinned identity, no producer signature

The sandbox can hold no private key that the model cannot read, and the proxy substitutes a bearer value but cannot sign (Stage 2
§4.1). So the seat is **keyless**: every event carries `producer_sig_verdict: none`. That departs from agent-rules 7, and a design
note does not enact it, and neither does a custody go (W5) or an operational go for the probe (W6): **the exception is enacted in
two class (a) steps before the seat writes anything** (§8). **W6a**, before the probe: a bounded *probe* exception, in B6's shape,
that permits exactly the probe's operations under the seat's pinned credential (writes to project `retrace`; one commit and one
push to one named non-main branch; no other GitHub write) together with the identity clause the seat needs (§2.4). **W7**, after
the probe passes: the standing exception for the seat's bound: it builds only; it never reviews or merges; it sends no agent-rules
15 pane messages; its only GitHub writes are pushes to non-main branches (§6). The bound is D-b as decided. Until W6a merges, the
seat may read and report only; a dispatch (§2.4) authenticates an instruction and enacts no rule.

### 2.4 The identity block and the instruction channel

**Identity.** The seat's identity block is a file in the repository, `sandbox/openshell/CLAUDE.seat.md` (W4), that the image copies
to the sandbox user's `~/.claude/CLAUDE.md`. Claude Code loads user instructions before the project's `CLAUDE.md` (the documented
load order), so the seat reads its own block first and the repository's identity file second. The repository's `CLAUDE.md` gets
one clause (W7): when the environment carries `RETRACE_SEAT=claude-code-openshell`, which the image sets, the session must not
adopt the `claude-code` identity; its actor id is `claude-code-openshell`, its rules are the same `docs/agent-rules.md` and
`docs/agent-ops.md`, and its bound is §2.3. `RETRACE_SEAT` is a selector, not authentication, like `CLAUDE_CODE_REMOTE` for the
cloud seat: the identity boundary is the server pin, which stamps `claude-code-openshell` whatever the model writes. Any other
harness that reads the file does not adopt it.
*Correction, 2026-10-05 (step W6a; the author's finding): v2 moved this clause into W6a (§2.3, §8) and left "(W7)" above
unchanged. Read W6a: the clause is enacted with the bounded probe exception, before the probe.*

**The instruction channel (D-c, c2-A).** Owner-protocol §1 and §5 recognise Jordan's envelope only on an Orca pane's direct input.
The sandbox's terminal on the PC is not one, and this note does not make it one. The seat is instructed by dispatch:

1. **The coordinator writes the brief on the laptop and seals it twice.** First an event whose `intent` is the brief's text,
   byte for byte (action `created`, the file as artifact). Then the agent-rules 15 `sent` event: the pointer's `text_sha256`, the
   brief's `brief_sha256`, the brief event's id as `brief_event_id`, the target `sandbox:claude-code-openshell`, and
   `enter_pressed_by` (Jordan at the PC, or Jordan over SSH during a session).
2. **The pointer is typed into the seat's attached session** (`openshell sandbox connect`): one line, at most 240 bytes,
   `CLAUDE-CODE … CLAUDE-CODE [sent-event <id>]` (agent-ops 18). The typist proves nothing and need not: the seat verifies the
   event, not the keystroke.
3. **The seat verifies before it acts**, with its own credential through the proxy: `GET /events/<sent id>` on the Worker (`curl`
   with the placeholder in the header; the proxy swaps it; a project-scoped read, the route Stage 1 test 4 used for its write)
   and the six checks of agent-rules 15 (action `sent`; `actor.id` `claude-code`; `sealed_by` `pinned:` the coordinator's
   credential; `producer_sig_verdict` `verified`; `text_sha256` equals the sha256 of the received line with the suffix removed;
   `brief_sha256` present). Then `GET /events/<brief event id>`, the `intent` bytes written to disk, their sha256 compared with
   `brief_sha256`. Only then does it log `received` and work. Anything less is a refusal: a `received` record naming the failure
   and no execution. The owner's envelope typed into the sandbox is text another party typed into a pane (§5): it is not an
   envelope there, and it is refused the same way. Jordan instructs the seat through the coordinator, as every builder is
   instructed today.
4. **What is unmeasured about carrier A.** The event schema puts no length on `intent`; the Worker's `/mcp` route caps a request
   body at 128 KiB, and the briefs this project writes run 3–10 KB. Whether the text survives the write and read byte for byte is
   exactly what the hash check measures (probe Q8). If it fails, carrier B (`openshell sandbox upload` by Jordan's hand, hashed
   against the `sent` event) needs no design change.

**What a sealed brief may contain (the content contract for carrier A).** A brief sealed as an event is ledger content for good.
The Worker's share routes return the selected events and exports to whoever holds an applicable share link, before any further
authentication, and an artifact share can include causal ancestors (`packages/core/src/router.ts` lines 764–815, the share
routes, especially 784–796). Carrier A is therefore **not a private channel**: the hash check authenticates the delivered bytes, not
their confidentiality. So a brief is sealed only when it is written to be share-safe: no secret value, private key or live bearer
URL (agent-rules 13 is the floor), and no operational, personal or proprietary detail whose disclosure to a share recipient would be
unacceptable. The coordinator checks the text against this contract before sealing and records the check on the brief event
(`method.params.share_safe: "checked"`); a brief that cannot meet it is not sealed: only its sha256 and a reference go on the
`sent` event, and its body travels by carrier B. A later amendment appends; it does not redact a sealed body. Revoking a share
does not retract copies already delivered. Every brief this project has written so far lives in the operator's folder, outside
the ledger; carrier A changes that for the briefs it carries, and this contract is the admission rule.

The seat's raw reads use its own credential because it holds no other, so "with its own credential" (agent-rules 15) holds for
the PC receiver's own read path without a new tool. That is a statement about this receiver's path, not a measurement (Q8 measures
it), and it does not close the laptop gap: `docs/design/sandbox-credential-proxy.md` §7 records that in a laptop pane the raw
verification reads run on the owner token from the pane's environment, and that gap stays open for the coordinator to route.

## 3. The second witness on the PC

### 3.1 Mechanism

The image installs the packed CLI at a pinned version and the hooks `retrace-git install` writes, and the sandbox environment
carries, none of it secret:

| Variable | Value | Why |
|---|---|---|
| `RETRACE_URL` | `https://retrace-api.slcwitit.workers.dev` | the Worker |
| `RETRACE_PROJECT` | `retrace` | |
| `RETRACE_HOOK_TOKEN` | the placeholder, injected by the `retrace-worker` provider | `resolveHookToken` returns it first (`git-hook.ts` line 74), **before** the `.retrace.json` `credential` lookup that would otherwise throw in a sandbox with no credentials file. The hook sends `authorization: Bearer <placeholder>`; the proxy swaps it at the Worker's host |
| `RETRACE_ENV` | `openshell-pc` | the hook stamps `location.environment`; the default would claim `local` |
| `RETRACE_DEVICE` | `omarchy-pc` | otherwise the sandbox's hostname is sealed into hash-covered bodies |
| `RETRACE_SEAT` | `claude-code-openshell` | the identity selector (§2.4) and the push guard's selector (§6) |

**No `RETRACE_AUTH=proxy`.** That mode sends no `Authorization` header (cloud-seat §3.2), which fits a proxy that adds one.
OpenShell substitutes a value the client already sends and adds nothing, so a header-less request would get 401. The placeholder
in `RETRACE_HOOK_TOKEN` is the whole mechanism, and **the hook needs no code change**. With no `RETRACE_HOOK_KEY_FILE` and no
credentials file, `resolveHookProducerKeyFile` returns nothing and the hook does not sign ("a missing path means do not sign"),
which is the keyless tier.

### 3.2 What the hook seal proves, and what it does not

As on the cloud (cloud-seat §3.3): the seal is **the credential's assertion** that this sha was committed with these files,
parents, trailers and `caused_by`. Under the pinned credential the Worker fixes the actor and principal itself. It is **not
independent of the model**: any process in the sandbox that runs one of the profile's binaries can send the placeholder to the
Worker's host and have it swapped, so the model could post a hook-shaped `committed` event with `curl`. The GitHub webhook stays
the only witness independent of the PC. What the pair adds is the comparison.

### 3.3 The restricted capture policy applies verbatim

The seat's stamp is **never** added to `reconcile.hook_sealed_by` or `attribution.repositories[].hook_sealed_by`. It goes in
`restricted_hook_stamps` under both (W7), as one entry pairing the exact stamp with the one actor it may seal for:
`{ "stamp": "pinned:<the credential's name as minted>", "actor": { "type": "agent", "id": "claude-code-openshell" } }`.
The stamp string is read back from the first event the credential seals (`sealed_by`, `router.ts` line 298), never typed from
memory. Cloud-seat §3.5's four rules (identity by `idempotency_key`, authorship checked against the webhook seal, paths
intersected with the webhook's file list, boundary only for those paths) are built in `capture.ts` and `reconcile.ts` and need
no change; the regression cases there are the regression cases here.

### 3.4 What reconcile shows once live, and what it does not

For a seat-authored commit, the restricted seal and the webhook seal agree on sha and on the actor `claude-code-openshell`, so
`producer_disagreement` clears. `uncovered` clears when the seat's edit declarations for the changed paths sit before the commit's
accepted ledger boundary (agent-rules 9). **That is a statement about ledger order, not about time, hook execution or authorship.**
`capture.ts` admits a restricted self-seal whenever the idempotency key, the sha, the commit artifact, the webhook's actor and the
paths match (lines 109–126), and `reconcile.ts` compares ledger sequence numbers, not Git commit times (lines 368–381). So a seat
could commit without any hook, declare its edits afterwards through its MCP server, post a matching `git:<sha>` self-seal, then
push: the webhook confirms the pushed commit and its actor, the self-seal is eligible, and reconcile reports `ok` with the paths'
coverage window ending at the forged seal. Codex reproduced exactly this against the built implementation with a synthetic fixture
(`evt_85554085…`, C-M3). What the pair proves is therefore the webhook-confirmed commit and actor, and edit declarations accepted
before a boundary the seat itself supplied; it does not prove that a hook ran, when the edits were declared relative to the commit,
or who authored them. The keyless tier accepts that limit (§2.3); it is stated here, not solved. Two verdicts are distinct:
`uncovered`, no qualifying declaration for a path, and `misattributed`, the only qualifying declarations belong to another seat
(`reconcile.ts` lines 381–395); another seat's declaration can clear the first while causing the second. A commit whose trailer
names another seat gets no eligible restricted seal, because the webhook resolves a different actor (`capture.ts` lines 119–126,
`reconcile.ts` lines 346–352), and reads as an agent commit seen only by the webhook, which fails by default.

### 3.5 Code this needs (W3)

- `admin.ts`: the harness entry, the no-key exception, the onboarding branch, with tests (§2.2). The same shape as B2.
- `scripts/cloud/guard-push-main.sh`: the selector becomes "`CLAUDE_CODE_REMOTE` is `true` **or** `RETRACE_SEAT` is
  `claude-code-openshell`", with a test row for each; the allowed shape and every refusal are unchanged.
- Nothing in the hook, the MCP server, `core` or the Worker. Smaller than B2.

## 4. The principal

Nothing new. D2 is built (cloud-seat §4, B2 in CLI 0.3.0, Worker deployed `ed9ebcb0`): the webhook records `github:jordandru` with
`principal_rule: agent-address/1`; the restricted seal carries the pinned credential's `on_behalf_of`, `jordansboxing@gmail.com`;
`noreply@anthropic.com` is never a principal. The seat's commit author is set by the image's git configuration to a name and
address that resolve to the agent, not to Jordan. Probe Q7 observes it.

## 5. The sandbox

### 5.1 The image (W4, `sandbox/openshell/Containerfile` in the repository, built on the PC with `podman build`)

Ubuntu 24.04 base; node (an LTS release, pinned); git and the GitHub CLI; `@anthropic-ai/claude-code` and `@retrace-dev/cli`,
both pinned by version; `curl`; the repository cloned at build time (public, read-only clone; the seat fetches at session start);
the hooks installed in that clone; `sandbox/openshell/CLAUDE.seat.md` copied to `~/.claude/CLAUDE.md`; a user-scope MCP entry for
`retrace-mcp` (§5.3); a settings file that puts `retrace-cloud` in `disabledMcpjsonServers` and installs the push guard as a
`PreToolUse` hook; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_AUTOUPDATER=1`. Everything the seat runs is in
the image, so the runtime policy opens no package registry. Resources at creation: `--cpu 2 --memory 3Gi`, an estimate for an
8 GB machine that also runs Omarchy, Podman and the gateway, to be measured in W6. The sandbox is created with the three
providers attached and `-- claude` as its canonical process, so `openshell sandbox connect` attaches to the harness. One build-time
detail: `retrace-git install` calls `loadCfg`, which resolves a hook token at install time (`git-hook.ts` lines 426–446), before
any provider exists; the Containerfile therefore runs it with a fixed, non-secret, meaningless `RETRACE_HOOK_TOKEN` that no server
accepts, and the provider's placeholder replaces it in the running sandbox's environment.

### 5.2 Three providers, three profiles (W4, in the repository beside the Containerfile)

| Provider | Profile | Credential, as seen by | Bound to | Binaries | Note |
|---|---|---|---|---|---|
| `retrace-seat` | `retrace-worker.yaml` (§2.2.3) | the sandbox: a placeholder in `RETRACE_TOKEN` and `RETRACE_HOOK_TOKEN`; the Worker: `authorization: Bearer <token>` | `retrace-api.slcwitit.workers.dev:443` | `node`, `curl` | the Retrace token |
| `anthropic-seat` | a copy of OpenShell's `claude-code.yaml` with `statsig.anthropic.com` and `sentry.io` removed and `binaries` set to the image's `claude` and `node` paths | `ANTHROPIC_API_KEY` placeholder; `x-api-key: <key>` at the API | `api.anthropic.com:443` | the harness | the model credential; `downloads.claude.ai` is not opened, and the CLI's update and plugin traffic is switched off |
| `github-seat` | a copy of OpenShell's `github.yaml` plus **one** rule: `allow: { method: POST, path: "/jordandru/retrace.git/git-receive-pack" }` | `GITHUB_TOKEN` placeholder; git's Basic-auth header decoded, resolved and re-encoded by the proxy | `github.com:443`, `api.github.com:443` (read-only, as shipped) | `git`, `gh` | a fine-grained token scoped to `jordandru/retrace`, contents read and write, nothing else. Basic-auth substitution is documented (`providers/overview.mdx` line 401) and unmeasured here: probe Q9 |

The network policy is the union of the three profiles' endpoints and nothing else. No `example.com`, no package registry, no
`downloads.claude.ai`, no telemetry host. A denial is logged by OpenShell; a harness that misbehaves on a denial is a W6 finding.

### 5.3 MCP on the PC

The seat's MCP server is the packed CLI's `retrace-mcp` over stdio, configured at **user scope inside the image**, with the
environment `RETRACE_URL`, `RETRACE_PROJECT=retrace`, `RETRACE_ACTOR=claude-code-openshell`,
`RETRACE_ON_BEHALF_OF=jordansboxing@gmail.com`, `RETRACE_ACTOR_LOCK=1`, and `RETRACE_TOKEN` inherited from the sandbox (the
placeholder). `remote-store.ts` then sends `authorization: Bearer <placeholder>`, swapped at the Worker's host. The model is not
pinned in the environment: the seat passes `actor.model` and `model_source: harness-runtime` on every call from the id its
context hands it (agent-rules 4), as this pane does.

Two paths this note does **not** take, and why:
- **The repository's `.mcp.json` entry `retrace-cloud`** sends no header. It exists for Anthropic's proxy, which adds one; behind
  OpenShell it would get 401. The image disables it.
- **An HTTP entry with `headers: { Authorization: "Bearer ${RETRACE_TOKEN}" }` in the repository's `.mcp.json`.** Claude Code
  expands `${VAR}` in headers, so it would work in the sandbox. But on the laptop `RETRACE_TOKEN` in a pane's environment is the
  **owner token** (Stage 2 §7), and a laptop session loading the project file would send it to `/mcp` (refused there as not
  pinned, but transmitted). No entry that expands a token goes into the repository. If probe Q5 finds the stdio path blocked, the
  fallback is the same HTTP entry **in the image's user-scope configuration**, never in the repository.

## 6. Guardrails

- **The bound (D-b):** edits, tests, commits in its clone; pushes to non-main branches only, each declared under agent-ops 19
  through its MCP server (unsigned, so the push's account attribution stays `unresolved`, stated as in cloud-seat §6); no pull
  requests, comments or reviews (no `api.github.com` write rule exists, so `gh` writes are denied by policy as well as by rule);
  never merges; sends no pane messages. Pull requests for its branches are opened by the laptop seat.
- **Pushes to main.** OpenShell's policy sees one endpoint, `git-receive-pack`, and cannot tell branches apart, so the policy rule
  that allows the push allows a push to any branch. What stops `main` is the push guard (a bypassable policy control, as
  cloud-seat §6 says) and the ledger: a webhook seal on `refs/heads/main` naming `claude-code-openshell` is evidence a reader
  notices. No automated alert exists. A doctor finding for it is future work, as it is for the cloud seat. **The residual, named:**
  the token plus repository-wide `git-receive-pack` access grants more ref authority than D-b authorises, and the guard, not the
  policy and not GitHub, holds the line; W5's custody go names this residual when the token is minted. Two alternatives were
  considered and are **declined for v1**: a GitHub App or machine identity for the seat, governed by a branch ruleset that nothing
  bypasses (a ruleset that exempts Jordan does not constrain a token acting as Jordan; this belongs with the per-seat GitHub
  identity work, `docs/design/github-owner-login-attribution.md` §6 step 5 and issue #82), and a push destination confined to a
  separate repository with coordinator promotion (two repositories to reconcile for one seat). Either can replace the residual
  later without changing the rest of this note. As on the cloud seat, a wrong trailer also defeats an actor-filtered search for a
  push to `main` (cloud-seat §6).
- **The GitHub token** is fine-grained, one repository, contents read and write, no other permission, held by the `github-seat`
  provider only, minted and rotated by Jordan (W5). The push arrives as his account, as every seat's push does today
  (agent-ops 19, issue #82).
- **The model credential** is an API key from an Anthropic Console account with a spend limit Jordan sets; it reaches
  `api.anthropic.com` only.
- **Host rules for the PC (W7, agent-ops entries):** no AI agent signed in on the host (`omarchy default agent`, a host-level
  `claude`) while a real token is in the gateway's store (Stage 2 §4.3); SSH off between sessions; a gateway restart kills
  in-flight work (Stage 1 test 5), so the seat commits often and the ledger shows what was lost; the gateway store is the token's
  home, and retirement is `openshell provider delete` on the PC plus `retrace-admin` retire and the Worker secret update on the
  laptop, by typed scripts; Docker on the PC stays unused (`compute_driver = "podman"`, Stage 1).
  *Correction, 2026-10-07 (Jordan's O1 choice (b), `evt_9e097bccc3a448d38b165a69cf1bf3ad`; the W5 plan's O1 and O2): the gateway
  runs under its own Unix account, not `stranger`, and the rule above applies to that account. No AI agent is signed in under the
  gateway's account while a real token is in its store. Agents, Orca and the workbench may stay signed in under `stranger` only
  while the agents' account is verifiably isolated from the gateway's, during a W5 or W6 session as well as between sessions: from
  `stranger` there is no read access to a credential, the store or its key; no write or replace access to the gateway's code, unit,
  profiles or configuration, or to a directory that holds them; and no usable path to control the gateway, root or any
  administrative function. Four checks are necessary examples of that condition, not proof of it: the gateway's account is reached
  only by its own password; `stranger` has no passwordless sudo; `stranger` is not in the `docker` group; and the gateway's account
  has no inbound SSH or Orca access outside a W5 or W6 session. Paths they miss include a gateway file or directory that `stranger`
  can write through a shared group or an ACL, the gateway account's Podman API socket, direct read access to the store and its key,
  and sudo, polkit or `machinectl` grants that one `sudo -n true` does not exercise. W5-0 verifies the whole condition with harmless
  fixtures before any real token reaches the store; if it fails, no real token goes in. Orca's remote server reaches an account the
  way SSH does, so the rule names both. A W5 or W6 session ends only when both hold: the temporary client's inbound authorization is
  revoked (the SSH authorized key that admits it, not merely a private-key file under the gateway's account, and any Orca grant),
  and every temporary access channel is closed and verified absent (authenticated SSH sessions, forwarding and multiplexed
  connections, and the Orca listener and its sessions). An Orca service that restarts or is socket-activated does not pass by being
  absent at one instant; until both hold, the session is not over. The commands are the W5 and W6 scripts'. "SSH off between
  sessions" now means that end state holds for the gateway's account. With the condition verified, SSH and Orca into `stranger` do
  not reach the store. Where this note names `stranger` as the gateway's account (§0, §0.1, §9), read the gateway's own account.*
- **TLS.** OpenShell terminates TLS with a per-sandbox CA and holds ledger and API traffic in clear inside the gateway's process
  on Jordan's own machine (Stage 2 §4.6). Accepted and stated. Whether node and `curl` in the sandbox trust that CA without extra
  configuration is unmeasured (Stage 1 was plain HTTP): probe Q2.
- **The A1 condition (Stage 2 §4.5).** The Worker must never reflect the `Authorization` header into a response the sandbox can
  read. Probe Q3 scans every response recorded during the probe for all three credentials; a negative result bounds the inspected
  representations and response paths, and is not a proof that the Worker never reflects a header. The Worker's response paths are
  also read in W6's verification, and that reading is stated as a reading.

## 7. The probe (W6)

Runs on the PC after W3, W4 and W5, with the real credentials, on Jordan's go, one line at a time; a failed line stops the
probe at that line except as noted. Results go into a dated correction to this note.

| | Question | Check | Passes when |
|---|---|---|---|
| Q1 | Does the proxy substitute the Retrace credential? | `curl` `GET /projects/retrace/head` with `authorization: Bearer $RETRACE_TOKEN` (the placeholder); the same request with no header | 200 with the header, 401 without |
| Q2 | Does node's `fetch` go through the proxy and trust its CA? | the same request from `node -e` with built-in `fetch` | 200 |
| Q3 | Are **all three** credentials absent from the bytes the seat can inspect, **including every response it receives**? **Runs last, after Q9**, because its input includes the Q4–Q9 traffic | Inside the sandbox, over every environment value, every file under the home and the clone, and every HTTP response (headers and body) recorded during Q1–Q9, including the `authorization`, `x-api-key` and Basic-auth headers git and the harness send: one detector per credential, each built from that credential's own length and alphabet as minted (Retrace's token: 43 base64url characters, `mintToken`; the Anthropic key and the GitHub fine-grained token: the lengths and alphabets of the values Jordan's script minted, supplied to the sandbox as non-secret numbers, never inferred from Retrace's generator). For each detector, every maximal run of its alphabet at least its length long is scanned and the sha256 of every window of exactly its length is printed, never the run; Basic-auth headers are also decoded before scanning. On the laptop, Jordan's script compares the printed digests with reference digests computed from the three values, which never enter the sandbox. Positive controls run first with dummy values of each type in an environment variable, a file, a full reflected `authorization` header, a reflected `x-api-key` header and a Basic-auth header | no printed digest equals a reference digest for any of the three credentials; stated as "no inspected representation on the inspected response paths carried a credential", a finite negative scan, not a proof that the Worker never reflects a header (§6) |
| Q4 | Do the hooks run in the clone and seal with the restricted stamp? | one authorised commit on a named non-main branch | a `committed` event for that sha, `sealed_by` `pinned:<name>`, verdict `none`, `idempotency_key` `git:<sha>` |
| Q5 | Does the MCP path work? | `retrace_instruct` and `retrace_log` through the stdio `retrace-mcp` | both seal under actor `claude-code-openshell`, `sealed_by` `pinned:<name>`. Fails: the image-scope HTTP entry is tried; both fail: stop |
| Q6 | Do the producers agree, within the restriction? | `reconcile` over the Q4 commit with `--restricted-hook-stamp "<stamp>=claude-code-openshell"` | no `producer_disagreement`; `uncovered` only if no edit was logged |
| Q7 | Is the principal right? | the raw webhook and restricted seals | `github:jordandru` with `principal_rule: agent-address/1`, and `jordansboxing@gmail.com`; never `noreply@anthropic.com` |
| Q8 | Does carrier A deliver a brief intact? | one real brief sealed by the coordinator as in §2.4; the seat reads the `sent` and brief events raw through the proxy, writes the text, hashes it | the six fields verify; the written file's sha256 equals `brief_sha256`. Fails: carrier B, no design change |
| Q9 | Does the GitHub push work through Basic-auth substitution, and only where allowed? | `git push origin <branch>:refs/heads/<branch>` to a named non-main branch; then a push to `main` attempted through the guard; then `gh pr create` | the branch push lands and the webhook seals it under the seat; the `main` push is refused by the guard; `gh pr create` is denied by policy |
| Q10 | What does a gateway restart cost? | restart the gateway during a turn | the session dies and the ledger shows the gap (Stage 1 test 5); whether the clone and uncommitted files survive is recorded either way |

If Q1 or Q2 fails, the seat is not buildable as designed and the question goes back to Jordan. If Q3 fails, the credentials are
rotated by typed script before anything else and the question goes back to Jordan.

*Correction, 2026-10-05 (step W6a; the author's finding, measured on the laptop with synthetic hook payloads only, nothing
pushed): Q9's "push to `main` attempted through the guard" could move `main` if the guard failed open, and the guard is inert in
the sandbox until step W3 adds its `RETRACE_SEAT` selector. Fed `git push origin HEAD:refs/heads/main` as a hook payload with no
selector set, the guard at main exits 0 and would let the push run; with the cloud selector set it exits 2, and it exits 2 for
`git push --dry-run origin HEAD:refs/heads/main` too. The control toward `main` is therefore two checks that cannot push: the
guard script fed that command as a hook payload, which must exit 2; then `git push --dry-run origin HEAD:refs/heads/main` through
the harness, which the hook must refuse and which sends no update if it does not. `gh pr create` stays as written: the policy
(`api.github.com` read-only) and the token's permissions (contents only, no pull requests) each refuse it. The probe exception
under agent-rules 7 permits nothing else toward `main`, and a probe run needs W3 on main and in the image.*

*Correction, 2026-10-06 (step W6a, PR 189 fix round 1; Codex C-M1, `evt_3688cb83d43e4608af963e0b8ae7d488`): the brief the seat
materializes in §2.4 step 3 ("the `intent` bytes written to disk"), the file carrier B uploads in step 4, and Q8's written file go
only in one scratch directory, `/tmp/openshell-seat/`: outside the clone and `~/.claude`, no configuration path, and writable under
OpenShell's baseline policy (`docs/how-it-works/policies/default-policy.mdx` at `021400be`: `/tmp` read-write). Hashing a
materialized brief is not acting on it; nothing in it is acted on before the six checks and its hash pass. Q3's in-sandbox half,
its dummy-value fixtures, response captures and scan, is run by Jordan through `openshell sandbox exec` in that directory, not by
the seat, and Q3 scans that directory along with the home and the clone. Agent-rules 7's probe exception states the bound.*

## 8. Build order

| Step | What | Who | Gate |
|---|---|---|---|
| W2 | this note | claude-code (OpenShell S1) | class (a): Codex (budget permitting), NOOA, Grok; the coordinator does merge-readiness; merge on Jordan's go |
| W3 | `admin.ts` harness entry, no-key exception, onboarding branch, tests; the guard's second selector with tests | a builder from a brief the coordinator routes | code order; brief class (a) |
| W4 | `sandbox/openshell/`: Containerfile, the three profiles, `CLAUDE.seat.md`, the settings file; built on the PC by Jordan | claude-code drafts in the S1 worktree while W2 is in review; Jordan builds the image | class (a): the files govern what the seat can reach |
| W5 | custody: mint the Retrace credential and update the Worker secret; carry it over SSH into `openshell provider create`; the Anthropic key and the GitHub token the same way | Jordan, by typed scripts outside Orca, one go each; the coordinator writes the scripts and receives only names and hashes | credential and secret changes |
| W6a | rules, part 1: the bounded **probe** exception to agent-rules 7 (§2.3: the probe's named non-main branch and operations under the seat's pinned credential, nothing else) and the `CLAUDE.md` selector clause (§2.4) | claude-code | class (a); **merged before W6 starts**. A W6 operational go is not a rule amendment |
| W6 | the probe, §7 | Jordan runs; claude-code verifies from the ledger | — |
| W7 | rules, part 2: the standing exception for the seat's bound (§2.3); `restricted_hook_stamps` in `.retrace.json`; `team-roles`; the agent-ops host entries (§6); the seat marked live | claude-code | class (a); after W6 passes |
| W8 | the first real task through the seat, then a measurement doc | the seat; claude-code writes the doc | class (b) |

Nothing past W2 starts without its gate. W3 and W4 may run in parallel after W2 merges. W6 does not start until W6a has merged;
until then the seat, if it exists at all, reads and reports only.

## 9. What this note does not claim

- That OpenShell holds a production token safely. Stage 1 used fake and scratch tokens; the first real token arrives in W5.
- That node, `curl` or git in a sandbox trust OpenShell's per-sandbox CA, or that Basic-auth substitution works for git over HTTPS.
  Documented, not measured (Q2, Q9).
- That a brief survives the ledger byte for byte (Q8).
- That the seat's events are producer-signed. They are not (§2.3).
- That the proxy protects the token from the `stranger` account (Stage 2 §4.3), or from a destination that reflects it (Q3).
- That the 8 GB PC runs the stack comfortably. The resource numbers in §5.1 are estimates.
- That OpenShell 0.1.x keeps these interfaces: "Interfaces marked Experimental may change or be removed in a patch release."
- That carrier A is private. A sealed brief is shareable ledger content (§2.4), and the content contract is the only guard.
- That a clean reconcile proves the hook ran or that edits were logged before the commit. It proves ledger order (§3.4).
- That a negative Q3 proves the Worker never reflects a header. It bounds the inspected representations and paths (§7).
- That any of §3, §5, §6 or §7 works. Nothing here is built.

## 10. Gate

Class (a) under agent-rules 12: Codex, NOOA and Grok review (team-roles rule 2); the coordinator is the author's seat, so it does
merge-readiness only (agent-rules 11). Merge on Jordan's go. Nothing in this note is code, so no code order applies; W3 and W4
have their own gates. The W1 sheet, the brief and the scope are in the operator's folder; what this note uses from them is
restated here with the ledger events that recorded them.

## 11. Changes in v2

| Finding | Disposition |
|---|---|
| Codex C-M1 (Medium), carrier A seals the brief's bytes into shareable history with no admission rule | **Applied.** §2.4 gains the content contract: share-safe text only, a pre-seal check recorded on the brief event, confidential briefs by carrier B with hash and reference sealed, and the statement that amendments and share revocation cannot retract a sealed or delivered body. §9 says carrier A is not private |
| Codex C-M2 (Medium), Q3 detects only Retrace's 43-character token shape and ran too early | **Applied.** Q3 is one detector per credential, built from each credential's own length and alphabet supplied as non-secret numbers, with owner-side reference digests, positive controls for every type including full reflected headers and Basic auth, decoded Basic-auth headers, a pass condition scoped to the inspected representations and paths, and it runs last, after Q9. §6's A1 bullet and §9 say what a negative scan does and does not prove |
| Codex C-M3 (Medium), §3.4 overclaimed that a clean `uncovered` means edits were logged before the commit | **Applied.** §3.4 states the forgery case Codex reproduced and what reconcile shows for it, describes the evidence as edit declarations before an accepted ledger boundary, and distinguishes `uncovered` from `misattributed`. §9 carries the limit |
| Codex C-M4 (Medium), W6 would exercise the keyless seat before W7 enacts the agent-rules 7 exception | **Applied.** The exception is enacted in two class (a) steps: W6a, a bounded probe exception plus the identity clause, merged before W6; W7, the standing bound, after the probe. §2.3 and §8 say that neither a custody go nor an operational go amends a rule |
| Grok G-L1 (Low), one `mcp.ts` line number asked to carry two facts | **Applied.** §1 cites `authenticateRemoteMcp` lines 61–75 for acceptance and line 38 (enforced at 238–240) for the body cap |
| Grok G-L2 (Low), owner-protocol §10 cited as if it existed | **Applied.** §0.1 says §10 is proposed in the open PR 176, that the file ends at §9 at this head, the base and main, and that `cloud-seat.md` §2.4 still calls the channel undefined |
| NOOA L1 (Low), §0 read as a running system beside "Not built" | **Applied.** §0's first bullet is phrased as the design ("would run") and points at §8 |
| NOOA L2 (Low), §2.4's Stage 2 §7 claim unverifiable from the packet and read too broadly | **Applied.** The sentence cites `sandbox-credential-proxy.md` §7 by file, narrows the claim to the PC receiver's own read path, says it is not a measurement, and says the laptop gap stays open |
| Codex scoped conclusions, recommended not required | **Applied.** §5.1 notes that `retrace-git install` resolves a token at install time and names the build-time override; §6 names the GitHub push-scope residual, the two alternatives declined for v1 and why, and keeps the wrong-trailer limit |

