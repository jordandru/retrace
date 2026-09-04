import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventInput, generateSigningKey, publicFromPrivate, verifyProducerSig } from "@retrace-dev/core";
import { keyPath } from "./keys.js";
import {
  defaultProducerKeyPath, ensureProducerKey, isExportIssuerKeyPath,
  loadProducerPrivateKey, producerKeySlug, resetProducerSigSchemaCheck, sealForAppend, writeProducerPrivateKey,
} from "./producer-key.js";

const sample: EventInput = {
  project: "p",
  actor: { type: "agent", id: "cursor-agent", on_behalf_of: "jordan@example.com" },
  action: "edited",
  artifacts: [{ id: "repo:p#a.ts", role: "generated" }],
  intent: "sign me",
};

test("producerKeySlug is filesystem-safe", () => {
  assert.equal(producerKeySlug("claude-code-alice@acme.dev"), "claude-code-alice-acme.dev");
  assert.equal(producerKeySlug("retrace-git-acme-app"), "retrace-git-acme-app");
});

test("ensureProducerKey writes 0600 under 0700 and never the export issuer file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-producer-key-"));
  const path = join(dir, "agent.jwk");
  const k = await ensureProducerKey(path);
  assert.equal(k.created, true);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(typeof k.kid, "string");
  assert.equal("d" in k.publicKey, false);
  const again = await ensureProducerKey(path);
  assert.equal(again.created, false);
  assert.equal(again.kid, k.kid);
  assert.equal(isExportIssuerKeyPath(keyPath()), true);
  await assert.rejects(() => ensureProducerKey(keyPath()), /export issuer key/);
});

test("writeProducerPrivateKey refuses to overwrite an existing private key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-producer-no-overwrite-"));
  const path = join(dir, "agent.jwk");
  const first = await generateSigningKey();
  const second = await generateSigningKey();
  writeProducerPrivateKey(path, first.privateKey);
  const original = readFileSync(path, "utf8");
  assert.throws(() => writeProducerPrivateKey(path, second.privateKey), /refusing to overwrite existing producer key/);
  assert.equal(readFileSync(path, "utf8"), original);
});

test("loadProducerPrivateKey prefers FILE over inline KEY; missing both is unsigned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-producer-load-"));
  const path = join(dir, "k.jwk");
  const kp = await generateSigningKey();
  writeProducerPrivateKey(path, kp.privateKey);
  assert.equal(loadProducerPrivateKey({}), null);
  const fromFile = loadProducerPrivateKey({ RETRACE_PRODUCER_KEY_FILE: path });
  assert.equal(fromFile?.d, kp.privateKey.d);
  const other = await generateSigningKey();
  const fromInline = loadProducerPrivateKey({ RETRACE_PRODUCER_KEY: JSON.stringify(other.privateKey) });
  assert.equal(fromInline?.d, other.privateKey.d);
  const fileWins = loadProducerPrivateKey({ RETRACE_PRODUCER_KEY_FILE: path, RETRACE_PRODUCER_KEY: JSON.stringify(other.privateKey) });
  assert.equal(fileWins?.d, kp.privateKey.d);
});

test("sealForAppend is a no-op without a key; with a key it fills timestamp/idempotency and verifies", async () => {
  const unsigned = await sealForAppend(sample, { privateKey: null });
  assert.equal(unsigned.producer_sig, undefined);
  const kp = await generateSigningKey();
  const signed = await sealForAppend(sample, { privateKey: kp.privateKey });
  assert.ok(signed.timestamp);
  assert.ok(signed.idempotency_key);
  assert.ok(signed.producer_sig?.sig);
  assert.equal(await verifyProducerSig(signed, publicFromPrivate(kp.privateKey)), true);
});

test("sealForAppend refuses a remote whose GET /api schema lacks producer_sig", async () => {
  resetProducerSigSchemaCheck();
  const kp = await generateSigningKey();
  const fetchApi = (async () => ({ ok: true, json: async () => ({ schema: { event: ["id", "hash"] } }) })) as unknown as typeof fetch;
  await assert.rejects(
    () => sealForAppend(sample, { privateKey: kp.privateKey, remoteUrl: "https://old.example.workers.dev", fetchApi }),
    /event.producer_sig/,
  );
  resetProducerSigSchemaCheck();
  const okFetch = (async () => ({ ok: true, json: async () => ({ schema: { event: ["producer_sig"] } }) })) as unknown as typeof fetch;
  const signed = await sealForAppend(sample, { privateKey: kp.privateKey, remoteUrl: "https://new.example.workers.dev", fetchApi: okFetch });
  assert.ok(signed.producer_sig);
});

test("defaultProducerKeyPath is under producer-keys, not signing-key.json", () => {
  const p = defaultProducerKeyPath("claude-code", { RETRACE_PRODUCER_KEYS_DIR: "/tmp/keys" });
  assert.equal(p, join("/tmp/keys", "claude-code.jwk"));
  assert.equal(isExportIssuerKeyPath(p), false);
});
