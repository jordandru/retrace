import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { R2ExportCache } from "./export-cache-r2.js";

test("R2 in workerd stores and returns a 33 MiB export as one byte-equal object", { timeout: 120_000 }, async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      r2Buckets: { EXPORT_CACHE: "export-cache-test" },
      compatibilityDate: "2025-06-01",
    }],
  }));
  try {
    const bucket = await mf.getR2Bucket("EXPORT_CACHE") as unknown as R2Bucket;
    const cache = new R2ExportCache(bucket);
    const bundle_json = "x".repeat(33 * 1024 * 1024);
    await cache.put({
      project: "large",
      head_seq: 10810,
      head_hash: "b".repeat(64),
      generated_at: "2026-10-01T15:07:00.000Z",
      bundle_json,
    });
    const stored = await cache.get("large");
    assert.equal(stored?.bundle_json.length, bundle_json.length);
    assert.equal(stored?.bundle_json, bundle_json);
    const object = await bucket.head("export-cache/v1/large.json");
    assert.equal(object?.httpMetadata?.contentType, "application/json");
    assert.deepEqual(object?.customMetadata, {
      format: "retrace-export-cache/1",
      project: "large",
      head_seq: "10810",
      head_hash: "b".repeat(64),
      generated_at: "2026-10-01T15:07:00.000Z",
    });
  } finally {
    await mf.dispose();
  }
});
