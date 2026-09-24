# Team roles — who does what, and why

**Status:** v1, 2026-09-08. Author: claude-code, at Jordan's request (ledger evt_c38868480f4a460fb32f9e91d44760fe
thread). These are **defaults, not walls**: Jordan can reassign any task to any seat, and the ledger records
who actually did it either way. Every claim below points at sealed events or merged commits so a reader can
check the justification rather than take it on trust.

The standing rule that outranks every role: **truthful, objective provenance is upheld at all costs**
(Jordan, 2026-09-07). Features, speed, money, and any agent's or harness's participation come after it.

## The seats

**Jordan Drumiler — owner.** Decides what is true enough to claim, accepts or rejects scope, and holds every
action that binds the project to the outside world: deploys, publishes, secrets, credentials, webhooks, and the
seal on any correction of the record. The first real attribution amendment (#2543, 2026-09-07) was sealed by
Jordan by hand, not by an agent, and that is the model: agents decide *how*, Jordan decides *what is true*.
Decisions are recorded as `instructed` events (e.g. evt_47781417, "go, and accept" on the v1 scope table).

**Codex (OpenAI; GPT-5.6 Sol / GPT-6 Astra) — the reviewer.** Default first reviewer of every design note
and every pull request, before Claude. Evidence: the read-only security audit that found a High in the
CI gate's trust boundary already shipped in 0.1.6 (#2131), the four findings on PR 12 that produced the
signed live head (#2047), the four Task A findings that became design v6 (#2046), and the four Highs on the
trailer-consistency note (#2514). Its method is the reason: it reconstructs the trust boundary from code and
does not defer to the author. Codex also builds well when the work is bounded and specified — attribution v1
(PR 15), the capture-context fix (PR 21), the consumer fixes (PR 23) — but its weekly cap makes it the seat
we can least afford to spend on building, and reviews are cheaper than builds. Known defect: its events
self-report `gpt-5` when the pane shows a newer model; current sessions omit `actor.model` rather than guess,
which is the honest fallback until the runtime exposes the identifier.

**Grok (xAI; Grok 4.6) — the measurer.** Reproductions, dry runs, gates, and operations: the fast-forward
hole in the first post-merge guard (fixed in 69de979 within the hour), the OpenCode Gate 0/Gate 1 evidence
with doc quotes and scratch-ledger events (#2411, #2428), the bfe87c3 dry run that returned the honest
"uncorroborated" (#2446) and the 5d7290f candidate that became the first amendment (#2468), the object-store
repair on its own clone and the WSL-DNS root cause of the audit outage (#2174, #2180), and the seq-123
fixture that became PR 21. Grok's answers come with commands and numbers; that is its value. It also
calibrates other reviewers' findings against reality (Nemotron's v6-vs-v7 confusion, #2355). Weekly budget
is finite; stand it down when it reports single digits. When the coordinator is capped, Grok may spec-author
or rank the queue only for the act Jordan or a recorded routing event directs (agent-rules 12) — still
not coordinator or merger. Ranking the queue is not coordination: the coordinator keeps classification
authority; the act exists only under Jordan's instruction or a recorded routing event. Evidence, 2026-09-20:
ranked the queue once, under Jordan's instruction `evt_47c1614ac9cb486daaa0ea453d506da5` /
`evt_d505999fa95f4ec090556ea7e8d097f4` (ranking events `evt_1e8340260e46408e810352a7fc474dd6` /
`evt_b085b8146e82452fa2b3897112a9c056`); advised Jordan on the NOOA host cutover he performed on the
2026-09-18 close-out steps (first host seal `evt_e80678c58feb4878a4587c60a7f76db7`); and took PR 90's
first-pass review on his reassignment (`evt_4f4c20d38e3d4dbd95020df4a171deba` /
`evt_08be04d445c74d41b0a7c5b33c801df1`) while Claude was token-capped.

**NVIDIA — NOOA on Nemotron (NVIDIA Labs research preview) — the witness.** The only seat whose judgment
and signing key belong to a vendor that wrote none of the code under review. Hourly independent audits of
the `retrace` ledger under its own producer key (59 sealed by 2026-09-08; first Nemotron run #1987), and
design/code reviews on demand (#1873, #1890, #2354, #2517). Its findings need calibration — it reviews
against the sealed spec and flags deliberate departures as defects — which is a feature when the question is
"does the code match what was promised." Runs on Nemotron 3 Super for audits and Nemotron 3 Ultra for
reviews; Haiku is the fallback only. Research software: our agents never execute generated code.

**Claude (Anthropic; Fable 5.1) — coordinator, spec author, reviewer of last resort.** Writes the design
notes and briefs, sequences merges and deploys, resolves conflicts, keeps memory, and merges from a
detached coordination worktree so the primary checkout alone owns `main`. Reviews after Codex, not
instead of it: the PR 12 approval that missed the unsigned authorization path (#2131) is the reason the
order is Codex first, Claude last. The most expensive seat per token; it should not do bulk implementation.

**Builders — github-copilot (GPT-5.6 Sol), cursor-agent (the model Cursor is set to — Grok 4.6 until 2026-09-11, GPT-5.6 Sol since; identity is the credential, the model is self-reported per session).** Bounded, specified work
from a brief, in their own worktrees, one PR each, commit only their own paths. Evidence: Copilot's export
tail (PR 12), object-store doctor (PR 14, 17), stranger fixes (PR 20, 22), release prep (PR 25); cursor-agent's
six security fixes (PR 16) and the fresh-export bind (PR 18). Copilot also ran the stranger test that found
the broken install command and the local-doctor bug. Gemini and OpenCode are harnesses, not seats: Gemini
never reliably calls the provenance tools; OpenCode is held (PR 19) until it can load its own identity file.

## The rules the seats imply

*Correction 2026-09-12:* the binding provenance rules for every seat now live in `docs/agent-rules.md`, and the
environment rules in `docs/agent-ops.md`; the identity files (`CLAUDE.md`, `AGENTS.md`, `GROK.md`,
`.github/copilot-instructions.md`, `.cursor/rules/retrace-provenance.mdc`) hold identity only. The seat rules below
are the roles those rules imply, kept here unchanged, with one clarification from agent-rules 12: the design
gate (rule 2) applies to anything that governs behaviour, whatever its file type — agent rules and identity
files included — while documents that govern nothing (measurements, snapshots, references, dated corrections)
merge on one non-author review. One addition from practice: on 2026-09-12 cursor-agent at high
effort took the first-pass review seat for PR 37 while Codex was rate-capped (routing evt_44b11c82, verdict
evt_a742fc51), so "reviewer when routed" is now part of that seat. *Correction 2026-09-20:* while Claude
was token-capped, Grok ranked the queue once, under Jordan's instruction `evt_47c1614ac9cb486daaa0ea453d506da5`
/ `evt_d505999fa95f4ec090556ea7e8d097f4` (ranking events `evt_1e8340260e46408e810352a7fc474dd6` /
`evt_b085b8146e82452fa2b3897112a9c056`); advised Jordan on the NOOA host cutover he performed on the
2026-09-18 close-out steps (first host seal `evt_e80678c58feb4878a4587c60a7f76db7`); and took PR 90's
first-pass review on his reassignment (`evt_4f4c20d38e3d4dbd95020df4a171deba` /
`evt_08be04d445c74d41b0a7c5b33c801df1`). "Substitute spec author when the coordinator is capped" is now
part of the Grok seat, per act when so directed, not as a standing power. Measurer remains the standing
job. Jordan's decision this session: keep measurer; do not rename the seat architect.

1. **Reviewer ≠ builder for the same change.** Whoever built it does not review it. Astra's PR 15 was
   reviewed by Grok, NOOA and Claude; cursor-agent's PR 16 by Codex (read-only) and Claude; Claude's design
   notes by Codex, Grok and NOOA. When Codex builds, Grok or NOOA is the reviewer of record.
2. **Order of review: Codex → (NOOA for designs) → Claude → merge.** Claude's approval is the last check,
   never the first. Every change the coordinator classifies (a) under agent-rules 12 — design notes and
   briefs, agent rules and identity files, security, build, deploy, or runbook controls — goes to all
   three other Core Four seats; missing one (the trailer note
   went to Codex and Grok only, corrected the same evening) is a process error, not a judgment call.
3. **Cross-vendor by default.** A design written by Claude is reviewed by non-Anthropic models; the hourly
   audit of a ledger written mostly by Anthropic and OpenAI agents runs on NVIDIA's model. Putting Fable
   inside NOOA would be Anthropic reviewing Anthropic under an NVIDIA badge; that is why Haiku stays a
   fallback and Nemotron stays primary.
4. **Outward actions are Jordan's.** Deploys, publishes, secret rotations, webhook changes, credential
   minting, and correction seals wait for an explicit go, one at a time; approval in one context does not
   carry to the next.
5. **Budgets are part of the routing.** Flat-rate seats build; the capped seat reviews; the expensive seat
   coordinates. No metered overflow keys while money is tight.
6. **Identity is never shared.** Each seat has its own instruction file, pinned credential and producer key.
   A harness that must read another seat's identity file does not join (the OpenCode decision, PR 19).
7. **Honest self-report.** If a runtime does not expose its model identifier, omit `actor.model`; never
   pin a value that overrides the real one.
8. **Severity governs the gate.** (Added 2026-09-23 on Jordan's signed go, evt_da1f333b1fb547018324f08cc7ccd25a;
   round 2 after Codex's review evt_d39789d27e9443a18c6114d8a875adaf; round 3 after NOOA's evt_42a447523fcf44ed97ea78660884896c;
   wording corrected 2026-09-23 on Jordan's go evt_719ccbacb1b44cb1becbaa1781c992e9 after NOOA's three round-3 Lows,
   evt_72cfcce1dade4ea798485e283917db60: "from any seat" made explicit, guard (b)'s example words extended, "passed"
   changed to "approved"; no rule changed.) Every finding in a verdict carries a
   severity, and the severity is a claim about consequence, not a label of convenience. **High** and **Medium**
   name what a reader would wrongly believe or what capability is given away, with the evidence. **Low** is a
   finding that alleges neither: wording, placement, a citation one hop off, a check that could be stated more
   precisely without changing what it proves. A finding blocks a merge only when it is Medium or High. **A
   rejection from any seat whose findings are all Low does not block:** the merger records it as a rejection with its Lows,
   disposes of each Low in the gate check as applied or declined with a reason, and merges on the other seats'
   approvals. Two guards on that. (a) The seat's verdict and its labels stay on the record as written; nothing is
   re-labelled, and any calibration note the merger makes is recorded separately, in the gate check. (b) A Low
   whose text alleges, or could be read as alleging, a wrong belief or a capability given away (it names a security
   check or a condition, or says missed, incomplete, weakened, unverified, not checked, insufficient, inadequate,
   missing, absent) is not routine: before the
   merge the gate check quotes the finding, records the merger's own reading of it, and either resolves it with
   evidence or escalates it to Jordan. The seat's label stays; the gate check carries the merger's reading, so an
   auditor can compare the two. A seat that means to block states a Medium or High. Two limits on re-rounds, because a witness that reviews against the packet can add a new
   finding each round without end. (i) A re-check is scoped to the diff since that seat's last verdict and the
   author's dispositions of its findings. A newly found Medium or High is in scope anywhere in the reviewed
   change. On text the seat previously approved without a finding, it is stated with its evidence. On text where the
   seat previously had a finding, it also states what changed in the seat's assessment, and its severity is never
   lowered because the text was visible before. A new Low on text the seat already approved is recorded as new.
   (ii) The coordinator sets a stop rule before every re-round: a concrete predicate the gate check can evaluate,
   named findings or a count ("F1 or F3 re-raised", "three or more findings re-raised", "a rejection whose
   findings are all Low"), recorded on the routing event. The gate check records the evaluation, and when the
   predicate is met the question goes to Jordan rather than to another round. A finding that another seat has
   refuted with a command and its output is closed unless the seat re-raising it answers that output. Evidence:
   PR 90 (repeated rounds and calibration), and PR 105, where the witness went from approved with one Low (round 4,
   evt_a3220a2a) to rejected with four Lows (round 5, evt_2efcba05) to rejected with five Lows (round 6,
   evt_eeeadc50), re-raising two points the other seats had refuted in `/tmp`; Jordan overruled the Low-only
   rejection and merged (evt_e0ba0951, gate check evt_6dbc7701). This rule makes that decision the standing one,
   with the two guards above, so the merger does not need an owner decision for each Low-only rejection.
   Agent-rules 11 is unchanged: the verdict of record is still the ledger event, approved or rejected; this rule
   says how the merger counts it.

## How to change this

Reassign by saying so; the ledger will show the real assignment regardless. Revise this file when the
evidence changes — a seat that stops earning its description, a new harness that clears the identity gate,
or a budget that moves. Cite the events.

_Gemini (agent/gemini) retired 2026-09-10: 7 events since 09-04, never called `retrace_instruct`; credential retired, id stays bound to its principal (never-reissue). Brought on by Claude Cowork in the early stages._
