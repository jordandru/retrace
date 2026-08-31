import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, createSign, generateKeyPairSync } from "node:crypto";
import {
  generateSigningKey, appendEvent, EventStore, Event, EventInput, Share,
  ed25519SpkiPem, witnessCheckpointRekor, runCheckpointCron, CheckpointLogStore, CheckpointLogRow, PortableFetch, checkpointFromStore,
} from "./index.js";

class MemStore implements EventStore {
  events: Event[] = []; shares = new Map<string, Share>();
  async head(p: string) { const e = this.events.filter((x) => x.project === p).at(-1); return e ? { seq: e.seq, hash: e.hash } : null; }
  async insert(e: Event) { this.events.push(e); }
  async byIdempotencyKey() { return null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(p: string) { return this.events.filter((e) => e.project === p); }
  async projects() { return [...new Set(this.events.map((e) => e.project))]; }
  async history() { return this.events; }
  async createShare(s: Share) { this.shares.set(s.id, s); }
  async getShare(id: string) { return this.shares.get(id) ?? null; }
}

class MemLog implements CheckpointLogStore {
  rows: CheckpointLogRow[] = [];
  async latest(p: string) { const r = [...this.rows].reverse().find((x) => x.project === p); return r ? { seq: r.seq, head_hash: r.head_hash } : null; }
  async save(row: CheckpointLogRow) { this.rows.push(row); }
}

function fakeRekor(failWith?: number) {
  let logIndex = 5000; let calls = 0;
  const fetchImpl: PortableFetch = async (_url, init) => {
    calls++;
    if (failWith) return { ok: false, status: failWith, text: async () => "boom" };
    const body = Buffer.from(init!.body!).toString("base64");
    const e = { body, integratedTime: 1_790_000_100, logID: "fake", logIndex: ++logIndex, verification: { signedEntryTimestamp: "c2V0" } };
    return { ok: true, status: 201, text: async () => JSON.stringify({ ["uuid" + e.logIndex]: e }) };
  };
  return { fetchImpl, calls: () => calls };
}

const ev = (p: string, over: Partial<EventInput> = {}): EventInput => ({ project: p, actor: { type: "agent", id: "claude" }, action: "edited", artifacts: [{ id: "a" }], ...over });

test("ed25519SpkiPem is byte-identical to node:crypto's spki/pem export", async () => {
  for (let i = 0; i < 3; i++) {
    const kp = generateKeyPairSync("ed25519");
    const jwk = kp.publicKey.export({ format: "jwk" }) as JsonWebKey;
    const nodePem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
    assert.equal(ed25519SpkiPem(jwk), nodePem);
  }
  assert.throws(() => ed25519SpkiPem({ kty: "EC" } as JsonWebKey), /Ed25519/);
});

test("witnessCheckpointRekor: signs the artifact so a real Ed25519 verifier accepts it; refuses wrong keys and unsigned checkpoints", async () => {
  const store = new MemStore();
  await appendEvent(store, ev("p"));
  const signer = await generateSigningKey();
  const cp = await checkpointFromStore(store, "p", { signingKey: signer.privateKey });
  let submitted: any;
  const fetchImpl: PortableFetch = async (_u, init) => {
    submitted = JSON.parse(init!.body!);
    const e = { body: "Ym9keQ==", integratedTime: 1, logID: "l", logIndex: 9, verification: { signedEntryTimestamp: "c2V0" } };
    return { ok: true, status: 201, text: async () => JSON.stringify({ u: e }) };
  };
  const rec = await witnessCheckpointRekor(cp, signer.privateKey, { fetchImpl });
  assert.equal(rec.log_index, 9);
  // The submitted signature must verify over the submitted content with the submitted PEM — like Rekor does server-side.
  const artifact = Buffer.from(submitted.spec.data.content, "base64");
  const pem = Buffer.from(submitted.spec.signature.publicKey.content, "base64").toString();
  const { verify } = await import("node:crypto");
  assert.equal(verify(null, artifact, createPublicKey(pem), Buffer.from(submitted.spec.signature.content, "base64")), true);

  const stranger = await generateSigningKey();
  await assert.rejects(() => witnessCheckpointRekor(cp, stranger.privateKey, { fetchImpl }), /does not match/);
  const unsigned = await checkpointFromStore(store, "p", {});
  await assert.rejects(() => witnessCheckpointRekor(unsigned, signer.privateKey, { fetchImpl }), /unsigned/);
});

test("runCheckpointCron: checkpoints moved heads only, records Rekor failures without losing the checkpoint, and is idempotent", async () => {
  const store = new MemStore();
  await appendEvent(store, ev("alpha"));
  await appendEvent(store, ev("alpha"));
  await appendEvent(store, ev("beta"));
  const signer = await generateSigningKey();
  const log = new MemLog();
  const rekor = fakeRekor();

  const r1 = await runCheckpointCron(store, log, { signingKey: signer.privateKey, fetchImpl: rekor.fetchImpl, signerName: "cron" });
  assert.deepEqual(r1.map((r) => [r.project, r.action, r.witness]), [["alpha", "checkpointed", "ok"], ["beta", "checkpointed", "ok"]]);
  assert.equal(log.rows.length, 2);
  const alpha = log.rows.find((r) => r.project === "alpha")!;
  assert.equal(alpha.seq, 1);
  assert.equal(JSON.parse(alpha.checkpoint).signer.kid, signer.kid);
  assert.equal(JSON.parse(alpha.witness!).kind, "rekor");

  // nothing moved → nothing written, no Rekor calls
  const before = rekor.calls();
  const r2 = await runCheckpointCron(store, log, { signingKey: signer.privateKey, fetchImpl: rekor.fetchImpl });
  assert.deepEqual(r2.map((r) => r.action), ["unchanged", "unchanged"]);
  assert.equal(log.rows.length, 2);
  assert.equal(rekor.calls(), before);

  // alpha moves; Rekor is down → checkpoint still saved, error recorded
  await appendEvent(store, ev("alpha"));
  const down = fakeRekor(503);
  const r3 = await runCheckpointCron(store, log, { signingKey: signer.privateKey, fetchImpl: down.fetchImpl });
  const a3 = r3.find((r) => r.project === "alpha")!;
  assert.equal(a3.action, "checkpointed");
  assert.match(a3.witness!, /^failed: Rekor 503/);
  const row3 = log.rows.at(-1)!;
  assert.equal(row3.witness, null);
  assert.match(row3.witness_error!, /Rekor 503/);
  assert.equal(JSON.parse(row3.checkpoint).seq, 2, "the checkpoint survives a witness outage");
});
