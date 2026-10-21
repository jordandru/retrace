"""Hook-level receipt tests use the actual v0.22.3 MCP wrapper and hook status.
No provider, credential or network is used.
"""
import copy
import json
import os
import sys
import types
import tempfile
import unittest
from unittest.mock import patch
from test_guard import guard, req

ROOT = "evt_" + "1" * 32
LOG = "evt_" + "2" * 32
COMMIT = "git commit -m 'test\nRetrace-Actor: hermes\nRetrace-Model: stub-model-1\nRetrace-Model-Source: harness-config\nRetrace-Caused-By: " + ROOT + "'"


def result(action="edited", **changes):
    receipt = dict(version=1, storage="local", id=LOG, hash="a" * 64, seq=1,
                   project="retrace", action=action, caused_by=ROOT,
                   actor=dict(type="agent", id="hermes", model="stub-model-1", model_source="harness-config"),
                   artifacts=[dict(id="repo:jordandru/retrace#a.md", role="both")])
    receipt.update(changes)
    return json.dumps({"result": "untrusted display text", "structuredContent": {
        "id": receipt["id"], "hash": receipt["hash"], "seq": receipt["seq"], "deduped": False, "receipt": receipt}})


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.adapter = patch.dict(sys.modules, {"retrace_runtime_adapter": types.SimpleNamespace(identity_text=lambda: "RETRACE-SEAT: hermes\nRetrace-Actor: hermes")})
        self.adapter.start()
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"HERMES_HOME": self.tmp.name, "RETRACE_GUARD_PHASE": "scratch", "RETRACE_GUARD_MODE": "builder-probe"})
        self.env.start(); guard._sessions.clear()
        guard._on_session_start(session_id="s", model="stub-model-1")
        guard._on_pre_api_request(session_id="s", api_request_id="r", request=req("ok"))
        self.n = 0
        self.call("mcp__retrace__retrace_instruct", {"human_id": "jordansboxing@gmail.com"},
                  result("instructed", id=ROOT, seq=0, caused_by=None,
                         actor={"type": "human", "id": "jordansboxing@gmail.com"}, artifacts=[]))
        self.call("write_file", {"path": "a.md"}, "{}")
        self.args = dict(action="edited", caused_by=ROOT,
                         artifacts=[dict(id="repo:jordandru/retrace#a.md", role="both")])

    def tearDown(self):
        self.adapter.stop()
        self.env.stop(); self.tmp.cleanup()

    def pre(self, tool, args):
        self.n += 1
        kw = dict(tool_name=tool, args=args, session_id="s", api_request_id="r", tool_call_id=str(self.n))
        block = guard._on_pre_tool_call(**kw)
        self.assertIsNone(block, block)
        return kw

    def call(self, tool, args, response, status="ok"):
        kw = self.pre(tool, args)
        guard._on_post_tool_call(**kw, status=status, result=response)

    def covered(self):
        return guard._check_commit(COMMIT, guard._state("s")) is None

    def test_failed_log_used_artifact_never_covers_edit(self):
        self.args["artifacts"][0]["role"] = "used"
        self.call("mcp__retrace__retrace_log", self.args, '{"error":"failed"}', status="error")
        self.assertFalse(self.covered())

    def test_only_matching_append_receipt_covers_edit(self):
        self.call("mcp__retrace__retrace_log", self.args, result())
        self.assertTrue(self.covered())
        self.pre("write_file", {"path": "a.md"})  # invalidate before dispatch, even if post-hook disappears
        self.assertFalse(self.covered())

    def test_invalid_receipts_fail_closed(self):
        bad = [None, "logged " + LOG, '{"isError":true}', result(action="read"),
               result(caused_by="evt_" + "3" * 32), result(project="other"), result(hash="short"),
               result(actor={"type": "agent", "id": "codex"}),
               result(artifacts=[dict(id="repo:other#a.md", role="both")]),
               result(artifacts=[dict(id="repo:jordandru/retrace#a.md", role="used")]),
               result(storage="remote", sealed_by="owner", producer_sig_verdict="verified")]
        for response in bad:
            with self.subTest(response=response):
                self.call("mcp__retrace__retrace_log", self.args, response)
                self.assertFalse(self.covered())

    def test_transport_ok_cannot_hide_mcp_error_or_deduplication(self):
        for key in ("isError", "error", "deduped"):
            response = json.loads(result())
            (response["structuredContent"] if key == "deduped" else response)[key] = True
            self.call("mcp__retrace__retrace_log", self.args, json.dumps(response))
            self.assertFalse(self.covered())

    def test_live_requires_exact_expected_seal_and_verified_signature(self):
        os.environ.update(RETRACE_GUARD_PHASE="live", RETRACE_GUARD_SEALED_BY="pinned:retrace · hermes for owner")
        for seal, verdict, allowed in [("owner", "verified", False), ("pinned:hermes", "verified", False),
                                       (os.environ["RETRACE_GUARD_SEALED_BY"], "none", False),
                                       (os.environ["RETRACE_GUARD_SEALED_BY"], "verified", True)]:
            os.environ["RETRACE_GUARD_MODE"] = "research"
            self.call("mcp__retrace__retrace_log", self.args, result(storage="remote", sealed_by=seal, producer_sig_verdict=verdict))
            self.assertEqual(self.covered(), allowed)

    def test_post_without_pre_and_changed_args_cannot_cover(self):
        guard._on_post_tool_call(tool_name="mcp__retrace__retrace_log", args=self.args, session_id="s", status="ok", result=result())
        self.assertFalse(self.covered())
        kw = self.pre("mcp__retrace__retrace_log", self.args)
        kw["args"] = {**self.args, "caused_by": "evt_other"}
        guard._on_post_tool_call(**kw, status="ok", result=result())
        self.assertFalse(self.covered())

    def test_late_log_result_cannot_cover_concurrent_edit(self):
        kw = self.pre("mcp__retrace__retrace_log", self.args)
        guard._on_post_tool_call(tool_name="write_file", args={"path": "a.md"}, session_id="s")
        guard._on_post_tool_call(**kw, status="ok", result=result())
        self.assertFalse(self.covered())

    def test_log_cannot_cover_an_edit_before_its_terminal_result(self):
        kw = self.pre("write_file", {"path": "a.md"})
        blocked = guard._on_pre_tool_call(tool_name="mcp__retrace__retrace_log", args=self.args,
                                          session_id="s", api_request_id="r", tool_call_id="premature")
        self.assertIsNotNone(blocked)
        self.assertIn("still in flight", blocked["message"])
        guard._on_post_tool_call(**kw, status="ok", result="{}")
        self.call("mcp__retrace__retrace_log", self.args, result())
        self.assertTrue(self.covered())

    def test_replayed_receipt_does_not_cover_new_edit(self):
        self.call("mcp__retrace__retrace_log", self.args, result())
        self.call("write_file", {"path": "a.md"}, "{}")
        self.call("mcp__retrace__retrace_log", self.args, result())
        self.assertFalse(self.covered())

    def test_missing_post_hook_blocks_next_dependent_tool(self):
        self.pre("mcp__retrace__retrace_log", self.args)
        blocked = guard._on_pre_tool_call(tool_name="terminal", args={"command": "ls"},
                                          session_id="s", api_request_id="r", tool_call_id="next")
        self.assertIsNotNone(blocked)

    def test_failed_receipt_stops_work_until_a_valid_provenance_retry(self):
        self.call("mcp__retrace__retrace_log", self.args, '{"error":"lost"}', status="error")
        self.assertIsNotNone(guard._on_pre_tool_call(tool_name="terminal", args={"command": "ls"}, session_id="s", api_request_id="r"))
        self.call("mcp__retrace__retrace_log", self.args, result())
        self.assertIsNone(guard._on_pre_tool_call(tool_name="terminal", args={"command": "ls"}, session_id="s", api_request_id="r"))

    def test_relative_path_uses_session_workdir(self):
        self.assertEqual(guard._rel("./a.md", self.tmp.name), "a.md")


if __name__ == "__main__":
    unittest.main()
