import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, buildExportBundle, checkpointFromBundle, createHandler, generateSigningKey, keyId, signProducer, PRODUCER_SIG_FORMAT_V2, CLAIM_DECISION_PARAM, PRODUCER_HOOK_SYSTEM_ACTOR, SEALED_BY_PARAM, POLICY_PROFILE } from "@retrace-dev/core";
import { SqliteStore } from "./sqlite-store.js";
import { trustedHookStampsFor, producerVerifyOptsFor } from "./hook-stamps.js";

const bin = fileURLToPath(new URL("./export-cli.js", import.meta.url));
const HOST_VARS = /^(RETRACE_|ORCA_|CLAUDE_CODE_SESSION_ID$|GROK_SESSION_ID$)/;
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !HOST_VARS.test(k))) as Record<string, string>;

async function putPolicy(store: SqliteStore, project: string, stamps: string[]) {
  const h = createHandler(store, { token: "owner-token-long-enough", ownerPrincipal: { type: "human", id: "o" } });
  const res = await h(new Request(`http://test/projects/${project}/policy`, {
    method: "PUT",
    headers: { authorization: "Bearer owner-token-long-enough", "content-type": "application/json", "if-match": "none" },
    body: JSON.stringify({
      profile: POLICY_PROFILE, project, trusted_hook_stamps: stamps,
      unresolved_claims: "record", repositories: [], github_repos: [],
    }),
  }));
  if (res.status !== 201) throw new Error(`PUT policy ${res.status}: ${await res.text()}`);
  return (await res.json() as { digest: string }).digest;
}

function runVerify(args: string[]) {
  return spawnSync(process.execPath, [bin, "verify", ...args], { encoding: "utf8", env: baseEnv, cwd: args[0] ? dirname(args[0]) : undefined });
}

test("verify --checkpoint fails closed unless a matching checkpoint has a trusted valid signature", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-checkpoint-verify-"));
  try {
    const store = new SqliteStore(join(dir, "ledger.db"));
    await appendEvent(store, {
      project: "p",
      actor: { type: "human", id: "jordan@example.com" },
      action: "created",
      artifacts: [{ id: "artifact:a", role: "generated" }],
    });
    const issuer = await generateSigningKey();
    const checkpointSigner = await generateSigningKey();
    const bundle = await buildExportBundle(store, { project: "p" }, { signingKey: issuer.privateKey });
    const checkpoint = await checkpointFromBundle(bundle, { signingKey: checkpointSigner.privateKey });

    const bundleFile = join(dir, "bundle.json");
    const issuerPub = join(dir, "issuer-pub.json");
    const checkpointPub = join(dir, "checkpoint-pub.json");
    const checkpointFile = join(dir, "checkpoints.jsonl");
    const unsignedFile = join(dir, "unsigned.jsonl");
    const otherProjectFile = join(dir, "other-project.jsonl");
    writeFileSync(bundleFile, JSON.stringify(bundle));
    writeFileSync(issuerPub, JSON.stringify(issuer.publicKey));
    writeFileSync(checkpointPub, JSON.stringify(checkpointSigner.publicKey));
    writeFileSync(checkpointFile, JSON.stringify(checkpoint) + "\n");
    writeFileSync(unsignedFile, JSON.stringify({ ...checkpoint, signer: undefined, signature: undefined }) + "\n");
    writeFileSync(otherProjectFile, JSON.stringify({ ...checkpoint, project: "q" }) + "\n");

    const common = [bundleFile, "--pubkey", issuerPub];
    const noTrustedKey = runVerify([...common, "--checkpoint", checkpointFile]);
    assert.equal(noTrustedKey.status, 2);
    assert.match(noTrustedKey.stdout, /NOT VALID|no trusted checkpoint key/);

    mkdirSync(join(dir, ".retrace"));
    writeFileSync(join(dir, ".retrace", "checkpoint-public.jwk"), JSON.stringify(checkpointSigner.publicKey));
    const repositoryDefault = runVerify([...common, "--checkpoint", checkpointFile]);
    assert.equal(repositoryDefault.status, 0, repositoryDefault.stdout + repositoryDefault.stderr);
    assert.match(repositoryDefault.stdout, /trusted key from \.retrace\/checkpoint-public\.jwk/);

    const valid = runVerify([...common, "--checkpoint", checkpointFile, "--checkpoint-pubkey", checkpointPub]);
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    assert.match(valid.stdout, /signature valid.*MATCHES/);

    const unsigned = runVerify([...common, "--checkpoint", unsignedFile, "--checkpoint-pubkey", checkpointPub]);
    assert.equal(unsigned.status, 2);
    assert.match(unsigned.stdout, /signature unsigned/);

    const missing = runVerify([...common, "--checkpoint", otherProjectFile, "--checkpoint-pubkey", checkpointPub]);
    assert.equal(missing.status, 2);
    assert.match(missing.stdout, /NOT VERIFIED.*none for project p/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("producer-keygen writes a 0600 private JWK, prints public only, and refuses the export issuer path", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-producer-keygen-"));
  const out = join(dir, "agent.jwk");
  const issuer = join(dir, "signing-key.json");
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env: { ...baseEnv, ...extra } });
  try {
    const ok = run(["producer-keygen", "--out", out]);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.match(ok.stdout, /created producer key at/);
    assert.match(ok.stdout, /public JWK/);
    assert.doesNotMatch(ok.stdout, /"d":/);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.ok(JSON.parse(readFileSync(out, "utf8")).d);
    const refuse = run(["producer-keygen", "--out", issuer], { RETRACE_SIGNING_KEY_FILE: issuer });
    assert.notEqual(refuse.status, 0);
    assert.match((refuse.stderr || "") + (refuse.stdout || ""), /export issuer key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trustedHookStampsFor uses basename only when cfg.project is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-stamps-bind-"));
  const named = join(dir, "projectB");
  const unnamed = join(dir, "fallbackB");
  try {
    mkdirSync(named);
    mkdirSync(unnamed);
    writeFileSync(join(named, ".retrace.json"), JSON.stringify({
      project: "projectA",
      reconcile: { hook_sealed_by: ["assert:git hook (assert)"] },
    }));
    writeFileSync(join(unnamed, ".retrace.json"), JSON.stringify({
      reconcile: { hook_sealed_by: ["assert:release-recorder"] },
    }));
    assert.deepEqual(trustedHookStampsFor(named, "projectA"), ["assert:git hook (assert)"]);
    assert.equal(trustedHookStampsFor(named, "projectB"), undefined, "a directory named projectB does not widen declared projectA");
    assert.equal(producerVerifyOptsFor(named, "projectB").trustedHookStamps, undefined);
    assert.equal(producerVerifyOptsFor(named, "projectB").project, "projectB");
    assert.deepEqual(trustedHookStampsFor(unnamed, "fallbackB"), ["assert:release-recorder"], "basename fallback when cfg.project is absent");
    assert.equal(trustedHookStampsFor(unnamed, "projectA"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify binds hook stamps to bundle.scope.project, not cwd (two-project, default cwd)", async () => {
  const root = mkdtempSync(join(tmpdir(), "retrace-two-project-"));
  const repoA = join(root, "repoA");
  const repoB = join(root, "repoB");
  try {
    mkdirSync(repoA);
    mkdirSync(repoB);
    writeFileSync(join(repoA, ".retrace.json"), JSON.stringify({
      project: "projectA",
      reconcile: { hook_sealed_by: ["assert:git hook (assert)"] },
    }));
    writeFileSync(join(repoB, ".retrace.json"), JSON.stringify({
      project: "projectB",
      reconcile: { hook_sealed_by: ["assert:release-recorder"] },
    }));

    const producer = await generateSigningKey();
    const issuer = await generateSigningKey();
    const claimed = { type: "agent" as const, id: "codex", on_behalf_of: "jordan@example.com" };
    const signed = await signProducer({
      project: "projectB",
      actor: claimed,
      action: "committed",
      artifacts: [{ id: "commit:projectB@abc1234abc12", kind: "commit", role: "generated" }],
      timestamp: "2026-09-09T12:00:00.000Z",
      idempotency_key: "git:two-project-bind",
      intent: "signed bump",
      method: {
        tool: "git",
        automated: true,
        params: {
          branch: "main",
          parents: ["defdefdefdefdefdefdefdefdefdefdefdefdefd"],
          files: 1,
          insertions: 1,
          deletions: 0,
          sha: "abcabcabcabcabcabcabcabcabcabcabcabcabca",
          raw_message: "signed bump\n\nRetrace-Actor: codex\n",
          author: { name: "Jordan", email: "jordan@example.com" },
        },
      },
    }, producer.privateKey, { format: PRODUCER_SIG_FORMAT_V2 });
    const withheld = {
      ...signed,
      actor: { ...PRODUCER_HOOK_SYSTEM_ACTOR },
      method: {
        ...signed.method,
        params: {
          ...signed.method!.params,
          [SEALED_BY_PARAM]: "assert:release-recorder",
          [CLAIM_DECISION_PARAM]: {
            policy: "trailer-consistency/1",
            decision: { actor_written: "withheld" },
            signed_actor: { ...claimed },
            claim: { type: claimed.type, id: claimed.id },
          },
        },
      },
    };
    const store = new SqliteStore(join(root, "ledger.db"));
    const digest = await putPolicy(store, "projectB", ["assert:release-recorder"]);
    (withheld.method.params[CLAIM_DECISION_PARAM] as { context?: { policy_digest: string; read_head_seq: number } }).context = {
      policy_digest: digest, read_head_seq: 0,
    };
    await appendEvent(store, withheld);
    const bundle = await buildExportBundle(store, { project: "projectB" }, {
      signingKey: issuer.privateKey,
      producers: [{ kid: await keyId(producer.publicKey), public_key: producer.publicKey }],
    });
    assert.ok(bundle.policies?.some((d) => d.digest === digest));
    const bundleFile = join(root, "bundle.json");
    const issuerPub = join(root, "issuer-pub.json");
    writeFileSync(bundleFile, JSON.stringify(bundle));
    writeFileSync(issuerPub, JSON.stringify(issuer.publicKey));

    const verifyFrom = (cwd: string) =>
      spawnSync(process.execPath, [bin, "verify", bundleFile, "--pubkey", issuerPub], { encoding: "utf8", env: baseEnv, cwd });

    // A-cwd / B-bundle uses B's enclosed policy, not repo A's .retrace.json.
    const fromA = verifyFrom(repoA);
    assert.match(fromA.stdout, /producer sigs: 1 verified · 0 INVALID/, fromA.stdout + fromA.stderr);
    const fromB = verifyFrom(repoB);
    assert.match(fromB.stdout, /producer sigs: 1 verified · 0 INVALID/, fromB.stdout + fromB.stderr);

    const stripped = { ...bundle, policies: [] };
    writeFileSync(bundleFile, JSON.stringify(stripped));
    const fromAMissing = verifyFrom(repoA);
    assert.match(fromAMissing.stdout, /producer sigs: 0 verified · 1 INVALID/, fromAMissing.stdout + fromAMissing.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify basename collision: projectA config in a directory named projectB fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "retrace-basename-collision-"));
  const colliding = join(root, "projectB");
  try {
    mkdirSync(colliding);
    writeFileSync(join(colliding, ".retrace.json"), JSON.stringify({
      project: "projectA",
      reconcile: { hook_sealed_by: ["assert:git hook (assert)"] },
    }));

    const producer = await generateSigningKey();
    const issuer = await generateSigningKey();
    const claimed = { type: "agent" as const, id: "codex", on_behalf_of: "jordan@example.com" };
    const signed = await signProducer({
      project: "projectB",
      actor: claimed,
      action: "committed",
      artifacts: [{ id: "commit:projectB@abc1234abc12", kind: "commit", role: "generated" }],
      timestamp: "2026-09-09T12:00:00.000Z",
      idempotency_key: "git:basename-collision",
      intent: "signed bump",
      method: {
        tool: "git",
        automated: true,
        params: {
          branch: "main",
          parents: ["defdefdefdefdefdefdefdefdefdefdefdefdefd"],
          files: 1,
          insertions: 1,
          deletions: 0,
          sha: "abcabcabcabcabcabcabcabcabcabcabcabcabca",
          raw_message: "signed bump\n\nRetrace-Actor: codex\n",
          author: { name: "Jordan", email: "jordan@example.com" },
        },
      },
    }, producer.privateKey, { format: PRODUCER_SIG_FORMAT_V2 });
    const withheld = {
      ...signed,
      actor: { ...PRODUCER_HOOK_SYSTEM_ACTOR },
      method: {
        ...signed.method,
        params: {
          ...signed.method!.params,
          [SEALED_BY_PARAM]: "assert:git hook (assert)",
          [CLAIM_DECISION_PARAM]: {
            policy: "trailer-consistency/1",
            decision: { actor_written: "withheld" },
            signed_actor: { ...claimed },
            claim: { type: claimed.type, id: claimed.id },
          },
        },
      },
    };
    const store = new SqliteStore(join(root, "ledger.db"));
    await appendEvent(store, withheld);
    const bundle = await buildExportBundle(store, { project: "projectB" }, {
      signingKey: issuer.privateKey,
      producers: [{ kid: await keyId(producer.publicKey), public_key: producer.publicKey }],
    });
    const bundleFile = join(root, "bundle.json");
    const issuerPub = join(root, "issuer-pub.json");
    writeFileSync(bundleFile, JSON.stringify(bundle));
    writeFileSync(issuerPub, JSON.stringify(issuer.publicKey));

    const fromCollision = spawnSync(process.execPath, [bin, "verify", bundleFile, "--pubkey", issuerPub], {
      encoding: "utf8",
      env: baseEnv,
      cwd: colliding,
    });
    assert.match(fromCollision.stdout, /producer sigs: 0 verified · 1 INVALID/, fromCollision.stdout + fromCollision.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify basename fallback: no cfg.project, directory named projectB, B's withheld bundle is 1 verified", async () => {
  const root = mkdtempSync(join(tmpdir(), "retrace-basename-fallback-"));
  const repo = join(root, "projectB");
  try {
    mkdirSync(repo);
    writeFileSync(join(repo, ".retrace.json"), JSON.stringify({
      reconcile: { hook_sealed_by: ["assert:release-recorder"] },
    }));

    const producer = await generateSigningKey();
    const issuer = await generateSigningKey();
    const claimed = { type: "agent" as const, id: "codex", on_behalf_of: "jordan@example.com" };
    const signed = await signProducer({
      project: "projectB",
      actor: claimed,
      action: "committed",
      artifacts: [{ id: "commit:projectB@abc1234abc12", kind: "commit", role: "generated" }],
      timestamp: "2026-09-09T12:00:00.000Z",
      idempotency_key: "git:basename-fallback",
      intent: "signed bump",
      method: {
        tool: "git",
        automated: true,
        params: {
          branch: "main",
          parents: ["defdefdefdefdefdefdefdefdefdefdefdefdefd"],
          files: 1,
          insertions: 1,
          deletions: 0,
          sha: "abcabcabcabcabcabcabcabcabcabcabcabcabca",
          raw_message: "signed bump\n\nRetrace-Actor: codex\n",
          author: { name: "Jordan", email: "jordan@example.com" },
        },
      },
    }, producer.privateKey, { format: PRODUCER_SIG_FORMAT_V2 });
    const withheld = {
      ...signed,
      actor: { ...PRODUCER_HOOK_SYSTEM_ACTOR },
      method: {
        ...signed.method,
        params: {
          ...signed.method!.params,
          [SEALED_BY_PARAM]: "assert:release-recorder",
          [CLAIM_DECISION_PARAM]: {
            policy: "trailer-consistency/1",
            decision: { actor_written: "withheld" },
            signed_actor: { ...claimed },
            claim: { type: claimed.type, id: claimed.id },
          },
        },
      },
    };
    const store = new SqliteStore(join(root, "ledger.db"));
    const digest = await putPolicy(store, "projectB", ["assert:release-recorder"]);
    (withheld.method.params[CLAIM_DECISION_PARAM] as { context?: { policy_digest: string; read_head_seq: number } }).context = {
      policy_digest: digest, read_head_seq: 0,
    };
    await appendEvent(store, withheld);
    const bundle = await buildExportBundle(store, { project: "projectB" }, {
      signingKey: issuer.privateKey,
      producers: [{ kid: await keyId(producer.publicKey), public_key: producer.publicKey }],
    });
    const bundleFile = join(root, "bundle.json");
    const issuerPub = join(root, "issuer-pub.json");
    writeFileSync(bundleFile, JSON.stringify(bundle));
    writeFileSync(issuerPub, JSON.stringify(issuer.publicKey));

    const fromFallback = spawnSync(process.execPath, [bin, "verify", bundleFile, "--pubkey", issuerPub], {
      encoding: "utf8",
      env: baseEnv,
      cwd: repo,
    });
    assert.match(fromFallback.stdout, /producer sigs: 1 verified · 0 INVALID/, fromFallback.stdout + fromFallback.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("L2 owner-login replay tolerates slow reads and identifies its own unavailable budget outcome", async (t) => {
  const { MemoryEventStore, appendOwnerLoginEvent } = await import("@retrace-dev/core");
  const { ownerLoginScenario } = await import("../../core/dist/owner-login-fixture.js");
  const { recomputeOwnerLogin } = await import("./owner-login-replay.js");
  const store = new MemoryEventStore(), f = await ownerLoginScenario(store);
  const handler = createHandler(store, { token: "owner-token", ownerPrincipal: { type: "human", id: "owner" } });
  const put = await handler(new Request(`http://test/projects/${f.project}/policy`, { method: "PUT",
    headers: { authorization: "Bearer owner-token", "content-type": "application/json", "if-match": "none" }, body: JSON.stringify(f.policy.body) }));
  assert.equal(put.status, 201, await put.text());
  const policy = (await store.getPolicy(f.project, { current: true }))!;
  await appendOwnerLoginEvent(store, f.input, policy, f.repo, Date.now()+2000);
  const bundle = await buildExportBundle(store, { project: f.project });
  const read = MemoryEventStore.prototype.eventsReferencingArtifacts;
  const slow = t.mock.method(MemoryEventStore.prototype, "eventsReferencingArtifacts",
    async function (this: InstanceType<typeof MemoryEventStore>, ...args: Parameters<typeof read>) {
      await new Promise(resolve => setTimeout(resolve, 400));
      return read.apply(this, args);
    });
  const replay = await recomputeOwnerLogin(bundle);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.results[0].replay_unavailable, undefined);
  slow.mock.restore();
  t.mock.method(MemoryEventStore.prototype, "eventsReferencingArtifacts", async () => ({ ok: false, reason: "budget" }));
  const exhausted = await recomputeOwnerLogin(bundle);
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.results[0].result, "mismatch record.decision.status");
  assert.equal(exhausted.results[0].replay_unavailable, "budget");
});

test("L2 recompute CLI prints when its row budget produces unavailable even if the sealed outcome matches", async () => {
  const { MemoryEventStore, appendOwnerLoginEvent, ownerLoginRecord } = await import("@retrace-dev/core");
  const { ownerLoginScenario } = await import("../../core/dist/owner-login-fixture.js");
  const store = new MemoryEventStore(), f = await ownerLoginScenario(store);
  const handler = createHandler(store, { token: "owner-token", ownerPrincipal: { type: "human", id: "owner" } });
  const put = await handler(new Request(`http://test/projects/${f.project}/policy`, { method: "PUT",
    headers: { authorization: "Bearer owner-token", "content-type": "application/json", "if-match": "none" }, body: JSON.stringify(f.policy.body) }));
  assert.equal(put.status, 201, await put.text());
  const policy = (await store.getPolicy(f.project, { current: true }))!;
  for (let i = 0; i < 2001; i++) await appendEvent(store, { project: f.project, actor: { type: "agent", id: "codex" },
    action: "read", artifacts: [{ id: `pr:${f.repo}#1`, role: "used" }] });
  const sealed = (await appendOwnerLoginEvent(store, f.input, policy, f.repo, Date.now()+2000)).event;
  assert.equal(ownerLoginRecord(sealed)!.decision.reason, "budget");
  const dir = mkdtempSync(join(tmpdir(), "owner-login-budget-"));
  try {
    const file = join(dir, "bundle.json"); writeFileSync(file, JSON.stringify(await buildExportBundle(store, { project: f.project })));
    const run = spawnSync(process.execPath, [bin, "owner-login", "--recompute", "--bundle", file], { encoding: "utf8", env: baseEnv });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /match; replay produced unavailable \(budget\)/);
    assert.match(run.stdout, /replay's own evidence reads, not a preserved sealed outcome/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("T2 T17 owner-login replay reconstructs decisions/table and rejects absent or after-L allocation consumers", async () => {
  const { MemoryEventStore, classifyOwnerLogin, ownerLoginAllocationFailed, appendOwnerLoginEvent, ownerLoginRecord } = await import("@retrace-dev/core");
  const { ownerLoginScenario } = await import("../../core/dist/owner-login-fixture.js");
  const { recomputeOwnerLogin } = await import("./owner-login-replay.js");
  const dir = mkdtempSync(join(tmpdir(), "owner-login-replay-"));
  for (const mode of ["before", "absent", "after-null", "after-id"] as const) {
    const store = new MemoryEventStore(), f = await ownerLoginScenario(store);
    const handler = createHandler(store, { token: "owner-token", ownerPrincipal: { type: "human", id: "owner" } });
    const put = await handler(new Request(`http://test/projects/${f.project}/policy`, { method: "PUT", headers: { authorization: "Bearer owner-token", "content-type": "application/json", "if-match": "none" }, body: JSON.stringify(f.policy.body) }));
    assert.equal(put.status, 201, await put.text());
    const policy = (await store.getPolicy(f.project, { current: true }))!;
    const selected = await classifyOwnerLogin({ store, input: f.input, policy, canonicalR: f.repo, readHead: (await store.head(f.project))!, deadline: Date.now()+1000 });
    assert.equal(selected.kind, "decision"); if (selected.kind !== "decision") throw new Error("fixture");
    // Timing is observed: deliberately unlike any timing the replay will measure.
    ownerLoginRecord(selected.input)!.decision.timing.candidates_ms = 987654;
    let winner: import("@retrace-dev/core").Event | undefined;
    if (mode === "before") winner = (await appendOwnerLoginEvent(store, { ...f.input, idempotency_key: "winner" }, policy, f.repo, Date.now()+2000)).event;
    const failed = { ...ownerLoginAllocationFailed(selected.input, winner?.id ?? null), idempotency_key: "loser" };
    // Deterministic event id lets the negative fixture name an actual consumer that has not sealed yet.
    if (mode === "after-id") ownerLoginRecord(failed)!.decision.allocation!.consumed_by = "evt_11111111111111111111111111111111";
    await appendEvent(store, failed);
    if (mode.startsWith("after")) {
      // Re-seal normally with a fixed id via sealEvent options; sequence/hash must remain valid.
      const { sealEvent } = await import("@retrace-dev/core");
      const e = await sealEvent({ ...selected.input, idempotency_key: "winner-late" }, await store.head(f.project), new Date(), { id: "evt_11111111111111111111111111111111" });
      await store.insert(e, { owner_login_consumption: [{ declaration_event_id: f.declaration.id }] });
    }
    if (mode === "before") await appendOwnerLoginEvent(store, { ...f.input, idempotency_key: "second" }, policy, f.repo, Date.now()+2000);
    if (mode === "before") {
      for (const id of ["codex", "other"]) await appendEvent(store, { ...f.declaration, actor: { type: "agent", id } });
      await appendOwnerLoginEvent(store, { ...f.input, idempotency_key: "conflict" }, policy, f.repo, Date.now()+2000);
      assert.equal(ownerLoginRecord(store.events.at(-1)!)!.decision.status, "conflicting");
    }
    const bundle = await buildExportBundle(store, { project: f.project });
    const replay = await recomputeOwnerLogin(bundle);
    assert.equal(replay.ok, mode === "before", JSON.stringify(replay));
    if (mode === "before") {
      assert.ok(replay.results.some(r => r.result === "match (allocation, by rule)"));
      assert.deepEqual(replay.consumption, [...store.ownerLoginConsumption.values()]);
      assert.ok(replay.results.every(r => r.preserved.includes("classification_ms") && r.preserved.includes("timing")));
    } else assert.ok(replay.results.some(r => r.result === "mismatch allocation"), JSON.stringify(replay));
    const file = join(dir, `${mode}.json`); writeFileSync(file, JSON.stringify(bundle));
    const run = spawnSync(process.execPath, [bin, "owner-login", "--recompute", "--bundle", file], { encoding: "utf8", env: baseEnv });
    assert.equal(run.status, mode === "before" ? 0 : 1, run.stderr + run.stdout);
    assert.match(run.stdout, mode === "before" ? /match \(allocation, by rule\)/ : /mismatch allocation/);
    assert.match(run.stdout, /preserved observed fields/);
  }
});

test("T-A5 T-A6 observed timing, legacy seals, replay prefix and stderr progress", async () => {
  const { MemoryEventStore, appendOwnerLoginEvent, ownerLoginRecord } = await import("@retrace-dev/core");
  const { ownerLoginScenario } = await import("../../core/dist/owner-login-fixture.js");
  const { recomputeOwnerLogin } = await import("./owner-login-replay.js");
  const store = new MemoryEventStore(), f = await ownerLoginScenario(store);
  const handler = createHandler(store, { token: "owner-token", ownerPrincipal: { type: "human", id: "owner" } });
  const put = await handler(new Request(`http://test/projects/${f.project}/policy`, { method: "PUT",
    headers: { authorization: "Bearer owner-token", "content-type": "application/json", "if-match": "none" }, body: JSON.stringify(f.policy.body) }));
  assert.equal(put.status, 201, await put.text());
  const policy = (await store.getPolicy(f.project, { current: true }))!;
  for (let i = 0; i < 501; i++) await appendEvent(store, { project: f.project, actor: { type: "system", id: "fixture" }, action: "read", artifacts: [{ id: "fixture:unrelated", role: "used" }] });
  const first = (await appendOwnerLoginEvent(store, f.input, policy, f.repo)).event;
  // Historical seals lack timing; remove it before sealing so their chain remains valid.
  const { classifyOwnerLogin } = await import("@retrace-dev/core");
  const legacy = await classifyOwnerLogin({ store, input: { ...f.input, idempotency_key: "legacy" }, policy,
    canonicalR: f.repo, readHead: (await store.head(f.project))!, deadline: Date.now() + 1000 });
  if (legacy.kind !== "decision") throw new Error("fixture");
  delete (ownerLoginRecord(legacy.input)!.decision as Partial<import("@retrace-dev/core").OwnerLoginRecord["decision"]>).timing;
  await appendEvent(store, legacy.input);
  const bundle = await buildExportBundle(store, { project: f.project });
  const full = await recomputeOwnerLogin(bundle);
  assert.equal(full.ok, true, JSON.stringify(full));
  assert.equal(full.results.length, 2);
  const prefix = await recomputeOwnerLogin(bundle, undefined, { limitSeq: first.seq });
  assert.deepEqual(prefix.results, full.results.slice(0, 1));
  assert.deepEqual(prefix.consumption, full.consumption);
  assert.deepEqual(await recomputeOwnerLogin(bundle, undefined, { limitSeq: 0 }), { ok: true, results: [], consumption: [] });
  const bad = structuredClone(bundle); bad.events.at(-1)!.intent = "tampered tail";
  assert.equal((await recomputeOwnerLogin(bad, undefined, { limitSeq: first.seq })).ok, false);
  const dir = mkdtempSync(join(tmpdir(), "owner-login-progress-"));
  try {
    const file = join(dir, "bundle.json"); writeFileSync(file, JSON.stringify(bundle));
    const run = (args: string[]) => spawnSync(process.execPath, [bin, "owner-login", "--recompute", "--bundle", file, ...args], { encoding: "utf8", env: baseEnv });
    const plain = run([]), bounded = run(["--limit-seq", String(bundle.events.at(-1)!.seq)]);
    assert.equal(plain.status, 0, plain.stderr); assert.equal(bounded.status, 0, bounded.stderr);
    assert.equal(bounded.stdout, plain.stdout);
    for (const phase of ["bundle parsed", "bundle validated", "fixture loading: 500 events", "fixture loaded", "500 events scanned", "2 decisions replayed"])
      assert.ok(bounded.stderr.includes(phase), bounded.stderr);
    assert.match(bounded.stderr, /\(\d+ ms\)/);
    assert.doesNotMatch(bounded.stdout, /bundle parsed|fixture loaded|events scanned/);
    for (const invalid of ["-1", "1.5", "9007199254740992", "nope"])
      assert.notEqual(run(["--limit-seq", invalid]).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("owner-login replay preserves sealed amendments call timing verbatim", async () => {
  const { MemoryEventStore, classifyOwnerLogin, ownerLoginRecord } = await import("@retrace-dev/core");
  const { ownerLoginScenario } = await import("../../core/dist/owner-login-fixture.js");
  const { recomputeOwnerLogin } = await import("./owner-login-replay.js");
  const store = new MemoryEventStore(), f = await ownerLoginScenario(store);
  const handler = createHandler(store, { token: "owner-token", ownerPrincipal: { type: "human", id: "owner" } });
  const put = await handler(new Request(`http://test/projects/${f.project}/policy`, { method: "PUT",
    headers: { authorization: "Bearer owner-token", "content-type": "application/json", "if-match": "none" }, body: JSON.stringify(f.policy.body) }));
  assert.equal(put.status, 201, await put.text());
  const policy = (await store.getPolicy(f.project, { current: true }))!;
  const result = await classifyOwnerLogin({ store, input: f.input, policy, canonicalR: f.repo,
    readHead: (await store.head(f.project))!, deadline: Date.now() + 1000 });
  assert.equal(result.kind, "decision"); if (result.kind !== "decision") throw new Error("fixture");
  const timing = ownerLoginRecord(result.input)!.decision.timing;
  timing.amendments_calls = [{
    call: "capture_targets", wall_ms: 91.25, rows: { statement_rows: 17, distinct_events: 4 },
    body_chars: 123456, parse_ms: 7.5, sql_ms: 42.75, statements: 3, outcome: "ok",
  }];
  timing.amendments_calls_truncated = true;
  await appendEvent(store, result.input);
  const bundle = await buildExportBundle(store, { project: f.project });
  const replay = await recomputeOwnerLogin(bundle);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.deepEqual(ownerLoginRecord(bundle.events.at(-1)!)!.decision.timing.amendments_calls, timing.amendments_calls);
  assert.equal(ownerLoginRecord(bundle.events.at(-1)!)!.decision.timing.amendments_calls_truncated, true);
  assert.ok(replay.results[0]?.preserved.includes("timing"));
});
