import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, buildExportBundle, checkpointFromBundle, generateSigningKey, keyId, signProducer, PRODUCER_SIG_FORMAT_V2, CLAIM_DECISION_PARAM, PRODUCER_HOOK_SYSTEM_ACTOR, SEALED_BY_PARAM } from "@retrace-dev/core";
import { SqliteStore } from "./sqlite-store.js";
import { trustedHookStampsFor, producerVerifyOptsFor } from "./hook-stamps.js";

const bin = fileURLToPath(new URL("./export-cli.js", import.meta.url));
const HOST_VARS = /^(RETRACE_|ORCA_|CLAUDE_CODE_SESSION_ID$|GROK_SESSION_ID$)/;
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !HOST_VARS.test(k))) as Record<string, string>;

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
    await appendEvent(store, withheld);
    const bundle = await buildExportBundle(store, { project: "projectB" }, {
      signingKey: issuer.privateKey,
      producers: [{ kid: await keyId(producer.publicKey), public_key: producer.publicKey }],
    });
    const bundleFile = join(root, "bundle.json");
    const issuerPub = join(root, "issuer-pub.json");
    writeFileSync(bundleFile, JSON.stringify(bundle));
    writeFileSync(issuerPub, JSON.stringify(issuer.publicKey));

    const verifyFrom = (cwd: string) =>
      spawnSync(process.execPath, [bin, "verify", bundleFile, "--pubkey", issuerPub], { encoding: "utf8", env: baseEnv, cwd });

    const fromA = verifyFrom(repoA);
    assert.match(fromA.stdout, /producer sigs: 0 verified · 1 INVALID/, fromA.stdout + fromA.stderr);
    const fromB = verifyFrom(repoB);
    assert.match(fromB.stdout, /producer sigs: 1 verified · 0 INVALID/, fromB.stdout + fromB.stderr);
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
