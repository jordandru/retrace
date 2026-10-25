"""Narrow startup adapter for the exact Hermes source contract in runtime-contract.json.

Runs inside the selected venv with Python -I, before importing the CLI. No provider
call or credential operation occurs here. Qualification must still exercise the
actual CLI/TUI: binding these functions is not proof every upstream path uses them.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import subprocess
import sys
from pathlib import Path

MAX_PAYLOAD = 8 * 1024 * 1024
_identity = None


def identity_text() -> str:
    if _identity is None:
        raise RuntimeError("identity adapter has not been installed")
    path, expected = _identity
    if path.is_symlink():
        raise RuntimeError("identity must not be a symlink")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise RuntimeError("identity changed after launch")
    text = data.decode("utf-8").strip()
    if not text or len(data) > 65536:
        raise RuntimeError("identity missing or exceeds scanner budget")
    return text


def verify_source(source: Path, contract: dict) -> None:
    head = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if head != contract["commit"]:
        raise RuntimeError("Hermes source commit does not match adapter contract")
    if subprocess.run(["git", "-C", str(source), "diff", "--quiet", "HEAD", "--"], check=False).returncode:
        raise RuntimeError("Hermes tracked source differs from its pin")
    for name, expected in contract["files"].items():
        path = source / name
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise RuntimeError("Hermes adapter contract changed: " + name)


def bind(prompt_builder, subdirectory_hints, request_hooks, root: Path, identity_sha: str) -> None:
    global _identity
    _identity = (root.resolve() / ".hermes.md", identity_sha)
    identity_text()

    def context(cwd=None, skip_soul=False, context_length=None, allow_install_tree_fallback=False, home_override=None):
        # The only automatic project instruction source is the launcher-selected
        # file. Missing/blocked identity raises; there is no AGENTS/CLAUDE fallback.
        text = identity_text()
        scanned = prompt_builder._scan_context_content(text, ".hermes.md")
        if scanned != text:
            raise RuntimeError("pinned Hermes identity was blocked or transformed by the scanner")
        return "# Project Context\n\n## .hermes.md\n\n" + text

    prompt_builder.build_context_files_prompt = context
    prompt_builder.load_soul_md = lambda *args, **kwargs: None
    # Discovery is also used by inspection displays. Never make a foreign source
    # look like an admitted instruction there.
    prompt_builder.discover_context_files = lambda cwd: [("hermes", ".hermes.md", _identity[0], identity_text())]
    subdirectory_hints.SubdirectoryHints.check_tool_call = lambda self, *args, **kwargs: None

    def complete_payload(cls, value):
        # Preserve upstream secret-key redaction/SDK coercion while relaxing its
        # max_string=8,000 and max_sequence=200 defaults (pinned v0.22.3
        # agent/api_request_hooks.py:67-70). Above 8 MiB, tools fail closed.
        payload = cls._hook_jsonable(value, max_depth=64, max_string=MAX_PAYLOAD, max_sequence=MAX_PAYLOAD)
        encoded = json.dumps(payload, ensure_ascii=False)
        if len(encoded.encode("utf-8")) > MAX_PAYLOAD:
            return {"_truncated": True, "reason": "Retrace inspection budget exceeded"}
        return payload

    request_hooks.ApiRequestHooksMixin._sanitize_hook_payload = classmethod(complete_payload)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--identity-sha", required=True)
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    contract = json.loads(args.contract.read_text())
    source = args.source.resolve()
    verify_source(source, contract)
    sys.path.insert(0, str(source))
    modules = [importlib.import_module(name) for name in
               ("agent.prompt_builder", "agent.subdirectory_hints", "agent.api_request_hooks")]
    for module in modules:
        if not Path(module.__file__).resolve().is_relative_to(source):
            raise RuntimeError("adapter imported a module outside the selected source")
    bind(*modules, args.root, args.identity_sha)
    # The guard checks this in-process binding, not a caller-supplied environment flag.
    sys.modules["retrace_runtime_adapter"] = sys.modules[__name__]
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    sys.argv = ["hermes", *command]
    from hermes_cli.main import main as hermes_main
    hermes_main()


if __name__ == "__main__":
    main()
