#!/usr/bin/env bash
# hermes-seat.sh — launcher for the Hermes seat (docs/design/hermes-seat.md §6.3). Runs in an Orca pane.
# usage: scripts/hermes-seat.sh --phase scratch|live [--model <id>] [--stub-base-url <url>] [--chat-args "..."]
# Test-only overrides, each printed and meant to be declared on the gate's ledger event:
#   HERMES_SRC=<checkout>   use this Hermes checkout instead of ~/.hermes-retrace/hermes-agent (must be at HERMES_COMMIT)
#   --stub-base-url <url>   point model.base_url at a stub (Gate 1a); provider stays as the template says unless --stub-provider
#   RETRACE_GUARD_TEST / RETRACE_GUARD_TEST_LOAD  passed through to the Hermes process for the Gate 1a negatives
#   --test-drop-shell-hook  render the config WITHOUT the hooks block (the "shell hook removed, plugin intact" negative)
# Prints names, hashes, paths and OK/FAILED only. Never prints a value from .env.
set -euo pipefail
umask 077
HERMES_COMMIT="5b147ab036d6d19131bff8d20701b5001eab844a" # v0.22.3 qualification candidate, not admission
PROFILE="${HERMES_PROFILE_HOME:-$HOME/.hermes-retrace}"
PHASE=""; MODEL=""; STUB=""; STUB_PROVIDER=""; CHAT_ARGS=""; DROP_HOOK=""; SEALED_BY=""; MCP_SHA=""; MODE="research"
declare -a CHAT=()
fail() { echo "FAILED: $*"; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --phase|--model|--stub-base-url|--stub-provider|--chat-args|--sealed-by|--mcp-build-sha256|--query|--mode)
      [ $# -ge 2 ] && [ -n "$2" ] || fail "option requires a nonempty value"
      case "$1" in
        --phase) PHASE="$2";; --model) MODEL="$2";; --stub-base-url) STUB="$2";;
        --stub-provider) STUB_PROVIDER="$2";; --chat-args) CHAT_ARGS="$2";;
        --sealed-by) SEALED_BY="$2";; --mode) MODE="$2";; --mcp-build-sha256) MCP_SHA="$2";; --query) CHAT+=("-q=$2");;
      esac
      shift 2;;
    --cli) CHAT+=(--cli); shift;;
    --test-drop-shell-hook) DROP_HOOK=1; shift;;
    *) fail "unknown launcher option";;
  esac
done
[ "$PHASE" = scratch ] || [ "$PHASE" = live ] || fail "--phase scratch|live is required"
[ "$MODE" = research ] || { [ "$MODE" = builder-probe ] && [ "$PHASE" = scratch ]; } || fail "only research is permitted live; builder-probe is scratch-only"
if [ "$PHASE" = live ]; then
  [ -z "$STUB$STUB_PROVIDER$DROP_HOOK$CHAT_ARGS" ] || fail "probe options are forbidden in live phase"
  [ ! -v RETRACE_GUARD_TEST ] && [ ! -v RETRACE_GUARD_TEST_LOAD ] || fail "guard test environment is forbidden in live phase"
  [[ "$SEALED_BY" == pinned:* ]] || fail "live requires --sealed-by with the expected pinned credential seal"
  [[ "$MCP_SHA" =~ ^[0-9a-f]{64}$ ]] || fail "live requires --mcp-build-sha256 from the qualified build"
fi
[ -z "$STUB_PROVIDER" ] || { [ -n "$STUB" ] && [ "$STUB_PROVIDER" = custom ]; } || fail "stub provider must be custom with a stub URL"
# Compatibility with old probe scripts is limited to one-shot input/display flags.
# No shell splitting/globbing; model, provider, tools, resume and approval switches cannot pass through.
if [ -n "$CHAT_ARGS" ]; then
  parsed="$(python3 -I - "$CHAT_ARGS" <<'PYARGS'
import json,shlex,sys
try:
    args=shlex.split(sys.argv[1]); out=[]
    while args:
        arg=args.pop(0)
        if arg=='--cli': out.append(arg)
        elif arg in ('-q','--query') and args: out.append('-q='+args.pop(0))
        else: raise ValueError()
    print(json.dumps(out))
except ValueError:
    sys.exit(1)
PYARGS
)" || fail "--chat-args permits only --cli and -q/--query in scratch"
  mapfile -d '' -t legacy < <(python3 -I -c 'import json,sys; [sys.stdout.write(x+"\0") for x in json.loads(sys.argv[1])]' "$parsed")
  CHAT+=("${legacy[@]}")
fi
# Reject YAML control characters/placeholders BEFORE writing a profile. Round-trip
# replacement alone cannot detect injected YAML when it simply reverses the injection.
python3 -I - "$PROFILE" "$MODEL" "${RETRACE_PRIMARY_CHECKOUT:-}" "$SEALED_BY" "$STUB" <<'PYVALID' || fail "unsafe configuration substitution or non-loopback stub URL"
import sys,urllib.parse
for value in sys.argv[1:]:
    if any(ord(c)<32 or ord(c)==127 or c in '\\"' for c in value) or '{{' in value or '}}' in value:
        sys.exit(1)
if sys.argv[5]:
    u=urllib.parse.urlsplit(sys.argv[5])
    if u.scheme!='http' or u.hostname not in ('127.0.0.1','localhost','::1') or u.username or u.password or u.query or u.fragment:
        sys.exit(1)
PYVALID
# (1) a Retrace worktree
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "not inside a git worktree"
[ -f "$ROOT/.retrace.json" ] && [ -f "$ROOT/docs/agent-rules.md" ] || fail "$ROOT is not a Retrace worktree"
cd "$ROOT"
python3 -I - "$ROOT" "$PROFILE" <<'PYPATHS' || fail "unsafe worktree/profile path"
import pathlib,sys
for value in sys.argv[1:]:
    if not pathlib.Path(value).is_absolute() or any(ord(c)<32 or ord(c)==127 or c in '\\"' for c in value) or '{{' in value or '}}' in value:
        sys.exit(1)
PYPATHS
[ "$(realpath "${BASH_SOURCE[0]}")" = "$ROOT/scripts/hermes-seat.sh" ] || fail "launcher must run from this worktree"
# (2) the identity file is the committed one
[ -f .hermes.md ] || fail ".hermes.md missing at $ROOT"
h_work="$(sha256sum .hermes.md | cut -d' ' -f1)"; h_head="$(git show HEAD:.hermes.md 2>/dev/null | sha256sum | cut -d' ' -f1)"
[ "$h_work" = "$h_head" ] || fail ".hermes.md differs from HEAD's (work ${h_work:0:12}, HEAD ${h_head:0:12})"
# (2b) the guard plugin, its shell-hook check and the seat-config templates are the committed ones. The seat works in this worktree,
#      so an edit here between launches must not become its guard or its config without a word: refuse, before anything is
#      installed, when a working-tree file differs from HEAD (or is not in HEAD). Step 6 then installs HEAD's bytes, not the
#      working tree's, and checks each copy against HEAD's sha256.
declare -A HEAD_SHA
for f in scripts/hermes-seat.sh packages/hermes-plugin/runtime_adapter.py packages/hermes-plugin/runtime-contract.json packages/hermes-plugin/retrace-guard/plugin.yaml packages/hermes-plugin/retrace-guard/__init__.py scripts/retrace-guard-check.sh hermes.retrace.yaml hermes.retrace.phases.yaml; do
  git cat-file -e "HEAD:$f" 2>/dev/null || fail "$f is not in HEAD"
  [ -f "$f" ] || fail "$f is missing from the working tree"
  hw="$(sha256sum "$f" | cut -d' ' -f1)"; hh="$(git show "HEAD:$f" | sha256sum | cut -d' ' -f1)"
  [ "$hw" = "$hh" ] || fail "$f differs from HEAD (work ${hw:0:12}, HEAD ${hh:0:12})"
  HEAD_SHA[$f]="$hh"
done
echo "pinned to HEAD: retrace-guard/plugin.yaml ${HEAD_SHA[packages/hermes-plugin/retrace-guard/plugin.yaml]:0:12}, retrace-guard/__init__.py ${HEAD_SHA[packages/hermes-plugin/retrace-guard/__init__.py]:0:12}, retrace-guard-check.sh ${HEAD_SHA[scripts/retrace-guard-check.sh]:0:12}, hermes.retrace.yaml ${HEAD_SHA[hermes.retrace.yaml]:0:12}, hermes.retrace.phases.yaml ${HEAD_SHA[hermes.retrace.phases.yaml]:0:12}"
# (3) The pinned startup adapter disables foreign fallback and automatic subdirectory hints.
# (5) profile home for tool subprocesses, empty of startup files
mkdir -p "$PROFILE/home" "$PROFILE/run/guard" "$PROFILE/run/reports" "$PROFILE/plugins" "$PROFILE/bin"
exec 9>"$PROFILE/run/seat.lock"
flock -n 9 || fail "another launcher/session owns this profile"
for f in .profile .bash_profile .bash_login .bashrc .bash_logout; do [ -e "$PROFILE/home/$f" ] && fail "$PROFILE/home/$f exists; the profile home must hold no startup file"; done
if ls /etc/profile.d/*.sh >/dev/null 2>&1 && grep -l "RETRACE_" /etc/profile.d/*.sh 2>/dev/null | head -1 | grep -q .; then fail "/etc/profile.d exports a RETRACE_ name (operator prerequisite, §6.3 step 5)"; fi
# (6) render the config from the template (the working tree equals HEAD, step 2b); install the guard and the check script from HEAD
PRIMARY="${RETRACE_PRIMARY_CHECKOUT:-$ROOT}"
[ -f "$PRIMARY/packages/mcp-server/dist/index.js" ] || fail "no built MCP server at $PRIMARY/packages/mcp-server/dist/index.js"
# Hash the executable JS tree and lockfile, not just index.js. This is build identity,
# not reproducible-build proof; the gate must produce the expected hash independently.
build_sha() {
  python3 -I - "$PRIMARY" <<'PYBUILD'
from pathlib import Path
import hashlib,sys
root=Path(sys.argv[1]); h=hashlib.sha256(); paths=[]
for part in ('packages/core/dist','packages/mcp-server/dist'):
    paths.extend((root/part).rglob('*.js'))
paths.append(root/'package-lock.json')
for p in sorted(paths):
    if p.is_symlink(): sys.exit('symlink in MCP build')
    h.update(str(p.relative_to(root)).encode()+b'\0'+p.read_bytes()+b'\0')
print(h.hexdigest())
PYBUILD
}
observed_mcp_sha="$(build_sha)" || fail "could not hash MCP build"
[ -z "$MCP_SHA" ] || [ "$MCP_SHA" = "$observed_mcp_sha" ] || fail "MCP build does not match the qualified hash"
echo "MCP build sha256 $observed_mcp_sha"
DATE="$(date -u +%Y%m%d)"
PHASE_ENV="$(python3 -I - "$PHASE" "$PROFILE" "$DATE" <<'PY'
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
[ -n "$MODEL" ] || MODEL="$(sed -n 's/^  model: "\(.*\)"$/\1/p' "$PROFILE/config.yaml" 2>/dev/null | head -1 || true)"
[ -n "$MODEL" ] && [ "$MODEL" != "{{MODEL}}" ] || fail "--model <id> is required the first time (the Portal model chosen at Gate 1b)"
# Revalidate a model restored from an older profile as well as an explicit model.
python3 -I - "$MODEL" <<'PYMODEL' || fail "unsafe model identifier in profile"
import sys
s=sys.argv[1]
sys.exit(1 if not s or any(ord(c)<32 or ord(c)==127 or c in '\\"' for c in s) or '{{' in s or '}}' in s else 0)
PYMODEL
export PHASE_ENV
export DROP_HOOK
python3 -I - "$ROOT" "$PRIMARY" "$PROFILE" "$MODEL" "$STUB" "$STUB_PROVIDER" <<'PY' > "$PROFILE/config.yaml.new" || fail "render failed"
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
python3 -I - "$ROOT/hermes.retrace.yaml" "$PROFILE/config.yaml.new" "$PRIMARY" "$PROFILE/bin" "$MODEL" "$STUB" "$STUB_PROVIDER" <<'PYCHK' || fail "rendered config differs from the template beyond the allowed substitutions"
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
install_from_head() { # $1 path in HEAD, $2 destination: writes HEAD's bytes, then checks the copy against HEAD's sha256 (step 2b)
  git show "HEAD:$1" > "$2" || fail "could not install $1 from HEAD"
  [ "$(sha256sum "$2" | cut -d' ' -f1)" = "${HEAD_SHA[$1]}" ] || fail "profile copy of $1 differs from HEAD"
}
rm -rf "$PROFILE/plugins/retrace-guard"; mkdir -p "$PROFILE/plugins/retrace-guard"
install_from_head packages/hermes-plugin/retrace-guard/plugin.yaml "$PROFILE/plugins/retrace-guard/plugin.yaml"
install_from_head packages/hermes-plugin/retrace-guard/__init__.py "$PROFILE/plugins/retrace-guard/__init__.py"
install_from_head scripts/retrace-guard-check.sh "$PROFILE/bin/retrace-guard-check.sh"
chmod 755 "$PROFILE/bin/retrace-guard-check.sh"; [ -x "$PROFILE/bin/retrace-guard-check.sh" ] || fail "$PROFILE/bin/retrace-guard-check.sh is not executable"
echo "config sha256 $(sha256sum "$PROFILE/config.yaml" | cut -c1-12); guard sha256 ${HEAD_SHA[packages/hermes-plugin/retrace-guard/__init__.py]:0:12}; check sha256 ${HEAD_SHA[scripts/retrace-guard-check.sh]:0:12} (profile copies = HEAD); phase $PHASE; .hermes.md sha256 ${h_head:0:12}"
# (7) the model string for the MCP server
export RETRACE_ACTOR_MODEL="$MODEL"
# (8) the pinned Hermes
SRC="${HERMES_SRC:-$PROFILE/hermes-agent}"
[ -x "$SRC/.venv/bin/hermes" ] || fail "no Hermes venv at $SRC/.venv (run the install step)"
at="$(git -C "$SRC" rev-parse HEAD 2>/dev/null)"; [ "$at" = "$HERMES_COMMIT" ] || fail "Hermes checkout at ${at:0:12}, pinned $HERMES_COMMIT"
if [ -n "${HERMES_SRC:-}" ]; then echo "override: HERMES_SRC=$SRC (declare on the gate event)"; fi
[ -n "$STUB" ] && echo "override: model.base_url=$STUB (declare on the gate event)"
[ -n "$DROP_HOOK" ] && echo "override: --test-drop-shell-hook (declare on the gate event)"
# (4)+(9): env -i, then the pre-start smoke and the session
ENVV=(PATH="$PATH" HOME="$HOME" USER="${USER:-$(id -un)}" LANG="${LANG:-C.UTF-8}" TERM="${TERM:-xterm}" HERMES_HOME="$PROFILE" RETRACE_ACTOR_MODEL="$MODEL" HERMES_ACCEPT_HOOKS=1 RETRACE_GUARD_PHASE="$PHASE" RETRACE_GUARD_MODE="$MODE" RETRACE_GUARD_REPORT_DIR="$PROFILE/run/reports" RETRACE_GUARD_SEALED_BY="$SEALED_BY" RETRACE_TERMINAL="${ORCA_TERMINAL_HANDLE:-}")
[ -n "${RETRACE_GUARD_TEST:-}" ] && ENVV+=(RETRACE_GUARD_TEST="$RETRACE_GUARD_TEST") && echo "override: RETRACE_GUARD_TEST=$RETRACE_GUARD_TEST"
[ -n "${RETRACE_GUARD_TEST_LOAD:-}" ] && ENVV+=(RETRACE_GUARD_TEST_LOAD="$RETRACE_GUARD_TEST_LOAD") && echo "override: RETRACE_GUARD_TEST_LOAD=$RETRACE_GUARD_TEST_LOAD"
HERMES_CMD=("$SRC/.venv/bin/python" -I "$ROOT/packages/hermes-plugin/runtime_adapter.py" --source "$SRC" --root "$ROOT" --identity-sha "$h_head" --contract "$ROOT/packages/hermes-plugin/runtime-contract.json" --)
config_sha="$(sha256sum "$PROFILE/config.yaml" | cut -d' ' -f1)"
ENVV+=(RETRACE_GUARD_CONFIG_SHA="$config_sha" RETRACE_GUARD_MCP_SHA="$observed_mcp_sha" RETRACE_GUARD_RUNTIME="$HERMES_COMMIT")
if ! smoke="$(env -i "${ENVV[@]}" "${HERMES_CMD[@]}" plugins list 2>&1)"; then
  fail "plugin discovery failed"
fi
case "$smoke" in *retrace-guard*) ;; *) fail "retrace-guard is not listed";; esac
echo "pre-start smoke: retrace-guard listed (tool hooks still require a passing request verdict)"
# A fresh profile's first Hermes run prepares its isolated runtime (pm/runtime.py prepare_runtime), which can outlast the
# MCP handshake timeout; so whenever the first pass does not connect, the test runs once more, and the second pass is the check.
for pass in 1 2; do
  t0=$(date +%s); mcp_rc=0; mcp_raw="$(env -i "${ENVV[@]}" timeout 120 "${HERMES_CMD[@]}" mcp test retrace 2>&1)" || mcp_rc=$?; t1=$(date +%s)
  printf '%s\n' "$mcp_raw" > "$PROFILE/run/mcp-test-pass$pass.txt"
  mcp_test="$(printf '%s\n' "$mcp_raw" | grep -E "Connected|Tools discovered|Connection failed" | head -3 | tr '\n' ' ' || true)"
  echo "pre-start smoke (mcp test retrace, pass $pass, rc=$mcp_rc, $((t1-t0))s): ${mcp_test:-<no matching output>}"
  if [ "$mcp_rc" = 0 ]; then case "$mcp_test" in *"✓ Connected"*) break;; esac; fi
  [ "$pass" = 1 ] && echo "  pass 1 did not connect (a fresh profile prepares Hermes's isolated runtime on its first start); testing once more"
done
[ "$mcp_rc" = 0 ] || fail "MCP test returned an error"
case "$mcp_test" in *"✓ Connected"*) ;; *) fail "the retrace MCP server did not connect in the pre-start test (see $PROFILE/run/mcp-test-pass*.txt)";; esac

[ "$(sha256sum "$PROFILE/config.yaml" | cut -d' ' -f1)" = "$config_sha" ] || fail "Hermes changed the rendered configuration during preflight"
[ "$(build_sha)" = "$observed_mcp_sha" ] || fail "MCP build changed during preflight"
for f in "${!HEAD_SHA[@]}"; do
  [ "$(sha256sum "$ROOT/$f" | cut -d' ' -f1)" = "${HEAD_SHA[$f]}" ] || fail "pinned asset changed during preflight"
done
echo "starting hermes (phase $PHASE) in $ROOT"
exec env -i "${ENVV[@]}" "${HERMES_CMD[@]}" chat "${CHAT[@]}"
