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
  "recorded_by": "reviewer"
}
```

`recorded_by` is `"coordinator"` only when the child could not record; say why in `intent`. `intent` carries the verdict summary and the findings in prose.

## 3. Gap event — when the workflow stops before a verdict (coordinator)

`retrace_log`, action `other`, tags `["orchflows", "review-gap"]`, the candidate as a `used` artifact, `method.tool` `"retrace:retrace-review"`, `method.params` `{ "stage": "<precondition|routing|review>", "result": "stopped", "missing": "<what was absent or refused>", "child_launched": false, "head_sha": "<sha or null>" }` plus any settings resolved before the stop. **Omit `routing_event_id` entirely** when no routing event exists: the server rejects `null` for that field (typed non-empty string), and the same applies to `reasoning_effort`. `null` is accepted only where §1 shows it.

## 4. What these events do and do not establish

- They bind a verdict to the inspected state and to the assignment that produced it. A later change does not inherit the verdict.
- They record that a **fresh child of the same credential** reviewed. They do not record a second seat, a second credential or a second vendor. In a repository governed by Retrace's `docs/agent-rules.md`, rule 11 (whoever built it does not review it) is not satisfied by them, because the seat is the same.
- Model and effort in §1 are what the coordinator launched; in §2 they are the child's self-report. Neither is witnessed by the host. Orchflows' `history inspect` can read the host's native transcript afterwards; a checker may compare, locally, and must never upload transcripts.
- Server stamps (`sealed_by`) and producer signatures are whatever the host's Retrace credential provides. A generic installation has server-stamped, unsigned events; this is stated by the ledger, not by this library.
