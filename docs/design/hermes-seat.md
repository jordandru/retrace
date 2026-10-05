# Hermes seat: Hermes Agent as an opt-in builder (design note v1, draft)

**Status:** v1 draft, 2026-10-05, by `claude-code` (coordinator, session 30; `claude-fable-5-1`, model source harness-runtime).
**Not built.** Class (a) under agent-rules 12: it defines a new seat, its identity file, a guard that governs what the seat may do,
the custody of its credential, and a launcher. Written on Jordan's signed `evt_af0778b61f08410884d91c94aafd9db6` ("Draft design
note"), after his signed `evt_3c29b74571ab49f5a69d8995c4125348` ("Investigate potential hermes seat") and `evt_cfd331e1abec4c50b99bb6bd3974e26b`
(the go for Gate 0). The investigation is `~/.retrace/hermes-seat-2026-10-05/ASSESSMENT.md` (sha256 `d5be3a62…`, `evt_1841872d…`)
and its Gate 0 measurement `gate0/RESULTS.md` (sha256 `b1b329b4…`, `evt_fb0a8f7d50274ea48b9658e42b288f9f`). The template is
`docs/design/opencode-seat.md` (PR 58, closed) for the identity gate and `docs/design/cloud-seat.md` for the shape of a seat note.

**Draft means:** the four decisions in §1 are Jordan's and are not taken here. Each carries the author's recommendation and the
line that overrules it. The note is complete under those recommendations and is routed for review only after the decisions are
signed, so reviewers read a note with answers, not placeholders.

## 0. What this note decides, and what it leaves to the gate

- **The seat.** Hermes Agent (Nous Research, MIT) joins as actor id `hermes`, an **opt-in builder**: in `HARNESSES`, never in
  `DEFAULT_HARNESSES` (`packages/mcp-server/src/admin.ts` lines 40–41), never a reviewer (agent-rules 11; team-roles 1). One pinned
  credential, one producer key, one identity file (`.hermes.md` at the repository root), one launcher, one guard plugin.
- **Why it may join** when OpenCode could not without an undocumented flag: Hermes loads **one** project context type per session and
  ranks `.hermes.md` above `AGENTS.md`, `CLAUDE.md` and `.cursorrules` in code and in its documentation (§2). Gate 0 measured it.
- **Why it may join only with the guard:** the same code falls through to `AGENTS.md` when `.hermes.md` is missing, and it splices a
  subdirectory `AGENTS.md` into tool results mid-session. Gate 0 measured both (§2). The guard (§4) is the identity control; the
  file precedence is the convenience.
- **What it leaves to later:** the exact text of the launcher, the plugin and the config template (each its own pull request, §8);
  the results of Gates 1–3 (§7), which go into dated corrections here; the roster line in `docs/team-roles.md` and the `SETUP-GUIDE.md`
  section, which merge only after Gate 2 (agent-rules 0: nothing says "supported" before a verified seal).

## 1. The decisions Jordan owns

| | Question | Options | Recommendation | Overrule |
|---|---|---|---|---|
| **H-0** | Is a seventh seat wanted at all? `SETUP-GUIDE.md` line 330 says "do not add … a sixth agent … while completeness (omission detection) and attribution … are still weak"; the 2026-09-01 NemoClaw assessment said the same. Since then: trailer-consistency classifier (PR 19 line), model-source v2 (PR 118/119), reconcile HEAD-only, `@retrace-dev/cli` 0.3.0 | (0a) yes, and that sentence is revised to name the gates a new seat must pass; (0b) yes, as a time-boxed pilot with no roster line; (0c) no, file this note as reference | **0a**: the gates in §7 are the condition the sentence lacked. The sentence changes in the same pull request as the roster line, after Gate 2 | one signed line: 0b or 0c |
| **H-a** | Which model and provider, and whose claim is the model id? | (a1) a vendor outside the Core Four on its own API key (DeepSeek, Moonshot, Alibaba, Zhipu…): the vendor's claim, metered; (a2) Nous Portal Plus, $20/month for $22 credit: a reseller's claim (opencode-seat §6 precedent), 300+ models; (a3) OpenRouter: reseller's claim, metered; (a4) a Core Four model (Anthropic/OpenAI/xAI): no vendor diversity, duplicates a seat | **a1** if the budget allows one metered key with a hard monthly cap; otherwise **a2**. Not a4: a builder on GPT or Claude adds a harness and no independence. Not a Nous model: Nous says Hermes 4 is "not recommended for use inside Hermes Agent" | one signed line naming a1 with the vendor, a2, a3 or a4 |
| **H-b** | Where does it run? | (b1) this laptop, an Orca pane, like the other seats; (b2) NemoHermes inside OpenShell on the Omarchy PC, a second tenant of PR 179's custody (bearer substituted at egress, no key in the sandbox) | **b1** for Gates 1–3; b2 after PR 179's W4–W6 exist, as a dated amendment here | one signed line: b2 now |
| **H-c** | What may it do? | (c1) build only: edits, tests, commits, pushes to non-main branches, pull requests opened by the coordinator from its branch; (c2) build and open its own pull requests; (c3) build and review | **c1**, matching OpenCode; c2 after one clean Gate 3; never c3 (team-roles 1, 3) | one signed line: c2 |

The note below assumes 0a, a1-or-a2, b1, c1. Where a choice would change a section, the section says so.

## 2. Evidence

| Source | What it shows | Where |
|---|---|---|
| Hermes source, commit `7b362884d88c887bdcc68271c3b51d25ad1a2197` (main, 2026-10-04) | "Only ONE project context type loads, first found wins: .hermes.md/HERMES.md (walk to git root) → AGENTS.md chain (git root → cwd) → CLAUDE.md (cwd) → .cursorrules + .cursor/rules/*.mdc (cwd)"; mid-session `_HINT_FILENAMES` = AGENTS.override.md, AGENTS.md, agents.md, CLAUDE.md, claude.md, .cursorrules (not .hermes.md), working directory pre-marked loaded; `pre_tool_call` timeouts fail closed; shell hooks block only on `pre_tool_call`; protected instruction basenames agents.md, claude.md, soul.md, .cursorrules (not .hermes.md); the terminal child env is `os.environ` minus a **name-based** credential blocklist; `.env` values never enter `os.environ` | `agent/prompt_builder.py:1797`, `agent/subdirectory_hints.py:20,152`, `hermes_cli/plugins_dispatch.py:49`, `agent/shell_hooks.py:44`, `tools/file_tools_write_guards.py:188`, `tools/environments/local.py:334,363` |
| Gate 0, measured 2026-10-05 01:00–01:08 MDT on a stub model at 127.0.0.1 (`evt_fb0a8f7d…`; `gate0/RESULTS.md`; `HASHES.txt`) | (a) with a root `.hermes.md` only it loaded (requests `0f48c42e…`); (b) without it, `AGENTS.md` with `Retrace-Actor: codex` reached the model (`6c0c086c…`); (c) a scanner-blocked `.hermes.md` yields a "[BLOCKED…]" placeholder, no fall-through, no identity (`d7639a11…`); (d) `agent.skip_context_files` in config.yaml is not honoured, `--ignore-rules` drops SOUL.md too (`96eca2d4…`, `3a016b5d…`); (e) a decoy `sub/AGENTS.md` arrived inside a `read_file` tool result (`2aa6ae41…`); (f) `RETRACE_URL`, `RETRACE_TOKEN`, `RETRACE_DB` from the launching shell were visible to the Hermes terminal, `OPENAI_API_KEY` from the profile `.env` was not; (g) a fail-closed `pre_tool_call` shell hook blocked every tool once a decoy identity was flagged (`c07ad134…`); (h) `on_session_start`, `pre_llm_call`, `pre_api_request` payloads carried the configured model string, and `pre_api_request` also `provider`, `base_url`, `api_mode`, `request` (`7325d53d…`) | `~/.retrace/hermes-seat-2026-10-05/gate0/runs/<V>/requests.jsonl`, `hooks.jsonl` |
| Hermes documentation, read 2026-10-05 | MCP over stdio and Streamable HTTP; `${VAR}` in `command`, `args`, `url`, `headers` resolved at connect time from the profile `.env`; "only explicitly configured `env` plus a safe baseline" to stdio children; per-server `tools.include`/`exclude`; profiles `hermes -p <name>` → `~/.hermes-<name>/`; `plugins.enabled` opt-in, plugins "run as regular in-process Python", "placing the files is the opt-in"; installer tracks `main`, `--commit` pins; Nous Portal tiers; "Hermes-4 … not recommended for use inside Hermes Agent" | `hermes-agent.nousresearch.com/docs/user-guide/features/{mcp,hooks,plugins}`, `/configuration/`, `/docs/integrations/nous-portal`, `/install.sh` |
| The retrace code at main `6190d5f3` | `HARNESSES` and `DEFAULT_HARNESSES`; the hook's token precedence `RETRACE_HOOK_TOKEN` → the credential `.retrace.json` names (`retrace-git`) in the credentials file → `RETRACE_TOKEN`; `RETRACE_ACTOR_MODEL` / `RETRACE_ACTOR_MODEL_SOURCE` on a seat's MCP server (PR 118); the trailer-consistency classifier as the enforcement of record for a false trailer | `packages/mcp-server/src/admin.ts:40–41`, `git-hook.ts:66–86`, `docs/design/model-source.md` §4, `docs/design/commit-trailer-consistency.md` §13 |
| The OpenCode decision | Layer A (loader), B (identity control on the text that reached the model), C (best-effort action checks); Gates 0–3; `HARNESSES` not `DEFAULT_HARNESSES`; the reseller-claim sentence for a gateway model id | `docs/design/opencode-seat.md` §3–§7 (PR 58 head) |

## 3. The identity gate, and what differs from OpenCode

Agent-rules 7: "a harness that can only load another seat's identity file does not join". OpenCode's `instructions` key **added** to
`AGENTS.md`; the fix was an undocumented environment variable plus a plugin that read the system prompt. Hermes's loader is
different in two ways that matter and one that does not:

1. **Precedence is documented and in code**, and Gate 0 (a) confirms it: a root `.hermes.md` is the only project context the session
   gets. No flag, no environment variable. The workspace snapshot still *names* "AGENTS.md, CLAUDE.md, .cursorrules" in the system
   prompt (names only, Gate 0 every run); that line is informational and carries no actor.
2. **The fallback is also documented**, and Gate 0 (b) and (e) confirm both routes to Codex's identity: a missing `.hermes.md`, and a
   subdirectory `AGENTS.md` reached through a tool result. The repository has no subdirectory context file today (checked
   2026-10-05); the guard treats that as a condition to keep checking, not a fact to rely on.
3. The SOUL.md route (identity in the profile, project files skipped) **does not exist as documented** at this commit: Gate 0 (d).
   This note does not use it. Should a later Hermes commit honour `agent.skip_context_files`, it would be a second layer A, not a
   replacement for layer B.

So the identity control is, as for OpenCode, the check on **what actually reached the model**, not the loader's behaviour.

## 4. The three layers

| Layer | Mechanism | What it is |
|---|---|---|
| **A. Loader** | the committed root `.hermes.md` (§5) plus the launcher `scripts/hermes-seat.sh` (§6) | keeps other seats' files out of the startup prompt; refuses to start when the preconditions fail |
| **B. Identity control** | the guard plugin `retrace-guard` (§4.1), in `plugins.enabled`, hooks `on_session_start`, `pre_api_request`, `transform_tool_result`, `pre_tool_call` | **the reason the seat may join**: it reads every message the harness is about to send, and blocks every tool when the session is not the Hermes seat's |
| **C. Action checks** | the same plugin on `pre_tool_call` | best effort, as opencode-seat §4 says: model self-report, commit trailers, edit-to-log coverage. The enforcement of record for a false trailer stays at Worker ingestion (`commit-trailer-consistency.md` §13) |

### 4.1 The guard, stated as checks

The plugin keeps per-`session_id` state: `model` (from `on_session_start`), `identity_ok` (unset until proven), `blocked` (with reason).

1. **Seat marker required.** On the first `pre_api_request` of a session, the `request` messages must contain a system message with
   `RETRACE-SEAT: hermes` and `Retrace-Actor: hermes`. Absent → `blocked = "no seat identity in prompt"`. This closes Gate 0 (b) and (c)
   alike: a missing file and a scanner-blocked file both leave the marker out.
2. **No other seat, anywhere.** On every `pre_api_request`, every message of any role, tool results included, is scanned for
   `Retrace-Actor:` or `RETRACE-SEAT:` followed by anything but `hermes`, and for the literal identity markers of the five identity files
   (`Retrace-Actor: claude-code`, `codex`, `grok`, `github-copilot`, `cursor-agent`). A hit → `blocked = "another seat's identity reached the model"`.
   This closes Gate 0 (e) at the next request; `transform_tool_result` (3) closes it before.
3. **Spliced context is stripped.** On `transform_tool_result`, a result containing "[Subdirectory context discovered:" is cut at that
   marker and the event is recorded; if the cut text carried another seat's marker, `blocked` is set as in 2.
4. **Blocked means no tool.** On `pre_tool_call`, while `blocked` is set or `identity_ok` is not, the plugin returns
   `{"action": "block", "message": <reason>}` for **every** tool, `terminal` and `mcp_retrace_*` included. The harness fails closed on a
   hook timeout (`plugins_dispatch.py:49`), so a crashed guard also blocks. A session that cannot act can still answer in text; a reply
   is not an action (agent-rules 15).
5. **Model equality (layer C).** A `mcp_retrace_retrace_log` or `mcp_retrace_retrace_instruct` call whose `actor.model` differs from the
   session's `model` is blocked with the two strings in the message. The seat's MCP server is launched with `RETRACE_ACTOR_MODEL` set
   by the launcher from `config.yaml` and `RETRACE_ACTOR_MODEL_SOURCE=harness-config` (`model-source.md` §4; the launcher reads a
   configured value), so the ordinary path never trips this check; the check catches a narrated model. Under H-a a2 or a3 the model id
   is the gateway's claim and no line in this repository may call it verified (opencode-seat §6).
6. **Commits (layer C).** A `terminal` command that contains `git commit` is blocked unless its message carries `Retrace-Actor: hermes`,
   `Retrace-Model:`, `Retrace-Model-Source:` and `Retrace-Caused-By:` as one final paragraph, and is blocked when it contains `--amend`
   or names another actor. `git commit -F`, a heredoc, `-c`, or a shell the plugin cannot parse step around this; stated, not closed.
7. **Coverage (layer C).** A commit is blocked while a path this session edited (tracked from `post_tool_call` on `write_file`,
   `patch`, and `terminal` writes the plugin can see) has never been named in a `retrace_log` the session made. Best effort for the
   same reasons.

What the guard proves and does not: it establishes that the text the harness sent to the model carried the Hermes seat's identity and
no other seat's, and that no tool ran otherwise. It does not prove what the model did with that text, which the ledger records; it does
not prove the model id, which is the provider's or gateway's claim; it does not see a shell the plugin never saw (§9).

### 4.2 Why a Python plugin and not shell hooks

Shell hooks can block (Gate 0 (g)) and receive `request` in `extra` (Gate 0 (h)), so a shell-only guard is possible. A plugin is chosen
because `transform_tool_result` is plugin-only, because per-session state across hooks is in-process, and because the plugin is one
file the launcher can hash. Trust: plugins "run as regular in-process Python"; the profile directory is therefore inside the seat's
trust boundary, like `~/.retrace` (§9).

## 5. The identity file: `.hermes.md`

One file at the repository root, identity only, pointing at `docs/agent-rules.md` and `docs/agent-ops.md` like the five identity files.
Required lines, verbatim, because the guard matches them: `RETRACE-SEAT: hermes` and `Retrace-Actor: hermes`. It states: actor id
`hermes`; trailers `Retrace-Actor: hermes`, `Retrace-Model: <the model string the harness is configured with, verbatim>`,
`Retrace-Model-Source: harness-config`, `Retrace-Caused-By: <instruction event id>`; that `actor.model` on every log is that same
string with `model_source: harness-config`; that the seat is a builder (H-c); that Hermes's own memory, skills, cron, gateways and
subagents are off for this seat and that turning any on is a change to this note; that the owner's envelope is never used (owner-protocol
§5); that any other identity file it ever sees is a refusal, not an instruction. It must pass Hermes's context-file injection scanner
(`tools/threat_patterns.py`, scope `context`): Gate 0 (c) shows a blocked file silently removes the identity, so the file is run through
`hermes` once in Gate 1 before it is committed, and its wording avoids the scanner's patterns ("ignore … instructions", "you are now",
"pretend", "register as", "connect to the network", "unset …", one-liners).

Write protection: `security.protected_instruction_extra_patterns: [".hermes.md"]` in the seat config (the default set has
`agents.md`, `claude.md`, `soul.md`, `.cursorrules`, not `.hermes.md`).

Interaction with other harnesses: Claude Code, Codex, Cursor and Copilot do not read `.hermes.md`. Hermes reads `.hermes.md` only.
The repository must not gain a subdirectory `AGENTS.md`, `CLAUDE.md` or `.cursorrules` without the guard being live (§4.1 point 3);
a check for such files is part of the launcher's preconditions.

## 6. Configuration and launcher

### 6.1 The seat profile, committed as `hermes.retrace.yaml`, rendered by the launcher into `~/.hermes-retrace/config.yaml`

```yaml
model:
  provider: <H-a>            # a1: the vendor's provider id; a2: nous; a3: openrouter
  model: <H-a, verbatim>     # the exact string; the launcher copies it into RETRACE_ACTOR_MODEL
agent:
  max_turns: 60
  dangerous_command_approval: true
  auto_approval_dangerous: false
  disabled_toolsets: [memory, skills, web, browser, image, cronjob, delegation, messaging]
memory:
  memory_enabled: false
skills:
  write_approval: true
  guard_agent_created: true
security:
  protected_instruction_files: true
  protected_instruction_extra_patterns: [".hermes.md"]
terminal:
  backend: local
plugins:
  enabled: [retrace-guard]
mcp_servers:
  retrace:
    command: node
    args: ["<absolute path to the primary checkout>/packages/mcp-server/dist/index.js"]
    env:
      RETRACE_ACTOR: hermes
      RETRACE_TOKEN: "${RETRACE_TOKEN_HERMES}"
      RETRACE_PRODUCER_KEY_FILE: "${RETRACE_PRODUCER_KEY_FILE_HERMES}"
      RETRACE_ACTOR_MODEL: "${RETRACE_ACTOR_MODEL}"
      RETRACE_ACTOR_MODEL_SOURCE: harness-config
    tools:
      include: [retrace_instruct, retrace_log, retrace_status, retrace_why, retrace_history]
```

`hermes skills opt-out` is run once per profile (auto-seeding of skills is a CLI toggle, not a config key). No `cron:` section, no
gateway configured. Whether `disabled_toolsets` accepts every name above is measured in Gate 1 (`hermes config show` and the tool list
the stub saw: Gate 0 sent 24 tools); unknown names are a Gate 1 finding, not a silent pass. The `tools.include` list is the five tools a
builder needs; `retrace_amend`, `retrace_share`, `retrace_export`, `retrace_projects`, `retrace_verify`, `retrace_lineage` are out
(`retrace_amend` is a correction seal, Jordan's under agent-rules 14; artifact-scoped reads wedge the server, a known issue).

### 6.2 The profile's `.env` (`~/.hermes-retrace/.env`, mode 0600, written by Jordan's typed step, agent-ops 16)

`RETRACE_TOKEN_HERMES=<pinned credential>`, `RETRACE_PRODUCER_KEY_FILE_HERMES=<path, mode 0600>`, and the model provider's key under
the name Hermes expects for H-a. `.env` values never enter `os.environ` (`local.py:363`) and Gate 0 (f) showed `OPENAI_API_KEY` from
`.env` absent from the terminal; whether `RETRACE_TOKEN_HERMES` is likewise absent is measured in Gate 1 (a name Hermes does not know).

### 6.3 The launcher `scripts/hermes-seat.sh`

Runs in an Orca pane. In order: (1) `git rev-parse --show-toplevel` and refuse unless `.retrace.json` and `docs/agent-rules.md` are
present (a Retrace worktree); (2) refuse unless `.hermes.md` exists at that root and hashes to the committed file; (3) refuse if any
`AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md` or `.cursorrules` exists below the root (§5); (4) start from `env -i` with PATH, HOME, USER,
LANG, TERM and nothing else: no `RETRACE_*` from the shell (Gate 0 (f)); (5) `HERMES_HOME=~/.hermes-retrace`; render `hermes.retrace.yaml`
to `config.yaml` with absolute paths and refuse if the rendered file differs from the committed template except in those paths; copy or
link the committed `packages/hermes-plugin/retrace-guard` into the profile's `plugins/` and refuse if its hash differs from the committed
source; (6) read `model.model` from the rendered config into `RETRACE_ACTOR_MODEL`; (7) run the pinned Hermes commit
(`HERMES_COMMIT`, a 40-character sha; refuse any other checkout) from its own venv; (8) `hermes -p retrace chat`. Approvals for dangerous
commands stay interactive; a pane always has Jordan or the coordinator watching it (agent-ops 18: never send into a human's pane).

Hermes is installed by Jordan's typed step, not by the `curl | bash` installer: a shallow clone at `HERMES_COMMIT` into
`~/.hermes-retrace/hermes-agent`, `uv python install 3.14`, `uv sync --frozen --no-dev`; nothing is written to a shell rc. Gate 0 ran
Hermes exactly this way.

## 7. Gates

Nothing is called supported until a sealed event shows it (agent-rules 0).

0. **Vendor behaviour.** Done 2026-10-05 on commit `7b362884` (`evt_fb0a8f7d…`; §2). Re-run on the commit `HERMES_COMMIT` pins before
   Gate 1 if it differs.
1. **Scratch, real tools, no Worker.** The launcher as in §6.3; the MCP entry pointed at a scratch `RETRACE_DB`, `RETRACE_URL` and
   `RETRACE_TOKEN` empty; no git hook (`core.hooksPath` to an empty directory for the worktree). Model per H-a (one metered key with a cap,
   or Portal). Tests: `retrace_instruct` then `retrace_log` sealed in the scratch store with `actor.id: hermes` and the configured model;
   the guard's seven checks each exercised once with a positive and a negative (`.hermes.md` removed → every tool blocked; a decoy
   `sub/AGENTS.md` → stripped and blocked; a `retrace_log` with a narrated model → blocked; a commit without trailers → blocked; `-F`
   → recorded as **not** caught); `hermes config show` diffed against §6.1; `env` in the terminal shows no `RETRACE_TOKEN_HERMES`;
   `.hermes.md` edit by the agent → approval prompt. **Stop rule:** zero sealed `instruct`/`log` pairs after three turns with the tools
   listed is the OpenClaw outcome; stop and record.
2. **Live Worker.** Credential `hermes` and its producer key minted by Jordan's typed step (agent-ops 16); one `instruct` and one `log`
   sealed `sealed_by: pinned:hermes`, `producer_sig_verdict: verified`. Only after this do `.hermes.md`, the roster line and the
   `SETUP-GUIDE.md` section merge (§8).
3. **Clean-shell walk** of the `SETUP-GUIDE.md` section in a new shell with no inherited `RETRACE_*`, as Codex required for OpenCode.

## 8. Repository changes this note implies, each its own pull request, in order

1. this note (class a);
2. `packages/hermes-plugin/retrace-guard` with tests against recorded Gate 0 request bodies, `hermes.retrace.yaml`, `scripts/hermes-seat.sh`
   (class a: a control);
3. `HARNESSES` gains `"hermes"` and `shouldMintProducerKey` keeps it keyed (code order; `DEFAULT_HARNESSES` unchanged);
4. after Gate 2: `.hermes.md`, the `docs/team-roles.md` roster line, the `SETUP-GUIDE.md` section and the revised line 330 (class a);
5. `docs/agent-ops.md` gains the launcher rule with its retirement condition: unnecessary when Hermes honours a documented
   project-context opt-in that leaves the profile identity in place and the subdirectory hints off (upstream), and when credentials no
   longer come from process env (agent-ops 13).

## 9. Risks and limits, stated

- **Self-modification.** Memory, auto-skills, the skills hub, cron, gateways and subagents are off by configuration (§6.1); the launcher
  diffs the running config. A Hermes release that renames a key turns a disabled feature on silently; the pin (§6.3) and the Gate 1 diff
  are the control.
- **Upstream churn.** Releases merge hundreds to nearly two thousand pull requests a week; the installer tracks `main`. The seat runs a
  pinned commit and Gate 0 re-runs on every move.
- **In-process plugin.** The guard runs as the same Python process; anyone who can write the profile directory can disable it. The
  profile directory is Jordan's account, like `~/.retrace`; the launcher's hash check catches an edited plugin, not a replaced harness.
- **Fall-through and splice** are closed by the guard on the text it sees; a Hermes code path that sends text to the model without
  `pre_api_request` would bypass it. None is known at `7b362884`; Gate 0 saw every main call pass through it (`hooks.jsonl`, A2 and G).
- **Env inheritance.** The terminal sees the launching environment; the launcher starts from `env -i`. The seat never runs from a shell
  that holds the owner token.
- **Model id** under a2/a3 is a gateway's claim. `post_api_request` carries `response_model` (Gate 0 (h) payload list; the provider's
  echo of the served model): a possible verification input for `model-source.md` §4.5, untested, not claimed.
- **Approvals.** A builder in a pane needs a human for dangerous-command prompts; `auto_approval_dangerous` stays false. Unattended runs
  are out of scope for this note.
- **The guard's layer C** is best effort by construction (§4.1 points 6 and 7); the classifier is the enforcement of record.
- **Hermes probes the custom endpoint** with `POST /api/show` (an Ollama-style call) before the first completion and streams by default
  (Gate 0); under a1 both go to the vendor and are harmless; recorded so nobody reads them as a leak.

## 10. What this note does not claim

That Hermes is supported (Gate 2); that a Hermes session calls the tools (Gate 1); that the guard is written (§8 item 2); that the
model id is verified (§9); that NemoHermes on the PC works (H-b b2, PR 179's gates); that any Nous model is involved (none is).

## 11. Dispositions of review findings

None yet. Review rounds append here, each finding with its disposition and the event id, under agent-rules 10.
