import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateSigningKey, buildExportBundle, verifyExportBundle, exportVerdictOk, appendEvent,
  checkpointFromBundle, checkpointFromStore, verifyCheckpoint, compareBundleToCheckpoint, parseCheckpointLog, latestCheckpoint,
  EventStore, Event, EventInput, Share,
} from "./index.js";

class MemStore implements EventStore {
  events: Event[] = []; shares = new Map<string, Share>();
  async head(p: string) { const e = this.events.filter((x) => x.project === p).at(-1); return e ? { seq: e.seq, hash: e.hash } : null; }
  async insert(e: Event) { this.events.push(e); }
  async byIdempotencyKey(p: string, k: string) { return this.events.find((e) => e.project === p && e.idempotency_key === k) ?? null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(p: string) { return this.events.filter((e) => e.project === p).sort((a, b) => a.seq - b.seq); }
  async projects() { return [...new Set(this.events.map((e) => e.project))]; }
  async history(q: any) { return (await this.all(q.project)).filter((e) => !q.artifact_id || e.artifacts.some((a) => a.id === q.artifact_id)); }
  async createShare(s: Share) { this.shares.set(s.id, s); }
  async getShare(id: string) { return this.shares.get(id) ?? null; }
}
const ev = (over: Partial<EventInput>): EventInput => ({ project: "p", actor: { type: "agent", id: "claude" }, action: "edited", artifacts: [{ id: "a" }], ...over });

test("checkpoint: derived from a verified full export, signed, and detects tail removal and rewrites in later bundles", async () => {
  const store = new MemStore();
  const e0 = (await appendEvent(store, ev({ actor: { type: "human", id: "jordan" }, action: "instructed", intent: "do it" }))).event;
  await appendEvent(store, ev({ caused_by: e0.id }));
  await appendEvent(store, ev({ artifacts: [{ id: "b" }] }));
  const issuer = await generateSigningKey(); const signer = await generateSigningKey();
  const t0 = new Date("2026-08-30T01:00:00Z");

  const bundle = await buildExportBundle(store, { project: "p" }, { signingKey: issuer.privateKey, now: t0 });
  assert.equal(exportVerdictOk(await verifyExportBundle(bundle)), true);
  const cp = await checkpointFromBundle(bundle, { signingKey: signer.privateKey, signerName: "ci" });
  assert.deepEqual([cp.project, cp.seq, cp.total_events, cp.head_hash], ["p", 2, 3, bundle.chain.head_hash]);
  assert.equal(cp.source.kind, "export");
  assert.equal((cp.source as any).issuer_kid, issuer.kid);
  assert.equal((await verifyCheckpoint(cp)).signature, "valid");
  assert.equal((await verifyCheckpoint(cp, signer.publicKey)).signature, "valid");
  const wrong = await verifyCheckpoint(cp, issuer.publicKey);
  assert.equal(wrong.signature, "invalid");
  assert.ok(wrong.problems.some((p) => /kid does not match/.test(p)));
  const forged = { ...cp, head_hash: "00".repeat(32) };
  assert.equal((await verifyCheckpoint(forged)).signature, "invalid");

  // Same bundle → matches.
  assert.equal(compareBundleToCheckpoint(bundle, cp).relation, "matches");

  // The project grows; a later full export extends the checkpoint.
  await appendEvent(store, ev({ artifacts: [{ id: "c" }] }));
  const later = await buildExportBundle(store, { project: "p" }, { signingKey: issuer.privateKey, now: new Date("2026-08-30T02:00:00Z") });
  const ext = compareBundleToCheckpoint(later, cp);
  assert.equal(ext.relation, "extends");
  assert.equal(ext.problems.length, 0);

  // Operator drops the newest two events after the checkpoint and re-exports: every hash verifies, coverage is
  // "complete" against the shrunken claim — only the checkpoint catches it.
  const store2 = new MemStore(); store2.events = store.events.slice(0, 2);
  const shrunk = await buildExportBundle(store2, { project: "p" }, { signingKey: issuer.privateKey, now: new Date("2026-08-30T03:00:00Z") });
  const v = await verifyExportBundle(shrunk);
  assert.equal(v.coverage.complete, true);
  const c = compareBundleToCheckpoint(shrunk, cp);
  assert.equal(c.relation, "conflict");
  assert.ok(c.problems.some((p) => /removed after the checkpoint/.test(p)), c.problems.join(" | "));

  // History rewritten at the checkpointed seq (same size, different content) → conflict.
  const rewritten = JSON.parse(JSON.stringify(later)); rewritten.events[2].hash = "ab".repeat(32);
  assert.equal(compareBundleToCheckpoint(rewritten, cp).relation, "conflict");

  // A bundle generated before the checkpoint cannot be judged by it.
  const old = await buildExportBundle(store2, { project: "p" }, { signingKey: issuer.privateKey, now: new Date("2026-08-30T00:30:00Z") });
  assert.equal(compareBundleToCheckpoint(old, cp).relation, "predates");

  // Scoped bundles: contains the checkpointed seq → extends; otherwise unverifiable, unless the size claim contradicts.
  const scopedWith = await buildExportBundle(store, { project: "p", artifact_id: "b" }, { signingKey: issuer.privateKey, now: new Date("2026-08-30T02:00:00Z") });
  assert.equal(compareBundleToCheckpoint(scopedWith, cp).relation, "extends");
  const scopedWithout = await buildExportBundle(store, { project: "p", artifact_id: "c" }, { signingKey: issuer.privateKey, now: new Date("2026-08-30T02:00:00Z") });
  assert.equal(compareBundleToCheckpoint(scopedWithout, cp).relation, "unverifiable");
  const lying = JSON.parse(JSON.stringify(scopedWithout)); lying.chain.total_events = 2;
  assert.equal(compareBundleToCheckpoint(lying, cp).relation, "conflict");

  // Other project.
  assert.equal(compareBundleToCheckpoint({ ...bundle, scope: { project: "q" } }, cp).relation, "other_project");

  // Refusals: scoped bundle, or a bundle whose last event is not its claimed head.
  await assert.rejects(() => checkpointFromBundle(scopedWith), /full export/);
  const cut = JSON.parse(JSON.stringify(later)); cut.events.pop();
  await assert.rejects(() => checkpointFromBundle(cut), /does not match its claimed head/);

  // Store-derived checkpoint and the JSON-lines log helpers.
  const fromStore = await checkpointFromStore(store, "p", { signingKey: signer.privateKey, now: new Date("2026-08-30T04:00:00Z") });
  assert.deepEqual([fromStore.seq, fromStore.total_events, fromStore.source.kind], [3, 4, "store"]);
  const log = [cp, fromStore, { ...cp, project: "q" }].map((c) => JSON.stringify(c)).join("\n") + "\n";
  const parsed = parseCheckpointLog(log);
  assert.equal(parsed.length, 3);
  assert.equal(latestCheckpoint(parsed, "p")?.seq, 3);
  assert.equal(latestCheckpoint(parsed, "q")?.seq, 2);
  assert.equal(latestCheckpoint(parsed, "zzz"), undefined);
});
