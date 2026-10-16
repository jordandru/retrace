# Coding standards

**Status:** v1, 2026-10-16. Author claude-code, on Jordan's request `evt_6c8a5d09cc2449699264681e51922937` and launch go
`evt_a982651c4de44513b9642f11a1e0669c`. Design: `docs/design/review-system-skills.md`.

Each rule below came from a blocking review finding on this repository, and each names the pull request, round, seat,
severity and verdict event it came from. Each one also says how to check it: by a command, or by a reading test that
two readers would apply the same way. A rule that cannot be checked is a claim and is left out.

**What this file is.** It is the list a builder checks a diff against before asking for review
(`.claude/skills/retrace-code-review`), and the list a reviewer may cite. It is not a review. Passing it counts for
nothing at the gate (agent-rules 11 and 12): the verdict of record is still the review seat's ledger event.

**How it changes.** It is a governing file, so changes go through a class (a) pull request under the design gate
(agent-rules 12). New rules arrive as proposals from `.claude/skills/retrace-retro` and are written by the coordinator.
Before adding a rule, ask whether an existing rule or claim should be removed instead.

**Sources.** The finding text comes from the verdict file where it survives. Where the file was in `/tmp` and is gone,
it comes from the coordinator's fix brief that restated it, and the rule says so.

---

## Secrets and untrusted input

**CS-1. No secret or input value in an error, a log, a stack or a cause.** On any path that reads a secret or
untrusted input, an error that leaves the function is a new, fixed error. It names the failing field and never a value.
A caught runtime error is not attached as `cause`, and its message is not carried over.
- *From:* PR 248 round 1, Codex, Medium, `evt_73cc3ae7563f45729002cd113cebc344`. In workerd, a malformed
  `RETRACE_SIGNING_KEY` reached Workers Logs: the runtime's JWK import error quoted the bad `kty`/`crv` value, and the
  router logged the whole stack. (The text is restated in the round-2 fix brief; the verdict file is gone.)
- *Check:* a test feeds a made-up value and asserts that no 4-character fragment of it appears in the thrown
  `message`, `stack`, `cause`, the response body or the captured log. Reading test: every `catch` on such a path
  throws a fresh error and does not pass the caught one on.

**CS-2. Validate the shape before any runtime parser or importer sees secret material.** Between reading a secret
and its first runtime import, a validator checks the fields, their types and their exact allowed values. It then fails
with a CS-1 error.
- *From:* the same finding: `parseSigningKey` accepted any valid JSON and handed it to WebCrypto, whose error text we
  do not control.
- *Check:* reading test. The first use of the value after the env read is the validator call. Tests cover one
  malformed made-up value per validated field.

**CS-3. A public response is built from an explicit allowlist and never spreads a secret-bearing object.** Name each
public member. `{...secret}`, `Object.assign({}, secret)` or a rest-spread minus a denylist is never allowed for an
object that holds, or was derived from, a secret.
- *From:* PR 248 round 2, Codex, Medium, `evt_21e248530eac4ec79e9be6fb6cb45e9f`. `publicFromPrivate` spread every
  member except `d` and `key_ops`, so `GET /.well-known/retrace-pubkey` published any extension member of the
  signing key. The same finding showed that `d` was never checked to derive `x`. (Restated in the round-3 fix brief;
  the verdict file is gone.)
- *Check:* `git diff <base>..<head> | grep -nE '^\+.*\.\.\.[A-Za-z_]*(key|jwk|secret|cred|token)'` lists the
  candidates, and a reading test decides each one: does it reach a response? The grep is a locator, not a verdict.
  It flags rest patterns too: on the last twelve merges into main it hit only PR 235's `{ alg: _alg, ...jwk }`,
  which feeds an import, not a response.

## Guards and caches

**CS-4. A check guards every path to the effect it protects, or the pull request names the unguarded path and says
why.** If a check protects an effect (signing, publishing, sealing, counting), every caller that reaches that effect
goes through it, preferably through one shared helper.
- *From:* PR 248 round 3, Codex, Medium, `evt_b320ac71630b4da7baab3f1e09f2b7f8`
  (`~/.retrace/ops-2026-10-15/issue232/verdicts/VERDICT-codex-pr248-r3.md`, sha256 `2db4eb6f…66a8`). The d↔x pair
  check ran on the public-key route only. The signed head, fresh export, producer signing and the scheduled
  checkpoint still signed with a mismatched key.
- *Check:* the pull request body lists every call site of the guarded effect, taken from `git grep` at the head, and
  names the test that covers each one.

**CS-5. No check-then-cache across an `await` on a mutable input.** Take one immutable snapshot before the first
`await`, check that snapshot, cache that snapshot, and use that snapshot afterwards. Never re-read the live object.
- *From:* PR 248 round 4, Codex, Medium, `evt_5c175362fdda479b93a37178c141f30f`
  (`~/.retrace/ops-2026-10-15/issue232/verdicts/VERDICT-codex-pr248-r4.md`). If `d` changed during the awaited
  derivation, the pair check cached a mismatched key, and the key then signed.
- *Check:* reading test. In an async function that caches, every value read after the first `await` that feeds the
  cache key, the cache value or the effect is a local snapshot. A regression test mutates the input in a
  `queueMicrotask` while the first check is pending.

## Verification paths and evidence

**CS-6. A rewrite of a verification, verdict or attribution path is proved exactly equivalent to the old path.** The
proof is differential tests that run the old and new paths over the same fixtures and require deep equality. The
fixtures include malformed, tampered and non-canonical rows. A "stated divergence" is not an acceptable outcome.
- *From:* PR 244 round 1: Codex High and Medium, `evt_96aed167513140beaaf5a41904ed6304`; NOOA Medium and three Lows,
  `evt_879e3d48a4294e8297685efa0cf5f1b4`. With a TEXT or BLOB `seq`, paged verify returned `{ok:true, checked:1000}`
  where `store.all` found the tamper at row 1,200. The attribution lookup inferred absence from the mutable `action`
  column. The coordinator's brief had allowed a stated divergence; the round-2 brief withdrew that allowance.
  (Restated in the round-2 fix brief; the Codex verdict file is gone and NOOA's text stays on its host.)
- *Check:* the diff adds or keeps a test that calls both paths on shared fixtures and asserts deep equality. Its
  fixture list names the shapes above.

**CS-7. Check a value's type and domain before it decides a count, a page bound or a verdict.** Never infer a fact
from a column or string that can disagree with the sealed body.
- *From:* PR 244 round 1 (above): a non-integer `seq` truncated verify; the `action` column was trusted; Codex Low,
  page bounds of 0 gave `{ok:true, checked:0}`. And PR 224 round 1, Codex, Medium, `evt_26759ce0aa4b410d8dfef93ed6238343`:
  `commit_shas` counted `commit:repo@not-a-sha` and upper/lower-case copies of one SHA as distinct SHAs.
- *Check:* tests feed a wrong type, a zero, negative or non-finite number, and a non-canonical spelling, and each
  input is refused or normalised. Reading test: no count or verdict reads a column without that column's check.

**CS-8. A test of runtime-dependent behaviour runs in the runtime that ships.** Worker paths that touch WebCrypto,
streams or the runtime's own error text are tested in the workerd pool (`*.workerd.test.ts`), not only in Node.
- *From:* PR 248 round 1 (the leak reproduced only in Miniflare/workerd) and round 3 (Node refuses a mismatched key
  at import, so the Node tests could not show that workerd signs with it).
- *Check:* a diff that changes such a path adds or updates a `*.workerd.test.ts` case for it, or the pull request
  says why none is feasible.

## Text that ships with a change

**CS-9. Every count and every completeness claim is backed by a command run at the head, or removed.** This covers
test counts, "all", "every", "covers", "none" and inventories, in a pull request body, a note or release text. Each
names the command that enumerates it. A claim without its command is removed rather than defended.
- *From:* PR 248 round 1, Codex Lows (`evt_73cc3ae7…` above): the body said 15 new tests where there were 14, and its
  secret inventory missed `RETRACE_ISSUER` and `RETRACE_OPS_PROJECT` and misclassified `RETRACE_TRAILER_POLICY`.
  PR 242 round 1, Codex, Medium, `evt_c9e62e54320e4f5b8b7301cf6841bfdf`: the release notes claimed coverage of the
  changes since 0.3.0 and omitted four shipped behaviour changes (PRs 207, 208, 219, 229). PR 242 round 2, NOOA,
  `evt_e17e320462724a9286fa77a0982f45ac`: the coverage sentence overstated what the sections covered.
- *Check:* the body's "How to verify" names a command for each number and each completeness claim. The reviewer can
  re-run it.

**CS-10. Public text carries no personal account identifiers and no device inventories.** Leave out local login
names, hostnames, IP addresses, lists of devices, and email addresses other than the published contact. State the
conclusion the argument needs instead of the inventory behind it.
- *From:* PR 245 round 1, Codex, Medium M1, `evt_8c118c8c5aa945eb9849fe5c01d64051`. An incident note quoted Jordan's
  account of events with the PC's local login identifier in it. The minimum correction also cut its peer statement down to the conclusion
  it needed, with no device list. (Restated in the round-2 fix brief; the verdict file is gone.)
- *Check:* `git diff <base>..<head> | grep -nE '^\+.*\b([0-9]{1,3}\.){3}[0-9]{1,3}\b'` lists candidate addresses.
  Loopback and unspecified addresses (`127.0.0.1`, `0.0.0.0`) pass; on the last twelve merges into main, its only
  hits were PR 181's `127.0.0.1` (twice) and `0.0.0.0`. Add a reading test for login names, hostnames and device lists.

**CS-11. Each factual statement says who established it.** It is either observed or read back (and names the
command or record), or reported (and names who reported it). An inference the evidence does not support is called
unsupported, not refuted and not true.
- *From:* PR 245 round 1, Codex, Mediums M2 and M3 (`evt_8c118c8c…` above). A boot inference was stated as refuted
  rather than unsupported, and repair items Jordan reported were mixed in with items that were read back.
- *Check:* reading test. In measurement notes, incident notes and pull request bodies, every past-tense factual
  sentence carries its source: a command, an event id, a file hash, or "reported by <who>".

---

**Considered and not included.** Two candidates from the brief came from incidents, not from review findings, so
they are not standards here. *Scratch environment inline on every test run* is already binding as agent-ops 10.
*No closing keywords in pull request bodies* is an existing body rule ("Refs #N", never "closes #N"), and
`.claude/skills/retrace-pr` enforces it mechanically.
