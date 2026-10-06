# Hermes seat: Hermes Agent as an opt-in builder (design note v2)

**Status:** v1, 2026-10-05, by `claude-code` (the "Hermes seat investigation" pane, author; `claude-fable-5-1`, model source harness-runtime). Drafted at 01:30 MDT; the four decisions were signed at 01:45 MDT (`evt_648a046e4778483b81db7bcbf2babc1e`, "0a, a2, b1, c1") and folded in.
**Not built.** Class (a) under agent-rules 12: it defines a new seat, its identity file, a guard that governs what the seat may do,
the custody of its credential, and a launcher. Written on Jordan's signed `evt_af0778b61f08410884d91c94aafd9db6` ("Draft design
note"), after his signed `evt_3c29b74571ab49f5a69d8995c4125348` ("Investigate potential hermes seat") and `evt_cfd331e1abec4c50b99bb6bd3974e26b`
(the go for Gate 0). The investigation is `~/.retrace/hermes-seat-2026-10-05/ASSESSMENT.md` (sha256 `d5be3a62…`, `evt_1841872d…`)
and its Gate 0 measurement `gate0/RESULTS.md` (sha256 `b1b329b4…`, `evt_fb0a8f7d50274ea48b9658e42b288f9f`). The template is
`docs/design/opencode-seat.md` (PR 58, closed) for the identity gate and `docs/design/cloud-seat.md` for the shape of a seat note.
- **v2, 2026-10-05 05:12 MDT (11:12Z):** round-1 findings resolved in place: Codex C-M1–C-M6 and C-L1 (`evt_a698ffe7835a44f19d0fbdd23393b093`,
  rejected), Grok G-M1 and G-L1–G-L3 (`evt_f96d9a68f62049e4b2a3734633ffe69d`, rejected); NOOA approved with no findings
  (`evt_2ad4a2d444e04def9dd992a599e78d1a`). One fix round for all eleven on Jordan's `evt_21422d2f03204b2abe05805d5d2864b4` ("Go on A for
  183"), gate check `evt_91b3cc8d94a04dbe84ce36009f38afc0`, fix-round routing `evt_5cb66e9614954a5dac6c15fb378d8212`. §11 gives each disposition.
  Fixed in place because the note is an unmerged draft (Jordan, `evt_9dc98206`).
- **Corrected in place, 2026-10-06** (agent-rules 10; the note is merged): nine dated corrections from building and reviewing the Gate 1a
  prep files (PR 186, merged as `27f4264f`), each marked *Correction 2026-10-06* beside the text it corrects; the earlier text stays.
  §8 item 2 is now built and merged; the seat is still not supported (Gate 1a has not run). One correction withdraws a claim the author
  made while building PR 186, that the guard's veto needs a `tools.override` grant (§6.1; ledger `evt_d96ee652f76d498dba1b03395f029d43`).
  Instruction root: Jordan's signed "Continue", `evt_55be366775f74225920fafb4357fbec0`.

**Decisions taken.** The four decisions in §1 were Jordan's; he signed `0a, a2, b1, c1` (`evt_648a046e…`). The table keeps the options
and the author's recommendations beside what was taken, so a reader sees where the decision followed the recommendation (H-0, H-b,
H-c) and where it did not (H-a: Nous Portal rather than a direct vendor key).

## 0. What this note decides, and what it leaves to the gate

- **The seat.** Hermes Agent (Nous Research, MIT) joins as actor id `hermes`, an **opt-in builder**: in `HARNESSES`, never in
  `DEFAULT_HARNESSES` (`packages/mcp-server/src/admin.ts` lines 40–41), never a reviewer (agent-rules 11; team-roles 1). One pinned
  credential, one producer key, one identity file (`.hermes.md` at the repository root), one launcher, one guard plugin and one
  independent shell hook that blocks when the plugin did not load (§4.2).
- **Why it may join** when OpenCode could not without an undocumented flag: Hermes loads **one** project context type per session and
  ranks `.hermes.md` above `AGENTS.md`, `CLAUDE.md` and `.cursorrules` in code and in its documentation (§2). Gate 0 measured it.
- **Why it may join only with the guard:** the same code falls through to `AGENTS.md` when `.hermes.md` is missing, and it splices a
  subdirectory `AGENTS.md` into tool results mid-session. Gate 0 measured both (§2). The guard (§4) is the identity control; the
  file precedence is the convenience. The guard detects and then blocks; it cannot strip text from a request (§4.1 check 3).
- **What it leaves to later:** the exact text of the launcher, the plugin and the config template (each its own pull request, §8);
  the results of Gates 1–3 (§7), which go into dated corrections here; the roster line in `docs/team-roles.md` and the `SETUP-GUIDE.md`
  section, which merge only after Gate 2 (agent-rules 0: nothing says "supported" before a verified seal).

## 1. The decisions Jordan owns

| | Question | Options | Recommendation | Taken (`evt_648a046e…`) |
|---|---|---|---|---|
| **H-0** | Is a seventh seat wanted at all? `SETUP-GUIDE.md` line 330 says "do not add … a sixth agent … while completeness (omission detection) and attribution … are still weak"; the 2026-09-01 NemoClaw assessment said the same. Since then: trailer-consistency classifier (PR 19 line), model-source v2 (PR 118/119), reconcile HEAD-only, `@retrace-dev/cli` 0.3.0 | (0a) yes, and that sentence is revised to name the gates a new seat must pass; (0b) yes, as a time-boxed pilot with no roster line; (0c) no, file this note as reference | **0a**: the gates in §7 are the condition the sentence lacked. The sentence changes in the same pull request as the roster line, after Gate 2 | **0a**: a seventh seat, and `SETUP-GUIDE.md` line 330 is revised to name the gates (§8 item 4) |
| **H-a** | Which model and provider, and whose claim is the model id? | (a1) a vendor outside the Core Four on its own API key (DeepSeek, Moonshot, Alibaba, Zhipu…): the vendor's claim, metered; (a2) Nous Portal Plus, $20/month for $22 credit: a reseller's claim (opencode-seat §6 precedent), 300+ models; (a3) OpenRouter: reseller's claim, metered; (a4) a Core Four model (Anthropic/OpenAI/xAI): no vendor diversity, duplicates a seat | **a1** if the budget allows one metered key with a hard monthly cap; otherwise **a2**. Not a4: a builder on GPT or Claude adds a harness and no independence. Not a Nous model: Nous says Hermes 4 is "not recommended for use inside Hermes Agent" | **a2**: Nous Portal. The model is chosen from the Portal catalog at Gate 1 and recorded verbatim; the model id is the Portal's claim (§6.1, §9). A model from a vendor outside the Core Four is preferred within that catalog (team-roles 3) |
| **H-b** | Where does it run? | (b1) this laptop, an Orca pane, like the other seats; (b2) NemoHermes inside OpenShell on the Omarchy PC, a second tenant of PR 179's custody (bearer substituted at egress, no key in the sandbox) | **b1** for Gates 1–3; b2 after PR 179's W4–W6 exist, as a dated amendment here | **b1**: this laptop, an Orca pane |
| **H-c** | What may it do? | (c1) build only: edits, tests, commits, pushes to non-main branches, pull requests opened by the coordinator from its branch; (c2) build and open its own pull requests; (c3) build and review | **c1**, matching OpenCode; c2 after one clean Gate 3; never c3 (team-roles 1, 3) | **c1**: build only |

The note below is written under 0a, a2, b1, c1. A later change to any of them is a dated amendment here.

## 2. Evidence

| Source | What it shows | Where |
|---|---|---|
| Hermes source, commit `7b362884d88c887bdcc68271c3b51d25ad1a2197` (main, 2026-10-04) | "Only ONE project context type loads, first found wins: .hermes.md/HERMES.md (walk to git root) → AGENTS.md chain (git root → cwd) → CLAUDE.md (cwd) → .cursorrules + .cursor/rules/*.mdc (cwd)"; mid-session `_HINT_FILENAMES` = AGENTS.override.md, AGENTS.md, agents.md, CLAUDE.md, claude.md, .cursorrules (not .hermes.md), working directory pre-marked loaded; `pre_tool_call` timeouts fail closed; shell hooks block only on `pre_tool_call`; protected instruction basenames agents.md, claude.md, soul.md, .cursorrules (not .hermes.md); the terminal child env is `os.environ` minus a **name-based** credential blocklist; `.env` values never enter `os.environ` | `agent/prompt_builder.py:1797`, `agent/subdirectory_hints.py:20,152`, `hermes_cli/plugins_dispatch.py:49`, `agent/shell_hooks.py:44`, `tools/file_tools_write_guards.py:188`, `tools/environments/local.py:334` (`_scrub_credentials`), `:328` and `:365` (the `os.environ.copy()`), `:363` (the `.env` comment); `tools/environments/base.py:358–366` and `local.py:1043–1053` (the login-shell snapshot, `bash -l -c`, sourcing `~/.profile`, `~/.bash_profile`, `~/.bashrc` unless `terminal.shell_init_files` is set, 759–800); `hermes_cli/plugins_loader.py:494–513` (a plugin that fails to import, register or load in time is dropped and startup continues); `hermes_cli/plugins_dispatch.py:42–49, 210–242` (`pre_api_request` is a bounded observer that fails open; only `pre_tool_call` fails closed); `agent/tool_executor.py:1123–1129, 1790–1805` (the subdirectory hint is appended in `_commit_tool_result`, after `transform_tool_result`); `hermes_cli/config_defaults.py:1669–1704` (`approvals.mode`, default `smart`), `:579–580` (`compression.enabled`, default true), `:334–337` (`terminal.home_mode`) |
| Gate 0, measured 2026-10-05 01:00–01:08 MDT on a stub model at 127.0.0.1 (`evt_fb0a8f7d…`; `gate0/RESULTS.md`; `HASHES.txt`) | (a) with a root `.hermes.md` only it loaded (requests `0f48c42e…`); (b) without it, `AGENTS.md` with `Retrace-Actor: codex` reached the model (`6c0c086c…`); (c) a scanner-blocked `.hermes.md` yields a "[BLOCKED…]" placeholder, no fall-through, no identity (`d7639a11…`); (d) `agent.skip_context_files` in config.yaml is not honoured, `--ignore-rules` drops SOUL.md too (`96eca2d4…`, `3a016b5d…`); (e) a decoy `sub/AGENTS.md` arrived inside a `read_file` tool result (`2aa6ae41…`); (f) `RETRACE_URL`, `RETRACE_TOKEN`, `RETRACE_DB` from the launching shell were visible to the Hermes terminal, `OPENAI_API_KEY` from the profile `.env` was not; (g) a fail-closed `pre_tool_call` shell hook blocked every tool once a decoy identity was flagged (`c07ad134…`); (h) `on_session_start`, `pre_llm_call`, `pre_api_request` payloads carried the configured model string, and `pre_api_request` also `provider`, `base_url`, `api_mode`, `request` (`7325d53d…`) | `~/.retrace/hermes-seat-2026-10-05/gate0/runs/<V>/requests.jsonl`, `hooks.jsonl`. **Which script produced which run:** A, B, C, D and E ran with a list-form `hooks:` block that Hermes ignores (so they have no `hooks.jsonl`); A2, D2 and G ran with the dict form that `gate0/run.sh` carries since. A re-run of A and B from the current script reproduces results (a) and (b) but not the recorded bytes (the hooks now fire; Grok's reproduction, `evt_f96d9a68…`); the recorded files still hash as `HASHES.txt` says |
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
| **A. Loader** | the committed root `.hermes.md` (§5) plus the launcher `scripts/hermes-seat.sh` (§6.3) | keeps other seats' files out of the startup prompt; refuses to start when the preconditions fail |
| **B. Identity control** | the guard plugin `retrace-guard` (§4.1) on `on_session_start`, `pre_api_request`, `pre_auxiliary_call`, `pre_tool_call`, `post_tool_call`, **and** an independent shell hook on `pre_tool_call` (§4.2) | **the reason the seat may join**: every provider-bound request is scanned, a tool runs only on a request that passed, and the second mechanism blocks when the first failed to load |
| **C. Action checks** | the same plugin on `pre_tool_call` | best effort, as opencode-seat §4 says: model self-report, commit trailers, edit-to-log coverage. The enforcement of record for a false trailer stays at Worker ingestion (`commit-trailer-consistency.md` §13) |

### 4.1 The guard, stated as checks

The plugin keeps per-`session_id` state: `model` (from `on_session_start`); `verdicts`, a map from `api_request_id` to `ok` or `failed`
with the reason and the sha256 of the request body scanned; `blocked`, a sticky reason. It appends every verdict to
`<profile>/run/guard/<session_id>.jsonl` (the file §4.2's shell hook reads).

1. **Every provider-bound request is scanned.** On each `pre_api_request`, the plugin reads the `request` body (Gate 0 (h): the payload
   carries it) and records a verdict for that `api_request_id`: `ok` only when a system message carries both `RETRACE-SEAT: hermes` and
   `Retrace-Actor: hermes` **and** no message of any role, tool results included, carries `Retrace-Actor:` or `RETRACE-SEAT:` followed by
   anything but `hermes`, nor any of the five identity markers (`Retrace-Actor: claude-code`, `codex`, `grok`, `github-copilot`,
   `cursor-agent`). A missing marker (Gate 0 (b), (c)) or a foreign marker (Gate 0 (b), (e)) is `failed`; a foreign marker also sets `blocked`.
2. **A tool runs only on a request that passed** (Codex C-M1). `pre_tool_call` carries the originating `api_request_id`
   (`agent/tool_executor.py:826, 1692`; `agent/inline_tool_executors.py:27`). The plugin returns `{"action": "block", "message": …}` unless
   that id has verdict `ok` in this session. An absent id, an id with no verdict (the scan never ran, timed out or raised: `pre_api_request`
   is a bounded observer that fails open, `hermes_cli/plugins_dispatch.py:42–49, 210–242`, and its caller swallows errors,
   `agent/turn_api_request.py:51–90`), or a `failed` verdict all block. An earlier request's `ok` never authorizes a later request's tools.
3. **Spliced subdirectory context is detected and bounded, not stripped** (Codex C-M3). Hermes appends the hint inside
   `_commit_tool_result` (`agent/tool_executor.py:1123–1129`), after `transform_tool_result` has run (1790–1805; concurrent results
   1515–1535), so no plugin hook sees the splice before the model does, and `pre_api_request` cannot modify a request. Three measures:
   (i) prevention for this repository: the launcher refuses to start while any `AGENTS.override.md`, `AGENTS.md`, `agents.md`, `CLAUDE.md`,
   `claude.md` or `.cursorrules` exists below the worktree root (the six names in `agent/subdirectory_hints.py:20`); (ii) prevention at the
   call, best effort: on `pre_tool_call` for `read_file`, `write_file`, `patch`, `search_files`, `list_dir` and any `terminal` command whose
   path arguments parse, the plugin walks from each path's directory up to the worktree root and blocks the call if one of the six names
   exists on the way ("a context file sits on this path"); (iii) detection, the guarantee: the spliced text is a tool message in the next
   request, so check 1 records `failed` and `blocked`, and check 2 stops every tool. **The guarantee is therefore:** the model may see such
   text once; no tool runs after it. Upstream ask, recorded: a configuration switch for subdirectory hints (`skip_context_files` honoured
   from config would cover it; Gate 0 (d) shows it is not).
4. **Blocked means no tool.** While `blocked` is set, check 2 blocks every tool, `terminal` and `mcp_retrace_*` included. A registered
   `pre_tool_call` callback that times out or raises also blocks (`plugins_dispatch.py:49`, and the raise path at 240–242). **That covers a
   registered callback only;** a plugin that never loaded is §4.2. A session that cannot act can still answer in text; a reply is not an
   action (agent-rules 15).
5. **Auxiliary model calls are scanned too** (Codex C-L1). Titling, compression, vision and approval models go through
   `pre_auxiliary_call` / `post_auxiliary_call` (`agent/auxiliary_hooks.py`: the `pre_api_request` payload shape plus `aux_task`), which
   the main-loop events never carry. The plugin subscribes and applies check 1; a hit sets `blocked`. Those hooks are observer-only and
   fail open (their module docstring), so this is detection; an auxiliary call produces no tool call, so the bound in check 3 holds. The
   seat configuration disables compression (§6.1), leaving title generation as the auxiliary task Gate 0 observed (run A, request 5).
   *Correction 2026-10-06 (source: Gate 1a prep smoke 2026-10-05, the title-generation request; PR 186, `scan_messages(require_seat=False)`):* an
   auxiliary request carries Hermes's own prompt, not the seat's system prompt, so it never holds the seat marker. The plugin applies
   only the foreign-marker half of check 1 to auxiliary requests; requiring the marker there would fail every auxiliary call.
6. **Model equality (layer C).** A `mcp_retrace_retrace_log` or `mcp_retrace_retrace_instruct` call whose `actor.model` differs from the
   session's `model` is blocked with the two strings in the message. The seat's MCP server is launched with `RETRACE_ACTOR_MODEL` set by
   the launcher from `config.yaml` and `RETRACE_ACTOR_MODEL_SOURCE=harness-config` (`model-source.md` §4), so the ordinary path never trips
   this check; it catches a narrated model. Under a2 the model id is the Portal's claim (§9).
   *Correction 2026-10-06 (source: Gate 1a prep smoke 2026-10-05, Hermes log "registered 5 tool(s): mcp__retrace__retrace_log, …"; PR 186):* Hermes
   `7b362884` registers MCP tools as `mcp__<server>__<tool>`, so the names in checks 4 and 6 are `mcp__retrace__*`,
   `mcp__retrace__retrace_log` and `mcp__retrace__retrace_instruct`, not `mcp_retrace_*`. The guard matches both spellings.
7. **Commits (layer C).** A `terminal` command that contains `git commit` is blocked unless its message carries `Retrace-Actor: hermes`,
   `Retrace-Model:`, `Retrace-Model-Source:` and `Retrace-Caused-By:` as one final paragraph, and is blocked when it contains `--amend` or
   names another actor. `git commit -F`, a heredoc, `-c`, or a shell the plugin cannot parse step around this; stated, not closed.
8. **Coverage (layer C).** A commit is blocked while a path this session edited (tracked from `post_tool_call` on `write_file`, `patch`,
   and `terminal` writes the plugin can see) has never been named in a `retrace_log` the session made. Best effort for the same reasons.
   *Correction 2026-10-06 (source: PR 186 round 1, Grok G-L1 `evt_c3935c1191094e0c98e489ae7fa233e9`; test `test_terminal_writes_tracked_for_coverage`):*
   the terminal writes the plugin can see are redirect targets (`>`, `>>`), `tee` files, `sed -i` files, `cp` and `mv` destinations, and
   the `+++` paths of a patch file given to `git apply` or `patch`. It cannot see heredoc bodies, scripts the shell executes, `git apply`
   from stdin, or programs that choose their own paths.

What the guard proves and does not: every request the harness sent through `pre_api_request` or `pre_auxiliary_call` was scanned and
no tool ran on a request that did not pass; the model may have seen foreign text once (check 3) and acted on nothing. It does not prove
what the model did with text it saw, which the ledger records; it does not prove the model id, which is the Portal's claim; it does not
see a shell the plugin never saw (§9); and it depends on the plugin having loaded, which §4.2 covers.

### 4.2 Two mechanisms, because a plugin can fail to load (Codex C-M2)

`hermes_cli/plugins_loader.py:494–513` catches an import error, a registration error and a load timeout, disposes of what the plugin
registered, logs a warning and **continues**; discovery goes on (`hermes_cli/plugins.py:1495–1502`), and with no callback registered nothing
issues a block (`plugins_dispatch.py:227`). A hash of the plugin source and an entry in `plugins.enabled` prove that the file was there, not
that it loaded. So the seat has a second mechanism, loaded by a different code path: the `hooks:` block of `config.yaml`, parsed by
`agent/shell_hooks.py` (Gate 0 (g) exercised it). A `pre_tool_call` shell hook with `fail_closed: true` runs `retrace-guard-check.sh`, which
reads `session_id` and the `api_request_id` from its stdin payload (`extra`), opens `<profile>/run/guard/<session_id>.jsonl` and exits
quietly only when that id has verdict `ok` there; in every other case, the file missing included, it prints `{"action": "block", …}`.
Properties: plugin absent or failed to load → no verdict file → every tool blocked; shell hook absent (a config error) → the plugin still
blocks; both fail only if the config and the plugin both failed, which the launcher's hashes (§6.3) and Gate 1a's negatives cover.
Shell hooks need consent on first run (`hooks_auto_accept`, `HERMES_ACCEPT_HOOKS`); the launcher sets it because it has already hashed the
script and the config. The launcher also runs the pinned Hermes once pre-start with the profile to confirm the plugin loads in that
environment; that is a smoke, not a guarantee for the live process, and the note does not call it one.

*Correction 2026-10-06 (source: PR 186 round 2, the coordinator's measurement in gate check `evt_19afe0c6f47c42d481741176a283d35d`; Hermes
`agent/shell_hooks.py` `_evaluate_result`, lines 406–437):* "prints `{"action": "block", …}`" is not enough. Hermes treats a hook that
exits 0 with no directive as allow, even with `fail_closed: true`, and the first version of the check let five of the nine measured inputs
through that way. The contract the check meets as merged in PR 186: it reads the payload from stdin, never argv, so a payload over 128 KiB cannot
break it; it type-checks the payload, its `extra` and every verdict-file line; on every failure, a missing `python3` included, it prints a
block directive and exits 2, Hermes's `BLOCK_EXIT_CODE`, which blocks even without a directive; nothing forces exit 0; and it runs python
isolated (`-I`), so a `json.py` in the working directory or on `PYTHONPATH` cannot end the check. Measured with `measure-guard-check.sh`
(sha256 `cf5022db…`): a passing verdict allows; eight failing inputs block.

Why a plugin at all, when the shell hook could do everything: per-session state across `pre_api_request`, `pre_auxiliary_call` and
`pre_tool_call` is in-process, and the request body is large; the shell hook is the small, independent, fail-closed check on the plugin's
output. Trust: plugins "run as regular in-process Python"; the profile directory is inside the seat's trust boundary, like `~/.retrace` (§9).

## 5. The identity file: `.hermes.md`

One file at the repository root, identity only, pointing at `docs/agent-rules.md` and `docs/agent-ops.md` like the five identity files.
Required lines, verbatim, because the guard matches them: `RETRACE-SEAT: hermes` and `Retrace-Actor: hermes`. It states: actor id
`hermes`; trailers `Retrace-Actor: hermes`, `Retrace-Model: <the model string the harness is configured with, verbatim>`,
`Retrace-Model-Source: harness-config`, `Retrace-Caused-By: <instruction event id>`; that `actor.model` on every log is that same
string with `model_source: harness-config`; that the seat is a builder (H-c); that Hermes's own memory, skills, cron, gateways and
subagents are off for this seat and that turning any on is a change to this note; that the owner's envelope is never used (owner-protocol
§5); that any other identity file it ever sees is a refusal, not an instruction; and, until the roster lists the seat, one line saying
**"Gate 2 has not passed; this seat is not supported until `docs/team-roles.md` lists it."**

**Order (Codex C-M6).** The file is committed in the pull request that brings the guard and the launcher (§8 item 2), before Gate 1, so
the launcher's check 2 (the working file hashes to `git show HEAD:.hermes.md`) can pass on the probe branch. Its injection-scanner check
is a unit test in that pull request: the test runs the pinned Hermes scanner (`tools/threat_patterns.py`, `_scan_for_threats(scope="context")`,
the function `agent/prompt_builder.py:84` calls) on the file's bytes and fails on any finding, because Gate 0 (c) showed a blocked file
removes the identity silently. The file's wording avoids the scanner's patterns ("ignore … instructions", "you are now", "pretend",
"register as", "connect to the network", "unset …", one-liners). The roster line, the `SETUP-GUIDE.md` section and every "supported"
claim stay gated at Gate 2 (§8 item 4); the committed file says so itself.

Write protection: `security.protected_instruction_extra_patterns: [".hermes.md"]` in the seat config (the default set has
`agents.md`, `claude.md`, `soul.md`, `.cursorrules`, not `.hermes.md`).

Interaction with other harnesses: Claude Code, Codex, Cursor and Copilot do not read `.hermes.md`. Hermes reads `.hermes.md` only.
The repository must not gain a subdirectory `AGENTS.md`, `CLAUDE.md` or `.cursorrules` while the seat exists (§4.1 check 3); the launcher
refuses to start if one does.

## 6. Configuration and launcher

### 6.1 The seat profile, committed as `hermes.retrace.yaml`, rendered by the launcher into `~/.hermes-retrace/config.yaml`

```yaml
model:
  provider: nous             # H-a a2: Nous Portal
  model: <chosen at Gate 1b from the Portal catalog, verbatim as Hermes records it; the launcher copies it into RETRACE_ACTOR_MODEL>
agent:
  max_turns: 60
  disabled_toolsets: [memory, skills, web, browser, cronjob, delegation, image_gen]
approvals:
  mode: manual               # every approval prompt goes to the human at the pane; the default `smart` lets an auxiliary model auto-approve
  unattended_mode: deny
  single_query_mode: deny
  cron_mode: deny
compression:
  enabled: false             # no auxiliary compression requests (§4.1 check 5); a session is one bounded build
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
  home_mode: profile         # HOME for tool subprocesses is ~/.hermes-retrace/home, which the launcher creates and keeps empty (§6.3)
  auto_source_bashrc: false
  shell_init_files: []
plugins:
  enabled: [retrace-guard]
hooks:
  pre_tool_call:
    - command: "<absolute path>/retrace-guard-check.sh"
      timeout: 10
      fail_closed: true
hooks_auto_accept: true      # the launcher has hashed the script and this file; the first-run consent prompt would otherwise stall a start
mcp_servers:
  retrace:
    command: node
    args: ["<absolute path to the primary checkout>/packages/mcp-server/dist/index.js"]
    env: <exactly one of the two phase blocks below, chosen by the launcher's --phase>
    tools:
      include: [retrace_instruct, retrace_log, retrace_status, retrace_why, retrace_history]
```

The `disabled_toolsets` names are the registered ones at `7b362884` (Grok, `evt_f96d9a68…`: `memory`, `skills`, `web`, `browser`, `cronjob`,
`delegation` and `image_gen` exist; `image` and `messaging` do not). Messaging platforms are bundles that load only when a gateway is
configured, and none is. `approvals.mode: manual` replaces two keys an earlier draft named that do not exist at this commit (Grok G-M1:
`agent.dangerous_command_approval`, `agent.auto_approval_dangerous`; unknown keys are stored and ignored, so the default `smart` would have
stayed in force). `hermes skills opt-out` is run once per profile (auto-seeding of skills is a CLI toggle, not a config key). No `cron:`
section, no gateway. The `tools.include` list is the five tools a builder needs; `retrace_amend`, `retrace_share`, `retrace_export`,
`retrace_projects`, `retrace_verify` and `retrace_lineage` are out (`retrace_amend` is a correction seal, Jordan's under agent-rules 14;
artifact-scoped reads wedge the server, a known issue).

*Correction 2026-10-06 (source: Gate 1a prep smoke 2026-10-05; PR 186 `hermes.retrace.yaml`; measurement `evt_d96ee652f76d498dba1b03395f029d43`):* the
template as built adds four keys the block above lacks. `_config_version: 49`: without it Hermes logged the file as a config older than
version 12 that it could not migrate.
`mcp_discovery_timeout: 30` and `mcp_single_query_discovery_timeout: 30` give the retrace MCP server time to start; the defaults are 1.5 s
and 15 s. `tools.tool_search.enabled: "off"` keeps every tool eager rather than behind a search bridge; whether the default would defer
the retrace tools was not measured. The hook command points at the profile's copy, `<profile>/bin/retrace-guard-check.sh` (§6.3).
**No capability grant.** While building PR 186 the author wrote that the guard's `pre_tool_call` veto needs
`plugins.entries.retrace-guard.granted_capabilities: [tools.override]`, and PR 186 shipped that grant. The claim was wrong. Hermes honours
any plugin's block directive with no capability check (`hermes_cli/plugins.py` 2040–2092); `tools.override` only decides whether a
plugin may replace built-in tools (`hermes_cli/plugins_loader.py` 556–573). Measured 2026-10-06 with the grant removed, the shell hook
dropped and the request scan skipped: Hermes logged the capability as denied, and the plugin alone blocked every tool. The pull request
that carries these corrections removes the grant and the manifest's capability declaration.

**The MCP environment, complete, per phase (Codex C-M4).** Hermes gives a stdio child only its safe baseline plus the server entry's own
`env` (`tools/mcp_tool_config.py:182–200`), and the launcher starts from `env -i`, so nothing reaches the server that this block does not
name. The template commits two blocks, `mcp_env_scratch` and `mcp_env_live`; the renderer copies exactly one into `env` and the launcher
accepts no other difference from the template except the absolute paths it renders.
*Correction 2026-10-06 (source: PR 186 round 1, Grok G-L4 and G-M1, `evt_c3935c1191094e0c98e489ae7fa233e9`):* the blocks live in
`hermes.retrace.phases.yaml` as three: `mcp_env_common`, the five shared keys, plus exactly one of `mcp_env_scratch` and `mcp_env_live`.
The live block names the Worker of record, `RETRACE_PUBLIC_URL` from `apps/worker/wrangler.toml`
(`https://retrace-api.slcwitit.workers.dev`), not a placeholder.

```yaml
# common to both phases
RETRACE_ACTOR: hermes
RETRACE_PROJECT: retrace                       # index.ts:56 — otherwise the project is "default"
RETRACE_ON_BEHALF_OF: jordansboxing@gmail.com  # index.ts:297–305 — with the actor lock, retrace_instruct refuses an unconfigured principal
RETRACE_ACTOR_MODEL: "${RETRACE_ACTOR_MODEL}"
RETRACE_ACTOR_MODEL_SOURCE: harness-config
# scratch (Gate 1): a local store and nothing that can reach the Worker
RETRACE_DB: "<profile>/run/scratch-<date>.sqlite"   # index.ts:165–169 — no RETRACE_URL, so the SQLite store is opened
# live (Gate 2 onward): the Worker and no local store
RETRACE_URL: "<the Worker's URL>"
RETRACE_TOKEN: "${RETRACE_TOKEN_HERMES}"
RETRACE_PRODUCER_KEY_FILE: "${RETRACE_PRODUCER_KEY_FILE_HERMES}"
```

The two blocks are mutually exclusive: a rendered `env` that names both `RETRACE_DB` and `RETRACE_URL`, or neither, fails the launcher.
Credentials never enter terminal children: they are `${VAR}` references resolved from the profile `.env` at connect time, and `.env`
values do not enter `os.environ` (`local.py:363`; Gate 0 (f) for `OPENAI_API_KEY`); the same is measured for `RETRACE_TOKEN_HERMES` at
Gate 2, the first phase that has one.

### 6.2 The profile's `.env` (`~/.hermes-retrace/.env`, mode 0600, written by Jordan's typed step, agent-ops 16)

Scratch phase: empty of Retrace values. Live phase: `RETRACE_TOKEN_HERMES=<pinned credential>` and
`RETRACE_PRODUCER_KEY_FILE_HERMES=<path, mode 0600>`. Under a2 there is no model API key in `.env`: Nous Portal authenticates by OAuth.
`hermes -p retrace auth add nous` (a browser login, Jordan's typed step) writes a refresh token to `~/.hermes-retrace/auth.json`, from which
Hermes mints a short-lived JWT per call. The Plus subscription ($20/month, $22 credit) is Jordan's outward action (agent-rules 14); the
Portal's Tool Gateway tools stay off (they are opt-in per tool).

### 6.3 The launcher `scripts/hermes-seat.sh --phase scratch|live`

Runs in an Orca pane. In order: (1) `git rev-parse --show-toplevel`; refuse unless `.retrace.json` and `docs/agent-rules.md` are present
(a Retrace worktree). (2) Refuse unless `.hermes.md` exists at that root and hashes to `git show HEAD:.hermes.md` (§5). (3) Refuse if any
of the six hint filenames (§4.1 check 3) exists below the root. (4) Start from `env -i` with PATH, HOME, USER, LANG, TERM and nothing else
(Gate 0 (f)). (5) **Terminal initialization that cannot source the account's startup files (Codex C-M5).** Hermes builds its per-session
environment snapshot through a login shell (`tools/environments/base.py:358–366`; `local.py:1043–1053`, `bash -l -c`), and by default
prepends `~/.profile`, `~/.bash_profile` and `~/.bashrc` (`local.py:759–800`); `bash -l` itself reads `/etc/profile` and the user's login
files in `$HOME` whatever Hermes prepends. So the seat sets `terminal.home_mode: profile` (`config_defaults.py:334–337`: HOME for tool
subprocesses becomes `<profile>/home`), `auto_source_bashrc: false` and `shell_init_files: []`; the launcher creates `<profile>/home`
empty and refuses to start if it contains `.profile`, `.bash_profile`, `.bash_login`, `.bashrc` or `.bash_logout`. What remains sourced is
`/etc/profile` and `/etc/profile.d/*`, system files the account does not write; the narrowed guarantee is **the seat's shell never sources
this account's own startup files**. Operator prerequisite, stated: nothing under `/etc/profile.d` exports a Retrace value (checked by name
in Gate 1a). (6) `HERMES_HOME=~/.hermes-retrace`; render `hermes.retrace.yaml` to `config.yaml` with absolute paths and the chosen phase
block; refuse if the rendered file differs from the template in anything else; copy or link the committed `packages/hermes-plugin/retrace-guard`
and `retrace-guard-check.sh` into the profile and refuse if either hashes differently from the committed source; create `<profile>/run/guard/`.
(7) Read `model.model` from the rendered config into `RETRACE_ACTOR_MODEL`. (8) Run the pinned Hermes commit (`HERMES_COMMIT`, a
40-character sha; refuse any other checkout) from its own venv, once pre-start with `hermes -p retrace plugins list` (or the equivalent
at the pinned commit) to confirm `retrace-guard` loads in this environment (a smoke, §4.2). (9) `hermes -p retrace chat`. Approvals are
`manual`: every prompt is answered by the human at the pane (agent-ops 18: never send into a human's pane).

*Correction 2026-10-06 (source: PR 186 rounds 1 and 3, Grok G-L2 and G-L1, gate check `evt_86fb5d372b4f4896b17ff027b867852b`; evidence in the
PR 186 v5 notes):* step 6 as built pins five files to HEAD, not to the working tree: the plugin's `plugin.yaml` and `__init__.py`,
`scripts/retrace-guard-check.sh`, and both config templates. A step 2b refuses, before anything is installed, when any of them differs
from HEAD or is not in HEAD. Step 6 then writes HEAD's bytes (`git show HEAD:<path>`) into `<profile>/plugins/retrace-guard/` and
`<profile>/bin/`, and checks each copy against HEAD's sha256. Steps 8 and 9 as built select the profile with `HERMES_HOME=<profile>`,
overridable for tests with `HERMES_PROFILE_HOME`, rather than `-p retrace`; both name `~/.hermes-retrace`. Before the session the
launcher runs `hermes plugins list` and `hermes mcp test retrace`. A fresh profile's first start prepares Hermes's isolated runtime
(`pm/runtime.py`), which can outlast the MCP connect timeout, so the MCP test runs once more when the first pass fails, and the launcher
refuses unless it connects. Step 9 is `hermes chat` under the same `HERMES_HOME`.

Hermes is installed by Jordan's typed step, not by the `curl | bash` installer: a shallow clone at `HERMES_COMMIT` into
`~/.hermes-retrace/hermes-agent`, `uv python install 3.14`, `uv sync --frozen --no-dev`; nothing is written to a shell rc. Gate 0 ran
Hermes exactly this way.
*Correction 2026-10-06 (source: Gate 1a prep 2026-10-05, Hermes error "requires the 'mcp' Python SDK"; Jordan's install verified
`evt_4116d080…`):* the sync needs `--extra mcp`, because the core dependencies omit the `mcp` SDK the stdio transport needs. Jordan's
typed step ran `uv sync --frozen --no-dev --extra mcp`, and the venv holds `mcp` 2.0.0. Gate 0 used no MCP server, so it did not show
the gap.

## 7. Gates

Nothing is called supported until a sealed event shows it (agent-rules 0).

0. **Vendor behaviour.** Done 2026-10-05 on commit `7b362884` (`evt_fb0a8f7d…`; §2). Re-run on the commit `HERMES_COMMIT` pins before
   Gate 1 if it differs.
1. **Gate 1a, the guard on the stub model.** The launcher in `--phase scratch` with `model.base_url` pointed at the Gate 0 stub (the only
   place the provider is overridden; the rendered difference is declared on the gate's event), the real retrace MCP server on a scratch
   `RETRACE_DB`, no git hook (`core.hooksPath` to an empty directory). The stub's recorded request bodies are the provider-bound requests
   (Codex C-M3: the assertion is on what left the harness, not on a hook's view). Positives and negatives for every check in §4.1 and §4.2:
   - check 1: `.hermes.md` removed → verdict `failed`, every tool blocked; a decoy `sub/AGENTS.md` added after start → the splice is in the
     next request body, verdict `failed`, every tool blocked; the scanner-blocked file (Gate 0 (c)) → `failed`;
   - check 2 (C-M1): a passing first request, then a second request whose scan is made to fail, to time out and to be suppressed (a test
     switch in the plugin, one way at a time) → the tools of that second request are blocked each time; a `pre_tool_call` with an
     `api_request_id` the session never scanned → blocked;
   - §4.2 (C-M2): the plugin made to fail at import, to raise during `register`, and to exceed the load deadline, one at a time → the shell
     hook blocks every tool; the shell hook removed with the plugin intact → the plugin still blocks;
   - check 3: `read_file` on a path under a directory that holds `AGENTS.md` → blocked before it runs; a `terminal` form the parser does
     not see → recorded as **not** caught before, caught after by check 1;
   - check 5: title generation observed on `pre_auxiliary_call`; compression off confirmed in `hermes config show`;
   - checks 6–8: a `retrace_log` with a narrated model → blocked; a commit without trailers → blocked; `-F` → recorded as not caught;
   - §6.3 step 5 (C-M5): a fixture HOME whose `.profile`, `.bash_profile` and `.bashrc` export a dummy marker name → the marker is absent
     from `env` inside the Hermes terminal under `home_mode: profile`, and present under `home_mode: real` as the control; `/etc/profile.d`
     checked by name for `RETRACE_`;
   - `hermes config show` diffed against §6.1; `.hermes.md` edit by the agent → approval prompt.
   **Gate 1b, the tools on the Portal model.** Same phase, the stub replaced by `provider: nous` and the chosen model, Jordan's Portal login
   in place. `retrace_instruct` then `retrace_log` sealed in the scratch store with `actor.id: hermes` and the configured model; the
   destination confirmed by reading the scratch file (Codex C-M4: the pair and where it landed). **Stop rule:** zero sealed `instruct`/`log`
   pairs after three turns with the tools listed is the OpenClaw outcome; stop and record.
2. **Live Worker.** `--phase live`. Credential `hermes` and its producer key minted by Jordan's typed step (agent-ops 16); one `instruct`
   and one `log` sealed `sealed_by: pinned:hermes`, `producer_sig_verdict: verified`; `env` inside the Hermes terminal shows no
   `RETRACE_TOKEN_HERMES` (names only). Only after this do the roster line and the `SETUP-GUIDE.md` section merge (§8 item 4).
3. **Clean-shell walk** of the `SETUP-GUIDE.md` section in a new shell with no inherited `RETRACE_*`, as Codex required for OpenCode.

## 8. Repository changes this note implies, each its own pull request, in order

1. this note (class a);
2. `.hermes.md` (§5, with the line that says the seat is not supported yet), `packages/hermes-plugin/retrace-guard` with tests against the
   recorded Gate 0 request bodies and the scanner unit test, `scripts/retrace-guard-check.sh`, `hermes.retrace.yaml` with both phase blocks,
   `scripts/hermes-seat.sh` (class a: controls);
   *Correction 2026-10-06 (source: PR 186, merged as `27f4264f`):* as built, item 2 also carries `hermes.retrace.phases.yaml`. Its tests run on
   message arrays extracted from the recorded Gate 0 request bodies, and two further suites cover the shell-hook check
   (`test_guard_check.py`) and the launcher's HEAD pins (`test_launcher_pins.py`).
3. `HARNESSES` gains `"hermes"` and `shouldMintProducerKey` keeps it keyed (code order; `DEFAULT_HARNESSES` unchanged);
4. after Gate 2: the `docs/team-roles.md` roster line, the `SETUP-GUIDE.md` section, the revised line 330, and the removal of the
   not-supported line from `.hermes.md` (class a);
5. `docs/agent-ops.md` gains the launcher rule with its retirement condition: unnecessary when Hermes honours a documented project-context
   opt-in from configuration that leaves the profile identity in place and turns subdirectory hints off (upstream), and when credentials no
   longer come from process env (agent-ops 13).

## 9. Risks and limits, stated

- **Self-modification.** Memory, auto-skills, the skills hub, cron, gateways, subagents and compression are off by configuration (§6.1);
  the launcher diffs the running config. A Hermes release that renames a key turns a disabled feature on silently (Grok G-M1 showed two
  keys that never existed doing exactly that in a draft); the pin (§6.3) and the Gate 1a diff are the control.
- **Upstream churn.** Releases merge hundreds to nearly two thousand pull requests a week; the installer tracks `main`. The seat runs a
  pinned commit and Gate 0 re-runs on every move.
- **In-process plugin, and a loader that fails open.** The guard runs as the same Python process; anyone who can write the profile
  directory can disable it, and a plugin that fails to load is dropped silently (§4.2). The shell hook is the independent check; the
  launcher's hashes catch an edited plugin or config, not a replaced harness. The profile directory is Jordan's account, like `~/.retrace`.
- **Detection, not stripping.** The guard cannot remove a spliced subdirectory file from a request (§4.1 check 3); it stops every tool
  afterwards. A Hermes code path that sends text to the model without `pre_api_request` or `pre_auxiliary_call` would bypass even that;
  none is known at `7b362884` beyond the auxiliary path now covered (Codex C-L1).
- **The shell.** `env -i` alone does not keep the owner's token out: the login-shell snapshot sources the account's startup files.
  `home_mode: profile` with an empty profile home closes that for this account's files; `/etc/profile` and `/etc/profile.d` still run and are
  checked by name (§6.3 step 5). Not claimed: isolation from anything else running under the account.
- **Model id** under a2 is Nous Portal's claim about what served the request, as OpenCode Go's was (opencode-seat §6); no line in this
  repository may call it verified. `post_api_request` carries `response_model` (Gate 0 (h) payload list; the provider's echo of the served
  model): a possible verification input for `model-source.md` §4.5, untested, not claimed.
- **Approvals.** `approvals.mode: manual`: a builder in a pane needs a human for every prompt; `unattended_mode`, `single_query_mode` and
  `cron_mode` are `deny`. Unattended runs are out of scope for this note.
- **The guard's layer C** is best effort by construction (§4.1 checks 7 and 8); the classifier is the enforcement of record.
- **Hermes probes the custom endpoint** with `POST /api/show` (an Ollama-style call) before the first completion and streams by default
  (Gate 0); under the Portal both go to Nous and are harmless; recorded so nobody reads them as a leak.

## 10. What this note does not claim

That Hermes is supported (Gate 2); that a Hermes session calls the tools (Gate 1b); that the guard or the launcher is written (§8 item 2);
that the guard strips foreign text from a request (it detects and then blocks, §4.1 check 3); that the model id is verified (§9); that
NemoHermes on the PC works (b2 was not chosen; PR 179's gates); that any Nous model is involved (the Portal serves third-party models;
none of Nous's own is chosen).

## 11. Dispositions of review findings

Round 1 reviewed head `75942525`; every finding fixed in place in v2 on `evt_5cb66e9614954a5dac6c15fb378d8212`.

| Finding | Seat, severity | Disposition | Where |
|---|---|---|---|
| C-M1 identity approval survives a failed later request check | Codex, Medium (`evt_a698ffe7…`) | **Applied.** Authorization binds to the `api_request_id` of the current request; absent, unscanned or failed → block; Gate 1a negatives for a failed, timed-out and suppressed second scan | §4.1 checks 1–2, §7 1a |
| C-M2 a plugin that fails to load leaves no guard | Codex, Medium | **Applied.** Independent fail-closed shell hook reading the plugin's verdict file; launcher hashes and pre-start smoke; crash claim narrowed to registered callbacks; Gate 1a import, registration and load-timeout negatives | §4.2, §6.1 `hooks`, §6.3 steps 6 and 8, §7 1a |
| C-M3 the transform runs before the splice is inserted | Codex, Medium | **Applied.** Stripping withdrawn; guarantee redesigned as prevention at start and at the call plus detection at the next request; Gate 1a asserts the provider-bound request body | §4.1 check 3, §7 1a, §10 |
| C-M4 the MCP entry cannot perform the gates | Codex, Medium | **Applied.** Complete, mutually exclusive scratch and live environment blocks with project and principal; renderer accepts only paths and the phase block; Gate 1b confirms the pair and its destination | §6.1, §6.3 step 6, §7 1b–2 |
| C-M5 login-shell initialization reloads startup files | Codex, Medium | **Applied.** `home_mode: profile` with an empty profile home, `auto_source_bashrc: false`, `shell_init_files: []`; guarantee narrowed to this account's files; `/etc/profile.d` prerequisite; Gate 1a marker fixture with a control | §6.1, §6.3 step 5, §7 1a, §9 |
| C-M6 Gate 1 needs an identity file the note forbids committing | Codex, Medium | **Applied.** `.hermes.md` is committed in the guard pull request before Gate 1, carrying a not-supported line; the scanner check becomes a unit test; roster and support claims stay at Gate 2 | §5, §8 items 2 and 4 |
| C-L1 auxiliary model requests are a boundary exception | Codex, Low | **Applied.** Compression disabled; guard subscribes to `pre_auxiliary_call`; claim limited to main-loop and auxiliary requests seen through those hooks | §4.1 check 5, §6.1, §9 |
| G-M1 two approval keys do not exist | Grok, Medium (`evt_f96d9a68…`) | **Applied.** `approvals.mode: manual` plus `deny` for unattended, single-query and cron modes; the two keys removed from §6.1, §6.3 and §9 | §6.1, §6.3 step 9, §9 |
| G-L1 `image` and `messaging` are not toolset names | Grok, Low | **Applied.** `image_gen`; `messaging` dropped with the reason | §6.1 |
| G-L2 a re-run is not byte-identical to the cited hashes | Grok, Low | **Applied.** §2 says which script form produced which run and that a re-run reproduces (a) and (b) but not the bytes | §2 |
| G-L3 `local.py:334` is the scrub function | Grok, Low | **Applied.** Citation corrected (334 scrub; 328 and 365 the copy; 363 the comment) | §2 |
| NOOA, no findings | NOOA, approved (`evt_2ad4a2d4…`) | nothing to dispose | — |
