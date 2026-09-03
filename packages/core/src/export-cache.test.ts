import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendEvent, buildExportBundle, createHandler, generateSigningKey, verifyExportBundle,
  refreshExportCache, exportBuilder, CachedExport, ExportCacheStore,
  EventStore, Event, EventInput, Share, pageHistoryNewest,
} from "./index.js";

class MemStore implements EventStore {
  events: Event[] = []; shares = new Map<string, Share>();
  async head(p: string) { const e = this.events.filter((x) => x.project === p).at(-1); return e ? { seq: e.seq, hash: e.hash } : null; }
  async insert(e: Event) { this.events.push(e); }
  async byIdempotencyKey() { return null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(p: string) { return this.events.filter((e) => e.project === p); }
  async projects() { return [...new Set(this.events.map((e) => e.project))]; }
  async history(q: Parameters<EventStore["history"]>[0]) { return pageHistoryNewest(this.events.filter((e) => e.project === q.project), q); }
  async createShare(s: Share) { this.shares.set(s.id, s); }
  async getShare(id: string) { return this.shares.get(id) ?? null; }
}

class MemCache implements ExportCacheStore {
  entries = new Map<string, CachedExport>();
  async get(p: string) { return this.entries.get(p) ?? null; }
  async put(e: CachedExport) { this.entries.set(e.project, e); }
}

const ev = (p: string, over: Partial<EventInput> = {}): EventInput => ({ project: p, actor: { type: "agent", id: "claude" }, action: "edited", artifacts: [{ id: "a" }], ...over });

test("refreshExportCache: builds only for missing/moved heads, records the bundle's own claim, isolates failures", async () => {
  const store = new MemStore();
  await appendEvent(store, ev("alpha"));
  await appendEvent(store, ev("alpha"));
  await appendEvent(store, ev("beta"));
  const key = await generateSigningKey();
  const cache = new MemCache();
  let builds = 0;
  const build = (project: string) => { builds++; return buildExportBundle(store, { project }, { signingKey: key.privateKey }); };

  const r1 = await refreshExportCache(store, cache, ["alpha", "beta", "ghost"], build);
  assert.deepEqual(r1.map((r) => [r.project, r.action]), [["alpha", "refreshed"], ["beta", "refreshed"], ["ghost", "skipped"]]);
  assert.equal(builds, 2);
  const alpha = cache.entries.get("alpha")!;
  assert.equal(alpha.head_seq, 1);
  const stored = JSON.parse(alpha.bundle_json);
  assert.equal(stored.chain.head_hash, alpha.head_hash);
  // the stored JSON is a real, verifiable signed export
  assert.equal((await verifyExportBundle(stored, key.publicKey)).signature, "valid");

  // nothing moved → no builds
  const r2 = await refreshExportCache(store, cache, ["alpha", "beta"], build);
  assert.deepEqual(r2.map((r) => r.action), ["unchanged", "unchanged"]);
  assert.equal(builds, 2);

  // alpha moves → only alpha rebuilds; a build failure on one project doesn't block others
  await appendEvent(store, ev("alpha"));
  await appendEvent(store, ev("beta"));
  const flaky = (project: string) => (project === "alpha" ? Promise.reject(new Error("boom")) : build(project));
  const r3 = await refreshExportCache(store, cache, ["alpha", "beta"], flaky);
  assert.deepEqual(r3.map((r) => [r.project, r.action]), [["alpha", "failed"], ["beta", "refreshed"]]);
  assert.match(r3[0].error!, /boom/);
  assert.equal(cache.entries.get("alpha")!.head_seq, 1, "failed refresh leaves the previous entry intact");
});

test("router: full export serves cached bytes (hit), labels stale, and ?fresh=1 / scoped exports build live", async () => {
  const store = new MemStore();
  await appendEvent(store, ev("p"));
  await appendEvent(store, ev("p", { artifacts: [{ id: "b" }] }));
  const key = await generateSigningKey();
  const cache = new MemCache();
  await refreshExportCache(store, cache, ["p"], exportBuilder(store, { signingKey: key.privateKey }));
  const cachedJson = cache.entries.get("p")!.bundle_json;

  const token = "owner-token-owner-token-owner-ok";
  const handle = createHandler(store, { token, signingKey: key.privateKey, exportCache: cache });
  const get = (path: string) => handle(new Request(`http://x${path}`, { headers: { authorization: `Bearer ${token}` } }));

  const hit = await get("/projects/p/export");
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get("x-retrace-export-cache"), "hit");
  assert.equal(await hit.text(), cachedJson, "exact stored bytes are served");

  // fresh=1 bypasses the cache: a live rebuild has a different generated_at
  const fresh = await get("/projects/p/export?fresh=1");
  assert.equal(fresh.headers.get("x-retrace-export-cache"), null);
  const freshBundle = JSON.parse(await fresh.text());
  assert.equal(freshBundle.chain.total_events, 2);

  // scoped exports never touch the cache
  const scoped = await get("/projects/p/export?artifact_id=b");
  assert.equal(scoped.headers.get("x-retrace-export-cache"), null);
  assert.equal(JSON.parse(await scoped.text()).scope.artifact_id, "b");

  // head moves → the cached bundle is served but labeled stale, with both heads named
  await appendEvent(store, ev("p"));
  const stale = await get("/projects/p/export");
  assert.equal(stale.headers.get("x-retrace-export-cache"), "stale");
  assert.equal(stale.headers.get("x-retrace-export-cached-head"), "1");
  assert.equal(stale.headers.get("x-retrace-export-live-head"), "2");
  assert.equal(await stale.text(), cachedJson);
  const staleVerdict = await verifyExportBundle(JSON.parse(cachedJson), key.publicKey);
  assert.equal(staleVerdict.coverage.complete, true, "stale bundle stays a complete export against its own claim");

  // share route uses the cache too
  await store.createShare({ id: "sh_test000000000000000000", project: "p", created_at: new Date().toISOString() });
  const shared = await handle(new Request("http://x/s/sh_test000000000000000000/export"));
  assert.equal(shared.status, 200);
  assert.equal(shared.headers.get("x-retrace-export-cache"), "stale");
  assert.equal(await shared.text(), cachedJson);

  // no cache configured → plain live path, no headers
  const plain = createHandler(store, { token, signingKey: key.privateKey });
  const live = await plain(new Request("http://x/projects/p/export", { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(live.headers.get("x-retrace-export-cache"), null);
  assert.equal(JSON.parse(await live.text()).chain.total_events, 3);
});
