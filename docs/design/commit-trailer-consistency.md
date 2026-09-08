# Commit trailer consistency — design note

**Status:** draft v1, 2026-09-07. Author: claude-code (ledger evt_47781417 thread). Not built.
Reviewers: Codex, Grok. Builder once reviewed: cursor-agent or github-copilot. Blocks any decision
on PR 19 (OpenCode).

## 1. The problem

A commit's WHO is derived from trailers the committing agent writes (`Retrace-Actor`, else an agent
`Co-Authored-By`, else the human author — `commit-actor.ts`). Both producers trust them: the git hook
on the committing machine, and the GitHub push webhook on the Worker. Neither checks the trailer
against anything the ledger already knows. So an agent that writes another agent's trailer — by
copying it from a shared instruction file, or by a formatting slip — puts a false actor into an
append-only ledger twice, and the falsehood is only discovered afterwards by the gate or reconcile.

This is not hypothetical. On 2026-09-06 github-copilot's first commit carried literal `\n` sequences
instead of trailer lines and was sealed as a human commit (#2030) until amended. On 2026-09-07 the
OpenCode evaluation (PR 19) established that OpenCode always loads Codex's `AGENTS.md`, so a model
running there would see `Retrace-Actor: codex` as an instruction.

Jordan's standing rule (2026-09-07): truthful, objective provenance is upheld at all costs. Detection
after the fact is not the same as never writing the false record.

## 2. What the producers already hold and do not use

- Every agent commit carries `Retrace-Caused-By: evt_…`. Its causal chain is MCP events whose actor
  was fixed **server-side** by a pinned credential and whose client was stamped from the MCP
  `initialize` handshake (`location.client`, e.g. `opencode@1.18.29`, measured 2026-09-07).
- The gate already compares the sealed commit's actor to those peers (`mcpPeers`, `pinSessionFinding`
  in `doctor.ts`) — but only after both seals exist.
- The hook can `GET` the chain with the credential it already holds; the Worker has the store in hand
  when the webhook fires.

## 3. Why an environment guard is not enough

OpenCode marks the shells it spawns with `OPENCODE=1` and `OPENCODE_PID` (measured by Grok in a
scratch setup; Claude Code and Grok set session ids; Codex, Copilot and Cursor set nothing the hook
reads today). A hook that refused to seal when the trailer names a harness other than the one the
environment reveals would protect **one** producer. The webhook seals from the push payload alone and
would still write the false actor. An environment marker is therefore at most a second line, never the
guard.

## 4. The guard: trailer consistency at seal time, in both producers

Before sealing a commit whose resolved actor is an **agent**:

1. Resolve the causal chain from `Retrace-Caused-By` (hook: one authenticated `GET …/why`; webhook:
   the store). Take the **server-stamped** actors of its MCP peers (`actor.type === "agent"` or
   `location.surface === "agent"`, excluding the `instructed` root), compared as `{type,id}`.
2. If the trailer actor is among them → seal as today.
3. If the chain has no MCP peers (a commit with an instruct root but no logged edits) → seal as today;
   that case already surfaces as `uncovered`/`unrooted` downstream and must not be masked here.
4. If the chain has peers and **none** match → do **not** write an agent WHO. Seal the commit with the
   producer's own actor (`system/retrace-git` or `system/webhook:github`), `action` unchanged, and
   `method.params.attribution_conflict = { trailer_actor: {type,id}, chain_actors: [{type,id}…],
   caused_by }`. The recorded trailer text stays in `intent`/params verbatim so nothing is hidden.
5. Fail closed on lookup failure (chain unreachable, Worker unreachable): the hook logs to
   `retrace-hook.log` and seals nothing; the webhook seals with `attribution_conflict.reason =
   "chain_unavailable"` and no agent WHO.

Consequences, deliberately: the gate fails on such a commit (`HEAD delivery` finds a system seal with a
conflict marker → new finding `trailer conflict`, fail); reconcile reports it as its own kind
(`trailer_conflict`, fail-level, acknowledgeable like the others); the correct WHO is restored by a
human-sealed attribution amendment whose evidence is exactly the stamped MCP edits the check found.
The amendment machinery landed today (PR 15), so the correction path exists before the guard does.

## 5. What this does and does not cover

Covers: any agent, in any harness, writing another harness's trailer — shared instruction files,
copy-paste, or a model's confusion — for both producers, at write time. Does not cover: a commit with
no causal trailer at all (already `unrooted`); an agent whose MCP credential is itself the wrong
identity (the property Friday's rollout established and the admin tool enforces); human commits
(no trailer, no chain, out of scope).

## 6. Environment marker as a second line (optional, hook only)

Record `location.harness_marker` on hook seals when a known marker is present (`OPENCODE=1`,
`CLAUDE_CODE_SESSION_ID`, `GROK_SESSION_ID`, …) — evidence, never a decision, same rule as `surface`.
Reviewers may drop this section without weakening §4.

## 7. Tests (adversarial first)

1. Trailer `codex`, chain peers all `opencode` (pinned) → system seal with conflict marker; gate FAIL
   `trailer conflict`; reconcile `trailer_conflict`.
2. Trailer matches one of two peers → sealed as trailer actor (multi-agent chains are legal).
3. Chain has instruct root only → sealed as today.
4. Chain unreachable at hook time → nothing sealed, hook log line; webhook path → conflict marker
   `chain_unavailable`.
5. Webhook and hook disagree (one had the chain, one did not) → existing `producer_disagreement`
   still reports; no new silent path.
6. Human commit → untouched.
7. Amendment: a conflict seal is corrected by a human-sealed attribution amendment citing the stamped
   peers; `why` shows recorded system seal → effective agent.

## 8. Open questions for review

- Q1 Should the webhook consult the chain synchronously (latency on every push) or seal-then-verify
  with the marker added by a second event? Lean: synchronously; the store read is cheap and the
  falsehood must never exist unmarked.
- Q2 Should `chain_actors` match on `{type,id}` only, or also require the peers' `location.client` to
  agree with the trailer's harness family? Lean: `{type,id}` only in v1; client is evidence for `why`.
- Q3 Does this change the OpenCode answer? Only after it ships: with the guard, a copied Codex
  trailer becomes an unwritable conflict rather than a false record. Until then PR 19 stays held.
