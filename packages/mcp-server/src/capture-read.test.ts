import { captureReadContract } from "../../core/dist/capture-read-fixture.js";
import { firstStampedSeq } from "../../core/dist/capture.js";
import { SqliteStore } from "./sqlite-store.js";
captureReadContract("SQLite", () => new SqliteStore(":memory:"));

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { appendEvent, EventInput, BACKFILL_ARTIFACT_INDEX_SQL } from "@retrace-dev/core";

test("both backfills store only guarded string stamps; old index affinity never sets capture boundary", async () => {
  const store = new SqliteStore(":memory:"), db = (store as unknown as { db: DatabaseSync }).db;
  const params = [{ sealed_by: 7 }, { sealed_by: true }, { sealed_by: { x: 1 } }, { sealed_by: "owner" },
    { "sealed_by\u0000x": "decoy" }, { "sealed_by\u0000x": 42, sealed_by: "owner" }];
  for (const value of params) await appendEvent(store, EventInput.parse({ project: "p", actor: { type: "agent", id: "A" },
    action: "read", artifacts: [{ id: "task:1" }], method: { params: value } }));
  const schema = readFileSync(new URL("../../../apps/worker/schema.sql", import.meta.url), "utf8");
  const workerBackfill = schema.slice(schema.indexOf("INSERT OR IGNORE INTO event_artifact_index")).split(";")[0] + ";";
  for (const sql of [BACKFILL_ARTIFACT_INDEX_SQL, workerBackfill]) {
    db.exec("DELETE FROM event_artifact_index"); db.exec(sql);
    assert.deepEqual(db.prepare("SELECT sealed_by FROM event_artifact_index ORDER BY seq").all().map(r => r.sealed_by), [null, null, null, "owner", null, null]);
    // Simulate an already backfilled index with affinity-corrupted non-string stamps. The new read uses the bodies.
    db.exec("UPDATE event_artifact_index SET sealed_by = '7' WHERE seq = 0");
    const query = { project: "p", artifact_keys: ["task:1"], after_seq: -1, through_seq: 100, row_cap: 100, deadline: Infinity };
    const old = await store.eventsReferencingArtifacts(query), got = await store.captureIndexRows(query);
    assert.ok(old.ok && got.ok); if (!old.ok || !got.ok) continue;
    assert.equal(firstStampedSeq(old.events, { repoName: "p" }), 3);
    assert.equal(Math.min(...got.rows.filter(r => r.stamped).map(r => r.seq)), 3);
  }
});
