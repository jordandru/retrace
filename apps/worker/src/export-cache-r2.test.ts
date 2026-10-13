import assert from "node:assert/strict";
import test from "node:test";
import { CachedExport, TornExportCacheError } from "@retrace-dev/core";
import { R2ExportCache } from "./export-cache-r2.js";
import { installFixedLengthStream } from "./test-fixed-length-stream.js";

installFixedLengthStream();

type Stored = {
  body: string;
  customMetadata?: Record<string, string>;
  httpMetadata?: R2HTTPMetadata;
};

class FakeBucket {
  objects = new Map<string, Stored>();
  nullPut = false;
  textReads = 0;
  cancels = 0;

  private object(key: string, stored: Stored) {
    const bytes = new TextEncoder().encode(stored.body);
    const bucket = this;
    return {
      key,
      size: bytes.length,
      customMetadata: stored.customMetadata,
      httpMetadata: stored.httpMetadata,
      body: new ReadableStream<Uint8Array>({
        pull(c) { c.enqueue(bytes); c.close(); },
        cancel() { bucket.cancels++; },
      }),
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

  /** Like R2: a streamed body is read to its end first, and a stream that errors fails the put and stores nothing. */
  async put(key: string, value: string | ReadableStream<Uint8Array>, options?: R2PutOptions) {
    const body = typeof value === "string" ? value : await new Response(value).text();
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
  const got = await cache.get(entry.project);
  assert.ok(got && "body" in got, "get returns a stream");
  const { body, bytes, ...meta } = got;
  assert.deepEqual(meta, { project: entry.project, head_seq: 42, head_hash: entry.head_hash, generated_at: entry.generated_at });
  assert.equal(bytes, Buffer.byteLength(entry.bundle_json));
  assert.equal(await new Response(body).text(), entry.bundle_json);
  assert.equal(bucket.textReads, 0, "the export is never read into memory");
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
    assert.equal(bucket.cancels, 1, `${name}: the torn object's body is cancelled`);
  }
});

test("R2 export cache treats a null put result as a failed write", async () => {
  const bucket = new FakeBucket();
  bucket.nullPut = true;
  const cache = new R2ExportCache(bucket as unknown as R2Bucket);
  await assert.rejects(() => cache.put(entry), /put returned no object/);
});

test("R2 export cache putStream stores exactly the streamed bytes; a throw, a short or a long write leaves the old object", async () => {
  const bucket = new FakeBucket();
  const cache = new R2ExportCache(bucket as unknown as R2Bucket);
  await cache.put(entry);
  const key = "export-cache/v1/project%2Fwith%20space.json";
  const { bundle_json: _old, ...meta } = entry;
  const next = { ...meta, head_seq: 43, head_hash: "b".repeat(64) };
  const text = "{\"signed\":\"é😀\"}";
  const bytes = new TextEncoder().encode(text);

  await assert.rejects(() => cache.putStream(next, bytes.length, async (sink) => {
    await sink.write(bytes.subarray(0, 5));
    throw new Error("pass 2 read different events from pass 0");
  }), /pass 2 read different events/);
  await assert.rejects(() => cache.putStream(next, bytes.length, async (sink) => { await sink.write(bytes.subarray(0, 5)); }), /did not see all expected bytes/);
  await assert.rejects(() => cache.putStream(next, bytes.length - 1, async (sink) => { await sink.write(bytes); }), /too many bytes/);
  assert.equal(bucket.objects.get(key)!.body, entry.bundle_json, "every failed stream left the old object");
  assert.equal(bucket.objects.get(key)!.customMetadata!.head_seq, "42");

  await cache.putStream(next, bytes.length, async (sink) => {
    await sink.write(bytes.subarray(0, 3));
    await sink.write(bytes.subarray(3));
  });
  assert.equal(bucket.objects.get(key)!.body, text);
  assert.deepEqual(await cache.meta(entry.project), next);
  bucket.nullPut = true;
  await assert.rejects(() => cache.putStream(next, bytes.length, async (sink) => { await sink.write(bytes); }), /put returned no object/);
});
