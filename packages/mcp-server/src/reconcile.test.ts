import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKey, appendEvent, buildExportBundle, EventStore, Event, Share, EventInput } from "@retrace-dev/core";
import { parseNameStatus, verifiedExportEvents } from "./reconcile.js";

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
const ev = (): EventInput => ({ project: "p", actor: { type: "agent", id: "claude-code" }, action: "edited", artifacts: [{ id: "repo:p#a.ts" }] });

test("parseNameStatus: modify, add, delete, rename with source", () => {
  assert.deepEqual(parseNameStatus("M\ta.ts\nA\tb.ts\nD\tc.ts\nR095\told.ts\tnew.ts\nC100\tsrc.ts\tdst.ts\n"), [
    { path: "a.ts", status: "M" }, { path: "b.ts", status: "A" }, { path: "c.ts", status: "D" }, { path: "new.ts", status: "R", from: "old.ts" }, { path: "dst.ts", status: "C", from: "src.ts" },
  ]);
});

test("verifiedExportEvents fails closed: no trusted key, wrong key, tampered events, self-attested; passes only a valid signed full export", async () => {
  const store = new MemStore();
  await appendEvent(store, ev()); await appendEvent(store, ev());
  const issuer = await generateSigningKey();
  const bundle = await buildExportBundle(store, { project: "p" }, { signingKey: issuer.privateKey, issuerName: "test" });
  const flag = JSON.stringify(issuer.publicKey);
  const good = await verifiedExportEvents(bundle, flag);
  assert.equal(good.events.length, 2);
  assert.match(good.note, /verified against --pubkey/);
  const saved = process.env.RETRACE_PUBKEY; delete process.env.RETRACE_PUBKEY;
  try {
    await assert.rejects(() => verifiedExportEvents(bundle, undefined, "http://plain.example"), /no trusted issuer key/);
    await assert.rejects(() => verifiedExportEvents(bundle, undefined, ""), /no trusted issuer key/);
  } finally { if (saved !== undefined) process.env.RETRACE_PUBKEY = saved; }
  const stranger = await generateSigningKey();
  await assert.rejects(() => verifiedExportEvents(bundle, JSON.stringify(stranger.publicKey)), /does not verify/);
  const tampered = { ...bundle, events: [{ ...bundle.events[0], actor: { type: "agent" as const, id: "codex" } }, bundle.events[1]] };
  await assert.rejects(() => verifiedExportEvents(tampered, flag), /does not verify/);
  const unsigned = await buildExportBundle(store, { project: "p" }, {});
  await assert.rejects(() => verifiedExportEvents(unsigned, flag), /does not verify/);
});
