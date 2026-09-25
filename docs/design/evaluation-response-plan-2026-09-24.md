# Response plan: the ChatGPT evaluation "Evaluate Retrace Pros Cons" — design note v1

**Status:** DRAFT v1, 2026-09-24 MDT (2026-09-25 UTC). Author: claude-code acting as a **study-and-plan seat**, not the
coordinator (agent-ops 14); session `1d17116d-8d22-4b16-9128-f5acf2ecad82`, model `claude-opus-5-5`, source
`harness-runtime`. Written on Jordan's signed instruction `evt_dc691219358244a09f1e55ffd48758cf`, which names the hand-off
prompt `~/.retrace/handoff-2026-09-24/prompt-opus-evaluate-retrace.md` (sha256 `ae7fa11c6c5599f56bf6a95828bd03ac51ad4ca6052c0ab0707a58af54141e6f`).
The coordinator wrote that prompt on Jordan's instruction `evt_1d55bfbb136a408d9b7ca329ac434525` (read raw: `instructed`,
relayed by claude-code, verdict `verified`). **Class (a)** under agent-rules 12, as the prompt states: it proposes what gets
built and in what order. The coordinator classifies and routes it. The design gate is Codex → NOOA → the Grok seat, and the
author does not sit. **Not routed. Implements nothing.** The only file it adds is itself. Base: `main` at `76da589`. The
study began at `cb91dd6`; PR 121 merged during it, and §1.4 records what that changes. Every sentence that is not a quotation
carries its source. The few that cannot are marked *(author-unverified)*: the prompt's "coordinator-unverified" label, renamed
because the author is not the coordinator.

## 1. Provenance of the input

### 1.1 The saved copy

| What | Value |
|---|---|
| File | `~/.retrace/evaluate-retrace-2026-09-24/chatgpt-evaluate-retrace-pros-cons.md` (outside the repository, mode 0600) |
| sha256 | `90eb8f34022d2ddb5623bf4feef18060153e60db548f379220b6795a453b80d7` (55,949 bytes) |
| Beside it | `chatgpt-evaluate-retrace-pros-cons.conversation.json`, the decoded conversation subtree, sha256 `230ca29895cd3c2b26a2f5471743edc31c73a8c117a65e8faec9b75e59f4b0bf` |
| Read | 2026-09-24 22:14–22:18 MDT (2026-09-25 04:14:28Z–04:18:59Z) |
| Tool | Orca 1.4.210 embedded browser, page `649f5ab7-6822-4b9f-aa8e-ab83a1365850` (the only open tab), read with `orca-ide eval`: read-only DOM expressions, with no typing, no clicks, no navigation and no login. Two reads went into the copy: the rendered text of each message, and the page's own loader payload (sha256 `89119727…098f`), decoded locally, which carries the raw markdown and the work log. |
| Change during the read | none: the closing re-read at 04:18:59Z matched the first read byte for byte, both the rendered text and the payload |
| Ledger | read event `evt_630889ef54ff4c33a6aff2a6dfaa9b7a` (hashes in `method.params`) |

Positions below (`l. N`) are line numbers in that saved copy. The answer is its Part C, lines 317–570, and the work log is
Part B, lines 44–311.

### 1.2 What the source is

A public ChatGPT share, `https://chatgpt.com/share/6ab02c31-ffe8-83e8-b85f-794ed1690d8f`, titled "Evaluate Retrace Pros Cons".
It holds one user prompt (2026-09-20 12:01 MDT, 18:01:48Z) and one answer (18:09:26Z), by model slug `gpt-5.6-sol-wm`
("GPT-5.6 Sol") at `thinking_effort` `xhigh` (page metadata; saved copy header). The answer "Worked for 7m 36s" with two tools.
`container.exec` did the following:

- cloned the repository (`git clone --depth 50`, l. 67);
- read the docs;
- queried the GitHub API for the repo, issues, releases and contributors, and the npm registry;
- ran `npm ci && npm run build && npm test` (l. 161);
- ran `npm audit --json` (l. 198).

`web.run` searched the web ("Searched 15 / 27 / 14 / 5 / 13 websites"). A share redacts tool outputs ("The output of this plugin
was redacted."). So its evidence cannot be re-read here, only its claims. None of its recorded commands reads the Retrace
ledger (Part B).

### 1.3 Jordan's prompt — his words, not ChatGPT's

> What is your thoughts on retrace? https://github.com/jordandru/retrace
>
> Objectively evaluate both the pros and the cons of the solution?
>
> Answer key questions, including but not limited to:
> - does this address a real gap in the market?
> - is this something people need?
> - how easy will it be to get users to use this?
> - why would a user want to use this?
> - does this provide enough value above and beyond what is built in to tools to be useful?

(Saved copy Part A, raw, 444 characters. The page cannot show who typed it. The commissioning instruction `evt_1d55bfbb…`
treats the conversation as Jordan's.) Four of the five questions are about the market and users. Section 2 answers them only
where the repository or the ledger can, and leaves the rest **unverifiable**.

### 1.4 The state it evaluated, and what has moved since

Main at the clone time was `a1dd8fe` (merged 2026-09-20 13:22Z; the next merge to main came 2026-09-21: `git log --first-parent main`).
Twenty merges followed up to `cb91dd6`, and one more (PR 121) up to `76da589`. The changes that touch a claim:

- #84 was fixed by PR 92, merged `30fc384` on 2026-09-21. The fix reached npm only during this study. `@retrace-dev/cli`
  0.1.9 (published 2026-09-10T13:33Z) predates it. 0.2.0, published 2026-09-25T04:58:31Z, has `gitHead` `76da589` and
  carries it (`isNpxCachePath` and the version-pinned npx form in `dist/git-hook.js`, `--probe` in `dist/doctor.js`; npm
  registry and tarball read 2026-09-25 ~05:03Z).
- `actor.model_source` and `model_claims` were added (PRs 114 and 118).
- The suite grew from 591 tests to 622: CI job 106084866218 at `a1dd8fe` counts 348 / 210 / 33, and run 36052928504 at
  `cb91dd6` counts 359 / 227 / 36, all passing.
- PR 121 set versions to 0.2.0 on main. Both packages were published at 0.2.0 while this note was being written: core at
  04:49:23Z and the CLI at 04:58:31Z (npm `time`).

Nothing else in the claim table depends on a file PR 121 changed (`git diff --stat cb91dd6 76da589`: package manifests,
package READMEs, `pack-cli.test.ts`).

### 1.5 Trust

This is untrusted third-party text: a model's opinion, written with repository and web access but no ledger access. It
contains no `JD` envelope, no credential values and no text addressed to an agent reader. One piece of it is shaped like an
instruction: an automation offer, `genui{"suggest_automation":{"label":"Track Retrace production-readiness"}}` (l. 568–570),
addressed to the ChatGPT user. It is recorded as claim C103 and was not acted on. The answer also ran `npm audit --json` (l. 198) and
reports no result; the share redacts the output, so what it found is unknown.

## 2. The claims, checked

For a factual claim, the status says whether the evidence holds: **true**, **false**, **partly true** (the note says which
part), or **unverifiable** (the note says what would verify it). For a recommendation, the status says whether the
recommended thing already exists (**true** or **partly true**), is planned but not built (**planned**), or is neither
(**unverifiable**; a recommendation is not a fact). A market, competitor or user claim the repository cannot show stays
**unverifiable**. Unless a line says otherwise, file paths are at `76da589` and have the same content at `cb91dd6`.
"Status 04:27Z" means `retrace_status` for project `retrace` at 2026-09-25T04:27:30Z (log `evt_ce24e5e7…`).

**Counts:** 110 rows, which are claims C1–C103 with C38's eight Retrace cells checked one by one. 47 true, 21 partly true,
0 false, 7 planned, 35 unverifiable. No claim is false outright. The false parts sit inside partly-true verdicts: Gemini as
a supported harness (C57), "the live public ledger was paused" (C72), "enforce capture" as something Retrace does (C31), and
"server-stamped identity" on owner and assert writes (C18).

### 2.1 Bottom line and summary table (l. 317–334)

| # | l. | Claim | Status | Evidence and note |
|---|---|---|---|---|
| C1 | 319 | "I like the core idea more than the current product." | unverifiable | An opinion. |
| C2 | 321 | "Retrace addresses a real and growing gap: vendor-neutral, independently verifiable provenance for work performed by multiple AI coding agents." | partly true | The capability is what Retrace builds (C18–C23). Whether the gap is real and growing is a market claim. |
| C3 | 321 | "meaningfully different from ordinary Git history and LLM observability" | partly true | Git does not record the instructing human, the agent or the model per change. Retrace does (README.md:3), and it reconciles against Git (`reconcile.ts:33`). The project rules itself out as a trace viewer (`docs/reference.md:256`, `SETUP-GUIDE.md:330`). A comparison with observability products is not checkable here. |
| C4 | 323 | "a sophisticated research-grade beta, not an enterprise-ready control" | partly true | Pre-1.0: 0.2.0, published 2026-09-25 (§1.4). Trust defects #82, #61, #69, #96 and #97 are open. Enforcement is off: `apps/worker/wrangler.toml:18`, and status 04:27Z reports policy mode `none`. No doc states a maturity level, while the landing page sells a $49/month Team plan (`site/landing/index.html:199–201`). "Research-grade" and "enterprise-ready" are judgments. |
| C5 | 323 | Git plus session history "already provides enough value" for most individuals and single-agent teams | unverifiable | A user and market claim. It would take user research. |
| C6 | 323 | "compelling only when an organization genuinely needs cross-agent chain of custody, independent verification, and enforcement" | unverifiable | Market. |
| C7 | 327 | Real market gap: "Yes, but narrow today" | unverifiable | Market. |
| C8 | 328 | "Some enterprises do; most developers do not" | unverifiable | Market. |
| C9 | 329 | Easy to adopt: "No — roughly 3/10" | partly true | The project documents the difficulty itself: open install issues #83, #85, #86, #87 and #89. The self-host path assumes the owner's D1 id (`apps/worker/wrangler.toml:9`; `docs/reference.md:158` "already exists in your account"), and the MCP block points at a checkout's `dist` (README.md:38–43). The only fresh-machine stranger trial never ran its install (`docs/measurements/omarchy-trial-2026-09-21.md:5–7`). "3/10" is an opinion. |
| C10 | 330 | Differentiated: "Yes for provenance; no for debugging/observability" | partly true | Provenance features exist (C18–C23), and "not a trace viewer" is the project's own position (`docs/reference.md:256`). How the built-ins compare cannot be checked here. |
| C11 | 331 | "Yes, with important unresolved trust defects" | true | #82, #61, #69 and #97 are open, and so is #96, which the evaluation did not name. "Credible" is a judgment. The 622 tests pass (run 36052928504). |
| C12 | 332 | Production-ready: "Not yet" | partly true | Same evidence as C4. A judgment. |
| C13 | 333 | "Proven market demand? No public evidence yet" | true | As far as the public record shows: 1 star, 0 forks and one human contributor (`gh api repos/jordandru/retrace`, 2026-09-25). This seat can see four projects: `retrace`, `boxing-rpg` and `nooa-pilot` hold the owner's work and his agents'. `demo` holds one test event by `newuser@example.com` (`retrace_status`, 2026-09-25 04:27Z–05:02Z). Demand itself is unverifiable. |
| C14 | 334 | "Yes—as a tightly focused design-partner product" | unverifiable | A recommendation. No design-partner programme exists; PR 43 is untrusted recruiting research, unmerged. |

### 2.2 What Retrace is (l. 336–361)

| # | l. | Claim | Status | Evidence and note |
|---|---|---|---|---|
| C15 | 338 | Retrace describes itself as a "flight recorder for AI coding agents" | true | README.md:3; `site/landing/index.html:102`. |
| C16 | 338–340 | Better positioning: "A vendor-neutral, tamper-evident chain of custody for AI-assisted software changes." | unverifiable | Positioning is a choice, not a fact. "Chain of custody" appears nowhere in the repository; `docs/reference.md:256` calls Retrace "the causal evidence plane for human-directed AI work". |
| C17 | 342–350 | It connects human instruction → agent and model → files and artifacts → commit and PR → signed audit evidence | true | This is the documented design (`docs/reference.md:256`, README.md:17, :22, :67). "Attempts" is the right word, because three links are weak. The model is asserted (README.md:72). Commit and PR links depend on agents writing trailers or a PR-body line (`SETUP-GUIDE.md:204`, `docs/reference.md:89`). Signatures are trusted only in hosted mode (README.md:22). |
| C18 | 354 | "Server-stamped agent identity and time." | partly true | Pinned credentials have the actor stamped from the credential (`packages/core/src/router.ts:165`, :814). `seq` and `received_at` are server-set and hash-covered (`packages/core/src/chain.ts:80–87`). Owner-token and assert writes keep the body's actor (`router.ts:203`, :335); local SQLite has no stamp; `timestamp` is caller-supplied when present (`chain.ts:87`). Of 7,909 events: 394 assert, 57 owner, 947 unstamped (status 04:27Z). |
| C19 | 355 | "A `caused_by` chain linking work back to a human instruction." | true | `packages/core/src/schema.ts:201–202`; `explainEvent` (`store.ts:848`). Only the MCP paths reject a dangling link (`packages/mcp-server/src/index.ts:329`); REST and the adapters seal it tagged `caused_by:unverified` (`store.ts:633`, :826). So README.md:17's "rejected at write time, never silently stored" holds for MCP writes only. The "human instruction" is usually relayed by an agent (C44). |
| C20 | 356 | "Git reconciliation that can identify uncovered or apparently misattributed files." | true | `reconcile.ts:33`, :351, :360. Gaps: merge commits and human-sealed commits get no coverage check (`reconcile.ts:328–331`), and `uncovered` is a warning by default (`reconcile.ts:181`). |
| C21 | 357 | "Hash-chained events, producer signatures, signed exports, and optional Rekor witnessing." | true | `chain.ts:80–81`, :113; `producer-sig.ts:5–6`, :59; `export.ts:4`, :125; `packages/mcp-server/src/witness.ts:5–6`. The witness is optional (`export-cli.ts:163`): daily from `.github/workflows/retrace-checkpoint.yml:22`, and hourly for `retrace` only (`wrangler.toml:24`). |
| C22 | 358 | "Cross-harness support rather than dependence on one AI vendor." | true | The live ledger holds events from ten agent actor ids, among them claude-code, codex, cursor-agent, github-copilot, grok, nooa, gemini and openclaw (status 04:27Z actor list); per-harness setup is at `SETUP-GUIDE.md:124–132`. |
| C23 | 359 | "Self-hosting under Apache 2.0." | partly true | Apache 2.0: `LICENSE:2–3`, README.md:86. The self-host steps (`SETUP-GUIDE.md:232`) assume the owner's database: `apps/worker/wrangler.toml:9` hard-codes the owner's `database_id`, and no step creates a database for a new account. |
| C24 | 361 | "real differentiators, not just another timeline UI" | unverifiable | A judgment. Retrace does ship a timeline UI (`docs/reference.md:130`). |
| C25 | 361 | "unusually candid about what it cannot prove in its README and limitations" | true | README.md:69–75, identical at `a1dd8fe`. "Unusually" is a judgment. Two public sentences claim more than those limits: `site/landing/index.html:103` ("verify without trusting anyone, including us") beside README.md:71's operator rewrite window, and README.md:17 (C19). |

### 2.3 The market gap (l. 363–386)

| # | l. | Claim | Status | Evidence and note |
|---|---|---|---|---|
| C26 | 365 | "The gap is evidence, not observability." | unverifiable | Market framing. It matches the project's own position (`docs/reference.md:256`). |
| C27 | 367–374 | Git "generally cannot answer" six questions, which Retrace is implied to answer | partly true | The Git half is general knowledge, not checkable in this repository. Retrace answers each question only in part. (1) Which agent produced the content: a covering event "proves an agent CLAIMED the edit, not that the diff matches" (`reconcile.ts:12–13`), and there is no line-level attribution (README.md:75). (2) Committer different from producer: `misattributed` (`reconcile.ts:360`); "Still open: distinguish content author from committer and relayer" (`docs/reference.md:263`). (3) Which instruction authorized the work: C19 and C44. (4) Which model and harness: the model is asserted with a source (C42); the harness is recorded as `location.system`. (5) Unrecorded file changes: `uncovered`, for agent-sealed non-merge commits only (C20). (6) Verification without trusting the operator: yes after a checkpoint, with a trusted key (`export.ts:125`; README.md:71). |
| C28 | 376 | Copilot cloud agent "exposes reasoning and tool-use session logs, links commits back to those logs, and signs the commits as verified" | unverifiable | A vendor capability; GitHub's documentation would verify it. The repository records the `Agent-Logs-Url` trailer as a harness-native claim source "verified to exist at scale on 2026-09-08" (`docs/design/commit-trailer-consistency.md:823`). |
| C29 | 378 | Claude Code "exposes extensive hooks around prompts, tool calls, file changes, subagents, model changes, and sessions, along with the transcript path" | unverifiable | A vendor capability; Anthropic's hooks documentation would verify it. P3 requires it to be verified at source before any design relies on it. |
| C30 | 380 | LangSmith "provides cross-provider agent traces, monitoring, evaluation, and integrations" | unverifiable | A vendor capability. |
| C31 | 384 | Retrace's gap: "Unify evidence from multiple coding agents, bind it to Git artifacts, enforce capture, and produce independently verifiable audit evidence." | partly true | Unify (C22), bind to Git (C20) and verifiable evidence (C21) hold. "Enforce capture" is not what Retrace does today. `uncovered` warns (`reconcile.ts:181`). The trailer policy is off (`wrangler.toml:18`). The ruleset exempts admins (`SETUP-GUIDE.md:202`). The shadow window has been paused since 2026-09-15 (`docs/measurements/step5-phase-a/window-start.md:115`, :128). |
| C32 | 386 | "I do not see that entire bundle commonly delivered by built-in coding-agent products today." | unverifiable | Market. |

### 2.4 Who needs it (l. 388–414)

| # | l. | Claim | Status | Evidence and note |
|---|---|---|---|---|
| C33 | 392–400 | Strong need: regulated or security-sensitive organizations; several AI tools at once; unsupervised agents; shared service identities; incidents reconstructed months later; supply-chain evidence on PRs; audit evidence independent of the vendor | unverifiable | Market. The repository names no users. |
| C34 | 402 | "The likely buyers are AppSec, engineering governance, platform engineering, internal audit, or a CISO—not individual developers." | unverifiable | Market. |
| C35 | 406–412 | Weak need: solo developers; small startups with one assistant; teams reviewing all AI work through PRs; teams standardized on Copilot cloud agent; low-risk repositories | unverifiable | Market. |
| C36 | 414 | "Most developers want better code, fewer bugs, and faster reviews. They do not inherently want a provenance ledger." | unverifiable | Users. |
| C37 | 414 | "Retrace must connect the ledger to a painful outcome such as preventing an unauthorized merge, shortening an investigation, or satisfying an audit." | planned | The gate exists as a check, not a lock. `retrace-gate.yml:1–2` fails an agent HEAD that is missing from the ledger or not rooted. Admins are exempt (`SETUP-GUIDE.md:202`; `site/landing/index.html:187` "a check, not a lock"). Enforcement is designed (`commit-trailer-consistency.md:796–797`) and not built. |

### 2.5 Value beyond built-ins (l. 416–443)

| # | l. | Claim | Status | Evidence and note |
|---|---|---|---|---|
| C38a | 422 | Retrace: exact committed diff — "References it" | true | Commit seals name the commit and its files as artifacts; the diff stays in Git. |
| C38b | 423 | Detailed prompts and tool calls — "Partial by design" | true | README.md:73. |
| C38c | 424 | Cross-vendor agent record — "Strong" | true | Ten agent actor ids in one ledger (status 04:27Z). |
| C38d | 425 | Human instruction → commit chain — "Core feature" | partly true | It is the core design (C19), but roots are usually agent-relayed (C44). Causal coverage is 98.1% on `retrace` and 42.8% on `boxing-rpg` (`retrace_status`, 2026-09-25 04:27Z and 04:31Z). |
| C38e | 426 | Detect unlogged or misattributed files — "Strong ambition" | true | "Ambition" is accurate: the check exists and only warns (C20). |
| C38f | 427 | Tamper-evident ledger — "Strong" | true | C21. There is an operator rewrite window between checkpoints (README.md:71). |
| C38g | 428 | Offline third-party verification — "Strong" | partly true | Offline verify works against a trusted key; without one the result is `self_attested` (`export.ts:125`, :212). Public live browsing is paused (README.md:12). The repository's committed checkpoint pin stops at seq 4098 (`.retrace/checkpoints.jsonl`, last line, 2026-09-14), with ten daily checkpoint PRs unmerged since (PRs 52, 64, 70, 75, 81, 94, 100, 102, 106 and 120). The public 2026-09-03 snapshot does verify offline (README.md:5). |
| C38h | 429 | Easy automatic adoption — "Weak currently" | true | C9. |
| C39 | 420–429 | The Git/GitHub, vendor-session-log and LangSmith columns | unverifiable | Competitor capabilities. |
| C40 | 431–437 | Enough value only when multi-vendor, audit-grade and independently verifiable are all required | unverifiable | Market. |
| C41 | 441 | "Retrace can help prove that a recorded event was not subsequently altered. It cannot prove that every event was captured or that every original claim was truthful." | true | `docs/reference.md:113` ("a hash chain only proves the events that are present were not altered"); README.md:71–73; `reconcile.ts:12–13`. Two nuances: "not altered" holds after a checkpoint (README.md:71), and full exports do detect omission against the server's claimed head (`site/landing/index.html:180`). |
| C42 | 443 | "Model identity is asserted." | true | README.md:72; `producer-sig.ts:20` ("the model stays asserted — never claim it"). Since PRs 114 and 118 it carries a source label (`schema.ts:14–20`, :54–61) that nothing verifies. |
| C43 | 443 | "Agent activity can be omitted." | true | Only commits (git hooks), GitHub webhooks and the Drive poller capture without the agent (`git-hook.ts:5`, `github.ts:5–10`, `adapters/google-apps-script/Code.gs:42`); everything else is `retrace_log` (agent-rules 1–3). Status 04:27Z: 93 unlinked commits and 152 instructions without follow-up on `retrace`; 96 of 140 commits unlinked on `boxing-rpg` (04:31Z). |
| C44 | 443 | "A relayed 'human instruction' is still being submitted by an agent configured to act for that human." | true | `router.ts:6–7` and :904–908 stamp `relayed_by`. Nothing downstream reads it: `causality.ts:12` counts any human `instructed` event as a root, so status's `rooted_in_human_instruction` (4,977 of 5,116) mixes relayed roots with direct ones. `docs/owner-protocol.md` §7 records that the envelope does not prove who typed. |
| C45 | 443 | "tamper-evident, but not automatically truth-complete" | true | Follows from C41–C44; README.md:71–73. |

### 2.6 What the evaluation says is good (l. 445–467)

| # | l. | Claim | Status | Evidence and note |
|---|---|---|---|---|
| C46 | 449 | "I cloned the current repository, built it from scratch, and ran the complete test suite. All 591 tests passed: 348 core, 210 CLI/MCP, and 33 Worker tests." | true | The work log shows the clone and the test run (l. 67, l. 161). Main at clone time was `a1dd8fe`, and its CI gate job 106084866218 printed `# tests 348`, `# tests 210` and `# tests 33`, `# fail 0` each. Today: 622 (§1.4). |
| C47 | 451 | Tests cover adversarial behaviour, credentials, signature verification, hash-chain tampering, reconciliation, replay, concurrency, D1, XSS, malformed data and failure modes | true | Each topic has at least one named test: `reconcile.test.ts:114`, `router.test.ts:295`, `producer-sig.test.ts:78`, `chain.test.ts:29`, `reconcile.test.ts:38`, `producer-sig.test.ts:100`, `router.test.ts:233`, `apps/worker/src/d1-store.workerd.test.ts:41`, `report.test.ts:20`, `router.test.ts:977` and `git-hook.test.ts:330`. Limits: most D1 tests run on a `node:sqlite` shim (`apps/worker/src/d1-store.test.ts:8`), and no test races two appends for one `seq`. |
| C48 | 451 | "significantly better than most early open-source prototypes" | unverifiable | A comparison with other projects. |
| C49 | 455 | "The project records the development of Retrace using Retrace." | true | `.retrace.json:2`; README.md:5. Project `retrace` holds 7,909 events and 972 commits (status 04:27Z). |
| C50 | 455 | "Its public examples show real attribution disagreements and coverage gaps" | true | `docs/examples.md:25`, :33, :58, :75, :146. Examples 3 and 4 are output shapes, and 7 and 8 are "shown on our word until redaction ships" (`examples.md:13`, :16). |
| C51 | 457 | "The authors are treating discrepancies as findings rather than hiding them." | true | agent-rules 10 (`docs/agent-rules.md:90–92`). Dated corrections are in place, for example `docs/measurements/omarchy-trial-2026-09-21.md:68–71`. |
| C52 | 461 | "Signed exports distinguish trusted verification from self-attestation." | true | `export.ts:125`, :208, :212; `export-cli.ts:10`. |
| C53 | 461 | "Producer signatures use keys not held by the server." | true | `producer-sig.ts:5–6`; `router.ts:182`. Two caveats: signing is optional unless `require_signature` is set (`router.ts:847`), and a signature whose key belongs to a different registered credential is accepted as `unknown_kid` (#96, open). |
| C54 | 461 | "Rekor provides an external witness." | true | `witness.ts:5–6`, :12. It witnesses a signed head at a time, not content or completeness (`checkpoint.ts:26`). The repository's copy of the pins is stale (C38g). |
| C55 | 461 | "The system does not falsely call itself tamper-proof." | true | README.md:71, `docs/examples.md:93`, `site/landing/index.html:173`. No doc calls it tamper-proof or immutable. `landing:103` "without trusting anyone, including us" is the strongest claim and sits beside README.md:71's rewrite window. |
| C56 | 463 | "substantially better than putting a hash in a database and calling it immutable" | unverifiable | A judgment. |
| C57 | 467 | "Supporting Claude Code, Codex, Gemini, Grok, Copilot, Cursor, and external frameworks" | partly true | **Gemini is false.** Gemini was retired 2026-09-10 (`docs/team-roles.md:153`; commit `e514d2a` removed `GEMINI.md`). Yet `SETUP-GUIDE.md:5`, :24, :127, :155, :163, `docs/reference.md:41`, `docs/examples.md:5` and `packages/mcp-server/src/admin.ts:40` (`DEFAULT_HARNESSES`) still offer or provision it. Cursor works but `retrace-admin` does not mint it (`SETUP-GUIDE.md:328`). Of the "external frameworks", NOOA signs (README.md:21); OpenClaw is an unsigned pilot, parked (`SETUP-GUIDE.md:161`, :186; `wrangler.toml:27–28`); OpenCode is on hold (PR 19). The evaluation repeated the stale docs, which shows they mislead a careful reader. |
| C58 | 467 | "the most strategically interesting part. Enterprises are unlikely to use only one agent forever." | unverifiable | Market. |

### 2.7 The problems the evaluation names (l. 469–528)

| # | l. | Claim | Status | Evidence and note |
|---|---|---|---|---|
| C59 | 473–483 | A hosted deployment involves Node 22, MCP per harness, tokens and producer keys, agent instructions, hooks and trailers, a Worker and D1, webhooks, Rekor checkpoints, and CI gates with reconciliation policy | true | `packages/mcp-server/package.json:36` (`"node": ">=22"`); `SETUP-GUIDE.md:21`, :120, :122, :153, :155, :93, :118, :232, :269, :248, :188. It also needs a checkpoint signing key and a hand-built GitHub App (`SETUP-GUIDE.md:216–217`). Checkpoints are "optional, recommended" (`SETUP-GUIDE.md:208`). |
| C60 | 485 | "The local path is simpler" | true | README.md:24–50 needs no cloud. The trade-offs: exports are self-attested (README.md:52–53), hook seals are unstamped, and reconcile needs `--allow-unstamped-seals` (`SETUP-GUIDE.md:110`; #87). |
| C61 | 485 | The stranger-install issue says the README assumes a cloned checkout | true | #83, open since 2026-09-20: "README's quick start assumes a checkout: no own-repo install path, MCP block points at a file I don't have". |
| C62 | 487 | "approximately 9.5 KB MCP tool-schema payload per session" | true | 9,509 bytes for the 11-tool local server and 6,944 for the Worker subset (`docs/design/step5-phase0-instrument.md:158–159`), measured 2026-09-11 (:3). These are bytes, not tokens, and have not been re-measured since. |
| C63 | 487 | 5.42 logged agent events per commit on `retrace`, 0.16 on `boxing-rpg`, "90.4% of intervals having zero" | true | `step5-phase0-instrument.md:255–256`, over each project's whole history to 2026-09-11/12. "Agent events" counts every agent action, including NOOA's 109 audit events on `retrace` (:256), not only edits. |
| C64 | 487 | This "strongly suggests that disciplined capture falls away outside the project specifically devoted to provenance" | partly true | Capture is low on the second project: live, 96 of 140 commits are unlinked, causal coverage is 42.8%, and the last event was 2026-09-17 (04:31Z). The project's own notes attribute part of it to wiring: only claude-code is pinned there (`docs/second-project-baseline.md:69–71`), and a credential fix lifted coverage from 19.0% to 32.9% (`window-start.md:25`). They also record that "edit capture did not" close (`second-project-baseline.md:45–46`). The cause is not established. |
| C65 | 489 | "A 'flight recorder' should be almost completely automatic. Retrace currently requires too much pilot participation." | partly true | Participation is required: agent-rules 1–3, and C43. "Too much" is a judgment. |
| C66 | 495 | An agent's GitHub action through the owner's `gh` session is sealed as the human owner (#82) | true | #82 is open. `packages/core/src/github.ts:41–47` makes any non-bot login a human. The actor `github:jordandru` (type human) has 592 events (status 04:27Z); it had 344 when the issue was filed. |
| C67 | 496 | Drive activity through a delegated account appears human (#61) | true | #61 is open. `packages/core/src/gdrive.ts:56` maps every known user to type `human`. The adapter has been idle since 2026-08-29 (12 events on `retrace`). |
| C68 | 497 | An installed hook can point at an ephemeral npx cache path, go missing, and doctor still reports READY (#84) | true | True when written: #84 was open. Fixed by PR 92 (`30fc384`, 2026-09-21; `git-hook.ts:340`, `doctor.ts:96–98`). The fix was published only in CLI 0.2.0, on 2026-09-25 (§1.4). |
| C69 | 498 | Credential retirement can leave the secret active through another record; local and deployed state can drift (#97) | true | #97 is open, and no doc references it. PR 42's unmerged design makes retirement a sealed event (`docs/design/credential-store.md:55–58` on `grok/credential-store-design`). |
| C70 | 499 | Several live credentials lack project scope (#69) | true | #69 is open: "Four live agent credentials are unscoped and can write to any project". |
| C71 | 493, 501 | These are not cosmetic, and until they are "resolved and independently assessed, Retrace should not be sold as an authoritative enterprise control" | partly true | The defects are real (C66–C70), and a paid Team plan is on offer while they are open (`site/landing/index.html:199–201`). No independent assessment is recorded in the repository: the 2026-08-30 assessment was the project's own (`fdcf01e`; `docs/reference.md:261`). Whether it should be sold is a recommendation. |
| C72 | 505 | "The live public ledger was paused after events from an unrelated private repository entered the public project." | partly true | A public share of project `retrace` served "two events that recorded work on an unrelated private repository" (commit `76df250`); the share was deleted 2026-09-16T16:35:54Z, `evt_8691bc0d43de488d9558688f76c4638e` (#5150, read raw). The ledger was not paused; public browsing was (README.md:12). The reason is recorded only in commit messages (`76df250`, `0d294eb`). |
| C73 | 505 | The events were hash-chained, so they "could not simply be removed without breaking the record" | true | Commit `76df250`: "hash-chained ahead of ~1400 successors, so they cannot be removed without tampering". See also `docs/reference.md:218`, and :83, where the only removal primitive is deleting a whole project. |
| C74 | 505 | "Payload redaction remains an open design item: issue #67" | true | #67 is open, and no design note, brief or code exists on any branch. README.md:12, `docs/examples.md:16` and `site/landing/index.html:123` say browsing is paused "while export redaction is built", which overstates: nothing is being built. |
| C75 | 507–514 | Provenance data may contain repository names and paths, prompts and intentions, vulnerability descriptions, internal identities, customer names and incident details | true | Free-text and identity fields sit inside the hashed body: `intent` (`schema.ts:199–200`), `action_detail` (:193), `actor.id` and `on_behalf_of` (:46–53), artifact ids and labels (:99–102), `change.diff` and `summary` (:137–138), `location` path, url and device (:142–146), and open `method.params` (:175). `retrace_instruct` copies the instruction into `intent` (`index.ts:409–410`). |
| C76 | 516 | "Redaction, access controls, retention, legal hold, and data classification should be first-class" | partly true | Some access control exists: per-credential project allow-lists (`router.ts:180`), share expiry and owner-only revoke (`router.ts:1121`, :33), and whole-project delete (`router.ts:20`). Redaction is an open issue with no design. Retention, legal hold and classification are absent and unplanned. |
| C77 | 520 | Retrace "deliberately does not capture every prompt, system prompt, keystroke, reasoning step, or line-level authorship" | true | README.md:73, :75; `docs/examples.md:189`. |
| C78 | 520 | Vendor logs and LangSmith "are much better when the question is 'Why did this agent fail?'" | unverifiable | Competitors. |
| C79 | 522 | "Retrace should avoid competing as a trace viewer. Its own documentation recognizes this." | true | `SETUP-GUIDE.md:330` ("Do not become C2PA, a trace viewer, or an identity provider"); `docs/reference.md:256`, :267. |
| C80 | 526 | As of 2026-09-20 the repository was about one month old, with one star, no forks and one human contributor | true | Created 2026-08-17T03:47Z. 1 star, 0 forks. Contributors: jordandru (469) and two bots (`gh api`, 2026-09-25). GitHub counts one human because every seat pushes as the owner (#82; `docs/owner-protocol.md` §8); the ledger names ten agent actor ids. |
| C81 | 528 | "no external evidence of product-market fit, community adoption, or operational use at scale" | true | True as far as the repository, GitHub and the ledger projects this seat can see show (C13). Whether evidence exists elsewhere is unverifiable. |

### 2.8 Recommendations and validation gates (l. 530–570)

| # | l. | Claim | Status | Evidence and note |
|---|---|---|---|---|
| C82 | 532 | "Continue building it, but narrow the product aggressively." | partly true | Narrowing is already the project's stance: `SETUP-GUIDE.md:330` ("Do not add connectors, a sixth agent … while completeness … and attribution … are still weak") and the `docs/reference.md:267` "Not next" list. |
| C83 | 536 | "Every AI-assisted pull request gets a verifiable provenance receipt." | unverifiable | Positioning; nothing like it exists or is planned. |
| C84 | 540 | "One-command or GitHub App installation." | planned | No `init` command and no user-facing GitHub App (`doctor.ts:717`; `packages/mcp-server/package.json:7–14`). The packed-CLI items are in the backlog (agent-ops 3 and 4, `docs/agent-ops.md:40–46`): rule 3 is partly built by PR 92, and rule 4 is not built. |
| C85 | 541 | "Automatic capture for Claude Code, Codex, and Copilot." | unverifiable | Not built and not planned. The project rejected "Claude-Code-only managed hooks as the completeness strategy" (`docs/reference.md:267`; commit `3b63298`). No cross-harness version is designed. |
| C86 | 542 | "Automatic session-to-diff-to-commit correlation." | partly true | Session to commit exists: the live hook stamps the session (`git-hook.ts:225`), and doctor checks it (`doctor.ts:251–271`). It covers Claude Code and Grok sessions only (`index.ts:162`). There is no session-to-diff link, because edit events carry no content hash (`reconcile.ts:12–13`). |
| C87 | 543 | "A single PR check: verified, incomplete, or conflicting." | planned | The gate prints PASS/WARN/FAIL (`doctor.ts:851–852`). `supported` / `conflicting` / `unresolved` exist server-side only (`classify.ts:72–74`), and the classifier is off: the shadow window is paused (`window-start.md:115`, :128), and enforce is designed (`commit-trailer-consistency.md:796–797`). |
| C88 | 544 | "A concise audit receipt attached to the PR." | unverifiable | Nothing posts to an ordinary pull request (`.github/`, `packages/`, `apps/`). Checkpoint PR bodies carry a reconcile block (`docs/reconciliation-plan.md:46`). A digest comment on checkpoint PRs is designed and not built (`docs/design/retrace-ai-digest.md:251–252`). |
| C89 | 545 | "Signed offline export." | true | It exists: `export.ts:4`; `export-cli.ts:10`. |
| C90 | 546 | "Redaction, RBAC, retention, and SSO." | planned | Only redaction is planned, as issue #67 with no design. Roles are owner, pinned and assert only, and there is no retention. An IdP is ruled out (`docs/reference.md:256`, :267; `SETUP-GUIDE.md:330`). |
| C91 | 547 | "SIEM/API export." | partly true | A pull API exists (`router.ts:10–32`: events, why, head, verify, status, signed export, report, lineage JSON/DOT/Mermaid). There is no push, stream or SIEM format. A W3C PROV export is only a comment (`schema.ts:7`). |
| C92 | 549 | "Postpone Google Drive and generalized work provenance" | planned | Drive is already deferred: "Out of scope until a Drive user exists" (`docs/reconciliation-plan.md:58`); `docs/producer-signing-plan.md:22`. Yet `docs/reference.md:98`, :258, :269 and `SETUP-GUIDE.md:282` present Drive as live while #61 is open. |
| C93 | 551 | "Replace cooperative `retrace_log` calls with automatic harness hooks wherever possible." | unverifiable | Not planned, and it conflicts with the recorded rejection of the Claude-only form (C85). The project's own prevention idea is a pre-commit refusal of unlogged paths (`docs/agent-ops.md:34–36`, a direction). |
| C94 | 555 | "Run five design-partner pilots" | unverifiable | Market; no programme exists (PR 43 is research only). |
| C95 | 557 | "Installation in under ten minutes." | unverifiable | Never measured: the stranger trial's install step was not run (`omarchy-trial-2026-09-21.md:173–175`). |
| C96 | 558 | "More than 95% of AI-assisted commits linked automatically." | planned | This is the project's own bar: `docs/second-project-baseline.md:73–84` ("Pass: that ratio ≥ 0.95, `missing_commit` 0, `misattributed` 0") and `docs/reference.md:265`. It is not met (C64). |
| C97 | 559 | "Near-zero false agent attribution." | planned | The trailer classifier is designed to find conflicting claims (`commit-trailer-consistency.md`, v2.5) but is not active. #82 is a live source of false human attribution. |
| C98 | 560 | "No routine manual logging by developers or agents." | unverifiable | It contradicts the current design (agent-rules 1–3), and nothing plans to remove manual logging. |
| C99 | 561 | "An audit or incident question answered in minutes instead of hours." | unverifiable | Nothing measures it. |
| C100 | 562 | "At least three of five partners willing to pay." | unverifiable | Market. |
| C101 | 564 | Without a merge gate or payment, the gap is "intellectually real but not commercially urgent" | unverifiable | Market. |
| C102 | 566 | "promising and differentiated, technically thoughtful, currently over-engineered relative to demonstrated demand, and not yet trustworthy enough to serve as the trust layer it wants to become" | unverifiable | A judgment. Its checkable parts are C4, C11 and C12. |
| C103 | 568–570 | The offer to "set up 'Track Retrace production-readiness'" and its `genui` widget | unverifiable | Not a claim about Retrace. It is an instruction-shaped offer to the ChatGPT user, recorded as a finding (§1.5) and not acted on. |

The work log's visible messages restate claims above and add none: l. 52 (a plan to inspect), l. 87 (C3, C26) and l. 250 (C46,
C11).

## 3. Ranking what survives

Of the claims that are true or partly true and point at a change, this is the order under Jordan's standing priorities:

1. **Truthfulness, completeness and verifiability of the ledger first.** "Truthful, objective provenance is upheld at all
   costs (Jordan, 2026-09-07)" (`docs/team-roles.md:8–9`; agent-rules 0).
2. **Defense and fail-closed defaults second.** "Jordan's standing rule: defense is top priority", 2026-08-30
   (`evt_7cb0db5fc3254ab7a5ba36233245db46`, #983, read raw; commit `5f8c881`). The build order is 13 → 3 → 4
   (`docs/agent-ops.md:241–243`).
3. **The stranger-install bar** (`docs/agent-ops.md:9`; Grok's 2026-09-12 assessment).
4. **Features and reach last.**

The prompt also cites a 2026-09-04 "product over money" decision. No repository file records it, and a ledger text search
(`GET /projects/retrace/events?text=`, three phrasings, 2026-09-25) did not find it *(author-unverified)*. The ranking below
does not depend on it.

| Rank | Plan item | Tier | Main claims |
|---|---|---|---|
| 1 | P1 — agents' GitHub actions sealed as the human owner | truthfulness | C66, C11, C97, C80 |
| 2 | P2 — agent-relayed instruction roots counted as human roots | truthfulness | C44, C19, C27, C38d |
| 3 | P3 — capture completeness: measure a live window, then design capture without cooperation | completeness | C43, C63, C64, C65, C85, C93, C96, C98 |
| 4 | P4 — public claims the evidence does not carry | truthfulness (public) | C57, C74, C19, C25, C55, C92 |
| 5 | P5 — the committed checkpoint pin is 11 days stale | verifiability | C38g, C41, C54 |
| 6 | P6 — the enforcement path already designed (shadow → enforce) | truthfulness | C31, C37, C87, C97 |
| 7 | P7 — Drive adapter: fail closed until it can tell an agent from a human | truthfulness / defense | C67, C92 |
| 8 | P8 — credentials: scope, signing, retirement, the credential store | defense | C11, C53, C69, C70, C71 |
| 9 | P9 — export redaction | defense / verifiability | C72–C76, C38g |
| 10 | P10 — stranger install | stranger-install bar | C9, C23, C59–C62, C68, C84, C95 |
| 11 | P11 — features, deferred | features | C83, C84, C87, C88, C90, C91 |

**Where the evaluation ranks differently, and why this note keeps Jordan's order:**

- The evaluation's "Most importantly" is automatic capture (C93). That is completeness, first tier here too, but it sits
  third. P1 and P2 come first because they concern records and metrics that overstate the truth today, while P3 concerns
  records that are missing.
- Its MVP list starts with installation (C84). Here installation is third tier.
- It groups redaction with RBAC, SSO and SIEM as enterprise features (C90). Here redaction is defense and privacy (P9, the
  public share already leaked a third party's work, C72); RBAC, SSO and SIEM are features (P11).
- It frames the trust defects as a sales blocker (C71). Here they are ranked by what they do to the record: #82 writes false
  human attributions every day (P1); the credential defects are defense (P8).
- Its validation gates are commercial pilot gates (C94–C100). Here the three that measure truth become acceptance criteria
  for P3 (C96, C97, C98), and the commercial ones wait (§6 Q9).

## 4. The plan

Each item gives what changes, the claims that justify it, what it touches, its class under agent-rules 12, its size, the
suggested builder and the reviewer who must not be that builder, and the evidence that would show it done. Seat suggestions
follow `docs/team-roles.md`: design notes by the coordinator with the gate Codex → NOOA → the Grok seat; code by
cursor-agent or github-copilot with review Codex → claude-code; measurements by the Grok seat. Routing is the coordinator's
decision (agent-rules 11–12). Every merge, deploy, publish, credential change and account creation waits for Jordan's go
(agent-rules 14).

### P1. Stop sealing agents' GitHub actions as the human owner

- **What changes.** First a design note. Then code in `packages/core/src/github.ts` (`githubActor`, :41–47) and the webhook
  path in `router.ts`, so that an event whose sender is the owner's login is no longer unconditionally `human`. The note
  chooses among three approaches:
  - (i) Classify owner-login events against evidence the ledger already holds, the way commit trailers are classified
    (`docs/design/commit-trailer-consistency.md`). An example of such evidence is a pinned seat's `sent` or `edited` event
    naming the same pull request, comment or sha.
  - (ii) Give each seat its own GitHub identity, which `docs/owner-protocol.md` §8 already names as the prevention
    ("per-seat GitHub identities and scoped credentials (issues #82, #69)").
  - (iii) Both, with (i) first because it needs no new accounts.

  Status reports the owner-login events by classification. The 592 existing events are not batch-amended: "batch-amending
  the ledger" is Not next (`docs/reference.md:267`).
- **Claims.** C66, C11, C97, C80.
- **Touches.** #82, #69; agent-rules 11 (`gh` runs as the owner); `docs/reference.md:263` ("distinguish content author from
  committer and relayer"); the v3 "authenticated commit assertion" candidate (`commit-trailer-consistency.md:823`).
- **Class and size.** (a) note, M; then code, M. Per-seat accounts are an owner action.
- **Seats.** Author: the coordinator. Gate: Codex → NOOA → the Grok seat. Build: cursor-agent. Review: Codex → claude-code.
- **Done when.**
  - A test seals an owner-login webhook event that has matching seat evidence under that seat, or as unresolved, never as
    `human`.
  - `retrace_status` splits owner-login events by classification.
  - A week of live operation adds no unlabelled human `github:jordandru` events from agent sessions.

### P2. Say which instruction roots were relayed by an agent

- **What changes.**
  - Code, in two places. `packages/core/src/causality.ts` and status count roots that carry `method.params.relayed_by`
    separately from roots a human wrote, splitting `rooted_in_human_instruction` into direct and relayed. `doctor --gate` says
    which kind rooted HEAD.
  - Docs: README.md:3 and :17 say "the instruction recorded for the human, directly or relayed by their agent".
  - The `input_channel` claim (`direct | pasted | relayed | unknown`) that `docs/owner-protocol.md` §7 lists as a design item
    gets its own small note. It records a claim; it proves nothing about who typed.
- **Claims.** C44, C19, C27, C38d.
- **Touches.** `router.ts:904–908`, `causality.ts:12`, status; owner-protocol §7. The note does not change
  `docs/owner-protocol.md`, which only Jordan merges (§8).
- **Class and size.** Code, S; README, (b), S; `input_channel` note, (a), S.
- **Seats.** Build: cursor-agent. Review: Codex → claude-code. Note: the coordinator, then the gate.
- **Done when.** Status on `retrace` prints direct and relayed root counts that add up to `rooted_in_human_instruction`
  (4,977 at 04:27Z), and README.md:17 says the same thing the code does.

### P3. Capture completeness: measure first, then design capture without cooperation

- **Step 3a, measurement (b).** Run a live window of real work in the second project, with every harness used there holding
  a `boxing-rpg`-scoped pinned credential. Only claude-code is pinned there today (`docs/second-project-baseline.md:69–71`).
  Judge it by the project's own pass rule (`second-project-baseline.md:84`: ratio ≥ 0.95, `missing_commit` 0,
  `misattributed` 0), report the rate per harness, and include the cost profile the phase-A brief defined
  (`docs/design/step5-phase-a-measurement-brief.md:29–35`). It needs Jordan's real work in `boxing-rpg` (§6 Q2).
- **Step 3b, design (a).** A cross-harness note: for each harness whose hooks are verified at source (C29 is not evidence),
  a hook-side producer seals *what* happened (file edits, commands). It signs with the seat's own producer key (agent-rules 7
  and 13), is marked `automated`, and never shares an identity. The agent's `retrace_instruct` and `retrace_log` stay for
  *why*: a hook cannot know the instruction. The note must also:
  - weigh agent-ops 2's prevention direction, a pre-commit refusal of unlogged paths (`docs/agent-ops.md:34–36`);
  - meet `docs/reference.md:267`, which rejects the Claude-Code-only form. A cross-harness form needs Jordan to lift "Not
    next" for it (§6 Q1).
- **Claims.** C43, C63, C64, C65, C85, C93, C96, C98, C9.
- **Touches.** `docs/reference.md:265`, :267; `docs/second-project-baseline.md`; the phase-A brief; `window-start.md:25`.
- **Class and size.** (b), M; then (a), L.
- **Seats.** Measurement: the Grok seat (measurer), reviewed by Codex or NOOA (one non-author review). Design: the
  coordinator, with the gate Codex → NOOA → the Grok seat.
- **Done when.**
  - A merged live-window measurement with per-harness numbers.
  - The design note merged.
  - In the end, the second project passes the 0.95 bar on a live window (`docs/reference.md:265`).

### P4. Correct the public claims the evidence does not carry

- **What changes.** Dated in-place corrections (agent-rules 10), folded into #74, the open public-claim sweep:
  - **Gemini** is offered as supported in `SETUP-GUIDE.md:5`, :24, :127, :155 and :163 (`GEMINI.md` is gone since `e514d2a`)
    and in `docs/reference.md:41`. `docs/examples.md:5` is history and gains the retirement date.
  - **Redaction:** "while export redaction is built" (README.md:12, `docs/examples.md:16`, `site/landing/index.html:123`)
    becomes "until export redaction is designed and built (#67)".
  - README.md:17: "rejected at write time" holds for MCP writes only (C19).
  - `site/landing/index.html:103`: "verify without trusting anyone, including us" is reconciled with README.md:71.
  - **Drive** is described as live (`docs/reference.md:98`, :258, :269; `SETUP-GUIDE.md:282`); it is idle, and #61 is open.
  - **Stale records:** "v0.1.6" at `SETUP-GUIDE.md:1` and :46, and the 2026-09-01 deploy record at `docs/reference.md:270`.
  - **Code:** `packages/mcp-server/src/admin.ts:40` still provisions `gemini` by default for new teams.
- **Claims.** C57, C74, C19, C25, C55, C92, C4.
- **Class and size.**
  - (b) for README, SETUP-GUIDE, reference and examples: dated corrections that change no rule. Where the coordinator
    judges a sentence governing, the higher gate applies (agent-rules 12).
  - The landing page is (b) text; its redeploy is Jordan's go.
  - `admin.ts` is code.
  - All S.
- **Seats.** Docs: github-copilot or cursor-agent, reviewed by Codex. `admin.ts`: cursor-agent, reviewed by Codex →
  claude-code.
- **Done when.**
  - No file presents Gemini as supported except as dated history.
  - The redaction sentence names #67.
  - The landing sentence matches README.md:71.
  - `DEFAULT_HARNESSES` excludes `gemini`, with a test.

### P5. Land the independent checkpoint pins

- **What changes.** `.retrace/checkpoints.jsonl` on main pins seq 4098 (2026-09-14, PR #48). The daily workflow has opened ten
  checkpoint PRs since, none merged: PRs 52, 64, 70, 75, 81, 94, 100, 102, 106 and 120. `docs/reference.md` ("Next" 1) says
  the daily append comes "via a PR you merge". Either the merger lands them in order after checking each, or the coordinator
  proposes a flow in which the pin lands without a manual merge. Meanwhile the docs say where current pins live: Rekor
  entries and the Worker's hourly checkpoints.
- **Claims.** C38g, C41, C54.
- **Touches.** `.github/workflows/retrace-checkpoint.yml`; `docs/reference.md` "Next" 1.
- **Class and size.** The checkpoint PRs are data, (b), S. Changing the flow is (a), S.
- **Seats.** Merger: the coordinator, on Jordan's go. Check: NOOA or the Grok seat runs `verify --checkpoint --witnesses` on
  the result.
- **Done when.** The committed pin is within a day of the ledger head and verifies with its witnesses.

### P6. Finish the enforcement path already designed

- **What changes.** Nothing new: the recorded sequence continues.
  1. PR 60, the classify alias lookup without a GLOB pattern, open since 2026-09-16 and named as the blocker at
     `window-start.md:183–186`.
  2. The Worker in shadow.
  3. The phase-A window.
  4. Enforce (`commit-trailer-consistency.md:796–797`).

  Separately, decide whether this repository makes `uncovered` a failure (`reconcile.ts:181` defaults to warn). That is a
  gate control, so class (a).
- **Claims.** C31, C37, C87, C97.
- **Touches.** PR 60, PR 57, #54, #62; `commit-trailer-consistency.md` §15; `window-start.md`.
- **Class and size.** Code, as designed, M; the `uncovered` decision, (a), S.
- **Seats.** Per that design. Deploys are Jordan's.
- **Done when.** A seal carrying `method.params.claim_decision` exists ("Activation remains NOT proven",
  `window-start.md:128`), then the window report, then enforce.

### P7. Drive: fail closed until the adapter can tell an agent from a human

- **What changes.** `POST /hooks/gdrive` stops sealing activity it cannot attribute as `human` (`gdrive.ts:56`). It either
  refuses or seals an unresolved actor until `gdrive.ts` has an agent branch. The Apps Script trigger on project `retrace` is
  turned off by Jordan (`SETUP-GUIDE.md:284`). The docs say "paused, #61" (P4).
- **Claims.** C67, C92.
- **Touches.** #61; `docs/reconciliation-plan.md:58`; `docs/producer-signing-plan.md:22`.
- **Class and size.** Code, S, plus an owner action.
- **Seats.** Build: cursor-agent. Review: Codex → claude-code.
- **Done when.** A test shows a Drive activity without agent evidence does not seal as `human`, and no new `google-drive`
  events appear until an agent branch exists.

### P8. Credentials: scope, signing, retirement, the store

- **What changes.**
  - Route PR 42 (`docs/design/credential-store.md` v1.2, open since 2026-09-12) through the class-(a) gate. It answers
    agent-ops 13's three questions and checks the kid "against the **authenticating** row, not `event.actor`" (PR 42 body),
    which covers #96. It makes retirement a sealed event, which covers #97.
  - Then build it.
  - Before the build, Jordan scopes the four unscoped credentials (#69) and sets `require_signature` on every pinned seat
    credential (`router.ts:847`), through typed scripts under agent-ops 16.
  - A doctor check compares the mirror with the deployed set (#97 drift). This is code, S.
- **Claims.** C11, C53, C69, C70, C71.
- **Touches.** PR 42, #69, #96, #97; agent-ops 13 and the build order.
- **Class and size.** (a), exists; code, L; owner actions.
- **Seats.** PR 42's author is the Grok seat, so the coordinator routes a substitute for that seat (agent-rules 12). Build:
  github-copilot or cursor-agent. Review: Codex → claude-code.
- **Done when.** #69, #96 and #97 are closed with tests, and doctor shows every live credential project-scoped and
  signature-required.

### P9. Export redaction

- **What changes.** A design note for #67, starting from the only design sentence that exists (commit `76df250`: "publishing
  an event's hash while withholding its payload, so the chain still verifies and the export states plainly that it is
  redacted"). It settles four questions:
  - who may redact (owner-only);
  - which fields (C75);
  - how verify reports a redacted event;
  - what a share serves.

  Retention, legal hold and classification stay out of v1 unless Jordan asks (§6 Q7). Then build. It retires the pause
  sentence (README.md:12) and lets examples 7 and 8 be checked (`docs/examples.md:16`).
- **Claims.** C72, C73, C74, C75, C76, C90, C38g.
- **Touches.** #67; `docs/reference.md:218` (capture time is the only control point for the device field).
- **Class and size.** (a), M; code, L.
- **Seats.** Author: the coordinator; the gate. Build: cursor-agent. Review: Codex → claude-code.
- **Done when.** A redacted export verifies offline and says it is redacted, and a share serves redacted payloads.

### P10. Stranger install

- **What changes.**
  - A README own-repo quick start with an npx-pinned MCP config: #83 and agent-ops 4, which is not built (`.cursor/mcp.json`
    still launches a checkout's `dist`).
  - Fixes for #85, #86, #87 and #89.
  - A self-host step that creates a D1 database instead of assuming the owner's (`apps/worker/wrangler.toml:9`).
  - The CLI that carries the #84 fix was published while this note was written (0.2.0, §1.4). The measurement below uses
    it.
  - A measured stranger install on a fresh machine, which is the Omarchy trial's unrun measurement 1
    (`omarchy-trial-2026-09-21.md:173–175`). The time to a verified export is recorded, so C95's "under ten minutes"
    becomes a number.
  - Optionally, a smaller MCP tool schema, re-measured against 9,509 bytes (`step5-phase0-instrument.md:158`).
- **Claims.** C9, C23, C59, C60, C61, C62, C68, C84, C95, C38h.
- **Touches.** #83, #85–#89; agent-ops 3, 4 and 7; `.github/workflows/local-walkthrough.yml`.
- **Class and size.** Code, S–M; docs, (b); measurement, (b).
- **Seats.** Build: github-copilot, which ran the earlier stranger test (`docs/team-roles.md:65–66`). Review: Codex →
  claude-code. Measurement: the Grok seat.
- **Done when.** A stranger reaches a verified export from the README alone on a fresh machine, with the time recorded, and
  #83 and #85–#89 are closed.

### P11. Deferred features, and what would bring each back

| Feature | Claims | Brought back when |
|---|---|---|
| PR outcome check (verified / incomplete / conflicting) and a PR receipt | C83, C87, C88 | P3 and P6 are done. Until capture is complete and enforcement runs, a "verified" receipt would overclaim. |
| One-command install, GitHub App | C84 | P10 is done. An App must not become one identity for every agent, or it recreates #82. |
| SIEM, streaming, W3C PROV export | C91 | A user asks for it. The pull API and signed export exist today. |
| RBAC, retention, legal hold, classification | C76, C90 | After P9. Retention on an append-only chain needs redaction first. |
| SSO / IdP | C90 | Not planned: ruled out (`docs/reference.md:256`, :267). |

## 5. Declined, and why

- **False parts** are corrected where the project states them, not planned around. Gemini in the harness list (C57) is P4.
  "The live public ledger was paused" (C72) is P4's redaction sentence.
- **Unverifiable market, user and competitor claims.** C1, C5–C8, C14, C16, C24, C26, C28–C30, C32–C36, C39, C40, C48, C56,
  C58, C78, C94, C99–C102. Nothing is planned on them. C29 enters P3 only as something to verify at source.
- **Changes that would trade truthfulness for something else:**
  - Dropping manual logging (C98) if that means dropping the *why*. A hook sees an edit, not the instruction behind it.
    P3 adds capture of *what*; `retrace_instruct` and `retrace_log` stay.
  - Automatic capture through a shared or Claude-only identity (C85, C93). Every hook-sealed event carries the seat's own key.
  - A GitHub App that acts as one identity for all agents (C84). It would recreate #82.
  - A PR receipt before P3 and P6 (C88). It would certify incomplete capture as verified.
  - Batch-amending the 592 owner-login events (P1). Not next (`docs/reference.md:267`); they are labelled, not rewritten.
- **Positioning** (C16, C83). Not planned; it is Jordan's call (§6 Q10).

## 6. Open questions for Jordan

Each gives a recommendation and how to overrule it.

1. **Q1. Capture strategy (P3b).** `docs/reference.md:267` rejects "Claude-Code-only managed hooks as the completeness
   strategy". *Recommendation:* keep that rejection, and authorize a cross-harness capture note after the P3a measurement.
   *To overrule:* say "keep Not next as written"; P3 then ends at the measurement.
2. **Q2. A live window in `boxing-rpg` (P3a)** needs your real work there, with each harness pinned to that project.
   *Recommendation:* schedule it. *To overrule:* decline; the 95% bar stays unmeasured.
3. **Q3. #82's approach (P1).** *Recommendation:* design classification and per-seat identities in one note, and build
   classification first. *To overrule:* choose one.
4. **Q4. The 592 existing owner-login events.** *Recommendation:* label them in status and amend individually only where
   evidence exists. *To overrule:* authorize batch amendment, reversing a Not-next line.
5. **Q5. Public claims (P4)**, including the landing redeploy. *Recommendation:* correct them now. *To overrule:* keep the text
   as is.
6. **Q6. Drive (P7).** *Recommendation:* turn the trigger off and fail closed until #61 is fixed. *To overrule:* keep it live and
   fix #61 first.
7. **Q7. Redaction scope (P9).** *Recommendation:* v1 is redaction only; retention, legal hold and classification come later.
   *To overrule:* widen v1.
8. **Q8. The paid Team plan while #82, #69, #96 and #97 are open (C71).** *Recommendation:* pause the offer or state the open
   defects beside it until P1 and P8 land, then commission an independent assessment. *To overrule:* keep the offer
   unchanged.
9. **Q9. Pilots and validation gates (C94–C100).** *Recommendation:* adopt the three gates that measure truth as P3 acceptance
   criteria: C96 (≥ 95% of commits linked automatically), C97 (near-zero false attribution), and C98 read as "no routine
   manual logging of *what* happened", with the *why* staying manual. Defer recruiting and the commercial gates until tiers
   1–3 are done; PR 43 stays research. *To overrule:* start recruiting now.
10. **Q10. Positioning (C16, C83).** *Recommendation:* no change before P3. *To overrule:* ask for a positioning note.

## 7. Record

Every event this seat created, in order (`location.session` `1d17116d-8d22-4b16-9128-f5acf2ecad82`). Three more come after
this text was fixed, so they cannot be listed inside it: the edit event naming this file, the commit's hook seal and the
push's webhook seal. The pane report lists them.

| # | Event | Action | What |
|---|---|---|---|
| 1 | `evt_d4b4e93cae284503a46f624c6b0d3a35` | received | The first input arrived without the `JD` envelope (the prompt path): miss 1, nothing acted on (`docs/owner-protocol.md` §2). |
| 2 | `evt_6359706adc844b779127459e7fceff96` | received | "Tool loaded.", unsigned, counted literally as miss 2 and flagged; reply of 2 characters. |
| 3 | `evt_dc691219358244a09f1e55ffd48758cf` | instructed | Jordan's signed instruction, envelope verbatim; the root of this work. |
| 4 | `evt_1eaf44644cf842ddaed5ad53f7866ffe` | read | The prompt and the documents it binds; the commissioning event read raw; the tab located. |
| 5 | `evt_630889ef54ff4c33a6aff2a6dfaa9b7a` | read | The source read whole, saved and hashed (§1.1). |
| 6 | `evt_16a0b6c255384247a6fcd89e8a11c9a0` | executed | The worktree `opus-evaluate-retrace` created with the prompt's own command. It did not exist, and this pane had been launched in the primary checkout. |
| 7 | `evt_c818be696bfb4afa99730105bc82d66d` | received | A second "Tool loaded." after another tool load, judged harness text (2 of 2 follow a tool-schema load) and not counted; annotates event 2. |
| 8 | `evt_ce24e5e728724efe979a36629cfede7d` | read | GitHub issues and PRs, CI logs at `a1dd8fe` and `cb91dd6`, ledger status and raw events. |
| 9 | `evt_c0e1d42d1dcd4fee976a373c28c7bc0f` | read | Docs, code and history checks by three read-only subagents, every citation re-read by the author; the branch fast-forwarded to `76da589`. |
