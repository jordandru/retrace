#!/usr/bin/env bash
# hermes-seat.sh — launcher for the Hermes seat (docs/design/hermes-seat.md §6.3). Runs in an Orca pane.
# usage: scripts/hermes-seat.sh --phase scratch|live [--model <id>] [--stub-base-url <url>] [--chat-args "..."]
# Test-only overrides, each printed and meant to be declared on the gate's ledger event:
#   HERMES_SRC=<checkout>   use this Hermes checkout instead of ~/.hermes-retrace/hermes-agent (must be at HERMES_COMMIT)
#   --stub-base-url <url>   point model.base_url at a stub (Gate 1a); provider stays as the template says unless --stub-provider
#   RETRACE_GUARD_TEST / RETRACE_GUARD_TEST_LOAD  passed through to the Hermes process for the Gate 1a negatives
#   --test-drop-shell-hook  render the config WITHOUT the hooks block (the "shell hook removed, plugin intact" negative)
# Prints names, hashes, paths and OK/FAILED only. Never prints a value from .env.
set -u
HERMES_COMMIT="7b362884d88c887bdcc68271c3b51d25ad1a2197"
PROFILE="${HERMES_PROFILE_HOME:-$HOME/.hermes-retrace}"
PHASE=""; MODEL=""; STUB=""; STUB_PROVIDER=""; CHAT_ARGS=""; DROP_HOOK=""
while [ $# -gt 0 ]; do case "$1" in
  --phase) PHASE="$2"; shift 2;; --model) MODEL="$2"; shift 2;; --stub-base-url) STUB="$2"; shift 2;;
  --stub-provider) STUB_PROVIDER="$2"; shift 2;; --chat-args) CHAT_ARGS="$2"; shift 2;;
  --test-drop-shell-hook) DROP_HOOK=1; shift;;
  *) echo "FAILED: unknown argument $1"; exit 2;; esac; done
fail() { echo "FAILED: $*"; exit 1; }
[ "$PHASE" = scratch ] || [ "$PHASE" = live ] || fail "--phase scratch|live is required"
# (1) a Retrace worktree
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "not inside a git worktree"
[ -f "$ROOT/.retrace.json" ] && [ -f "$ROOT/docs/agent-rules.md" ] || fail "$ROOT is not a Retrace worktree"
cd "$ROOT"
# (2) the identity file is the committed one
[ -f .hermes.md ] || fail ".hermes.md missing at $ROOT"
h_work="$(sha256sum .hermes.md | cut -d' ' -f1)"; h_head="$(git show HEAD:.hermes.md 2>/dev/null | sha256sum | cut -d' ' -f1)"
[ "$h_work" = "$h_head" ] || fail ".hermes.md differs from HEAD's (work ${h_work:0:12}, HEAD ${h_head:0:12})"
# (3) no context file below the root
hits="$(find . -mindepth 2 \( -path ./node_modules -o -path ./.git \) -prune -o \( -name AGENTS.override.md -o -name AGENTS.md -o -name agents.md -o -name CLAUDE.md -o -name claude.md -o -name .cursorrules \) -print | head -5)"
[ -z "$hits" ] || fail "context files below the root would be spliced into tool results: $hits"
# (5) profile home for tool subprocesses, empty of startup files
mkdir -p "$PROFILE/home" "$PROFILE/run/guard" "$PROFILE/plugins" "$PROFILE/bin"
for f in .profile .bash_profile .bash_login .bashrc .bash_logout; do [ -e "$PROFILE/home/$f" ] && fail "$PROFILE/home/$f exists; the profile home must hold no startup file"; done
if ls /etc/profile.d/*.sh >/dev/null 2>&1 && grep -l "RETRACE_" /etc/profile.d/*.sh 2>/dev/null | head -1 | grep -q .; then fail "/etc/profile.d exports a RETRACE_ name (operator prerequisite, §6.3 step 5)"; fi
# (6) render the config from the committed template; copy the guard and the check script by hash
PRIMARY="${RETRACE_PRIMARY_CHECKOUT:-/home/jordandrumiler/provenance/retrace}"
[ -f "$PRIMARY/packages/mcp-server/dist/index.js" ] || fail "no built MCP server at $PRIMARY/packages/mcp-server/dist/index.js"
DATE="$(date -u +%Y%m%d)"
PHASE_ENV="$(python3 - "$PHASE" "$PROFILE" "$DATE" <<'PY'
import sys,re
phase,profile,date=sys.argv[1:4]
txt=open('hermes.retrace.phases.yaml',encoding='utf-8').read()
blocks={}; cur=None
for line in txt.splitlines():
    if not line.strip() or line.lstrip().startswith('#'): continue
    if not line.startswith(' '): cur=line.rstrip(':'); blocks[cur]=[]; continue
    blocks[cur].append(line.strip())
out=blocks['mcp_env_common']+blocks['mcp_env_'+phase]
print("\n".join("      "+l.replace('{{PROFILE}}',profile).replace('{{DATE}}',date) for l in out))
PY
)" || fail "could not render the phase block"
case "$PHASE_ENV" in *RETRACE_DB*RETRACE_URL*|*RETRACE_URL*RETRACE_DB*) fail "phase block names both RETRACE_DB and RETRACE_URL";; esac
case "$PHASE_ENV" in *RETRACE_DB*|*RETRACE_URL*) ;; *) fail "phase block names neither RETRACE_DB nor RETRACE_URL";; esac
[ -n "$MODEL" ] || MODEL="$(sed -n 's/^  model: "\(.*\)"$/\1/p' "$PROFILE/config.yaml" 2>/dev/null | head -1)"
[ -n "$MODEL" ] && [ "$MODEL" != "{{MODEL}}" ] || fail "--model <id> is required the first time (the Portal model chosen at Gate 1b)"
export PHASE_ENV
export DROP_HOOK
python3 - "$ROOT" "$PRIMARY" "$PROFILE" "$MODEL" "$STUB" "$STUB_PROVIDER" <<'PY' > "$PROFILE/config.yaml.new" || fail "render failed"
import sys,os,re
root,primary,profile,model,stub,stub_provider=sys.argv[1:7]
phase_env=os.environ['PHASE_ENV']
t=open(os.path.join(root,'hermes.retrace.yaml'),encoding='utf-8').read()
t=t.replace('{{PRIMARY_CHECKOUT}}',primary).replace('{{HOOK_DIR}}',os.path.join(profile,'bin')).replace('{{PHASE_ENV}}',phase_env).replace('{{MODEL}}',model)
if stub:
    t=t.replace('  provider: nous\n', f'  provider: {stub_provider or "custom"}\n  base_url: "{stub}"\n  api_key: stub-key-not-a-secret\n')
if os.environ.get('DROP_HOOK'):
    t=re.sub(r'hooks:\n(?:  .*\n|    .*\n|      .*\n)+', '', t, count=1)
sys.stdout.write(t)
PY
# the rendered file may differ from the template only in the substitutions (and the stub override, when given):
# reverse every substitution on the rendered text and require byte equality with the committed template
python3 - "$ROOT/hermes.retrace.yaml" "$PROFILE/config.yaml.new" "$PRIMARY" "$PROFILE/bin" "$MODEL" "$STUB" "$STUB_PROVIDER" <<'PYCHK' || fail "rendered config differs from the template beyond the allowed substitutions"
import sys,os
tmpl=open(sys.argv[1],encoding='utf-8').read(); rend=open(sys.argv[2],encoding='utf-8').read()
primary,hookdir,model,stub,stub_provider=sys.argv[3:8]; phase_env=os.environ['PHASE_ENV']
if stub:
    rend=rend.replace(f'  provider: {stub_provider or "custom"}\n  base_url: "{stub}"\n  api_key: stub-key-not-a-secret\n','  provider: nous\n',1)
if os.environ.get('DROP_HOOK'):
    import re; tmpl=re.sub(r'hooks:\n(?:  .*\n|    .*\n|      .*\n)+', '', tmpl, count=1)
rend=rend.replace(phase_env,'{{PHASE_ENV}}',1).replace(f'  model: "{model}"','  model: "{{MODEL}}"',1)
rend=rend.replace(f'"{hookdir}/','"{{HOOK_DIR}}/').replace(f'"{primary}/','"{{PRIMARY_CHECKOUT}}/')
sys.exit(0 if rend==tmpl else 1)
PYCHK
mv "$PROFILE/config.yaml.new" "$PROFILE/config.yaml"
rm -rf "$PROFILE/plugins/retrace-guard"; cp -r "$ROOT/packages/hermes-plugin/retrace-guard" "$PROFILE/plugins/retrace-guard"
for f in plugin.yaml __init__.py; do [ "$(sha256sum "$PROFILE/plugins/retrace-guard/$f" | cut -c1-64)" = "$(sha256sum "$ROOT/packages/hermes-plugin/retrace-guard/$f" | cut -c1-64)" ] || fail "guard copy differs: $f"; done
cp "$ROOT/scripts/retrace-guard-check.sh" "$PROFILE/bin/retrace-guard-check.sh" && chmod 755 "$PROFILE/bin/retrace-guard-check.sh"
[ "$(sha256sum "$PROFILE/bin/retrace-guard-check.sh" | cut -c1-64)" = "$(sha256sum "$ROOT/scripts/retrace-guard-check.sh" | cut -c1-64)" ] || fail "shell hook copy differs from the committed scripts/retrace-guard-check.sh"
[ -x "$PROFILE/bin/retrace-guard-check.sh" ] || fail "$PROFILE/bin/retrace-guard-check.sh is not executable"
echo "config sha256 $(sha256sum "$PROFILE/config.yaml" | cut -c1-12); guard sha256 $(sha256sum "$ROOT/packages/hermes-plugin/retrace-guard/__init__.py" | cut -c1-12); check sha256 $(sha256sum "$PROFILE/bin/retrace-guard-check.sh" | cut -c1-12) (profile copy = committed); phase $PHASE; .hermes.md sha256 ${h_head:0:12}"
# (7) the model string for the MCP server
export RETRACE_ACTOR_MODEL="$MODEL"
# (8) the pinned Hermes
SRC="${HERMES_SRC:-$PROFILE/hermes-agent}"
[ -x "$SRC/.venv/bin/hermes" ] || fail "no Hermes venv at $SRC/.venv (run the install step)"
at="$(git -C "$SRC" rev-parse HEAD 2>/dev/null)"; [ "$at" = "$HERMES_COMMIT" ] || fail "Hermes checkout at ${at:0:12}, pinned $HERMES_COMMIT"
[ -n "${HERMES_SRC:-}" ] && echo "override: HERMES_SRC=$SRC (declare on the gate event)"
[ -n "$STUB" ] && echo "override: model.base_url=$STUB (declare on the gate event)"
[ -n "$DROP_HOOK" ] && echo "override: --test-drop-shell-hook (declare on the gate event)"
# (4)+(9): env -i, then the pre-start smoke and the session
ENVV=(PATH="$PATH" HOME="$HOME" USER="${USER:-$(id -un)}" LANG="${LANG:-C.UTF-8}" TERM="${TERM:-xterm}" HERMES_HOME="$PROFILE" RETRACE_ACTOR_MODEL="$MODEL" HERMES_ACCEPT_HOOKS=1)
[ -n "${RETRACE_GUARD_TEST:-}" ] && ENVV+=(RETRACE_GUARD_TEST="$RETRACE_GUARD_TEST") && echo "override: RETRACE_GUARD_TEST=$RETRACE_GUARD_TEST"
[ -n "${RETRACE_GUARD_TEST_LOAD:-}" ] && ENVV+=(RETRACE_GUARD_TEST_LOAD="$RETRACE_GUARD_TEST_LOAD") && echo "override: RETRACE_GUARD_TEST_LOAD=$RETRACE_GUARD_TEST_LOAD"
smoke="$(env -i "${ENVV[@]}" "$SRC/.venv/bin/hermes" plugins list 2>&1 | grep -i "retrace-guard" | head -2)"
echo "pre-start smoke (plugins list): ${smoke:-<retrace-guard not listed>}"
# A fresh profile's first Hermes run prepares its isolated runtime (pm/runtime.py prepare_runtime), which outlasts the
# MCP handshake timeout; so the test runs twice when the first pass reports that preparation. The second pass is the check.
for pass in 1 2; do
  t0=$(date +%s); mcp_raw="$(env -i "${ENVV[@]}" timeout 120 "$SRC/.venv/bin/hermes" mcp test retrace 2>&1)"; mcp_rc=$?; t1=$(date +%s)
  printf '%s\n' "$mcp_raw" > "$PROFILE/run/mcp-test-pass$pass.txt"
  mcp_test="$(printf '%s\n' "$mcp_raw" | grep -E "Connected|Tools discovered|Connection failed" | head -3 | tr '\n' ' ')"
  echo "pre-start smoke (mcp test retrace, pass $pass, rc=$mcp_rc, $((t1-t0))s): ${mcp_test:-<no matching output>}"
  case "$mcp_test" in *"✓ Connected"*) break;; esac
  [ "$pass" = 1 ] && echo "  pass 1 did not connect (a fresh profile prepares Hermes's isolated runtime on its first start); testing once more"
done
case "$mcp_test" in *"✓ Connected"*) ;; *) fail "the retrace MCP server did not connect in the pre-start test (see $PROFILE/run/mcp-test-pass*.txt)";; esac

echo "starting hermes (phase $PHASE) in $ROOT"
# shellcheck disable=SC2086
exec env -i "${ENVV[@]}" "$SRC/.venv/bin/hermes" chat $CHAT_ARGS
