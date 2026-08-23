import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, sealEvent, verifyProject, EventInput, HeadMovedError } from "@retrace/core";
import { SqliteStore } from "./sqlite-store.js";

const ev = (over: Partial<EventInput>): EventInput => ({ project: "junk", actor: { type: "agent", id: "claude" }, action: "edited", artifacts: [{ id: "a" }], ...over });
const audit = (store: SqliteStore) => store.head("ops").then((h) => sealEvent(ev({ project: "ops", action: "deleted", artifacts: [{ id: "project:junk" }] }), h));

test("SqliteStore.deleteProject: deletes + audit insert commit together", async () => {
  const store = new SqliteStore(":memory:");
  await appendEvent(store, ev({ artifacts: [{ id: "a" }, { id: "b" }] }));
  await appendEvent(store, ev({}));
  await appendEvent(store, ev({ project: "keep" }));
  await store.createShare({ id: "sh_1", project: "junk", created_at: "2026-08-20T00:00:00Z" });
  const counts = await store.deleteProject("junk", await audit(store), (await store.head("junk"))!);
  assert.deepEqual(counts, { events: 2, event_artifacts: 3, shares: 1 });
  assert.deepEqual(await store.projects(), ["keep", "ops"]);
  assert.equal((await store.all("ops")).length, 1);
  assert.equal((await verifyProject(store, "ops")).ok, true);
});

test("SqliteStore.deleteProject: audit insert failure rolls the deletes back (B3)", async () => {
  const store = new SqliteStore(":memory:");
  await appendEvent(store, ev({}));
  await store.createShare({ id: "sh_1", project: "junk", created_at: "2026-08-20T00:00:00Z" });
  const stale = await audit(store); // sealed at ops seq 0 …
  await appendEvent(store, ev({ project: "ops", action: "deleted", artifacts: [{ id: "project:other" }] })); // … then someone else takes seq 0
  await assert.rejects(store.deleteProject("junk", stale, (await store.head("junk"))!), /UNIQUE/);
  assert.equal((await store.all("junk")).length, 1);
  assert.ok(await store.getShare("sh_1"));
  assert.equal((await store.all("ops")).length, 1); // only the competing event, no half-written audit
});

test("SqliteStore.deleteProject: a head that moved since the audit was sealed throws HeadMovedError and commits nothing", async () => {
  const store = new SqliteStore(":memory:");
  await appendEvent(store, ev({}));
  await store.createShare({ id: "sh_1", project: "junk", created_at: "2026-08-20T00:00:00Z" });
  const seen = (await store.head("junk"))!; // router reads the head and seals the audit from it …
  const sealed = await audit(store);
  await appendEvent(store, ev({ artifacts: [{ id: "late" }] })); // … then a write lands on junk before the transaction
  await assert.rejects(store.deleteProject("junk", sealed, seen), (e: any) => e instanceof HeadMovedError && e.name === "HeadMovedError");
  assert.equal((await store.all("junk")).length, 2);
  assert.ok(await store.getShare("sh_1"));
  assert.equal((await store.all("ops")).length, 0);
  // retry with the fresh head succeeds
  const counts = await store.deleteProject("junk", await audit(store), (await store.head("junk"))!);
  assert.deepEqual(counts, { events: 2, event_artifacts: 2, shares: 1 });
  assert.equal((await store.all("ops")).length, 1);
});
