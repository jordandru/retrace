# Review-system skills: standards and builder aids (design note v1)

**Status:** v1, 2026-10-16. Class (a), surface S. Author claude-code (builder under Coordinator 34). Owner's request
`evt_6c8a5d09cc2449699264681e51922937`; launch go `evt_a982651c4de44513b9642f11a1e0669c`.

## 1. The problem

Review is Retrace's bottleneck, and the rounds show it. PR 248 (issue #232) took four rejected Codex rounds in one
day. Each round found a different class of mistake:

| Round | Finding | Verdict event |
|---|---|---|
| r1 | a malformed signing key leaked through the runtime's error text | `evt_73cc3ae7563f45729002cd113cebc344` |
| r2 | a secret-bearing JWK spread into a public response | `evt_21e248530eac4ec79e9be6fb6cb45e9f` |
| r3 | the pair check guarded one path of five | `evt_b320ac71630b4da7baab3f1e09f2b7f8` |
| r4 | a check-then-cache race across an `await` | `evt_5c175362fdda479b93a37178c141f30f` |

PR 244 took two rounds, and its first round found a High (`evt_96aed167513140beaaf5a41904ed6304`). Each of these
classes could have been written down once and checked before review. Reviewers find them at the cost of a full round
each.

The idea Jordan pointed at is to **review the system that produces the code, not just the code**. When a reviewer
finds something, ask what would have caught it before review, and change that.

## 2. Sources, and what this note does not claim

- aihero.dev/skills was read on 2026-10-16. The page names `/pr` ("writes reviewable PR bodies") and `/retro`
  ("improves your agent's environment"). It does not describe "review the system", `/improve-codebase-architecture`,
  `/code-review`, `CODING_STANDARDS.md` or `/show-me`. It links its source, github.com/mattpocock/skills (MIT).
- That repository's README describes the following. `code-review` "reviews the diff on two axes, Standards and Spec".
  `pr` covers a summary, before/after evidence and a merge-danger call. `retro` suggests "improvements to the coding
  agent's environment (navigation, automated checks, coding standards, steering files, tooling) … most severe first".
  `improve-codebase-architecture` "scans a codebase for deepening opportunities". `codebase-design` holds the
  deep-module discipline, from Ousterhout: "The best modules are deep."
- github.com/humanlayer/skills (MIT): `show-me` "explains the current topic with concise diagrams, code-shape
  sketches, and focused HTML artifacts".
- **The talk "Fixing the PR Bottleneck" (youtu.be/LlgiOCmFG_w) was not reachable as text.** The page returned no
  transcript or description. Nothing here is attributed to it beyond its title and the phrase Jordan quoted.
- No skill file was copied. The three skills here are written for Retrace and cite their sources.
- This note claims no improvement. Whether review rounds go down is measured in §6, after the fact.

## 3. Boundaries

1. **A self-check is a builder's pre-review aid, and never a review seat.** `retrace-code-review` does not count
   toward any gate in agent-rules 12 or `docs/team-roles.md`. It never logs `approved` or `rejected`, never carries
   the `review` tag (doctor counts any review-tagged event as a verdict), never cites a routing event, and never posts
   to GitHub. Agent-rules 11 is unchanged: the reviewer of record is a different seat, and its ledger event is the
   verdict. A reviewer may cite `CODING_STANDARDS.md`. A builder's clean self-check is not evidence that the review
   would have passed.
2. **Standards are governing.** `CODING_STANDARDS.md` changes how every seat writes code, so it takes the design gate
   (class (a)), like the agent rules. A retro *proposes*; the coordinator writes the change; the gate decides.
3. **Ledger first.** Each skill's acts are logged under the seat's own credential (agent-rules 2), with files named as
   `repo:jordandru/retrace#<path>`. GitHub writes are declared before they run (agent-ops 19).
4. **The PR-body rules stay as they are.** The class is stated (agent-rules 12). There is a `Retrace-Caused-By:` line
   naming a human `instructed` event, and the first such line is the one the webhook reads. Issues are referenced as
   "Refs #N", never with a closing keyword. `retrace-pr` encodes these rules; it does not change them.
5. **Who runs a skill does not change.** Builders run `retrace-pr` and `retrace-code-review`. The coordinator, or a
   seat it routes, runs `retrace-retro` after a merge.

## 4. Decisions

| Idea | Decision | Why, and how it fits |
|---|---|---|
| Review the system, not just the code | **Adopt** | It becomes a loop. A blocking finding → `retrace-retro` proposes a standard or check → a class (a) PR → `retrace-code-review` checks it before the next review. Verdicts stay the evidence; the system changes only through the gate. |
| `CODING_STANDARDS.md` | **Adopt, constrained** | v1 has 11 rules, each tied to a verdict (PR, round, seat, severity, event) and each with a stated check. Rules without a finding behind them are left out (see the file's last paragraph). |
| `/code-review` (diff vs standards) | **Adapt** → `retrace-code-review` | Two axes, as in the source: the standards, and the *brief* in place of the spec. The diff does what the brief asks and nothing more. It reports to the builder only (§3.1). |
| `/pr` (reviewable body) | **Adapt** → `retrace-pr` | The source's summary and merge-danger call, plus Retrace's required parts: class and surface, `Retrace-Caused-By`, "Refs", a command behind every number (CS-9), the agent-ops 19 declaration and read-back, and the Claude Code line. |
| `/retro` (suggest checks and standards) | **Adapt** → `retrace-retro` | It runs per merged PR, on its verdict events rather than a session. Its output is text for the coordinator, and it edits nothing. It looks for something to remove before it proposes something to add. |
| `/improve-codebase-architecture` (deep modules) | **Skip for v1; follow-up** | It produces large refactors, and each would be a class (c) diff that costs review rounds, which is the bottleneck this note targets. But PR 248 r3 is a deep-module finding: the signing key reached five paths (the public-key route, the signed head, a fresh export, producer signing and the scheduled checkpoint), and the guard covered one. A narrower follow-up is worth an issue: a read-only report of *security-relevant effects with more than one entry point*, filed as issues and never auto-refactored. |
| `/show-me` (diagrams, HTML) | **Skip for v1** | Retrace's reviewers (Codex, NOOA) read text packets with hashes, and a rendered artifact is not in the record ("rendered Markdown is not the record", NOOA's verdict form). It may help Jordan read a design. That is a separate request, and the MIT source would need its own adaptation. |

## 5. The three skills

- **`.claude/skills/retrace-pr/SKILL.md`** composes the body in a scratch file and runs mechanical refusals:
  - no closing keyword;
  - the first `Retrace-Caused-By` names a human `instructed` event, read raw;
  - a class and a surface are present;
  - the Claude Code line is last.

  It then hashes the body with agent-ops 19's normalisation, declares the write, runs it and reads it back.
- **`.claude/skills/retrace-code-review/SKILL.md`** takes the diff `<base>..<head>`, applies each standard's stated
  check and the brief axis, and reports pass / fail / not applicable per rule with `file:line` evidence. It logs one
  `executed` event tagged `self-check`. Fresh-context helpers, when used, read only and never call the retrace tools.
- **`.claude/skills/retrace-retro/SKILL.md`** takes a merged PR number. It reads every verdict event for the PR raw,
  and the verdict text where it survives. For each Medium or High, and for any Low that recurs, it names what would
  have caught the finding earlier:
  - an existing standard the self-check missed;
  - a new standard, with its check;
  - an automated test or CI check;
  - a brief correction (PR 244's withdrawn allowance is the example).

  It writes a proposal file for the coordinator and stops.

## 6. How we will know

The baseline is PRs 225–248, counted from ledger verdicts: rejected rounds per merged class (c) PR, and blocking
findings that fall under a CS rule. The coordinator recounts over the next ten merged class (c) PRs. Until then, this
note claims only that the loop exists.

## 7. Follow-ups (not in this PR)

1. A CI check that refuses closing keywords in pull request bodies, the mechanical form of the `retrace-pr` refusal.
   Its regex was run on the bodies of PRs 238, 241–245, 247 and 248. It hit exactly one line, PR 247's "The coordinator closes
   #188, …", and nothing else.
2. The read-only multi-entry-point report from §4, as an issue.
3. No CI step for CS-3 or CS-10 yet. Both greps were run over the last twelve merges into main. Each hit only text
   the rule allows (PR 235's rest pattern into an import; PR 181's `127.0.0.1` and `0.0.0.0`). So both stay locators for a
   reading test rather than gates.
