/**
 * The export-cache refresh and its serving path inside workerd (export-cache handoff db4bb0d6 §6 test 5). The real
 * Worker, bundled from src/index.ts, runs its scheduled handler against Miniflare's D1 and R2, with FixedLengthStream
 * and R2's own put. A test-only entry, built only here, wraps the Worker: it records the export_cache_refresh writes,
 * counts the export's page queries, reads the refresh row mid-build, and can fail or grow one page query. Outbound
 * fetches (the checkpoint cron's Rekor witness) get a 503; nothing leaves the machine.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { MemoryEventStore, appendEvent, buildExportBundle, exportVerdictOk, generateSigningKey, verifyExportBundle } from "@retrace-dev/core";
import type { EventInput } from "@retrace-dev/core";
import { D1Store } from "./d1-store.js";
import { readExportCacheLastRefresh } from "./export-cache-refresh.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const schemaSql = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const TOKEN = "owner-token-for-the-workerd-export-test";
const KEY = "export-cache/v1/p.json";
const N = 1_100;

const ENTRY = `
import worker from "./index.ts";
import { D1Store } from "./d1-store.ts";
const RAW = Symbol("raw");
const state = { writes: [], pageQueries: 0, failAt: -1, growAt: -1, observeAt: -1, observed: null };
function statement(raw, sql, params, db) {
  return new Proxy(raw, {
    get(target, prop) {
      if (prop === RAW) return target;
      if (prop === "bind") return (...args) => statement(target.bind(...args), sql, args, db);
      if (prop === "run" && sql.includes("INSERT INTO export_cache_refresh")) {
        return async () => { state.writes.push(params[2]); return target.run(); };
      }
      if (prop === "all" && sql.includes("OVER (ORDER BY seq")) {
        return async () => {
          const n = state.pageQueries++;
          if (n === state.observeAt) {
            state.observed = await db.prepare("SELECT attempted_at, result, error, last_ok_at FROM export_cache_refresh WHERE project = ?").bind(params[0]).first();
          }
          if (n === state.failAt) throw new Error("injected D1 failure at page query " + n);
          const result = await target.all();
          if (n === state.growAt) result.results[0].body = JSON.stringify({ ...JSON.parse(result.results[0].body), intent: "z".repeat(200000) });
          return result;
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
function wrap(db) {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql) => statement(target.prepare(sql), sql, [], target);
      if (prop === "batch") return (statements) => target.batch(statements.map((s) => s[RAW] ?? s));
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/state") return Response.json(state);
    if (url.pathname === "/__test/seed") {
      // Inside workerd, through D1Store.insert: one proxied insert per event from Node takes about 70 ms.
      const store = new D1Store(env.DB);
      for (const e of await request.json()) await store.insert(e);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__test/arm") {
      for (const k of ["failAt", "growAt", "observeAt"]) state[k] = Number(url.searchParams.get(k) ?? -1);
      Object.assign(state, { pageQueries: 0, observed: null, writes: [] });
      return Response.json(state);
    }
    if (url.pathname === "/__test/fetch") {
      // The Worker's own Response, inspected inside workerd: Miniflare's dispatch re-chunks every response.
      const res = await worker.fetch(new Request("https://retrace.test" + url.searchParams.get("path"), { headers: request.headers }), env, ctx);
      const body = new Uint8Array(await res.arrayBuffer());
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].map((b) => b.toString(16).padStart(2, "0")).join("");
      return Response.json({ status: res.status, headers: Object.fromEntries(res.headers), length: body.length, sha256: digest });
    }
    return worker.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    return worker.scheduled(controller, { ...env, DB: wrap(env.DB) }, ctx);
  },
};
`;

const input = (i: number): EventInput => ({
  project: "p",
  actor: { type: i % 3 ? "agent" : "human", id: i % 3 ? "claude-code" : "jordan@example.com" },
  action: (["edited", "created", "sent"] as const)[i % 3],
  artifacts: [{ id: `repo:acme/app#src/f${i % 7}.ts`, role: "generated" }],
  intent: `${["plain", "dash — arrow →", "astral 😀"][i % 3]} #${i}`,
});

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

test("workerd: the scheduled refresh streams the signed export into R2 (started → refreshed), failures keep the old object, and every route serves the stored bytes", { timeout: 300_000 }, async () => {
  const bundled = await build({
    stdin: { contents: ENTRY, resolveDir: SRC, sourcefile: "export-cache-test-entry.js", loader: "js" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022",
    conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], external: ["node:*", "cloudflare:*"], logLevel: "silent",
  });
  const key = await generateSigningKey();
  const mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "retrace", modules: true, script: bundled.outputFiles[0]!.text,
      compatibilityDate: "2025-06-01", compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "export-cache-workerd" }, r2Buckets: { EXPORT_CACHE: "export-cache-workerd" },
      bindings: { RETRACE_TOKEN: TOKEN, RETRACE_SIGNING_KEY: JSON.stringify(key.privateKey), RETRACE_CHECKPOINT_PROJECTS: JSON.stringify(["p"]) },
      outboundService: () => new Response("no network in tests", { status: 503 }),
    }],
  }));
  try {
    const db = await mf.getD1Database("DB") as unknown as D1Database;
    const bucket = await mf.getR2Bucket("EXPORT_CACHE") as unknown as R2Bucket;
    for (const statement of schemaSql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean)) {
      if (/^INSERT OR IGNORE INTO event_artifact_index/.test(statement)) continue;
      try { await db.prepare(statement).run(); } catch (e) { if (!/duplicate column name/i.test(String((e as Error).message))) throw e; }
    }
    const memory = new MemoryEventStore();
    for (let i = 0; i < N; i++) await appendEvent(memory, input(i));
    const seeded = await mf.dispatchFetch("http://retrace.test/__test/seed", { method: "POST", body: JSON.stringify(memory.events) });
    assert.equal(seeded.status, 200, await seeded.text());
    const d1 = new D1Store(db);
    const auth = { authorization: `Bearer ${TOKEN}` };
    const json = async (path: string, init?: Parameters<typeof mf.dispatchFetch>[1]) => (await mf.dispatchFetch(`http://retrace.test${path}`, init)).json() as Promise<any>;
    const worker = await mf.getWorker();
    const run = async (arm: Record<string, number>) => {
      await json(`/__test/arm?${new URLSearchParams(Object.entries(arm).map(([k, v]) => [k, String(v)]))}`);
      const outcome = await worker.scheduled({ cron: "7 * * * *" });
      assert.equal(outcome.outcome, "ok");
      return json("/__test/state");
    };
    const stored = async () => {
      const object = await bucket.get(KEY);
      return object ? { text: await object.text(), meta: object.customMetadata!, size: object.size } : null;
    };

    // An older cache entry: the export of the first 1,000 events.
    const old = new MemoryEventStore();
    old.events = memory.events.slice(0, 1_000);
    const oldJson = JSON.stringify(await buildExportBundle(old, { project: "p" }, { signingKey: key.privateKey, now: new Date("2026-10-10T19:07:11.543Z") }));
    await bucket.put(KEY, oldJson, { httpMetadata: { contentType: "application/json" }, customMetadata: { format: "retrace-export-cache/1", project: "p", head_seq: "999", head_hash: old.events[999]!.hash, generated_at: "2026-10-10T19:07:11.543Z" } });

    // 1. A run: the row reads `started` during the build, then `refreshed`; R2 holds buildExportBundle's bytes.
    const first = await run({ observeAt: 0 });
    assert.deepEqual(first.writes, ["started", "refreshed"]);
    assert.equal(first.observed.result, "started", "mid-build, /status would show started");
    assert.equal(first.observed.last_ok_at, null);
    assert.ok(first.pageQueries >= 6 && first.pageQueries % 3 === 0, `three passes of the same pages (${first.pageQueries} page queries)`);
    const perPass = first.pageQueries / 3;
    const refreshed = await readExportCacheLastRefresh(db, "p");
    assert.equal(refreshed?.result, "refreshed");
    assert.equal(refreshed?.attempted_at, first.observed.attempted_at);
    assert.equal(refreshed?.last_ok_at, refreshed?.attempted_at);
    const s1 = (await stored())!;
    const head = (await memory.head("p"))!;
    assert.deepEqual(s1.meta, { format: "retrace-export-cache/1", project: "p", head_seq: String(N - 1), head_hash: head.hash, generated_at: s1.meta.generated_at });
    const expected = JSON.stringify(await buildExportBundle(memory, { project: "p" }, { signingKey: key.privateKey, now: new Date(s1.meta.generated_at!) }));
    assert.equal(s1.text, expected, "R2 holds exactly buildExportBundle's bytes");
    assert.equal(exportVerdictOk(await verifyExportBundle(JSON.parse(s1.text), key.publicKey)), true);

    // 2. Serving: the Worker's Response carries the stored bytes and their Content-Length.
    for (const path of ["/projects/p/export", "/projects/p/export?cached=1"]) {
      const r = await json(`/__test/fetch?path=${encodeURIComponent(path)}`, { headers: auth });
      assert.equal(r.status, 200, path);
      assert.equal(r.headers["content-length"], String(s1.size), `${path}: Content-Length`);
      assert.equal(r.headers["content-type"], "application/json");
      assert.equal(r.headers["x-retrace-export-cache"], "hit");
      assert.equal(r.headers["x-retrace-export-generated-at"], s1.meta.generated_at);
      assert.equal(r.length, s1.size);
      assert.equal(r.sha256, sha256(s1.text), `${path}: the stored bytes`);
    }
    const wire = await mf.dispatchFetch("http://retrace.test/projects/p/export", { headers: auth });
    assert.equal(wire.status, 200);
    assert.equal(await wire.text(), s1.text);
    const fresh = await mf.dispatchFetch("http://retrace.test/projects/p/export?fresh=1", { headers: auth });
    assert.equal(fresh.headers.get("x-retrace-export-cache"), null, "fresh=1 builds live");
    const live = JSON.parse(await fresh.text());
    assert.equal(live.chain.total_events, N);
    assert.notEqual(live.generated_at, s1.meta.generated_at);
    assert.equal(exportVerdictOk(await verifyExportBundle(live, key.publicKey)), true);
    const share = await json("/projects/p/share", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
    const shared = await json(`/__test/fetch?path=${encodeURIComponent(`/s/${share.share.id}/export`)}`);
    assert.equal(shared.status, 200);
    assert.equal(shared.headers["content-length"], String(s1.size));
    assert.equal(shared.headers["cache-control"], "public, max-age=15");
    assert.equal(shared.sha256, sha256(s1.text), "the share link serves the stored bytes");

    // 3. The head moves; a D1 failure in pass 2, after part of the object was streamed, keeps the old object.
    for (let i = N; i < N + 5; i++) await d1.insert((await appendEvent(memory, input(i))).event);
    const failed = await run({ failAt: 2 * perPass });
    assert.deepEqual(failed.writes, ["started", "failed"]);
    const failedRow = await readExportCacheLastRefresh(db, "p");
    assert.equal(failedRow?.result, "failed");
    assert.match(failedRow?.error ?? "", /injected D1 failure at page query/);
    assert.equal(failedRow?.last_ok_at, refreshed?.attempted_at, "last_ok_at still names the last success");
    assert.deepEqual(await stored(), s1, "the old object stays");

    // 4. Pass 2 reads more bytes than pass 0 counted: refused before the declared length, the old object stays.
    const grown = await run({ growAt: 2 * perPass });
    assert.deepEqual(grown.writes, ["started", "failed"]);
    assert.match((await readExportCacheLastRefresh(db, "p"))?.error ?? "", /outgrew pass 0's count/);
    assert.deepEqual(await stored(), s1, "the old object stays");

    // 5. The next clean run refreshes to the moved head.
    const again = await run({});
    assert.deepEqual(again.writes, ["started", "refreshed"]);
    const s2 = (await stored())!;
    assert.equal(s2.meta.head_seq, String(N + 4));
    assert.equal(s2.text, JSON.stringify(await buildExportBundle(memory, { project: "p" }, { signingKey: key.privateKey, now: new Date(s2.meta.generated_at!) })));
  } finally {
    await mf.dispose();
  }
});
