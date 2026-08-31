import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { generateSigningKey, checkpointFromStore, EventStore, Event, Share, appendEvent, EventInput } from "@retrace-dev/core";
import { witnessCheckpoint, verifyWitness, parseWitnessLog, witnessFor, checkpointArtifact, sha256HexSync, WITNESS_FORMAT, FetchLike } from "./witness.js";

class MemStore implements EventStore {
  events: Event[] = []; shares = new Map<string, Share>();
  async head(p: string) { const e = this.events.filter((x) => x.project === p).at(-1); return e ? { seq: e.seq, hash: e.hash } : null; }
  async insert(e: Event) { this.events.push(e); }
  async byIdempotencyKey() { return null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(p: string) { return this.events.filter((e) => e.project === p); }
  async projects() { return ["p"]; }
  async history() { return this.events; }
  async createShare(s: Share) { this.shares.set(s.id, s); }
  async getShare(id: string) { return this.shares.get(id) ?? null; }
}

/** A fake Rekor: verifies nothing, but signs SETs with its own P-256 key exactly like the real one. */
function fakeRekor() {
  const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
  let logIndex = 1000;
  const canon = (v: unknown): string => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ":" + canon((v as any)[k])).join(",") + "}" : JSON.stringify(v);
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.endsWith("/api/v1/log/publicKey")) return { ok: true, status: 200, text: async () => pem };
    const entry = JSON.parse(init!.body!);
    const body = Buffer.from(JSON.stringify(entry)).toString("base64");
    const e = { body, integratedTime: 1_790_000_000, logID: "fakelog", logIndex: ++logIndex, verification: { signedEntryTimestamp: "" } };
    const s = createSign("SHA256");
    s.update(Buffer.from(canon({ body: e.body, integratedTime: e.integratedTime, logID: e.logID, logIndex: e.logIndex })));
    e.verification.signedEntryTimestamp = s.sign(kp.privateKey).toString("base64");
    return { ok: true, status: 201, text: async () => JSON.stringify({ ["uuid" + e.logIndex]: e }) };
  };
  return { fetchImpl, pem };
}

const ev = (over: Partial<EventInput> = {}): EventInput => ({ project: "p", actor: { type: "agent", id: "claude" }, action: "edited", artifacts: [{ id: "a" }], ...over });

test("witness: submit, record, verify offline; tampering with checkpoint, record or Rekor key is caught", async () => {
  const store = new MemStore();
  await appendEvent(store, ev());
  await appendEvent(store, ev());
  const signer = await generateSigningKey();
  const cp = await checkpointFromStore(store, "p", { signingKey: signer.privateKey, signerName: "test", now: new Date("2026-08-30T22:00:00Z") });
  const rekor = fakeRekor();

  const rec = await witnessCheckpoint(cp, signer.privateKey, { rekorUrl: "https://rekor.example", fetchImpl: rekor.fetchImpl });
  assert.equal(rec.format, WITNESS_FORMAT);
  assert.deepEqual(rec.checkpoint, { project: "p", seq: cp.seq, head_hash: cp.head_hash });
  assert.equal(rec.checkpoint_sha256, sha256HexSync(checkpointArtifact(cp)));
  assert.equal(rec.signer_kid, signer.kid);

  const good = await verifyWitness(rec, cp, rekor.pem);
  assert.equal(good.ok, true, good.problems.join(" | "));
  assert.match(good.note!, /witnessed by Rekor log index \d+/);

  // a different checkpoint (head moved) does not match the witness
  await appendEvent(store, ev());
  const cp2 = await checkpointFromStore(store, "p", { signingKey: signer.privateKey, now: new Date("2026-08-30T23:00:00Z") });
  const wrongCp = await verifyWitness(rec, cp2, rekor.pem);
  assert.equal(wrongCp.ok, false);
  assert.ok(wrongCp.problems.some((p) => /witness is for checkpoint sha256/.test(p)));

  // tampered record fields break the SET
  for (const mutate of [
    (r: typeof rec) => ({ ...r, log_index: r.log_index + 1 }),
    (r: typeof rec) => ({ ...r, integrated_time: r.integrated_time + 1 }),
    (r: typeof rec) => ({ ...r, body: Buffer.from(Buffer.from(r.body, "base64").toString().replace("rekord", "rekorD")).toString("base64") }),
  ]) {
    const bad = await verifyWitness(mutate(rec), cp, rekor.pem);
    assert.equal(bad.ok, false);
  }

  // wrong Rekor key
  const other = fakeRekor();
  assert.equal((await verifyWitness(rec, cp, other.pem)).ok, false);

  // body swapped wholesale to hash a different artifact: SET breaks AND the content check names it
  const swappedBody = { ...rec, body: Buffer.from(JSON.stringify({ kind: "rekord", spec: { data: { content: Buffer.from("other").toString("base64") } } })).toString("base64") };
  const sb = await verifyWitness(swappedBody, cp, rekor.pem);
  assert.equal(sb.ok, false);
  assert.ok(sb.problems.some((p) => /content is not this checkpoint|SET does not verify/.test(p)));

  // log helpers
  const log = JSON.stringify(rec) + "\n" + JSON.stringify({ ...rec, checkpoint_sha256: "00".repeat(32) }) + "\n";
  const parsed = parseWitnessLog(log);
  assert.equal(parsed.length, 2);
  assert.equal(witnessFor(parsed, cp)?.uuid, rec.uuid);
  assert.equal(witnessFor(parsed, cp2), undefined);
});

test("witness refusals: unsigned checkpoint; key that is not the signer; Rekor error surfaces", async () => {
  const store = new MemStore();
  await appendEvent(store, ev());
  const signer = await generateSigningKey();
  const stranger = await generateSigningKey();
  const rekor = fakeRekor();
  const unsigned = await checkpointFromStore(store, "p", {});
  await assert.rejects(() => witnessCheckpoint(unsigned, signer.privateKey, { fetchImpl: rekor.fetchImpl }), /unsigned checkpoint/);
  const cp = await checkpointFromStore(store, "p", { signingKey: signer.privateKey });
  await assert.rejects(() => witnessCheckpoint(cp, stranger.privateKey, { fetchImpl: rekor.fetchImpl }), /does not match the checkpoint's signer/);
  const failing: FetchLike = async () => ({ ok: false, status: 500, text: async () => "boom" });
  await assert.rejects(() => witnessCheckpoint(cp, signer.privateKey, { fetchImpl: failing }), /Rekor 500/);
});

test("verifyWitness ties the logged signer to the checkpoint signer", async () => {
  const store = new MemStore();
  await appendEvent(store, ev());
  const signer = await generateSigningKey();
  const rekor = fakeRekor();
  const cp = await checkpointFromStore(store, "p", { signingKey: signer.privateKey });
  const rec = await witnessCheckpoint(cp, signer.privateKey, { fetchImpl: rekor.fetchImpl });
  // graft a body whose embedded content+hash still match but claim a different public key
  const body = JSON.parse(Buffer.from(rec.body, "base64").toString());
  body.spec.signature = { publicKey: { content: Buffer.from("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n").toString("base64") } };
  const grafted = { ...rec, body: Buffer.from(JSON.stringify(body)).toString("base64") };
  const v = await verifyWitness(grafted, cp, rekor.pem);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /different key than the checkpoint's signer/.test(p)));
});
