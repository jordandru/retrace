import assert from "node:assert/strict";
import test from "node:test";
import { readExportCacheLastRefresh, recordExportCacheRefreshResults } from "./export-cache-refresh.js";

class Statement {
  params: unknown[] = [];
  constructor(readonly sql: string, private db: FakeD1) {}
  bind(...params: unknown[]) { this.params = params; return this; }
  async run() {
    if (this.db.failRun) throw new Error("D1 unavailable");
    this.db.runs.push(this);
    return { meta: { changes: 1 } };
  }
  async first() { return this.db.row; }
}

class FakeD1 {
  runs: Statement[] = [];
  failRun = false;
  row: unknown = null;
  prepare(sql: string) { return new Statement(sql, this); }
}

test("refresh outcome persistence records failed errors and refreshed heads while moving last_ok_at only on success", async () => {
  const db = new FakeD1();
  const attemptedAt = "2026-10-01T15:07:00.000Z";
  await recordExportCacheRefreshResults(db as unknown as D1Database, [
    { project: "failed", action: "failed", error: "R2 write failed" },
    { project: "ok", action: "refreshed", head_seq: 10810 },
  ], attemptedAt);
  assert.equal(db.runs.length, 2);
  assert.deepEqual(db.runs[0]!.params, ["failed", attemptedAt, "failed", null, "R2 write failed", "failed", attemptedAt]);
  assert.deepEqual(db.runs[1]!.params, ["ok", attemptedAt, "refreshed", 10810, null, "refreshed", attemptedAt]);
  assert.match(db.runs[0]!.sql, /ELSE export_cache_refresh\.last_ok_at/);
});

test("refresh outcome persistence logs a failed upsert without throwing", async () => {
  const db = new FakeD1();
  db.failRun = true;
  const messages: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { messages.push(args); };
  try {
    await recordExportCacheRefreshResults(db as unknown as D1Database, [{ project: "p", action: "failed", error: "boom" }]);
  } finally {
    console.error = original;
  }
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.join(" "), /export cache refresh status write failed for p: D1 unavailable/);
});

test("refresh status reader returns optional error and last_ok_at", async () => {
  const db = new FakeD1();
  db.row = {
    attempted_at: "2026-10-01T15:07:00.000Z",
    result: "failed",
    error: "boom",
    last_ok_at: "2026-10-01T14:07:00.000Z",
  };
  assert.deepEqual(await readExportCacheLastRefresh(db as unknown as D1Database, "p"), db.row);
  db.row = null;
  assert.equal(await readExportCacheLastRefresh(db as unknown as D1Database, "p"), null);
});
