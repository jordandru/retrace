import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateSigningKey, appendEvent, buildExportBundle, EventStore, Event, Share, EventInput,
  pageHistoryNewest, keyId, publicFromPrivate, signCanonical, verifyExportBundle,
} from "@retrace-dev/core";
import { parseNameStatus, verifiedExportEvents } from "./reconcile.js";
import { fetchVerifiedRemoteEvents, historyTail } from "./verified-events.js";
import { RemoteStore } from "./remote-store.js";

class MemStore implements EventStore {
  events: Event[] = []; shares = new Map<string, Share>();
  async head(p: string) { const e = this.events.filter((x) => x.project === p).at(-1); return e ? { seq: e.seq, hash: e.hash } : null; }
  async insert(e: Event) { this.events.push(e); }
  async byIdempotencyKey() { return null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(p: string) { return this.events.filter((e) => e.project === p); }
  async projects() { return ["p"]; }
  async history(q: any) { return pageHistoryNewest(this.events, q); }
  async createShare(s: Share) { this.shares.set(s.id, s); }
  async getShare(id: string) { return this.shares.get(id) ?? null; }
}
const ev = (): EventInput => ({ project: "p", actor: { type: "agent", id: "claude-code" }, action: "edited", artifacts: [{ id: "repo:p#a.ts" }] });
async function signedHead(
  privateKey: JsonWebKey,
  head: { seq: number; hash: string },
  options: { project?: string; signedAt?: string; publicKey?: JsonWebKey } = {},
) {
  const project = options.project ?? "p";
  const signed_at = options.signedAt ?? new Date().toISOString();
  const payload = { project, seq: head.seq, hash: head.hash, signed_at };
  const publicKey = options.publicKey ?? publicFromPrivate(privateKey);
  return {
    ...payload,
    issuer: { kid: await keyId(publicKey), alg: "Ed25519", public_key: publicKey },
    signature: await signCanonical(privateKey, payload),
  };
}

test("parseNameStatus: modify, add, delete, rename with source", () => {
  assert.deepEqual(parseNameStatus("M\ta.ts\nA\tb.ts\nD\tc.ts\nR095\told.ts\tnew.ts\nC100\tsrc.ts\tdst.ts\n"), [
    { path: "a.ts", status: "M" }, { path: "b.ts", status: "A" }, { path: "c.ts", status: "D" }, { path: "new.ts", status: "R", from: "old.ts" }, { path: "dst.ts", status: "C", from: "src.ts" },
  ]);
});

test("verifiedExportEvents fails closed: no trusted key, wrong key, tampered events, self-attested; passes only a valid signed full export", async () => {
  const store = new MemStore();
  await appendEvent(store, ev()); await appendEvent(store, ev());
  const issuer = await generateSigningKey();
  const bundle = await buildExportBundle(store, { project: "p" }, { signingKey: issuer.privateKey, issuerName: "test" });
  const flag = JSON.stringify(issuer.publicKey);
  const good = await verifiedExportEvents(bundle, flag);
  assert.equal(good.events.length, 2);
  assert.match(good.note, /verified against --pubkey/);
  const saved = process.env.RETRACE_PUBKEY; delete process.env.RETRACE_PUBKEY;
  try {
    await assert.rejects(() => verifiedExportEvents(bundle, undefined, "http://plain.example"), /no trusted issuer key/);
    await assert.rejects(() => verifiedExportEvents(bundle, undefined, ""), /no trusted issuer key/);
  } finally { if (saved !== undefined) process.env.RETRACE_PUBKEY = saved; }
  const stranger = await generateSigningKey();
  await assert.rejects(() => verifiedExportEvents(bundle, JSON.stringify(stranger.publicKey)), /does not verify/);
  const tampered = { ...bundle, events: [{ ...bundle.events[0], actor: { type: "agent" as const, id: "codex" } }, bundle.events[1]] };
  await assert.rejects(() => verifiedExportEvents(tampered, flag), /does not verify/);
  const unsigned = await buildExportBundle(store, { project: "p" }, {});
  await assert.rejects(() => verifiedExportEvents(unsigned, flag), /does not verify/);
  const scoped = await buildExportBundle(store, { project: "p", artifact_id: "repo:p#a.ts" }, { signingKey: issuer.privateKey, issuerName: "test" });
  const scopedVerdict = await verifyExportBundle(scoped, issuer.publicKey);
  assert.equal(scopedVerdict.signature, "valid");
  assert.equal(scopedVerdict.coverage.scope, "scoped");
  await assert.rejects(() => verifiedExportEvents(scoped, flag), /scoped export \(scope artifact_id=repo:p#a\.ts\)/);
});

test("remote events: signed cache is extended by a chain-verified HTTP tail without trying fresh export", async () => {
  const store = new MemStore();
  await appendEvent(store, ev());
  const issuer = await generateSigningKey();
  const cached = await buildExportBundle(store, { project: "p" }, { signingKey: issuer.privateKey, issuerName: "test" });
  await appendEvent(store, ev());
  await appendEvent(store, ev());
  const tail = store.events.slice(1);
  const calls: string[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/projects/p/export?cached=1")) return Response.json(cached);
    if (url.endsWith("/projects/p/head?signed=1")) return Response.json(await signedHead(issuer.privateKey, { seq: 2, hash: tail[1].hash }));
    if (url.includes("/projects/p/events?")) return Response.json({ events: tail, truncated: false });
    if (url.includes("fresh=1")) return new Response("mock live rebuild unavailable", { status: 503 });
    return new Response("not found", { status: 404 });
  };
  try {
    const got = await fetchVerifiedRemoteEvents(new RemoteStore("https://mock.test"), "p", JSON.stringify(issuer.publicKey));
    assert.deepEqual(got.events.map((e) => e.seq), [0, 1, 2]);
    assert.match(got.note, /signed cache through #0; chain-verified tail #1\.\.#2/);
    assert.equal(calls.some((url) => url.includes("fresh=1")), false);
  } finally { globalThis.fetch = savedFetch; }
});

test("remote events: newest-window history pages are walked backward and reassembled ascending", async () => {
  const store = new MemStore();
  await appendEvent(store, ev());
  const issuer = await generateSigningKey();
  const cached = await buildExportBundle(store, { project: "p" }, { signingKey: issuer.privateKey, issuerName: "test" });
  await appendEvent(store, ev());
  await appendEvent(store, ev());
  await appendEvent(store, ev());
  const calls: string[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input)); calls.push(url.toString());
    if (url.pathname === "/projects/p/export" && url.searchParams.get("cached") === "1") return Response.json(cached);
    if (url.pathname === "/projects/p/head" && url.searchParams.get("signed") === "1") {
      return Response.json(await signedHead(issuer.privateKey, { seq: 3, hash: store.events[3].hash }));
    }
    if (url.pathname === "/projects/p/events" && !url.searchParams.has("before_seq")) {
      return Response.json({ events: [store.events[2], store.events[3]], truncated: true, next_before_seq: 2 });
    }
    if (url.pathname === "/projects/p/events" && url.searchParams.get("before_seq") === "2") {
      return Response.json({ events: [store.events[1]], truncated: false });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    const got = await fetchVerifiedRemoteEvents(new RemoteStore("https://mock.test"), "p", JSON.stringify(issuer.publicKey));
    assert.deepEqual(got.events.map((event) => event.seq), [0, 1, 2, 3]);
    assert.equal(calls.filter((url) => url.includes("/events?")).length, 2);
  } finally { globalThis.fetch = savedFetch; }
});

test("remote events: a tail gap fails closed without cache-only success or fresh retry", async () => {
  const store = new MemStore();
  await appendEvent(store, ev());
  const issuer = await generateSigningKey();
  const cached = await buildExportBundle(store, { project: "p" }, { signingKey: issuer.privateKey, issuerName: "test" });
  await appendEvent(store, ev());
  await appendEvent(store, ev());
  const calls: string[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/projects/p/export?cached=1")) return Response.json(cached);
    if (url.endsWith("/projects/p/head?signed=1")) return Response.json(await signedHead(issuer.privateKey, { seq: 2, hash: store.events[2].hash }));
    if (url.includes("/projects/p/events?")) return Response.json({ events: [store.events[2]], truncated: false });
    if (url.includes("fresh=1")) return new Response("must not retry", { status: 503 });
    return new Response("not found", { status: 404 });
  };
  try {
    await assert.rejects(
      () => fetchVerifiedRemoteEvents(new RemoteStore("https://mock.test"), "p", JSON.stringify(issuer.publicKey)),
      /sequence gap/,
    );
    assert.equal(calls.some((url) => url.includes("fresh=1")), false);

    globalThis.fetch = async (input) => {
      const url = String(input); calls.push(url);
      if (url.endsWith("/projects/p/export?cached=1")) return Response.json(cached);
      if (url.endsWith("/projects/p/head?signed=1")) return Response.json(await signedHead(issuer.privateKey, { seq: 2, hash: store.events[2].hash }));
      if (url.includes("/projects/p/events?")) {
        return Response.json({ events: [{ ...store.events[1], intent: "tampered" }, store.events[2]], truncated: false });
      }
      if (url.includes("fresh=1")) return new Response("must not retry", { status: 503 });
      return new Response("not found", { status: 404 });
    };
    await assert.rejects(
      () => fetchVerifiedRemoteEvents(new RemoteStore("https://mock.test"), "p", JSON.stringify(issuer.publicKey)),
      /content hash mismatch/,
    );
    assert.equal(calls.some((url) => url.includes("fresh=1")), false);
  } finally { globalThis.fetch = savedFetch; }
});

test("remote events: live-behind and equal-seq hash disagreement fail closed", async () => {
  const store = new MemStore();
  await appendEvent(store, ev());
  await appendEvent(store, ev());
  const issuer = await generateSigningKey();
  const cached = await buildExportBundle(store, { project: "p" }, { signingKey: issuer.privateKey, issuerName: "test" });
  const savedFetch = globalThis.fetch;
  try {
    for (const head of [{ seq: 0, hash: store.events[0].hash }, { seq: 1, hash: "f".repeat(64) }]) {
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.endsWith("/projects/p/export?cached=1")) return Response.json(cached);
        if (url.endsWith("/projects/p/head?signed=1")) return Response.json(await signedHead(issuer.privateKey, head));
        return new Response("not found", { status: 404 });
      };
      await assert.rejects(
        () => fetchVerifiedRemoteEvents(new RemoteStore("https://mock.test"), "p", JSON.stringify(issuer.publicKey)),
        head.seq === 0 ? /behind signed cache/ : /hash disagrees/,
      );
    }
  } finally { globalThis.fetch = savedFetch; }
});

test("remote events: only a cache miss requests fresh, whose mocked 503 fails closed", async () => {
  const calls: string[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/projects/p/export?cached=1")) return new Response("no cached export", { status: 404, headers: { "x-retrace-export-cache": "miss" } });
    if (url.includes("fresh=1")) return new Response("mock live rebuild unavailable", { status: 503 });
    return new Response("not found", { status: 404 });
  };
  try {
    await assert.rejects(
      () => fetchVerifiedRemoteEvents(new RemoteStore("https://mock.test"), "p", "{}"),
      /503/,
    );
    assert.equal(calls.filter((url) => url.includes("/export")).length, 2);
    assert.equal(calls.some((url) => url.includes("fresh=1")), true);
  } finally { globalThis.fetch = savedFetch; }
});

test("remote events: forged unsigned, wrong-key, and stale signed heads fail closed without a fresh retry", async () => {
  const store = new MemStore();
  await appendEvent(store, ev());
  const issuer = await generateSigningKey();
  const impostor = await generateSigningKey();
  const cached = await buildExportBundle(store, { project: "p" }, { signingKey: issuer.privateKey, issuerName: "test" });
  await appendEvent(store, ev());
  const forgedTail = [{ ...store.events[1] }];
  const cases = [
    {
      name: "unsigned",
      head: { seq: 1, hash: forgedTail[0].hash },
      pattern: /malformed or unsigned/,
    },
    {
      name: "wrong key",
      head: await signedHead(impostor.privateKey, { seq: 1, hash: forgedTail[0].hash }),
      pattern: /does not match trusted key/,
    },
    {
      name: "stale",
      head: await signedHead(issuer.privateKey, { seq: 1, hash: forgedTail[0].hash }, { signedAt: "2026-09-01T00:00:00.000Z" }),
      pattern: /is stale/,
    },
    {
      // Codex follow-up on PR 12: a future stamp made the age negative and slipped past the staleness bound
      name: "future-dated",
      head: await signedHead(issuer.privateKey, { seq: 1, hash: forgedTail[0].hash }, { signedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
      pattern: /dated in the future/,
    },
  ];
  const savedFetch = globalThis.fetch;
  try {
    for (const scenario of cases) {
      const calls: string[] = [];
      globalThis.fetch = async (input) => {
        const url = String(input); calls.push(url);
        if (url.endsWith("/projects/p/export?cached=1")) return Response.json(cached);
        if (url.endsWith("/projects/p/head?signed=1")) return Response.json(scenario.head);
        if (url.includes("/projects/p/events?")) return Response.json({ events: forgedTail, truncated: false });
        if (url.includes("fresh=1")) return new Response("must not retry", { status: 503 });
        return new Response("not found", { status: 404 });
      };
      await assert.rejects(
        () => fetchVerifiedRemoteEvents(new RemoteStore("https://mock.test"), "p", JSON.stringify(issuer.publicKey)),
        scenario.pattern,
        scenario.name,
      );
      assert.equal(calls.some((url) => url.includes("/events?")), false, scenario.name);
      assert.equal(calls.some((url) => url.includes("fresh=1")), false, scenario.name);
    }
  } finally { globalThis.fetch = savedFetch; }
});

test("history tail: a one-event suffix on a 100,001-event ledger requests and receives exactly one event", async () => {
  const ledgerSize = 100_001;
  const event = { seq: ledgerSize - 1 } as Event;
  const requests: URL[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input)); requests.push(url);
    return Response.json({ events: [event], truncated: false });
  };
  try {
    const tail = await historyTail(new RemoteStore("https://mock.test"), "p", ledgerSize - 2, ledgerSize - 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get("limit"), "1");
    assert.deepEqual(tail, [event]);
  } finally { globalThis.fetch = savedFetch; }
});

test("remote events: cache unavailability throws without requesting a fresh export", async () => {
  const savedFetch = globalThis.fetch;
  try {
    for (const response of [
      new Response("export cache is not configured", { status: 503 }),
      new Response("export cache read failed: boom", { status: 503 }),
      new Response("not a confirmed cache miss", { status: 404 }),
    ]) {
      const calls: string[] = [];
      globalThis.fetch = async (input) => {
        const url = String(input); calls.push(url);
        if (url.endsWith("/projects/p/export?cached=1")) return response.clone();
        if (url.includes("fresh=1")) return new Response("must not retry", { status: 500 });
        return new Response("not found", { status: 404 });
      };
      await assert.rejects(
        () => fetchVerifiedRemoteEvents(new RemoteStore("https://mock.test"), "p", "{}"),
        /404|503/,
      );
      assert.equal(calls.some((url) => url.includes("fresh=1")), false);
    }
  } finally { globalThis.fetch = savedFetch; }
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unreachableSeals, reconcileWithGit, commitFacts } from "./reconcile.js";

function tempRepo(): { repo: string; g: (...a: string[]) => string; write: (f: string, c: string) => void } {
  const repo = mkdtempSync(join(tmpdir(), "retrace-rec-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  g("init", "-q", "-b", "main");
  return { repo, g, write: (f, c) => writeFileSync(join(repo, f), c) };
}

async function remoteTail(
  cached: Awaited<ReturnType<typeof buildExportBundle>>,
  events: Event[],
  issuer: { privateKey: JsonWebKey; publicKey: JsonWebKey },
): Promise<{ events: Event[]; calls: string[] }> {
  const calls: string[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/projects/p/export?cached=1")) return Response.json(cached);
    if (url.endsWith("/projects/p/head?signed=1")) {
      const head = events.at(-1)!;
      return Response.json(await signedHead(issuer.privateKey, { seq: head.seq, hash: head.hash }));
    }
    if (url.includes("/projects/p/events?")) {
      return Response.json({ events: events.slice(cached.chain.total_events), truncated: false });
    }
    if (url.includes("fresh=1")) return new Response("mock live rebuild unavailable", { status: 503 });
    return new Response("not found", { status: 404 });
  };
  try {
    const result = await fetchVerifiedRemoteEvents(new RemoteStore("https://mock.test"), "p", JSON.stringify(issuer.publicKey));
    return { events: result.events, calls };
  } finally { globalThis.fetch = savedFetch; }
}

test("remote tail: a seal after the signed cache prevents a false missing_commit without a live export", async () => {
  const repo = tempRepo();
  repo.write("a.ts", "one\n"); repo.g("add", "a.ts"); repo.g("commit", "-q", "-m", "one");
  const sha = repo.g("rev-parse", "HEAD");
  const store = new MemStore();
  await appendEvent(store, {
    project: "p", actor: { type: "agent", id: "github-copilot" }, action: "edited",
    artifacts: [{ id: "repo:o/r#a.ts" }],
  });
  const issuer = await generateSigningKey();
  const cached = await buildExportBundle(store, { project: "p" }, { signingKey: issuer.privateKey, issuerName: "test" });
  await appendEvent(store, {
    project: "p", actor: { type: "agent", id: "github-copilot" }, action: "committed",
    artifacts: [{ id: `commit:o/r@${sha.slice(0, 12)}`, kind: "commit" }, { id: "repo:o/r#a.ts" }],
    method: { tool: "git", params: { sealed_by: "assert:retrace-git" } },
  });

  const remote = await remoteTail(cached, store.events, issuer);
  const report = reconcileWithGit(repo.repo, [commitFacts(repo.repo, "HEAD")], remote.events, {
    repoName: "o/r", hookSealedBy: ["assert:retrace-git"], allowUnstampedSeals: true,
  });
  assert.equal(report.commits[0].findings.some((finding) => finding.kind === "missing_commit"), false);
  assert.equal(remote.calls.some((url) => url.includes("fresh=1")), false);
});

test("remote tail: a correction after the signed cache acknowledges the live finding", async () => {
  const repo = tempRepo();
  repo.write("a.ts", "one\n"); repo.g("add", "a.ts"); repo.g("commit", "-q", "-m", "one");
  const sha = repo.g("rev-parse", "HEAD");
  const commitId = `commit:o/r@${sha.slice(0, 12)}`;
  const store = new MemStore();
  await appendEvent(store, {
    project: "p", actor: { type: "agent", id: "claude-code" }, action: "edited",
    artifacts: [{ id: "repo:o/r#a.ts" }],
  });
  await appendEvent(store, {
    project: "p", actor: { type: "agent", id: "github-copilot" }, action: "committed",
    artifacts: [{ id: commitId, kind: "commit" }, { id: "repo:o/r#a.ts" }],
    method: { tool: "git", params: { sealed_by: "assert:retrace-git" } },
  });
  const issuer = await generateSigningKey();
  const cached = await buildExportBundle(store, { project: "p" }, { signingKey: issuer.privateKey, issuerName: "test" });
  await appendEvent(store, {
    project: "p", actor: { type: "human", id: "reviewer@example.com" }, action: "other",
    action_detail: "attributed", tags: ["correction"], artifacts: [{ id: commitId, kind: "commit" }],
  });

  const remote = await remoteTail(cached, store.events, issuer);
  const report = reconcileWithGit(repo.repo, [commitFacts(repo.repo, "HEAD")], remote.events, {
    repoName: "o/r", hookSealedBy: ["assert:retrace-git"],
  });
  const finding = report.commits[0].findings.find((item) => item.kind === "misattributed");
  assert.equal(finding?.level, "info");
  assert.equal(finding?.acknowledged?.seq, 2);
  assert.equal(report.ok, true);
  assert.equal(remote.calls.some((url) => url.includes("fresh=1")), false);
});

test("unreachableSeals: ref reachability with a horizon — an amended original that still exists as an object IS unreachable; history older than the checkout is NOT", () => {
  const { repo, g, write } = tempRepo();
  write("a.txt", "1"); g("add", "a.txt"); g("commit", "-q", "-m", "c1"); const c1 = g("rev-parse", "HEAD").slice(0, 12);
  write("a.txt", "2"); g("commit", "-q", "-am", "c2"); const c2 = g("rev-parse", "HEAD").slice(0, 12);
  write("a.txt", "3"); g("commit", "-q", "-am", "c3"); const c3orig = g("rev-parse", "HEAD").slice(0, 12);
  g("commit", "-q", "--amend", "-m", "c3 amended"); const c3 = g("rev-parse", "HEAD").slice(0, 12);
  // the amended original still exists as an object (reflog) — existence must not be the test
  execFileSync("git", ["-C", repo, "cat-file", "-e", `${c3orig}^{commit}`]);
  const gone = "0123456789ab";
  const seals = [{ sha12: gone, seq: 1 }, { sha12: c1, seq: 2 }, { sha12: c2, seq: 3 }, { sha12: c3orig, seq: 4 }, { sha12: c3, seq: 5 }, { sha12: "fedcba987654", seq: 6 }];
  assert.deepEqual(unreachableSeals(repo, seals), [c3orig, "fedcba987654"], "older-than-horizon sha is unfetched history, not a rewrite");
  assert.deepEqual(unreachableSeals(repo, [{ sha12: gone, seq: 1 }]), [], "nothing reachable → nothing excluded");
  assert.deepEqual(unreachableSeals(repo, []), []);
});

test("shallow-clone regression (Codex review of 05c61f9): history the checkout never fetched keeps bounding windows, so a stale edit cannot cover an unlogged HEAD change", () => {
  const src = tempRepo();
  src.write("x.ts", "1"); src.g("add", "x.ts"); src.g("commit", "-q", "-m", "c1"); const c1 = src.g("rev-parse", "HEAD");
  src.write("x.ts", "2"); src.g("commit", "-q", "-am", "c2"); const c2 = src.g("rev-parse", "HEAD");
  src.write("x.ts", "3"); src.g("commit", "-q", "-am", "c3"); const c3 = src.g("rev-parse", "HEAD");
  const shallow = mkdtempSync(join(tmpdir(), "retrace-shallow-"));
  execFileSync("git", ["clone", "-q", "--depth", "2", `file://${src.repo}`, shallow], { stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(execFileSync("git", ["-C", shallow, "rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim(), "true");
  const REPO = "o/r"; const HOOK = "assert:retrace-git";
  const ev = (seq: number, actor: any, action: any, ids: string[], extra: any = {}): Event => ({ id: `e${seq}`, seq, project: "p", actor, action, artifacts: ids.map((id) => ({ id, ...(id.startsWith("commit:") ? { kind: "commit" } : {}) })), timestamp: "2026-09-01T00:00:00Z", received_at: "2026-09-01T00:00:00Z", prev_hash: "", hash: `h${seq}`, ...extra });
  const codex = { type: "agent", id: "codex" };
  const seal = (seq: number, sha: string) => ev(seq, codex, "committed", [`commit:${REPO}@${sha.slice(0, 12)}`, `repo:${REPO}#x.ts`], { method: { tool: "git", params: { sealed_by: HOOK } }, idempotency_key: `git:${sha}` });
  // old edit #1 → sealed into c1 (#2, NOT in the shallow clone) → c2 (#3) → HEAD c3 (#4) with no edit logged
  const events = [ev(1, codex, "edited", [`repo:${REPO}#x.ts`]), seal(2, c1), seal(3, c2), seal(4, c3)];
  const facts = commitFacts(shallow, "HEAD");
  const r = reconcileWithGit(shallow, [facts], events, { repoName: REPO, hookSealedBy: [HOOK] });
  assert.deepEqual(r.commits[0].findings.map((f) => `${f.kind}:${f.level}`), ["uncovered:warn"], "the unfetched seal of c1 still bounds the window; edit #1 must not cover HEAD");
  assert.deepEqual(r.commits[0].coverage["x.ts"].window, { after: 3, before: 4 });
  assert.equal(r.summary.unreachable_seal, 0);
});
