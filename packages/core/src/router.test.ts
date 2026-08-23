import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, parseCredentials, Credential, EventStore, Event, Share, appendEvent, EventInput, verifyProject, ChainHead, HeadMovedError } from "./index.js";

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
  async deleteProject(p: string, audit: Event, expectedHead: ChainHead) {
    const head = await this.head(p);
    if (!head || head.seq !== expectedHead.seq || head.hash !== expectedHead.hash) throw new HeadMovedError(p, expectedHead);
    const evs = this.events.filter((e) => e.project === p);
    const counts = {
      events: evs.length,
      event_artifacts: evs.reduce((n, e) => n + e.artifacts.length, 0),
      shares: [...this.shares.values()].filter((s) => s.project === p).length,
    };
    // mimic a UNIQUE(project, seq) constraint so the router's re-seal/retry path is exercised
    if (this.events.some((e) => e.project === audit.project && e.seq === audit.seq)) throw new Error("UNIQUE constraint failed: events.project, events.seq");
    this.events = this.events.filter((e) => e.project !== p);
    for (const [id, s] of this.shares) if (s.project === p) this.shares.delete(id);
    this.events.push(audit);
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

test("DELETE /projects/:p refuses the ops/audit project → 403, nothing deleted, ops chain intact", async () => {
  const store = await seeded();
  const handle = createHandler(store, { token: "tok", opsProject: "ops" });
  await appendEvent(store, ev({ project: "ops", action: "deleted", artifacts: [{ id: "project:old" }] }));
  const before = store.events.filter((e) => e.project === "ops").map((e) => e.hash);
  const res = await del(handle, "/projects/ops?confirm=ops", AUTH);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "refusing to delete the ops/audit project" });
  assert.deepEqual(store.events.filter((e) => e.project === "ops").map((e) => e.hash), before); // no wipe, no new audit event
  assert.equal(store.events.length, 4);

  // default ops project name ("retrace") is guarded too
  const dflt = await seeded();
  await appendEvent(dflt, ev({ project: "retrace" }));
  const res2 = await del(createHandler(dflt, { token: "tok" }), "/projects/retrace?confirm=retrace", AUTH);
  assert.equal(res2.status, 403);
  assert.equal(dflt.events.filter((e) => e.project === "retrace").length, 1);
});

test("DELETE /projects/:p audit event records the deleted project's final head hash and seq", async () => {
  const store = await seeded();
  const head = await store.head("junk");
  assert.ok(head && head.seq === 1);
  const handle = createHandler(store, { token: "tok", opsProject: "ops" });
  const res = await del(handle, "/projects/junk?confirm=junk", AUTH);
  assert.equal(res.status, 200);
  const [audit] = store.events.filter((e) => e.project === "ops");
  assert.equal(audit.change?.before_hash, head.hash);
  assert.match(audit.change?.summary ?? "", new RegExp(`at head ${head.hash} seq ${head.seq}$`));
});

// ---- audit-event actor ----
test("DELETE /projects/:p: audit event is attributed to ownerActor, records the route, and links caused_by", async () => {
  const store = await seeded();
  const ins = await appendEvent(store, ev({ project: "ops", actor: { type: "human", id: "jordan@example.com" }, action: "instructed", artifacts: [{ id: "task:clean up" }] }));
  const handle = createHandler(store, { token: "tok", opsProject: "ops", ownerActor: { type: "human", id: "jordan@example.com", display_name: "Jordan" } });
  const res = await del(handle, `/projects/junk?confirm=junk&caused_by=${ins.event.id}`, AUTH);
  assert.equal(res.status, 200);
  const opsEvent = (await res.json()).ops_event;
  const audit = store.events.find((e) => e.id === opsEvent)!;
  assert.deepEqual(audit.actor, { type: "human", id: "jordan@example.com", display_name: "Jordan" });
  assert.equal(audit.caused_by, ins.event.id);
  assert.deepEqual(audit.method, { tool: "http", automated: false, params: { route: "DELETE /projects/:p", principal: "owner" } });
  assert.equal(audit.location?.system, "retrace-api");
  assert.match(audit.location?.url ?? "", /\/projects\/junk$/);
  const why = await (await handle(new Request(`http://test/events/${audit.id}/why`, { headers: AUTH }))).json();
  assert.deepEqual(why.map((e: Event) => e.id), [audit.id, ins.event.id]);
});

test("DELETE /projects/:p: without ownerActor the audit falls back to system/worker and is marked automated", async () => {
  const store = await seeded();
  const res = await del(createHandler(store, { token: "tok", opsProject: "ops" }), "/projects/junk?confirm=junk", AUTH);
  const opsEvent = (await res.json()).ops_event;
  const audit = store.events.find((e) => e.id === opsEvent)!;
  assert.deepEqual(audit.actor, { type: "system", id: "worker" });
  assert.equal(audit.method?.automated, true);
  assert.equal(audit.caused_by, undefined);
});

// ---- delete atomicity (B3) ----
test("DELETE /projects/:p: audit event is sealed before deletion and handed to the store in the same call", async () => {
  const store = await seeded();
  const calls: string[] = [];
  const origInsert = store.insert.bind(store);
  store.insert = async (e) => { calls.push(`insert:${e.project}`); return origInsert(e); };
  const origDelete = store.deleteProject.bind(store);
  store.deleteProject = async (p, audit, head) => { calls.push(`delete:${p}+audit:${audit.project}#${audit.seq}`); return origDelete(p, audit, head); };
  const res = await del(createHandler(store, { token: "tok", opsProject: "ops" }), "/projects/junk?confirm=junk", AUTH);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["delete:junk+audit:ops#0"]); // no separate insert — the store owns the transaction
  const [audit] = store.events.filter((e) => e.project === "ops");
  assert.equal(audit.id, (await res.json()).ops_event);
  assert.match(audit.change?.summary ?? "", /^deleted project "junk" \(2 events\) at head /);
  assert.equal((await verifyProject(store, "ops")).ok, true);
});

test("DELETE /projects/:p: if the store's transaction fails, nothing is deleted and no audit event exists", async () => {
  const store = await seeded();
  store.deleteProject = async () => { throw new Error("disk on fire"); };
  const res = await del(createHandler(store, { token: "tok", opsProject: "ops" }), "/projects/junk?confirm=junk", AUTH).catch((e) => e);
  assert.notEqual(res.status, 200);
  assert.equal(store.events.filter((e) => e.project === "junk").length, 2);
  assert.equal(store.events.filter((e) => e.project === "ops").length, 0);
});

test("DELETE /projects/:p: a concurrent ops write that takes the audit's seq rolls back and is retried onto the new head", async () => {
  const store = await seeded();
  await appendEvent(store, ev({ project: "ops", action: "deleted", artifacts: [{ id: "project:old" }] }));
  let raced = false;
  const origHead = store.head.bind(store);
  store.head = async (p) => { // after the router reads the ops head once, sneak in another ops event
    const h = await origHead(p);
    if (p === "ops" && !raced) { raced = true; await appendEvent(store, ev({ project: "ops", action: "deleted", artifacts: [{ id: "project:other" }] })); }
    return h;
  };
  const res = await del(createHandler(store, { token: "tok", opsProject: "ops" }), "/projects/junk?confirm=junk", AUTH);
  assert.equal(res.status, 200);
  const ops = store.events.filter((e) => e.project === "ops");
  assert.deepEqual(ops.map((e) => e.seq), [0, 1, 2]);
  assert.equal(ops[2].id, (await res.json()).ops_event);
  assert.equal(store.events.filter((e) => e.project === "junk").length, 0);
  assert.equal((await verifyProject(store, "ops")).ok, true);
});

test("DELETE /projects/:p: a write to the target project that races the delete is retried, and the audit records the true final head", async () => {
  const store = await seeded();
  let raced = false, lateHash: string | undefined;
  const origHead = store.head.bind(store);
  store.head = async (p) => { // after the router reads junk's head (2 events) once, a pinned-credential agent appends a 3rd
    const h = await origHead(p);
    if (p === "junk" && !raced) { raced = true; lateHash = (await appendEvent(store, ev({ artifacts: [{ id: "late" }] }))).event.hash; }
    return h;
  };
  const res = await del(createHandler(store, { token: "tok", opsProject: "ops" }), "/projects/junk?confirm=junk", AUTH);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deleted.events, 3);
  const [audit] = store.events.filter((e) => e.project === "ops");
  assert.equal(audit.id, body.ops_event);
  assert.match(audit.change?.summary ?? "", /^deleted project "junk" \(3 events\) at head .* seq 2$/);
  assert.equal(audit.change?.before_hash, lateHash); // not the stale 2-event head the first attempt was sealed from
  assert.equal(store.events.filter((e) => e.project === "junk").length, 0);
  assert.equal((await verifyProject(store, "ops")).ok, true);
});

test("DELETE /projects/:p: HeadMovedError on every attempt surfaces after the retry budget, nothing deleted", async () => {
  const store = await seeded();
  store.deleteProject = async (p, _audit, head) => { throw new HeadMovedError(p, head); };
  const res = await del(createHandler(store, { token: "tok", opsProject: "ops" }), "/projects/junk?confirm=junk", AUTH).catch((e) => e);
  assert.notEqual(res.status, 200);
  assert.equal(store.events.filter((e) => e.project === "junk").length, 2);
  assert.equal(store.events.filter((e) => e.project === "ops").length, 0);
});

// ---- per-actor credentials (backlog #6) ----
const CLAUDE = { token: "claude-code-token-0123456789", actor: { type: "agent" as const, id: "claude-code", model: "claude-fable-5", on_behalf_of: "jordan@example.com" } };
const HOOK = { token: "git-hook-token-0123456789abc", actor: { type: "system" as const, id: "retrace-git" }, trust: "assert" as const };
const post = (handle: (r: Request) => Promise<Response>, path: string, body: unknown, bearer?: string) =>
  handle(new Request(`http://test${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } }));
const get = (handle: (r: Request) => Promise<Response>, path: string, bearer?: string) =>
  handle(new Request(`http://test${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }));

test("credentials: pinned token cannot claim a human/system actor; nothing written", async () => {
  const store = new MemStore();
  const handle = createHandler(store, { token: "tok", credentials: [Credential.parse(CLAUDE)] });
  for (const type of ["human", "system"] as const) {
    const res = await post(handle, "/events", ev({ actor: { type, id: "jordan@example.com" }, action: "approved" }), CLAUDE.token);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, new RegExp(`actor.type "${type}" is not allowed.*pinned to agent "claude-code"`));
  }
  assert.equal(store.events.length, 0);
});

test("credentials: pinned token's actor is stamped from the credential, not the body", async () => {
  const store = new MemStore();
  const h = createHandler(store, { token: "tok", credentials: parseCredentials(JSON.stringify([CLAUDE, HOOK])) });
  const res = await post(h, "/events", ev({ actor: { type: "agent", id: "claude-cowork", on_behalf_of: "mallory@example.com", model: "gpt-x", display_name: "Cowork", version: "1.2" } }), CLAUDE.token);
  assert.equal(res.status, 201);
  assert.deepEqual(store.events[0].actor, { type: "agent", id: "claude-code", model: "claude-fable-5", on_behalf_of: "jordan@example.com", display_name: "Cowork", version: "1.2" });
});

test("credentials: assert-trust token and the owner token store the body actor verbatim", async () => {
  const store = new MemStore();
  const h = createHandler(store, { token: "tok", credentials: parseCredentials(JSON.stringify([CLAUDE, HOOK])) });
  const human = { type: "human" as const, id: "jordan@example.com", display_name: "Jordan" };
  assert.equal((await post(h, "/events", ev({ actor: human, action: "committed" }), HOOK.token)).status, 201);
  assert.equal((await post(h, "/events", ev({ actor: { type: "agent", id: "claude-cowork" } }), "tok")).status, 201);
  assert.deepEqual(store.events.map((e) => e.actor), [human, { type: "agent", id: "claude-cowork" }]);
});

test("credentials: Bearer only, unknown tokens 401, reads allowed, DELETE/share/gdrive forbidden for pinned tokens", async () => {
  const store = await seeded();
  const h = createHandler(store, { token: "tok", credentials: parseCredentials(JSON.stringify([CLAUDE, HOOK])), opsProject: "ops" });
  assert.equal((await get(h, `/projects?token=${CLAUDE.token}`)).status, 401); // credentials never via query string
  assert.equal((await get(h, "/projects", "nope-nope-nope-nope-nope")).status, 401);
  assert.equal((await get(h, "/projects", CLAUDE.token)).status, 200);
  assert.equal((await get(h, "/projects/junk/verify", CLAUDE.token)).status, 200);
  assert.equal((await del(h, "/projects/junk?confirm=junk", { authorization: `Bearer ${CLAUDE.token}` })).status, 403);
  assert.equal((await del(h, "/projects/junk?confirm=junk", { authorization: `Bearer ${HOOK.token}` })).status, 403);
  assert.equal((await post(h, "/projects/junk/share", { label: "x" }, CLAUDE.token)).status, 403);
  assert.equal((await post(h, "/hooks/gdrive?project=junk", { activities: [] }, CLAUDE.token)).status, 403);
  assert.equal((await post(h, "/hooks/gdrive?project=junk", { activities: [] }, HOOK.token)).status, 201);
  assert.equal(store.events.filter((e) => e.project === "junk").length, 2);
  assert.equal(store.shares.size, 1);
  const api = await (await get(h, "/api")).json();
  assert.equal(api.credentials, 2);
});

test("credentials: parseCredentials validates the secret and defaults trust to pinned", async () => {
  assert.deepEqual(parseCredentials(undefined), []);
  assert.equal(parseCredentials(JSON.stringify([CLAUDE]))[0].trust, "pinned");
  assert.throws(() => parseCredentials(JSON.stringify([{ token: "short", actor: CLAUDE.actor }])), /too_small|at least 16/i);
  assert.throws(() => parseCredentials(JSON.stringify([{ token: CLAUDE.token }])), /actor/);
  assert.throws(() => parseCredentials("{not json"));
});
