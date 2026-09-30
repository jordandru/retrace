# Retrace events for orchflows assignments

Agent-facing contract for the `retrace` library. Owner of the shapes: `docs/design/orchflows-integration.md` §4 in the Retrace repository, which mirrors `docs/design/effort-model-routing.md` §5. Field names here are exact.

Every event carries `caused_by` = the instruction event for the task, and the host's own actor and model (report the model the harness exposes, verbatim; omit it otherwise).

## 1. Routing event — before the reviewer launches (coordinator)

`retrace_log`, action `other`, `method.tool` `"routing"`, the candidate as a `used` artifact (`commit:<owner>/<repo>@<sha12>` or the artifact id), and `method.params`:

```json
{
  "rule_version": "effort-routing/1",
  "rules_digest": "<sha256 of routing-rules/1.json, or null when the repository has none>",
  "models_digest": "<sha256 of routing-rules/models.json, or null>",
  "head_sha": "<full 40-hex sha, or null for a non-commit candidate>",
  "candidate": "<artifact id when head_sha is null>",
  "surface_class": "<S|D|C|T|F, or null when unclassified>",
  "target": { "agent": "<host seat actor id>", "model": "<model the child is launched with>", "effort": "<level or null>", "child": "native-subagent", "host": "<claude-code|codex|...>" },
  "independence": "same-credential-fresh-context",
  "workflow": "retrace:retrace-review",
  "pin_event": null,
  "escalated_from": null,
  "unmatched_paths": [],
  "why": "<paths or signals that selected the class and effort; or 'caller settings' when no rubric>"
}
```

`rule_version` is `"caller/1"` with null digests when the repository has no routing rules. Pins raise only. A candidate that changes after this event needs a new routing event.

## 2. Verdict event — after review (the reviewer; the coordinator only when the child cannot reach Retrace)

`retrace_log`, action `approved` or `rejected`, tags `["review", "orchflows"]`, every reviewed file as a `used` artifact plus the candidate, `method.tool` `"orchflows"`, `method.params`:

```json
{
  "routing_event_id": "<id from §1>",
  "reviewed_head": "<full sha, or the candidate artifact id>",
  "reasoning_effort": "<level from the reviewer's own running configuration, or 'not_exposed'>",
  "independence": "same-credential-fresh-context",
  "workflow": "retrace:retrace-review",
  "recorded_by": "reviewer",
  "child_id": "<the host's native id for the reviewer child, when the host exposes one; omit otherwise>"
}
```

`recorded_by` is `"coordinator"` only when the child could not record; say why in `intent`. `intent` carries the verdict summary and the findings in prose. `child_id` is what a later local check against the host's native transcript keys on (design note §7); in trial run 3 on Claude Code the child recorded no `child_id` and none was available to the coordinator at launch. When the host exposes it to the child, the child records it here. When only the transcript reveals it afterwards, it goes on a **separate, append-only child-observation event** (§2a below) — never onto the routing event, which is sealed before launch and cannot be rewritten: `retrace_log` only appends, and `retrace_amend` (Retrace `packages/mcp-server/src/index.ts:260–267` at `0d294eb`) carries attribution, artifact-role and causal-root attestations, not `method.params`.

## 2a. Child-observation event — when `child_id` is learned after the verdict (coordinator, optional)

`retrace_log`, action `other`, tags `["orchflows", "child-observation"]`, artifacts: the candidate as `used`, the routing event as `event:<routing id>` `used`, and the verdict event as `event:<verdict id>` `used` when one exists; `method.tool` `"retrace:retrace-review"`; `method.params` `{ "routing_event_id": "<routing id>", "verdict_event_id": "<verdict id or omitted>", "child_id": "<the host's native id>", "source": "<host|transcript>" }`. The routing event and the verdict event are left exactly as sealed; the observation joins them by id. A future witness (design note §7) reads this event, not the routing event, to find the child. Until a host exposes an id or a transcript reveals one, no observation event exists and the review is simply unwitnessed — say so rather than invent an id.

## 3. Gap event — when the workflow stops before a verdict (coordinator)

`retrace_log`, action `other`, tags `["orchflows", "review-gap"]`, the candidate as a `used` artifact, `method.tool` `"retrace:retrace-review"`, `method.params` `{ "stage": "<precondition|routing|review>", "result": "stopped", "missing": "<what was absent or refused>", "child_launched": <false | true | "unknown">, "head_sha": "<sha or null>" }` plus any settings resolved before the stop, plus `routing_event_id` and `child_id` whenever they are known. `child_launched` is **observed, not assumed**: `false` only when the stop came before any launch (`precondition` or `routing`, or a `review`-stage refusal of the launch itself); `true` when a child was launched and then exited, failed, or returned without recording a verdict — that run is history the library exists to keep, and it is recorded as such, with the routing id it ran under; `"unknown"` when the coordinator cannot tell whether the launch happened (say why in `intent`). The manual trial specification covers both shapes: a pre-launch refusal and a post-launch failure. **Omit `routing_event_id` entirely** when no routing event exists: the server rejects `null` for that field, and the same applies to `reasoning_effort` — both are `z.string().min(1).optional()` in Retrace `packages/core/src/schema.ts` (lines 133–135 at `0d294eb`). `null` is accepted only where §1 shows it.

## 4. What these events do and do not establish

- They bind a verdict to the inspected state and to the assignment that produced it. A later change does not inherit the verdict.
- They record that a **fresh child of the same credential** reviewed. They do not record a second seat, a second credential or a second vendor. In a repository governed by Retrace's `docs/agent-rules.md`, rule 11 (whoever built it does not review it) is not satisfied by them, because the seat is the same. Retrace's `doctor` at `0d294eb` does not read `independence` and counts a §2 event as a review (`doctor.ts:240–246`); the design note §6 is the fix, and until it lands a gated repository's merger must read the field by hand.
- Model and effort in §1 are what the coordinator launched; in §2 they are the child's self-report. Neither is witnessed by the host. Orchflows' `history inspect` (`docs/history.md` at `6eb8af4120a1b9bdb8ff971705d80be02a62b432`) can read the host's native transcript afterwards; a checker may compare, locally, and must never upload transcripts ("Keep raw history local", same file).
- Server stamps (`sealed_by`) and producer signatures are whatever the host's Retrace credential provides. A generic installation has server-stamped, unsigned events; the ledger event itself carries `sealed_by`, which a reader can inspect. `sealed_by` is a server stamp only; in a generic installation it does not cryptographically bind the event to a producer key. The library does not add a signature.
