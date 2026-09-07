import assert from "node:assert/strict";
import test from "node:test";
import { TornExportCacheError } from "@retrace-dev/core";
import { D1ExportCache } from "./export-cache-d1.js";

class PreparedStatement {
  params: unknown[] = [];
  constructor(readonly sql: string, private readonly rows: unknown[]) {}
  bind(...params: unknown[]) { this.params = params; return this; }
  async all() { return { results: this.rows }; }
}

class FakeD1 {
  constructor(private readonly rows: unknown[]) {}
  prepare(sql: string) { return new PreparedStatement(sql, this.rows); }
  async batch() { return []; }
}

const chunk = (over: Record<string, unknown> = {}) => ({
  chunk: 0, head_seq: 1, head_hash: "a".repeat(64), generated_at: "2026-09-07T00:00:00.000Z",
  total_chunks: 2, data: "{\"ok\":true}", ...over,
});

test("D1 export cache: no rows is absent; torn chunks throw instead of looking like a miss", async () => {
  const empty = new D1ExportCache(new FakeD1([]) as unknown as D1Database);
  assert.equal(await empty.get("p"), null);

  const torn = new D1ExportCache(new FakeD1([chunk({ total_chunks: 2 })]) as unknown as D1Database);
  await assert.rejects(() => torn.get("p"), (error: unknown) => {
    assert.ok(error instanceof TornExportCacheError);
    assert.equal(error.torn, true);
    assert.match(error.message, /torn \(inconsistent chunks\)/);
    return true;
  });

  const ok = new D1ExportCache(new FakeD1([
    chunk({ chunk: 0, total_chunks: 2, data: "{\"a\":" }),
    chunk({ chunk: 1, total_chunks: 2, data: "1}" }),
  ]) as unknown as D1Database);
  const cached = await ok.get("p");
  assert.equal(cached?.bundle_json, "{\"a\":1}");
  assert.equal(cached?.head_seq, 1);
});
