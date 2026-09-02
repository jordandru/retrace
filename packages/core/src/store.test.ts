import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adapterIdempotencyError, AdapterIdempotencyError, CAUSED_BY_UNVERIFIED_TAG, appendEvent,
  EventInput, Event, EventStore, Share, likeContains, clampHistoryLimit, HISTORY_LIMIT_MAX,
  pageHistoryNewest, collectHistory, asHistoryPage,
} from "./index.js";

class MemStore implements EventStore {
  events: Event[] = [];
  async head(p: string) { const e = this.events.filter((x) => x.project === p).at(-1); return e ? { seq: e.seq, hash: e.hash } : null; }
  async insert(e: Event) { this.events.push(e); }
  async byIdempotencyKey(p: string, k: string) { return this.events.find((e) => e.project === p && e.idempotency_key === k) ?? null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(p: string) { return this.events.filter((e) => e.project === p); }
  async projects() { return [...new Set(this.events.map((e) => e.project))]; }
  async history(q: { project: string }) { return pageHistoryNewest(this.events, q); }
  async createShare(_s: Share) {}
  async getShare() { return null; }
}

const ev = (over: Partial<EventInput>): EventInput => ({
  project: "p", actor: { type: "agent", id: "grok" }, action: "edited", artifacts: [{ id: "a" }], ...over,
});

test("likeContains treats % and _ as literals; clampHistoryLimit binds a finite cap", () => {
  assert.equal(likeContains("100%").pattern, "%100!%%");
  assert.equal(likeContains("a_b").pattern, "%a!_b%");
  assert.equal(likeContains("a!b").pattern, "%a!!b%");
  assert.match(likeContains("x").sql, /ESCAPE '!'/);
  assert.equal(clampHistoryLimit(undefined), 100);
  assert.equal(clampHistoryLimit(NaN), 100);
  assert.equal(clampHistoryLimit(-4), 100);
  assert.equal(clampHistoryLimit(3.9), 3);
  assert.equal(clampHistoryLimit(HISTORY_LIMIT_MAX + 1), HISTORY_LIMIT_MAX);
});

test("pageHistoryNewest: default limit is the newest 100, not genesis; cursor walks older pages", () => {
  const events = Array.from({ length: 130 }, (_, seq) => ({
    id: `evt_${seq}`, project: "p", seq, timestamp: "2026-09-01T00:00:00.000Z", received_at: "2026-09-01T00:00:00.000Z",
    actor: { type: "agent" as const, id: "claude-code" }, action: "edited" as const, artifacts: [{ id: "a" }],
    prev_hash: "0", hash: `h${seq}`,
  }));
  const def = pageHistoryNewest(events, { project: "p" });
  assert.equal(def.events.length, 100);
  assert.equal(def.events[0].seq, 30);
  assert.equal(def.events.at(-1)?.seq, 129);
  assert.equal(def.truncated, true);
  assert.equal(def.next_before_seq, 30);
  const older = pageHistoryNewest(events, { project: "p", before_seq: def.next_before_seq, limit: 100 });
  assert.equal(older.events[0].seq, 0);
  assert.equal(older.events.at(-1)?.seq, 29);
  assert.equal(older.truncated, false);
  assert.equal(older.next_before_seq, undefined);
  const small = pageHistoryNewest(events, { project: "p", limit: 3 });
  assert.deepEqual(small.events.map((e) => e.seq), [127, 128, 129]);
  assert.equal(small.next_before_seq, 127);
});

test("asHistoryPage: a legacy Event[] is a complete page; a wrapper keeps truncated", () => {
  const ev0 = { id: "e", project: "p", seq: 0, timestamp: "2026-09-01T00:00:00.000Z", received_at: "2026-09-01T00:00:00.000Z", actor: { type: "agent" as const, id: "x" }, action: "edited" as const, artifacts: [] as { id: string }[], prev_hash: "0", hash: "h" };
  assert.deepEqual(asHistoryPage([ev0]), { events: [ev0], truncated: false });
  assert.equal(asHistoryPage({ events: [ev0], truncated: true, next_before_seq: 4 }).truncated, true);
  assert.throws(() => asHistoryPage({}), /neither/);
});

test("collectHistory: pages until the window is complete and returns ascending seq", async () => {
  const events = Array.from({ length: 250 }, (_, seq) => ({
    id: `evt_${seq}`, project: "p", seq, timestamp: "2026-09-01T00:00:00.000Z", received_at: "2026-09-01T00:00:00.000Z",
    actor: { type: "agent" as const, id: "claude-code" }, action: "edited" as const, artifacts: [{ id: "a" }],
    prev_hash: "0", hash: `h${seq}`,
  }));
  const store = { history: async (q: { project: string; limit?: number; before_seq?: number }) => pageHistoryNewest(events, { ...q, limit: 80 }) };
  const all = await collectHistory(store, { project: "p" });
  assert.equal(all.length, 250);
  assert.equal(all[0].seq, 0);
  assert.equal(all.at(-1)?.seq, 249);
});

test("adapter idempotency: git:/gd:/gh: are reserved unless the event is adapter-shaped", () => {
  assert.ok(adapterIdempotencyError(ev({ idempotency_key: "git:abc" })));
  assert.ok(adapterIdempotencyError(ev({ idempotency_key: "git:abc", method: { tool: "git" }, action: "edited" })));
  assert.equal(adapterIdempotencyError(ev({ idempotency_key: "git:abc", method: { tool: "git" }, action: "committed" })), undefined);
  assert.equal(adapterIdempotencyError(ev({ idempotency_key: "git:abc", method: { tool: "git" }, action: "merged" })), undefined);

  assert.ok(adapterIdempotencyError(ev({ idempotency_key: "gd:x" })));
  assert.equal(adapterIdempotencyError(ev({ idempotency_key: "gd:x", tags: ["google-drive"] })), undefined);
  assert.equal(adapterIdempotencyError(ev({ idempotency_key: "gd:x", method: { tool: "google-docs" } })), undefined);

  assert.ok(adapterIdempotencyError(ev({ idempotency_key: "gh:d1" })));
  assert.equal(adapterIdempotencyError(ev({ idempotency_key: "gh:d1", method: { tool: "github" } })), undefined);
  assert.equal(adapterIdempotencyError(ev({ idempotency_key: "gh:d1", tags: ["github"] })), undefined);

  assert.equal(adapterIdempotencyError(ev({ idempotency_key: "k1" })), undefined);
  assert.equal(adapterIdempotencyError(ev({})), undefined);
});

test("appendEvent: a planted git: key on a non-commit does not shadow a later git-hook event", async () => {
  const store = new MemStore();
  await assert.rejects(
    () => appendEvent(store, ev({ idempotency_key: "git:deadbeef", action: "edited", method: { tool: "Edit" } })),
    (e: unknown) => e instanceof AdapterIdempotencyError && /git:/.test((e as Error).message),
  );
  assert.equal(store.events.length, 0);
  const { event, deduped } = await appendEvent(store, ev({
    action: "committed", method: { tool: "git" }, idempotency_key: "git:deadbeef",
    artifacts: [{ id: "commit:p@deadbeefcafe", kind: "commit" }],
  }));
  assert.equal(deduped, false);
  assert.equal(event.action, "committed");
  const again = await appendEvent(store, ev({
    action: "committed", method: { tool: "git" }, idempotency_key: "git:deadbeef",
    artifacts: [{ id: "commit:p@deadbeefcafe", kind: "commit" }],
  }));
  assert.equal(again.deduped, true);
  assert.equal(again.event.id, event.id);
});

test("appendEvent: caused_by is optional; dangling/cross-project/newer is sealed with the link kept", async () => {
  const store = new MemStore();
  const root = (await appendEvent(store, ev({ action: "instructed", actor: { type: "human", id: "j@x" }, artifacts: [{ id: "task:1" }] }))).event;
  const child = await appendEvent(store, ev({ caused_by: root.id }));
  assert.equal(child.event.caused_by, root.id);
  assert.ok(!child.event.tags?.includes(CAUSED_BY_UNVERIFIED_TAG));

  const missing = (await appendEvent(store, ev({ caused_by: "evt_deadbeefdeadbeefdeadbeefdeadbeef" }))).event;
  assert.equal(missing.caused_by, "evt_deadbeefdeadbeefdeadbeefdeadbeef");
  assert.ok(missing.tags?.includes(CAUSED_BY_UNVERIFIED_TAG));
  assert.equal(missing.method?.params?.caused_by_problem, "missing");

  const other = (await appendEvent(store, ev({ project: "other", action: "instructed", actor: { type: "human", id: "j@x" } }))).event;
  const cross = (await appendEvent(store, ev({ caused_by: other.id }))).event;
  assert.equal(cross.caused_by, other.id);
  assert.ok(cross.tags?.includes(CAUSED_BY_UNVERIFIED_TAG));
  assert.equal(cross.method?.params?.caused_by_problem, "wrong_project");

  const newer = (await appendEvent(store, ev({
    caused_by: root.id,
    timestamp: "2020-01-01T00:00:00.000Z",
  }))).event;
  assert.equal(newer.caused_by, root.id);
  assert.ok(newer.tags?.includes(CAUSED_BY_UNVERIFIED_TAG));
  assert.equal(newer.method?.params?.caused_by_problem, "not_older");

  const none = await appendEvent(store, ev({}));
  assert.equal(none.event.caused_by, undefined);
});
