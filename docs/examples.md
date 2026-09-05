# Retrace by example — the problem, then the proof

Retrace is a provenance ledger for AI coding agents. Every event records **who** did **what**, **when**, **where**, **why** (a `caused_by` chain back to the human instruction) and **how**, sealed in a hash chain that anyone can verify offline.

Everything below comes from **this repository's own public ledger** — 1,700+ events and 220 commits, written by the six agents that built the tool (Claude Code, Codex, Gemini CLI, Grok, GitHub Copilot, Cursor Agent) under one human. Nothing here is invented: every example names a commit, an event id, or a command you can run.

- Browse the live ledger: <https://retrace-api.slcwitit.workers.dev/s/sh_ea81439e010abb1c0ec7167c>
- The full reference is the [README](../README.md); this page is the three-minute version.

---

## 1. A commit named the wrong agent as its author

**The problem.** Six agents share one checkout. Claude Code left ~300 lines uncommitted. Codex was told "re-integrate" and committed them — under its own name. `git blame` said Codex wrote them. It had no way to know otherwise.

**Without Retrace.** Git records the *committer*. It cannot tell you which agent authored a change, or that the author and the committer were different agents.

**With Retrace.** The ledger already held Claude Code's `edited` events for those files, with no matching edits from Codex. `retrace-export reconcile` compares each commit's file list against the logged edits and reports this shape by name — **`misattributed`**: *fail when every file's only logged edits belong to another agent*. That is the documented definition, and bfe87c3 is the case it was written for; the check finds it from ledger data alone, without trusting git's author string.

The fix is append-only — the record is never rewritten. Commit `c375ed4` is the correction, sealed after the fact: *"Attribution: bfe87c3 was authored by claude-code, committed by codex."*

On the first run over this repo's last 120 commits: 119 sealed, **3 complete mis-attributions** (one acknowledged, two still open — an acknowledgement must come from the author or a human, never the accused committer), and 215 files agents changed without logging. That count is the point of the check.

---

## 2. "Which human told the agent to do this?"

**The problem.** An agent made a change. You want the instruction behind it — not the agent's summary of the instruction, the actual root.

**With Retrace.** Every agent event carries `caused_by`, and the chain ends at a human `instructed` event. `retrace_why` walks it. This is a real chain from a public project, produced by NOOA — NVIDIA Labs’ Object-Oriented Agents research preview, an outside framework — logging to the live ledger:

```
#1  «nooa» [agent: «claude-haiku-4-5»] on behalf of «jordansboxing@gmail.com»
    created «nooa:demo/what-is-nooa»
    why: «Summarized NOOA framework»
  ↳ because
#0  «jordansboxing@gmail.com» instructed
    «Summarize what the NVIDIA-NeMo Object-Oriented Agents framework is…»
```

Browse it: <https://retrace-api.slcwitit.workers.dev/s/sh_bd2ab621ad2454ceb9b9fdc7>. A `caused_by` that names a missing or foreign event is rejected at write time — a dangling link is never silently stored.

---

## 3. "The agent says it ran model X. Did it?"

**The problem.** Agents self-report their model, and they get it wrong. This week Codex logged itself as `gpt-5` in some events while running `gpt-5.6-sol`; the ledger's actor list shows three variants (`GPT-5`, `gpt-5`, `gpt-5.6-sol`).

**With Retrace.** Trust is tiered and labeled, not flattened:

| Field | Who decides | How it's protected |
|---|---|---|
| **who** (actor id) | the server, from the credential | agents cannot impersonate each other |
| **when** | the server (arrival time) | sealed into the hash |
| **model** | the agent | recorded as *asserted*, shown as such |
| producer signature | the agent's own Ed25519 key | verified by the server; the server never holds the private key |

So the ledger shows you exactly what Codex *claimed*, next to what the server *knows*. The model field is honest about being a claim. (Producer signing shipped this week; one external producer signs today and the six harnesses are being re-provisioned.)

---

## 4. An agent changed files and never logged it

**The problem.** A commit lands. Some of its files have no provenance at all — an agent edited them and never called `retrace_log`.

**With Retrace.** Reconciliation reports each such file as **`uncovered`** — a silent producer. In CI, `retrace doctor --gate` adds a **`capture coverage`** finding for HEAD that lists them by kind and detail, and fails the commit when no producer sealed it. (`uncovered` warns by default; set `"reconcile": {"uncovered": "fail"}` in `.retrace.json` once a repo's producers are complete.)

Honest limit: a covering event proves an agent **claimed** the edit, not that the diff matches it — there are no per-file content hashes yet. The gate makes coverage *complete for commits*; it does not capture keystrokes.

---

## 5. Someone rewrote history after the fact

**The problem.** Whoever operates the database — or an attacker who reached it — edits or deletes events. (Wiz's 2026 AI-infrastructure honeypot watched attackers erase their artifacts with `rmtree` after compromising MCP servers.)

**With Retrace.** Three independent layers, each one you can check yourself:

- **Hash chain.** Every event includes the previous event's hash; `retrace_verify` recomputes the chain. An edited or removed event breaks it.
- **External witness.** Heads are checkpointed **hourly** into Sigstore's Rekor transparency log — a Merkle log we do not operate. Checkpoint #1337 is Rekor log index `2683576008`; look it up against Rekor's own key.
- **Two producers per commit.** The git hook and the GitHub push webhook seal every commit independently. If the actors disagree: `producer_disagreement`. If a commit was amended after the hook sealed it, the abandoned original shows up as `unreachable_seal`.

Honest limit: this is **tamper-evident, not tamper-proof**. Between checkpoints there is a window of up to an hour in which an operator could rewrite; after a checkpoint, rewriting means rewriting Rekor.

---

## 6. Prove it to someone who doesn't trust your server

**The problem.** A client, auditor, or skeptic asks: "show me — without my having to trust your dashboard."

**With Retrace.** Export a signed bundle and verify it offline against the ledger's published key:

```
$ npx -y --package=@retrace-dev/cli retrace-export verify retrace.json \
    --pubkey https://retrace-api.slcwitit.workers.dev/.well-known/retrace-pubkey

VALID — signature: valid (kid 51f6ac4c7ba7be66, trusted key); events intact: true;
links: true; chain ok at export: true; coverage: complete — 4 of 4 events;
producer sigs: 4 verified · 0 INVALID · 0 unsigned agent events
```

That is the real output for the public NOOA project above. And the tool refuses to flatter you: run it **without** a trusted key and it says `NOT VALID — signature: self_attested (key embedded in bundle — NOT a trusted key)`, because a bundle vouching for itself is not proof.

---

## What it deliberately does not do

- It is **tamper-evident, not tamper-proof** — see the checkpoint window above.
- **Model names are asserted** by the agent, and labeled so. Verifying them waits on harnesses exposing a verifiable model id.
- **Coverage is what producers log.** Complete for commits (enforced by the CI gate); it does not record keystrokes, prompts wholesale, or the harness's system prompt.
- **A wrong actor stays sealed.** Corrections are appended (`c375ed4` above), never edited. `retrace_amend` can supply a missing artifact role or attest a missing causal root; a first-class *attribution amendment* that re-attributes an actor is not built yet — this ledger's own seq 18 still carries a model name where an actor id belongs.
- **No line-level attribution** ("GPT wrote this function") — not a feature, not planned.

---

## Try it in two minutes

1. Browse the live ledger: <https://retrace-api.slcwitit.workers.dev/s/sh_ea81439e010abb1c0ec7167c> (timeline · printable report · signed export).
2. Verify a bundle offline with the command in §6 — the pre-verified snapshot is in the [releases](https://github.com/jordandru/retrace/releases/tag/ledger-2026-09-03).
3. Wire your own agents: the [Quick start](reference.md#quick-start-local-no-cloud-needed) runs locally with no cloud account; the [SETUP-GUIDE](../SETUP-GUIDE.md) covers the hosted Worker. Apache-2.0; self-host free.
