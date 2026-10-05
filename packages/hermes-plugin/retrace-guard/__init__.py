"""retrace-guard: the Hermes seat's identity control (docs/design/hermes-seat.md section 4.1).

Every provider-bound request is scanned (pre_api_request, pre_auxiliary_call). A tool runs only on a request
whose scan passed (pre_tool_call keyed by api_request_id). Verdicts are appended to
<HERMES_HOME>/run/guard/<session_id>.jsonl, which scripts/retrace-guard-check.sh reads independently.

Test switches (Gate 1a negatives only; never set for a real session):
  RETRACE_GUARD_TEST=scan-raise | scan-timeout | scan-skip   -> the request scan raises / sleeps / records nothing
  RETRACE_GUARD_TEST_LOAD=import | register | timeout        -> the plugin fails at import / in register() / hangs loading
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

if os.environ.get("RETRACE_GUARD_TEST_LOAD") == "import":
    raise ImportError("retrace-guard: RETRACE_GUARD_TEST_LOAD=import")

SEAT = "hermes"
SEAT_MARKER = "RETRACE-SEAT: hermes"
ACTOR_MARKER = "Retrace-Actor: hermes"
OTHER_SEATS = ("claude-code", "codex", "grok", "github-copilot", "cursor-agent", "claude-code-cloud", "claude-code-openshell", "openclaw", "nooa")
_FOREIGN_RE = re.compile(r"(?:RETRACE-SEAT|Retrace-Actor):\s*(?!hermes\b)([A-Za-z0-9._-]+)")
HINT_FILENAMES = ("AGENTS.override.md", "AGENTS.md", "agents.md", "CLAUDE.md", "claude.md", ".cursorrules")
PATH_TOOLS = {"read_file": ("path",), "write_file": ("path",), "patch": ("path",), "search_files": ("path",), "list_dir": ("path",)}
RETRACE_LOG_TOOLS = {"mcp__retrace__retrace_log", "mcp__retrace__retrace_instruct", "mcp_retrace_retrace_log", "mcp_retrace_retrace_instruct"}  # Hermes 7b362884 registers MCP tools as mcp__<server>__<tool>
RETRACE_LOG_TOOL_NAMES = {"mcp__retrace__retrace_log", "mcp_retrace_retrace_log"}
TRAILERS = ("Retrace-Actor: hermes", "Retrace-Model:", "Retrace-Model-Source:", "Retrace-Caused-By:")

_lock = threading.Lock()
_sessions: Dict[str, Dict[str, Any]] = {}


def _home() -> Path:
    try:
        from hermes_constants import get_hermes_home  # type: ignore
        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))


def _state(session_id: str) -> Dict[str, Any]:
    with _lock:
        st = _sessions.get(session_id)
        if st is None:
            st = {"model": None, "verdicts": {}, "blocked": None, "edited": set(), "logged": set(), "workdir": os.getcwd()}
            _sessions[session_id] = st
        return st


def _record(session_id: str, entry: Dict[str, Any]) -> None:
    entry = {"ts": time.time(), "session_id": session_id, **entry}
    try:
        d = _home() / "run" / "guard"
        d.mkdir(parents=True, exist_ok=True)
        with open(d / f"{session_id or 'unknown'}.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, default=str) + "\n")
    except Exception:
        pass  # the shell hook treats a missing line as a block; nothing to do here


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict):
                parts.append(str(p.get("text") or p.get("content") or ""))
            else:
                parts.append(str(p))
        return "\n".join(parts)
    if content is None:
        return ""
    return json.dumps(content, default=str)


def _messages_of(request: Any) -> List[Dict[str, Any]]:
    body = request.get("body") if isinstance(request, dict) else None
    if not isinstance(body, dict):
        return []
    msgs = body.get("messages") or body.get("input") or []
    return [m for m in msgs if isinstance(m, dict)]


def scan_messages(messages: Iterable[Dict[str, Any]], *, require_seat: bool) -> Tuple[bool, str]:
    """(ok, reason). require_seat: a system message must carry both seat markers (main-loop requests);
    auxiliary requests carry Hermes's own prompts and are scanned for foreign markers only."""
    system_text = []
    for m in messages:
        role = m.get("role")
        text = _text(m.get("content"))
        if role == "system":
            system_text.append(text)
        hit = _FOREIGN_RE.search(text)
        if hit:
            return False, f"another seat's identity reached the model ({hit.group(0).strip()}, role {role})"
        for other in OTHER_SEATS:
            if f"Retrace-Actor: {other}" in text:
                return False, f"another seat's identity reached the model (Retrace-Actor: {other}, role {role})"
    if require_seat:
        sys_all = "\n".join(system_text)
        if SEAT_MARKER not in sys_all or ACTOR_MARKER not in sys_all:
            return False, "no seat identity in the system prompt (.hermes.md missing, blocked, or not loaded)"
    return True, "ok"


def _scan_request(session_id: str, api_request_id: str, request: Any, *, aux: bool, aux_task: str = "") -> None:
    test = os.environ.get("RETRACE_GUARD_TEST", "")
    if test == "scan-raise":
        raise RuntimeError("retrace-guard: RETRACE_GUARD_TEST=scan-raise")
    if test == "scan-timeout":
        time.sleep(3600)
    if test == "scan-skip":
        return
    msgs = _messages_of(request)
    body_sha = hashlib.sha256(json.dumps(request, sort_keys=True, default=str).encode()).hexdigest()
    ok, reason = scan_messages(msgs, require_seat=not aux)
    st = _state(session_id)
    verdict = "ok" if ok else "failed"
    if not ok and "another seat" in reason:
        st["blocked"] = reason
    if api_request_id:
        st["verdicts"][api_request_id] = {"verdict": verdict, "reason": reason}
    _record(session_id, {"event": "aux_request" if aux else "request", "api_request_id": api_request_id or "",
                         "aux_task": aux_task, "verdict": verdict, "reason": reason, "body_sha256": body_sha,
                         "message_count": len(msgs)})


def _block(reason: str) -> Dict[str, Any]:
    return {"action": "block", "message": f"retrace-guard: {reason}"}


def _path_hits(path_str: str, workdir: str) -> Optional[str]:
    try:
        p = Path(path_str).expanduser()
        p = p if p.is_absolute() else Path(workdir) / p
        p = p.resolve()
        root = Path(workdir).resolve()
        cur = p if p.is_dir() else p.parent
        while True:
            for name in HINT_FILENAMES:
                if (cur / name).is_file() and cur != root:
                    return str(cur / name)
            if cur == root or root not in cur.parents and cur != root:
                break
            cur = cur.parent
    except Exception:
        return None
    return None


def _paths_from_terminal(cmd: str) -> List[str]:
    return [tok for tok in re.split(r"[\s'\";|&<>()]+", cmd) if "/" in tok and not tok.startswith("-") and not tok.startswith("http")]


def _check_retrace_actor_model(args: Dict[str, Any], st: Dict[str, Any]) -> Optional[str]:
    actor = args.get("actor") if isinstance(args, dict) else None
    if isinstance(actor, dict) and actor.get("model") and st.get("model") and actor["model"] != st["model"]:
        return f"actor.model '{actor['model']}' is not the session model '{st['model']}'"
    return None


def _check_commit(cmd: str, st: Dict[str, Any]) -> Optional[str]:
    if not re.search(r"\bgit\s+(?:-c\s+\S+\s+)*commit\b", cmd):
        return None
    if "--amend" in cmd:
        return "git commit --amend is refused for this seat"
    for t in TRAILERS:
        if t not in cmd:
            return f"git commit without trailer '{t}' (seen only inside the command text; -F and heredocs are not parsed)"
    for other in OTHER_SEATS:
        if f"Retrace-Actor: {other}" in cmd:
            return f"git commit names another seat (Retrace-Actor: {other})"
    missing = sorted(p for p in st["edited"] if p not in st["logged"])
    if missing:
        return f"git commit while edited paths were never named in a retrace_log: {', '.join(missing[:5])}"
    return None


# ---- hooks -------------------------------------------------------------------------------------

def _on_session_start(session_id: str = "", model: Any = None, **_: Any) -> None:
    st = _state(session_id)
    st["model"] = str(model) if model else None
    _record(session_id, {"event": "session_start", "model": st["model"], "plugin": "retrace-guard", "version": "0.1.0"})


def _on_pre_api_request(session_id: str = "", api_request_id: str = "", request: Any = None, **_: Any) -> None:
    _scan_request(session_id, api_request_id, request, aux=False)


def _on_pre_auxiliary_call(session_id: str = "", api_request_id: str = "", request: Any = None, aux_task: str = "", **_: Any) -> None:
    _scan_request(session_id, api_request_id, request, aux=True, aux_task=aux_task)


def _on_pre_tool_call(tool_name: str = "", args: Optional[Dict[str, Any]] = None, session_id: str = "",
                      api_request_id: str = "", **_: Any) -> Optional[Dict[str, Any]]:
    st = _state(session_id)
    args = args if isinstance(args, dict) else {}
    if st["blocked"]:
        return _block(f"session blocked: {st['blocked']}")
    if not api_request_id:
        return _block("tool call carries no api_request_id; no request to authorize it")
    v = st["verdicts"].get(api_request_id)
    if v is None:
        return _block(f"request {api_request_id} was never scanned (scan skipped, timed out or failed); nothing authorizes its tools")
    if v["verdict"] != "ok":
        return _block(f"request {api_request_id} failed the identity scan: {v['reason']}")
    # layer B, check 3(ii): a context file on the path
    cands: List[str] = []
    for key in PATH_TOOLS.get(tool_name, ()):
        if isinstance(args.get(key), str):
            cands.append(args[key])
    if tool_name == "terminal" and isinstance(args.get("command"), str):
        cands.extend(_paths_from_terminal(args["command"]))
    for c in cands:
        hit = _path_hits(c, st["workdir"])
        if hit:
            return _block(f"a context file sits on this path ({hit}); refused before it could be spliced")
    # layer C
    if tool_name in RETRACE_LOG_TOOLS:
        r = _check_retrace_actor_model(args, st)
        if r:
            return _block(r)
    if tool_name == "terminal" and isinstance(args.get("command"), str):
        r = _check_commit(args["command"], st)
        if r:
            return _block(r)
    return None


def _on_post_tool_call(tool_name: str = "", args: Optional[Dict[str, Any]] = None, session_id: str = "", status: Any = None, **_: Any) -> None:
    st = _state(session_id)
    args = args if isinstance(args, dict) else {}
    if tool_name in ("write_file", "patch") and isinstance(args.get("path"), str):
        st["edited"].add(_rel(args["path"], st["workdir"]))
    if tool_name in RETRACE_LOG_TOOL_NAMES:
        for a in args.get("artifacts") or []:
            if isinstance(a, dict) and isinstance(a.get("id"), str):
                aid = a["id"]
                if "#" in aid:
                    st["logged"].add(aid.split("#", 1)[1])
                elif aid.startswith("file:"):
                    st["logged"].add(_rel(aid[5:], st["workdir"]))


def _rel(p: str, workdir: str) -> str:
    try:
        return str(Path(p).expanduser().resolve().relative_to(Path(workdir).resolve()))
    except Exception:
        return p


def register(ctx) -> None:
    test = os.environ.get("RETRACE_GUARD_TEST_LOAD", "")
    if test == "register":
        raise RuntimeError("retrace-guard: RETRACE_GUARD_TEST_LOAD=register")
    if test == "timeout":
        time.sleep(3600)
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("pre_api_request", _on_pre_api_request)
    ctx.register_hook("pre_auxiliary_call", _on_pre_auxiliary_call)
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
