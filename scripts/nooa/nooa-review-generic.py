"""NOOA review of a Retrace pull request, launched by the claude-code coordinator seat (generic form of the earlier per-PR wrappers: every per-PR and per-round fact comes from the launcher environment, never from this file).

Why this wrapper exists (do not delete it and go back to the stock runner):

1. `review_agent.py`'s built-in prompt is specific to the attribution DESIGN note — it demands an
   "Answers to §10 / Q1-Q4" section and a verdict phrased "ready to build as v2". PR 73 is a
   claims-versus-evidence review of a public web page. The stock prompt would produce an incoherent
   review. Codex hit the same wall on PR 71 on 2026-09-17 and solved it the same way.
2. The stock `seal_review` seals `action="other"`, `action_detail="design-review"`, which is an
   artifact record and NOT a verdict of record under agent-rules 11. A verdict must be `approved` or
   `rejected`, tagged `review`, with every reviewed file as `used`, citing the coordinator's routing
   event in `method.params.routing_event_id` and naming the reviewed head.

This wrapper fixes both and changes nothing else. The model is pinned by the caller and NOT
defaulted here: `review_agent.py:30` defaults NOOA_MODEL to an Anthropic model, which would make
this Anthropic reviewing Anthropic under an NVIDIA badge (docs/team-roles.md rule 3).

v2 (2026-10-11, docs/design/dispatch-protocol.md §2, the verdict shape): the review ENDS with three bare lines,
`FINDINGS: high=<n> medium=<n> low=<n>`, `BLOCKING: yes|no`, `VERDICT: …`, and the seal records `findings` and
`blocking` in method.params. Measured cause: 17 of 55 verdicts on six PRs that week carried their counts only in
prose, and one all-Low "needs changes" said of itself that it did not block.

v2.1 (PR 225 fix round 1, Codex evt_ecd4c216): the rules are the ones packages/core/src/review-verdict.ts applies
to every sealed verdict (team-roles rule 8) — `blocking` is DERIVED, `high + medium > 0`, never declared: a BLOCKING line
that disagrees with the counts is refused, an `approved` with a High or Medium is refused, a `needs changes` with only
Lows is sealed as a non-blocking rejection, and there are no REASON overrides (H1). The parser reads ONE anchored block
at the very end of the review and refuses a second FINDINGS/BLOCKING/VERDICT line anywhere and any text after the block,
so the sealed action is the review's final verdict and no other (H2). NOOA_MODEL must EQUAL the pinned witness model
(M2). The class and the review surface come from the launcher; nothing about the class or the gate is hard-coded here
(M3). Every launcher value is shape-checked before the run (H3).

v2.2 (PR 225 fix round 2, Codex evt_d9d42935): the launcher values are TRUSTED INPUT from the coordinator's launch, taken as
given. scripts/nooa/build-packet.mjs authenticates the routing event raw on the laptop when it writes a launcher, but the
launcher is a plain shell file, push-and-launch.sh transfers whatever bytes it is handed, and this wrapper cannot tell a
builder-written launcher from an edited one: it checks shapes, re-verifies nothing against the routing event (the host's MCP
exposes no raw event read), and the sealed verdict says exactly that (`launcher_trust`), claiming no authentication (H1). The
VERDICT line is parsed whole against an explicit grammar, so "approved? no — needs changes" is refused, not mapped (H2). The
three sealed lines must start at column zero; fence state is tracked, so a block after an unclosed fence is inside it and
refused; a keyword line in blockquote, list, heading, bold, inline-code or indented form anywhere in the review is refused
(H3). A `needs changes` with only Lows is allowed and seals a non-blocking rejection; the prompt no longer says otherwise
(M1).

v2.3 (PR 225 fix round 3, Codex evt_501bdc45): `launcher_trust` says only what this code does — the values were taken from the
launcher as given and only their shape and the model pin were checked; whether a launch record exists in the ledger, and what
it binds, is the coordinator's act outside this code (push-and-launch.sh prints hashes and a pid and writes nothing) (H1). An
HTML comment (`<!--` … `-->`) is tracked like a fence, so a keyword line inside one, or a terminal block after an unclosed
comment, is refused: a human reader would not see it (H2). A VERDICT delimiter must be followed by text; `approved —` alone is
refused (L1). Self-test: `python3 nooa-review-generic.py --selftest` (no host modules needed).
The canonical copy lives in the repository at scripts/nooa/nooa-review-generic.py; push-and-launch.sh
copies the one in its own directory, so copy the repository file over it after a merge.
"""
import asyncio
import os
import re
import sys
from hashlib import sha256
from pathlib import Path

REQUIRED_MODEL = "nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b"

# The one block the seal reads: the last three non-blank lines of the review, each starting at column zero, in this order,
# nothing after them but whitespace.
_BLOCK_RE = re.compile(
    r"^FINDINGS:[ \t]*high[ \t]*=[ \t]*(\d+)[ \t]+medium[ \t]*=[ \t]*(\d+)[ \t]+low[ \t]*=[ \t]*(\d+)[ \t]*\n"
    r"BLOCKING:[ \t]*(yes|no)[ \t]*\n"
    r"VERDICT:[ \t]*([^\n]*?)[ \t]*\n?[ \t\n]*\Z",
    re.M,
)
# The whole VERDICT line after the keyword: the action word, then nothing, or one delimiter and the rest of the line (Codex,
# PR 225 r2, H2). "approved? no — needs changes" and "approvedness is not approval" match neither alternative: refused, not mapped.
_VERDICT_RE = re.compile(r"(?i)^(approved|needs changes)(?:[ \t]*[—–:\-][ \t]*(\S.*))?$")  # a delimiter needs text after it (L1)
# Markdown dress a keyword line can wear: indentation, blockquote, list marker, heading, bold, inline code (H3). A keyword
# line behind any of these, anywhere in the review, is refused: the three sealed lines are bare, at column zero.
_MD_PREFIX_RE = re.compile(r"^(?:[ \t]+|>[ \t]*|[-*+][ \t]+|\d{1,3}[.)][ \t]+|#{1,6}[ \t]*|\*\*|__|`+)+")
_KEYWORD_RE = re.compile(r"(?i)^(FINDINGS|BLOCKING|VERDICT|REASON)\**[ \t]*:")
_FENCE_RE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})")
# An HTML comment hides text from a human reader of rendered Markdown while the bytes stay in the file (Codex, PR 225 r3, H2).
_COMMENT_OPEN, _COMMENT_CLOSE = "<!--", "-->"


def keyword_lines(text: str) -> list:
    """Every line of the review that starts, after optional Markdown dress, with one of the four keywords and a colon, as
    (line number, KEYWORD, dress, hidden) where hidden is None, "fence" or "comment". Fence state is tracked line by line (a
    fence closes only on a line of the same character at least as long, with nothing after it) and HTML-comment state the
    same way (`<!--` opens, `-->` closes), so a block after an unclosed fence or comment is inside it (r2 H3, r3 H2)."""
    found = []
    fence = None
    comment = False
    for i, line in enumerate(text.split("\n")):
        if comment:
            # Inside a comment: a keyword line here is hidden; the line that closes the comment is consumed whole.
            km = _KEYWORD_RE.match(line.lstrip())
            if km:
                found.append((i + 1, km.group(1).upper(), "", "comment"))
            if _COMMENT_CLOSE in line:
                comment = False
            continue
        opens = line.rfind(_COMMENT_OPEN)
        if opens != -1 and _COMMENT_CLOSE not in line[opens:]:
            comment = True
            line = line[:opens]  # only the visible part of this line can be a keyword line
        fm = _FENCE_RE.match(line)
        if fm:
            mark = fm.group(1)
            if fence is None:
                fence = mark
            elif mark[0] == fence[0] and len(mark) >= len(fence) and not line[fm.end():].strip():
                fence = None
            continue
        pm = _MD_PREFIX_RE.match(line)
        rest = line[pm.end():] if pm else line
        km = _KEYWORD_RE.match(rest)
        if km:
            found.append((i + 1, km.group(1).upper(), pm.group(0) if pm else "", "fence" if fence is not None else None))
    return found


def parse_verdict_block(review_markdown: str) -> dict:
    """The sealed shape of a verdict, from the review's own final block. Raises ValueError on anything missing, duplicated,
    dressed, fenced, trailing or inconsistent, so a malformed review seals nothing (fail closed) and the error names what to
    fix. Same derivation and refusals as packages/core/src/review-verdict.ts: blocking = high + medium > 0."""
    text = review_markdown.replace("\r\n", "\n")
    found = keyword_lines(text)
    for lineno, kw, dress, hidden in found:
        if hidden == "fence":
            raise ValueError(f"line {lineno}: a {kw}: line is inside a code fence (opened earlier and, if never closed, running to "
                             "the end of the review); the three sealed lines are bare text outside any fence")
        if hidden == "comment":
            raise ValueError(f"line {lineno}: a {kw}: line is inside an HTML comment (opened earlier and, if never closed, running to "
                             "the end of the review); a human reader would not see it, so nothing is sealed")
        if dress:
            raise ValueError(f"line {lineno}: a {kw}: line is in a Markdown form ({dress!r}: indentation, blockquote, list, heading, "
                             "bold or code); the three sealed lines start at column zero, bare, exactly once each")
        if kw == "REASON":
            raise ValueError(f"line {lineno}: REASON: lines are not accepted: BLOCKING is derived from the counts, never declared "
                             "(team-roles rule 8)")
    for name in ("FINDINGS", "BLOCKING", "VERDICT"):
        n = sum(1 for f in found if f[1] == name)
        if n != 1:
            raise ValueError(f"the review has {n} lines starting with {name}:; exactly one is allowed, in the final block")
    m = _BLOCK_RE.search(text)
    if not m:
        raise ValueError("the review must END with exactly three bare lines at column zero, in order, nothing after them: "
                         "'FINDINGS: high=<n> medium=<n> low=<n>', 'BLOCKING: yes' or 'BLOCKING: no', "
                         "'VERDICT: approved …' or 'VERDICT: needs changes …'")
    high, medium, lo = int(m.group(1)), int(m.group(2)), int(m.group(3))
    declared = m.group(4).lower() == "yes"
    verdict_line = m.group(5).strip()
    if not verdict_line:
        raise ValueError("VERDICT: line is empty")
    vm = _VERDICT_RE.fullmatch(verdict_line)
    if not vm:
        raise ValueError("VERDICT: must read 'approved' or 'needs changes', alone or followed by one of — – : - and at least one "
                         "word; a bare delimiter is refused; got: " + verdict_line[:140])
    action = "approved" if vm.group(1).lower() == "approved" else "rejected"
    verdict = verdict_line[:140]
    blocking = high + medium > 0
    if declared != blocking:
        raise ValueError(f"BLOCKING: {'yes' if declared else 'no'} disagrees with FINDINGS high={high} medium={medium} low={lo}: "
                         "BLOCKING is yes exactly when high + medium > 0 (team-roles rule 8)")
    if action == "approved" and blocking:
        raise ValueError("VERDICT: approved cannot carry a High or Medium finding; write 'needs changes', or reclassify the finding")
    return {"action": action, "verdict": verdict,
            "params": {"findings": {"high": high, "medium": medium, "low": lo}, "blocking": blocking}}


def _selftest() -> None:
    base = "## Findings\nNo findings\n\n## What is sound\n- ok\n\n## Limits of this review\nread all\n\n"
    cases = 0
    ok = parse_verdict_block(base + "FINDINGS: high=0 medium=0 low=2\nBLOCKING: no\nVERDICT: approved — fine")
    assert ok == {"action": "approved", "verdict": "approved — fine", "params": {"findings": {"high": 0, "medium": 0, "low": 2}, "blocking": False}}, ok
    cases += 1
    rej = parse_verdict_block(base + "FINDINGS: high=0 medium=1 low=0\nBLOCKING: yes\nVERDICT: needs changes: M1\n")
    assert rej["action"] == "rejected" and rej["params"] == {"findings": {"high": 0, "medium": 1, "low": 0}, "blocking": True}, rej
    cases += 1
    # PR 222 parity (M1): a Low-only rejection is allowed and is NOT blocking.
    lr = parse_verdict_block(base + "FINDINGS: high=0 medium=0 low=1\nBLOCKING: no\nVERDICT: needs changes: L1 wording")
    assert lr["action"] == "rejected" and lr["params"]["blocking"] is False, lr
    cases += 1
    # Trailing blank lines are tolerated; a bare action word is a whole verdict; the word is case-insensitive; '-' is a delimiter.
    bare = parse_verdict_block(base + "FINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT: approved\n\n\n")
    assert bare["action"] == "approved" and bare["verdict"] == "approved", bare
    cases += 1
    hy = parse_verdict_block(base + "FINDINGS: high=1 medium=0 low=0\nBLOCKING: yes\nVERDICT: Needs changes - H1")
    assert hy["action"] == "rejected" and hy["params"]["blocking"] is True, hy
    cases += 1
    # A keyword mid-line, and a closed fence holding ordinary text, are not keyword lines.
    prose = parse_verdict_block(base + "The final VERDICT: line is below.\n```\nsome diff\n```\n\nFINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT: approved — fine")
    assert prose["action"] == "approved", prose
    cases += 1
    # r3 H2: a CLOSED HTML comment before the block, on one line or across lines, hides nothing that is sealed.
    closed = parse_verdict_block(base + "<!-- reviewer note -->\n\nFINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT: approved — fine")
    assert closed["action"] == "approved", closed
    cases += 1
    spanning = parse_verdict_block(base + "<!-- a note\nover two lines -->\n\nFINDINGS: high=0 medium=0 low=1\nBLOCKING: no\nVERDICT: approved — fine")
    assert spanning["params"]["findings"]["low"] == 1, spanning
    cases += 1
    bad = [
        # H2 (r1): an earlier VERDICT line with a terminal needs-changes block is refused, never sealed as approved.
        base + "VERDICT: approved — early\n\nmore text\n\nFINDINGS: high=1 medium=0 low=0\nBLOCKING: yes\nVERDICT: needs changes: H1",
        # Text after the block.
        base + "FINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT: approved — fine\n\nThanks for reading.",
        # The block inside a closed code fence.
        base + "```\nFINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT: approved — fine\n```\n",
        # A second FINDINGS line.
        base + "FINDINGS: high=0 medium=0 low=0\n\nFINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT: approved — fine",
        # Wrong order.
        base + "BLOCKING: no\nFINDINGS: high=0 medium=0 low=0\nVERDICT: approved — fine",
        # Bold and heading forms are not the bare lines the contract asks for.
        base + "FINDINGS: high=0 medium=0 low=0\nBLOCKING: no\n**VERDICT:** approved — bold",
        base + "FINDINGS: high=0 medium=0 low=0\nBLOCKING: no\n## VERDICT: approved — heading",
        # H1 (r1): an approval with a High, however the BLOCKING line reads.
        base + "FINDINGS: high=1 medium=0 low=0\nBLOCKING: no\nVERDICT: approved — high accepted",
        base + "FINDINGS: high=0 medium=1 low=0\nBLOCKING: yes\nVERDICT: approved — medium accepted",
        # A Low-only block that claims to block.
        base + "FINDINGS: high=0 medium=0 low=3\nBLOCKING: yes\nVERDICT: needs changes: lows only",
        # A Medium that claims not to block.
        base + "FINDINGS: high=0 medium=1 low=0\nBLOCKING: no\nVERDICT: needs changes: not blocking",
        # REASON overrides are gone.
        base + "FINDINGS: high=0 medium=0 low=1\nBLOCKING: yes\nREASON: head differs\nVERDICT: needs changes: head",
        base + "REASON: the Medium is accepted\nFINDINGS: high=0 medium=1 low=0\nBLOCKING: no\nVERDICT: approved — with one Medium",
        # Missing lines and other verdict words.
        base + "VERDICT: approved — no counts",
        base + "FINDINGS: high=0 medium=0 low=0\nVERDICT: approved — no blocking line",
        base + "FINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT: ready to build",
        base + "FINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT:",
        # H2 (r2, Codex's probes): prefix matching no longer maps these to approved.
        base + "FINDINGS: high=1 medium=0 low=0\nBLOCKING: yes\nVERDICT: approved? no — needs changes",
        base + "FINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT: approvedness is not approval",
        # H2 (r2): a comma is not one of the documented delimiters.
        base + "FINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT: approved, with notes",
        # H3 (r2, Codex's probes): an indented terminal block (four spaces, then a tab).
        base + "    FINDINGS: high=0 medium=0 low=0\n    BLOCKING: no\n    VERDICT: approved — indented",
        base + "\tFINDINGS: high=0 medium=0 low=0\n\tBLOCKING: no\n\tVERDICT: approved — tabbed",
        # H3 (r2): a terminal block after an unclosed fence is inside it.
        base + "```diff\n+ a changed line\n\nFINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT: approved — fenced",
        # H3 (r2): an earlier blockquoted VERDICT: or REASON: line.
        base + "> VERDICT: approved — quoted\n\nFINDINGS: high=1 medium=0 low=0\nBLOCKING: yes\nVERDICT: needs changes: H1",
        base + "> REASON: quoted override\n\nFINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT: approved — fine",
        # H3 (r2): list, numbered-list and inline-code forms anywhere in the review.
        base + "- VERDICT: approved — listed\n\nFINDINGS: high=1 medium=0 low=0\nBLOCKING: yes\nVERDICT: needs changes: H1",
        base + "1. BLOCKING: no\n\nFINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT: approved — fine",
        base + "`VERDICT: approved`\n\nFINDINGS: high=1 medium=0 low=0\nBLOCKING: yes\nVERDICT: needs changes: H1",
        # H3 (r2): a keyword line inside a closed fence earlier in the review is refused too, so quoted text never competes.
        base + "```\nVERDICT: approved — quoted contract\n```\n\nFINDINGS: high=1 medium=0 low=0\nBLOCKING: yes\nVERDICT: needs changes: H1",
        # H2 (r3, Codex's probe): an unclosed HTML comment before the block hides it from a human reader.
        base + "<!-- hidden from the reader\n\nFINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT: approved — fine",
        # H2 (r3): a keyword line inside a closed comment, and a comment opened mid-line and never closed.
        base + "<!--\nVERDICT: approved — commented\n-->\n\nFINDINGS: high=1 medium=0 low=0\nBLOCKING: yes\nVERDICT: needs changes: H1",
        base + "Some prose <!-- starts here\nFINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT: approved — fine",
        # L1 (r3): a delimiter with nothing after it.
        base + "FINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT: approved — ",
        base + "FINDINGS: high=1 medium=0 low=0\nBLOCKING: yes\nVERDICT: needs changes:",
    ]
    for text in bad:
        try:
            parse_verdict_block(text)
        except ValueError:
            cases += 1
            continue
        raise AssertionError("accepted a malformed verdict block:\n" + text)
    print(f"nooa-review-generic selftest: {cases} cases OK")


if "--selftest" in sys.argv[1:]:
    _selftest()
    sys.exit(0)

def _env(name: str, pattern: str | None = None, choices: tuple | None = None) -> str:
    """A launcher value, present and well-formed, or the run is refused before anything is read or sealed."""
    v = os.environ.get(name, "")
    if not v:
        sys.exit(f"REFUSED: {name} is not set; every per-run value comes from the launcher scripts/nooa/build-packet.mjs wrote")
    if pattern and not re.fullmatch(pattern, v):
        sys.exit(f"REFUSED: {name}={v!r} does not match {pattern}")
    if choices and v not in choices:
        sys.exit(f"REFUSED: {name}={v!r} is not one of {choices}")
    return v


# Every value below is taken from the launcher AS GIVEN. scripts/nooa/build-packet.mjs writes a launcher only after reading the
# routing event raw and refusing to build unless that event authorized the build, but the launcher is a plain shell file,
# push-and-launch.sh transfers whatever bytes it is handed (it prints hashes and a pid and writes nothing to the ledger), and
# nothing on this host proves that these bytes are the builder's. So this wrapper checks each value's SHAPE and the model pin and
# nothing more: it re-verifies nothing against the routing event (the host MCP exposes no raw event read), cannot tell a
# builder-written launcher from an edited one, and the sealed verdict says exactly that (LAUNCHER_TRUST). Whether a record of the
# launch exists in the ledger, and what it binds, is the coordinator's act outside this code (Codex, PR 225 r3, H1).
PR = _env("NOOA_PR", r"\d+")
TITLE = _env("NOOA_PR_TITLE")
JUDGEMENT = _env("NOOA_JUDGEMENT")
TAGS = [t for t in os.environ.get("NOOA_TAGS", "").split(",") if t]
ROUTING_EVENT = _env("NOOA_ROUTING_EVENT", r"evt_[0-9a-f]{32}")
REVIEWED_HEAD = _env("NOOA_REVIEWED_HEAD", r"[0-9a-f]{40}")
REVIEWED_FILES = [p for p in _env("NOOA_FILES").split(",") if p]
ROUND = _env("NOOA_ROUND", r"r\d+[a-z]?")
RUBRIC = _env("NOOA_RUBRIC", choices=("low", "medium", "high", "xhigh", "max"))
SCOPE = _env("NOOA_SCOPE")
CLASS = _env("NOOA_CLASS", choices=("a", "b", "c", "S"))
SURFACE = _env("NOOA_SURFACE")
PR_URL = f"https://github.com/jordandru/retrace/pull/{PR}"
LAUNCHER_TRUST = ("values taken from the launcher as given; this wrapper verified only their shape and the model pin, re-verified none "
                  "of them against the routing event (the host MCP exposes no raw event read), and cannot tell a builder-written launcher "
                  "from an edited one; whether a record of the launch exists in the ledger, and what it binds, is the coordinator's act "
                  "outside this code")

if os.environ.get("NOOA_MODEL", "") != REQUIRED_MODEL:
    sys.exit(f"REFUSED: NOOA_MODEL must equal {REQUIRED_MODEL!r}, the witness model pinned in the routing event and in "
             f"scripts/nooa/build-packet.mjs; got {os.environ.get('NOOA_MODEL', '<unset>')!r}")

# Only once every launcher value has passed its shape check does the wrapper touch the host.
NOOA_HOME = Path.home() / "nooa-retrace"
sys.path.insert(0, str(NOOA_HOME))
os.chdir(NOOA_HOME)

import review_agent as ra  # noqa: E402  (module-level code reads NOOA_* env)


class PRReviewer(ra.RetraceDesignReviewer):
    async def seal_review(self, caused_by: str, review_markdown: str) -> str:
        """Persist the exact review and seal ONE signed verdict event. Call exactly once."""
        if not ra._EVENT_ID.fullmatch(caused_by):
            raise ValueError("caused_by must be a bare Retrace event id")
        if len(review_markdown.strip()) < 200:
            raise ValueError("review is too short to be a review")

        shape = parse_verdict_block(review_markdown)  # raises on a missing, duplicated, trailing or inconsistent final block
        action, verdict = shape["action"], shape["verdict"]

        ra.ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
        path = (ra.ARTIFACTS_DIR / f"review-pr{PR}-{ra.RUN_ID}.md").resolve()
        header = (f"# NOOA review — Retrace PR {PR} ({ra.REPO_REL}) @ {REVIEWED_HEAD[:12]}\n\n"
                  f"run: {ra.RUN_ID}\nreviewer: nooa (model {ra.MODEL})\n"
                  f"packet sha256: {ra.DESIGN_SHA}\nrouting event: {ROUTING_EVENT}\n"
                  f"reviewed head: {REVIEWED_HEAD}\nclass: {CLASS}\ncaused_by: {caused_by}\n\n---\n\n")
        body = (header + review_markdown.strip() + "\n").encode("utf-8")
        with path.open("xb") as fh:
            fh.write(body)
        digest = sha256(body).hexdigest()

        logged = await self.retrace.retrace_log(
            action=action,
            action_detail="review",
            caused_by=caused_by,
            idempotency_key=f"nooa:{ra.RUN_ID}:pr{PR}-verdict",
            artifacts=[
                *[{"id": f"repo:jordandru/retrace#{p}", "kind": "file",
                   "label": f"{p} @ {REVIEWED_HEAD[:12]} — reviewed", "role": "used"} for p in REVIEWED_FILES],
                {"id": PR_URL, "kind": "pull_request", "label": f"PR {PR} — {TITLE}, {ROUND}", "role": "used"},
                {"id": "event:" + ROUTING_EVENT, "kind": "event", "label": "routing event", "role": "used"},
                {"id": f"file:{ra.REVIEW_FILE}", "kind": "document",
                 "label": f"review packet sha256 {ra.DESIGN_SHA[:12]}", "role": "used"},
                {"id": f"file:{path}", "kind": "review", "label": path.name, "role": "generated"},
            ],
            change={"after_hash": digest, "summary": "Exact review text as written by the reviewer, unedited"},
            method={"tool": "review", "automated": True, "params": {
                **shape["params"],
                "routing_event_id": ROUTING_EVENT,
                "reviewed_head": REVIEWED_HEAD,
                "class": CLASS,
                "review_surface": SURFACE,
                "launcher_trust": LAUNCHER_TRUST,
                "reasoning_effort": f"not_applicable — {ra.MODEL} exposes no effort control (models.json supports_effort=false); routed rubric effort was {RUBRIC}",
                "review_scope": f"packet-scoped and advisory: the reviewer was INSTRUCTED to read the whole packet ({len(ra.DESIGN_TEXT)} characters: {SCOPE}) in slices of at most 20,000 characters, because the harness cuts printed output at 50,000; what it actually read is stated in its own Limits section; it executed nothing",
                "packet_sha256": ra.DESIGN_SHA,
            }},
            tags=["review", f"pr-{PR}", *TAGS, "gate"],
            intent=f"NOOA independent review of Retrace PR {PR} ({TITLE}, {ROUND}, class {CLASS}, witness seat; {SURFACE}) at {REVIEWED_HEAD[:12]}: {verdict}",
        )
        logged_text = ra._text(logged)
        print(f"NOOA_REVIEW_RESULT action={action} verdict={verdict!r} review={path}", file=sys.stderr, flush=True)
        return f"review: {path}\nsha256: {digest}\naction: {action}\nverdict: {verdict}\nreview event: {logged_text}"


PR_DOC = """Review a change to the Retrace repository as its independent witness seat: PR __PR__ (__TITLE__), __ROUND__ at __REV__; __SURFACE__.
    Do EACH step EXACTLY ONCE.

    1. Call retrace_instruct ONCE with human_id "jordansboxing@gmail.com" and the instruction
       "NOOA independent review of Retrace PR __PR__: __TITLE__, __ROUND__ at __REV__".
       Its response contains an event id shaped like "evt_" + 32 hex characters; extract ONLY that
       token as INSTRUCT_ID.
    2. READ THE WHOLE PACKET, IN SLICES. `design_markdown` is __LEN__ characters long. Anything you print is
       cut at 50,000 characters with the middle removed, and the cut cannot be recovered, so NEVER print
       `design_markdown` whole. Read it in slices of at most 20,000 characters:
       design_markdown[0:20000], design_markdown[20000:40000], and so on until the slice end reaches
       len(design_markdown). In your "Limits of this review" section, state the slices you read and whether
       you read every one. A previous run printed it whole and saw only its head and tail.
       Then read `design_markdown` carefully and in full. It is a self-contained review packet: it states
       your role and its limits, gives you the facts you may rely on, gives the author's own account
       of the change as a CLAIM UNDER TEST rather than as evidence, and carries the diff of the change.
       Follow the packet's "Output contract" section exactly — the headings it names, in the order it
       names them, and nothing else.
       The judgement you are making is: __JUDGEMENT__ ALSO whether each sentence of the change claims LESS THAN OR EXACTLY
       what the evidence carries, while still saying something true. Overcorrecting into vagueness is
       a defect of equal rank to overclaiming. Do not manufacture findings; if a claim is sound, say
       so. Where you cannot verify something from the packet alone, mark it unverified from packet
       rather than guessing in either direction.
       The LAST THREE lines of your whole review MUST be bare text starting at column zero — not indented, not a
       heading, not bold, not a list item, not a blockquote, not in a code fence — with nothing after them, in this
       order: "FINDINGS: high=<n> medium=<n> low=<n>" (the counts of the findings you listed), "BLOCKING: yes" or
       "BLOCKING: no", and "VERDICT:" followed by exactly "approved" or "needs changes", then nothing or one of the
       delimiters — – : - and one line of text. BLOCKING is derived, not chosen: "yes" exactly when high + medium > 0.
       "approved" cannot carry a Medium or High. "needs changes" is sealed as the action "rejected"; with only Lows it is
       allowed and reads "BLOCKING: no" (a non-blocking rejection). There is no REASON line. Write FINDINGS:, BLOCKING:
       and VERDICT: at the start of exactly one line each in the whole review, and never quote them in a fence, a
       blockquote, a list or a heading. The seal refuses anything else and seals nothing.
    3. Call self.seal_review(INSTRUCT_ID, <the complete review markdown>) ONCE. If seal_review
       raises, report the error verbatim and never invent a review event id.
    Finally reply with INSTRUCT_ID, the review path, its SHA-256, the action, and the review event id,
    copied verbatim from seal_review's returned text.
    """
ra.RetraceDesignReviewer.review.__doc__ = (PR_DOC.replace("__REV__", REVIEWED_HEAD[:12]).replace("__ROUND__", ROUND)
    .replace("__LEN__", str(len(ra.DESIGN_TEXT))).replace("__PR__", PR).replace("__TITLE__", TITLE)
    .replace("__SURFACE__", SURFACE).replace("__JUDGEMENT__", JUDGEMENT))


async def main():
    agent = PRReviewer()
    result = await agent.review(ra.DESIGN_TEXT)
    print("\n=== REVIEW RESULT ===")
    print(result)
    tail = str(result).split("review event", 1)[-1]
    if not re.search(r"evt_[0-9a-f]{32}", tail):
        print("REVIEW_NOT_SEALED: the reply names no review event id; treat this run as failed",
              file=sys.stderr, flush=True)
        sys.exit(2)


if __name__ == "__main__":
    asyncio.run(main())
