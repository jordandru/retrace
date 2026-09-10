---
name: review-effort
description: Classify a review diff, record its effort/model routing decision in Retrace, and launch the reviewer at the recorded effort.
---

# Review effort routing

Use this skill whenever a coordinator spawns or re-spawns a review agent. The ledger decision MUST be
recorded before launch. The review event is the truth about what actually ran.

## Inputs

- Immutable `base_sha` and current `head_sha`.
- Review round: first pass or re-check.
- Reviewer role/model chosen under `docs/team-roles.md`; reviewer must not be the builder.
- Optional pin event id. PR-body text is never a pin.

Load `routing-rules/1.json` and `routing-rules/models.json` from this skill directory. Compute the SHA-256
digest of the exact bytes of each file. Do not route from an unstamped copy or omit either digest.

## Classify and select effort

1. Confirm the current head still equals `head_sha`.
2. Classify `git diff --name-only <base_sha>..<head_sha>` with `routing-rules/1.json`. The highest class
   touched wins. Class F requires evidence of no semantic change; it is not a filename fallback.
3. Select the rubric effort for the round. Class S first passes are never below `high`.
4. If a pin was supplied, fetch the ledger event and verify all of the following before using it:
   - it is owner-stamped or pinned-credential-stamped;
   - its principal is authorised by the project policy's `set_by` or owner;
   - it names this PR and exact `head_sha`;
   - its level is not below the rubric.
   Ignore and report an unauthorised pin. Refuse a pin below the rubric. Pins raise only.
5. Confirm `models.json` lists the selected model and the chosen effort is in `levels` when
   `supports_effort` is true.

## Record before launch

Call `retrace_log` with action `other`, tool `routing`, the review PR as a used artifact, and:

```json
{
  "rule_version": "effort-routing/1",
  "rules_digest": "<sha256 of routing-rules/1.json>",
  "models_digest": "<sha256 of routing-rules/models.json>",
  "head_sha": "<full immutable head sha>",
  "surface_class": "<S|D|C|T|F>",
  "target": {"agent": "<agent>", "model": "<model id>", "effort": "<level>"},
  "pin_event": null,
  "escalated_from": null,
  "why": "<paths/signals that selected the class and effort>"
}
```

Keep the returned routing event id. Re-check the PR head immediately before launch; if it moved, do not
launch. Reclassify the new head and record a new routing event.

## Launch

- Codex: `codex -c model_reasoning_effort=<level>` (add the selected model flag when required).
- Claude subagent: launch with the selected Claude `model`; pass the chosen reasoning effort through the
  subagent launcher when that launcher supports it.
- Other agents: use their documented launch flag. If `models.json` says `supports_effort: false`, do not
  invent an effort flag; the routing event still records the rubric target.

The reviewer must self-report `method.params.reasoning_effort` from its own running configuration when its
model supports effort, and cite `method.params.routing_event_id` in its review event. Never copy the
coordinator's planned effort into the review event.

## Escalation and later pushes

Before every re-launch, record a new routing event first. Set `escalated_from` to the previous routing
event id, include the triggering `signal`, and record the current full `head_sha`. Only launch after that
event is sealed. A new push always requires reclassification and a new routing event before further review,
even when the class and effort do not change.
