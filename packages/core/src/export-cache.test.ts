import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, sign as nodeSign } from "node:crypto";
import {
  appendEvent, buildExportBundle, createHandler, generateSigningKey, verifyExportBundle,
  refreshExportCache, refreshExportCacheStream, exportBuilder, CachedExport, CachedExportMeta, ExportCacheStore, TornExportCacheError,
  EventStore, Event, EventInput, Share, pageHistoryNewest, verifyCanonical, MemoryEventStore, publicFromPrivate,
} from "./index.js";
import type { ExportByteSink, ExportSigner, RefreshResult } from "./index.js";

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
  let historyReads = 0;
  const history = store.history.bind(store);
  store.history = async (query) => {
    historyReads++;
    return history(query);
  };

  const token = "owner-token-owner-token-owner-ok";
  const handle = createHandler(store, { token, signingKey: key.privateKey, exportCache: cache });
  const get = (path: string) => handle(new Request(`http://x${path}`, { headers: { authorization: `Bearer ${token}` } }));

  const hit = await get("/projects/p/export");
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get("x-retrace-export-cache"), "hit");
  assert.equal(await hit.text(), cachedJson, "exact stored bytes are served");
  assert.equal(historyReads, 0, "a cache hit adds no history read");

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
  const historyReadsBeforeStale = historyReads;
  const stale = await get("/projects/p/export");
  assert.equal(stale.headers.get("x-retrace-export-cache"), "stale");
  assert.equal(stale.headers.get("x-retrace-export-cached-head"), "1");
  assert.equal(stale.headers.get("x-retrace-export-live-head"), "2");
  assert.equal(await stale.text(), cachedJson);
  assert.equal(historyReads, historyReadsBeforeStale + 1, "a stale entry is checked against the live chain once");
  const staleVerdict = await verifyExportBundle(JSON.parse(cachedJson), key.publicKey);
  assert.equal(staleVerdict.coverage.complete, true, "stale bundle stays a complete export against its own claim");

  // cache-only clients get an explicit miss; ordinary exports preserve the live fallback
  const savedEntry = cache.entries.get("p")!;
  cache.entries.delete("p");
  const miss = await get("/projects/p/export?cached=1");
  assert.equal(miss.status, 404);
  assert.equal(miss.headers.get("x-retrace-export-cache"), "miss");
  const ordinary = await get("/projects/p/export");
  assert.equal(ordinary.status, 200);
  assert.equal(JSON.parse(await ordinary.text()).chain.total_events, 3);
  const liveAfterMiss = await get("/projects/p/export?fresh=1");
  assert.equal(liveAfterMiss.status, 200);
  assert.equal(JSON.parse(await liveAfterMiss.text()).chain.total_events, 3);
  cache.entries.set("p", savedEntry);

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

  const unavailable = await plain(new Request("http://x/projects/p/export?cached=1", { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(unavailable.status, 503);
  assert.match((await unavailable.json()).error, /not configured/);

  const brokenCache: ExportCacheStore = {
    async get() { throw new Error("backend unavailable"); },
    async put() {},
  };
  const broken = createHandler(store, { token, signingKey: key.privateKey, exportCache: brokenCache });
  const failedRead = await broken(new Request("http://x/projects/p/export?cached=1&token=" + encodeURIComponent(token)));
  assert.equal(failedRead.status, 503);
  assert.equal(failedRead.headers.get("x-retrace-export-cache"), null);
  assert.match((await failedRead.json()).error, /backend unavailable/);
  const ordinaryAfterFailure = await broken(new Request("http://x/projects/p/export?token=" + encodeURIComponent(token)));
  assert.equal(ordinaryAfterFailure.status, 200);
  assert.equal(JSON.parse(await ordinaryAfterFailure.text()).chain.total_events, 3);

  const tornCache: ExportCacheStore = {
    async get() { throw new TornExportCacheError("p"); },
    async put() {},
  };
  const torn = createHandler(store, { token, signingKey: key.privateKey, exportCache: tornCache });
  const tornRead = await torn(new Request("http://x/projects/p/export?cached=1&token=" + encodeURIComponent(token)));
  assert.equal(tornRead.status, 503);
  assert.match((await tornRead.json()).error, /torn \(inconsistent chunks\)/);
  const ordinaryAfterTorn = await torn(new Request("http://x/projects/p/export?token=" + encodeURIComponent(token)));
  assert.equal(ordinaryAfterTorn.status, 200);
  assert.equal(JSON.parse(await ordinaryAfterTorn.text()).chain.total_events, 3);

  cache.entries.set("p", { ...savedEntry, head_hash: "f".repeat(64) });
  const notPrefixOnly = await get("/projects/p/export?cached=1");
  assert.equal(notPrefixOnly.status, 503);
  assert.equal(notPrefixOnly.headers.get("x-retrace-export-cache"), "stale");
  assert.match((await notPrefixOnly.json()).error, /not a prefix of the live ledger/);
  const notPrefixFallback = await get("/projects/p/export");
  assert.equal(notPrefixFallback.status, 200);
  assert.equal(notPrefixFallback.headers.get("x-retrace-export-cache"), null);
  assert.equal(JSON.parse(await notPrefixFallback.text()).chain.total_events, 3);
  cache.entries.set("p", savedEntry);

  cache.entries.set("ghost", {
    project: "ghost",
    head_seq: 0,
    head_hash: "a".repeat(64),
    generated_at: "2026-09-07T00:00:00.000Z",
    bundle_json: "{\"must\":\"not be served or rebuilt\"}",
  });
  let liveBuilds = 0;
  const counting: EventStore = Object.create(store, {
    all: { value: async (project: string) => { liveBuilds++; return store.all(project); } },
  });
  const noHead = createHandler(counting, { token, signingKey: key.privateKey, exportCache: cache });
  const cachedNoHead = await noHead(new Request("http://x/projects/ghost/export?cached=1&token=" + encodeURIComponent(token)));
  assert.equal(cachedNoHead.status, 404);
  assert.equal(cachedNoHead.headers.get("x-retrace-export-cache"), "miss");
  assert.match((await cachedNoHead.json()).error, /no live head/);
  assert.equal(liveBuilds, 0, "cached=1 with no live head must not fall through to a live build");
});

test("router: signed head uses the export issuer key while plain head stays unchanged", async () => {
  const store = new MemStore();
  await appendEvent(store, ev("p"));
  const key = await generateSigningKey();
  const token = "owner-token-owner-token-owner-ok";
  const handle = createHandler(store, { token, signingKey: key.privateKey });
  const plain = await handle(new Request("http://x/projects/p/head?token=" + encodeURIComponent(token)));
  assert.deepEqual(await plain.json(), await store.head("p"));

  const signed = await handle(new Request("http://x/projects/p/head?signed=1&token=" + encodeURIComponent(token)));
  assert.equal(signed.status, 200);
  const body = await signed.json();
  assert.equal(body.project, "p");
  assert.equal(body.issuer.kid, key.kid);
  assert.deepEqual(body.issuer.public_key, key.publicKey);
  assert.equal(await verifyCanonical(
    key.publicKey,
    { project: body.project, seq: body.seq, hash: body.hash, signed_at: body.signed_at },
    body.signature,
  ), true);

  const unsigned = createHandler(store, { token });
  const unavailable = await unsigned(new Request("http://x/projects/p/head?signed=1&token=" + encodeURIComponent(token)));
  assert.equal(unavailable.status, 404);
  assert.match((await unavailable.json()).error, /no signing key/);

  const empty = createHandler(new MemStore(), { token, signingKey: key.privateKey });
  const emptySigned = await empty(new Request("http://x/projects/ghost/head?signed=1&token=" + encodeURIComponent(token)));
  assert.equal(emptySigned.status, 200);
  const emptyBody = await emptySigned.json();
  assert.equal(emptyBody.project, "ghost");
  assert.equal(emptyBody.seq, -1);
  assert.equal(emptyBody.hash, "0".repeat(64));
  assert.equal(await verifyCanonical(
    key.publicKey,
    { project: emptyBody.project, seq: emptyBody.seq, hash: emptyBody.hash, signed_at: emptyBody.signed_at },
    emptyBody.signature,
  ), true);
});

const sha256 = () => {
  const h = createHash("sha256");
  return { update: (b: Uint8Array) => h.update(b), digest: () => new Uint8Array(h.digest()) };
};

/** Keeps M and signs it with node:crypto's Ed25519 (RFC 8032, as WebCrypto): equal to signCanonical's signature
 *  exactly when M equals the canonical bundle. The Worker's streaming signer is tested in apps/worker. */
function referenceSigner(privateJwk: JsonWebKey): ExportSigner {
  const { alg: _alg, ...jwk } = privateJwk as JsonWebKey & { alg?: string };
  const key = createPrivateKey({ key: jwk as any, format: "jwk" });
  return {
    publicKey: publicFromPrivate(privateJwk),
    begin() {
      const one: Uint8Array[] = [];
      const two: Uint8Array[] = [];
      return {
        nonce: (c) => { one.push(c.slice()); },
        challenge: (c) => { two.push(c.slice()); },
        finish: () => {
          const m = Buffer.concat(one);
          if (!m.equals(Buffer.concat(two))) throw new Error("signature refused");
          return new Uint8Array(nodeSign(null, m, key));
        },
        dispose: () => {},
      };
    },
    dispose() {},
  };
}

/** A store that streams, as R2ExportCache does, over bytes in memory: putStream keeps the old entry unless `write`
 *  returns after exactly `bytes`; get returns a ReadableStream and counts cancellations. */
class StreamCache implements ExportCacheStore {
  entries = new Map<string, { meta: CachedExportMeta; bytes: Uint8Array }>();
  gets = 0;
  cancelled = 0;
  async meta(p: string) { return this.entries.get(p)?.meta ?? null; }
  async get(p: string) {
    this.gets++;
    const entry = this.entries.get(p);
    if (!entry) return null;
    const self = this;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(entry.bytes); c.close(); },
      cancel() { self.cancelled++; },
    });
    return { ...entry.meta, body, bytes: entry.bytes.length };
  }
  async put(e: CachedExport) {
    const { bundle_json, ...meta } = e;
    this.entries.set(e.project, { meta, bytes: new TextEncoder().encode(bundle_json) });
  }
  async putStream(meta: CachedExportMeta, bytes: number, write: (sink: ExportByteSink) => Promise<void>) {
    const chunks: Uint8Array[] = [];
    let n = 0;
    await write({ write: async (c) => { n += c.length; if (n > bytes) throw new Error("too many bytes"); chunks.push(c); } });
    if (n !== bytes) throw new Error("too few bytes");
    this.entries.set(meta.project, { meta, bytes: Buffer.concat(chunks) });
  }
}

const NOW = new Date("2026-10-13T05:07:00.000Z");

test("refreshExportCache decides through meta when the store has it, never downloading the export", async () => {
  const store = new MemStore();
  await appendEvent(store, ev("p"));
  const key = await generateSigningKey();
  const cache = new StreamCache();
  const build = exportBuilder(store, { signingKey: key.privateKey });
  assert.deepEqual((await refreshExportCache(store, cache, ["p"], build)).map((r) => r.action), ["refreshed"]);
  assert.deepEqual((await refreshExportCache(store, cache, ["p"], build)).map((r) => r.action), ["unchanged"]);
  assert.equal(cache.gets, 0, "no get: the head comparison read only metadata");
});

test("refreshExportCacheStream: started then refreshed, the bytes buildExportBundle gives, unchanged without a build, and a failed build keeps the old entry", async () => {
  const store = new MemoryEventStore();
  for (let i = 0; i < 40; i++) await appendEvent(store, ev("p", { intent: `event ${i} — é 😀` }));
  await appendEvent(store, ev("q"));
  const key = await generateSigningKey();
  const cache = new StreamCache();
  const hooks: string[] = [];
  const opts = {
    signer: referenceSigner(key.privateKey), now: NOW, sha256, pageRows: 16,
    onStart: async (p: string) => { hooks.push(`started ${p}`); },
    onResult: async (r: RefreshResult) => { hooks.push(`${r.action} ${r.project}`); },
  };

  const r1 = await refreshExportCacheStream(store, cache, ["p", "q", "ghost", "p"], opts);
  assert.deepEqual(r1.map((r) => [r.project, r.action, r.head_seq]), [["p", "refreshed", 39], ["q", "refreshed", 0], ["ghost", "skipped", undefined]]);
  assert.deepEqual(hooks, ["started p", "refreshed p", "started q", "refreshed q", "skipped ghost"]);
  const stored = cache.entries.get("p")!;
  const expected = JSON.stringify(await buildExportBundle(store, { project: "p" }, { signingKey: key.privateKey, now: NOW }));
  assert.equal(Buffer.from(stored.bytes).toString("utf8"), expected, "the stored bytes are buildExportBundle's");
  assert.deepEqual(stored.meta, { project: "p", head_seq: 39, head_hash: (await store.head("p"))!.hash, generated_at: NOW.toISOString() });
  assert.equal((await verifyExportBundle(JSON.parse(expected), key.publicKey)).signature, "valid");
  assert.equal(cache.gets, 0);

  hooks.length = 0;
  const r2 = await refreshExportCacheStream(store, cache, ["p"], opts);
  assert.deepEqual(r2.map((r) => r.action), ["unchanged"]);
  assert.deepEqual(hooks, ["unchanged p"], "no build, so no started");

  await appendEvent(store, ev("p"));
  hooks.length = 0;
  let pages = 0;
  const failing: EventStore = Object.create(store, {
    eventsPage: { value: async (...args: Parameters<NonNullable<EventStore["eventsPage"]>>) => {
      if (++pages === 7) throw new Error("D1 unavailable mid-pass");
      return store.eventsPage(...args);
    } },
  });
  const r3 = await refreshExportCacheStream(failing, cache, ["p"], opts);
  assert.deepEqual(r3.map((r) => [r.action, r.error]), [["failed", "D1 unavailable mid-pass"]]);
  assert.deepEqual(hooks, ["started p", "failed p"]);
  assert.equal(cache.entries.get("p"), stored, "the old entry stays");

  const noStream: ExportCacheStore = { get: async () => null, put: async () => {} };
  const r4 = await refreshExportCacheStream(store, noStream, ["p"], { ...opts, onStart: undefined, onResult: undefined });
  assert.deepEqual(r4.map((r) => [r.action, r.error]), [["failed", "export cache store cannot write a stream"]]);
});

test("router: a streamed cache entry is served as a stream with Content-Length; paths that do not serve it cancel it", async () => {
  const store = new MemoryEventStore();
  await appendEvent(store, ev("p", { intent: "dash — and 😀" }));
  await appendEvent(store, ev("p"));
  const key = await generateSigningKey();
  const cache = new StreamCache();
  assert.deepEqual((await refreshExportCacheStream(store, cache, ["p"], { signer: referenceSigner(key.privateKey), now: NOW, sha256 })).map((r) => r.action), ["refreshed"]);
  const stored = cache.entries.get("p")!;
  const token = "owner-token-owner-token-owner-ok";
  const handle = createHandler(store, { token, signingKey: key.privateKey, exportCache: cache });
  const get = (path: string) => handle(new Request(`http://x${path}`, { headers: { authorization: `Bearer ${token}` } }));

  for (const path of ["/projects/p/export", "/projects/p/export?cached=1"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.equal(res.headers.get("content-length"), String(stored.bytes.length), `${path}: Content-Length is the stored size`);
    assert.equal(res.headers.get("x-retrace-export-cache"), "hit");
    assert.equal(res.headers.get("x-retrace-export-generated-at"), NOW.toISOString());
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(stored.bytes)), `${path}: the stored bytes`);
  }
  await store.createShare({ id: "sh_stream00000000000000000", project: "p", created_at: new Date().toISOString() });
  const shared = await handle(new Request("http://x/s/sh_stream00000000000000000/export"));
  assert.equal(shared.status, 200);
  assert.equal(shared.headers.get("content-length"), String(stored.bytes.length));
  assert.equal(shared.headers.get("cache-control"), "public, max-age=15");
  assert.ok(Buffer.from(await shared.arrayBuffer()).equals(Buffer.from(stored.bytes)));

  await appendEvent(store, ev("p"));
  const stale = await get("/projects/p/export");
  assert.equal(stale.headers.get("x-retrace-export-cache"), "stale");
  assert.equal(stale.headers.get("content-length"), String(stored.bytes.length));
  assert.ok(Buffer.from(await stale.arrayBuffer()).equals(Buffer.from(stored.bytes)));
  assert.equal(cache.cancelled, 0);

  cache.entries.set("p", { ...stored, meta: { ...stored.meta, head_hash: "f".repeat(64) } });
  assert.equal((await get("/projects/p/export?cached=1")).status, 503);
  assert.equal(cache.cancelled, 1, "a cached entry that is not a prefix of the ledger is cancelled, not served");
  const fresh = await get("/projects/p/export?fresh=1");
  assert.equal(fresh.headers.get("x-retrace-export-cache"), null);
  assert.equal(JSON.parse(await fresh.text()).chain.total_events, 3);
  cache.entries.set("ghost", { ...stored, meta: { ...stored.meta, project: "ghost" } });
  assert.equal((await get("/projects/ghost/export?cached=1")).status, 404);
  assert.equal(cache.cancelled, 2, "a cached entry for a project with no head is cancelled");

  const strings = new StreamCache();
  const plain = createHandler(store, { token, exportCache: { get: async () => ({ project: "p", head_seq: 2, head_hash: (await store.head("p"))!.hash, generated_at: NOW.toISOString(), bundle_json: "{\"é\":\"😀\"}" }), put: async () => {} } });
  const text = await plain(new Request("http://x/projects/p/export", { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(text.headers.get("content-length"), String(Buffer.byteLength("{\"é\":\"😀\"}")), "a whole-text entry carries its UTF-8 length");
  assert.equal(strings.gets, 0);
});
