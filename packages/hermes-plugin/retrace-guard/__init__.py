"""retrace-guard: the Hermes seat's identity control (docs/design/hermes-seat.md section 4.1).

Every provider-bound request is scanned (pre_api_request, pre_auxiliary_call). A tool runs only on a request
whose scan passed (pre_tool_call keyed by api_request_id). Verdicts are appended to
<HERMES_HOME>/run/guard/<session_id>.jsonl, which scripts/retrace-guard-check.sh reads independently.

2026-10-21 implementation correction: runtime-contract.json selects v0.22.3; runtime_adapter.py
binds automatic identity loading and preserves complete observer input up to an explicit cap. Evidence
may name foreign actors only with that adapter present. Research is the default capability; builder-probe
is scratch-only. Edit coverage requires correlated append receipts and is invalidated before a later edit.
The historical evidence below describes the original pin, not qualification of this revision. Actual
CLI/TUI, hook ordering and all admission gates remain to be measured on the new pin.

Historical fail-closed evidence (NOOA N-M1), hermes_cli/plugins_dispatch.py at 7b362884d88c887bdcc68271c3b51d25ad1a2197, quoted:
    226        fail_closed = hook_name in _HOOK_TIMEOUT_FAIL_CLOSED_HOOKS
    231                    if ret is _HOOK_SKIPPED:
    232                        if fail_closed:  # policy hook: fail closed with a block directive
    233                            results.append({"action": "block", "message": _PRE_TOOL_CALL_TIMEOUT_BLOCK_MESSAGE})
    239            except (Exception, SystemExit) as exc:
    240                self._report_hook_failure(hook_name, cb, kwargs, exc)
    241                if fail_closed:  # a guard that raised made no decision: same veto as a timeout
    242                    results.append(_policy_error_block_directive(hook_name, cb, exc))
  with ``_HOOK_TIMEOUT_FAIL_CLOSED_HOOKS = {"pre_tool_call"}`` (line 49). So a registered pre_tool_call callback that raises or
  times out yields a block directive. Independently, scripts/retrace-guard-check.sh runs as a fail_closed pre_tool_call shell
  hook. It allows (exit 0, no output) only when the session's verdict file holds a passing verdict for the tool call's own
  api_request_id; on every other input it prints a block directive and exits 2, which Hermes blocks on even without a
  directive (BLOCK_EXIT_CODE, agent/shell_hooks.py line 42; _evaluate_result, lines 406-437). Measured in PR 186 v4 with
  measure-guard-check.sh (sha256 cf5022db9a544dbc...): input (a), a passing verdict, allows; (b) no verdict file, (c) a failing
  verdict, (d) a verdict-file line that is not an object, (e) bytes that are not UTF-8, (f) a payload whose extra is not an
  object, (g) a 140 KB payload, (h) a 1 KB payload and (i) no python3 on PATH all block. So with the plugin absent or its
  callback raising, a tool runs only on a request the plugin had scanned as passing. Not covered: a rendered config without
  the hooks entry (the launcher's template check refuses one), a profile copy changed after the launch (the launcher refuses
  a working tree whose plugin, check script or config templates differ from HEAD and installs HEAD's bytes, but it does not
  watch the profile afterwards, and the launcher script itself runs from the working tree), and any Hermes path that runs a
  tool without pre_tool_call.
  Exercised by RETRACE_GUARD_TEST=scan-raise (the request scan raises; no verdict; tools blocked), by
  tests.test_guard.HookTests.test_scan_raise_switch_blocks and LoadSwitchTests.test_register_switch_raises, by
  tests.test_guard_check (cases a-i and the hijack paths), and by the Gate 1a negatives (hermes-seat.md §7 1a).

Coverage of edits (layer C, check 8; Grok G-L1): edited paths come from write_file and patch arguments and, best effort, from
terminal commands: redirection targets (``>``, ``>>``), ``tee [-a]`` files, ``sed -i`` file arguments, ``cp``/``mv`` destinations, and
the ``+++ b/`` paths of a patch file given to ``git apply``/``patch -p1``. Heredoc bodies, scripts executed by the shell, ``git apply``
from stdin, and programs that write paths of their own are NOT tracked; the classifier at Worker ingestion remains the enforcement of
record (hermes-seat.md §4.1 check 8, §9).

Test switches (Gate 1a negatives only; never set for a real session):
  RETRACE_GUARD_TEST=scan-raise | scan-timeout | scan-skip   -> the request scan raises / sleeps / records nothing
  RETRACE_GUARD_TEST_LOAD=import | register | timeout        -> the plugin fails at import / in register() / hangs loading
"""
from __future__ import annotations

from functools import wraps
import hashlib
import json
import os
import re
import sys
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

_lock = threading.RLock()
_sessions: Dict[str, Dict[str, Any]] = {}


def _serialized(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        with _lock:
            return fn(*args, **kwargs)
    return wrapped


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
            st = {"model": None, "verdicts": {}, "blocked": None, "edited": set(), "logged": set(), "workdir": os.getcwd(),
                  "root": None, "versions": {}, "pending": {}, "writes": set(), "receipts": set(),
                  "seen_requests": set(), "receipt_error": False}
            _sessions[session_id] = st
        return st


def _record(session_id: str, entry: Dict[str, Any]) -> None:
    entry = {"ts": time.time(), "session_id": session_id, **entry}
    try:
        if not session_id or session_id.startswith(".") or any(c in session_id for c in ("/", "\\", "\x00")):
            raise ValueError("invalid session id")
        d = _home() / "run" / "guard"
        d.mkdir(parents=True, exist_ok=True)
        with open(d / f"{session_id or 'unknown'}.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, default=str) + "\n")
    except Exception:
        _state(session_id)["blocked"] = "guard evidence could not be written"


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
    if not isinstance(msgs, list) or not msgs or any(not isinstance(m, dict) for m in msgs):
        return []
    return msgs


def _incomplete(value: Any) -> bool:
    """Recognize loss markers emitted by the pinned Hermes observer serializer.
    Refusal is conservative: literal evidence containing a marker also blocks.
    This does not turn the observer into a pre-provider policy hook.
    """
    if isinstance(value, dict):
        return any(k in ("_truncated", "_truncated_items") or _incomplete(v) for k, v in value.items())
    if isinstance(value, list):
        return any(_incomplete(v) for v in value)
    return isinstance(value, str) and bool(re.search(r"\.\.\.\[truncated \d+ chars\]|<\w+ depth limit>|<redacted>", value))


def _adapter_text() -> Optional[str]:
    adapter = sys.modules.get("retrace_runtime_adapter")
    return adapter.identity_text() if adapter is not None else None


def scan_messages(messages: Iterable[Dict[str, Any]], *, require_seat: bool,
                  identity_text: Optional[str] = None) -> Tuple[bool, str]:
    """(ok, reason). require_seat: a system message must carry both seat markers (main-loop requests);
    auxiliary requests carry Hermes's own prompts and are scanned for foreign markers only."""
    system_text = []
    for m in messages:
        role = m.get("role")
        text = _text(m.get("content"))
        if role in ("system", "developer"):
            system_text.append(text)
        if identity_text is not None and role not in ("system", "developer"):
            # Evidence is allowed to name other seats only when the pinned loader
            # adapter disabled implicit foreign instruction loading. Text alone
            # never grants a role or permission, including embedded JD envelopes.
            # This literal splice marker is a best-effort secondary heuristic;
            # the pinned adapter's suppression of the hint loader is primary.
            if "[Subdirectory context discovered:" in text:
                return False, "unexpected automatic context splice in tool evidence"
            continue
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
        if identity_text is not None and identity_text not in sys_all:
            return False, "the pinned identity text is missing or incomplete in the system prompt"
    return True, "ok"


@_serialized
def _scan_request(session_id: str, api_request_id: str, request: Any, *, aux: bool, aux_task: str = "") -> None:
    st = _state(session_id)
    if not aux:
        reused = api_request_id in st["seen_requests"]
        st["seen_requests"].add(api_request_id)
        st["verdicts"].clear()
        # Retire shell-hook approval before a scan can raise, skip or time out.
        _record(session_id, {"event": "request", "api_request_id": api_request_id, "verdict": "pending"})
        if reused:
            st["blocked"] = "reused api_request_id"
    else:
        reused = False
    test = os.environ.get("RETRACE_GUARD_TEST", "")
    if test == "scan-raise":
        raise RuntimeError("retrace-guard: RETRACE_GUARD_TEST=scan-raise")
    if test == "scan-timeout":
        time.sleep(3600)
    if test == "scan-skip":
        return
    msgs = _messages_of(request)
    body_sha = hashlib.sha256(json.dumps(request, sort_keys=True, default=str).encode()).hexdigest()
    if st["blocked"]:
        ok, reason = False, st["blocked"]
    elif not api_request_id or not msgs or _incomplete(request):
        ok, reason = False, "missing or incomplete request inspection input"
    elif reused:
        ok, reason = False, "reused api_request_id"
    else:
        try:
            identity = _adapter_text()
            if identity is None:
                ok, reason = False, "pinned runtime adapter is not installed"
            else:
                ok, reason = scan_messages(msgs, require_seat=not aux, identity_text=identity)
        except Exception:
            ok, reason = False, "pinned identity adapter failed"
            st["blocked"] = reason
    verdict = "ok" if ok else "failed"
    if not ok and (aux or "another seat" in reason):
        st["blocked"] = reason
    if api_request_id and not aux:
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


_REDIRECT_RE = re.compile(r"(?<![<>])(?:\d?)>>?\s*([^\s;&|]+)")


def terminal_write_targets(cmd: str, workdir: str) -> List[str]:
    """Best-effort paths a terminal command writes, relative to workdir (see the module docstring for the limits)."""
    out: List[str] = []
    def add(tok: str) -> None:
        tok = tok.strip("'\"")
        if not tok or tok.startswith("-") or tok in ("/dev/null", "&1", "&2") or tok.startswith("/dev/"):
            return
        out.append(_rel(tok, workdir))
    for m in _REDIRECT_RE.finditer(cmd):
        add(m.group(1))
    for seg in re.split(r"[;|&]+|&&|\|\|", cmd):
        toks = [t for t in re.split(r"\s+", seg.strip()) if t]
        if not toks:
            continue
        name = toks[0]
        if name == "tee":
            for t in toks[1:]:
                if not t.startswith("-"):
                    add(t)
        elif name == "sed" and any(t.startswith("-i") or t == "--in-place" for t in toks[1:]):
            args_ = [t for t in toks[1:] if not t.startswith("-")]
            for t in args_[1:]:  # the first non-flag argument is the script
                add(t)
        elif name in ("cp", "mv") and len(toks) >= 3:
            add(toks[-1])
        elif (name == "git" and len(toks) >= 3 and toks[1] == "apply") or (name == "patch"):
            for t in toks[2:] if name == "git" else toks[1:]:
                if t.startswith("-"):
                    continue
                try:
                    pf = Path(t).expanduser()
                    pf = pf if pf.is_absolute() else Path(workdir) / pf
                    for line in pf.read_text(encoding="utf-8", errors="replace").splitlines():
                        if line.startswith("+++ b/"):
                            add(line[6:].strip())
                        elif line.startswith("+++ ") and not line.startswith("+++ /dev/null"):
                            add(line[4:].split("\t")[0].strip())
                except Exception:
                    pass
    return out


def _check_retrace_actor_model(args: Dict[str, Any], st: Dict[str, Any]) -> Optional[str]:
    actor = args.get("actor") if isinstance(args, dict) else None
    if isinstance(actor, dict):
        if actor.get("id", SEAT) != SEAT or actor.get("type", "agent") != "agent":
            return "provenance call names a foreign actor"
        if actor.get("model_source", "harness-config") != "harness-config":
            return "provenance call has a model source inconsistent with this configured-model profile"
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


def _research_path(value: Any, st: Dict[str, Any], *, write: bool) -> bool:
    if not isinstance(value, str) or not value or "\x00" in value:
        return False
    p = Path(value)
    # Bind the checked path to the actual tool argument. A CLI cwd change must not
    # make a relative path refer to a different directory after this check.
    if not p.is_absolute() or ".." in p.parts:
        return False
    if any(part.is_symlink() for part in (p, *p.parents)):
        return False
    reports = os.environ.get("RETRACE_GUARD_REPORT_DIR")
    roots = ([Path(reports)] if reports else []) + ([] if write else [Path(st["workdir"])])
    for root in roots:
        try:
            relative = p.resolve().relative_to(root.resolve())
        except ValueError:
            continue
        if not relative.parts or any(part.startswith(".") for part in relative.parts):
            # The seat's own .hermes.md identity is the sole read-only exception;
            # no other hidden config, Git data, credential file or dot-directory
            # is a research file surface.
            return not write and relative.parts == (".hermes.md",)
        return True
    return False


def _capability_problem(tool: str, args: Dict[str, Any], st: Dict[str, Any]) -> Optional[str]:
    mode = os.environ.get("RETRACE_GUARD_MODE", "research")
    if mode == "builder-probe" and os.environ.get("RETRACE_GUARD_PHASE") == "scratch":
        return None
    if mode != "research":
        return "unqualified capability mode"
    audit = {"retrace_instruct", "retrace_log", "retrace_status", "retrace_why", "retrace_history", "retrace_verify_send"}
    if tool in {prefix + name for prefix in ("mcp__retrace__", "mcp_retrace_") for name in audit}:
        return None
    if tool == "read_file" and _research_path(args.get("path"), st, write=False):
        return None
    if tool == "write_file" and _research_path(args.get("path"), st, write=True):
        return None
    if tool == "web_search":
        return None
    if tool == "web_extract":
        from urllib.parse import urlsplit
        urls = args.get("urls")
        if isinstance(urls, list) and urls and all(isinstance(u, str) and urlsplit(u).scheme in ("http", "https")
                                                 and urlsplit(u).hostname and not urlsplit(u).username for u in urls):
            return None
    return "outside research capability; file tools require absolute paths within the worktree or report directory"


# ---- hooks -------------------------------------------------------------------------------------

def _on_session_start(session_id: str = "", model: Any = None, **_: Any) -> None:
    st = _state(session_id)
    st["model"] = str(model) if model else None
    configured = os.environ.get("RETRACE_ACTOR_MODEL")
    if configured and st["model"] != configured:
        st["blocked"] = "session model differs from the launcher's MCP model claim"
    _record(session_id, {"event": "session_start", "model": st["model"], "plugin": "retrace-guard", "version": "0.2.0",
                         "mode": os.environ.get("RETRACE_GUARD_MODE", "research"),
                         "phase": os.environ.get("RETRACE_GUARD_PHASE", "live"),
                         "config_sha256": os.environ.get("RETRACE_GUARD_CONFIG_SHA"),
                         "mcp_build_sha256": os.environ.get("RETRACE_GUARD_MCP_SHA"),
                         "runtime_commit": os.environ.get("RETRACE_GUARD_RUNTIME")})


def _on_pre_api_request(session_id: str = "", api_request_id: str = "", request: Any = None, model: Any = None, **_: Any) -> None:
    st = _state(session_id)
    if model is not None and st["model"] is not None and str(model) != st["model"]:
        st["blocked"] = "request model changed during the session"
    _scan_request(session_id, api_request_id, request, aux=False)


def _on_pre_auxiliary_call(session_id: str = "", api_request_id: str = "", request: Any = None, aux_task: str = "", **_: Any) -> None:
    _scan_request(session_id, api_request_id, request, aux=True, aux_task=aux_task)


@_serialized
def _on_pre_tool_call(tool_name: str = "", args: Optional[Dict[str, Any]] = None, session_id: str = "",
                      api_request_id: str = "", tool_call_id: str = "", **_: Any) -> Optional[Dict[str, Any]]:
    st = _state(session_id)
    args = args if isinstance(args, dict) else {}
    if st["pending"]:
        return _block("a provenance call has no terminal receipt; stop dependent work and restart/reconcile")
    if st["receipt_error"] and tool_name not in RETRACE_LOG_TOOLS:
        return _block("provenance receipt failed; only a provenance retry is permitted")
    if st["blocked"]:
        return _block(f"session blocked: {st['blocked']}")
    if not api_request_id:
        return _block("tool call carries no api_request_id; no request to authorize it")
    v = st["verdicts"].get(api_request_id)
    if v is None:
        return _block(f"request {api_request_id} was never scanned (scan skipped, timed out or failed); nothing authorizes its tools")
    if v["verdict"] != "ok":
        return _block(f"request {api_request_id} failed the identity scan: {v['reason']}")
    problem = _capability_problem(tool_name, args, st)
    if problem:
        return _block(problem)
    # layer B, check 3(ii): a context file on the path
    cands: List[str] = []
    for key in PATH_TOOLS.get(tool_name, ()):
        if isinstance(args.get(key), str):
            cands.append(args[key])
    if tool_name == "terminal" and isinstance(args.get("command"), str):
        cands.extend(_paths_from_terminal(args["command"]))
    for c in ([] if _adapter_text() is not None else cands):
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
    if tool_name in RETRACE_LOG_TOOLS:
        if st["writes"]:
            return _block("an edit is still in flight; wait for its terminal result before logging it")
        if not tool_call_id:
            return _block("provenance call has no tool_call_id; cannot correlate its receipt")
        st["pending"][tool_call_id] = {"tool": tool_name, "request": api_request_id,
            "args": json.loads(json.dumps(args)), "versions": dict(st["versions"])}
    paths = _write_paths(tool_name, args, st)
    if paths:
        if not tool_call_id:
            return _block("edit call has no tool_call_id; cannot observe its completion")
        _invalidate(st, paths)
        if tool_call_id:
            st["writes"].add(tool_call_id)
    return None


def _write_paths(tool: str, args: Dict[str, Any], st: Dict[str, Any]) -> List[str]:
    if tool in ("write_file", "patch") and isinstance(args.get("path"), str):
        return [_rel(args["path"], st["workdir"])]
    if tool == "terminal" and isinstance(args.get("command"), str):
        return terminal_write_targets(args["command"], st["workdir"])
    return []


def _invalidate(st: Dict[str, Any], paths: Iterable[str]) -> None:
    for path in paths:
        st["edited"].add(path)
        st["logged"].discard(path)
        st["versions"][path] = st["versions"].get(path, 0) + 1


def _receipt(result: Any, status: Any) -> Optional[Dict[str, Any]]:
    """Accept only the connected MCP server's machine receipt, not rendered prose.
    Hermes v0.22.3 preserves structuredContent in its JSON result wrapper. Earlier
    runtimes that drop it deliberately cannot establish coverage. The connection
    and pinned build are the trust boundary; this is not offline signature proof.
    """
    if status != "ok":
        return None
    try:
        value = json.loads(result) if isinstance(result, str) else result
        if not isinstance(value, dict) or value.get("isError") or value.get("error"):
            return None
        data = value.get("structuredContent")
        if not isinstance(data, dict) or data.get("isError") or data.get("error") or data.get("deduped"):
            return None
        r = data.get("receipt")
        if not isinstance(r, dict) or r.get("version") != 1 or r.get("project") != "retrace":
            return None
        if not isinstance(r.get("id"), str) or not re.fullmatch(r"evt_[0-9a-f]{32}", r["id"]):
            return None
        if data.get("id") != r["id"]:
            return None
        if not isinstance(r.get("hash"), str) or not re.fullmatch(r"[0-9a-f]{64}", r["hash"]):
            return None
        if type(r.get("seq")) is not int or r["seq"] < 0:
            return None
        for key in ("hash", "seq"):
            if key in data and data[key] != r[key]:
                return None
        phase = os.environ.get("RETRACE_GUARD_PHASE", "live")
        if phase == "scratch":
            if r.get("storage") != "local":
                return None
        elif phase == "live":
            seal = os.environ.get("RETRACE_GUARD_SEALED_BY", "")
            if not seal.startswith("pinned:") or not re.search(r"\bhermes\b", seal[7:]):
                return None
            if r.get("storage") != "remote" or r.get("sealed_by") != seal or r.get("producer_sig_verdict") != "verified":
                return None
        else:
            return None
        return r
    except (TypeError, ValueError):
        return None


@_serialized
def _on_post_tool_call(tool_name: str = "", args: Optional[Dict[str, Any]] = None, session_id: str = "",
                       status: Any = None, result: Any = None, tool_call_id: str = "",
                       api_request_id: str = "", **_: Any) -> None:
    st = _state(session_id)
    args = args if isinstance(args, dict) else {}
    # Invalidate before dispatch, so a lost post hook cannot preserve old coverage.
    # A post without a matching pre is still conservatively treated as an edit.
    if tool_call_id in st["writes"]:
        st["writes"].remove(tool_call_id)
    else:
        _invalidate(st, _write_paths(tool_name, args, st))
    if tool_name not in RETRACE_LOG_TOOLS:
        return
    pending = st["pending"].pop(tool_call_id, None)
    st["receipt_error"] = True
    if not pending or pending["tool"] != tool_name or pending["request"] != api_request_id or pending["args"] != args:
        return
    r = _receipt(result, status)
    if r is None or r["id"] in st["receipts"]:
        _record(session_id, {"event": "receipt_rejected", "tool_call_id": tool_call_id})
        return
    actor = r.get("actor")
    if not isinstance(actor, dict):
        return
    if tool_name not in RETRACE_LOG_TOOL_NAMES:
        if (r.get("action") == "instructed" and actor.get("type") == "human"
                and actor.get("id") == args.get("human_id") == "jordansboxing@gmail.com"
                and st["root"] is None):
            st["root"] = r["id"]
            st["receipts"].add(r["id"])
            st["receipt_error"] = False
        return
    if (not r.get("action") or r["action"] != args.get("action")
            or not st["root"] or r.get("caused_by") != st["root"] or args.get("caused_by") != st["root"]
            or actor.get("type") != "agent" or actor.get("id") != SEAT
            or not st["model"] or actor.get("model") != st["model"]
            or actor.get("model_source") != "harness-config"):
        return
    st["receipt_error"] = False
    if r["action"] not in ("created", "edited"):
        st["receipts"].add(r["id"])
        return
    refs = r.get("artifacts")
    proposed = args.get("artifacts")
    if not isinstance(refs, list) or not isinstance(proposed, list):
        return
    # Require an explicit output role on both sides; omitted/defaulted or input-only
    # refs are not edit receipts for this guard, even if the ledger accepted them.
    def outputs(items):
        return {a["id"] for a in items if isinstance(a, dict) and isinstance(a.get("id"), str)
                and a.get("role") in ("generated", "both")}
    st["receipts"].add(r["id"])
    for aid in outputs(refs) & outputs(proposed):
        prefix = "repo:jordandru/retrace#"
        if not aid.startswith(prefix):
            continue
        path = aid[len(prefix):]
        if not path or ".." in Path(path).parts or _rel(path, st["workdir"]) != path or Path(path).is_absolute():
            continue
        version = pending["versions"].get(path)
        if version is not None and version == st["versions"].get(path):
            st["logged"].add(path)
    _record(session_id, {"event": "edit_receipt", "event_id": r["id"], "tool_call_id": tool_call_id,
                         "covered": sorted(st["logged"])})


def _rel(p: str, workdir: str) -> str:
    try:
        path = Path(p).expanduser()
        if not path.is_absolute():
            path = Path(workdir) / path
        return str(path.resolve().relative_to(Path(workdir).resolve()))
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
