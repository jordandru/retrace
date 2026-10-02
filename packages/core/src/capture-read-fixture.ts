/** Test-only shared contract suite: memory and SQLite retain their own matched-set semantics. */
import assert from "node:assert/strict";
import test from "node:test";
import { Event, EventInput } from "./schema.js";
import { EventStore, ArtifactIndexQuery, CaptureIndexResult, artifactIndexRows, appendEvent } from "./store.js";
import { captureSealEligible, captureSeals, firstStampedSeq, sameArtifact } from "./capture.js";
import { evaluateAmendmentsAtU, CLASSIFY_ROW_CAP } from "./classify.js";
import { ownerLoginScenario } from "./owner-login-fixture.js";
import { classifyOwnerLogin, ownerLoginRecord } from "./owner-login.js";

export function legacyCaptureRead(store: EventStore): NonNullable<EventStore["captureIndexRows"]> {
  return async (q, now, metrics): Promise<CaptureIndexResult> => {
    const result = await store.eventsReferencingArtifacts!(q, now, metrics);
    if (!result.ok) return result;
    return { ok: true, rows: result.events.map(event => ({ seq: event.seq, event,
      stamped: typeof event.method?.params?.sealed_by === "string",
      keys: artifactIndexRows(event).filter(row => q.artifact_keys.some(key => sameArtifact(key, row.artifact_key))
        || q.artifact_prefixes?.some(prefix => row.artifact_key.startsWith(prefix))).map(row => row.artifact_key),
    })) };
  };
}

export function captureReadContract(name: string, factory: () => EventStore & { close?: () => void }) {
  const run = (title: string, fn: (store: EventStore) => Promise<void>) => test(`${name}: ${title}`, async () => {
    const store = factory(); try { await fn(store); } finally { store.close?.(); }
  });
  const q = (keys = ["repo:app#a.ts"]): ArtifactIndexQuery => ({ project: "p", artifact_keys: keys,
    after_seq: -1, through_seq: 100_000, row_cap: 1000, deadline: Infinity });
  const add = async (store: EventStore, over: Partial<EventInput> = {}) => (await appendEvent(store, EventInput.parse({
    project: "p", actor: { type: "agent", id: "codex" }, action: "read", artifacts: [{ id: "repo:acme/app#a.ts", role: "used" }], ...over,
  }))).event;

  run("boundary, legacy seals, webhook and merged non-seal; guarded NUL/deep bodies", async store => {
    const sha = "a".repeat(40), artifacts = [{ id: "repo:acme/app#a.ts" }, { id: `commit:acme/app@${sha}` }];
    const seal = () => add(store, { action: "committed", artifacts, method: { tool: "git", params: { sha } } });
    const before = await seal();
    await add(store, { method: { params: { "sealed_by\u0000x": "decoy" } } });
    const hider = await add(store, { method: { params: { "sealed_by\u0000x": 42, sealed_by: "owner" } } });
    const after = await seal();
    let deep: unknown = 1; for (let i = 0; i < 1001; i++) deep = { child: deep };
    await add(store, { method: { params: { deep } } });
    const hook = await add(store, { action: "committed", artifacts, method: { tool: "git", params: { sha, sealed_by: "owner" } } });
    const webhook = await add(store, { action: "committed", artifacts, tags: ["push"], method: { params: { sha, sealed_by: "webhook:github" } } });
    const merged = await add(store, { action: "merged", artifacts, method: { tool: "github", params: { sha, sealed_by: "webhook:github" } } });
    const old = await store.eventsReferencingArtifacts!(q(), () => 0), fresh = await store.captureIndexRows!(q(), () => 0);
    assert.ok(old.ok && fresh.ok); if (!old.ok || !fresh.ok) return;
    assert.equal(fresh.rows.length, old.events.length);
    const boundary = Math.min(...fresh.rows.filter(r => r.stamped).map(r => r.seq));
    assert.equal(boundary, hider.seq);
    const policy = { repoName: "acme/app", aliases: ["app"], ownerSeals: true };
    assert.equal(boundary, firstStampedSeq(old.events, policy));
    const bodies = fresh.rows.flatMap(r => r.event ? [r.event] : []);
    const resolve = () => `acme/app@${sha}`;
    assert.deepEqual(captureSeals(bodies, { ...policy, firstStampedSeq: boundary }, resolve), captureSeals(old.events, policy, resolve));
    assert.deepEqual(bodies.filter(e => captureSealEligible(e, policy, boundary)).map(e => e.id), [before.id, hook.id, webhook.id]);
    // One grouped seal records the earliest eligible capture, never the post-boundary legacy or merged non-push.
    assert.equal(captureSeals(bodies, { ...policy, firstStampedSeq: boundary }, resolve)[0].event.id, before.id);
    for (const event of [before, after, hook, webhook, merged]) assert.ok(bodies.some(e => e.id === event.id));
    if (name === "SQLite") for (const seq of [1, 2, 4]) assert.ok(fresh.rows.find(r => r.seq === seq)?.event, `unknown ${seq} returns body`);
    else assert.equal(bodies.length, 5);
  });

  run("no seals still carries counts; cap counts pairs, grouped limit and >400-term dedup", async store => {
    await add(store, { artifacts: [{ id: "task:0" }, { id: "task:1" }], method: { params: { sealed_by: "owner" } } });
    for (let i = 2; i < 6; i++) await add(store, { artifacts: [{ id: `task:${i}` }] });
    const query = { ...q(Array.from({ length: 401 }, (_, i) => `task:${i}`)), artifact_prefixes: ["task:"] };
    const fresh = await store.captureIndexRows!(query, () => 0);
    assert.ok(fresh.ok); if (!fresh.ok) return;
    assert.equal(fresh.rows.length, 5); assert.equal(fresh.rows.reduce((n, r) => n + r.keys.length, 0), 6);
    assert.ok(fresh.rows.every(r => !r.event)); assert.equal(fresh.rows[0].stamped, true);
    for (const row_cap of [1, 4, 5, 6]) {
      const old = await store.eventsReferencingArtifacts!({ ...query, row_cap }, () => 0);
      const got = await store.captureIndexRows!({ ...query, row_cap }, () => 0);
      assert.equal(got.ok, old.ok); if (!old.ok) assert.deepEqual(got, old);
    }
  });

  run("amendment outcomes, base-only stamp, per-call boundaries and full-OID veto equal full-body reader", async store => {
    const root = await add(store, { actor: { type: "human", id: "owner" }, action: "instructed", artifacts: [{ id: "task:root" }] });
    const sha = "b".repeat(40), ref = `commit:acme/app@${sha.slice(0, 7)}`;
    // Found only on the second read. Moves complete boundary below the legacy file seal.
    const commitStamp = await add(store, { artifacts: [{ id: ref }], method: { params: { sealed_by: "owner" } } });
    const legacy = await add(store, { action: "committed", artifacts: [{ id: ref }, { id: "repo:acme/app#a.ts" }], method: { tool: "git", params: { sha } } });
    const targetStamp = await add(store, { method: { params: { sealed_by: "owner" } } });
    const target = await add(store, { action: "edited", caused_by: root.id, artifacts: [{ id: "repo:acme/app#a.ts", role: "generated" }] });
    await add(store, { action: "other", action_detail: "amended", tags: ["amendment", "attribution"], caused_by: root.id,
      artifacts: [{ id: `event:${target.id}`, role: "used" }], method: { tool: "retrace_amend", params: { sealed_by: "owner", target_event_id: target.id,
        attribution: { from: target.actor, to: { type: "agent", id: "other" }, evidence: [root.id] } } } });
    const policy = { profile: "retrace-project-policy/1" as const, project: "p", trusted_hook_stamps: [], unresolved_claims: "record" as const,
      repositories: [{ name: "acme/app", aliases: ["app"] }], github_repos: ["acme/app"] };
    const native = store.captureIndexRows!.bind(store), old = legacyCaptureRead(store);
    const evaluate = (captureEvents: Event[]) => evaluateAmendmentsAtU({ store, project: "p", U: 100_000, headHash: "a".repeat(64),
      policy, policyDigest: "a".repeat(64), canonicalRepo: "acme/app", captureEvents, coveredArtifactKeys: [], deadline: 1_000_000, now: () => 0 });
    for (const base of [[], [{ ...root, method: { params: { sealed_by: "owner" } } }]]) {
      store.captureIndexRows = old; const expected = await evaluate(base);
      const calls: number[] = [];
      store.captureIndexRows = async (...args) => { const got = await native(...args); if (got.ok) calls.push(Math.min(...got.rows.filter(r => r.stamped).map(r => r.seq))); return got; };
      const got = await evaluate(base); assert.equal(got.ok, expected.ok); assert.equal(got.snapshotJson, expected.snapshotJson);
      if (got.ok && expected.ok) assert.deepEqual(got.captureSeals, expected.captureSeals);
      if (!base.length) assert.deepEqual(calls, [targetStamp.seq, commitStamp.seq]);
      else assert.equal(calls.length, 1, "base stamp excludes legacy before preliminary, so no commit read");
    }
    const almostFull = [legacy, ...Array.from({ length: CLASSIFY_ROW_CAP - 4 }, () => root)];
    store.captureIndexRows = old; const oldCap = await evaluate(almostFull);
    store.captureIndexRows = native; const newCap = await evaluate(almostFull);
    assert.deepEqual(newCap, oldCap); assert.equal(newCap.ok, false);
    if (!newCap.ok) assert.equal(newCap.reason, "budget", "three matched events, only one body: rowsRead fills before commit read");
    // Two eligible owner seals resolving the same short reference differently must veto.
    for (const full of [sha, sha.slice(0, 7) + "c".repeat(33)]) await add(store, { action: "committed",
      artifacts: legacy.artifacts, method: { tool: "git", params: { sha: full, sealed_by: "owner" } } });
    store.captureIndexRows = old; const expected = await evaluate([]);
    store.captureIndexRows = native; const got = await evaluate([]);
    assert.equal(got.ok, expected.ok); assert.equal(got.snapshotJson, expected.snapshotJson);
      if (got.ok && expected.ok) assert.deepEqual(got.captureSeals, expected.captureSeals); assert.equal(got.ok, false); if (!got.ok) assert.equal(got.reason, "store_error");
    // An absent capture method fails closed even when the general read remains available.
    store.captureIndexRows = undefined; const missing = await evaluate([]); assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason, "store_error");
    store.captureIndexRows = native;
    const capped = await evaluate(Array.from({ length: CLASSIFY_ROW_CAP }, () => root));
    assert.equal(capped.ok, false); if (!capped.ok) assert.equal(capped.reason, "budget");
  });

  run("owner aggregate budget counts non-seals and keeps SQL over-match semantic count at zero", async store => {
    const f = await ownerLoginScenario(store);
    const root = (await appendEvent(store, { project: f.project, actor: { type: "human", id: "owner" }, action: "instructed", artifacts: [{ id: "task:root" }] })).event;
    const file = "repo:app#a.ts";
    const target = (await appendEvent(store, { project: f.project, actor: { type: "agent", id: "codex" }, action: "edited",
      artifacts: [{ id: file, role: "generated" }], caused_by: root.id })).event;
    f.policy.body.repositories.push({ name: "acme/app", aliases: ["app"] });
    await appendEvent(store, { project: f.project, actor: root.actor, action: "other", action_detail: "amended", tags: ["amendment", "attribution"], caused_by: root.id,
      artifacts: [{ id: `event:${target.id}` }], method: { tool: "retrace_amend", params: { sealed_by: "owner", target_event_id: target.id,
        attribution: { from: target.actor, to: { type: "agent", id: "other" }, evidence: [root.id] } } } });
    const native = store.captureIndexRows!.bind(store);
    const classify = () => classifyOwnerLogin({ store, input: f.input, policy: f.policy, canonicalR: f.repo,
      readHead: { seq: 100_000, hash: "a".repeat(64) }, deadline: Date.now() + 60_000 });
    const decision = async () => { const r = await classify(); assert.equal(r.kind, "decision"); if (r.kind !== "decision") throw new Error("fixture"); return ownerLoginRecord(r.input)!.decision; };
    for (let i = 0; i < 1994; i++) await appendEvent(store, { project: f.project, actor: target.actor, action: "read", artifacts: [{ id: file }] });
    await appendEvent(store, { project: f.project, actor: target.actor, action: "read", artifacts: [{ id: "repo:x#/app#a.ts" }] });
    store.captureIndexRows = legacyCaptureRead(store); const expected = await decision();
    store.captureIndexRows = native; const got = await decision();
    const strip = (d: typeof got) => { const { timing, classification_ms, ...rest } = d; return rest; };
    assert.deepEqual(strip(got), strip(expected)); assert.equal(got.timing.budget_rows_remaining, expected.timing.budget_rows_remaining);
    assert.equal(got.timing.budget_rows_remaining, 1, "one candidate, one amendment, two dependencies, 1995 semantic capture pairs");
    store.captureIndexRows = async () => ({ ok: false, reason: "store_error" });
    const malformed = await decision(); assert.equal(malformed.status, "unavailable"); assert.equal(malformed.reason, "store_error");
    store.captureIndexRows = native;
    for (let i = 0; i < 2; i++) await appendEvent(store, { project: f.project, actor: target.actor, action: "read", artifacts: [{ id: file }] });
    const capped = await decision(); assert.equal(capped.status, "unavailable"); assert.equal(capped.reason, "budget");
  });
}
