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
is finite; stand it down when it reports single digits.

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

**Builders — github-copilot (GPT-5.6 Sol), cursor-agent (Grok 4.6 in Cursor).** Bounded, specified work
from a brief, in their own worktrees, one PR each, commit only their own paths. Evidence: Copilot's export
tail (PR 12), object-store doctor (PR 14, 17), stranger fixes (PR 20, 22), release prep (PR 25); cursor-agent's
six security fixes (PR 16) and the fresh-export bind (PR 18). Copilot also ran the stranger test that found
the broken install command and the local-doctor bug. Gemini and OpenCode are harnesses, not seats: Gemini
never reliably calls the provenance tools; OpenCode is held (PR 19) until it can load its own identity file.

## The rules the seats imply

1. **Reviewer ≠ builder for the same change.** Whoever built it does not review it. Astra's PR 15 was
   reviewed by Grok, NOOA and Claude; cursor-agent's PR 16 by Codex (read-only) and Claude; Claude's design
   notes by Codex, Grok and NOOA. When Codex builds, Grok or NOOA is the reviewer of record.
2. **Order of review: Codex → (NOOA for designs) → Claude → merge.** Claude's approval is the last check,
   never the first. Every design note goes to all three other Core Four seats; missing one (the trailer note
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

## How to change this

Reassign by saying so; the ledger will show the real assignment regardless. Revise this file when the
evidence changes — a seat that stops earning its description, a new harness that clears the identity gate,
or a budget that moves. Cite the events.
