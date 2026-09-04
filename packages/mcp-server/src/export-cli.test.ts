import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, buildExportBundle, checkpointFromBundle, generateSigningKey } from "@retrace-dev/core";
import { SqliteStore } from "./sqlite-store.js";

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
