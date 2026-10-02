# Claude cloud session probe, 2026-10-02

Read-only probe of the Claude Code cloud seat for the Retrace project.
Session: https://claude.ai/code/session_01Es84tHSjdgj8Z4BNCiuFZq

Values that look like secrets or tokens are omitted. Only variable names are listed.

## 1. Model id

The harness hands this session `claude-fable-5-1` in the session context, not in any
environment variable. The claude-code-remote `get_session` tool reports the same value in
`configured_model`, `session_context.model` and `external_metadata.last_served_model`.
No environment variable carries a model id. `CLAUDE_CODE_MODEL_CAPABILITIES` exists but is empty.

## 2. Remote session variables

| Variable | Value |
|---|---|
| `CLAUDE_CODE_REMOTE` | `true` |
| `CLAUDE_CODE_REMOTE_SESSION_ID` | `cse_01Es84tHSjdgj8Z4BNCiuFZq` |

## 3. Rule files

`CLAUDE.md` was loaded into context automatically by the harness. All three files are
present and readable on disk:

| File | Lines |
|---|---|
| `CLAUDE.md` | 18 |
| `docs/agent-rules.md` | 176 |
| `docs/agent-ops.md` | 259 |

The two docs files were checked for readability only, not read in full, during the probe.

## 4. Tool and git output

```
node --version          v22.22.0
git --version           git version 2.43.0
git config user.name    Claude
git config user.email   noreply@anthropic.com
git log -1              d8822dc jordandru <jordansboxing@gmail.com>
git remote -v           origin  https://github.com/jordandru/retrace (fetch)
                        origin  https://github.com/jordandru/retrace (push)
branch at probe time    claude/gallant-goldberg-4xkg0w
```

The git identity is the cloud default (Claude, noreply address), not the actor identity in
`CLAUDE.md`. Retrace trailers must be added per commit.

## 5. Retrace MCP server

Not available. There is no `.mcp.json` in the repository and no tool prefixed
`mcp__retrace__` exists in the session. MCP servers present: claude-code-remote, github,
Claude_Docs, Cloudflare_Developer_Platform, Gmail, Google_Calendar, Google_Drive.
The repository ships one skill, `.claude/skills/review-effort`, which is loaded.

## 6. Network access

Outbound HTTPS goes through the agent proxy with an allowlist. `api.github.com` and
`registry.npmjs.org` returned HTTP 200. A generic host (`example.com`) was refused by the
proxy with a 403 on the CONNECT tunnel. This matches a limited, not full, network policy.
Environment type is `cloud_default`; hermetic mode is off.

## 7. First 20 environment variable names

```
SHELL
IS_SANDBOX
COREPACK_ENABLE_AUTO_PIN
CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD
CLAUDE_CODE_ARTIFACT_MULTI_FILE
CLAUDE_CODE_ACCOUNT_UUID
CLAUDE_CODE_CHILD_SESSION
PYTHONUNBUFFERED
CCR_AGENT_PROXY_ENABLED
no_proxy
MAX_THINKING_TOKENS
ENV_MANAGER_ENABLE_DIAG_LOGS
AI_AGENT
CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
CLAUDE_CODE_USER_EMAIL
SKIP_PLUGIN_MARKETPLACE
CLAUDE_CODE_SESSION_ID
CLAUDE_CODE_DEBUG
NODE_OPTIONS
JAVA_HOME
```
