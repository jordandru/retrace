import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, parseCredentials, Credential, EventStore, Event, Share, appendEvent, EventInput, verifyProject, ChainHead, HeadMovedError, schemaSurface, Location, Action, tokenEquals, parseGithubRepoProjects, resolveGithubProject, pageHistoryNewest } from "./index.js";

/** minimal in-memory store for tests */
class MemStore implements EventStore {
  events: Event[] = []; shares = new Map<string, Share>();
  async head(p: string) { const e = this.events.filter((x) => x.project === p).at(-1); return e ? { seq: e.seq, hash: e.hash } : null; }
  async insert(e: Event) { this.events.push(e); }
  async byIdempotencyKey(p: string, k: string) { return this.events.find((e) => e.project === p && e.idempotency_key === k) ?? null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(p: string) { return this.events.filter((e) => e.project === p).sort((a, b) => a.seq - b.seq); }
  async projects() { return [...new Set(this.events.map((e) => e.project))]; }
  async history(q: any) { return pageHistoryNewest(this.events, q); }
  async createShare(s: Share) { this.shares.set(s.id, s); }
  async getShare(id: string) { return this.shares.get(id) ?? null; }
  async deleteShare(id: string) { return this.shares.delete(id); }
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

test("GET /projects/:p/status exposes the canonical transparency model", async () => {
  const store = new MemStore();
  const root = (await appendEvent(store, ev({ project: "p", actor: { type: "human", id: "jordan@example.com" }, action: "instructed", artifacts: [{ id: "task:1", role: "generated" }] }))).event;
  await appendEvent(store, ev({ project: "p", actor: { type: "agent", id: "gemini", model: "gemini-pro" }, caused_by: root.id, artifacts: [{ id: "repo:p#a.ts", role: "both" }] }));
  const res = await get(createHandler(store, { token: "tok" }), "/projects/p/status", "tok");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.integrity.ok, true);
  assert.equal(body.causality.coverage_pct, 100);
  assert.deepEqual(body.actors.map((a: any) => a.id), ["gemini", "jordan@example.com"]);
});

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
  assert.deepEqual(audit.method, { tool: "http", automated: false, params: { route: "DELETE /projects/:p", principal: "owner", sealed_by: "owner", producer_sig_verdict: "none" } });
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
const HOOK = {
  token: "git-hook-token-0123456789abc",
  actor: { type: "system" as const, id: "retrace-git" },
  trust: "assert" as const,
  allowed_actors: [{ type: "human" as const, id: "jordan@example.com" }, { type: "agent" as const, id: "claude-code" }],
};
const post = (handle: (r: Request) => Promise<Response>, path: string, body: unknown, bearer?: string) =>
  handle(new Request(`http://test${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } }));
const get = (handle: (r: Request) => Promise<Response>, path: string, bearer?: string) =>
  handle(new Request(`http://test${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }));

test("credentials: pinned token cannot claim a system actor or misuse a human one; nothing written", async () => {
  const store = new MemStore();
  const handle = createHandler(store, { token: "tok", credentials: [Credential.parse(CLAUDE)] });
  const cases: [any, RegExp][] = [
    [ev({ actor: { type: "system", id: "worker" }, action: "approved" }), /actor.type "system" is not allowed.*pinned to agent "claude-code"/],
    [ev({ actor: { type: "human", id: "mallory@example.com" }, action: "instructed" }), /human "mallory@example.com" is not allowed.*only relay instructions from its operator "jordan@example.com"/],
    [ev({ actor: { type: "human", id: "jordan@example.com" }, action: "approved" }), /action "approved" is not allowed for a human actor.*only record "instructed" roots/],
  ];
  for (const [body, re] of cases) {
    const res = await post(handle, "/events", body, CLAUDE.token);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, re);
  }
  assert.equal(store.events.length, 0);
});

test("credentials: pinned agent token records an instructed root for its on_behalf_of human, stamped with relayed_by", async () => {
  const store = new MemStore();
  const handle = createHandler(store, { token: "tok", credentials: [Credential.parse(CLAUDE)] });
  const body = ev({
    actor: { type: "human", id: "jordan@example.com", display_name: "Jordan", model: "sneaky-model", on_behalf_of: "mallory@example.com" },
    action: "instructed",
    method: { tool: "chat", automated: false },
  });
  const res = await post(handle, "/events", body, CLAUDE.token);
  assert.equal(res.status, 201);
  const e = store.events[0];
  assert.deepEqual(e.actor, { type: "human", id: "jordan@example.com", display_name: "Jordan" }); // model/on_behalf_of from the body are dropped
  assert.equal(e.method?.params?.relayed_by, "claude-code");
  assert.equal(e.method?.tool, "chat");
});

test("credentials: a pinned agent credential without on_behalf_of cannot record human instructed roots", async () => {
  const store = new MemStore();
  const bare = Credential.parse({ token: "bare-agent-token-0123456789", actor: { type: "agent", id: "claude-code" } });
  const res = await post(createHandler(store, { token: "tok", credentials: [bare] }), "/events", ev({ actor: { type: "human", id: "jordan@example.com" }, action: "instructed" }), bare.token);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /no on_behalf_of human configured.*RETRACE_CREDENTIALS/);
  assert.equal(store.events.length, 0);
});

test("credentials: pinned token's actor is stamped from the credential, not the body", async () => {
  const store = new MemStore();
  const h = createHandler(store, { token: "tok", credentials: parseCredentials(JSON.stringify([CLAUDE, HOOK])) });
  const res = await post(h, "/events", ev({ actor: { type: "agent", id: "claude-cowork", on_behalf_of: "mallory@example.com", model: "gpt-x", display_name: "Cowork", version: "1.2" } }), CLAUDE.token);
  assert.equal(res.status, 201);
  assert.deepEqual(store.events[0].actor, { type: "agent", id: "claude-code", model: "claude-fable-5", on_behalf_of: "jordan@example.com", display_name: "Cowork", version: "1.2" });
});

test("credentials: a pinned credential that omits model lets the producer report the model it actually ran", async () => {
  const store = new MemStore();
  const NO_MODEL = { ...CLAUDE, actor: { type: "agent" as const, id: "claude-code", on_behalf_of: "jordan@example.com" } };
  const h = createHandler(store, { token: "tok", credentials: parseCredentials(JSON.stringify([NO_MODEL, HOOK])) });
  const res = await post(h, "/events", ev({ actor: { type: "agent", id: "claude-cowork", on_behalf_of: "mallory@example.com", model: "claude-opus-5" } }), NO_MODEL.token);
  assert.equal(res.status, 201);
  // identity is still stamped from the credential and stays unforgeable — only the model gets through
  assert.deepEqual(store.events[0].actor, { type: "agent", id: "claude-code", on_behalf_of: "jordan@example.com", model: "claude-opus-5" });
});

test("credentials: model passthrough is agent-only", async () => {
  const store = new MemStore();
  const HUMAN = { token: "human-token-0123456789abcd", actor: { type: "human" as const, id: "jordan@example.com" } };
  const h = createHandler(store, { credentials: parseCredentials(JSON.stringify([HUMAN])) });
  const res = await post(h, "/events", ev({ actor: { type: "human", id: "mallory@example.com", model: "sneaky-model", display_name: "Jordan" } }), HUMAN.token);
  assert.equal(res.status, 201);
  assert.deepEqual(store.events[0].actor, { type: "human", id: "jordan@example.com", display_name: "Jordan" });
});

test("credentials: assert-trust token and the owner token store the body actor verbatim", async () => {
  const store = new MemStore();
  const h = createHandler(store, { token: "tok", credentials: parseCredentials(JSON.stringify([CLAUDE, HOOK])) });
  const human = { type: "human" as const, id: "jordan@example.com", display_name: "Jordan" };
  assert.equal((await post(h, "/events", ev({ actor: human, action: "committed", method: { tool: "git" } }), HOOK.token)).status, 201);
  assert.equal((await post(h, "/events", ev({ actor: { type: "agent", id: "claude-cowork" } }), "tok")).status, 201);
  assert.deepEqual(store.events.map((e) => e.actor), [human, { type: "agent", id: "claude-cowork" }]);
  // an assert-trust credential RELAYS the human verbatim — it must not get the carve-out's relayed_by stamp
  assert.equal(store.events[0].method?.tool, "git");
  assert.equal(store.events[0].method?.params?.relayed_by, undefined, "assert-trust human events are not relayed instruct roots");
  assert.match(String(store.events[0].method?.params?.sealed_by), /^assert:/, "but every write is stamped with who sealed it");
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

test("credentials: assert token may only record actors in its allowed_actors list; forgeries write nothing", async () => {
  const store = new MemStore();
  const h = createHandler(store, { token: "tok", credentials: parseCredentials(JSON.stringify([CLAUDE, HOOK])) });
  // in-list actors pass (exact type + id)
  assert.equal((await post(h, "/events", ev({ actor: { type: "human", id: "jordan@example.com" }, action: "committed" }), HOOK.token)).status, 201);
  assert.equal((await post(h, "/events", ev({ actor: { type: "agent", id: "claude-code", model: "claude-fable-5" } }), HOOK.token)).status, 201);
  // forged human not in the list
  const forgedHuman = await post(h, "/events", ev({ actor: { type: "human", id: "mallory@example.com" }, action: "approved" }), HOOK.token);
  assert.equal(forgedHuman.status, 403);
  assert.match((await forgedHuman.json()).error, /actor human "mallory@example.com" is not in this credential's allowed_actors/);
  // same id, wrong type: listing human jordan does not allow asserting agent jordan
  assert.equal((await post(h, "/events", ev({ actor: { type: "agent", id: "jordan@example.com" } }), HOOK.token)).status, 403);
  assert.equal(store.events.length, 2);
});

test("credentials: assert token without allowed_actors may assert nothing on POST /events", async () => {
  const store = new MemStore();
  const bareHook = Credential.parse({ token: "bare-hook-token-0123456789ab", actor: { type: "system", id: "retrace-git" }, trust: "assert" });
  const h = createHandler(store, { token: "tok", credentials: [bareHook], opsProject: "ops" });
  for (const actor of [{ type: "human" as const, id: "jordan@example.com" }, { type: "system" as const, id: "retrace-git" }]) {
    const res = await post(h, "/events", ev({ actor, action: "committed" }), bareHook.token);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /allowed_actors/);
  }
  assert.equal(store.events.length, 0);
  // routes that map actors server-side are unaffected by the allow-list
  assert.equal((await post(h, "/hooks/gdrive?project=junk", { activities: [] }, bareHook.token)).status, 201);
});

test("credentials: pinned path regression — allowed_actors changes nothing for pinned tokens", async () => {
  const store = new MemStore();
  const h = createHandler(store, { token: "tok", credentials: parseCredentials(JSON.stringify([CLAUDE, HOOK])) });
  // pinned agent still stamped from the credential
  assert.equal((await post(h, "/events", ev({ actor: { type: "agent", id: "whoever" } }), CLAUDE.token)).status, 201);
  assert.deepEqual(store.events[0].actor, { type: "agent", id: "claude-code", model: "claude-fable-5", on_behalf_of: "jordan@example.com" });
  // pinned instructed-root carve-out (e0b6499) still works and still stamps relayed_by
  const res = await post(h, "/events", ev({ actor: { type: "human", id: "jordan@example.com" }, action: "instructed" }), CLAUDE.token);
  assert.equal(res.status, 201);
  assert.deepEqual(store.events[1].actor, { type: "human", id: "jordan@example.com" });
  assert.equal(store.events[1].method?.params?.relayed_by, "claude-code");
});

test("credentials: parseCredentials validates the secret and defaults trust to pinned", async () => {
  assert.deepEqual(parseCredentials(undefined), []);
  assert.equal(parseCredentials(JSON.stringify([CLAUDE]))[0].trust, "pinned");
  assert.throws(() => parseCredentials(JSON.stringify([{ token: "short", actor: CLAUDE.actor }])), /too_small|at least 16/i);
  assert.throws(() => parseCredentials(JSON.stringify([{ token: CLAUDE.token }])), /actor/);
  assert.throws(() => parseCredentials("{not json"));
});

// ---- schema probe: the only defence against a silently-stale deployment ----

test("POST /hooks/gdrive: optional caused_by is stored; empty/absent stays a root", async () => {
  const store = new MemStore();
  const h = createHandler(store, { token: "tok", credentials: parseCredentials(JSON.stringify([HOOK])) });
  const activity = (ts: string) => ({
    primaryActionDetail: { edit: {} },
    actors: [{ user: { knownUser: { personName: "people/111" } } }],
    targets: [{ driveItem: { name: "items/DOC1", title: "Untitled document", mimeType: "application/vnd.google-apps.document" } }],
    timestamp: ts,
  });
  const actors = { "people/111": { email: "jordan@example.com", name: "Jordan" } };
  const body = (over: Record<string, unknown>, ts: string) => ({ source: "apps-script", actors, activities: [activity(ts)], ...over });

  const absent = await post(h, "/hooks/gdrive?project=retrace", body({}, "2026-08-29T12:00:00.000Z"), HOOK.token);
  assert.equal(absent.status, 201);
  assert.equal(store.events[0].caused_by, undefined);
  assert.equal(store.events[0].action, "edited");
  assert.equal(store.events[0].artifacts[0].id, "gdoc:DOC1");
  assert.equal(store.events[0].change?.summary, "edited");

  const dangling = await post(h, "/hooks/gdrive?project=retrace", body({ caused_by: "evt_abc123" }, "2026-08-29T12:01:00.000Z"), HOOK.token);
  assert.equal(dangling.status, 201);
  assert.equal(store.events.at(-1)!.caused_by, "evt_abc123");
  assert.ok(store.events.at(-1)!.tags?.includes("caused_by:unverified"));
  assert.equal(store.events.at(-1)!.method?.params?.caused_by_problem, "missing");

  const ins = await post(h, "/events", ev({ project: "retrace", action: "instructed", actor: { type: "human", id: "jordan@example.com" }, artifacts: [{ id: "task:1" }] }), "tok");
  assert.equal(ins.status, 201);
  const parent = (await ins.json()).event.id;
  const linked = await post(h, "/hooks/gdrive?project=retrace", body({ caused_by: parent }, "2026-08-29T12:01:30.000Z"), HOOK.token);
  assert.equal(linked.status, 201);
  assert.equal(store.events.at(-1)!.caused_by, parent);
  // Activity timestamp predates the instruct — keep the link, mark not_older (do not drop the Drive event).
  assert.ok(store.events.at(-1)!.tags?.includes("caused_by:unverified"));
  assert.equal(store.events.at(-1)!.method?.params?.caused_by_problem, "not_older");

  const empty = await post(h, "/hooks/gdrive?project=retrace", body({ caused_by: "   " }, "2026-08-29T12:02:00.000Z"), HOOK.token);
  assert.equal(empty.status, 201);
  assert.equal(store.events.at(-1)!.caused_by, undefined);
});

test("schemaSurface is derived from the zod shapes, so it cannot drift from the code", () => {
  const surface = schemaSurface();
  // Derived, not hand-listed: adding a field to Location must show up here with no other edit. If someone replaces
  // this with a literal array, this assertion is what fails.
  assert.deepEqual(surface.location, Object.keys(Location.shape).sort());
  assert.deepEqual(surface.actions, [...Action.options].sort());
  // The fields whose silent loss motivated the probe.
  for (const f of ["session", "client", "ide", "workspace", "surface", "device", "system"]) assert.ok(surface.location.includes(f), f);
  for (const f of ["actor", "action", "artifacts", "location", "caused_by", "idempotency_key"]) assert.ok(surface.event.includes(f), f);
  assert.ok(surface.artifact.includes("role"));
});

test("GET /api publishes the schema surface, unauthenticated, and it matches this build", async () => {
  const store = new MemStore();
  const handle = createHandler(store, { token: "secret" });
  // No authorization header: a deployment must be checkable by someone holding no credential for it.
  const res = await handle(new Request("https://x/api"));
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.name, "retrace-api");
  assert.deepEqual(body.schema, schemaSurface(), "what the deployment reports is what the deployment can parse");
  // The comparison check-deploy performs: every local field present in the probe.
  const missing = Object.entries(schemaSurface()).flatMap(([g, keys]) =>
    (keys as string[]).filter((k) => !body.schema[g].includes(k)).map((k) => `${g}.${k}`));
  assert.deepEqual(missing, []);
});

test("requireAuth: a cloud handler with no owner token or credentials fails closed", async () => {
  const store = new MemStore();
  const handle = createHandler(store, { requireAuth: true });
  const requests = [
    new Request("https://x/api"),
    new Request("https://x/projects"),
    new Request("https://x/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev({ project: "public" })),
    }),
    new Request("https://x/projects/public?confirm=public", { method: "DELETE" }),
  ];
  for (const req of requests) {
    const res = await handle(req);
    assert.equal(res.status, 503, `${req.method} ${new URL(req.url).pathname}`);
    assert.deepEqual(await res.json(), { error: "server authentication is not configured" });
  }
  assert.equal(store.events.length, 0, "a missing Worker secret cannot write anything");

  const configured = createHandler(store, { requireAuth: true, token: "secret" });
  assert.equal((await configured(new Request("https://x/api"))).status, 200, "configured deployments retain the public schema probe");
});

test("POST /events: dangling caused_by is sealed with the link kept, not 400", async () => {
  const store = new MemStore();
  const h = createHandler(store, { token: "tok" });
  const missing = await post(h, "/events", ev({ caused_by: "evt_deadbeefdeadbeefdeadbeefdeadbeef" }), "tok");
  assert.equal(missing.status, 201);
  const sealed = (await missing.json()).event;
  assert.equal(sealed.caused_by, "evt_deadbeefdeadbeefdeadbeefdeadbeef");
  assert.ok(sealed.tags.includes("caused_by:unverified"));
  assert.equal(sealed.method.params.caused_by_problem, "missing");
  const root = await post(h, "/events", ev({ action: "instructed", actor: { type: "human", id: "jordan@example.com" }, artifacts: [{ id: "task:1" }] }), "tok");
  assert.equal(root.status, 201);
  const id = (await root.json()).event.id;
  const child = await post(h, "/events", ev({ caused_by: id }), "tok");
  assert.equal(child.status, 201);
  assert.equal(store.events.at(-1)!.caused_by, id);
  assert.ok(!store.events.at(-1)!.tags?.includes("caused_by:unverified"));
});

test("POST /events: reserved adapter idempotency prefixes cannot shadow the git hook", async () => {
  const store = new MemStore();
  const h = createHandler(store, { token: "tok" });
  const planted = await post(h, "/events", ev({ idempotency_key: "git:deadbeefcafe", action: "edited", method: { tool: "Edit" } }), "tok");
  assert.equal(planted.status, 400);
  assert.match((await planted.json()).error, /git:/);
  assert.equal(store.events.length, 0);
  const hook = await post(h, "/events", ev({
    action: "committed", method: { tool: "git" }, idempotency_key: "git:deadbeefcafe",
    artifacts: [{ id: "commit:junk@deadbeefcafe", kind: "commit" }],
    actor: { type: "human", id: "jordan@example.com" },
  }), "tok");
  assert.equal(hook.status, 201);
  assert.equal(store.events[0].action, "committed");
});

test("POST /events silently strips unknown keys — the exact failure the probe exists to surface", async () => {
  const store = new MemStore();
  const handle = createHandler(store, { token: "secret" });
  const res = await handle(new Request("https://x/events", {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({
      project: "p", actor: { type: "human", id: "j" }, action: "edited",
      artifacts: [{ id: "a" }],
      location: { path: "/x", a_field_from_a_newer_build: "gone" },
    }),
  }));
  assert.equal(res.status, 201);
  const stored = store.events[0];
  assert.equal(stored.location?.path, "/x");
  assert.ok(!("a_field_from_a_newer_build" in (stored.location ?? {})),
    "accepted, sealed and hashed WITHOUT the field, and with no error anywhere — hence GET /api");
});

test("POST /events stamps method.params.sealed_by server-side: owner, pinned:<name>, assert:<name>; a caller value is overwritten; status counts them", async () => {
  const store = new MemStore();
  const creds = parseCredentials(JSON.stringify([
    { token: "pinnedtoken12345", name: "claude-code MCP (pinned)", actor: { type: "agent", id: "claude-code", on_behalf_of: "jordan@example.com" } },
    { token: "asserttoken12345", trust: "assert", actor: { type: "system", id: "retrace-git" }, allowed_actors: [{ type: "human", id: "jordan@example.com" }] },
    { token: "unnamedpin123456", actor: { type: "agent", id: "codex" } },
  ]));
  const h = createHandler(store, { token: "tok", credentials: creds });
  const owner = await post(h, "/events", ev({ project: "p", method: { tool: "curl", params: { sealed_by: "pinned:forged" } } }), "tok");
  assert.equal(owner.status, 201);
  assert.equal((await owner.json()).event.method.params.sealed_by, "owner", "server wins over a caller-supplied sealed_by");
  const pinned = await post(h, "/events", ev({ project: "p", actor: { type: "agent", id: "whatever" } }), "pinnedtoken12345");
  assert.equal(pinned.status, 201);
  const pe = (await pinned.json()).event;
  assert.equal(pe.actor.id, "claude-code");
  assert.equal(pe.method.params.sealed_by, "pinned:claude-code MCP (pinned)");
  const unnamed = await post(h, "/events", ev({ project: "p" }), "unnamedpin123456");
  assert.equal((await unnamed.json()).event.method.params.sealed_by, "pinned:agent/codex", "unnamed credentials fall back to type/id");
  const asserted = await post(h, "/events", ev({ project: "p", actor: { type: "human", id: "jordan@example.com" }, action: "committed", method: { tool: "git" }, artifacts: [{ id: "commit:p@abc" }] }), "asserttoken12345");
  assert.equal(asserted.status, 201);
  assert.equal((await asserted.json()).event.method.params.sealed_by, "assert:system/retrace-git");
  const st = await (await get(h, "/projects/p/status", "tok")).json();
  assert.deepEqual(st.capture.sealed_by, { pinned: 2, assert: 1, webhook: 0, owner: 1, unauthenticated: 0, unstamped: 0 });
  assert.equal(st.capture.agent_events_not_pinned, 1, "the owner-asserted agent event is the one a skeptic cannot trust");
});

// ---- security assessment 2026-08-30 (evt_5e0caa58) — Grok follow-up on router/store ----

async function ghSigned(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "sha256=" + [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("tokenEquals is length-independent and matches only equal strings", async () => {
  assert.equal(await tokenEquals("tok", "tok"), true);
  assert.equal(await tokenEquals("tok", "tok2"), false);
  assert.equal(await tokenEquals("", "tok"), false);
});

test("resolveGithubProject never takes ?project=; unmapped repo uses full_name; mapped repo is allow-listed", () => {
  assert.deepEqual(resolveGithubProject("jordandru/retrace", undefined), { project: "jordandru/retrace" });
  assert.deepEqual(resolveGithubProject("jordandru/retrace", { "jordandru/retrace": "retrace" }), { project: "retrace" });
  assert.match((resolveGithubProject("evil/repo", { "jordandru/retrace": "retrace" }) as any).error, /not in RETRACE_GITHUB_PROJECTS/);
  assert.deepEqual(parseGithubRepoProjects('{"a/b":"p"}'), { "a/b": "p" });
});

test("POST /hooks/github: project comes from HMAC-covered repo, not ?project=; delivery cannot replay across projects", async () => {
  const store = new MemStore();
  const h = createHandler(store, { token: "tok", githubSecret: "s3cret", githubRepoProjects: { "jordandru/retrace": "retrace" } });
  const payload = JSON.stringify({
    action: "opened",
    repository: { full_name: "jordandru/retrace" },
    sender: { login: "jordandru" },
    pull_request: { number: 1, title: "t", html_url: "https://github.com/jordandru/retrace/pull/1", updated_at: "2026-08-30T00:00:00Z", head: { sha: "abc", ref: "f" }, base: { ref: "main" } },
  });
  const sig = await ghSigned("s3cret", payload);
  const replay = (projectQ: string) => h(new Request(`http://test/hooks/github?project=${projectQ}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig, "x-github-event": "pull_request", "x-github-delivery": "deliv-1" },
    body: payload,
  }));
  const first = await replay("attacker");
  assert.equal(first.status, 201);
  assert.equal((await first.json()).project, "retrace");
  assert.equal(store.events[0].project, "retrace");
  const second = await replay("other");
  assert.equal(second.status, 201);
  assert.equal((await second.json()).logged[0].deduped, true, "same delivery+project is idempotent");
  // unknown repo with a map configured is 403 even with a valid signature
  const otherRepo = JSON.stringify({ ...JSON.parse(payload), repository: { full_name: "evil/repo" } });
  const otherSig = await ghSigned("s3cret", otherRepo);
  const blocked = await h(new Request("http://test/hooks/github?project=retrace", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": otherSig, "x-github-event": "pull_request", "x-github-delivery": "deliv-2" },
    body: otherRepo,
  }));
  assert.equal(blocked.status, 403);
  await appendEvent(store, ev({
    project: "other",
    idempotency_key: "gh:deliv-cross",
    method: { tool: "github" },
    tags: ["github"],
    artifacts: [{ id: "pr:jordandru/retrace#9" }],
  }));
  const cross = await h(new Request("http://test/hooks/github", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig, "x-github-event": "pull_request", "x-github-delivery": "deliv-cross" },
    body: payload,
  }));
  assert.equal(cross.status, 409);
});

test("POST /hooks/gdrive: assert credential applies allowed_actors to the mapped actors map", async () => {
  const store = new MemStore();
  const h = createHandler(store, { token: "tok", credentials: parseCredentials(JSON.stringify([HOOK])) });
  const activity = (person: string) => ({
    primaryActionDetail: { edit: {} },
    actors: [{ user: { knownUser: { personName: person } } }],
    targets: [{ driveItem: { name: "items/DOC1", title: "doc", mimeType: "application/vnd.google-apps.document" } }],
    timestamp: "2026-08-30T12:00:00.000Z",
  });
  const ok = await post(h, "/hooks/gdrive?project=retrace", { actors: { "people/111": { email: "jordan@example.com" } }, activities: [activity("people/111")] }, HOOK.token);
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).logged, 1);
  const forged = await post(h, "/hooks/gdrive?project=retrace", { actors: { "people/222": { email: "mallory@example.com" } }, activities: [activity("people/222")] }, HOOK.token);
  assert.equal(forged.status, 201);
  const body = await forged.json();
  assert.equal(body.logged, 0);
  assert.match(body.results[0].error, /mallory@example.com.*allowed_actors/);
  assert.equal(store.events.length, 1);
});

test("?token= is accepted on GET only; POST/DELETE need Bearer", async () => {
  const store = await seeded();
  const h = createHandler(store, { token: "tok", opsProject: "ops" });
  assert.equal((await get(h, "/projects?token=tok")).status, 200);
  assert.equal((await post(h, "/events?token=tok", ev({}))).status, 401);
  assert.equal((await del(h, "/projects/junk?confirm=junk&token=tok")).status, 401);
  assert.equal(store.events.filter((e) => e.project === "junk").length, 2);
});

test("credentials.projects scopes POST and reads; unset still sees every project", async () => {
  const store = await seeded();
  const scoped = Credential.parse({ token: "scoped-token-01234567", actor: { type: "agent", id: "codex" }, projects: ["keep"] });
  const h = createHandler(store, { token: "tok", credentials: [scoped] });
  assert.equal((await post(h, "/events", ev({ project: "junk" }), scoped.token)).status, 403);
  assert.equal((await post(h, "/events", ev({ project: "keep" }), scoped.token)).status, 201);
  const list = await (await get(h, "/projects", scoped.token)).json();
  assert.deepEqual(list, ["keep"]);
  assert.equal((await get(h, "/projects/junk/events", scoped.token)).status, 403);
  const keepEvt = store.events.find((e) => e.project === "keep")!;
  assert.equal((await get(h, `/events/${keepEvt.id}`, scoped.token)).status, 200);
  const junkEvt = store.events.find((e) => e.project === "junk")!;
  assert.equal((await get(h, `/events/${junkEvt.id}`, scoped.token)).status, 404);
});

test("POST /events strips caller relayed_by and location.client on non-relayed paths", async () => {
  const store = new MemStore();
  const h = createHandler(store, { token: "tok", credentials: parseCredentials(JSON.stringify([CLAUDE])) });
  const res = await post(h, "/events", ev({
    method: { tool: "Edit", params: { relayed_by: "forged-agent", sealed_by: "pinned:forged" } },
    location: { client: "forged-client", path: "/x" },
  }), CLAUDE.token);
  assert.equal(res.status, 201);
  const e = (await res.json()).event;
  assert.equal(e.method.params.relayed_by, undefined);
  assert.equal(e.method.params.sealed_by, "pinned:agent/claude-code");
  assert.equal(e.location.client, undefined);
  assert.equal(e.location.path, "/x");
});

test("share: expires_in_days is bounded, created_by is not taken from the client, meta hides it, DELETE revokes", async () => {
  const store = await seeded();
  const h = createHandler(store, { token: "tok", ownerActor: { type: "human", id: "jordan@example.com" } });
  assert.equal((await post(h, "/projects/junk/share", { expires_in_days: 0 }, "tok")).status, 400);
  assert.equal((await post(h, "/projects/junk/share", { expires_in_days: 9999 }, "tok")).status, 400);
  const created = await post(h, "/projects/junk/share", { label: "pub", created_by: "mallory" }, "tok");
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.share.created_by, undefined);
  const id = body.share.id;
  const meta = await (await get(h, `/s/${id}/meta`)).json();
  assert.equal(meta.created_by, undefined);
  assert.equal(meta.label, "pub");
  const gone = await del(h, `/s/${id}`, AUTH);
  assert.equal(gone.status, 200);
  assert.equal((await get(h, `/s/${id}/meta`)).status, 404);
});

test("GET /s/:id/verify is cached by share id + head hash", async () => {
  const store = await seeded();
  const h = createHandler(store, { token: "tok" });
  const a = await get(h, "/s/sh_1/verify");
  assert.equal(a.status, 200);
  assert.equal(a.headers.get("x-retrace-share-cache"), "miss");
  const b = await get(h, "/s/sh_1/verify");
  assert.equal(b.status, 200);
  assert.equal(b.headers.get("x-retrace-share-cache"), "hit");
  assert.deepEqual(await b.json(), await a.json());
  await appendEvent(store, ev({}));
  const c = await get(h, "/s/sh_1/verify");
  assert.equal(c.headers.get("x-retrace-share-cache"), "miss");
});

test("500 handler does not echo the internal error text", async () => {
  const store = new MemStore();
  store.projects = async () => { throw new Error("SQL boom /secret/path"); };
  const h = createHandler(store, { token: "tok" });
  const res = await get(h, "/projects", "tok");
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /^internal error \(ref [0-9a-f]{8}\)$/);
  assert.equal(body.error.includes("SQL"), false);
  assert.equal(body.error.includes("/secret/path"), false);
});

test("GET /projects/:p/events returns a newest-window page, not a genesis prefix", async () => {
  const store = new MemStore();
  const h = createHandler(store, { token: "tok" });
  for (let i = 0; i < 5; i++) await appendEvent(store, ev({ project: "p", artifacts: [{ id: `a${i}` }] }));
  const page = await (await get(h, "/projects/p/events?limit=2", "tok")).json();
  assert.equal(page.truncated, true);
  assert.deepEqual(page.events.map((e: { seq: number }) => e.seq), [3, 4]);
  assert.equal(page.next_before_seq, 3);
  const older = await (await get(h, "/projects/p/events?limit=2&before_seq=3", "tok")).json();
  assert.deepEqual(older.events.map((e: { seq: number }) => e.seq), [1, 2]);
  assert.equal(older.truncated, true);
  const rest = await (await get(h, "/projects/p/events?limit=2&before_seq=1", "tok")).json();
  assert.deepEqual(rest.events.map((e: { seq: number }) => e.seq), [0]);
  assert.equal(rest.truncated, false);
  assert.equal((await get(h, "/projects/p/events?before_seq=-1", "tok")).status, 400);
});
