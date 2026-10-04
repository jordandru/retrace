# Seat bearer tokens behind a sandbox credential proxy (OpenShell Stage 2, design note v1)

**Status:** v1, 2026-10-04, by claude-code (second session `3dc103f3`; `claude-opus-5-5`, model source
harness-runtime). **It proposes no code, no credential and no rule text.** Class (a) under agent-rules 12: a design
note on how seat credentials are held.
- Written on Jordan's signed go `evt_0eac86082cb946579c9b6ace937284be` ("Go on 1", received 15:50 MDT / 21:50Z), item
  1 of the open list this session gave on resume (`evt_c1370e69…`).
- The question is Stage 2 of the OpenShell plan saved on Jordan's instruction `evt_d182ae0f…`. Stage 1, the
  credential-custody pilot it depends on, passed and is merged as
  `docs/measurements/openshell-stage1-omarchy-2026-10-04.md` (PR 174, `5ae3388f`).

A **sandbox credential proxy** here means a component outside an agent's sandbox that holds a credential and adds it
to the agent's outbound requests for bound destinations only. Two appear in this project's record: OpenShell's
providers (Stage 1) and the API credentials of a Claude Code cloud environment (`docs/design/cloud-seat.md` §2.2).

## 0. The question and the proposed answer

**The question (the plan's Stage 2):** should seat bearer tokens be held by a sandbox credential proxy? Measure it
against agent-ops 16's credential sinks, and state what it cannot do: producer keys, and cross-seat provider attach.

**The proposed answer, for Jordan to decide after the gate:**

- **A1. Yes, for every seat that runs inside a sandbox.** The seat's bearer token is held outside the sandbox and is
  never placed in the session's environment, files or arguments. The platform's credential proxy is the way available
  today, and the cloud seat is already designed this way. A1 holds whichever way the seat's producer key is handled
  (§4.1).
- **A2. No change for the laptop seats.** No sandbox can run on this laptop (§2.3). And the most powerful token on the
  laptop sits in every pane's environment: the owner token (§2, §3). No proxy for seat tokens touches it. §7 records it
  for the coordinator to route as its own item.
- **A3. Option P waits.** A production pilot identity behind OpenShell would add little that other steps do not
  measure, at the cost of a code change, a rules exception, a mint and a secret change, for an identity that records no
  work (§5). It starts when Jordan decides that a real seat runs sandboxed on a native-Linux host.
- **A4. The limits are stated, not solved.** A proxy holds no producer key. On a host where seats share one account
  and one gateway, it separates each sandbox from the host, not one seat from another. And any process of the
  gateway's own account can decrypt its store (§4).

## 1. Evidence

| Source | What it shows | Where |
|---|---|---|
| Stage 1, measured | On native Linux (OpenShell v0.1.2, rootless Podman), the sandbox held only a placeholder. The proxy added the token only at the bound endpoint and refused it elsewhere. A scratch Retrace server sealed a placeholder-only call under its pinned identity. A gateway restart was an explicit loss. Fake and scratch tokens only; plain HTTP only | the Stage 1 doc; `evt_fe1baad0`, `evt_9751dd20`, `evt_3820bd45`, `evt_0af2013c`, `evt_b87a9a78` |
| The research report, 2026-10-01 | OpenShell's documented design, platform needs and limits | `evt_3bd81e05…`; OpenShell's documentation, below |
| The cloud seat, designed | A keyless seat whose token sits in Anthropic's proxy, and the bounded rules exception that needs. The token was minted and placed on 2026-10-04 (B4 complete, `evt_255a43b7`). The probe that checks it (P3) has not run | `docs/design/cloud-seat.md` |
| Retrace's code at `5ae3388f` | What each kind of token can do | `packages/core/src/router.ts` (`authenticate`, `POST /events`); `apps/worker/src/mcp.ts` (`authenticateRemoteMcp`); `packages/mcp-server/src/admin.ts` (`shouldMintProducerKey`) |
| The ledger | Five events on the sinks | §3 |

OpenShell's documentation is cited at commit `021400be8af471f8669369e679de3e18cf0bd672`
(`https://github.com/NVIDIA/OpenShell/blob/021400be8af471f8669369e679de3e18cf0bd672/`):
- `docs/how-it-works/providers/overview.mdx`, sha256 `f4e7384a…`
- `docs/how-it-works/providers/profiles.mdx`, sha256 `0d1306a6…`
- `docs/how-it-works/policies/schema.mdx`, sha256 `38060f6f…`
- `docs/security/best-practices.mdx`, sha256 `49fd4a98…`
- `docs/how-it-works/gateways/configuration.mdx`, sha256 `479a5049…`

## 2. What a bearer token is worth here

### 2.1 Three kinds of token

From the Worker's code at `5ae3388f`:

| Token | On its own, it can | Source |
|---|---|---|
| **Owner** | write under any actor, stamped `sealed_by: owner` and never with verdict `verified`; read every project; and use the owner-only routes (DELETE, PUT, and POSTs other than events). GET also accepts it as a `?token=` query | `router.ts`: `authenticate`, `resolveActor`, the credential route guard; `producer-sig.ts` `producerSigCheck` (no registered key: `none` or `unknown_kid`) |
| **A seat credential with a producer key** (`require_signature`) | read its project, and **not** write: any write without a verified producer signature gets 401 | `router.ts`, `POST /events`. `admin.ts` `shouldMintProducerKey` gives a key to every pinned agent except those on its no-key list |
| **A keyless pinned agent** (`claude-code-cloud`; `openclaw`, now retired) | write under its pinned actor (never `verified`) and read its project. `/mcp` accepts only pinned agent credentials without `require_signature` | `admin.ts`; `mcp.ts` `authenticateRemoteMcp` |

So a keyless seat's bearer token carries all of its write power. For a seat with a key, the token is one of the two
things a write needs, and the key is the other.

### 2.2 Where the tokens sit today

- **The five laptop seats** (claude-code, codex, grok, github-copilot, cursor-agent):
  - each token sits in its harness's MCP configuration or env file (`docs/reference.md`, the harness list; agent-ops
    8 and 9);
  - each producer key sits in a mode-0600 file named by `RETRACE_PRODUCER_KEY_FILE` (agent-rules 13);
  - all of it is in one Unix account, so every process of that account can read it, every agent of every seat
    included. What separates the seats is agent-rules 13: policy, not prevention. The cloud-seat note says the same of
    the hook's token (§3.3).
- **The owner token** is exported from `~/.bashrc`. The rotation record `evt_6d8e566f…` names that file and the new
  value's sha256 prefix, `eddeb395e1b3`.
  - Every shell that sources the file carries the token, Orca panes included, unless a guard strips it. One guard
    does, in the house worktree (`evt_c21df545…`).
  - This pane carries it: the prefix check its hand-off asks for printed `eddeb395e1b3`. The coordinator's hand-off
    asks for the same check.
- **The auditor seat** (`nooa`), on its own host: the token is in the MCP configuration file there (`evt_707bc460…`),
  and the key is in a file on that host.
- **The cloud seat:** in the cloud environment's API credentials, attached by Anthropic's proxy for the Worker's host
  only (`evt_255a43b7`). It has no key.
- **Every credential** is also in the Worker's secret (agent-ops 13). No proxy changes that.

### 2.3 Where a proxy can run

- **OpenShell needs Landlock ABI 3 or newer.** This laptop's WSL kernel (5.15) reports ABI 1, measured
  (`evt_8580b0a9…`).
- **Its Docker driver** would have the gateway drive Docker's root-equivalent engine for every sandbox, continuously.
  Agent-ops 17's one signed go per exact command cannot cover that (research report, Risks).
- **Stage 1 ran on the Omarchy PC:** native Linux, rootless Podman, one account (`stranger`).
- **The cloud VM** has Anthropic's proxy.

So no laptop seat can sit behind OpenShell today.

## 3. Measured against the sinks

Agent-ops 16 names three sinks: agent transcripts, a pane's environment after a rotation, and the clipboard. Agent-ops
17 adds a fourth: containers. A search of the ledger for this note found five events on them. The last column is an
inference from Stage 1's tests 2 and 3, not a measurement.

| When (UTC) | Event | Sink | What happened | Would a proxy-held seat token have prevented it? |
|---|---|---|---|---|
| 09-16 | `evt_c21df545…` | transcript | the owner token, printed from the shell environment | **No.** It is not a seat token |
| 09-21 | `evt_6bfe5f18…` | clipboard | pasted fences ran a Worker secret change and a shred | **No.** An operator's step, outside any sandbox |
| 09-21 | `evt_e660b499…` (agent-ops 17) | container | the retired shared `nooa`/`openclaw` token, found in the NemoClaw sandbox's OpenClaw configuration | **Only if the value came through a provider.** On 0.1.2's measured behaviour a provider gives a sandbox only a placeholder. That sandbox ran a release before 0.1.0 (published 09-25), and how the value reached its configuration was not established. OpenShell's own upgrade note warns that sandboxes from before endpoint binding "may have received their real values" (`profiles.mdx`) |
| 10-04 | `evt_707bc460…` | transcript | the `nooa` seat token, printed by a `cat` of the host's MCP configuration over ssh | **Yes, for that accident:** with the token in a proxy, the file would hold no value. A deliberate read through the gateway's account stays possible (§4.3) |
| 10-04 | `evt_8fc5c456…` | clipboard, then transcript | the cloud seat's first token, pasted into a pane on its way into Anthropic's proxy | **No.** It happened while a token was being put into a proxy |

Sink by sink:
- **Transcripts.** A sandboxed agent holds only a placeholder (Stage 1, test 2), so nothing it prints or writes can
  carry the value. That closes the mode of the 10-04 `nooa` exposure: a plain-text configuration file, read by
  accident. It does nothing for the owner token, which reached a transcript from the shell environment (09-16).
- **A pane's environment after a rotation.** Documented, not measured: after a static credential update, "launch a new
  client process to use the updated reference. An existing process keeps its revision-scoped reference"
  (`providers/overview.mdx`). So a rotation still needs a client restart, as panes do today. What changes is that the
  stale process holds a placeholder, not the old value.
- **The clipboard.** Unchanged. A token still reaches the proxy's store through a terminal or a form, once per mint or
  rotation, and the cloud seat's first token burned at exactly that step. Agent-ops 16's terminal boundary keeps
  governing it.
- **Containers.** A sandboxed agent holds no value to write into a container's environment or configuration. A value
  that someone writes into the sandbox by hand is not covered.

**Net:** the proxy closes the sinks inside the sandbox. Provisioning and the host account stay as they are. And on
this laptop, the token that reached a transcript from a pane's environment was the owner's.

## 4. What a proxy cannot do

### 4.1 Hold a producer key

Signing needs the key in the signer's memory. OpenShell's only request signing is AWS SigV4 (`policies/schema.mdx`,
`credential_signing`). Anthropic's proxy attaches a header (cloud-seat §2.3). So a sandboxed seat takes one of three
positions on its key:

| Option | The key | Consequence |
|---|---|---|
| **Keyless** (the cloud seat's tier) | none | Every event carries verdict `none`. Agent-rules 7 needs a bounded exception, as the cloud seat's does (cloud-seat §2.3, step B6: it builds only, never reviews or merges, and sends no pane messages, which a receiver must refuse anyway) |
| **The key inside the sandbox** | readable by the agent | The proxy still keeps the bearer token out, so a key that leaks cannot write on its own (§2.1). Anything running inside the sandbox can still write as the seat |
| **A signer outside the sandbox** | held with the token by the seat's MCP server on the host, which the sandbox reaches as a local service (`host.openshell.internal`, Stage 1 observation 6) | Neither secret is in the sandbox; both are in the host account (§4.3). **Not built:** the packed CLI's MCP server speaks stdio only |

A1 holds in all three: in none of them does the bearer token belong inside the sandbox.

### 4.2 Separate one seat from another

- OpenShell's gateway authenticates its caller, and a caller holding the gateway's client credentials can attach a
  provider to a running sandbox (`openshell sandbox provider attach`, `providers/overview.mdx`).
- **Inference** from those documents (research report, Q3): on a host where several seats share one account and one
  gateway, as on this laptop, any host process of that account, an unsandboxed coordinator included, could attach one
  seat's provider to another seat's sandbox.
- So the proxy separates each sandbox from the host, not one seat from another. One gateway per seat, each under its
  own account, is the shape that would. It is not examined here.

### 4.3 Guard against its own host account

- **Observed in Stage 1 (observation 5):** OpenShell's default store encrypts each credential under a key-encryption
  key kept in the same account, in an owner-only file, so any process of that account can decrypt it.
- **Documented:** OpenShell also supports external stores, Vault and Kubernetes Secrets (`gateways/configuration.mdx`,
  "Credential Drivers").
- **Inference:** the gateway still resolves each value in its own process, and authenticates to such a store with
  material in its own account. So the boundary stays the account.
- A host-level agent signed in under that account therefore defeats the custody. That is why the Stage 1 go-3
  proposal set a rule for the Omarchy PC: no AI agent signed in on it while it holds a real token.

### 4.4 Limit what the token is used for

The proxy limits where a token goes: the host, port and path, and the binaries the policy lists. It does not limit what
a process in the sandbox writes with it. A prompt-injected agent can still append as its seat, and the pinned stamp
will attribute that write to the seat. Custody is not authorisation.

### 4.5 The rest

- **TLS.** OpenShell's proxy "terminates TLS transparently using a per-sandbox ephemeral CA" (`best-practices.mdx`),
  so it holds ledger traffic in clear. Stage 1 measured plain HTTP only.
- **The Worker's secret.** Every credential stays there (agent-ops 13). A proxy moves no token out of it.
- **The vendor's proxy.** For the cloud seat, the statement that the value never reaches the session is Anthropic's.
  P3's Q3 checks only the bytes a session can inspect (cloud-seat §7, §9), and P3 has not run.

## 5. Option P: not now

Option P is the production pilot from Stage 1's go-3 proposal: a new identity, `openshell-pilot`, keyless, in its own
project, called through the production `/mcp` from an OpenShell sandbox.

- **What it would add:** OpenShell's proxy in front of the production Worker. That joins Stage 1's two unmeasured
  links, the `/mcp` route and the TLS path, in one run.
- **What covers those links without it:**
  - The cloud seat's P3 sends a keyless pinned credential, attached by a proxy, to the production Worker (its Q1), and
    over `/mcp` if its path A works (its Q5).
  - OpenShell's TLS path can be measured with a fake token and an HTTPS echo service, as Stage 1's go 2b did over HTTP,
    with a client image that speaks TLS. No identity is needed.
- **What it would cost:**
  - a class (a) change to `admin.ts`: the harness list, its onboarding text and the no-key exception, with tests;
  - a bounded agent-rules 7 exception;
  - a mint and a Worker secret change, by Jordan's typed scripts (agent-ops 16);
  - the hand-over of the token to the PC;
  - its retirement afterwards.
- **What it would leave:** an identity that records no work.

**Recommendation:** start P only as the first step of a real sandboxed seat, when Jordan decides one runs on a
native-Linux host. That is the research report's precondition P3. The Omarchy PC is such a host, with OpenShell
installed. P's shape is then the cloud seat's, B2's issuance and B6's bounded exception, written for that seat. A
sandboxed Claude or Codex seat also needs its own model credential behind the proxy, and OpenShell documents
`ANTHROPIC_API_KEY` as an API key, "not a subscription token" (research report, open question 4). That cost belongs to
the same decision.

## 6. What Jordan is asked to decide, and what changes

- **To decide:** A1–A4. Each can be taken on its own.
- **What changes:** nothing in code, credentials or rule text.
  - A1 is applied by each sandboxed seat's own design, as the cloud seat's already is.
  - If a second such seat is designed, its gate decides whether A1 becomes rule text (agent-rules 13).
- **To overrule:** name the answer to change. For A3, "go P" sends Option P to the coordinator as a class (a) brief
  instead.

## 7. Found while measuring: the owner token in the panes

This is not a seat token, so it is outside the question. It is recorded because §2 and §3 show it is the most powerful
token on this laptop, and the one that reached a transcript from a pane's environment.

- **Where it is:** `~/.bashrc`, and so every pane that sources it (§2.2).
- **What uses it from panes, at least:**
  - **The raw reads that verify a pane message under agent-rules 15.** Agent-ops 18 has the receiver curl "with the
    credential in the `Authorization` header from the environment", and in a claude-code pane that is the owner token
    (§2.2). This session's raw reads for this note used it too. On 2026-09-20 a claude-code session recorded its method
    as "REST reads (owner token, values never printed)" (`evt_881b1f85…`).
  - **The CLIs, when run in a pane,** take `RETRACE_TOKEN` from the environment: `retrace-export`,
    `retrace doctor --gate`, `retrace-admin set-policy`, `retrace-github` and `retrace-gdrive`. The git hook and plain
    `retrace doctor` take it only when `.retrace.json` names no credential; this repository's names `retrace-git`.
- **A gap between the rule and the practice.** Agent-rules 15 says the receiver reads "with its own credential". This
  note records the gap and changes neither.
- **A way out already exists in agent-ops 18's direction.** A narrow `retrace_verify_send` tool, served by each seat's
  MCP server under that seat's own credential, would end the raw reads. Scoped read credentials would cover the CLIs.
- **Recommendation:** the coordinator routes "the owner token out of the pane environment" as its own item. It starts
  with an inventory of every reader of `RETRACE_TOKEN` in panes. This note does not design it.

## 8. What this note does not claim

- That OpenShell holds a production token safely. Stage 1 used fake and scratch tokens only.
- That a proxy protects a token from its host account (§4.3).
- That Anthropic's proxy keeps the cloud token from the model (cloud-seat §9).
- That §3's last column is measured. It is inferred from Stage 1's tests 2 and 3.
- That §3's five events are every event on these sinks. They are what a text search of the ledger found.
- That OpenShell's rotation behaviour (§3) or its external stores (§4.3) were measured. They are documented.
- Anything about moving the auditor seat, on its own native-Linux host, behind a proxy. That host has 961 MB of memory,
  on which the CLI's MCP server already ran out of heap (`evt_707bc460…`), and the seat keeps a producer key. Neither
  question is examined.

## 9. Gate

- **Class (a):** Codex, NOOA and Grok review (team-roles rule 2). The coordinator is the author's seat, so it does
  merge-readiness only (agent-rules 11). Merge on Jordan's go. Nothing in the note is built, so no code order applies.
- **Inputs outside this repository:** the plan, the go-3 proposal and the research report are in the operator's
  folder. What this note uses from them is restated here, with the ledger events that recorded them.
