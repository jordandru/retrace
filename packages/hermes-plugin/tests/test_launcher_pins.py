"""Tests for scripts/hermes-seat.sh steps 2b and 6 (docs/design/hermes-seat.md §6.3; PR 186 fix round 3).

The launcher refuses, before anything is installed, when the guard plugin, its shell-hook check or a seat-config template in the
working tree differs from HEAD or is not in HEAD; on a clean tree it installs HEAD's bytes into the profile. Each case builds a
throwaway git repository holding only the files the launcher reads, commits them with hooks disabled and no global git config (so
nothing reaches any ledger), and runs the launcher with a scratch HERMES_PROFILE_HOME and a stand-in primary checkout. No Hermes
install is present, so the launcher stops at step 8 ("no Hermes venv") and Hermes never starts."""
import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FILES = [".retrace.json", "docs/agent-rules.md", ".hermes.md", "hermes.retrace.yaml", "hermes.retrace.phases.yaml",
         "scripts/hermes-seat.sh", "scripts/retrace-guard-check.sh",
         "packages/hermes-plugin/retrace-guard/plugin.yaml", "packages/hermes-plugin/retrace-guard/__init__.py"]
PINNED = ["packages/hermes-plugin/retrace-guard/plugin.yaml", "packages/hermes-plugin/retrace-guard/__init__.py",
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

    def tearDown(self):
        self.tmp.cleanup()

    def env(self, **extra):
        e = {"PATH": os.environ["PATH"], "HOME": str(self.base / "home"), "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1"}
        e.update(extra)
        return e

    def git(self, *args):
        subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
                        *args], cwd=self.repo, env=self.env(), check=True, capture_output=True)

    def launch(self, name):
        profile = self.base / ("profile-" + name)
        r = subprocess.run(["bash", "scripts/hermes-seat.sh", "--phase", "scratch", "--model", "stub-model-1"], cwd=self.repo,
                           env=self.env(HERMES_PROFILE_HOME=str(profile), RETRACE_PRIMARY_CHECKOUT=str(self.primary)),
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


if __name__ == "__main__":
    unittest.main()
