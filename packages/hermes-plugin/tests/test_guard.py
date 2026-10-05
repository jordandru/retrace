"""Unit tests for retrace-guard against message arrays extracted from recorded Gate 0 request bodies (docs/design/hermes-seat.md §7 1a;
fixtures/*.json name the run and jsonl line each array came from).
Run: python3 -m unittest discover -s packages/hermes-plugin/tests  (no Hermes install needed)."""
import importlib.util, json, os, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("retrace_guard", HERE.parent / "retrace-guard" / "__init__.py")
guard = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(guard)  # type: ignore


def fx(name):
    return json.loads((HERE / "fixtures" / f"{name}.json").read_text())["messages"]


def req(name):
    return {"method": "POST", "body": {"messages": fx(name), "model": "stub-model-1"}}


class Ctx:
    def __init__(self): self.hooks = {}
    def register_hook(self, name, cb): self.hooks[name] = cb


class ScanTests(unittest.TestCase):
    def test_ok_prompt_passes(self):
        ok, reason = guard.scan_messages(fx("ok"), require_seat=True); self.assertTrue(ok, reason)
    def test_decoy_agents_md_fails(self):
        ok, reason = guard.scan_messages(fx("decoy"), require_seat=True); self.assertFalse(ok); self.assertIn("codex", reason)
    def test_blocked_identity_file_fails_for_missing_marker(self):
        ok, reason = guard.scan_messages(fx("blocked"), require_seat=True); self.assertFalse(ok); self.assertIn("no seat identity", reason)
    def test_spliced_tool_result_fails(self):
        ok, reason = guard.scan_messages(fx("splice"), require_seat=True); self.assertFalse(ok); self.assertIn("tool", reason)
    def test_aux_without_seat_marker_passes(self):
        ok, _ = guard.scan_messages([{"role": "system", "content": "Summarise the title."}], require_seat=False); self.assertTrue(ok)
    def test_aux_with_foreign_marker_fails(self):
        ok, _ = guard.scan_messages([{"role": "user", "content": "x Retrace-Actor: grok y"}], require_seat=False); self.assertFalse(ok)


class HookTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); os.environ["HERMES_HOME"] = self.tmp.name
        os.environ.pop("RETRACE_GUARD_TEST", None); os.environ.pop("RETRACE_GUARD_TEST_LOAD", None)
        guard._sessions.clear(); self.ctx = Ctx(); guard.register(self.ctx); self.h = self.ctx.hooks
        self.h["on_session_start"](session_id="s1", model="stub-model-1")
    def tearDown(self): self.tmp.cleanup()
    def verdict_file(self): return Path(self.tmp.name) / "run" / "guard" / "s1.jsonl"

    def test_tool_allowed_only_after_passing_scan(self):
        self.assertIsNotNone(self.h["pre_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="s1", api_request_id="r1"))
        self.h["pre_api_request"](session_id="s1", api_request_id="r1", request=req("ok"))
        self.assertIsNone(self.h["pre_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="s1", api_request_id="r1"))
        lines = [json.loads(l) for l in self.verdict_file().read_text().splitlines()]
        self.assertTrue(any(e.get("api_request_id") == "r1" and e.get("verdict") == "ok" for e in lines))

    def test_stale_approval_does_not_carry(self):  # C-M1
        self.h["pre_api_request"](session_id="s1", api_request_id="r1", request=req("ok"))
        r = self.h["pre_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="s1", api_request_id="r2")
        self.assertEqual(r["action"], "block"); self.assertIn("never scanned", r["message"])

    def test_scan_skip_switch_blocks(self):  # C-M1 negative
        os.environ["RETRACE_GUARD_TEST"] = "scan-skip"
        self.h["pre_api_request"](session_id="s1", api_request_id="r1", request=req("ok"))
        self.assertEqual(self.h["pre_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="s1", api_request_id="r1")["action"], "block")

    def test_scan_raise_switch_blocks(self):  # N-M1: a raising request scan records no verdict; tools blocked
        os.environ["RETRACE_GUARD_TEST"] = "scan-raise"
        with self.assertRaises(RuntimeError):
            self.h["pre_api_request"](session_id="s1", api_request_id="r1", request=req("ok"))
        r = self.h["pre_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="s1", api_request_id="r1")
        self.assertEqual(r["action"], "block"); self.assertIn("never scanned", r["message"])

    def test_terminal_writes_tracked_for_coverage(self):  # G-L1
        wd = Path(self.tmp.name) / "proj"; wd.mkdir(); (wd / "p.diff").write_text("--- a/src/x.ts\n+++ b/src/x.ts\n@@\n")
        guard._sessions["s1"]["workdir"] = str(wd)
        self.h["pre_api_request"](session_id="s1", api_request_id="r1", request=req("ok"))
        for cmd in ("echo hi > notes.md", "printf x >> log/out.txt", "cat a | tee -a b.txt", "sed -i 's/a/b/' c.py", "cp one.txt two.txt", "git apply p.diff"):
            self.h["post_tool_call"](tool_name="terminal", args={"command": cmd}, session_id="s1")
        self.assertTrue({"notes.md", "log/out.txt", "b.txt", "c.py", "two.txt", "src/x.ts"} <= guard._sessions["s1"]["edited"], guard._sessions["s1"]["edited"])
        commit = "git commit --only notes.md -m 'x\n\nRetrace-Actor: hermes\nRetrace-Model: m\nRetrace-Model-Source: harness-config\nRetrace-Caused-By: evt_1'"
        self.assertEqual(self.h["pre_tool_call"](tool_name="terminal", args={"command": commit}, session_id="s1", api_request_id="r1")["action"], "block")
        self.assertEqual(guard.terminal_write_targets("ls > /dev/null 2>&1", str(wd)), [])

    def test_decoy_blocks_session(self):
        self.h["pre_api_request"](session_id="s1", api_request_id="r1", request=req("decoy"))
        r = self.h["pre_tool_call"](tool_name="read_file", args={"path": "x"}, session_id="s1", api_request_id="r1")
        self.assertEqual(r["action"], "block"); self.assertIn("blocked", r["message"])
        self.h["pre_api_request"](session_id="s1", api_request_id="r2", request=req("ok"))
        self.assertEqual(self.h["pre_tool_call"](tool_name="read_file", args={"path": "x"}, session_id="s1", api_request_id="r2")["action"], "block")

    def test_splice_detected_at_next_request(self):  # C-M3 detection
        self.h["pre_api_request"](session_id="s1", api_request_id="r1", request=req("splice"))
        self.assertEqual(self.h["pre_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="s1", api_request_id="r1")["action"], "block")

    def test_path_precheck_blocks_context_file_on_path(self):  # C-M3 prevention at the call
        wd = Path(self.tmp.name) / "proj"; (wd / "sub" / "dir").mkdir(parents=True); (wd / "sub" / "AGENTS.md").write_text("Retrace-Actor: codex\n")
        (wd / "sub" / "dir" / "n.txt").write_text("x"); guard._sessions["s1"]["workdir"] = str(wd)
        self.h["pre_api_request"](session_id="s1", api_request_id="r1", request=req("ok"))
        r = self.h["pre_tool_call"](tool_name="read_file", args={"path": "sub/dir/n.txt"}, session_id="s1", api_request_id="r1")
        self.assertEqual(r["action"], "block"); self.assertIn("context file sits on this path", r["message"])
        self.assertIsNone(self.h["pre_tool_call"](tool_name="read_file", args={"path": "README.md"}, session_id="s1", api_request_id="r1"))

    def test_model_equality(self):  # layer C check 6
        self.h["pre_api_request"](session_id="s1", api_request_id="r1", request=req("ok"))
        r = self.h["pre_tool_call"](tool_name="mcp__retrace__retrace_log", args={"actor": {"model": "narrated-model"}}, session_id="s1", api_request_id="r1")
        self.assertEqual(r["action"], "block")
        self.assertIsNone(self.h["pre_tool_call"](tool_name="mcp__retrace__retrace_log", args={"actor": {"model": "stub-model-1"}}, session_id="s1", api_request_id="r1"))

    def test_commit_trailers_and_coverage(self):  # layer C checks 7-8
        self.h["pre_api_request"](session_id="s1", api_request_id="r1", request=req("ok"))
        bad = {"command": "git commit -m 'x'"}
        self.assertEqual(self.h["pre_tool_call"](tool_name="terminal", args=bad, session_id="s1", api_request_id="r1")["action"], "block")
        good_msg = "git commit --only a.md -m 'x\n\nRetrace-Actor: hermes\nRetrace-Model: m\nRetrace-Model-Source: harness-config\nRetrace-Caused-By: evt_1'"
        self.h["post_tool_call"](tool_name="write_file", args={"path": "a.md"}, session_id="s1")
        r = self.h["pre_tool_call"](tool_name="terminal", args={"command": good_msg}, session_id="s1", api_request_id="r1")
        self.assertEqual(r["action"], "block"); self.assertIn("never named", r["message"])
        self.h["post_tool_call"](tool_name="mcp__retrace__retrace_log", args={"artifacts": [{"id": "repo:jordandru/retrace#a.md"}]}, session_id="s1")
        self.assertIsNone(self.h["pre_tool_call"](tool_name="terminal", args={"command": good_msg}, session_id="s1", api_request_id="r1"))
        self.assertEqual(self.h["pre_tool_call"](tool_name="terminal", args={"command": good_msg + " --amend"}, session_id="s1", api_request_id="r1")["action"], "block")


class LoadSwitchTests(unittest.TestCase):
    def test_register_switch_raises(self):
        os.environ["RETRACE_GUARD_TEST_LOAD"] = "register"
        try:
            with self.assertRaises(RuntimeError): guard.register(Ctx())
        finally:
            os.environ.pop("RETRACE_GUARD_TEST_LOAD", None)


if __name__ == "__main__":
    unittest.main()
