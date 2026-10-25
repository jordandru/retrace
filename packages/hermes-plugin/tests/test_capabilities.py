import os
import sys
import types
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from test_guard import guard, req


class CapabilityTests(unittest.TestCase):
    def setUp(self):
        self.adapter = patch.dict(sys.modules, {"retrace_runtime_adapter": types.SimpleNamespace(identity_text=lambda: "RETRACE-SEAT: hermes\nRetrace-Actor: hermes")})
        self.adapter.start()
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.repo = self.root / "repo"; self.repo.mkdir()
        self.reports = self.root / "profile/run/reports"; self.reports.mkdir(parents=True)
        self.env = patch.dict(os.environ, {"RETRACE_GUARD_MODE": "research", "RETRACE_GUARD_PHASE": "scratch",
            "RETRACE_GUARD_REPORT_DIR": str(self.reports), "HERMES_HOME": str(self.root / "profile")})
        self.env.start(); guard._sessions.clear()
        guard._on_session_start(session_id="s", model="test")
        guard._state("s")["workdir"] = str(self.repo)
        guard._on_pre_api_request(session_id="s", api_request_id="r", request=req("ok"))

    def tearDown(self): self.adapter.stop(); self.env.stop(); self.tmp.cleanup()

    def allowed(self, tool, **args):
        return guard._on_pre_tool_call(tool_name=tool, args=args, session_id="s", api_request_id="r", tool_call_id=tool) is None

    def test_research_reads_reports_and_web_but_cannot_mutate_project_or_execute(self):
        self.assertTrue(self.allowed("read_file", path=str(self.repo / "docs/agent-rules.md")))
        self.assertTrue(self.allowed("write_file", path=str(self.reports / "finding.md"), content="cited finding"))
        self.assertTrue(self.allowed("web_search", query="upstream docs"))
        self.assertTrue(self.allowed("web_extract", urls=["https://github.com/NousResearch/hermes-agent"]))
        for tool, args in [("terminal", {"command": "cat ~/.retrace/key"}), ("write_file", {"path": "src/a.ts"}),
                           ("patch", {"mode": "patch", "patch": "arbitrary path"}), ("read_file", {"path": ".env"}),
                           ("read_file", {"path": "../secret"}), ("read_file", {"path": "/etc/passwd"}),
                           ("read_file", {"path": ".git/config"}), ("web_extract", {"urls": ["file:///etc/passwd"]})]:
            with self.subTest(tool=tool, args=args): self.assertFalse(self.allowed(tool, **args))

    def test_alternate_tool_names_and_unqualified_capabilities_are_denied(self):
        for tool in ("execute_code", "tool_call", "tool_search", "delegate_task", "memory", "skill_manage",
                     "cronjob", "kanban_create", "mcp__retrace__retrace_send", "mcp__other__read", "new_upstream_tool"):
            with self.subTest(tool=tool): self.assertFalse(self.allowed(tool))

    def test_symlink_and_report_traversal_refused(self):
        (self.repo / "outside").symlink_to(self.root)
        self.assertFalse(self.allowed("read_file", path=str(self.repo / "outside/secret")))
        self.assertFalse(self.allowed("write_file", path=str(self.reports / "../guard/s.jsonl")))
        self.assertFalse(self.allowed("write_file", path=str(self.reports / ".env")))

    def test_relative_paths_cannot_follow_a_changed_tool_working_directory(self):
        self.assertFalse(self.allowed("read_file", path="docs/agent-rules.md"))
        self.assertTrue(self.allowed("read_file", path=str(self.repo / "docs/agent-rules.md")))

    def test_live_cannot_select_builder_probe(self):
        os.environ.update(RETRACE_GUARD_PHASE="live", RETRACE_GUARD_MODE="builder-probe")
        self.assertFalse(self.allowed("terminal", command="true"))

    def test_model_switch_blocks_the_session(self):
        with patch.dict(os.environ, {"RETRACE_ACTOR_MODEL": "different"}):
            guard._on_session_start(session_id="s", model="test")
        self.assertFalse(self.allowed("web_search", query="q"))
