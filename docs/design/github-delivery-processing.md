# GitHub delivery processing

**Status:** architecture interview draft, 2026-10-21. Not built. Owner accepted the
individual choices below; final shared-understanding confirmation is pending. This
document records a proposed design, not a formal review verdict or execution authority.

**2026-10-21 update (supersedes the draft status above):** Jordan confirmed the final
shared understanding in `evt_ad84db2eb48345e088b1b80024d8029f`, interpreted in
`evt_5f1016c11a434f48bd51d85d28868549`. The bounded local extraction is implemented
and the checks below pass. Earlier draft statements remain visible as history;
formal review remains outstanding. Validation is recorded in
`evt_4de42c6678914236974938eb7fef999a`.

**Inspected source:** `a02f27483c509d3ff5822cb689600b765c98427c`.
**Author:** Codex, `gpt-6-astra`, harness-runtime, effort `ultra`.
**Named task root:** `evt_1beb2396455f415fa01cfecaf9e39742`.

## Problem and scope

GitHub receipt and pending retry currently coordinate mapping, validation,
deduplication, classification, sealing and completion separately in `router.ts`.
Understanding partial progress or changing a shared processing rule requires reading
both loops and distinguishing intentional differences from accidental divergence.

Concentrate that knowledge in one deep GitHub delivery module. Its interface owns
one whole delivery attempt, including partial outcomes. Its depth comes from hiding
processing order and recovery obligations; locality comes from keeping receipt and
retry rules together. Deleting the module would spread those obligations back into
both callers.

The first extraction covers enabled push, pull-request, review and comment deliveries
through receipt and retry. Preserve compatibility with every other delivery that can
already be parked, including historical records. Preserve existing behavior, even
where it looks inconsistent. Investigate and scope corrections separately.

## Agreed ownership

| Responsibility | Owner |
| --- | --- |
| Signature verification, original ingress capture, JSON/repository checks, routing/policy preflight, pending-row reuse and cross-project conflict checks | Existing receipt caller |
| Early parking caused by unresolved routing or missing policy | Existing preflight path |
| Start the receipt deadline at its existing position, after preflight | Existing receipt caller |
| Ordinary processing retention, breaker admission and outcome recording, mapping, validation, per-event deduplication, classifier calls, stamping, sealing and delivery-wide progress | GitHub delivery module |
| Translate receipt outcomes into the existing HTTP responses | Existing receipt caller |
| List eligible rows, acquire leases, schedule retries and accumulate drain totals | Existing retry caller |
| Process a claimed row, compute aggregate outcomes, conditionally save progress and perform permitted cleanup | GitHub delivery module |
| Attribution decisions, policy/evidence selection and owner-login declaration allocation retries | Existing classifier and append modules |

The receipt caller does not move the timer before preflight. The module receives
the absolute deadline and preserves the current placement of raced and unraced work.
The retry caller supplies the row and ownership values returned by successful lease
acquisition. The module does not acquire or renew leases.

## Interface shape and dependencies

Use two named operations, `receive` and `resume`, in one module. Each invocation
supplies its current context; no delivery state or current-policy snapshot is cached
between calls. A likely file is `packages/core/src/github-delivery.ts`; exported
identifier spelling is an implementation detail.

Illustrative shape, not a complete type definition:

```ts
receive(store, routedReceipt, receiptContext): Promise<ReceiptOutcome>
resume(store, claimedPendingDelivery, retryContext): Promise<RetryOutcome>
```

The routed receipt includes the authenticated raw input, parsed payload, event kind,
original ingress, delivery identity, project/repository and routing facts. Its context
includes the existing current-policy fallback, trailer mode, push inclusion, deadline
and clock. The retry input includes retained raw input and outcomes plus the acquired
lease owner/until values; its context includes trailer mode and the existing drain
clock. These values represent existing caller knowledge, not new authentication
guarantees.

Return the data needed for the existing receipt responses or drain accounting.
Preserve expected receipt interruptions and recognized write errors without erasing
ordered validation-error entries. Preserve unexpected exceptions and retry rejection
behavior; a common result type must not turn every exception into a recoverable row.

Mapping and classification are in-process dependencies. Reuse `mapGithubWebhook`,
`classifyCommitClaim`, `appendOwnerLoginEvent` and `appendEvent`, preserving their
independent callers. Reuse the existing `EventStore` seam and its adapters. Missing
optional store methods retain their present behavior; the new module does not promise
capabilities that an adapter lacks. No new transport or queue-operation protocol is
needed for this extraction.

Private implementation is shared where behavior agrees. Distinct receipt and retry
rules stay explicit; callers do not select individual processing stages or supply an
arbitrary callback pipeline.

## Persistence and preservation requirements

For ordinary retry completion, process the row, save aggregate outcomes once using
the existing owner-conditional update, then delete only after a successful save when
all mapped keys are sealed. A failed save cannot authorize cleanup. Keep the existing
malformed-payload branch and exception behavior distinct from ordinary completion.

| Existing distinction | Preserve during extraction |
| --- | --- |
| Receipt deadline | Starts after preflight; ordinary retention is awaited outside the deadline race. Cleanup retains its existing deadline behavior. |
| Breaker | Receipt admission precedes mapping. A successful classification records its breaker outcome and clears the probe before append. Retry bypasses the breaker. |
| Classification time | Receipt supplies its clock/deadline. Retry push classification currently omits them and uses classifier defaults; non-push retry supplies a fresh per-item deadline and the drain clock. |
| Attribution failure | Unavailable commit classification can leave work pending. Unavailable owner-login classification can seal with the GitHub-account actor and consume no declaration. |
| Policy and evidence | Owner-login keeps its head-bound policy selection and allocation-loss reclassification. Commit classification keeps its existing context and policy digest. |
| Identity and mapping | Preserve delivery versus semantic push idempotency, original ingress, configured receipt push inclusion, unconditional retry push inclusion, and historical missing event kind as push. |
| Stamps, invalid inputs and empty mappings | Preserve field absence and the current receipt/retry differences. Empty retry mappings do not become successfully completed deliveries. |
| Append and failures | Preserve dedup read ordering, branch-specific UNIQUE retries, receipt error conversion and retry exceptions. Do not introduce catch-and-continue behavior. |
| Timeout | Expiration is not cancellation. Already-started inserts may finish later; retained input and idempotency support recovery. Observe late failures as today. |
| Lease and checkpoint | Keep owner-equality saving, existing lease-field updates, one aggregate save after processing and existing deletion behavior. Do not add expiry rechecks or per-event checkpoints. |

The stamp and empty-input differences are observations from static inspection, not
independently tested defect verdicts. Characterize them before extraction rather than
silently normalizing them.

## Acceptance evidence

Retain caller tests for authentication, routing, initial receipt timing, pending reuse,
partial processing, late inserts, leases and exceptional delivery compatibility. Retain
mapper, classifier, owner-login allocation and store-adapter tests at their existing
seams. Move selected duplicated processing assertions only after equivalent coverage
exists through `receive` or `resume`.

Add focused characterization for complete sealed records across the four families,
including actor attribution, stamps, policy/evidence decisions and field absence.
Handle generated identifiers and timestamps explicitly while verifying chain/hash
relationships; do not broadly omit metadata from comparisons. Receipt and retry are
each compared with their existing behavior, not forced to match one another.

Add an active-drain lease-loss scenario that proves a failed ownership save cannot
delete the retained row. Preserve coverage for partial seal followed by timeout,
redelivery, retry and later deduplication; terminal budget/invalid-input outcomes; and
late insert completion with durable recovery. Keep SQLite/D1 transactional tests at
their existing store seam. No application tests have been run for this design draft.

## Alternatives and interview record

A tagged receipt/retry operation is viable, but two named operations make each caller's
required context easier to read. An alternative preparation operation could absorb
routing while preserving the timer split; the selected design retains that preflight
with the caller. A typed execution/queue-effect protocol adds another lifecycle and
adapter contract without an established need beyond the existing store seam.

Returning a progress plan to the caller would keep persistence outside but expose
save-before-delete ordering as a caller obligation. Module-owned conditional saving
and cleanup provide more leverage while keeping lease acquisition outside.

| Owner decision | Instruction event |
| --- | --- |
| Q1-Q2: preserve behavior; four-family scope plus exceptional queued compatibility | `evt_a4025e3aba6546c8a2d2241bd8454a5f` |
| Q3-Q5: delivery-wide ownership; existing classifiers/adapters; behavioral acceptance | `evt_6433a38afae74d128ed68546860a3f62` |
| Q6-Q7: receive/resume; module-owned processing retention, progress save and cleanup | `evt_634943101fe54e21b7b73677fe5b7b94` |

The short owner replies are interpreted in their preceding question context and
recorded by the corresponding receipt events. The named task root above remains the
authoring root. This draft does not represent formal review, a merge decision or a
completed implementation.

## Source anchors at the inspected revision

- `packages/core/src/router.ts:598-816`: receipt preflight, timer, retention and processing.
- `packages/core/src/router.ts:1286-1424`: lease acquisition, retry processing and finalization.
- `packages/core/src/classify.ts:1004-1045`: classification context and default timing.
- `packages/core/src/owner-login.ts:242-296`: unavailable attribution and append ownership.
- `packages/core/src/store.ts:1038-1155`: append deadlines, late inserts and deduplication.
- `packages/core/src/classify-http.test.ts:615-854,982-1042`: late insert, terminal outcomes, leases and partial-delivery recovery.
- `packages/core/src/router.test.ts:1121-1156,1287-1328`: queued comments, workflow compatibility and late inserts.


## Implementation and validation update — 2026-10-21

This update supersedes the draft's pending-confirmation, not-built and no-tests-run
statements. Q8 confirmed the complete design and proceeding with its bounded local
implementation (`evt_ad84db2eb48345e088b1b80024d8029f`). The named authoring root is
unchanged.

`packages/core/src/github-delivery.ts` now exposes `receive` and `resume`.
`router.ts` retains authentication, routing/preflight, initial receipt clock setup,
HTTP rendering and lease acquisition. The module owns ordinary retention, mapping,
validation, deduplication, calls to the existing classifiers, sealing, progress saves
and cleanup. Existing receipt and retry differences remain explicit. The unchanged
stamp helper now lives in `producer-sig.ts`; recognized append-error rendering lives
beside its error types in `store.ts`. No storage schema or classifier behavior was
changed. The current-policy fallback is carried by the routed receipt.

One compatibility detail emerged during the extraction audit: receipt initially reads
push inclusion before starting its clock, then reads it again for mapping after
retention/breaker awaits. Retry reads trailer policy at each push classification after
deduplication; malformed payloads never read it. The first extraction accidentally
read these options too early. Three regression tests failed before correction and
passed afterward. The receipt context now carries the initial admission fact plus a
getter for mapping inclusion; the retry context forwards a trailer-policy getter.
This preserves existing read timing rather than establishing a new snapshot rule.
The correction and focused results are recorded in
`evt_9c823db0011e451886352c5eb4576c06`.

Complete-record fixtures were captured against the inspected revision before
extraction. Their SHA-256 remains
`48897f9396b5d631b7b61fbacb5535d5c6e38599fd992777f0706d20459c658a`.
Ten receipt/retry comparisons now exercise the module directly across push off,
push shadow, pull request, review and comment cases. Two additional review cases
exercise its callers. Four recovery cases cover active lease loss followed by
deduplication, expired leases without takeover, empty mappings and historical queued
records. Together with the three option-timing cases, these are 19 focused tests.
Existing caller, classifier, allocation and SQLite/D1 adapter tests remain in place.
The stamp and empty-mapping observations above now have characterization coverage;
they have not been reclassified as defects or changed.

Validation in the isolated `codex-github-delivery-design` worktree:

| Check | Result |
| --- | --- |
| Core build | Passed |
| CLI build | Passed |
| Core tests | 590 passed, 0 failed; includes the 19 focused tests |
| CLI tests | 314 passed, 0 failed |
| Worker typecheck | Passed after CLI declaration build |
| Worker tests, including D1/workerd coverage | 95 passed, 0 failed |

The earlier Worker typecheck started concurrently with the CLI build and could not
resolve its generated declarations; the correctly ordered rerun passed. A static
follow-up audit found no additional extraction differences after the timing fixes.
That audit is not a formal review verdict. The validation event is
`evt_4de42c6678914236974938eb7fef999a`; local test outputs are
`/tmp/retrace-delivery-{core,cli,worker}-tests.log`.

The implementation remains uncommitted in the isolated worktree. No PR, merge or
deployment has been performed. The source anchors above still refer to the original
inspected revision, not the new module's line numbers.
