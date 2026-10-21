"""Tests for scripts/hermes-seat.sh steps 2b and 6 (docs/design/hermes-seat.md §6.3; PR 186 fix round 3).

The launcher refuses, before anything is installed, when the guard plugin, its shell-hook check or a seat-config template in the
working tree differs from HEAD or is not in HEAD; on a clean tree it installs HEAD's bytes into the profile. Each case builds a
throwaway git repository holding only the files the launcher reads, commits them with hooks disabled and no global git config (so
nothing reaches any ledger), and runs the launcher with a scratch HERMES_PROFILE_HOME and a stand-in primary checkout. No Hermes
install is present, so the launcher stops at step 8 ("no Hermes venv") and Hermes never starts."""
import hashlib
import fcntl
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FILES = ["packages/hermes-plugin/runtime_adapter.py", "packages/hermes-plugin/runtime-contract.json", ".retrace.json", "docs/agent-rules.md", ".hermes.md", "hermes.retrace.yaml", "hermes.retrace.phases.yaml",
         "scripts/hermes-seat.sh", "scripts/retrace-guard-check.sh",
         "packages/hermes-plugin/retrace-guard/plugin.yaml", "packages/hermes-plugin/retrace-guard/__init__.py"]
PINNED = ["packages/hermes-plugin/runtime_adapter.py", "packages/hermes-plugin/runtime-contract.json", "scripts/hermes-seat.sh", "packages/hermes-plugin/retrace-guard/plugin.yaml", "packages/hermes-plugin/retrace-guard/__init__.py",
          "scripts/retrace-guard-check.sh", "hermes.retrace.yaml", "hermes.retrace.phases.yaml"]
INSTALLED = {"packages/hermes-plugin/retrace-guard/plugin.yaml": "plugins/retrace-guard/plugin.yaml",
             "packages/hermes-plugin/retrace-guard/__init__.py": "plugins/retrace-guard/__init__.py",
             "scripts/retrace-guard-check.sh": "bin/retrace-guard-check.sh"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


class LauncherPinTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        (self.base / "home").mkdir()
        self.repo = self.base / "repo"
        for f in FILES:
            dst = self.repo / f
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / f, dst)
        self.git("init", "-q")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "fixture")
        self.primary = self.base / "primary"
        (self.primary / "packages" / "mcp-server" / "dist").mkdir(parents=True)
        (self.primary / "packages" / "mcp-server" / "dist" / "index.js").write_text("// stand-in for the built MCP server\n")
        (self.primary / "package-lock.json").write_text("{}\n")

    def tearDown(self):
        self.tmp.cleanup()

    def env(self, **extra):
        e = {"PATH": os.environ["PATH"], "HOME": str(self.base / "home"), "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1"}
        e.update(extra)
        return e

    def git(self, *args):
        subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
                        *args], cwd=self.repo, env=self.env(), check=True, capture_output=True)

    def launch(self, name, args=(), extra_env=None):
        profile = self.base / ("profile-" + name)
        r = subprocess.run(["bash", "scripts/hermes-seat.sh", "--phase", "scratch", "--model", "stub-model-1", *args], cwd=self.repo,
                           env=self.env(HERMES_PROFILE_HOME=str(profile), RETRACE_PRIMARY_CHECKOUT=str(self.primary), **(extra_env or {})),
                           capture_output=True, text=True, timeout=60)
        return r, profile

    def installed_files(self, profile):
        return [p for p in profile.rglob("*") if p.is_file()] if profile.exists() else []

    def test_clean_tree_installs_head_bytes_and_stops_before_hermes(self):
        r, profile = self.launch("clean")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("pinned to HEAD:", r.stdout)
        self.assertIn("(profile copies = HEAD)", r.stdout)
        self.assertIn("FAILED: no Hermes venv", r.stdout)
        for src, dst in INSTALLED.items():
            self.assertEqual(sha((profile / dst).read_bytes()), sha((self.repo / src).read_bytes()), dst)
        self.assertTrue(os.access(profile / "bin" / "retrace-guard-check.sh", os.X_OK))

    def test_one_byte_edit_to_a_pinned_file_refuses_and_installs_nothing(self):
        for f in PINNED:
            with self.subTest(file=f):
                path = self.repo / f
                original = path.read_bytes()
                path.write_bytes(original + b" ")
                try:
                    r, profile = self.launch(f.replace("/", "_"))
                    self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
                    self.assertIn("FAILED: " + f + " differs from HEAD", r.stdout)
                    self.assertEqual(self.installed_files(profile), [])
                finally:
                    path.write_bytes(original)

    def test_pinned_file_missing_from_head_refuses(self):
        self.git("rm", "-q", "--cached", "packages/hermes-plugin/retrace-guard/plugin.yaml")
        self.git("commit", "-q", "-m", "drop from HEAD")
        r, profile = self.launch("not-in-head")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("FAILED: packages/hermes-plugin/retrace-guard/plugin.yaml is not in HEAD", r.stdout)
        self.assertEqual(self.installed_files(profile), [])

    def test_live_refuses_probe_switches_before_writing_profile(self):
        probes = [("--stub-base-url", "http://127.0.0.1:4000"), ("--stub-provider", "custom"),
                  ("--test-drop-shell-hook",), ("--chat-args", "--yolo")]
        for i, args in enumerate(probes):
            r, profile = self.launch("live" + str(i), ["--phase", "live", *args])
            self.assertIn("probe options are forbidden", r.stdout)
            self.assertEqual(self.installed_files(profile), [])
        for name in ("RETRACE_GUARD_TEST", "RETRACE_GUARD_TEST_LOAD"):
            r, profile = self.launch(name, ["--phase", "live"], {name: ""})
            self.assertIn("test environment is forbidden", r.stdout)
            self.assertEqual(self.installed_files(profile), [])

    def test_argument_and_yaml_injection_refused_before_profile_writes(self):
        cases = [("--chat-args", "--model foreign"), ("--chat-args", "--provider other"),
                 ("--chat-args", "--yolo"), ("--chat-args", "--toolsets all"),
                 ("--model", 'x"\napprovals:\n  mode: yolo'),
                 ("--stub-base-url", "https://example.org"), ("--model",)]
        for i, args in enumerate(cases):
            r, profile = self.launch("inject" + str(i), args)
            self.assertNotEqual(r.returncode, 0, args)
            self.assertEqual(self.installed_files(profile), [], args)

    def test_scratch_query_compatibility_preserves_shell_metacharacters_as_data(self):
        r, _ = self.launch("quoted-query", ["--chat-args", "--cli -q 'literal $(touch /not-executed) *'"])
        self.assertIn("FAILED: no Hermes venv", r.stdout)

    def test_wrong_mcp_hash_refuses(self):
        r, _ = self.launch("hash", ["--mcp-build-sha256", "0" * 64])
        self.assertIn("MCP build does not match", r.stdout)

    def fake_runtime(self, behavior):
        """Only a launcher subprocess fixture; does not qualify upstream Hermes."""
        src = self.base / "fake-src"; (src / ".venv/bin").mkdir(parents=True)
        (src / ".venv/bin/hermes").write_text("#!/bin/sh\nexit 0\n")
        (src / ".venv/bin/hermes").chmod(0o755)
        (src / "behavior").write_text(behavior)
        python = src / ".venv/bin/python"
        python.write_text('''#!/usr/bin/python3
import json,os,sys
from pathlib import Path
root=Path(__file__).resolve().parents[2]; behavior=(root/'behavior').read_text()
args=sys.argv[sys.argv.index('--')+1:]
if args==['plugins','list']:
    print('retrace-guard')
    sys.exit(7 if behavior=='plugin-error' else 0)
if args==['mcp','test','retrace']:
    print('✓ Connected')
    if behavior=='migration':
        with open(Path(os.environ['HERMES_HOME'])/'config.yaml','a') as f: f.write('# changed\\n')
    sys.exit(7 if behavior=='mcp-error' else 0)
(root/'chat.json').write_text(json.dumps(args))
''')
        python.chmod(0o755)
        bins = self.base / "fake-bin"; bins.mkdir()
        git = bins / "git"
        real_git = shutil.which("git")
        git.write_text('#!/bin/sh\nif [ "$1" = -C ]; then echo 5b147ab036d6d19131bff8d20701b5001eab844a; else exec ' + real_git + ' "$@"; fi\n')
        git.chmod(0o755)
        return src, {"HERMES_SRC": str(src), "PATH": str(bins) + os.pathsep + os.environ["PATH"]}

    def test_launch_preserves_query_and_refuses_smoke_errors_or_config_migration(self):
        src, env = self.fake_runtime("ok")
        query = "literal $(touch ignored) * two words"
        r, _ = self.launch("runtime", ["--cli", "--query", query], env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(json.loads((src / "chat.json").read_text()), ["chat", "--cli", "-q=" + query])
        for behavior, message in [("plugin-error", "plugin discovery failed"), ("mcp-error", "MCP test returned an error"),
                                  ("migration", "changed the rendered configuration")]:
            (src / "behavior").write_text(behavior); (src / "chat.json").unlink(missing_ok=True)
            r, _ = self.launch(behavior, extra_env=env)
            self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn(message, r.stdout)
            self.assertFalse((src / "chat.json").exists())

    def test_profile_has_only_one_writer(self):
        lock = self.base / "profile-busy/run/seat.lock"; lock.parent.mkdir(parents=True)
        with lock.open("w") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            r, _ = self.launch("busy")
        self.assertIn("another launcher/session owns this profile", r.stdout)


if __name__ == "__main__":
    unittest.main()
