# Attribution amendments (v7 implementation branch)

This feature is under review, not released. The spec of record is
[the v7 amendment design](design/attribution-amendment.md), including implementation
gate #2139. B1 fixes the eligible artifact universe. B2 defines scoped replay and
B3 requires reproducible capture context; their inclusion in v1 remains an explicit
review decision. The contract's larger test matrix is not a claim that every row passes.

## Human amendment workflow

Use the human owner credential in a human terminal. `retrace_amend` recognizes an
`attribution` argument, mutually exclusive with `artifact_roles` and
`attest_causal_root`, but refuses agent relays with `relay_disabled`. The supported
write path is the CLI. It checks the remote owner's identity through authenticated
`GET /identity`; per-agent credentials cannot call that endpoint.

Provide a reviewed policy file, or put the same object under `attribution` in
`.retrace.json`. This example is illustrative: use the actual repository names,
historical sequence intervals and exact server stamps for the project.

```json
{
  "profile": "retrace-attribution/1",
  "repositories": [{
    "name": "owner/repository",
    "aliases": ["repository"],
    "from_seq": 0,
    "hook_sealed_by": ["assert:git hook (assert)"]
  }],
  "non_git": []
}
```

Intervals have optional inclusive `through_seq`. Non-Git entries specify `scheme`,
`from_seq`, optional `through_seq`, and exact `capture_stamps`. A current hook
configuration is not evidence of its historical validity. Missing policy or Git
objects yields unavailable attribution, not inferred history.

```sh
retrace-export amend-attribution --repo . --project PROJECT \
  --policy attribution-policy.json --human HUMAN_ID \
  --target evt_TARGET --to agent/ACTOR_ID \
  --evidence evt_EDIT1,evt_EDIT2 --caused-by evt_INSTRUCTION \
  --reason 'Human reviewed the covering contributions' --dry-run
```

Remove `--dry-run` to append. Set `RETRACE_PROJECT` and storage/credential environment
for the intended project; repository selection does not switch remote credentials.
Optional `--artifacts` narrows scope to comma-separated canonical artifact IDs.
`--from type/id` is needed when the current scoped identity cannot be inferred;
`--supersedes evt_ID` explicitly replaces the intersecting active amendment.

The preview names the verified head and policy/Git digests. It is advisory under
concurrent writes. Its `diagnostics_summary` gives a total and counts by reason.
Add `--verbose` to include the full `diagnostics` list of malformed or unavailable
commit references on non-seal events (for example, a `sent` git-push report) as `ignored`, with the
event ID, sequence, and original artifact ID. These references neither define capture
windows nor get corrected by guessing an object ID. Required references on commit
and merge events still fail closed when their full identity is unavailable.
The CLI prints the durable event ID before attempting a post-write
read, then reports whether that sealed record is effective. Exit 0 means successful
preview/effectiveness; 1 means a rejected command or preflight; 2 means a durable
record exists but is ineffective or its final evaluation is unavailable.
`--seal-anyway` records a rejected semantic attempt for audit; it never bypasses
malformed input, human authority or relay restrictions.

## Reading the result

```sh
retrace-export render bundle.json --pubkey trusted-public.jwk \
  --repo . --policy attribution-policy.json
retrace-export render bundle.json --pubkey trusted-public.jwk \
  --repo . --policy attribution-policy.json --effective
```

The default banner reports amendments and retains recorded actors. `--effective`
puts effective identities first and keeps recorded identities alongside them.
Partial amendments say “1 of N artifacts” and do not replace the event-level actor.
Signed export event bytes never change. Scoped or unverified bundles and consumers
without required Git context disclose unavailable evaluation. Worker/UI views have
no Git context and retain recorded identities with that disclosure.

Only complete per-file certificates for the selected commit seal can downgrade
reconciliation's commit-level misattribution failure. Covering actors and producer
agreement remain based on recorded identities. Optional blob and actual Git trailer
matches are annotations, not sufficient evidence.

## Review and rollout

Rebase this branch onto the merged `cursor/gate-trust-boundary` and
`copilot/object-store-doctor` prerequisites before landing. Claude reviews before
merge. Jordan deploys the Worker after the NOOA Ultra review and review fixes,
before the PR gate can pass; Codex does not deploy it.

Worker runtime changes are `apps/worker/src/mcp.ts`, shared core router/status/
lineage/report/explain/amendment code, the new attribution modules, and the embedded
UI. The router adds owner-only `/identity` and advertises `attribution-v7` through
`/api`. `doctor --gate` fails if that capability is absent; ordinary doctor warns.
No database migration is required.

Do not mark the README feature shipped or claim the historical seq-18 demonstration
until review, deployment and a qualifying human-selected live amendment are complete.
