---
name: retrace-pr
description: Write a Retrace pull request body built for fast human review (what and why, how to verify, class and surface, follow-ups, Retrace-Caused-By, Refs), refuse the known body defects mechanically, then declare, run and read back the GitHub write under agent-ops 19.
---

# Retrace PR body

This skill is a builder's tool for opening or updating its own pull request. It writes a body that lets a reviewer
see the change, its risk and its proof quickly, and that meets Retrace's body rules. It is adapted from the `pr`
skill in github.com/mattpocock/skills (MIT); no text was copied. Design: `docs/design/review-system-skills.md`.

## Inputs

- The branch head (full SHA), the base (`origin/main`), and the brief that dispatched the work.
- The human `instructed` event id the brief names for `Retrace-Caused-By`. Read it raw first, as agent-ops 20(c)
  requires: `actor.type: human`, `actor.id` `jordansboxing@gmail.com`, `action: instructed`, and text that names the
  task. A bare go fails this check.
- The class (a/b/c, agent-rules 12) and the surface (`.claude/skills/review-effort/routing-rules/1.json`).

## Compose

Write the body to a scratch file, never in the repository, in this order:

1. **What changes and why.** Two to five sentences. Lead with the effect, then the reason. Name the finding, issue or
   instruction it answers.
2. **Where to look first.** The one or two places a reviewer should read first, and the **merge danger**: what would
   break, and for whom, if this is wrong.
3. **How to verify.** Commands a reviewer can run at the head, each with its expected result. Every number and every
   completeness claim in the body ("14 tests", "all callers", "covers") has its command here, or comes out
   (`CODING_STANDARDS.md` CS-9).
4. **Class and surface.** For example `Class (c), surface S`, with the reason when it is not obvious.
5. **Rounds.** Fix rounds only: one paragraph per round, naming the verdict event, the go and what changed. Earlier
   paragraphs stay as written (agent-rules 10).
6. **Follow-ups.** Anything left undone, as "Refs #N" or as text.
7. **Trailers.** `Retrace-Caused-By: <instructed id>` on its own line. The webhook reads the **first**
   `Retrace-Caused-By: evt_` line, so no other id may come before it.
8. The Claude Code attribution line from the session's attribution reminder, last.

The title carries the class in parentheses, as recent titles do: `fix(worker): … (#232, class c)`.

## Refuse before declaring

Run these on the scratch file. Any hit stops the skill until the body is fixed:

- `grep -niE '\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b:?\s+(#|[a-z0-9_.-]+/[a-z0-9_.-]+#)[0-9]+' <body>` must find
  nothing. Use "Refs #N".
- The first `Retrace-Caused-By:` line names the event read raw above.
- A class and a surface are stated.
- The last non-empty line is the Claude Code line.
- No credential, token or secret-shaped value, and nothing CS-10 excludes.

## Declare, run, read back (agent-ops 19)

1. Hash the body after normalisation: UTF-8, `\r\n` → `\n`, trailing whitespace stripped from each line, trailing
   newlines removed.
   `python3 -c 'import sys,hashlib;t=open(sys.argv[1],encoding="utf-8").read().replace("\r\n","\n");t="\n".join(l.rstrip() for l in t.split("\n")).rstrip("\n");print(hashlib.sha256(t.encode()).hexdigest())' <body>`.
   Hash the title the same way.
2. `retrace_log` under your own credential: the pull request (or, for a new one, the branch) as an artifact,
   `caused_by` your receipt, `actor.model` and `model_source` set, and `method.params.github_action`
   `{kind: "pr_create" | "pr_edit", repo, login, pr, content}`, with the body and title sha256 in `content`. Wait
   for the event id.
3. Run the write. Create: `gh pr create --base main --head <branch> --title <title> --body-file <body>`. Edit:
   `gh api -X PATCH repos/jordandru/retrace/pulls/<n> -F body=@<body> -f title=<title>`, because `gh pr edit` fails
   on this repository.
4. Read it back with `gh api repos/jordandru/retrace/pulls/<n> --jq .body`, normalise and hash it, and compare. Log the
   outcome (`executed`, with `github_action.result`). If the hashes differ, say so and stop.

## Never

- Never request a review, merge, or comment from this skill. Review routing is the coordinator's (agent-rules 11).
- Never declare content you did not write.
- Never push to the branch between a declaration and the write it declares.
