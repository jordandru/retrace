import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adapterIdempotencyError, AdapterIdempotencyError, appendEvent,
  EventInput, Event, EventStore, Share,
} from "./index.js";

class MemStore implements EventStore {
  events: Event[] = [];
  async head(p: string) { const e = this.events.filter((x) => x.project === p).at(-1); return e ? { seq: e.seq, hash: e.hash } : null; }
  async insert(e: Event) { this.events.push(e); }
  async byIdempotencyKey(p: string, k: string) { return this.events.find((e) => e.project === p && e.idempotency_key === k) ?? null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(p: string) { return this.events.filter((e) => e.project === p); }
  async projects() { return [...new Set(this.events.map((e) => e.project))]; }
  async history(q: { project: string }) { return this.all(q.project); }
  async createShare(_s: Share) {}
  async getShare() { return null; }
}

const ev = (over: Partial<EventInput>): EventInput => ({
  project: "p", actor: { type: "agent", id: "grok" }, action: "edited", artifacts: [{ id: "a" }], ...over,
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
