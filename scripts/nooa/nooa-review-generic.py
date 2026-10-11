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

v2 (2026-10-11, docs/design/dispatch-protocol.md §2, the verdict shape): the review's last lines carry
`FINDINGS: high=<n> medium=<n> low=<n>`, `BLOCKING: yes|no`, optionally `REASON: …`, then `VERDICT:`.
The seal records `findings`, `blocking` and the reason in method.params, and REFUSES (seals nothing, keeps the
text) when the lines are missing or disagree: `needs changes` is blocking and needs a High or Medium or a
REASON; `approved` is not blocking and, with a High or Medium, needs a REASON. Measured cause: 17 of 55
verdicts on six PRs that week carried their counts only in prose, and one all-Low "needs changes" said of
itself that it did not block. Self-test: `python3 nooa-review-generic.py --selftest` (no host modules needed).
The canonical copy lives in the repository at scripts/nooa/nooa-review-generic.py; push-and-launch.sh
copies the one in its own directory, so copy the repository file over it after a merge.
"""
import asyncio
import os
import re
import sys
from hashlib import sha256
from pathlib import Path

_VERDICT_RE = re.compile(r"(?m)^(?:#{1,6}\s*)?\**VERDICT:?\**:?\s*(.+?)\s*$")
_FINDINGS_RE = re.compile(r"(?m)^\s*FINDINGS:\s*high\s*=\s*(\d+)\s+medium\s*=\s*(\d+)\s+low\s*=\s*(\d+)\s*$", re.I)
_BLOCKING_RE = re.compile(r"(?m)^\s*BLOCKING:\s*(yes|no)\s*$", re.I)
_REASON_RE = re.compile(r"(?m)^\s*REASON:\s*(.+?)\s*$")


def parse_verdict_block(review_markdown: str) -> dict:
    """The sealed shape of a verdict, from the review's own last lines. Raises ValueError on anything missing or
    inconsistent, so a malformed review seals nothing (fail closed) and the error names the line to fix."""
    m = _VERDICT_RE.search(review_markdown)
    if not m:
        raise ValueError("review must contain a line starting with VERDICT:")
    verdict = m.group(1).strip()[:140]
    if not verdict:
        raise ValueError("VERDICT: line is empty")
    low = verdict.lower()
    if low.startswith("approved"):
        action = "approved"
    elif low.startswith("needs changes"):
        action = "rejected"
    else:
        raise ValueError("VERDICT: must start with 'approved' or 'needs changes'; got: " + verdict)
    f = _FINDINGS_RE.findall(review_markdown)
    if not f:
        raise ValueError("review must contain a line 'FINDINGS: high=<n> medium=<n> low=<n>' before VERDICT:")
    high, medium, lo = (int(x) for x in f[-1])
    b = _BLOCKING_RE.findall(review_markdown)
    if not b:
        raise ValueError("review must contain a line 'BLOCKING: yes' or 'BLOCKING: no' before VERDICT:")
    blocking = b[-1].lower() == "yes"
    reasons = _REASON_RE.findall(review_markdown)
    reason = reasons[-1].strip() if reasons else None
    severe = high + medium > 0
    params = {"findings": {"high": high, "medium": medium, "low": lo}, "blocking": blocking}
    if action == "rejected":
        if not blocking:
            raise ValueError("VERDICT: needs changes requires BLOCKING: yes (a Low-only review is VERDICT: approved with its Lows listed)")
        if not severe:
            if not reason:
                raise ValueError("VERDICT: needs changes with no High or Medium finding requires a 'REASON: <why this blocks>' line")
            params["blocking_reason"] = reason[:400]
    else:
        if blocking:
            raise ValueError("VERDICT: approved requires BLOCKING: no")
        if severe:
            if not reason:
                raise ValueError("VERDICT: approved with a High or Medium finding requires a 'REASON: <why it is accepted>' line")
            params["accepted_reason"] = reason[:400]
    return {"action": action, "verdict": verdict, "params": params}


def _selftest() -> None:
    base = "## Findings\nNo findings\n\n## Limits\nread all\n\n"
    ok = parse_verdict_block(base + "FINDINGS: high=0 medium=0 low=2\nBLOCKING: no\nVERDICT: approved — fine")
    assert ok["action"] == "approved" and ok["params"] == {"findings": {"high": 0, "medium": 0, "low": 2}, "blocking": False}, ok
    rej = parse_verdict_block(base + "FINDINGS: high=0 medium=1 low=0\nBLOCKING: yes\nVERDICT: needs changes: M1")
    assert rej["action"] == "rejected" and rej["params"]["blocking"] is True and "blocking_reason" not in rej["params"], rej
    rr = parse_verdict_block(base + "FINDINGS: high=0 medium=0 low=1\nBLOCKING: yes\nREASON: head differs from the routed head\nVERDICT: needs changes: head")
    assert rr["params"]["blocking_reason"].startswith("head differs"), rr
    ar = parse_verdict_block(base + "FINDINGS: high=0 medium=1 low=0\nBLOCKING: no\nREASON: the Medium is accepted by the merger as a doc nit\nVERDICT: approved — with one Medium")
    assert ar["params"]["accepted_reason"].startswith("the Medium"), ar
    bad = [
        base + "VERDICT: approved — no counts",
        base + "FINDINGS: high=0 medium=0 low=0\nVERDICT: approved — no blocking line",
        base + "FINDINGS: high=0 medium=0 low=3\nBLOCKING: yes\nVERDICT: needs changes: lows only",
        base + "FINDINGS: high=0 medium=0 low=0\nBLOCKING: yes\nVERDICT: approved — contradiction",
        base + "FINDINGS: high=1 medium=0 low=0\nBLOCKING: no\nVERDICT: approved — high without reason",
        base + "FINDINGS: high=0 medium=1 low=0\nBLOCKING: no\nVERDICT: needs changes: not blocking",
        base + "FINDINGS: high=0 medium=0 low=0\nBLOCKING: no\nVERDICT: ready to build",
    ]
    for text in bad:
        try:
            parse_verdict_block(text)
        except ValueError:
            continue
        raise AssertionError("accepted a malformed verdict block:\n" + text)
    print("nooa-review-generic selftest: 11 cases OK")


if "--selftest" in sys.argv[1:]:
    _selftest()
    sys.exit(0)

NOOA_HOME = Path.home() / "nooa-retrace"
sys.path.insert(0, str(NOOA_HOME))
os.chdir(NOOA_HOME)

PR = os.environ["NOOA_PR"]                # e.g. "93"
TITLE = os.environ["NOOA_PR_TITLE"]      # short title for labels and intents
JUDGEMENT = os.environ["NOOA_JUDGEMENT"]  # the one-sentence judgement the reviewer is making
TAGS = [t for t in os.environ["NOOA_TAGS"].split(",") if t]
ROUTING_EVENT = os.environ["NOOA_ROUTING_EVENT"]
REVIEWED_HEAD = os.environ["NOOA_REVIEWED_HEAD"]
REVIEWED_FILES = [p for p in os.environ["NOOA_FILES"].split(",") if p]
ROUND = os.environ["NOOA_ROUND"]    # e.g. "round 5" — set by the launcher, never hard-coded here
RUBRIC = os.environ["NOOA_RUBRIC"]  # the routed rubric effort, copied from the routing event
SCOPE = os.environ["NOOA_SCOPE"]    # what the packet contains, for review_scope
PR_URL = f"https://github.com/jordandru/retrace/pull/{PR}"

if not os.environ.get("NOOA_MODEL", "").startswith("nvidia_nim/"):
    sys.exit("REFUSED: NOOA_MODEL must be pinned to an NVIDIA model for this review; got "
             f"{os.environ.get('NOOA_MODEL', '<unset>')!r}")

import review_agent as ra  # noqa: E402  (module-level code reads NOOA_* env)


class PRReviewer(ra.RetraceDesignReviewer):
    async def seal_review(self, caused_by: str, review_markdown: str) -> str:
        """Persist the exact review and seal ONE signed verdict event. Call exactly once."""
        if not ra._EVENT_ID.fullmatch(caused_by):
            raise ValueError("caused_by must be a bare Retrace event id")
        if len(review_markdown.strip()) < 200:
            raise ValueError("review is too short to be a review")

        shape = parse_verdict_block(review_markdown)  # raises on a missing or inconsistent FINDINGS/BLOCKING/VERDICT block
        action, verdict = shape["action"], shape["verdict"]

        ra.ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
        path = (ra.ARTIFACTS_DIR / f"review-pr{PR}-{ra.RUN_ID}.md").resolve()
        header = (f"# NOOA review — Retrace PR {PR} ({ra.REPO_REL}) @ {REVIEWED_HEAD[:12]}\n\n"
                  f"run: {ra.RUN_ID}\nreviewer: nooa (model {ra.MODEL})\n"
                  f"packet sha256: {ra.DESIGN_SHA}\nrouting event: {ROUTING_EVENT}\n"
                  f"reviewed head: {REVIEWED_HEAD}\ncaused_by: {caused_by}\n\n---\n\n")
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
                "reasoning_effort": f"not_applicable — {ra.MODEL} exposes no effort control (models.json supports_effort=false); routed rubric effort was {RUBRIC}",
                "review_scope": f"packet-scoped and advisory: the reviewer was INSTRUCTED to read the whole packet ({len(ra.DESIGN_TEXT)} characters: {SCOPE}) in slices of at most 20,000 characters, because the harness cuts printed output at 50,000; what it actually read is stated in its own Limits section; it executed nothing",
                "packet_sha256": ra.DESIGN_SHA,
            }},
            tags=["review", f"pr-{PR}", *TAGS, "gate"],
            intent=f"NOOA independent review of Retrace PR {PR} ({TITLE}, {ROUND}, class a, witness seat of the design gate) at {REVIEWED_HEAD[:12]}: {verdict}",
        )
        logged_text = ra._text(logged)
        print(f"NOOA_REVIEW_RESULT action={action} verdict={verdict!r} review={path}", file=sys.stderr, flush=True)
        return f"review: {path}\nsha256: {digest}\naction: {action}\nverdict: {verdict}\nreview event: {logged_text}"


PR_DOC = """Review a change to a governing document in the Retrace repository as the independent witness seat of its design gate.
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
       of the change as a CLAIM UNDER TEST rather than as evidence, and ends with the complete
       unified diff of the change. Follow the packet's "Output contract" section exactly — the
       headings it names, in the order it names them, and nothing else.
       The judgement you are making is: __JUDGEMENT__ ALSO whether each sentence of the change claims LESS THAN OR EXACTLY
       what the evidence carries, while still saying something true. Overcorrecting into vagueness is
       a defect of equal rank to overclaiming. Do not manufacture findings; if a claim is sound, say
       so. Where you cannot verify something from the packet alone, mark it unverified from packet
       rather than guessing in either direction.
       The LAST THREE lines of your review MUST be bare text — not markdown headings, not bold — in this order:
       "FINDINGS: high=<n> medium=<n> low=<n>" (the counts of the findings you listed), "BLOCKING: yes" or
       "BLOCKING: no", and "VERDICT:" beginning with either "approved" or "needs changes". "needs changes" is
       BLOCKING: yes and needs at least one Medium or High finding; with only Lows write "VERDICT: approved" and keep
       the Lows as findings, or add a line "REASON: <why this blocks>" before VERDICT. An approval with a Medium or
       High also needs a "REASON:" line. The seal refuses a review whose last lines disagree.
    3. Call self.seal_review(INSTRUCT_ID, <the complete review markdown>) ONCE. If seal_review
       raises, report the error verbatim and never invent a review event id.
    Finally reply with INSTRUCT_ID, the review path, its SHA-256, the action, and the review event id,
    copied verbatim from seal_review's returned text.
    """
ra.RetraceDesignReviewer.review.__doc__ = (PR_DOC.replace("__REV__", REVIEWED_HEAD[:12]).replace("__ROUND__", ROUND)
    .replace("__LEN__", str(len(ra.DESIGN_TEXT))).replace("__PR__", PR).replace("__TITLE__", TITLE).replace("__JUDGEMENT__", JUDGEMENT))


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
