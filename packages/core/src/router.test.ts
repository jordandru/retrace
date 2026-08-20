import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, EventStore, Event, Share, appendEvent, EventInput } from "./index.js";

/** minimal in-memory store for tests */
class MemStore implements EventStore {
  events: Event[] = []; shares = new Map<string, Share>();
  async head(p: string) { const e = this.events.filter((x) => x.project === p).at(-1); return e ? { seq: e.seq, hash: e.hash } : null; }
  async insert(e: Event) { this.events.push(e); }
  async byIdempotencyKey(p: string, k: string) { return this.events.find((e) => e.project === p && e.idempotency_key === k) ?? null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(p: string) { return this.events.filter((e) => e.project === p).sort((a, b) => a.seq - b.seq); }
  async projects() { return [...new Set(this.events.map((e) => e.project))]; }
  async history(q: any) { return this.all(q.project); }
  async createShare(s: Share) { this.shares.set(s.id, s); }
  async getShare(id: string) { return this.shares.get(id) ?? null; }
  async deleteProject(p: string) {
    const evs = this.events.filter((e) => e.project === p);
    const counts = {
      events: evs.length,
      event_artifacts: evs.reduce((n, e) => n + e.artifacts.length, 0),
      shares: [...this.shares.values()].filter((s) => s.project === p).length,
    };
    this.events = this.events.filter((e) => e.project !== p);
    for (const [id, s] of this.shares) if (s.project === p) this.shares.delete(id);
    return counts;
  }
}

const ev = (over: Partial<EventInput>): EventInput => ({ project: "junk", actor: { type: "agent", id: "claude" }, action: "edited", artifacts: [{ id: "a" }], ...over });

async function seeded() {
  const store = new MemStore();
  await appendEvent(store, ev({ artifacts: [{ id: "a" }, { id: "b" }] }));
  await appendEvent(store, ev({}));
  await appendEvent(store, ev({ project: "keep" }));
  await store.createShare({ id: "sh_1", project: "junk", created_at: "2026-08-20T00:00:00Z" });
  return store;
}
const del = (handle: (r: Request) => Promise<Response>, path: string, headers?: Record<string, string>) =>
  handle(new Request(`http://test${path}`, { method: "DELETE", headers }));
const AUTH = { authorization: "Bearer tok" };

test("DELETE /projects/:p requires auth and deletes nothing without it", async () => {
  const store = await seeded();
  const handle = createHandler(store, { token: "tok", opsProject: "ops" });
  const noToken = await del(handle, "/projects/junk?confirm=junk");
  assert.equal(noToken.status, 401);
  const badToken = await del(handle, "/projects/junk?confirm=junk", { authorization: "Bearer wrong" });
  assert.equal(badToken.status, 401);
  assert.equal(store.events.filter((e) => e.project === "junk").length, 2);
});

test("DELETE /projects/:p without exact confirm → 400, nothing deleted", async () => {
  const store = await seeded();
  const handle = createHandler(store, { token: "tok", opsProject: "ops" });
  const missing = await del(handle, "/projects/junk", AUTH);
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /confirm=junk/);
  const wrong = await del(handle, "/projects/junk?confirm=Junk", AUTH);
  assert.equal(wrong.status, 400);
  assert.equal(store.events.filter((e) => e.project === "junk").length, 2);
  assert.equal(store.shares.size, 1);
  assert.equal(store.events.filter((e) => e.project === "ops").length, 0); // no audit event for a refused delete
});

test("DELETE /projects/:p on unknown project → 404, nothing deleted", async () => {
  const store = await seeded();
  const handle = createHandler(store, { token: "tok", opsProject: "ops" });
  const res = await del(handle, "/projects/nope?confirm=nope", AUTH);
  assert.equal(res.status, 404);
  assert.equal(store.events.length, 3);
  assert.equal(store.events.filter((e) => e.project === "ops").length, 0);
});

test("DELETE /projects/:p happy path: per-table counts, other projects intact, audit event in ops project", async () => {
  const store = await seeded();
  const handle = createHandler(store, { token: "tok", opsProject: "ops" });
  const res = await del(handle, "/projects/junk?confirm=junk", AUTH);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.project, "junk");
  assert.deepEqual(body.deleted, { events: 2, event_artifacts: 3, shares: 1 });
  assert.equal(store.events.filter((e) => e.project === "junk").length, 0);
  assert.equal(store.events.filter((e) => e.project === "keep").length, 1); // untouched
  assert.equal(store.shares.size, 0);
  const [audit] = store.events.filter((e) => e.project === "ops");
  assert.ok(audit);
  assert.equal(audit.id, body.ops_event);
  assert.deepEqual(audit.actor, { type: "system", id: "worker" });
  assert.equal(audit.action, "deleted");
  assert.equal(audit.artifacts[0].id, "project:junk");
  assert.equal(audit.intent, "project deleted via DELETE route");
});

test("DELETE /projects/:p defaults ops project to 'retrace' and 501s on stores without deleteProject", async () => {
  const store = await seeded();
  const handle = createHandler(store, { token: "tok" });
  const res = await del(handle, "/projects/junk?confirm=junk", AUTH);
  assert.equal(res.status, 200);
  assert.equal(store.events.filter((e) => e.project === "retrace").length, 1);

  const bare = await seeded();
  (bare as any).deleteProject = undefined;
  const res2 = await del(createHandler(bare, { token: "tok" }), "/projects/junk?confirm=junk", AUTH);
  assert.equal(res2.status, 501);
  assert.equal(bare.events.filter((e) => e.project === "junk").length, 2);
});
