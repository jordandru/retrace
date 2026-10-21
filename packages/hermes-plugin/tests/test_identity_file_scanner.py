"""The committed .hermes.md must pass Hermes's own context-file injection scanner at the pinned commit
(docs/design/hermes-seat.md §5; Gate 0 (c) showed a blocked file removes the identity silently).
Needs HERMES_SRC pointing at a checkout of NousResearch/hermes-agent at HERMES_COMMIT; skipped otherwise."""
import hashlib, json, os, sys, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


class IdentityFileScannerTest(unittest.TestCase):
    def test_hermes_md_passes_context_scope(self):
        src = os.environ.get("HERMES_SRC")
        if not src:
            self.skipTest("HERMES_SRC not set")
        contract = json.loads((ROOT / "packages/hermes-plugin/runtime-contract.json").read_text())
        self.assertEqual(hashlib.sha256((Path(src) / "tools/threat_patterns.py").read_bytes()).hexdigest(),
                         contract["files"]["tools/threat_patterns.py"], "scanner differs from the selected runtime contract")
        sys.path.insert(0, src)
        from tools.threat_patterns import scan_for_threats as _scan_for_threats  # type: ignore
        content = (ROOT / ".hermes.md").read_text(encoding="utf-8")
        findings = _scan_for_threats(content, scope="context")
        self.assertEqual(findings, [], f".hermes.md would be BLOCKED by Hermes: {findings}")
        self.assertIn("RETRACE-SEAT: hermes", content); self.assertIn("Retrace-Actor: hermes", content)
