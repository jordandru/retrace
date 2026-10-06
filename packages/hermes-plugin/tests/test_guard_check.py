"""Shell-level tests for scripts/retrace-guard-check.sh, the fail-closed pre_tool_call hook (docs/design/hermes-seat.md §4.2).

Each case runs the script with a synthetic payload on stdin and a scratch HERMES_HOME, then applies the decision Hermes
7b362884 takes for a pre_tool_call shell hook with fail_closed: true (agent/shell_hooks.py _evaluate_result, lines 406-437):
exit 2 -> block; a block directive on stdout -> block; a non-zero exit with no directive -> block; stdout that is not a JSON
object -> block; otherwise allow. Cases a-i are the coordinator's measurement cases (measure-guard-check.sh, PR 186 round 2);
the others add a passing verdict under the conditions that used to fail open, and the two hijack paths -I closes."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CHECK = ROOT / "scripts" / "retrace-guard-check.sh"
BASH = shutil.which("bash")
PAYLOAD = {"session_id": "S1", "tool_name": "terminal", "extra": {"api_request_id": "R1"}}
OK_R1 = b'{"event":"request","api_request_id":"R1","verdict":"ok"}\n'


def hermes_decision(rc, out):
    out = out.strip()
    directive, nonjson = None, False
    if out:
        try:
            d = json.loads(out)
            directive = d if isinstance(d, dict) else None
            nonjson = not isinstance(d, dict)
        except Exception:
            nonjson = True
    blocks = bool(directive) and (directive.get("action") == "block" or directive.get("decision") == "block")
    if rc == 2 or blocks or (directive is None and rc != 0) or (out and nonjson):
        return "BLOCK"
    return "ALLOW"


def big_payload(n=140_000):
    return {"session_id": "S1", "tool_name": "write_file", "tool_input": {"path": "x", "content": "A" * n},
            "extra": {"api_request_id": "R1"}}


class GuardCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.home = self.base / "home"
        (self.home / "run" / "guard").mkdir(parents=True)
        self.verdicts = self.home / "run" / "guard" / "S1.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def run_check(self, payload, verdict=None, no_python=False, cwd=None, extra_env=None):
        if verdict is not None:
            self.verdicts.write_bytes(verdict)
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        if no_python:
            b = self.base / "bin"
            b.mkdir()
            os.symlink(BASH, b / "bash")
            env, cmd = {"PATH": str(b), "HERMES_HOME": str(self.home)}, [str(b / "bash"), str(CHECK)]
        else:
            env, cmd = {"PATH": os.environ["PATH"], "HERMES_HOME": str(self.home)}, [BASH, str(CHECK)]
        env.update(extra_env or {})
        r = subprocess.run(cmd, input=data, capture_output=True, env=env, timeout=30, cwd=cwd)
        out = r.stdout.decode("utf-8", "replace")
        return r.returncode, out, hermes_decision(r.returncode, out)

    def assertBlocks(self, result):
        rc, out, decision = result
        self.assertEqual(decision, "BLOCK", (rc, out))
        self.assertEqual(rc, 2, (rc, out))
        self.assertEqual(json.loads(out).get("action"), "block", out)

    def assertAllows(self, result):
        rc, out, decision = result
        self.assertEqual((rc, out.strip(), decision), (0, "", "ALLOW"))

    # the coordinator's measurement cases
    def test_a_ok_verdict_allows(self):
        self.assertAllows(self.run_check(PAYLOAD, OK_R1))

    def test_b_no_verdict_file_blocks(self):
        self.assertBlocks(self.run_check(PAYLOAD))

    def test_c_failing_verdict_blocks(self):
        self.assertBlocks(self.run_check(PAYLOAD, b'{"event":"request","api_request_id":"R1","verdict":"blocked"}\n'))
        self.assertBlocks(self.run_check(PAYLOAD, b'{"event":"request","api_request_id":"R1","verdict":"failed"}\n'))

    def test_d_non_object_line_blocks(self):
        self.assertBlocks(self.run_check(PAYLOAD, b'1\n{"event":"request","api_request_id":"R9","verdict":"ok"}\n'))

    def test_e_non_utf8_verdict_file_blocks(self):
        self.assertBlocks(self.run_check(PAYLOAD, b"\xff\xfe\n"))

    def test_f_extra_not_an_object_blocks(self):
        self.assertBlocks(self.run_check({"session_id": "S1", "extra": "x"},
                                         b'{"event":"request","api_request_id":"R9","verdict":"ok"}\n'))

    def test_g_140kb_payload_without_verdict_blocks(self):
        self.assertBlocks(self.run_check(big_payload()))

    def test_h_1kb_payload_without_verdict_blocks(self):
        self.assertBlocks(self.run_check(big_payload(1_000)))

    def test_i_no_python3_blocks(self):
        self.assertBlocks(self.run_check(PAYLOAD, no_python=True))

    # a passing verdict under the conditions that used to fail open, and the rest of the contract
    def test_ok_verdict_with_140kb_payload_allows(self):
        self.assertAllows(self.run_check(big_payload(), OK_R1))

    def test_ok_verdict_without_python3_still_blocks(self):
        self.assertBlocks(self.run_check(PAYLOAD, OK_R1, no_python=True))

    def test_corrupt_line_beside_an_ok_verdict_blocks(self):
        self.assertBlocks(self.run_check(PAYLOAD, b"1\n" + OK_R1))

    def test_ok_for_another_request_blocks(self):
        self.assertBlocks(self.run_check(PAYLOAD, b'{"event":"request","api_request_id":"R0","verdict":"ok"}\n'))

    def test_latest_verdict_for_the_request_wins(self):
        self.assertBlocks(self.run_check(PAYLOAD, OK_R1 + b'{"event":"request","api_request_id":"R1","verdict":"failed"}\n'))

    def test_aux_verdict_does_not_authorize(self):
        self.assertBlocks(self.run_check(PAYLOAD, b'{"event":"aux_request","api_request_id":"R1","verdict":"ok"}\n'))

    def test_payload_not_json_blocks(self):
        self.assertBlocks(self.run_check(b"not json", OK_R1))

    def test_payload_not_an_object_blocks(self):
        self.assertBlocks(self.run_check(b"[]", OK_R1))

    def test_session_id_with_a_path_blocks(self):
        self.assertBlocks(self.run_check({"session_id": "../S1", "extra": {"api_request_id": "R1"}}, OK_R1))

    def test_module_in_working_directory_cannot_change_the_check(self):
        cwd = self.base / "cwd"
        cwd.mkdir()
        (cwd / "json.py").write_text("import os\nos._exit(0)\n")
        self.assertBlocks(self.run_check(PAYLOAD, cwd=str(cwd)))

    def test_pythonpath_cannot_change_the_check(self):
        lib = self.base / "lib"
        lib.mkdir()
        (lib / "json.py").write_text("import os\nos._exit(0)\n")
        self.assertBlocks(self.run_check(PAYLOAD, extra_env={"PYTHONPATH": str(lib), "PYTHONSTARTUP": str(lib / "json.py")}))


if __name__ == "__main__":
    unittest.main()
