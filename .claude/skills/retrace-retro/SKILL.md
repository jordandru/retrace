---
name: retrace-retro
description: After a pull request merges, read its review verdicts from the ledger and propose, as text for the coordinator, the standard, automated check or brief correction that would have caught each finding before review. Proposes only; edits nothing.
---

# Retrace retro

Run this after a PR merges, especially one that took more than one review round. Every blocking finding cost a round.
The question this skill asks is what in the *system* would have caught that finding before review: the standards,
the checks, or the brief. It is adapted from the `retro` skill in github.com/mattpocock/skills (MIT), changed to work
per pull request and from sealed verdicts. No text was copied. Design: `docs/design/review-system-skills.md`.

## Inputs

- The merged PR number `<n>` and its merge commit.
- The coordinator's request, by event id, which goes in `caused_by`.

## Gather

1. List the PR's verdict events from the ledger: `action=rejected` and `action=approved` through the Worker's list
   route. Keep the events whose artifacts name `pr:jordandru/retrace#<n>` or
   `https://github.com/jordandru/retrace/pull/<n>`. Read each one raw (`GET /events/<id>`). The model-facing history
   views hide ids and hashes.
2. For each verdict, find its text. Use the verdict file it or its fix brief names, if that file still exists and its
   sha256 matches. Otherwise use the event's `intent`, and say that the text was not available. Never reconstruct a
   finding from memory.
3. Record each finding's seat, round, severity, verdict event and one-line summary.

## Ask, per finding

Ask this for every Medium and High, and for any Low that also appeared on an earlier PR:

1. **Was there already a standard for this?** If so, did the builder's `retrace-code-review` run apply it? A missed
   check is a self-check gap, not a new rule.
2. **Was this the brief's fault?** For example, an allowance the coordinator had to withdraw (PR 244 round 1). Propose
   the brief correction.
3. **Could an automated check catch it?** A test, a lint or a CI step, named concretely, with its expected
   false-positive cost.
4. **Otherwise, propose a standard.** Write one rule, its source (PR, round, seat, severity, event), and its check:
   a command, or a reading test two readers would apply the same way. If no check can be stated, it is not a
   standard; say so and propose nothing.
5. **Before any addition, ask what to remove.** Is there an existing rule this finding shows to be wrong, redundant
   or unchecked? Prefer removing a claim to adding a rule.

## Output

1. Write `RETRO-PR<n>.md` in the coordinator's ops directory for the day. If none is named, use the scratchpad. List
   proposals most severe first, each with its source and check. "No proposal", with the reason, is a valid result.
2. Log one event under your own credential: action `created`, `method.tool` `retrace-retro`, the proposal file as
   `role: generated`, each verdict event read as `role: used`, and `actor.model` and `model_source` set.
3. Stop. The coordinator decides what to do with the proposals. Any change to `CODING_STANDARDS.md` or to these skills
   goes through a class (a) pull request (agent-rules 12).

## Never

- Never edit `CODING_STANDARDS.md`, a skill, a brief or any repository file.
- Never seal a verdict, use the `review` tag, open an issue or PR, comment, or send a pane message.
- Never re-litigate a merged verdict. The retro is about the next PR, not this one.
