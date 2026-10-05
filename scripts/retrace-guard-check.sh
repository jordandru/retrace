#!/usr/bin/env bash
# retrace-guard-check.sh — the independent half of the Hermes seat's identity control (docs/design/hermes-seat.md §4.2).
# Hermes runs it as a pre_tool_call shell hook with fail_closed: true. It reads the hook payload on stdin, finds the
# session's verdict file written by the retrace-guard plugin, and stays silent (allow) only when the tool's own
# api_request_id has verdict "ok" there. Every other case prints a block directive. Prints no secret, no payload.
set -u
payload="$(cat)"
home="${HERMES_HOME:-$HOME/.hermes}"
python3 - "$home" <<'PY' "$payload"
import json, sys, os
home = sys.argv[1]; payload = sys.argv[2]
def block(reason):
    print(json.dumps({"action": "block", "message": "retrace-guard-check: " + reason})); sys.exit(0)
try:
    p = json.loads(payload)
except Exception:
    block("unreadable hook payload")
sid = p.get("session_id") or ""
rid = (p.get("extra") or {}).get("api_request_id") or ""
if not sid: block("no session_id in payload")
if not rid: block("no api_request_id in payload; no request authorizes this tool")
path = os.path.join(home, "run", "guard", sid + ".jsonl")
if not os.path.isfile(path): block("no verdict file for this session (the retrace-guard plugin did not load or never scanned)")
ok = False
with open(path, encoding="utf-8") as f:
    for line in f:
        try: e = json.loads(line)
        except Exception: continue
        if e.get("event") == "request" and e.get("api_request_id") == rid:
            ok = e.get("verdict") == "ok"
if not ok: block(f"request {rid} has no passing verdict in the session's verdict file")
PY
exit 0
