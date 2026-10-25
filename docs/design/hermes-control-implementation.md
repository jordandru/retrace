# Hermes control implementation — 2026-10-21

Implementation candidate under Jordan's `evt_9ca54a682e8c4dcb8503a9d6c0494e19`, based on
Retrace `a02f27483c509d3ff5822cb689600b765c98427c`. Author `codex`, `gpt-6-astra`,
`harness-runtime`, effort `high`. Proposed class (a): identity, launcher and provenance controls.
The coordinator must classify and route the exact head; this author cannot supply its review.

This is the first control change against [the onboarding plan](hermes-onboarding.md). It is not a
completed onboarding, passed admission gate, live launch, or credential operation.

## Implemented interfaces

| Requirement | Implementation | Remaining evidence/work |
|---|---|---|
| F1 identity/evidence | Startup adapter loads only the hash-pinned `.hermes.md`, with the upstream threat scanner and no foreign fallback, SOUL loading or automatic subdirectory hints. The guard requires that adapter and the complete identity in the inspected main system prompt. Other actors' trailers in evidence are readable. | Actual CLI/TUI call-path coverage, forged-dispatch and malicious-evidence trials; no claim of immunity to model influence. |
| F2 edit receipts | MCP returns `receipt` version 1 from the appended event. The plugin correlates pre/post calls and immutable argument/revision snapshots, requires matching output artifacts/action/cause/model, and invalidates before later edits. Failed, duplicate, replayed or unmatched receipts cannot cover edits. | Full installed-runtime receipt propagation and commit-hook/reconciliation trials. Shell-write discovery remains best effort in scratch builder probes. |
| F3 launch/config | Exact candidate pin and source contract, launcher/adapter/guard/template hashes, explicit live MCP build hash and expected seal, probe-only switches, safe argument handling, config mutation refusal, one profile writer. | Effective tool inventory, CLI/TUI equivalence, installed dependency/build evidence, provider fallback and actual hook failure trials. |
| F4 research mode | Explicit tool policy: source reads within the worktree, web research, writes under the profile's report directory, and the seat's audit/verification tools. Terminal, project mutation, generic tool bridges, unrelated MCP servers and unknown tools are refused. | This is an in-process tool policy, not OS isolation. Real tool implementations, auxiliary paths and host custody still require gate evidence. Reproductions requiring execution stay scratch-only. |
| F5 opt-in identity | Admin recognizes keyed Hermes, preserves `DEFAULT_HARNESSES`, produces profile-specific onboarding, and retains the existing duplicate/principal protections. Profile exposes `retrace_verify_send`, not `retrace_send`. | Owner provisioning, own-credential live signature and terminal-binding checks. No credential was minted by implementing this change. |
| F6 knowledge | Native memory/profile injection, curator and background review stay disabled; write-approval settings are explicit and skill-ledger trimming disabled. Profile locking supplies the single-writer prerequisite. | **Not complete.** Need the controlled persistence implementation: approved versions, source/approval receipts, restart loading checks, correction history and failure handling before K1/K2 can pass. |
| F7 failure/provenance | Complete observer payloads within an explicit bound, refusal on loss markers, new-request retirement of old approvals, request-ID reuse refusal, model-switch refusal, receipt failure recovery and evidence-write failure refusal. | Installed-path/auxiliary coverage and evidence-bearing completion trials. Observer callbacks do not veto provider requests. |
| F8 expansions | Live mode is research only. The broader `builder-probe` mode is accepted only with scratch destination; all other roles still need their expansion gate. | Later capabilities are deliberately not admitted by this change. |

## Runtime adapter contract

`packages/hermes-plugin/runtime-contract.json` records the v0.22.3 commit
`5b147ab036d6d19131bff8d20701b5001eab844a`, sensitive source-file hashes and the dependency-lock hash.
`runtime_adapter.py` runs in that source's venv with Python `-I`, verifies the commit/clean tracked
source/contract, binds the selected context and observer functions, then imports the ordinary Hermes CLI.
The source checkout itself is not patched. Both launcher probes and chat use this entrypoint.

This is a small, version-specific adapter to upstream internals, not a claim that those internals are
a stable public interface. A different source contract requires inspection and renewed qualification.
Untracked/ignored code, installed dependencies and same-user filesystem interference are not proved
safe by a Git HEAD check; the installation/isolation trial must address those surfaces.

The literal `"[Subdirectory context discovered:"` evidence check is a best-effort secondary heuristic.
The primary guarantee is the pinned adapter's suppression of `SubdirectoryHints.check_tool_call`; an
upstream change to that surface requires a new source contract and renewed qualification.

The stock serializer clips strings at 8,000 characters and sequences at 200 entries. Its top-level
size setting does not remove those inner caps (`agent/api_request_hooks.py:67-70` at the pinned commit).
The adapter relaxes those per-value caps so the guard can inspect complete requests while preserving
upstream secret-key redaction and JSON conversion, then applies a maximum 8 MiB inspection budget;
oversize/depth/redaction loss is explicit
and the guard refuses dependent tools. It writes request hashes and verdicts, not raw requests.
The callbacks are observers: an invalid request may already have reached a provider before tools
are denied. This implementation does not claim a pre-provider privacy or authorization firewall.

## Receipt contract and limits

The stdio MCP server adds `structuredContent.receipt` to successful `retrace_instruct` and `retrace_log`
results. Existing result fields remain. It projects only event identity/hash/sequence, actor/model,
project, action, cause, artifact ids/roles and remote seal/signature verdict. It contains no intent,
diff, arbitrary method parameters, token or private key. A local store never receives a synthesized
credential seal, even if the caller submitted seal-shaped method parameters.

The consumer trusts its pinned MCP connection and the appended-event response. This receipt is not
a separately signed portable attestation. In live mode, the seal must equal the explicit expected
credential name and the Worker signature verdict must be `verified`. Scratch accepts only `local`.
`--sealed-by` must use the **actual credential name**: admin-issued credentials normally produce
`pinned:<project> · hermes for <member>`, not the literal shorthand `pinned:hermes`.

Hermes v0.22.3 preserves `structuredContent` alongside display prose in its MCP result wrapper and
delivers `result`, `status`, request id and tool-call id to `post_tool_call`. The plugin reads that
machine structure only. A missing post-hook leaves a pending call and blocks dependent tools; an
explicit failed result permits only provenance retries. A fresh session currently starts with its
own successful `retrace_instruct` receipt; binding a pre-existing routed root is additional work
before delegated/routed builder use.

The research tool policy is narrower than filesystem isolation. It rejects symlink paths, traversal,
hidden config paths and arbitrary executable tools, with one read-only hidden-path exception for the
seat's root `.hermes.md` identity file. A same-user process can race filesystem checks. No such process
is authorized by this mode. Host isolation and credential custody remain admission work.

## Remaining knowledge work

The selected source exposes skill lifecycle facts after a successful change. Native skill ledger
failures do not block mutations, and the ledger normally trims old entries. Those observations alone
cannot establish the plan's approved, attributable knowledge-loading contract. Turning on native
memory/skills now would give a stronger impression than the controls support.

The next persistence change must bind a proposal's source references and before/after hashes to an
approval receipt, make activation conditional on that receipt, check the approved manifest at restart,
and retain correction history outside the mutable active entry. It must cover both explicit writes
and background learning. No auto-approval or profile switch may substitute for these checks. K1/K2
and full primary-seat admission remain open until that change is implemented and measured.

## Validation and routing

Run `npm run test:hermes` for offline plugin/launcher tests. Set `HERMES_SRC` to the selected source
for the required scanner and serializer checks; without it those tests skip and runtime qualification
is incomplete. The suite verifies pinned source bytes before exercising those two upstream functions.
Launcher tests use throwaway Git fixtures, disabled fixture hooks, scratch paths and stand-in
processes; they do not install or launch a real Hermes session.

Run the MCP receipt, server, producer-signing, admin and dispatch suites after rebuilding the isolated
worktree. The receipt integration test uses an in-memory Worker handler and synthetic key/token;
its fetch shim refuses other destinations. It proves the projected seal came from that handler,
not that a live credential exists.

After normal design/code review, run Gates 0 and 1a on the exact installed source/build. Prepare a
bounded real-model budget brief for Gate 1b. Only after those pass should the reviewed owner step
provision or reuse Hermes's live credential. Gate 2 and the clean-shell/restart pilot follow.
The knowledge implementation and K1/K2 must land before calling initial onboarding complete.
