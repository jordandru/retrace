import assert from "node:assert/strict";
import test from "node:test";
import { CachedExport, TornExportCacheError } from "@retrace-dev/core";
import { R2ExportCache } from "./export-cache-r2.js";

type Stored = {
  body: string;
  customMetadata?: Record<string, string>;
  httpMetadata?: R2HTTPMetadata;
};

class FakeBucket {
  objects = new Map<string, Stored>();
  nullPut = false;
  textReads = 0;

  private object(key: string, stored: Stored) {
    return {
      key,
      customMetadata: stored.customMetadata,
      httpMetadata: stored.httpMetadata,
      text: async () => {
        this.textReads++;
        return stored.body;
      },
    };
  }

  async get(key: string) {
    const stored = this.objects.get(key);
    return stored ? this.object(key, stored) : null;
  }

  async head(key: string) {
    const stored = this.objects.get(key);
    return stored ? this.object(key, stored) : null;
  }

  async put(key: string, body: string, options?: R2PutOptions) {
    if (this.nullPut) return null;
    this.objects.set(key, {
      body,
      customMetadata: options?.customMetadata,
      httpMetadata: options?.httpMetadata as R2HTTPMetadata | undefined,
    });
    return this.object(key, this.objects.get(key)!);
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

const entry: CachedExport = {
  project: "project/with space",
  head_seq: 42,
  head_hash: "a".repeat(64),
  generated_at: "2026-10-01T15:07:00.000Z",
  bundle_json: "{\"signed\":true}",
};

const validMetadata = {
  format: "retrace-export-cache/1",
  project: "p",
  head_seq: "42",
  head_hash: "a".repeat(64),
  generated_at: "2026-10-01T15:07:00.000Z",
};

test("R2 export cache round-trips exact bytes and metadata without reading the body for meta", async () => {
  const bucket = new FakeBucket();
  const cache = new R2ExportCache(bucket as unknown as R2Bucket);
  await cache.put(entry);
  const key = "export-cache/v1/project%2Fwith%20space.json";
  const stored = bucket.objects.get(key)!;
  assert.equal(stored.body, entry.bundle_json);
  assert.equal(stored.httpMetadata?.contentType, "application/json");
  assert.deepEqual(stored.customMetadata, {
    format: "retrace-export-cache/1",
    project: entry.project,
    head_seq: "42",
    head_hash: entry.head_hash,
    generated_at: entry.generated_at,
  });
  assert.deepEqual(await cache.meta(entry.project), {
    project: entry.project,
    head_seq: 42,
    head_hash: entry.head_hash,
    generated_at: entry.generated_at,
  });
  assert.equal(bucket.textReads, 0);
  assert.deepEqual(await cache.get(entry.project), entry);
  assert.equal(bucket.textReads, 1);
});

test("R2 export cache miss returns null and delete removes the project object", async () => {
  const bucket = new FakeBucket();
  const cache = new R2ExportCache(bucket as unknown as R2Bucket);
  assert.equal(await cache.get("missing"), null);
  assert.equal(await cache.delete("missing"), false);
  await cache.put(entry);
  assert.equal(await cache.delete(entry.project), true);
  assert.equal(await cache.get(entry.project), null);
});

test("R2 export cache rejects every missing or malformed metadata field as torn", async () => {
  const cases: Array<[string, Record<string, string> | undefined]> = [
    ["missing", undefined],
    ["format", { ...validMetadata, format: "other/1" }],
    ["project", { ...validMetadata, project: "other" }],
    ["head_seq", { ...validMetadata, head_seq: "42x" }],
    ["head_hash", { ...validMetadata, head_hash: "A".repeat(64) }],
    ["generated_at", { ...validMetadata, generated_at: "not-a-date" }],
  ];
  for (const [name, customMetadata] of cases) {
    const bucket = new FakeBucket();
    bucket.objects.set("export-cache/v1/p.json", { body: "{}", customMetadata });
    const cache = new R2ExportCache(bucket as unknown as R2Bucket);
    await assert.rejects(
      () => cache.get("p"),
      (error: unknown) => error instanceof TornExportCacheError && error.torn,
      name,
    );
  }
});

test("R2 export cache treats a null put result as a failed write", async () => {
  const bucket = new FakeBucket();
  bucket.nullPut = true;
  const cache = new R2ExportCache(bucket as unknown as R2Bucket);
  await assert.rejects(() => cache.put(entry), /put returned no object/);
});
