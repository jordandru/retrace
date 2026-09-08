# Attribution v7 — normative implementation contract

Preserved from Codex review #2139 (`evt_4f2bb7c1480f4766b88ad309fd5a797d`),
2026-09-07. Historical code links refer to the reviewed baseline `1d24ee8`.
Feature tests described below are specifications until implemented and validated.

## Scope and input contract

**Identity and attribution units**

Actor identity is the exact pair:

```ts
type ActorRef = Readonly<{
  type: "human" | "agent" | "system";
  id: string;
}>;

// Collision-safe key; never compare id alone.
actorKey(a) = JSON.stringify([a.type, a.id]);
sameActor(a, b) = a.type === b.type && a.id === b.id;
```

IDs are nonempty strings. Do not trim, case-fold, normalize Unicode, or compare display names. In particular, `human/x`, `agent/x`, and `system/x` are different identities. The operator and beneficiary may have identical `id` strings under different types.

For each target `T`, derive an immutable universe `U(T)`:

| Reference or operation | Attribution treatment |
|---|---|
| Explicit `generated` or `both` artifact | Eligible output claim, subject to the exclusions below. |
| Explicit `used` artifact | Input-only; ineligible unless another reference to the same canonical artifact supplies an output claim. |
| Role absent | Fall back to `created`, `edited`, `deleted`, `moved`, or `renamed`; for commit file references, also `committed`/`merged`. |
| `executed`, `sent`, `other`, etc. | Eligible only through explicit `generated`/`both` roles. |
| Commit reference | Context identifying the recorded commit seal; never an independently amendable file-contribution claim. |
| Event/actor reference | Context, never an attribution unit. |
| `caused_by`, `derived_from`, commit parents | Links, not implicit scope members. |
| Deleted artifact | Attribution of the claimed deletion/state transition; does not assert surviving content. |
| Git target | Eligible references must correspond to changed-file transitions in verified Git facts. |
| Non-Git target | Eligible canonical output/invalidation artifacts explicitly referenced by the target. |

Use **recorded roles**, including their recorded absence. Provenance role amendments do not enlarge attribution scope or turn old input references into primary evidence. Otherwise role amendments would introduce an additional authorization dependency and an evidence-laundering route.

Duplicate references to one canonical artifact form one attribution unit. Retain all original reference indexes and roles for display and auditing. A duplicated input/output pair represents one artifact with an output claim, not two independently amendable identities.

**Canonical artifacts and aliases**

- Git identities are `(canonical repository identity, exact repository-relative path)`.
- Repository aliases are explicit, versioned policy inputs. Resolve historical event references under the mapping applicable to that event.
- Preserve case, Unicode, percent characters, and literal path characters. Do not use filesystem case folding or `realpath`.
- Reject traversal, absolute repository-relative paths, and ambiguous mappings. Never resolve `..` against a checkout.
- Bare paths and `file:` references remain **loose matches** unless an explicit trusted mapping establishes their identity. CLI path shorthand may be resolved into a canonical ID before submission; that does not upgrade historical loose evidence.
- A foreign repository’s same-named path is not strict evidence for this repository.
- Other artifact schemes use exact IDs, with only explicitly declared aliases.
- An unrepresentable Git filename makes the required context unavailable; it must not disappear from the changed-file denominator.

The raw sealed IDs remain unchanged. Canonicalization creates comparison keys and reference mappings only.

**Git transitions**

A changed-file attribution unit is identified by its destination path; deletion uses its deleted path.

- `A/M/T`: match that path.
- `D`: match the deleted path; content matching is not applicable.
- `R/C`: scope the destination transition. Evidence may match destination or the verified `from` path, as reconcile currently allows. The lower bound is the maximum previous-touch sequence across those names.
- Rename/copy source paths are evidence aliases for that transition, not permission to amend an unlisted source artifact.
- No identity alias is inferred merely from `derived_from` or prose.
- Merge attribution uses an explicitly declared first-parent diff; root commits use the empty tree. This describes that diff’s file contributions, not merge-resolution authorship or all parent histories.
- Reconcile continues to skip ordinary coverage evaluation for merge commits. An amendment does not change that eligibility decision.

Git facts must declare their diff profile and carry explicit rename/copy results. Consumers must use the same supplied facts, rather than rerunning different rename heuristics silently.

**Scope normalization**

1. Omitted scope means `U(T)`.
2. Explicit empty scope is `scope_invalid`.
3. Deduplicate repeated entries after canonicalization; sort canonical keys by deterministic code-unit order.
4. Every entry must identify an eligible unit represented in the target’s own references. Unknown, input-only, commit, and event references are `scope_invalid`.
5. An empty eligible universe is `scope_invalid`.
6. Scope is atomic: the checker either admits its entire normalized set or none of it.
7. The normal CLI seals an explicit normalized scope. Omitted scope remains supported when reading sealed payloads.

For Git targets, maintain a separate `domain_complete` flag: **every Git changed-file transition must be represented by an eligible target reference**. Missing target file references cannot be repaired by inventing references during derivation.

```ts
whole_event =
  U(T).size > 0 &&
  scope === U(T) &&
  domain_complete;
```

For non-Git targets, `domain_complete` means all eligible target references were successfully resolved.

**Event-level versus artifact-level claims**

- Only a **single active amendment with `whole_event: true`** changes the event-level effective actor.
- Several disjoint amendments never promote themselves into an event-level amendment, even if their union covers every unit and their beneficiaries agree.
- Thus “2 of 2 artifacts across two partial amendments” can legitimately retain the recorded event-level actor.
- Context references and input-only artifacts retain their recorded association, even when the event’s eligible output summary is wholly amended.
- `whole_event` means the entire eligible contribution domain. It does not claim that the beneficiary operated Git, authenticated the original seal, authored every byte, or used every input.

When attribution changes, the effective actor projection contains `{type,id}` and the target’s unchanged `on_behalf_of`, if present. **Do not copy the old `model`, `display_name`, or `version` onto the beneficiary.** Do not borrow those fields from another event and present them as metadata of the target action. Witness models/names may be listed separately with their evidence event IDs.

This preserves the recorded human delegation without inventing a target model. Model-only requests remain unsupported.

**Snapshot and trust requirements**

An authoritative derivation requires:

- One designated project, complete from genesis through an identified head `(seq, hash)`.
- Unique event IDs and project sequences after exact duplicate retrieval rows are collapsed.
- Safe-integer, nonnegative sequences; contiguous `0..head.seq`.
- Valid event hashes, chain links, genesis link, and the declared head.
- An authenticated issuer/head or equivalent trusted acquisition establishing that server stamps are server-authored.
- Original event objects retained without schema parsing that silently strips hash-covered fields.
- Explicit project-local absence: a missing reference in a complete snapshot is absent at that head, not a retrieval failure.

A filtered export, why-chain, artifact history, or newest history page is insufficient. Derive from full context **before** filtering the display.

Exact duplicate records may be collapsed for derivation. Conflicting bytes under one ID, different IDs at one sequence, incompatible heads, or mixed project rows invalidate the snapshot. There is no “last row wins” rule.

A separately authenticated foreign-reference lookup may distinguish `wrong_project` from `missing_target`. Without it, absence from the complete project snapshot is reported as `missing_target`; neither outcome is effective.

The v1 sufficient evidence arm rests on an authenticated **server receipt**:

- Primary evidence requires a `pinned:` or `assert:` stamp.
- Actor existence additionally accepts authenticated `webhook:` appearances.
- Human amendment authority accepts authenticated owner/assert authority, or a genuinely human-pinned credential supported by the server’s actor-resolution rules.
- Unstamped, unauthenticated, or webhook-produced amendment attempts do not establish Tier 1 operator selection.
- A producer signature alone does not replace a required receipt stamp.

Unsigned evidence is permitted. Producer signatures are additional evidence, not a new v1 sufficient arm. An invalid optional producer signature must be reported as such; it cannot be displayed as verified. A caller whose independent integrity policy refuses the input must return an unavailable derivation. The default attribution profile does not infer authorship from signature presence.

Current server behavior supports the distinction: [server stamps overwrite caller values, and actor resolution precedes signature verification](https://github.com/jordandru/retrace/blob/1d24ee8b73f03803e1eca4efca53a4dc4dcf7c2c/packages/core/src/router.ts#L511-L538). The [producer signature excludes model/display metadata](https://github.com/jordandru/retrace/blob/1d24ee8b73f03803e1eca4efca53a4dc4dcf7c2c/packages/core/src/producer-sig.ts#L10-L26).

**Required external context**

Every result identifies:

```text
project + ledger head + attribution profile + policy digest + Git-facts digest
```

The policy/Git context supplies:

- Canonical repositories, historical aliases and supported path interpretation.
- Exact trusted hook stamps, owner override, and legacy-seal treatment.
- Historical applicability of those policies.
- Full commit identity resolution; ambiguous abbreviated SHAs are unavailable context.
- Target diffs, parents, and rename/copy information.
- A frozen Git reference/reachability view, including the checkout horizon.
- Non-Git capture-producer policy.
- Optional content/trailer observations, separated from required facts.

An object lingering in Git’s object database is not sufficient to establish reachability. Use the adapter’s ref-reachability/horizon rule; do not exclude merely unfetched older history. Missing target/parent objects needed to establish a diff are unavailable context. Missing historical policy must not silently become today’s configuration.

For a simple v1 implementation, required-context availability is **all-or-nothing for an evaluation**: an incomplete snapshot or missing required capture context yields no authoritative active map. Optional content observations are outside that requirement. Render recorded data with an “attribution evaluation unavailable” notice; do not report “zero effective amendments.”

## Deterministic derivation algorithm

**Capture context construction**

Extract one shared capture-index implementation for reconcile and attribution. Its inputs and profile must be explicit.

1. Classify raw commit-shaped events using the configured exact hook identities and authenticated webhook stamps. Pinned client commit claims do not become hook seals.
2. Preserve the existing legacy distinction: pre-stamp historical seals may bound windows even when they are not accepted as trusted target seals. Post-stamp unstamped claims do not acquire that status automatically.
3. Resolve commit identity to a full OID and canonical repository. Reject ambiguous/conflicting resolution as unavailable context.
4. Group producer seals by full commit identity. Select the earliest seal per producer; retain later duplicates as recorded history.
5. Build one boundary per commit identity from its trusted/historical capture seals. Its sequence is the earliest applicable capture receipt. Its touched-artifact set comes from the recorded file references accepted by the shared capture profile.
6. Exclude only the seals classified as abandoned under the supplied reachability/horizon facts.
7. For a Git target `T` referring to commit `K`, use:
   - `before = min(T.seq, earliest applicable capture receipt for K)`, falling back to `T.seq` when no applicable capture seal exists.
   - Exclude `K` itself from preceding-touch lookup.
   - For each transition, `after = max(previousTouch(name, before))` over its destination and any verified rename/copy source.
8. For an ordinary MCP event referring to repository files, use the same commit-boundary index, ending at `T.seq`.
9. For a genuinely non-Git artifact, only policy-designated capture events close its window. In v1 these are `committed`/`merged` output references from exact configured capture-producer stamps. Ordinary edit claims do not close it.
10. If the relevant capture policy is present but there is no preceding capture, `after = -1`. An absent policy is unavailable context, not an empty boundary history.

Every primary witness must satisfy:

```text
after < evidence.seq < before ≤ target.seq < amendment position
```

The shared same-SHA cutoff is a required repair to v6. It prevents the webhook copy from swallowing pre-hook evidence and prevents a late duplicate receipt from extending the evidence window.

**Replay semantics**

Use these distinct concepts:

- **Admitted at replay position:** passed the checker when replay reached it.
- **Active:** admitted and not subsequently replaced during that target’s replay.
- **Superseded:** admitted, then replaced; retained as a valid historical chain link.
- **Rejected:** failed the current snapshot’s replay; never mutated state.
- **Unavailable:** the necessary input context cannot establish a result.

For each target, maintain:

```ts
interface TargetState {
  active: Map<AmendmentKey, AttributionClaim>;
  owner: Map<ArtifactKey, AmendmentKey>;
}
```

`owner[p]` identifies the single active amendment governing `p`. Otherwise `p` has the recorded target identity.

The evidence ban remains **event-wide**, as v6 explicitly states. If evidence event `E` has any active attribution amendment, no artifact from `E` can serve as primary evidence. A partial amendment of `E.b` therefore disqualifies `E` as a witness for `a` too. This is conservative collateral invalidation, not a direct attribution expansion.

However, cited evidence is existential per artifact: another clean qualifying witness can still satisfy that artifact. A bad, absent, or amended extra citation does not invalidate an otherwise completely corroborated scope.

**Pseudocode**

The schema, identity, scope, capture, authority, and failure rules used here are defined explicitly in this contract. Validation never mutates raw events.

```ts
function normalizeSnapshot(input: SnapshotInput): SnapshotResult {
  // Validate the authenticated envelope before trusting stamp fields.
  if (!input.proof.authenticated)
    return unavailable("untrusted_snapshot");

  const byId = new Map<EventId, Readonly<Event>>();
  const bySeq = new Map<number, Readonly<Event>>();

  for (const raw of input.events) {
    if (!validEventShapeWithoutStrippingFields(raw) ||
        raw.project !== input.project ||
        !Number.isSafeInteger(raw.seq) || raw.seq < 0)
      return unavailable("invalid_snapshot");

    const previous = byId.get(raw.id);
    if (previous) {
      if (canonicalFullRecord(previous) !== canonicalFullRecord(raw))
        return unavailable("invalid_snapshot", "conflicting_id");
      continue; // Exact repeated retrieval row.
    }

    if (bySeq.has(raw.seq))
      return unavailable("invalid_snapshot", "conflicting_sequence");

    byId.set(raw.id, raw);
    bySeq.set(raw.seq, raw);
  }

  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);

  if (!input.proof.fullProject ||
      events.length !== input.head.seq + 1 ||
      events.some((e, i) => e.seq !== i))
    return unavailable("incomplete_snapshot");

  // Includes event hashes, genesis, every link, and authenticated head equality.
  if (!verifyNormalizedChainAndHead(events, input.proof, input.head))
    return unavailable("invalid_snapshot");

  return {
    kind: "available",
    project: input.project,
    head: input.head,
    events,
    byId,
    foreignRefs: input.foreignRefs
  };
}
```

`canonicalFullRecord` includes all event fields, including unknown hash-covered fields. It is not a serialization of a Zod-stripped projection.

Root state uses the existing raw `causalRootState` semantics over the full project map: stop successfully at a recorded human `instructed` event; missing parent, absent chain termination, or a cycle is unrooted. Compute it with memoized iterative path traversal. Attribution and causal-attestation results do not alter this traversal.

```ts
function normalizeScope(c, targetDomain): ScopeResult {
  // targetDomain was constructed from recorded references and required facts.
  const chosen = c.artifacts === undefined
    ? [...targetDomain.units.keys()]
    : c.artifacts.map(id =>
        resolveScopeEntryThroughTargetReferences(id, targetDomain));

  if (chosen.some(x => x === undefined))
    return reject("scope_invalid");

  const keys = sortedUnique(chosen);

  if (keys.length === 0 ||
      keys.some(k => !targetDomain.units.has(k)))
    return reject("scope_invalid");

  return {
    kind: "available",
    scope: {
      artifacts: keys,
      universe: sortedKeys(targetDomain.units),
      whole_event:
        targetDomain.complete &&
        equalSets(keys, targetDomain.units.keys())
    }
  };
}
```

The primary evidence evaluator applies these checks independently to each cited event and scoped unit:

```ts
function evaluateEvidence(c, target, unit, prepared, finalByTarget) {
  const base: EvidenceMatch[] = [];
  const diagnostics: EvidenceDiagnostic[] = [];

  for (const id of c.evidence) { // Deduplicated, ordered by seq then ID.
    const e = prepared.snapshot.byId.get(id);

    if (!e) {
      diagnostics.push({ id, reason: "missing_or_foreign_ref" });
      continue;
    }
    if (!sameActor(e.actor, c.to)) {
      diagnostics.push({ id, reason: "wrong_actor" });
      continue;
    }
    if (isAmendmentAttempt(e) ||
        e.action === "instructed" ||
        e.action === "committed" ||
        e.action === "merged") {
      diagnostics.push({ id, reason: "not_primary_edit" });
      continue;
    }
    if (!authenticatedStampKind(e, ["pinned", "assert"])) {
      diagnostics.push({ id, reason: "untrusted_evidence" });
      continue;
    }

    // Match only recorded output/invalidation refs:
    // explicit generated/both; otherwise the enumerated edit-action fallback.
    // A used-only reference never qualifies.
    const refs = matchingStrictWriteRefs(e, unit.matchKeys, prepared.policy);

    if (refs.length === 0) {
      diagnostics.push({
        id,
        reason: diagnosticForNoStrictWriteMatch(e, unit)
        // wrong_artifact | input_only | loose_identity
      });
      continue;
    }

    if (!(unit.window.after < e.seq &&
          e.seq < unit.window.before &&
          e.seq < target.seq &&
          precedesCandidate(e, c))) {
      diagnostics.push({ id, reason: "outside_window" });
      continue;
    }

    base.push({ event_id: e.id, seq: e.seq, ref_indexes: refs });
  }

  const live: EvidenceMatch[] = [];
  const amended: EvidenceMatch[] = [];

  for (const match of base) {
    const active = finalByTarget.get(match.event_id)?.active;
    if (active && active.size > 0) amended.push(match);
    else live.push(match);
  }

  return {
    artifact: unit.key,
    window: unit.window,
    qualifying: live,
    excluded_as_amended: amended,
    diagnostics,
    state: live.length ? "covered"
         : amended.length ? "amended_only"
         : "missing"
  };
}
```

`matchingStrictWriteRefs` performs only the role/action and canonical-identity comparisons specified above. It does not inspect effective actors, intent, model names, content flags, or provenance role amendments.

```ts
function checkAttributionAmendment(c, env): CheckResult {
  // env contains the complete verified snapshot, required capture context,
  // current same-target prefix state, and finalized earlier-target states.

  if (c.parseError) return reject("malformed");

  if (!env.rawRooted(c.caused_by))
    return reject("unrooted");

  const target = env.snapshot.byId.get(c.target_event_id);
  if (!target) {
    return env.snapshot.foreignRefs.has(c.target_event_id)
      ? reject("wrong_project")
      : reject("missing_target");
  }

  if (target.project !== c.project)
    return reject("wrong_project");
  if (!precedesCandidate(target, c))
    return reject("not_older");

  if (target.action_detail === "amended" || isAmendmentAttempt(target))
    return reject("target_is_amendment");
  if (target.action === "instructed")
    return reject("target_is_instruction");

  if (c.resolvedActor.type !== "human")
    return reject("relay_disabled");
  if (!env.hasHumanSelectionAuthority(c))
    return reject("untrusted_authority");

  if (c.to.type === "human")
    return reject("human_beneficiary_unsupported");
  if (sameActor(c.from, c.to))
    return reject("no_op");

  const normalized = normalizeScope(c, env.domains.get(target.id));
  if (normalized.kind === "rejected") return normalized;
  const scope = normalized.scope;

  if (!env.snapshot.events.some(e =>
      precedesCandidate(e, c) &&
      sameActor(e.actor, c.to) &&
      authenticatedStampKind(e, ["pinned", "assert", "webhook"])))
    return reject("unknown_actor");

  const overlap = sortedUnique(
    scope.artifacts.flatMap(p => {
      const key = env.current.owner.get(p);
      return key === undefined ? [] : [key];
    })
  );

  // Single-string supersedes permits one predecessor only.
  if (overlap.length > 1)
    return reject("no_supersede", { overlap });

  if (overlap.length === 0 && c.supersedes !== undefined)
    return reject("no_supersede");

  if (overlap.length === 1 &&
      !sameSealedAmendment(overlap[0], c.supersedes))
    return reject("no_supersede");

  const beforeByArtifact = new Map();
  for (const p of scope.artifacts) {
    const owner = env.current.owner.get(p);
    const actor = owner === undefined
      ? target.actor
      : env.current.active.get(owner)!.to;
    beforeByArtifact.set(p, actor);
  }

  if ([...beforeByArtifact.values()].some(a => !sameActor(a, c.from)))
    return reject("stale_from", { beforeByArtifact });

  const evidence = scope.artifacts.map(p =>
    evaluateEvidence(
      c, target, env.domains.get(target.id).units.get(p),
      env, env.finalByTarget
    )
  );

  const missing = evidence.filter(x => x.state !== "covered");

  if (missing.length) {
    if (missing.some(x => x.state === "amended_only"))
      return reject("evidence_amended", { evidence });

    if (evidence.some(x => x.state === "covered"))
      return reject("partial_coverage", { evidence });

    return reject("uncorroborated", { evidence });
  }

  return {
    kind: "accepted",
    claim: {
      ref: c.ref,
      target_id: target.id,
      from: c.from,
      to: c.to,
      scope,
      tier: "human",
      evidence,
      reason: c.reason,
      supersedes: c.supersedes
    },
    replace: overlap[0] // Undefined or exactly one active predecessor.
  };
}
```

The collector owns mutation of derived state. The checker performs none:

```ts
function collectAttributionAmendments(input, policy, git, observations) {
  const snapshot = normalizeSnapshot(input);
  if (snapshot.kind === "unavailable") return snapshot;

  const attempts = classifyAndParseAttributionAttempts(snapshot.events);

  // Validate identities, policy coverage, commit resolution, required diffs,
  // capture boundaries, and domains. Optional observations are excluded.
  const prepared = prepareRequiredContext(snapshot, attempts, policy, git);
  if (prepared.kind === "unavailable")
    return unavailableForObservedAttempts(prepared, attempts);

  const finalByTarget = new Map<EventId, TargetState>();
  const results = new Map<AmendmentKey, AmendmentResult>();

  // Missing-target/malformed attempts retain deterministic result ordering.
  const groups = groupByTarget(attempts);
  groups.sort(byKnownTargetSeqThenTargetId);

  for (const group of groups) {
    const current: TargetState = {
      active: new Map(),
      owner: new Map()
    };

    for (const c of group.attempts.sort(byAmendmentPosition)) {
      const check = checkAttributionAmendment(c, {
        ...prepared, current, finalByTarget
      });

      if (check.kind === "rejected") {
        results.set(c.ref.key, rejectedResult(c, check));
        continue; // No owner, active, or predecessor changes.
      }

      if (check.replace !== undefined) {
        const predecessor = current.active.get(check.replace)!;

        // Full replacement, including predecessor scope outside new scope.
        for (const p of predecessor.scope.artifacts)
          current.owner.delete(p);

        current.active.delete(check.replace);

        results.set(check.replace, {
          state: "superseded",
          amendment: predecessor,
          superseded_by: c.ref
        });
      }

      current.active.set(c.ref.key, check.claim);
      for (const p of check.claim.scope.artifacts)
        current.owner.set(p, c.ref.key);

      results.set(c.ref.key, {
        state: "active",
        amendment: check.claim
      });
    }

    finalByTarget.set(group.target_id, current);
  }

  // Attach informational flags after effectiveness is fixed.
  const decorated = attachObservations(results, observations, prepared);

  return {
    kind: "available",
    at: prepared.contextKey,
    results: sortResultsByAmendmentPosition(decorated),
    activeByTarget: finalByTarget,
    effective: buildEffectiveViews(snapshot.events, finalByTarget)
  };
}
```

Scope dropped by supersession returns to the **recorded** identity. Previously superseded ancestors are not resurrected just to fill the dropped scope.

The optional preflight candidate enters the same internal replay as a distinguished candidate token, after all sealed amendments on its target. Its position is `after(snapshot.head)`, not a fabricated numeric sequence or event ID.

**Dependency proof**

There are four kinds of inputs/dependencies:

1. **Raw facts:** authorization stamps, actor existence, roles, scope, Git windows, and raw causal rooting. Compute these from the full immutable input before replay. They do not depend on effective attribution.
2. **Evidence attribution:** candidate on target `T` asks whether witness `E` has active amendments. A qualifying witness has `E.seq < T.seq`. Therefore every amendment targeting `E`, including ones sealed much later, is resolved in an earlier target group.
3. **Same-target replacement:** a candidate depends on the prefix state produced by earlier amendment sequences on that target.
4. **Observations/rendering/reconcile:** these depend on completed attribution results, never the reverse.

The dynamic dependency order is lexicographic:

```text
(target sequence, amendment position)
```

Every dynamic edge points earlier in that order. Merely sorting targets would not suffice without the strict evidence inequality, raw-only auxiliary rules, and prefix-state definition of `from`.

**Termination and determinism**

- Snapshot/root traversal terminates because the event set is finite and cycles are detected.
- Each target group and candidate is processed once.
- Each accepted predecessor is removed at most once during a replay.
- There is no fixed-point iteration or backward mutation of a finalized target group.

For fixed verified snapshot and fixed context, normalization, ordering, precedence, witness selection, and transitions are all deterministic. Unique sequences remove tie ambiguity. Diagnostic lists and maps must also have specified sorted serialization.

**Safety invariants**

Induction over replay establishes:

- Active scopes on a target are pairwise disjoint.
- Each active claim has qualifying evidence for every claimed unit.
- Each `from` matches all scoped prefix identities.
- Rejected candidates leave attribution state unchanged.
- A successor can replace only its named active predecessor.
- No effective identity is used to manufacture a recorded covering actor.
- Raw events, actor metadata, hashes, signatures, and references remain recoverable unchanged.

**Complexity**

Let:

- `N`: events; `R`: raw artifact references.
- `A`: attribution attempts.
- `S = Σ scopeSize(a)`.
- `Q = Σ citedEvidenceCount(a)`.
- `K = Σ scopeSize(a) × citedEvidenceCount(a)`.
- `C`: capture boundaries; `T`: target attribution units requiring windows.
- `P`: supplied Git diff rows; `V`: cryptographic verification cost.

With per-event artifact indexes, memoized roots, and per-path sorted boundary lists:

```text
Time:
O(V + N log N + A log A + R + P
    + T log(C + 1) + Q log(N + 1) + S + K)

Space:
O(N + R + P + C + A + S + K)
```

Input byte processing is additional linear cost. Retaining every per-witness diagnostic accounts for `K` space.

**Worked cascade, including reactivation**

All edits are stamped, generated/both, rooted at `R#0`; `a` has no earlier capture boundary.

| Seq | Event |
|---:|---|
| 1 | `F`: `D` edits `a`. |
| 2 | `G`: `C` edits `a`. |
| 3 | `E`: `B` edits `a`. |
| 4 | `W`: `C` edits `a`. |
| 5 | `T`: hook records commit as `O`, changing `a`. |
| 6 | `A1`: target `T`, `O→B`, scope `{a}`, evidence `E`. |
| 7 | `A2`: target `T`, `B→C`, scope `{a}`, evidence `W`, supersedes `A1`. |
| 8 | `X`: target `E`, `B→C`, scope `{a}`, evidence `G`. |
| 9 | `Y`: target `G`, `C→D`, scope `{a}`, evidence `F`. |

Results:

| Snapshot | Derivation | Effective `T.a` | Reconcile, assuming no other findings |
|---|---|---|---|
| Through 7 | `A1` superseded; `A2` active. | `C` | `misattributed:info`, amended; gate passes. |
| Through 8 | Resolve target `E` first: `X` active. `A1` loses `E`: `evidence_amended`. `A2` cannot supersede rejected `A1`: `no_supersede`. | `O` | `misattributed:fail`; gate fails. |
| Through 9 | `Y` active on `G`; therefore `X` loses its witness and is `evidence_amended`. `E` now has no active amendment. `A1` qualifies again; `A2` supersedes it again using unaffected `W`. | `C` | `misattributed:info`, amended; gate passes. |

Thus **reactivation is possible without resealing the reactivated amendments**. This follows from final-ledger recomputation. The smallest repair is to make “must be re-sealed” conditional on the foundation remaining withdrawn, rather than introducing a permanent revocation mechanism.

At head 8, a separate branch may append `A2′: T, O→C, evidence W, no supersedes`; it qualifies because no active predecessor remains.

## Reconcile downgrade invariants

The current code creates a commit-level `misattributed:fail` only when every changed file is covered and the recorded committer is absent from the union of recorded covering actors. Otherwise it emits per-file warnings. [The aggregation and final `ok` computation are explicit here.](https://github.com/jordandru/retrace/blob/1d24ee8b73f03803e1eca4efca53a4dc4dcf7c2c/packages/core/src/reconcile.ts#L348-L397)

Compute the ordinary report first using recorded events and the shared capture context. Attribution then qualifies findings; it does not rewrite the inputs to ordinary reconciliation.

For a commit-level finding `F`, define:

- `s(F)`: the exact selected seal event that produced the finding.
- `D(F)`: the changed files responsible for the original failure.
- `CoverRecorded(s,p)`: the recorded actor pairs from ordinary covering events for file `p`, under the same capture profile.
- `M(s,p)`: the active amendment owning the corresponding eligible artifact on seal `s`.

At this revision, a commit-level failure’s `D(F)` is **every changed file**. Do not derive it from the incoming amendment’s scope.

A downgrade is permitted iff all of the following hold:

1. `F.kind === "misattributed"`, original level is `fail`, and `F` is commit-level.
2. `F` has not already become informational through an acknowledgement.
3. Attribution evaluation is available under exactly the report’s snapshot and capture context.
4. No open `producer_disagreement` exists for that commit. “Open” means unacknowledged, including warning-level lone-producer findings.
5. For every `p ∈ D(F)`:
   - `M(s(F),p)` exists and is active.
   - It targets **that exact seal event**, not merely the same SHA.
   - Its scope contains the corresponding artifact.
   - Its beneficiary equals the effective artifact identity.
   - Its beneficiary is in `CoverRecorded(s(F),p)` using the full pair.
   - Its retained per-artifact evidence evaluation contains a clean, strictly identified, in-window witness.
6. The attached downgrade certificate records these associations for every file.

One amendment may justify every file, or several disjoint amendments may do so with different beneficiaries.

Formally:

```text
F.amended exists
⇒
F.original_level = fail
∧ F.level = info
∧ ¬F.acknowledged
∧ ¬openProducerDisagreement(F.sha)
∧ ∀p∈D(F):
    active(Mp)
    ∧ Mp.target_id = s(F).id
    ∧ p ∈ scope(Mp)
    ∧ effective(s(F),p) = Mp.to
    ∧ Mp.to ∈ CoverRecorded(s(F),p)
    ∧ qualifyingWitnesses(Mp,p) ≠ ∅
```

This certificate is the direct invariant connecting the downgrade to scope, evidence, and effective amendment state.

**Preserved behavior and limits**

- A partial correction of an original commit-level failure retains that failure. If some files are justified and others are not, expose the unresolved files and their per-file `misattributed:warn` diagnostics; those warnings do not replace the original failure.
- Existing per-file warnings are not newly promoted to failures, nor automatically downgraded by this feature.
- Loose matches can still participate in ordinary reconcile’s existing diagnostics. They cannot satisfy the amendment’s strict identity requirement.
- Covering sets use recorded actors and recorded roles. Amending edit events to another actor does not add that actor to a covering set.
- Current ordinary coverage includes agent events, not system/human events. Preserve that population in this feature. A valid amendment to a system actor can affect display without necessarily satisfying the existing reconcile downgrade predicate.
- Attribution does not remove `missing_commit`, `uncovered`, `loose_match`, `unreachable_seal`, or unrelated failures/warnings.

**Producer seals**

The selected seal is the existing hook-preferred seal, otherwise the webhook seal. The common capture cutoff and selected finding-producing seal are distinct concepts.

- Amendment of only the non-selected webhook seal cannot downgrade a failure produced by the hook seal.
- If both recorded seals say the same wrong actor, there is no recorded producer disagreement. Correcting the selected hook seal completely may downgrade its finding; the unchanged webhook record remains visible.
- This is a correction of the selected seal’s attribution claim, not a declaration that both producer records were corrected.
- If recorded actors differ, effective agreement does not erase `producer_disagreement`.
- Amending one of two agreeing seals does not manufacture a new producer disagreement.

**Acknowledgements**

Preserve the existing correction-acknowledgement path independently. It currently changes non-info findings, including producer disagreement, to info when an eligible acknowledgement exists. [See `ackFor` and finding creation.](https://github.com/jordandru/retrace/blob/1d24ee8b73f03803e1eca4efca53a4dc4dcf7c2c/packages/core/src/reconcile.ts#L138-L157)

- A structured correction flag is not an attribution amendment.
- An existing valid correction may acknowledge a finding even when an attribution attempt is rejected.
- Do not attach `amended` as the explanation for a finding already downgraded by `acknowledged`.
- Exclude all amendment attempts from correction-acknowledgement mining, regardless of extra tags. Otherwise an ineffective attribution attempt tagged `correction` could acquire a second, unintended effect.
- Keep accused/beneficiary identity comparisons as pairs. Agent allowlists and the existing model/session restrictions continue to apply to acknowledgement eligibility.

**Finding counts and exit behavior**

- Preserve `summary[kind]` as counts of findings, including informational findings.
- Add `summary.amended` as the number of findings actually downgraded through the certificate above.
- `summary.acknowledged` remains independent.
- `report.ok` remains “no fail-level finding anywhere.”
- `reconcile --gate` returns `1` iff `report.ok` is false.
- Doctor’s capture finding is fail if a live fail remains, warn if only live warnings remain, otherwise pass.
- Doctor’s overall exit still depends on all its checks. A corrected capture finding does not clear a pin/session, causal-root, delivery, or integrity failure. [Doctor’s aggregation is unchanged.](https://github.com/jordandru/retrace/blob/1d24ee8b73f03803e1eca4efca53a4dc4dcf7c2c/packages/mcp-server/src/doctor.ts#L132-L147)

Concrete outcomes:

| Trace | Attribution result | Finding/gate result |
|---|---|---|
| `E2:B{a,b}; T5:O{a,b}; A6:O→B{a,b}` | `A6` active, whole. | Commit failure → amended info; gate passes absent other failures. |
| Same, `A6.scope={a}` | Active partial; `b` remains `O`. | Original commit failure remains; unresolved `b` warns; gate fails. |
| `E2:B{a}; G3:C{b}; A6:{a}→B; A7:{b}→C` | Both active partial; event actor remains `O`. | Both files justified; commit failure → amended info. |
| Worked cascade through 8 | `A1` rejected, `A2` rejected. | Commit failure returns. |
| Hook `O`, webhook `Z`, amendment makes hook effective `Z` | Amendment may be active. | Recorded disagreement remains; no attribution downgrade. |
| Hook `O`, webhook `O`; amend only webhook | Webhook corrected. | Hook-produced failure remains. |
| Hook `O`, webhook `O`; completely amend hook | Hook corrected; webhook retained as recorded `O`. | No recorded disagreement; selected-seal failure may downgrade. |
| Only `system/x` edits; target recorded `agent/x` | Amendment to `agent/x` is not corroborated by that witness. | Current baseline produces `uncovered:warn`, not necessarily a failing gate. |
| Human correction acknowledges disagreeing seals | Independent acknowledgement. | Findings become acknowledged info; no amendment-based downgrade certificate. |

## Exact interfaces and rejection reasons

These types describe proposed interfaces, not existing exports.

```ts
type EventId = string;
type ArtifactKey = string;
type AmendmentKey = string; // Internal candidate token uses a separate namespace.

type ActorRef = Readonly<{
  type: "human" | "agent" | "system";
  id: string;
}>;

interface NormalizedAttributionScope {
  artifacts: readonly ArtifactKey[]; // Nonempty, unique, sorted.
  universe: readonly ArtifactKey[];
  whole_event: boolean;
}

interface AttributionRequest {
  project: string;
  target_event_id: EventId;
  to: ActorRef;
  artifacts?: readonly string[];
  evidence: readonly EventId[];
  supersedes?: EventId;
  caused_by: EventId;
  reason: string;
  from?: ActorRef; // Normally inferred; explicit for reviewable failed attempts.
}

interface CandidateInput
  extends Omit<AttributionRequest, "from"> {
  from: ActorRef;
}

// Human authority is resolved separately from caller-supplied fields.
interface PreflightCandidate {
  kind: "candidate";
  input: CandidateInput;
  authority: ResolvedSubmissionAuthority;
  after_head: { seq: number; hash: string };
}

interface AttributionPayload {
  from: ActorRef;
  to: ActorRef;
  artifacts?: readonly string[];
  evidence: readonly EventId[];
  supersedes?: EventId;
}

interface SealedAttributionPayload {
  action: "other";
  action_detail: "amended";
  tags: readonly string[]; // Includes amendment and attribution.
  caused_by: EventId;
  intent: string;
  artifacts: readonly ArtifactRef[]; // Target/evidence refs are used.
  method: {
    tool: "retrace_amend";
    automated: false;
    params: {
      target_event_id: EventId;
      attribution: AttributionPayload;
      // Server-owned stamps may also be present after sealing.
    };
  };
}

type AttemptRef =
  | { kind: "sealed"; key: AmendmentKey; id: EventId; seq: number }
  | { kind: "candidate"; key: AmendmentKey };

interface CaptureWindow {
  after: number;  // -1 means genesis boundary.
  before: number; // Exclusive.
}

interface EvidenceMatch {
  event_id: EventId;
  seq: number;
  ref_indexes: readonly number[];
}

type EvidenceDiagnosticReason =
  | "missing_or_foreign_ref"
  | "wrong_actor"
  | "not_primary_edit"
  | "untrusted_evidence"
  | "wrong_artifact"
  | "input_only"
  | "loose_identity"
  | "outside_window";

interface ArtifactEvidenceEvaluation {
  artifact: ArtifactKey;
  window: CaptureWindow;
  state: "covered" | "amended_only" | "missing";
  qualifying: readonly EvidenceMatch[];
  excluded_as_amended: readonly EvidenceMatch[];
  diagnostics: readonly {
    id: EventId;
    reason: EvidenceDiagnosticReason;
  }[];
}

interface AttributionClaim {
  ref: AttemptRef;
  target_id: EventId;
  from: ActorRef;
  to: ActorRef;
  scope: NormalizedAttributionScope;
  tier: "human";
  evidence: readonly ArtifactEvidenceEvaluation[];
  reason: string;
  supersedes?: EventId;
  flags?: EvidenceFlags;
}

type AttributionAmendment =
  AttributionClaim & {
    ref: Extract<AttemptRef, { kind: "sealed" }>;
  };
```

Snapshot and context inputs must be constructed by trusted adapters; a JSON object claiming `authenticated: true` is not itself a verification proof.

```ts
interface SnapshotInput {
  project: string;
  events: readonly Readonly<Event>[];
  head: { seq: number; hash: string };
  proof: VerifiedSnapshotProof;
  foreignRefs: ReadonlyMap<EventId, AuthenticatedForeignReference>;
}

interface AttributionPolicy {
  profile: "retrace-attribution/1";
  digest: string;
  repositoryMappings: readonly HistoricalRepositoryMapping[];
  sealPolicies: readonly HistoricalSealPolicy[];
  nonGitCapturePolicies: readonly {
    scheme: string;
    actions: readonly ("committed" | "merged")[];
    exactSealedBy: readonly string[];
  }[];
}

interface GitFactInput {
  digest: string;
  repositories: readonly {
    repository: string;
    objectFormat: "sha1" | "sha256";
    refsDigest: string;
    horizonSeq: number | null;
  }[];
  commitResolutions: readonly CommitReferenceResolution[];
  targetDiffs: readonly {
    target_id: EventId;
    repository: string;
    oid: string;
    parents: readonly string[];
    diffBasis: "empty-tree" | "first-parent";
    diffProfile: string;
    files: readonly {
      path: string;
      status: "A" | "M" | "D" | "R" | "C" | "T";
      from?: string; // Required for R/C.
    }[];
  }[];
  sealReachability: readonly {
    repository: string;
    oid: string;
    state: "reachable" | "outside-horizon" | "excluded-unreachable";
  }[];
}

interface ContextKey {
  project: string;
  head_seq: number;
  head_hash: string;
  profile: "retrace-attribution/1";
  policy_digest: string;
  git_facts_digest: string;
}
```

`HistoricalRepositoryMapping` explicitly maps an alias to one canonical repository over a sequence interval. `HistoricalSealPolicy` contains the exact trusted hook stamps, owner override, and legacy treatment over its interval. Overlapping contradictory entries are `context_conflict`; missing required intervals are `context_missing`.

`CommitReferenceResolution` binds a sealed reference to one full OID and repository. A missing or ambiguous binding is unavailable, not an arbitrary prefix match.

```ts
type RejectionReason =
  | "malformed"
  | "unrooted"
  | "missing_target"
  | "wrong_project"
  | "not_older"
  | "target_is_amendment"
  | "target_is_instruction"
  | "relay_disabled"
  | "untrusted_authority"
  | "human_beneficiary_unsupported"
  | "no_op"
  | "scope_invalid"
  | "unknown_actor"
  | "no_supersede"
  | "stale_from"
  | "evidence_amended"
  | "partial_coverage"
  | "uncorroborated";

type UnavailableReason =
  | "untrusted_snapshot"
  | "invalid_snapshot"
  | "incomplete_snapshot"
  | "context_missing"
  | "context_conflict";

type AmendmentResult =
  | { state: "active"; amendment: AttributionClaim }
  | {
      state: "superseded";
      amendment: AttributionClaim;
      superseded_by: AttemptRef;
    }
  | {
      state: "rejected";
      ref: AttemptRef;
      reason: RejectionReason;
      diagnostics: readonly Diagnostic[];
    }
  | {
      state: "unavailable";
      ref: AttemptRef;
      reason: UnavailableReason;
      diagnostics: readonly Diagnostic[];
    };

interface EffectiveArtifactAttribution {
  artifact: ArtifactKey;
  target_ref_indexes: readonly number[];
  recorded: Readonly<Actor>;
  effective: Readonly<Actor>;
  amendment?: Extract<AttemptRef, { kind: "sealed" }>;
}

interface EffectiveEventAttribution {
  event_id: EventId;
  recorded: Readonly<Actor>;
  effective: Readonly<Actor>;
  state: "recorded" | "partial" | "whole" | "unavailable";
  eligible_artifacts: number;
  amended_artifacts: number;
  whole_event_amendment?: Extract<AttemptRef, { kind: "sealed" }>;
  by_artifact: readonly EffectiveArtifactAttribution[];
  excluded_refs: readonly {
    index: number;
    recorded: Readonly<Actor>;
    reason: "input_only" | "context_reference" | "outside_git_diff";
  }[];
}

interface ReconcileAmendmentMetadata {
  at: ContextKey;
  original_level: "fail";
  target_seal: { id: EventId; seq: number };
  amendments: readonly { id: EventId; seq: number }[];
  files: readonly {
    file: string;
    artifact: ArtifactKey;
    beneficiary: ActorRef;
    amendment: { id: EventId; seq: number };
    window: CaptureWindow;
    qualifying_evidence: readonly EvidenceMatch[];
  }[];
}
```

Public signatures:

```ts
function collectAttributionAmendments(
  snapshot: SnapshotInput,
  policy: AttributionPolicy,
  git: GitFactInput,
  observations?: EvidenceObservationInput
): AttributionDerivation;

function checkAttributionAmendment(
  candidate: ParsedCandidate,
  context: PreparedCheckerContext
): CheckResult;

function preflightAttributionAmendment(
  request: AttributionRequest,
  authority: ResolvedSubmissionAuthority,
  snapshot: SnapshotInput,
  policy: AttributionPolicy,
  git: GitFactInput,
  observations?: EvidenceObservationInput
): PreflightResult;

function effectiveAttribution(
  event: Readonly<Event>,
  derivation: AttributionDerivation
): EffectiveEventAttribution;
```

The public preflight wrapper constructs the same replay context and invokes the same checker. It must not ask a caller to supply an “already effective” map.

**Rejection precedence**

Snapshot/context unavailability prevents authoritative semantic evaluation. For available inputs, select the first applicable reason in the enum order shown above.

Consequences:

- Malformed mixed-kind payload beats all semantic reasons.
- Missing target beats target eligibility and scope checks.
- `no_supersede` beats `stale_from`, preserving v6’s back-to-back and cascade expectations.
- `evidence_amended` applies when at least one uncovered scoped artifact has otherwise qualifying witnesses excluded by the amendment ban.
- Otherwise some covered artifacts means `partial_coverage`.
- Otherwise zero covered artifacts means `uncorroborated`.

Return all relevant per-artifact diagnostics, while keeping one deterministic primary rejection reason.

This resolves v6’s conflicting descriptions of “missing evidence”: zero coverage is `uncorroborated`; some-but-not-all is `partial_coverage`; withdrawal of an otherwise qualifying witness is `evidence_amended`. A surviving alternative witness prevents that artifact from being classified as withdrawn.

**Malformed versus ineffective versus unavailable**

- Invalid request shape, extra actor fields such as `to.model`, forged server fields, inconsistent envelope references, and mixed amendment kinds are rejected before sealing.
- A sealed event with a valid outer event shape but malformed attribution params is retained and reported as `rejected/malformed`.
- A well-formed attempt may be sealed but ineffective for a semantic reason.
- A retrieval/context failure is unavailable, not evidence that the attempt was uncorroborated.
- Previously accepted amendments may later be rejected, superseded, or reactivated under final-ledger replay.

**Preflight and sealing**

When `from` is omitted, infer it from the current effective identity of **every scoped artifact**. If those identities differ, there is no inferable scalar `from`; return `stale_from` with the per-artifact identities.

Preflight uses:

```ts
type CandidatePosition =
  { kind: "after_head"; seq: number; hash: string };

precedesCandidate(e, sealedCandidate) = e.seq < sealedCandidate.seq;
precedesCandidate(e, pendingCandidate) = e.seq <= pendingCandidate.after_head.seq;
```

The second form is an ordering relation, not a proposed server sequence.

- Resolve expected submission authority separately from the payload.
- Do not fabricate `sealed_by`, `received_at`, hash fields, or a sealed event ID.
- Include the candidate in the internal target-ordered replay to expose downstream effects.
- Return the evaluated head/context and affected existing amendments.
- Preflight acceptance is **advisory**. No append atomicity/CAS guarantee is implied.
- If a newer head is observed before submission, rerun preflight.
- After sealing, refetch and report the actual sealed amendment’s state.
- Concurrent writes can make an accepted preflight become ineffective immediately after append.

**`--seal-anyway`**

It permits recording a **well-formed, explicitly reviewable semantic failure** under valid human submission authority. It does not make the attempt effective.

It cannot bypass:

- Request/envelope validation or the one-kind rule.
- Authentication, actor resolution, project authorization, or server-reserved fields.
- Required snapshot/context acquisition.
- Tier 1 human submission authority.
- The collector’s subsequent effectiveness rules.

It may record, for example, `uncorroborated`, `partial_coverage`, `stale_from`, or `missing_target` attempts. If `from` or scope cannot be inferred, explicit values are required; the tool must not invent them.

Use a distinct attempt idempotency key. A failed prior attempt must not deduplicate a deliberately corrected attempt.

Recommended exact CLI outcomes:

- `0`: the returned sealed attempt is currently active.
- `1`: validation, authorization, transport, or rejected preflight without sealing.
- `2`: evaluation unavailable, or an attempt was recorded but is currently rejected/superseded.

Always print the sealed ID when a write succeeded, including nonzero outcomes. “Recorded” and “effective” must be separate machine fields.

**Optional flags**

```ts
type ContentObservation =
  | {
      state: "match" | "mismatch";
      algorithm: "sha1" | "sha256";
      object_kind: "git-blob";
      evidence_event_id: EventId;
      artifact: ArtifactKey;
      asserted_oid: string;
      target_blob_oid: string;
      context: ContextKey;
    }
  | {
      state: "unavailable";
      evidence_event_id: EventId;
      artifact: ArtifactKey;
      reason:
        | "missing_hash"
        | "ambiguous_hash_subject"
        | "missing_object"
        | "unknown_hash_format";
    }
  | {
      state: "not_applicable";
      evidence_event_id: EventId;
      artifact: ArtifactKey;
      reason: "deletion" | "non_blob" | "non_git";
    };

interface EvidenceFlags {
  human_corroborated_by: readonly EventId[];
  trailer_corroborated_by: readonly EventId[];
  by_artifact: readonly {
    artifact: ArtifactKey;
    content: readonly ContentObservation[];
  }[];
  content_bound: boolean; // True only when every scoped artifact has a match.
}
```

For `content_bound`:

- Compare the evidence’s full `change.after_hash` to the Git **blob object ID** at the target commit’s path.
- Git blob OID is `H("blob " + byteLength + NUL + blobBytes)`, using the repository’s verified object format. It is not a plain file SHA-256, commit OID, tree OID, or patch digest.
- Accept a legacy unprefixed hash only as a full OID of that object format and only where the evidence event has one unambiguous eligible output artifact.
- A scalar `after_hash` on a multi-output event is not silently assigned to every file.
- Deletions have no post-image blob. Gitlinks are not blobs. Missing objects are unavailable observations.
- The Git adapter computes observations; core carries them without allowing caller booleans to decide anything.
- Authoritative flags are derived at evaluation/render time. An assertion sealed into arbitrary params remains a recorded assertion, not a trusted computed flag.
- Amendment-level `content_bound` is true only for complete per-artifact matching; retain partial matches explicitly.
- Flag absence, mismatch, or unavailable content **never changes amendment effectiveness**.

Even a matching hash proves only that the earlier claim named the target blob. The operator/credential holder could know or copy that hash. It does not prove authorship.

For other flags:

- Structured human correction: same project, cited before the amendment, authenticated human correction, names the target SHA, and identifies the beneficiary structurally. Prefer an `ActorRef`. Legacy ID-only fields count only when unambiguous across actor types; prose never counts.
- Trailer: a cited sealed commit for the target SHA plus a verified matching Git object or retained structured trailer data. Use exact parsed `Retrace-Actor` identity, not model-name guessing. A bare Git object is insufficient.
- Existing hook/webhook events strip trailer paragraphs from `intent`; absence of raw trailers is not permission to reconstruct them from prose. [The parser and stripping behavior are explicit.](https://github.com/jordandru/retrace/blob/1d24ee8b73f03803e1eca4efca53a4dc4dcf7c2c/packages/core/src/commit-actor.ts#L78-L107)
- Both flags remain insufficient without primary coverage.

**Existing provenance amendments and consumers**

Classify attempts before applying either amendment family:

- Presence of the attribution block, or the attribution amendment marker, routes an attempt to attribution handling.
- Mixed attribution/provenance payloads are malformed.
- Attribution attempts cannot be applied or counted again by the provenance collector/rejection collector.
- Preserve legacy provenance rules using the full raw lookup context; do not filter away possible targets or causal ancestors.
- Targets with `action_detail:"amended"` remain forbidden regardless of amendment kind.

This dispatch is necessary because the [current provenance collector accepts every rooted `other/amended` event](https://github.com/jordandru/retrace/blob/1d24ee8b73f03803e1eca4efca53a4dc4dcf7c2c/packages/core/src/amendment.ts#L17-L43).

All consumers use the same derivation:

- Whole-event actor counts move; partial-event counts do not.
- Count active, superseded, rejected, whole-target, and partial-target states separately.
- Do not count superseded amendments as rejected.
- `ineffective_amendments` merges rejected IDs from the two families exactly once.
- Lineage actor keys include type and ID; partial attribution changes only the corresponding contribution edges.
- Default/effective render modes always retain the recorded/effective association and amendment reference.
- Serialize maps as sorted arrays or objects explicitly; `JSON.stringify(new Map())` is not a machine-readable attribution result.
- MCP presentations retain the existing inert-text/sanitization rules. Raw export/API data remains separately available.
- Unavailable views show unavailable counts, not fabricated zeroes.
- Export event bytes and signatures remain unchanged.

Example partial machine view:

```json
{
  "event_id": "T",
  "state": "partial",
  "recorded": { "type": "agent", "id": "O" },
  "effective": { "type": "agent", "id": "O" },
  "eligible_artifacts": 2,
  "amended_artifacts": 1,
  "by_artifact": [
    {
      "artifact": "repo:r#a",
      "recorded": { "type": "agent", "id": "O" },
      "effective": { "type": "agent", "id": "B" },
      "amendment": { "id": "A", "seq": 6 }
    },
    {
      "artifact": "repo:r#b",
      "recorded": { "type": "agent", "id": "O" },
      "effective": { "type": "agent", "id": "O" }
    }
  ]
}
```

## Adversarial test matrix

**All feature rows below are specifications, not executed passing feature tests.**

Notation:

- Actors `O/B/C/D` are distinct agents; `H` is human.
- `a/b/c` are canonical repository file artifacts.
- `E2:B{a,b}` means a stamped, rooted edit at sequence 2 with `both` references.
- `T5:O{a,b}` includes a generated commit reference `K` plus generated file references.
- `A6:T,O→B,{a,b},[E2]` is a human-sealed amendment.
- Unless stated otherwise, `R0` is the human instruction, `B1` is a stamped input-only registration event, `G3:C{a,b}` is another edit, and no earlier capture boundary exists.
- Unspecified sequence positions are valid neutral events, so complete snapshots remain contiguous.
- **Base:** `E2:B{a,b}; G3:C{a,b}; T5:O{a,b}; A6:T,O→B,{a,b},[E2]`.
- `F/I/W` mean fail/info/warn. Gate results assume no unrelated failures.
- `N/A` means a collector/input test that does not invoke reconcile.

**Rejection vocabulary and precedence**

| Test | Minimal setup/change | Amendment state and reason | Effective identity | Reconcile/gate | Invariant |
|---|---|---|---|---|---|
| R1 | Base plus `attribution` and `artifact_roles` in A6. | Rejected `malformed`. | Event/artifacts `O`. | N/A | One amendment kind. |
| R2 | Base, A6’s cause missing. | Rejected `unrooted`. | `O`. | N/A | Raw human root required. |
| R3 | Base, A6 targets absent `Z`. | Rejected `missing_target`. | T unchanged. | N/A | Complete absence differs from retrieval failure. |
| R4 | A6 targets authenticated foreign-project `Z`. | Rejected `wrong_project`. | All unchanged. | N/A | Project boundary. |
| R5 / v6 8 | Put A at #4, target remains #5. | Rejected `not_older`. | `O`. | N/A | No pre-planted effective amendment. |
| R6 / 7c | A7 targets amendment A6. | Rejected `target_is_amendment`. | A6’s established target view unchanged. | N/A | Cannot amend authority events. |
| R7 / 7e | A6 targets R0. | Rejected `target_is_instruction`. | R0 stays H. | N/A | Human instruction identity immutable. |
| R8 / 1–3, 5c | A6 sealed by accused, beneficiary, or another agent. | Rejected `relay_disabled` in all v1 cases. | `O`. | N/A | No Tier 2 path. |
| R9 | A6 says human H but is unstamped/unauthenticated. | Rejected `untrusted_authority`. | `O`. | N/A | Human-shaped bytes are insufficient. |
| R10 / 7d | A6 `to=human/H`. | Rejected `human_beneficiary_unsupported`. | `O`. | N/A | V1 beneficiary restriction. |
| R11 | A6 `from=to=O`; no extra model field. | Rejected `no_op`. | `O`. | N/A | No model-only amendment. |
| R12 / 4d | A6 scope `{c}`, where T has only `{a,b}`. | Rejected `scope_invalid`. | `O`. | N/A | Scope cannot expand target domain. |
| R13 / 6 | A6 `to=Z`, with no prior stamped `Z`. | Rejected `unknown_actor`. | `O`. | N/A | Pair-specific actor existence. |
| R14 / 7 | Base A6 active; A7 overlaps without supersedes. | A7 rejected `no_supersede`; A6 active. | T/artifacts B. | N/A | Explicit replacement. |
| R15 | Base A6 active; A7 supersedes A6 but `from=O`. | A7 rejected `stale_from`. | B. | N/A | Prefix identity is B. |
| R16 / 7g | Replace #1 with C edit; X7 amends E2 to C using #1. | A6 rejected `evidence_amended`. | T/artifacts O. | Misattributed F; false. | Final witness state. |
| R17 / 4b | T has `{a,b,c}`, E2 covers only `a`; scope omitted. | Rejected `partial_coverage`. | All O. | N/A | Whole candidate rejected. |
| R18 / 5, 5f | Base but A6 evidence empty, wrong-actor, or only unrelated paths. | Rejected `uncorroborated`. | O. | Misattributed F; false. | No primary coverage. |
| P1 | Malformed mixed payload also unrooted and missing target. | `malformed`. | Unchanged. | N/A | Shape precedence. |
| P2 | Unrooted and missing target. | `unrooted`. | Unchanged. | N/A | Root precedence. |
| P3 | Missing target, unknown beneficiary, invalid scope. | `missing_target`. | Unchanged. | N/A | Lookup precedence. |
| P4 / 7b | Base; A7 from O overlaps A6, without supersedes. | `no_supersede`, not `stale_from`. | B. | N/A | Same-target ordering. |
| P5 / 7h | A1 rejected due witness withdrawal; successor names A1 and has stale from. | Successor `no_supersede`. | Recorded state. | Misattributed F; false. | Cascade precedence. |
| P6 | Scope `{a,b}`; `a` has only amended qualifying witnesses; `b` has none. | `evidence_amended`, with both diagnostics. | O. | N/A | Deterministic evidence precedence. |

**Scope, state transitions, and evidence**

| Test | Minimal setup | Expected state/reason | Event/artifact identity | Reconcile/gate | Invariant |
|---|---|---|---|---|---|
| S1 / 4 | Base. | A6 active, whole. | Event B; a/b B; commit reference recorded O. | Amended I; true. | Complete correction without editing bytes. |
| S2 / 4c | Base, A6 scope `{a}`. | Active partial. | Event O; a B; b O. | Original F plus unresolved b W; false. | Partial correction cannot clear complete failure. |
| S3 | Omitted versus explicit `{a,b}`. | Identical normalized active result. | B/B/B. | I; true. | Omitted scope normalization. |
| S4 | Explicit `[]`. | `scope_invalid`. | O. | N/A | No vacuous whole-event amendment. |
| S5 | Scope `{a,a,alias(a)}` with trusted alias. | One normalized unit; active partial. | Event O; a B; b O. | F; false. | Duplicate/alias idempotence. |
| S6 | Scope `{commit:K}` or `{event:R0}`. | `scope_invalid`. | O. | N/A | Context refs are not contribution claims. |
| S7 | T has output `a`, input-only `b`, commit K; scope omitted. | Active whole eligible domain `{a}`. | Event B; a B; input b recorded O. | Depends on actual Git diff; N/A here. | Input roles do not demand output evidence. |
| S8 | Git diff changes a/b; T lists only a plus K. | Scope a can be active, but not whole. | Event O; a B; b has no amendable target ref. | F remains; false. | Missing target refs cannot shrink denominator. |
| S9 | Read-only target, all refs used. | `scope_invalid`, empty universe. | Recorded actor. | N/A | Output/invalidation feature scope. |
| S10 | Non-Git T5 has outputs doc:a/doc:b; E2 covers both; configured capture policy, no earlier capture. | Active whole. | Event and both artifacts B. | N/A | Multi-artifact non-Git support. |
| S11 | Same, preceding capture #3 touches doc:b. | A6 `partial_coverage`: E2 covers a only. | Both remain O. | N/A | Per-artifact windows. |
| S12 / 4e | E2 B{a}; G3 C{b}; A6 O→B{a}; A7 O→C{b}. | Both active partial. | Event O; a B; b C. | I with two-amendment certificate; true. | Disjoint beneficiaries compose. |
| S13 | Disjoint A6/A7 both credit B and collectively cover a/b. | Both active partial. | Event remains O; a/b B. | I; true. | No collective whole-event promotion. |
| S14 | A6 O→B{a}; A7 B→C{a}, supersedes A6, witness G3. | A6 superseded; A7 active. | Event O; a C; b O. | F; false. | Scoped `from`. |
| S15 | A6 O→B{a}; A7 B→C{a,b}, supersedes A6. | A7 `stale_from`: b is O. | Event O; a B; b O. | F; false. | Scalar from must match entire scope. |
| S16 | Active A6 B{a}, A7 B{b}; A8 B→C{a,b}, supersedes A7. | A8 `no_supersede`, multiple overlaps. | Event O; a/b B. | Earlier complete justification remains. | Single predecessor cannot replace two. |
| S17 | A6 whole O→B{a,b}; A7 B→C{a}, supersedes A6. | A6 superseded; A7 active partial. | Event O; a C; b restored O. | F plus b W; false. | Full predecessor removal. |
| S18 | S17 plus A8 O→B{b}, no supersedes. | A7/A8 active disjoint. | Event O; a C; b B. | I; true. | Dropped scope can be corrected again. |
| S19 | Successor names an active disjoint amendment or rejected attempt. | `no_supersede`. | Prior state unchanged. | N/A | Supersedes must name actual overlap. |
| E1 | One E2 names a/b, both outputs. | Supports both scoped units. | Base active B. | I; true. | One event may cover multiple artifacts. |
| E2 | E2 uses `edited` but a/b roles are `used`; B1 establishes B. | `uncorroborated`. | O. | N/A | Explicit role overrides verb. |
| E3 | E2 action `executed`, a/b `generated` or `both`. | Active. | B. | I; true. | Explicit output role is sufficient edit shape. |
| E4 | E2 role absent, action `deleted`; deletion target a. | Active if window matches. | a B. | I if otherwise covered; true. | Legacy action fallback, deletion support. |
| E5 / 5 | Prior capture #1, witness #1 or earlier, target #5. | `uncorroborated`. | O. | N/A | Exclusive lower bound. |
| E6 | Witness at target’s cutoff or after target. | `uncorroborated`. | O. | N/A | Exclusive upper bound. |
| E7 / 5e | E2 unstamped; B1 still establishes B. | `uncorroborated`. | O. | N/A | Stamp is independently required. |
| E8 | Producer signature present, no server stamp; B1 exists. | `uncorroborated`. | O. | N/A | Signature does not replace receipt. |
| E9 | Valid pinned/assert receipt; unsigned evidence. | Active. | B. | I; true. | Producer signing optional in v1. |
| E10 | Valid producer signature, no content hash. | Active; content observation unavailable. | B. | I; true. | Signature is not content proof. |
| E11 | Authentic receipt with optional producer signature reported invalid. | Stamp-arm outcome unchanged; invalid signature visibly reported. | Base B under default profile. | Preserve independent verification policy/finding. | Do not claim a failed signature verified. |
| E12 / 5h | Beneficiary deliberately logs a qualifying path claim; human selects it. | Active. | B. | I; true. | Documented authorship limit. |
| E13 | E2 only loosely identifies a/b. | `uncorroborated` for attribution. | O. | Raw loose coverage may still produce F; no downgrade. | Loose identity cannot authorize correction. |
| E14 | Verified rename old→new; E2 edits old inside max(source,destination) window; T lists new. | Active for new transition only. | new B; unrelated old refs unchanged. | I if all failing files justified. | Rename alias is evidence-local. |
| E15 | Verified copy source→dest; fresh E2 on source in the same required window. | Active for dest only. | dest B. | Same per-file rule. | Copy semantics explicit. |
| E16 | Rename/copy facts absent rather than “no rename.” | Unavailable `context_missing`. | Recorded fallback, attribution unknown. | No downgrade. | Do not guess Git facts. |
| E17 | Merge T5, declared first-parent diff, complete evidence. | Scope may be active. | Per declared domain. | Merge coverage remains N/A. | Attribution does not change merge gate eligibility. |
| E18 / 5e, 7g | #1 C edits a/b; X4 already amends E2 before A6. | A6 `evidence_amended`. | T O. | No downgrade. | Same final condition has same reason. |
| E19 | A6 cites E2 for a; X7 amends only E2.b. | A6 `evidence_amended`. | T.a O. | F remains. | V6’s event-wide witness exclusion. |
| E20 | E19, but A6 also cites clean E4:B{a}. | A6 remains active for a. | T.a B. | Full/partial gate rule applies. | Alternative witness survives. |
| E21 | A6 cites valid E2 plus missing/irrelevant references. | Base remains active. | B. | I; true. | Evidence is existential per artifact. |
| E22 / 7h | Worked trace through #8. | A1 `evidence_amended`; A2 `no_supersede`. | T O. | F; false. | Cascading invalidation. |
| E23 | Worked trace through #9. | Y active; X rejected; A1 superseded; A2 reactivated. | T C. | I; true. | Reactivation under final-ledger replay. |
| E24 / 7h | Branch from head 8: A2′9 O→C, W4, no supersedes. | A2′ active. | T C. | I; true. | Visible reseal while foundation absent. |
| E25 | E is amended away, then actively amended back to its recorded pair. | E still has an active amendment; dependent witness use remains excluded. | Dependent target unchanged/rejected. | No downgrade from that witness alone. | Ban concerns active amendments, not just final equality. |

**Flags, identities, snapshots, and consumers**

| Test | Setup | Expected amendment state/reason | Effective view | Reconcile/gate | Invariant |
|---|---|---|---|---|---|
| F1 / 5b | Human correction names beneficiary only in intent. | No human flag; without primary evidence `uncorroborated`. | Recorded. | N/A | No prose scraping. |
| F2 / 5b, 5d | Human correction names target SHA and structured B; no primary evidence. | Human flag present; `uncorroborated`. | Recorded. | Existing ACK may independently make report info. | Flag is not sufficient evidence. |
| F3 | Legacy structured ID `x`, both agent/x and system/x exist. | No ambiguous human flag. | Primary-evidence outcome unchanged. | N/A | Pair identity in flags. |
| F4 / 5 | Sealed target commit has matching trailer, no primary evidence. | Trailer flag only; `uncorroborated`. | Recorded. | No amendment downgrade. | Trailer insufficiency. |
| F5 | Bare Git object has trailer, no cited sealed commit. | No trailer flag. | Unchanged. | N/A | Ledger-native corroboration. |
| F6 / 5g | Single-output E2.a has full matching Git blob OID. | Active; a content match; whole-scope flag true. | B. | I; true. | Exact blob comparison. |
| F7 / 5g | Same, mismatching OID. | Same active state; mismatch observation; flag false. | B. | I; true. | Content mismatch is informational. |
| F8 / 5g | Required diff exists, optional blob object/hash unavailable. | Same active state; unavailable observation. | B. | I; true. | Optional availability cannot decide effectiveness. |
| F9 | Multi-output E2 has one scalar after_hash. | Active coverage; ambiguous hash subject; no automatic per-file match. | B. | I; true. | No unscoped hash expansion. |
| F10 | Deleted path or gitlink. | Effectiveness unchanged; content not applicable. | As evidence establishes. | Ordinary downgrade rule. | Object kind matters. |
| I1 / 9f | Agent/x registered; E2 is system/x; amendment to agent/x. | `uncorroborated`, not unknown_actor. | Target remains recorded. | System-only baseline: uncovered W; default gate true, no downgrade. | Full pair comparison. |
| I2 | Same evidence, amendment to system/x. | May be active. | System/x effective. | Does not invent agent coverage; raw fail, if present, stays fail. | Display and coverage population differ. |
| I3 | Operator human/x, beneficiary agent/x, valid evidence. | Active. | Agent/x. | Ordinary downgrade rule. | Do not compare bare operator/beneficiary IDs. |
| I4 | Ordinary human target, agent beneficiary, valid evidence. | Permitted; instruction targets remain banned. | Agent effective, human recorded. | Raw non-agent eligibility stays unchanged. | Exact target restriction. |
| I5 | Whole correction O→B; O has model/name/version/OBO. | Active. | B has no copied O model/name/version; recorded OBO preserved. | N/A | No metadata transplant. |
| N1 / 7i | Shuffle complete valid event input. | Identical ordered states/reasons. | Identical. | Identical. | Permutation invariance. |
| N2 | Repeat an identical event retrieval row. | Deduplicated; same result. | Identical. | Identical. | No double counting. |
| N3 | Same ID with conflicting bytes or sequence. | Unavailable `invalid_snapshot`. | Recorded fallback, unknown attribution. | No downgrade. | No last-write-wins. |
| N4 | Distinct IDs share a sequence; unsafe integer sequence. | Unavailable `invalid_snapshot`. | Unknown attribution. | No downgrade. | Total ordering is verified. |
| N5 | History page/scoped export misses target, witness, or amendment history. | Unavailable `incomplete_snapshot`. | Unknown attribution, not “rejected missing target.” | No downgrade. | Completeness precedes absence claims. |
| N6 | Full complete snapshot; referenced witness truly absent. | `uncorroborated` unless other witnesses suffice. | Recorded or independently justified. | Ordinary rule. | Actual absence is semantic. |
| N7 | Event hash/head signature invalid. | Unavailable `invalid_snapshot`/`untrusted_snapshot`, respectively. | Unknown attribution. | Integrity failure preserved. | Stamps require authenticated bytes. |
| N8 | Historical hook policy missing. | Unavailable `context_missing`. | Unknown attribution. | No downgrade. | No current-policy substitution. |
| N9 | Conflicting repository aliases or commit resolutions. | Unavailable `context_conflict`. | Unknown attribution. | No downgrade. | Canonical identity must be unique. |
| N10 | Prior P3 reachable versus established excluded-unreachable, E2, T5. | First uncorroborated; second can qualify. | O versus B, under different explicit contexts. | Corresponding raw-window result. | Context is part of reproducibility. |
| N11 | Older unfetched seal before checkout horizon. | Retains its boundary; do not treat it as abandoned. | According to bounded window. | No widened stale coverage. | Missing object ≠ unreachable rewrite. |
| N12 | Required target parent absent in shallow checkout. | Unavailable `context_missing`. | Unknown attribution. | No downgrade. | No fabricated empty-tree diff. |
| D1 / 9c | Agreeing recorded hook/webhook; amend one. | Amendment can be active. | Two views retained separately. | No newly manufactured disagreement. | Recorded producer comparison. |
| D2 / 9d–9e | Recorded hook O/webhook C; amendment makes effective identities agree. | Amendment can be active. | Recorded disagreement visible. | Producer disagreement F; misattributed F not downgraded. | Attribution cannot erase open disagreement. |
| D3 | Both recorded O; amend only webhook completely. | Webhook amendment active. | Hook O; webhook effective B. | Hook-produced F remains. | Exact target-seal association. |
| D4 | Both recorded O; amend selected hook completely. | Hook amendment active. | Hook effective B; webhook recorded O. | Amended I; true absent other failures. | Correct only the finding-producing claim. |
| D5 | Lone producer disagreement is W under local policy; misattributed F also present. | Amendment may be active. | Effective view shown. | Open disagreement still blocks downgrade; false. | Open is not synonymous with fail level. |
| D6 | Valid human ACK plus partial/ineffective attribution. | Attribution state unchanged by ACK. | Partial/recorded as derived. | Existing ACK can make findings I; no false amended certificate. | Independent acknowledgement path. |
| D7 | Rejected attribution attempt also tagged correction. | Rejected; excluded from ACK mining. | Prior view unchanged. | No new ACK downgrade. | One attempt cannot acquire a second effect. |
| D8 | Valid full correction plus unrelated missing commit/integrity/pin failure. | Amendment active. | Corrected target view. | Unrelated failure remains; applicable gate/doctor still fails. | No blanket “green” result. |
| V1 / 4, 10 | Serialize/hash all sealed events before and after view generation. | Derived states only. | Both identities recoverable. | N/A | Original bytes unchanged. |
| V2 / 4c, 10 | One of three eligible units amended. | Active partial. | Text says “1 of 3”; JSON has recorded event actor and scoped artifact override. | N/A | Partial display cannot imply whole attribution. |
| V3 | Disjoint complete aggregate attribution. | Several active partials. | “N of N across partial amendments”; event count stays recorded. | N/A | Explicit whole-event rule. |
| V4 / 10 | Default/effective export rendering. | Same derivation and sealed bundle. | Banner, recorded/effective pairing, amendment references in both modes. | Verification outcome unchanged by display mode. | Render-time only. |
| V5 | Existing valid provenance amendment plus rejected attribution. | Legacy effect preserved; attribution counted once as rejected. | No attribution role laundering. | N/A | Collector isolation. |
| V6 | Preflight accepts at H; concurrent overlapping amendment seals first. | New sealed attempt becomes `no_supersede` or other ranked rejection. | Actual final state reported. | No promised downgrade. | Preflight is advisory. |
| V7 | `--seal-anyway`, well-formed uncorroborated attempt. | Recorded, rejected `uncorroborated`; CLI exit 2. | Recorded target actor. | No downgrade. | Recording is not acceptance. |
| V8 | `--seal-anyway` with mixed kinds, forged stamps, or unavailable required context. | No submission through supported tool. | Unchanged. | N/A | Override boundaries. |

**Candidate properties**

| Property | Evaluation |
|---|---|
| Reordering a valid snapshot cannot change the result. | **True for fixed context.** Verified unique sequences and explicit sorting establish this; diagnostics must also be sorted. |
| Rejected candidates do not mutate effective state. | **True for the checker/replay transition.** Rejection performs no owner/predecessor mutation. |
| Adding an ineffective amendment cannot make another effective. | **Too broad over arbitrary serialized histories.** The current raw-root walker permits a previously missing causal reference to become resolvable. If old A points to missing X, and newly present X is rooted but rejected for its own amendment target, X can supply A’s raw causal path. Correct replacement: a rejected transition does not alter attribution state; appending a rejected attempt cannot affect prior attribution when their raw rooting and other static inputs remain unchanged. |
| Scoped changes cannot silently expand to unrelated artifacts. | **Too strong as stated.** Full supersession intentionally restores dropped predecessor scope; the event-wide witness ban can also cause indirect cascades on other artifacts. Direct beneficiary assignment is confined to the incoming scope. Direct removal is confined to the named predecessor’s scope. Both changes and downstream cascades must be exposed. |
| Unresolved producer disagreement cannot be erased by attribution. | **True.** Recorded comparison and the open-disagreement veto establish it. An independent valid ACK is a separate mechanism. |
| Recorded identities and original bytes remain recoverable. | **True by construction.** Views are separate values and never rewrite sealed events. |
| Content-bound availability cannot change effectiveness. | **True when only optional observations change.** Required Git window/diff context is a different input and must not be confused with optional blob availability. |
| Once ineffective, always ineffective. | **False.** The worked head-9 cascade reactivates A2 without resealing it. Correct replacement: outcomes are properties of the identified final snapshot/context. |

