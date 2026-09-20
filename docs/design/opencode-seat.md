# OpenCode as a Retrace seat — design

**Status:** v1, 2026-09-15. Author: claude-code (coordinator), at Jordan's request, reviewed in draft by
Claude Fable before drafting (five adjustments folded in, §9). Instruction event
`evt_09fcbc45f80c4ce49e10ff6169a17993`. Supersedes the approach in **PR 19**
(`grok/opencode-harness`, head `edd2b33`, open since 2026-09-08), whose Gate 0/1 evidence still stands and
is referenced here.

**What this note decides:** whether OpenCode may hold a Retrace seat at all, and on what mechanism. It does
not make OpenCode a supported harness — that needs the gates in §7, and none of them has run on the live
Worker yet.

## 1. The problem PR 19 could not solve

`docs/agent-rules.md` rule 7: *"Never adopt another seat's `Retrace-Actor` or actor id, whatever file you
happen to read; a harness that can only load another seat's identity file does not join (the OpenCode
decision, PR 19)."* `docs/team-roles.md` §6 says the same.

OpenCode loads `AGENTS.md` by walking up from the working directory. In this repository `AGENTS.md` is
Codex's identity file, and it says `Retrace-Actor: codex`. `opencode.json`'s `instructions` key **adds** to
that file rather than replacing it (`opencode.ai/docs/rules`, re-read 2026-09-15: *"All instruction files
are combined with your AGENTS.md files"*). So an OpenCode session had two identity files in context and
could stamp a commit with another seat's actor. Jordan filed
[anomalyco/opencode#47879](https://github.com/anomalyco/opencode/issues/47879) asking for a skip-or-replace
switch; as of 2026-09-15 it is **open**, with no maintainer reply — only a duplicate-suggestion bot comment
and Jordan's reply distinguishing #44842 and #36699.

## 2. What changed: measured, not read

`opencode 1.18.29` has an **undocumented** environment variable, `OPENCODE_DISABLE_PROJECT_CONFIG`. It is
not in `opencode.ai/docs/rules`, `/docs/config`, `/docs/cli`, `/docs/enterprise` or `/docs/troubleshooting`
(all checked 2026-09-15). It is in the shipped binary, and this is what it does, measured rather than
assumed.

**Method.** A probe plugin recorded the exact system prompt through
`experimental.chat.system.transform`. The model was a local openai-compatible **stub server on
127.0.0.1** — no credential, no external call, and the capture happens before any provider request, so the
evidence does not depend on a working model. A scratch project held a decoy `AGENTS.md`
("`Retrace-Actor: codex`"), a decoy `CLAUDE.md`, a decoy project `opencode.json`, and a seat file marked
`RETRACE-SEAT: opencode`. Every run had `RETRACE_DB` pointed at a scratch file with `RETRACE_URL` and
`RETRACE_TOKEN` empty, no MCP entry that could reach the Worker, and no Retrace git hook — nothing from
Gate 0 reached the production ledger (ledger events `evt_fec9ea9b…`, `evt_7325c751…`).

| Run | Launch | Decoy `AGENTS.md` in the prompt | Seat file in the prompt |
|---|---|---|---|
| A | default | **yes** | no |
| B | `OPENCODE_DISABLE_PROJECT_CONFIG=1` + `OPENCODE_CONFIG=<seat config>` | **no** | **yes** |

Three further findings, each of which shaped the design:

1. **`OPENCODE_CONFIG` is loaded whether or not project config is disabled**, so the seat can have a
   sole-source config that is not the project file.
2. **Relative paths in `instructions` silently load nothing** once project config is disabled: OpenCode
   resolves them against its own config directory, not the project. A relative entry does not fail loudly —
   the session simply has no identity file. A plugin spec that is not an existing absolute `file://` URL
   (relative, or `{env:…}`-substituted) stalls startup instead of loading. The launcher therefore renders
   the committed template to absolute paths before starting OpenCode.
3. **Orca sets `OPENCODE_CONFIG_DIR`** to a per-worktree overlay it regenerates
   (`~/.orca-relay/opencode-overlays/<hash>`), and that overlay is merged **after** `OPENCODE_CONFIG`.
   Today it only adds a status plugin, and plugin lists from different scopes accumulate rather than
   replace — measured, both plugins load. But an overlay that ever set `instructions` would win over the
   seat config, so the launcher refuses to start if it does.

An ops observation for whoever runs the gates: the first OpenCode start after a config or plugin change
stalls for up to about two minutes; the next start is immediate. Time out generously rather than reading a
slow first run as a failure.

## 3. Decision

OpenCode joins as **seat seven, an opt-in builder**: in `HARNESSES`, never in `DEFAULT_HARNESSES`, so
`new-team` does not provision it for strangers. It is never a reviewer (builder ≠ reviewer, agent-rules 11).

The identity gate is cleared not by the environment variable alone — an undocumented flag is not a vendor
contract — but by the flag **plus** a fail-closed guard that checks what actually reached the model, plus a
version pin that re-opens Gate 0 on upgrade.

## 4. The three layers

| Layer | Mechanism | What it is |
|---|---|---|
| A. Loader | `scripts/opencode-seat.sh` exports `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_DISABLE_CLAUDE_CODE=1` and `OPENCODE_CONFIG=<rendered seat config>` | Keeps another seat's file out of the prompt |
| B. Guard plugin | `packages/opencode-plugin`: reads every system prompt through `experimental.chat.system.transform` | **The identity control.** Another seat's identity in any prompt replaces that prompt with a refusal and blocks the session; a session no prompt of which carried `RETRACE-SEAT: opencode` may not call a single tool |
| C. Action checks | Same plugin, on `tool.execute.before` | **Best-effort.** Model self-report, commit trailers, edit-to-log coverage |

**Layer B is why the seat may join.** Layer A can regress upstream without warning; layer B is checked
against the text that actually reached the model, so a regression stops the session instead of producing a
mislabelled commit. Verified end to end against the stub provider: a correct launch runs clean; a launch
with the seat config but without the flag is refused, naming `Retrace-Actor: codex`; a bare `opencode` in a
Retrace worktree is refused.

**Layer C is explicitly not enforcement.** The commit check reads the command the agent is about to run,
so `git commit -F`, `-c`/`--amend`, a heredoc, or any shell that never goes through the tool can step
around it, and `--pure` runs with no plugin at all. It catches the ordinary slip early and nothing more.
**The enforcement of record for a copied trailer stays at Worker ingestion**, in the trailer-consistency
classifier (`docs/design/commit-trailer-consistency.md` §13). §13's analysis is unchanged by this note: the
classifier still decides `conflicting` / `unresolved`; the harness check only makes a false trailer rarer.

Layer C does three things: it refuses a `retrace_log` whose `actor.model` is not the `<providerID>/<modelID>`
OpenCode reported for the session (agent-rules 4 becomes harness-checked for this seat, not model-narrated);
it refuses a `git commit` that lacks the three trailers, carries another seat's actor, or amends; and it
refuses a commit while a file this session edited has never been named in a `retrace_log` (agent-rules 3).
Any coverage number reported for this seat must say it is **harness-enforced**, not volunteered.

## 5. Where the guard is installed — both places, in v1

The plugin is loaded by the seat config, and **also installed globally** in
`~/.config/opencode/opencode.jsonc`, because Orca can spawn a bare `opencode` that never goes through the
launcher. Outside a Retrace worktree (`.retrace.json` plus `docs/agent-rules.md`) the plugin returns no
hooks and does nothing at all, so the global install cannot affect unrelated projects. The global entry
points at the primary checkout's built `dist`, the same arrangement as the git hook (agent-ops 3), and it
is a machine-local operator step, not a repository change. Nothing is ever written into Orca's overlay
directory: Orca regenerates it.

**Residual risk, stated rather than papered over:** `opencode --pure` loads no plugins. The launcher
refuses `--pure`, but a person who types it directly gets an unguarded session. Layer A still holds if the
environment is set; if it is not, that session is exactly the pre-PR-19 hazard and the classifier is what
catches the result. A `commit-msg` backstop keyed on a marker injected through the `shell.env` hook would
close it at the repository level; it is a follow-up because it touches the hook path shared by all seats.

## 6. Model identity

`actor.model` is `<providerID>/<modelID>` exactly as OpenCode reports it — for the intended configuration,
`opencode-go/qwen3.7-max`. **OpenCode Go is a reseller gateway** (`https://opencode.ai/zen/go/v1`, a $10/month
subscription serving Qwen, LongCat and DeepSeek models). The model id is the gateway's claim about what
served the request. It is recorded as reported and is not independently verified; no line in this repository
may describe it as a verified model attribution.

## 7. Gates

Nothing here is called proven until a sealed event shows it (agent-rules 0).

0. **Vendor behaviour** — §2. Done 2026-09-15.
1. **Scratch** — fresh worktree, scratch `RETRACE_DB`, `RETRACE_URL`/`RETRACE_TOKEN` empty and inline, no
   Worker-reaching MCP entry, no git hook installed. `retrace_instruct` → `retrace_log` with `actor.id`
   `opencode` and the real model, plus the negative tests: no flag; bare `opencode`; a commit trailered for
   another seat, recording which bypass forms are **not** caught; a `retrace_log` with the wrong model.
2. **Live Worker** — one `instruct` and one `log` sealed with `producer_sig_verdict: verified`. Before this,
   nothing may say OpenCode is supported.
3. **Clean-shell walk** — a new shell with no inherited `RETRACE_*`, following only `SETUP-GUIDE.md`. This is
   the rung Codex's PR 19 review said Gate 1 does not cover.
4. **Roster** — `docs/team-roles.md`, `docs/agent-ops.md`, `AGENTS.md`, `README.md`, `SETUP-GUIDE.md`,
   `docs/reference.md`, each claim citing the Gate 2 event ids.

Gate 1 onward starts only on **Jordan's explicit go, given after step-5 Phase A has produced one clean
window** — not on a date. The shadow classifier is reverted and under investigation, so a seventh
committing actor joining mid-measurement would perturb the numbers being measured.

## 8. Operator steps (Jordan only, agent-rules 14, one at a time)

`retrace-admin add-agent retrace --member jordansboxing@gmail.com --harness opencode` (mints the pinned
credential and an Ed25519 producer key); add `opencode` to the `retrace-git` assert credential's
`allowed_actors`; `wrangler secret put RETRACE_CREDENTIALS_EXTRA` from the mirror; write
`~/.retrace/opencode.env` (0600, MCP token only); add the guard plugin to `~/.config/opencode/opencode.jsonc`.
No agent performs any of these.

## 9. Review adjustments folded in before drafting

Claude Fable's review of the plan, with Jordan, 2026-09-15: layer C stated as best-effort with §13 as the
enforcement of record; the global guard install moved into v1 and the Orca wiring decided at Gate 0; ledger
isolation made explicit for every Gate 0/1 run; Gate 1 onward gated on Jordan's explicit go after one clean
Phase A window; and Codex's review of the roster pull request must explicitly acknowledge the one-line edit
to `AGENTS.md`, which is Codex's own identity file.

## 10. What this note does not claim

Not that OpenCode is supported, compatible, or a seventh seat — that is Gate 2's to say. Not that the
copied-trailer path is closed at the harness; it is not. Not that the upstream fix is unnecessary: #47879
remains the right outcome, and this design is a workaround this repository pinned, guarded and measured.
