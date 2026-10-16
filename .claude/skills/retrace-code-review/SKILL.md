---
name: retrace-code-review
description: Builder's pre-review self-check of a diff against CODING_STANDARDS.md and against the dispatching brief. Reports to the builder only; never a verdict, never a review seat, never posts to GitHub.
---

# Retrace code self-check

A builder runs this on its own diff before asking for review, and again before each fix-round push. It catches the
classes of mistake that past review rounds found, so that a reviewer's round is not spent finding them again. It is
adapted from the `code-review` skill in github.com/mattpocock/skills (MIT): the same two axes, with Retrace's brief in
place of the spec. No text was copied. Design: `docs/design/review-system-skills.md`.

**This is not a review.** It never counts toward a gate (agent-rules 11 and 12). It never logs `approved` or
`rejected`, never uses the `review` tag, never cites a routing event, and never writes to GitHub. A clean result says
only that these checks found nothing.

## Inputs

- `base` (normally `origin/main`) and the full `head` SHA. Commit first, so the check runs on what will be pushed.
- `CODING_STANDARDS.md` at the head. Record its sha256.
- The dispatching brief, by path and sha256.

## Axis 1: standards

For each rule in `CODING_STANDARDS.md`:

1. Decide whether the diff `git diff <base>..<head>` touches what the rule governs. If not, mark it **n/a** with the
   reason.
2. Run the rule's stated check exactly: the command it gives, or the reading test it states. Do not invent a stricter
   or looser check.
3. Mark it **pass** with the evidence, or **fail** with `file:line` and what the check found.

## Axis 2: the brief

1. List every requirement in the brief, numbered as the brief numbers them.
2. For each one, give the `file:line` or test that meets it, or **missing**.
3. List every changed path the brief does not ask for. Each one is either justified in one line or removed.
4. Check every number and completeness claim in the PR body or notes against a command run at the head (CS-9).

## Where it runs

Run every check in your own session, where each command is logged under agent-rules 2. Do not hand the checks to a
subagent.

## Report and log

1. Write the report to the scratchpad, never into the repository. Give a table of rule → n/a / pass / fail with
   evidence, the brief table, and a one-line bottom line: `SELF-CHECK: <n> fail, <n> pass, <n> n/a`.
2. Log one event under your own credential: action `executed`, `method.tool` `retrace-code-review`, `tags`
   `["self-check"]`, `caused_by` your receipt, `actor.model` and `model_source` set. `method.params` holds `base`,
   `head`, `standards_sha256`, `brief_sha256` and the counts. List the files checked as `role: used`.
3. Fix every **fail** before asking for review. If you decide not to fix one, the PR body says which rule, and why.

## When a rule seems wrong

Do not edit `CODING_STANDARDS.md` in a feature PR. Write the objection in the report. The coordinator takes it to
`retrace-retro` or a class (a) PR.
