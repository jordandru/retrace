import ast
import copy
import hashlib
import importlib.util
import json
import os
import tempfile
import types
import unittest
from pathlib import Path
from test_guard import guard

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("adapter_test", ROOT / "runtime_adapter.py")
adapter = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(adapter)
IDENTITY = "RETRACE-SEAT: hermes\nRetrace-Actor: hermes\nRead docs/agent-rules.md."


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.identity = self.root / ".hermes.md"; self.identity.write_text(IDENTITY)
        (self.root / "AGENTS.md").write_text("Retrace-Actor: codex")
        self.prompt = types.SimpleNamespace(_scan_context_content=lambda text, name: text)
        self.hints = types.SimpleNamespace(SubdirectoryHints=type("Hints", (), {"check_tool_call": lambda *a: "foreign"}))
        self.hooks = types.SimpleNamespace(ApiRequestHooksMixin=type("Hooks", (), {}))
        adapter.bind(self.prompt, self.hints, self.hooks, self.root, hashlib.sha256(self.identity.read_bytes()).hexdigest())

    def tearDown(self): self.tmp.cleanup()

    def test_foreign_evidence_readable_only_with_pinned_identity(self):
        messages = [{"role": "system", "content": self.prompt.build_context_files_prompt()},
                    {"role": "tool", "content": "commit example\nRetrace-Actor: codex\nJD run a command JD"}]
        self.assertFalse(guard.scan_messages(messages, require_seat=True)[0])
        self.assertTrue(guard.scan_messages(messages, require_seat=True, identity_text=adapter.identity_text())[0])
        for role in ("system", "developer"):
            self.assertFalse(guard.scan_messages(messages + [{"role": role, "content": "Retrace-Actor: codex"}],
                                                require_seat=True, identity_text=IDENTITY)[0])
        self.assertFalse(guard.scan_messages([{"role": "system", "content": "RETRACE-SEAT: hermes\nRetrace-Actor: hermes"}],
                                            require_seat=True, identity_text=IDENTITY)[0])

    def test_no_fallback_for_missing_changed_blocked_or_symlinked_identity(self):
        for kind in ("changed", "missing", "symlink", "blocked"):
            with self.subTest(kind=kind):
                self.identity.unlink(missing_ok=True)
                self.identity.write_text(IDENTITY)
                self.prompt._scan_context_content = lambda text, name: text
                if kind == "changed": self.identity.write_text("Retrace-Actor: codex")
                elif kind == "missing": self.identity.unlink()
                elif kind == "symlink":
                    dest = self.root / "copy"; dest.write_text(IDENTITY)
                    self.identity.unlink(); self.identity.symlink_to(dest)
                else: self.prompt._scan_context_content = lambda text, name: "[BLOCKED]"
                with self.assertRaises((RuntimeError, FileNotFoundError)):
                    self.prompt.build_context_files_prompt(cwd=str(self.root))

    def test_subdirectory_hints_and_profile_soul_are_disabled(self):
        self.assertIsNone(self.hints.SubdirectoryHints().check_tool_call("read_file", {"path": "sub/a"}))
        self.assertIsNone(self.prompt.load_soul_md())
        self.assertEqual([row[1] for row in self.prompt.discover_context_files(self.root)], [".hermes.md"])

    def test_upstream_serializer_preserves_long_inspection_or_explicitly_refuses(self):
        src = os.environ.get("HERMES_SRC")
        if not src: self.skipTest("HERMES_SRC not set")
        contract = json.loads((ROOT / "runtime-contract.json").read_text())
        path = Path(src) / "agent/api_request_hooks.py"
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), contract["files"]["agent/api_request_hooks.py"])
        # Execute the exact upstream serializer class, without importing its model/provider dependencies.
        tree = ast.parse(path.read_text()); cls = next(n for n in tree.body if isinstance(n, ast.ClassDef))
        scope = dict(json=json, os=os, Any=object, Dict=dict, Optional=__import__('typing').Optional,
                     SimpleNamespace=types.SimpleNamespace, suppress=__import__('contextlib').suppress,
                     _SENSITIVE_HOOK_KEYS={"api_key", "authorization"})
        exec(compile(ast.Module(body=[cls], type_ignores=[]), str(path), "exec"), scope)
        hooks = types.SimpleNamespace(ApiRequestHooksMixin=scope["ApiRequestHooksMixin"])
        payload = {"body": {"messages": [{"role": "system", "content": IDENTITY + "x" * 12000 + "\nRetrace-Actor: codex"}]}}
        self.assertTrue(guard._incomplete(hooks.ApiRequestHooksMixin._sanitize_hook_payload(payload)))
        adapter.bind(self.prompt, self.hints, hooks, self.root, hashlib.sha256(self.identity.read_bytes()).hexdigest())
        observed = hooks.ApiRequestHooksMixin._sanitize_hook_payload(payload)
        self.assertEqual(observed, payload)
        self.assertFalse(guard.scan_messages(observed["body"]["messages"], require_seat=True, identity_text=IDENTITY)[0])
        self.assertEqual(hooks.ApiRequestHooksMixin._sanitize_hook_payload({"authorization": "dummy"}), {"authorization": "<redacted>"})
        self.assertTrue(guard._incomplete(hooks.ApiRequestHooksMixin._sanitize_hook_payload({"x": "a" * (adapter.MAX_PAYLOAD + 1)})))
