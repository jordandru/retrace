import copy
import os
import sys
import types
import tempfile
import unittest
from unittest.mock import patch
from test_guard import guard, req


class RequestEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.adapter = patch.dict(sys.modules, {"retrace_runtime_adapter": types.SimpleNamespace(identity_text=lambda: "RETRACE-SEAT: hermes\nRetrace-Actor: hermes")})
        self.adapter.start()
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"HERMES_HOME": self.tmp.name})
        self.env.start(); guard._sessions.clear()

    def tearDown(self):
        self.adapter.stop()
        self.env.stop(); self.tmp.cleanup()

    def scan(self, r, rid="r"):
        guard._on_pre_api_request(session_id="s", api_request_id=rid, request=r)

    def allowed(self, rid="r"):
        return guard._on_pre_tool_call(session_id="s", api_request_id=rid, tool_name="read_file", args={"path": os.path.join(os.getcwd(), "README.md")}) is None

    def test_partial_and_malformed_inspections_never_pass(self):
        cases = [None, {"body": {}}, {"body": {"messages": "not a list"}},
                 {"_truncated": True}, {"body": {"messages": [req("ok")["body"]["messages"][0], "lost"]}}]
        for marker in ("...[truncated 10 chars]", "<dict depth limit>", "<redacted>", {"_truncated_items": 2}):
            r = copy.deepcopy(req("ok")); r["body"]["messages"].append({"role": "tool", "content": marker}); cases.append(r)
        for i, r in enumerate(cases):
            with self.subTest(case=i):
                self.scan(r, str(i)); self.assertFalse(self.allowed(str(i)))

    def test_new_request_retires_old_approval(self):
        self.scan(req("ok")); self.assertTrue(self.allowed())
        self.scan(req("ok"), "next")
        self.assertFalse(self.allowed()); self.assertTrue(self.allowed("next"))

    def test_reused_id_scan_exception_cannot_keep_previous_pass(self):
        self.scan(req("ok"))
        with patch.dict(os.environ, {"RETRACE_GUARD_TEST": "scan-raise"}):
            with self.assertRaises(RuntimeError): self.scan(req("ok"))
        self.assertFalse(self.allowed())

    def test_auxiliary_request_cannot_authorize_main_tools(self):
        guard._on_pre_auxiliary_call(session_id="s", api_request_id="aux", request=req("ok"))
        self.assertFalse(self.allowed("aux"))

    def test_old_request_id_cannot_be_reintroduced_after_another_request(self):
        self.scan(req("ok")); self.scan(req("ok"), "next"); self.scan(req("ok"))
        self.assertFalse(self.allowed())

    def test_runtime_model_switch_stops_tools(self):
        guard._on_session_start(session_id="s", model="initial")
        guard._on_pre_api_request(session_id="s", api_request_id="r", request=req("ok"), model="fallback")
        self.assertFalse(self.allowed())

    def test_invalid_session_id_cannot_write_outside_guard_directory(self):
        guard._on_pre_api_request(session_id="../escaped", api_request_id="r", request=req("ok"))
        self.assertIsNotNone(guard._on_pre_tool_call(session_id="../escaped", api_request_id="r", tool_name="read_file"))

    def test_unwritable_evidence_blocks_plugin_even_with_passing_scan(self):
        with patch.object(guard.Path, "mkdir", side_effect=OSError("unwritable")):
            self.scan(req("ok"))
        self.assertFalse(self.allowed())


    def test_missing_adapter_never_authorizes_tools(self):
        with patch.dict(sys.modules):
            sys.modules.pop("retrace_runtime_adapter", None)
            self.scan(req("ok"))
        self.assertFalse(self.allowed())
