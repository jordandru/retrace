#!/usr/bin/env bash
# retrace-guard-check.sh — the independent half of the Hermes seat's identity control (docs/design/hermes-seat.md §4.2).
# Hermes 7b362884 runs it as a pre_tool_call shell hook with fail_closed: true and passes the hook payload on stdin.
# Contract: exit 0 with no output (allow) ONLY when the session's verdict file, written by the retrace-guard plugin, holds a
# passing verdict for the tool call's own api_request_id. Every other outcome prints a block directive and exits 2, which
# Hermes treats as a block even without a directive (BLOCK_EXIT_CODE, agent/shell_hooks.py line 42; _evaluate_result,
# lines 406-437): an unreadable or malformed payload, a missing or unreadable verdict file, a verdict-file line that is not
# a JSON object, bytes that are not UTF-8, a missing python3, or any exception in the check. The payload never travels in
# argv (no 128 KiB limit), python runs isolated (-I: no PYTHON* variable and no module in the working directory can change
# the check), and nothing forces exit 0 after a failure. Measured in PR 186 v4 with measure-guard-check.sh: input (a) allows,
# (b)-(i) block; packages/hermes-plugin/tests/test_guard_check.py covers the same cases. Prints no secret and no payload.
set -u
block() { printf '{"action": "block", "message": "retrace-guard-check: %s"}' "$1"; exit 2; }
home="${HERMES_HOME:-${HOME:-}/.hermes}"
IFS= read -r -d '' CODE <<'PY' || true
import json, os, sys


def block(reason):
    try:
        sys.stdout.write(json.dumps({"action": "block", "message": "retrace-guard-check: " + str(reason)[:300]}))
        sys.stdout.flush()
    finally:
        os._exit(2)


try:
    home = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except Exception:
        block("unreadable hook payload")
    if not isinstance(payload, dict):
        block("hook payload is not a JSON object")
    extra = payload.get("extra")
    if not isinstance(extra, dict):
        block("hook payload has no extra object")
    sid = payload.get("session_id")
    rid = extra.get("api_request_id")
    if not isinstance(sid, str) or not sid:
        block("no session_id in payload")
    if not isinstance(rid, str) or not rid:
        block("no api_request_id in payload; no request authorizes this tool")
    if "/" in sid or "\\" in sid or "\x00" in sid or sid.startswith("."):
        block("session_id is not a plain file name")
    if not home:
        block("no HERMES_HOME")
    path = os.path.join(home, "run", "guard", sid + ".jsonl")
    if not os.path.isfile(path):
        block("no verdict file for this session (the retrace-guard plugin did not load or never scanned)")
    try:
        with open(path, "rb") as f:
            text = f.read().decode("utf-8")
    except UnicodeDecodeError:
        block("verdict file is not valid UTF-8")
    except Exception as exc:
        block("verdict file unreadable (" + type(exc).__name__ + ")")
    ok = False
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except Exception:
            block("verdict file holds a line that is not JSON")
        if not isinstance(entry, dict):
            block("verdict file holds a line that is not a JSON object")
        if entry.get("event") == "request" and entry.get("api_request_id") == rid:
            ok = entry.get("verdict") == "ok"
    if not ok:
        block("request " + rid + " has no passing verdict in the session's verdict file")
except BaseException as exc:
    block("check failed (" + type(exc).__name__ + ")")
sys.stdout.flush()
os._exit(0)
PY
[ -n "$CODE" ] || block "check code missing"
command -v python3 >/dev/null 2>&1 || block "python3 not found on PATH"
exec python3 -I -c "$CODE" "$home"
