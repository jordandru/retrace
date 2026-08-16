import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKey, buildExportBundle, verifyExportBundle, EventStore, Event, Share, appendEvent, EventInput, publicFromPrivate, renderReportHtml } from "./index.js";

/** minimal in-memory store for tests */
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

test("signed export verifies; tampering or wrong key fails; artifact scope subsets", async () => {
  const store = new MemStore();
  const e0 = (await appendEvent(store, ev({ actor: { type: "human", id: "jordan" }, action: "instructed", intent: "do it" }))).event;
  await appendEvent(store, ev({ caused_by: e0.id, artifacts: [{ id: "a" }] }));
  await appendEvent(store, ev({ artifacts: [{ id: "b" }] }));
  const key = await generateSigningKey();

  const bundle = await buildExportBundle(store, { project: "p" }, { signingKey: key.privateKey, issuerName: "test" });
  assert.equal(bundle.events.length, 3);
  assert.equal(bundle.chain.ok, true);
  assert.equal(bundle.issuer?.kid, key.kid);
  const v = await verifyExportBundle(bundle);
  assert.deepEqual([v.signature, v.events_intact, v.links_consistent, v.chain_ok_at_export], ["valid", true, true, true]);
  // trusted key path
  assert.equal((await verifyExportBundle(bundle, key.publicKey)).signature, "valid");
  const other = await generateSigningKey();
  const w = await verifyExportBundle(bundle, other.publicKey);
  assert.equal(w.signature, "invalid");
  assert.ok(w.problems.some((p) => /kid does not match/.test(p)));

  // tamper an event's intent inside the bundle
  const tampered = JSON.parse(JSON.stringify(bundle));
  tampered.events[1].intent = "innocent";
  const t = await verifyExportBundle(tampered);
  assert.equal(t.signature, "invalid");
  assert.equal(t.events_intact, false);

  // drop the middle event → adjacency link broken (seq 0 → 2 not adjacent, so no link claim), signature invalid
  const dropped = JSON.parse(JSON.stringify(bundle)); dropped.events.splice(1, 1);
  assert.equal((await verifyExportBundle(dropped)).signature, "invalid");

  // artifact scope
  const scoped = await buildExportBundle(store, { project: "p", artifact_id: "a" }, { signingKey: key.privateKey });
  assert.equal(scoped.events.length, 2);
  assert.equal(scoped.chain.total_events, 3);
  assert.equal((await verifyExportBundle(scoped)).signature, "valid");

  // unsigned bundle
  const un = await buildExportBundle(store, { project: "p" });
  assert.equal((await verifyExportBundle(un)).signature, "unsigned");

  const html = renderReportHtml(bundle, v);
  assert.match(html, /Provenance report/); assert.match(html, /valid/); assert.match(html, /jordan/);
  assert.equal(publicFromPrivate(key.privateKey).d, undefined);
});
