import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKey, signCanonical, verifyCanonical, buildExportBundle, verifyExportBundle, exportVerdictOk, EventStore, Event, Share, appendEvent, EventInput, publicFromPrivate, renderReportHtml, pageHistoryNewest } from "./index.js";

/** minimal in-memory store for tests */
class MemStore implements EventStore {
  events: Event[] = []; shares = new Map<string, Share>();
  async head(p: string) { const e = this.events.filter((x) => x.project === p).at(-1); return e ? { seq: e.seq, hash: e.hash } : null; }
  async insert(e: Event) { this.events.push(e); }
  async byIdempotencyKey(p: string, k: string) { return this.events.find((e) => e.project === p && e.idempotency_key === k) ?? null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(p: string) { return this.events.filter((e) => e.project === p).sort((a, b) => a.seq - b.seq); }
  async projects() { return [...new Set(this.events.map((e) => e.project))]; }
  async history(q: any) { return pageHistoryNewest(this.events, q); }
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
  // No trusted key: the signature only proves internal consistency → self-attested, and it does NOT pass exportVerdictOk.
  const sa = await verifyExportBundle(bundle);
  assert.deepEqual([sa.signature, sa.events_intact, sa.links_consistent, sa.chain_ok_at_export], ["self_attested", true, true, true]);
  assert.equal(exportVerdictOk(sa), false, "a self-attested bundle is not VALID");
  assert.ok(sa.problems.some((p) => /embedded in the bundle/.test(p)));
  // re-signed by an impostor with a fresh key: internally consistent, still only self-attested; fails against the real key
  const impostor = await generateSigningKey();
  const forged = await buildExportBundle(store, { project: "p" }, { signingKey: impostor.privateKey, issuerName: "test" });
  assert.equal((await verifyExportBundle(forged)).signature, "self_attested");
  assert.equal((await verifyExportBundle(forged, key.publicKey)).signature, "invalid");
  // trusted key path
  const v = await verifyExportBundle(bundle, key.publicKey);
  assert.deepEqual([v.signature, v.events_intact, v.links_consistent, v.chain_ok_at_export, v.legacy_hash_events], ["valid", true, true, true, 0]);
  assert.equal(exportVerdictOk(v), true);
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
  assert.equal((await verifyExportBundle(scoped, key.publicKey)).signature, "valid");

  // unsigned bundle
  const un = await buildExportBundle(store, { project: "p" });
  assert.equal((await verifyExportBundle(un)).signature, "unsigned");

  const html = renderReportHtml(bundle, v);
  assert.match(html, /Provenance report/); assert.match(html, /valid/); assert.match(html, /jordan/);
  assert.equal(publicFromPrivate(key.privateKey).d, undefined);
});

test("coverage: a full export must carry every claimed event — tail truncation, dropped middle, and head mismatch are reported", async () => {
  const store = new MemStore();
  const e0 = (await appendEvent(store, ev({ actor: { type: "human", id: "jordan" }, action: "instructed", intent: "do it" }))).event;
  await appendEvent(store, ev({ caused_by: e0.id, artifacts: [{ id: "a" }] }));
  await appendEvent(store, ev({ artifacts: [{ id: "b" }] }));
  await appendEvent(store, ev({ artifacts: [{ id: "c" }] }));
  const key = await generateSigningKey();
  const bundle = await buildExportBundle(store, { project: "p" }, { signingKey: key.privateKey });

  const full = await verifyExportBundle(bundle, key.publicKey);
  assert.equal(full.coverage.scope, "full");
  assert.equal(full.coverage.complete, true);
  assert.equal(full.coverage.head_hash_matches, true);
  assert.deepEqual([full.coverage.events, full.coverage.total_events], [4, 4]);
  assert.equal(exportVerdictOk(full), true);

  // Truncate the tail: the chain still "verifies" (every present event links), only coverage catches it.
  const tail = JSON.parse(JSON.stringify(bundle)); tail.events.splice(3, 1);
  const t = await verifyExportBundle(tail);
  assert.equal(t.events_intact, true);
  assert.equal(t.links_consistent, true);
  assert.equal(t.coverage.complete, false);
  assert.equal(t.coverage.head_hash_matches, false);
  assert.deepEqual(t.coverage.missing_seqs, [3]);
  assert.ok(t.problems.some((p) => /tail .*missing/.test(p)), t.problems.join(" | "));
  assert.equal(exportVerdictOk(t), false);

  // Drop a middle event: seq 1 missing.
  const mid = JSON.parse(JSON.stringify(bundle)); mid.events.splice(1, 1);
  const m = await verifyExportBundle(mid);
  assert.equal(m.coverage.complete, false);
  assert.deepEqual(m.coverage.missing_seqs, [1]);
  assert.ok(m.problems.some((p) => /missing seq 1/.test(p)));

  // Unsigned bundle with a rewritten total_events: the self-consistency checks still fire.
  const un = await buildExportBundle(store, { project: "p" });
  const lie = JSON.parse(JSON.stringify(un)); lie.chain.total_events = 3;
  const l = await verifyExportBundle(lie);
  assert.equal(l.coverage.complete, false);
  assert.ok(l.problems.some((p) => /outside the 3 events claimed/.test(p)));

  // Duplicate seq is reported.
  const dup = JSON.parse(JSON.stringify(un)); dup.events.push(dup.events[2]);
  assert.ok((await verifyExportBundle(dup)).problems.some((p) => /#2 appears more than once/.test(p)));

  // A bundle with no head_hash cannot be anchored.
  const noHead = JSON.parse(JSON.stringify(un)); delete noHead.chain.head_hash;
  const h = await verifyExportBundle(noHead);
  assert.equal(h.coverage.complete, false);
  assert.ok(h.problems.some((p) => /head_hash/.test(p)));

  // Scoped export: omission is not claimable; complete stays undefined and the note says why; ok does not fail on it.
  const scoped = await buildExportBundle(store, { project: "p", artifact_id: "a" }, { signingKey: key.privateKey });
  const s = await verifyExportBundle(scoped, key.publicKey);
  assert.equal(s.coverage.scope, "scoped");
  assert.equal(s.coverage.complete, undefined);
  assert.match(s.coverage.note, /cannot be verified offline/);
  assert.equal(exportVerdictOk(s), true);
  // …but a scoped bundle whose events exceed the claimed project size is still inconsistent.
  const badScoped = JSON.parse(JSON.stringify(scoped)); badScoped.chain.total_events = 1;
  assert.ok((await verifyExportBundle(badScoped)).problems.some((p) => /outside the 1 events claimed/.test(p)));

  // The report and CLI summaries surface coverage.
  assert.match(renderReportHtml(bundle, full), /Coverage/);
});

test("signing: JWKs carrying alg Ed25519 or EdDSA both sign and verify (alg is stripped before import)", async () => {
  const key = await generateSigningKey();
  for (const alg of ["Ed25519", "EdDSA", undefined]) {
    const priv = { ...key.privateKey, alg } as JsonWebKey; const pub = { ...key.publicKey, alg } as JsonWebKey;
    const sig = await signCanonical(priv, { a: 1 });
    assert.equal(await verifyCanonical(pub, { a: 1 }, sig), true);
    assert.equal(await verifyCanonical(pub, { a: 2 }, sig), false);
  }
});
