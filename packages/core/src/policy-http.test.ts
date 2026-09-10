import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, MemoryEventStore, POLICY_PROFILE, appendEvent, EventInput, generateSigningKey, publicFromPrivate, signProducer, PRODUCER_SIG_FORMAT_V2 } from "./index.js";

const ev = (over: Partial<EventInput>): EventInput => ({ project: "p", actor: { type: "agent", id: "claude" }, action: "edited", artifacts: [{ id: "a" }], ...over });

function body(over: Record<string, unknown> = {}) {
  return {
    profile: POLICY_PROFILE,
    project: "p",
    trusted_hook_stamps: ["assert:git hook (assert)"],
    unresolved_claims: "record",
    repositories: [{ name: "acme/app", aliases: ["app"] }],
    github_repos: ["acme/app"],
    ...over,
  };
}

const owner = { authorization: "Bearer owner-token-long-enough" };

function handler(store = new MemoryEventStore(), extra: Record<string, unknown> = {}) {
  return {
    store,
    h: createHandler(store, {
      token: "owner-token-long-enough",
      ownerPrincipal: { type: "human", id: "owner@example.com" },
      ownerActor: { type: "human", id: "owner@example.com" },
      credentials: [
        { token: "pinned-token-long-enough", trust: "pinned", actor: { type: "agent", id: "codex" }, projects: ["p"] },
        { token: "assert-token-long-enough", trust: "assert", actor: { type: "agent", id: "hook" }, projects: ["p"], allowed_actors: [{ type: "agent", id: "claude" }, { type: "agent", id: "hook" }] },
        { token: "admin-named-token-ok", trust: "pinned", name: "admin", actor: { type: "agent", id: "admin-bot" }, projects: ["p"] },
      ],
      ...extra,
    }),
  };
}

async function put(h: (r: Request) => Promise<Response>, project: string, raw: string, ifMatch: string, extra: Record<string, string> = {}) {
  return h(new Request(`http://test/projects/${project}/policy`, {
    method: "PUT",
    headers: { ...owner, "content-type": "application/json", "if-match": ifMatch, ...extra },
    body: raw,
  }));
}

test("P1: authority, If-Match, no-op, v2, team owner, serve without owner → 403", async () => {
  const { store, h } = handler();
  const raw = JSON.stringify(body());
  for (const tok of ["pinned-token-long-enough", "assert-token-long-enough", "admin-named-token-ok"]) {
    const res = await h(new Request("http://test/projects/p/policy", {
      method: "PUT",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "if-match": "none" },
      body: raw,
    }));
    assert.equal(res.status, 403, tok);
  }
  const noOwner = createHandler(new MemoryEventStore(), { token: "owner-token-long-enough" });
  assert.equal((await put(noOwner, "p", raw, "none")).status, 403);

  const dupKeys = await put(h, "p", '{"profile":"retrace-project-policy/1","profile":"retrace-project-policy/1","project":"p","trusted_hook_stamps":[],"unresolved_claims":"record","repositories":[],"github_repos":[]}', "none");
  assert.equal(dupKeys.status, 400);

  const created = await put(h, "p", raw, "none");
  assert.equal(created.status, 201);
  const doc = await created.json() as any;
  assert.equal(doc.envelope.version, 1);
  assert.equal(doc.envelope.set_by.type, "human");
  const act = store.events.find((e) => e.idempotency_key === "policy:p:1")!;
  assert.equal(act.actor.type, "system");
  assert.equal(act.actor.id, "retrace-api");
  assert.equal(act.actor.on_behalf_of, "human:owner@example.com");
  assert.equal((act.method?.params?.set_by as { type: string }).type, "human");
  assert.equal(act.method?.params?.sealed_by, "owner");

  const noop = await put(h, "p", raw, doc.digest);
  assert.equal(noop.status, 200);
  assert.equal(store.events.filter((e) => (e.idempotency_key ?? "").startsWith("policy:")).length, 1);

  const stale = await put(h, "p", raw, "none");
  assert.equal(stale.status, 412);

  const v2body = { ...body(), trusted_hook_stamps: ["assert:git hook (assert)", "assert:release-recorder"] };
  const v2 = await put(h, "p", JSON.stringify(v2body), doc.digest);
  assert.equal(v2.status, 201);
  const d2 = await v2.json() as any;
  assert.equal(d2.envelope.version, 2);
  assert.equal(d2.envelope.supersedes, doc.digest);

  const teamStore = new MemoryEventStore();
  const teamH = createHandler(teamStore, { token: "owner-token-long-enough", ownerPrincipal: { type: "team", id: "acme" } });
  const team = await put(teamH, "p", raw, "none");
  assert.equal(team.status, 201);
  const te = teamStore.events[0]!;
  assert.equal(te.actor.on_behalf_of, "team:acme");
  assert.equal((te.method?.params?.set_by as { type: string; id: string }).type, "team");
  assert.equal((te.method?.params?.set_by as { type: string; id: string }).id, "acme");
});

test("P1: concurrent PUTs with the same If-Match → one 201 and one 412", async () => {
  const { store, h } = handler();
  const first = await put(h, "p", JSON.stringify(body()), "none");
  const d1 = await first.json() as any;
  const a = { ...body(), trusted_hook_stamps: ["assert:a"] };
  const b = { ...body(), trusted_hook_stamps: ["assert:b"] };
  const [r1, r2] = await Promise.all([
    put(h, "p", JSON.stringify(a), d1.digest),
    put(h, "p", JSON.stringify(b), d1.digest),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 412]);
  assert.equal(store.policies.filter((p) => p.body.project === "p").length, 2);
});

test("P4: policy: prefix rejected at ingress from every credential including owner", async () => {
  const { h } = handler();
  const payload = ev({
    project: "p",
    action: "created",
    idempotency_key: "policy:p:9",
    method: { tool: "retrace-api", params: { sealed_by: "owner" } },
    artifacts: [{ id: "policy:p@dead", kind: "policy" }],
  });
  for (const tok of ["owner-token-long-enough", "pinned-token-long-enough", "assert-token-long-enough"]) {
    const res = await h(new Request("http://test/events", {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }));
    assert.equal(res.status, 400, tok);
    assert.match(await res.text(), /policy:/);
  }
});

test("GET policy is constrained to :p; history and routes", async () => {
  const { h } = handler();
  const other = new MemoryEventStore();
  const h2 = createHandler(other, { token: "owner-token-long-enough", ownerPrincipal: { type: "human", id: "o" } });
  const a = await (await put(h, "p", JSON.stringify(body()), "none")).json() as any;
  const b = await (await put(h2, "q", JSON.stringify({ ...body(), project: "q", github_repos: ["acme/q"], repositories: [{ name: "acme/q", aliases: [] }] }), "none")).json() as any;
  const miss = await h(new Request(`http://test/projects/p/policy?digest=${b.digest}`, { headers: owner }));
  assert.equal(miss.status, 404);
  const hit = await h(new Request(`http://test/projects/p/policy?digest=${a.digest}`, { headers: owner }));
  assert.equal(hit.status, 200);
  const hist = await h(new Request("http://test/projects/p/policy/history", { headers: owner }));
  assert.equal((await hist.json() as any[]).length, 1);
  const routes = await h(new Request("http://test/projects/p/routes", { headers: owner }));
  assert.equal((await routes.json() as any[])[0].state, "active");
});

async function ghSigned(secret: string, payload: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return "sha256=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("P5: stored route wins; env only for unbootstrapped no-row; revoked; reassign; unresolved before 202", async () => {
  const store = new MemoryEventStore();
  const h = createHandler(store, {
    token: "owner-token-long-enough",
    ownerPrincipal: { type: "human", id: "o" },
    githubSecret: "s3cret",
    githubRepoProjects: { "acme/envb": "b", "acme/app": "p" },
  });
  const opened = (full: string) => JSON.stringify({
    action: "opened", repository: { full_name: full }, sender: { login: "j" },
    pull_request: { number: 1, title: "t", html_url: "https://x", updated_at: "2026-08-30T00:00:00Z", head: { sha: "abc", ref: "f" }, base: { ref: "main" } },
  });
  const post = async (full: string, delivery: string) => {
    const payload = opened(full);
    return h(new Request("http://test/hooks/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": await ghSigned("s3cret", payload), "x-github-event": "pull_request", "x-github-delivery": delivery },
      body: payload,
    }));
  };
  const envOnly = await post("acme/envb", "d-env");
  assert.equal(envOnly.status, 201);
  assert.equal((await envOnly.json() as any).project, "b");

  await put(h, "p", JSON.stringify(body({ github_repos: ["acme/app", "acme/envb"], repositories: [{ name: "acme/app", aliases: [] }, { name: "acme/envb", aliases: [] }] })), "none");
  const viaPolicy = await post("acme/envb", "d-pol");
  assert.equal(viaPolicy.status, 201);
  assert.equal((await viaPolicy.json() as any).project, "p");

  const cur = await (await h(new Request("http://test/projects/p/policy", { headers: owner }))).json() as any;
  const drop = await put(h, "p", JSON.stringify(body({ github_repos: ["acme/app"], repositories: [{ name: "acme/app", aliases: ["app"] }] })), cur.digest);
  assert.equal(drop.status, 201);
  const revoked = store.routes.get("acme/envb")!;
  assert.equal(revoked.state, "revoked");
  const afterRevoke = await post("acme/envb", "d-rev");
  assert.equal(afterRevoke.status, 202);
  assert.equal((await afterRevoke.json() as any).routing, "unresolved");
  assert.ok(store.pending.some((p) => p.repo === "acme/envb" && p.routing_state === "unresolved"));

  const dup = await put(h, "b", JSON.stringify({ ...body(), project: "b", github_repos: ["acme/app"], repositories: [{ name: "acme/app", aliases: [] }] }), "none");
  assert.equal(dup.status, 409);

  const p2 = await (await h(new Request("http://test/projects/p/policy", { headers: owner }))).json() as any;
  const reassign = await h(new Request("http://test/projects/b/policy?reassign=p", {
    method: "PUT",
    headers: { ...owner, "content-type": "application/json", "if-match": "none" },
    body: JSON.stringify({ ...body(), project: "b", github_repos: ["acme/app"], repositories: [{ name: "acme/app", aliases: [] }] }),
  }));
  const reassignText = await reassign.text();
  assert.equal(reassign.status, 201, reassignText);
  const bdoc = JSON.parse(reassignText) as any;
  assert.equal(bdoc.envelope.version, 1);
  assert.equal(store.routes.get("acme/app")!.project, "b");
  assert.equal(store.routes.get("acme/app")!.state, "active");
  const pAfter = await store.getPolicy("p", { current: true });
  assert.ok(pAfter && !pAfter.body.github_repos.includes("acme/app"));

  const staleReassign = await h(new Request("http://test/projects/p/policy?reassign=p", {
    method: "PUT",
    headers: { ...owner, "content-type": "application/json", "if-match": pAfter!.digest },
    body: JSON.stringify(body({ github_repos: ["acme/app"], repositories: [{ name: "acme/app", aliases: [] }] })),
  }));
  assert.equal(staleReassign.status, 409);

  const pNow = await (await h(new Request("http://test/projects/p/policy", { headers: owner }))).json() as any;
  const reactivate = await put(h, "p", JSON.stringify(body({ github_repos: ["acme/envb"], repositories: [{ name: "acme/envb", aliases: [] }] })), pNow.digest);
  assert.equal(reactivate.status, 201);
  assert.equal(store.routes.get("acme/envb")!.state, "active");
  assert.equal(store.routes.get("acme/envb")!.project, "p");

  const st = await (await h(new Request("http://test/projects/p/status", { headers: owner }))).json() as any;
  assert.equal(st.policy.mode, "document");
  assert.ok(st.policy.digest);
  assert.ok(st.routing.some((r: any) => r.repo === "acme/envb" && r.source === "policy"));
});

test("P8: missing policy by mode — off seals, shadow/enforce stay pending loud", async () => {
  const payload = JSON.stringify({
    action: "opened", repository: { full_name: "acme/envb" }, sender: { login: "j" },
    pull_request: { number: 1, title: "t", html_url: "https://x", updated_at: "2026-08-30T00:00:00Z", head: { sha: "abc", ref: "f" }, base: { ref: "main" } },
  });
  const run = async (mode: "off" | "shadow" | "enforce") => {
    const store = new MemoryEventStore();
    const h = createHandler(store, {
      token: "owner-token-long-enough",
      ownerPrincipal: { type: "human", id: "o" },
      githubSecret: "s3cret",
      githubRepoProjects: { "acme/envb": "b" },
      trailerPolicy: mode,
    });
    const res = await h(new Request("http://test/hooks/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": await ghSigned("s3cret", payload), "x-github-event": "pull_request", "x-github-delivery": `d-${mode}` },
      body: payload,
    }));
    return { res, store };
  };
  const off = await run("off");
  assert.equal(off.res.status, 201);
  const shadow = await run("shadow");
  assert.equal(shadow.res.status, 202);
  const bodyS = await shadow.res.json() as any;
  assert.equal(bodyS.hook, "queued");
  assert.equal(shadow.store.events.length, 0);
  assert.ok(shadow.store.pending.some((p) => p.routing_state === "pending_policy"));
  const enforce = await run("enforce");
  assert.equal(enforce.res.status, 202);
  const pinned = shadow.store.pending.find((p) => p.routing_state === "pending_policy")!;
  assert.equal(pinned.project, "b");
  assert.equal(pinned.repo, "acme/envb");
  assert.equal(pinned.routing_source, "env");
});

test("P10: store failure on policy lookup surfaces as 501/unavailable rather than a scan", async () => {
  const bare = createHandler({
    async head() { return null; }, async insert() {}, async byIdempotencyKey() { return null; },
    async get() { return null; }, async all() { return []; }, async projects() { return []; },
    async history() { return { events: [], truncated: false }; },
    async createShare() {}, async getShare() { return null; },
  } as any, { token: "owner-token-long-enough", ownerPrincipal: { type: "human", id: "o" } });
  const res = await put(bare, "p", JSON.stringify(body()), "none");
  assert.equal(res.status, 501);
});

test("F1: PUT {\"__proto__\": body} is 400", async () => {
  const { h } = handler();
  const wrapper = `{"__proto__":${JSON.stringify(body())}}`;
  assert.equal((await put(h, "p", wrapper, "none")).status, 400);
});

test("F3: concurrent A/B PUT claiming one repo yields one 201 and one 409", async () => {
  const store = new MemoryEventStore();
  const h = createHandler(store, { token: "owner-token-long-enough", ownerPrincipal: { type: "human", id: "o" } });
  const rawA = JSON.stringify({ ...body(), project: "a", github_repos: ["acme/shared"], repositories: [{ name: "acme/shared", aliases: [] }] });
  const rawB = JSON.stringify({ ...body(), project: "b", github_repos: ["acme/shared"], repositories: [{ name: "acme/shared", aliases: [] }] });
  const [r1, r2] = await Promise.all([put(h, "a", rawA, "none"), put(h, "b", rawB, "none")]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  const active = [...store.routes.values()].filter((r) => r.repo === "acme/shared" && r.state === "active");
  assert.equal(active.length, 1);
  const docs = store.policies.filter((d) => d.body.github_repos.includes("acme/shared"));
  assert.equal(docs.length, 1, "only the winning document may claim the repo");
});

test("F7: no named digest → no trusted list; missing named lookup → 501", async () => {
  const kp = await generateSigningKey();
  const store = new MemoryEventStore();
  const h = createHandler(store, {
    token: "owner-token-long-enough",
    ownerPrincipal: { type: "human", id: "o" },
    credentials: [{
      token: "pinned-token-long-enough",
      trust: "pinned",
      actor: { type: "agent", id: "codex" },
      projects: ["p"],
      public_key: publicFromPrivate(kp.privateKey),
      require_signature: true,
    }],
  });
  const unsignedOk = await h(new Request("http://test/events", {
    method: "POST",
    headers: { authorization: "Bearer owner-token-long-enough", "content-type": "application/json" },
    body: JSON.stringify(ev({ project: "p" })),
  }));
  assert.equal(unsignedOk.status, 201);
    const signed = await signProducer({
      ...ev({
        project: "p",
        actor: { type: "agent", id: "codex" },
        timestamp: "2026-09-09T12:00:00.000Z",
        idempotency_key: "agent:f7-named",
        method: { params: { claim_decision: { context: { policy_digest: "ab".repeat(32) } } } },
      }),
    }, kp.privateKey);
  const miss = await h(new Request("http://test/events", {
    method: "POST",
    headers: { authorization: "Bearer pinned-token-long-enough", "content-type": "application/json" },
    body: JSON.stringify(signed),
  }));
  assert.equal(miss.status, 501);
});

test("F9: DELETE preserves policy_routes tombstones so env cannot resurrect", async () => {
  const store = new MemoryEventStore();
  const h = createHandler(store, {
    token: "owner-token-long-enough",
    ownerPrincipal: { type: "human", id: "o" },
    ownerActor: { type: "human", id: "o" },
    githubSecret: "s3cret",
    githubRepoProjects: { "acme/app": "b" },
  });
  await put(h, "a", JSON.stringify({ ...body(), project: "a", github_repos: ["acme/app"], repositories: [{ name: "acme/app", aliases: [] }] }), "none");
  const cur = await (await h(new Request("http://test/projects/a/policy", { headers: owner }))).json() as any;
  assert.equal((await put(h, "a", JSON.stringify({ ...body(), project: "a", github_repos: [], repositories: [] }), cur.digest)).status, 201);
  assert.equal(store.routes.get("acme/app")!.state, "revoked");
  const del = await h(new Request("http://test/projects/a?confirm=a", { method: "DELETE", headers: owner }));
  assert.equal(del.status, 200, await del.text());
  assert.equal(store.routes.get("acme/app")?.state, "revoked");
  const payload = JSON.stringify({
    action: "opened", repository: { full_name: "acme/app" }, sender: { login: "j" },
    pull_request: { number: 1, title: "t", html_url: "https://x", updated_at: "2026-08-30T00:00:00Z", head: { sha: "abc", ref: "f" }, base: { ref: "main" } },
  });
  const hook = await h(new Request("http://test/hooks/github", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": await ghSigned("s3cret", payload), "x-github-event": "pull_request", "x-github-delivery": "d-resurrect" },
    body: payload,
  }));
  assert.equal(hook.status, 202);
  assert.equal((await hook.json() as any).routing, "unresolved");
});

test("F10: pending-delivery routing is insert-once; redelivery reuses the stored project", async () => {
  const store = new MemoryEventStore();
  const h = createHandler(store, {
    token: "owner-token-long-enough",
    ownerPrincipal: { type: "human", id: "o" },
    githubSecret: "s3cret",
    githubRepoProjects: { "acme/envb": "b" },
    trailerPolicy: "shadow",
  });
  const payload = JSON.stringify({
    action: "opened", repository: { full_name: "acme/envb" }, sender: { login: "j" },
    pull_request: { number: 1, title: "t", html_url: "https://x", updated_at: "2026-08-30T00:00:00Z", head: { sha: "abc", ref: "f" }, base: { ref: "main" } },
  });
  store.pending.push({
    delivery_id: "d-pin", project: "pinned-a", raw_body: payload, received_at: "2026-09-01T00:00:00.000Z",
    repo: "acme/envb", routing_source: "env", routing_state: "pending_policy",
  });
  const res = await h(new Request("http://test/hooks/github", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": await ghSigned("s3cret", payload), "x-github-event": "pull_request", "x-github-delivery": "d-pin" },
    body: payload,
  }));
  assert.equal(res.status, 202);
  const bodyJ = await res.json() as any;
  assert.equal(bodyJ.reused, true);
  assert.equal(bodyJ.project, "pinned-a");
  assert.equal(store.pending.filter((p) => p.delivery_id === "d-pin").length, 1);
  assert.equal(store.pending.find((p) => p.delivery_id === "d-pin")!.project, "pinned-a");
});

test("F11: revoked tombstone with no live claimant activates without ?reassign", async () => {
  const store = new MemoryEventStore();
  const h = createHandler(store, { token: "owner-token-long-enough", ownerPrincipal: { type: "human", id: "o" } });
  await put(h, "a", JSON.stringify({ ...body(), project: "a", github_repos: ["acme/app"], repositories: [{ name: "acme/app", aliases: [] }] }), "none");
  const cur = await (await h(new Request("http://test/projects/a/policy", { headers: owner }))).json() as any;
  assert.equal((await put(h, "a", JSON.stringify({ ...body(), project: "a", github_repos: [], repositories: [] }), cur.digest)).status, 201);
  assert.equal(store.routes.get("acme/app")!.state, "revoked");
  const take = await put(h, "b", JSON.stringify({ ...body(), project: "b", github_repos: ["acme/app"], repositories: [{ name: "acme/app", aliases: [] }] }), "none");
  assert.equal(take.status, 201, await take.text());
  assert.equal(store.routes.get("acme/app")!.project, "b");
  assert.equal(store.routes.get("acme/app")!.state, "active");
});

test("F12: hook /2 POST /events under shadow/enforce is 503 and appends nothing; off may seal", async () => {
  const kp = await generateSigningKey();
  const pub = publicFromPrivate(kp.privateKey);
  const commit = async (mode: "off" | "shadow" | "enforce") => {
    const store = new MemoryEventStore();
    const h = createHandler(store, {
      token: "owner-token-long-enough",
      ownerPrincipal: { type: "human", id: "o" },
      trailerPolicy: mode,
      credentials: [{
        token: "assert-token-long-enough",
        trust: "assert",
        actor: { type: "agent", id: "hook" },
        projects: ["p"],
        allowed_actors: [{ type: "agent", id: "hook" }],
        public_key: pub,
        require_signature: true,
      }],
    });
    const input = await signProducer({
      project: "p",
      actor: { type: "agent", id: "hook" },
      action: "committed",
      artifacts: [{ id: "commit:p@abc1234abc12", kind: "commit", role: "generated" }],
      timestamp: "2026-09-09T12:00:00.000Z",
      idempotency_key: "git:" + mode,
      intent: "signed bump",
      method: {
        tool: "git",
        automated: true,
        params: {
          branch: "main",
          parents: ["defdefdefdefdefdefdefdefdefdefdefdefdefd"],
          files: 1, insertions: 1, deletions: 0,
          sha: "abcabcabcabcabcabcabcabcabcabcabcabcabca",
          raw_message: "signed bump\n",
          author: { name: "Jordan", email: "jordan@example.com" },
        },
      },
    }, kp.privateKey, { format: PRODUCER_SIG_FORMAT_V2 });
    const res = await h(new Request("http://test/events", {
      method: "POST",
      headers: { authorization: "Bearer assert-token-long-enough", "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
    return { res, store };
  };
  const off = await commit("off");
  assert.equal(off.res.status, 201, await off.res.text());
  assert.equal(off.store.events.length, 1);
  for (const mode of ["shadow", "enforce"] as const) {
    const r = await commit(mode);
    assert.equal(r.res.status, 503, mode);
    assert.equal(r.store.events.length, 0, mode);
    assert.match(await r.res.text(), /policy_missing/);
  }
});

test("F16: /status routing matches delivery and does not leak another project's active repo", async () => {
  const store = new MemoryEventStore();
  const h = createHandler(store, {
    token: "owner-token-long-enough",
    ownerPrincipal: { type: "human", id: "o" },
    githubRepoProjects: { "acme/app": "b", "acme/onlyb": "b" },
  });
  await put(h, "a", JSON.stringify({ ...body(), project: "a", github_repos: ["acme/app"], repositories: [{ name: "acme/app", aliases: [] }] }), "none");
  const bStatus = await (await h(new Request("http://test/projects/b/status", { headers: owner }))).json() as any;
  assert.ok(!bStatus.routing?.some((r: any) => r.repo === "acme/app" && r.source === "env_fallback"));
  assert.ok(bStatus.routing?.some((r: any) => r.repo === "acme/onlyb" && r.source === "env_fallback"));
  const aStatus = await (await h(new Request("http://test/projects/a/status", { headers: owner }))).json() as any;
  assert.ok(aStatus.routing?.some((r: any) => r.repo === "acme/app" && r.source === "policy"));
});
