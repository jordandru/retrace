import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, sign as nodeSign } from "node:crypto";
import {
  ChainVerifier, GENESIS_HASH, MemoryEventStore, POLICY_PROFILE, StreamedFullExport, appendEvent, buildExportBundle, computeHash,
  createHandler, exportVerdictOk, generateSigningKey, newId, publicFromPrivate, utf8Length, verifyChain, verifyExportBundle,
} from "./index.js";
import type { Event, EventInput, ExportPageSource, ExportSignature, ExportSigner, ProducerKey, StreamingExportOptions } from "./index.js";

const sha256 = () => {
  const h = createHash("sha256");
  return { update: (b: Uint8Array) => h.update(b), digest: () => new Uint8Array(h.digest()) };
};

/** Core's reference two-pass signer: it keeps M (fine at test sizes) and signs it with node:crypto's Ed25519, which is
 *  RFC 8032 like WebCrypto, so its signature equals signCanonical's exactly when M equals the canonical bundle. The
 *  Worker's streaming signer has its own tests in apps/worker. */
function referenceSigner(privateJwk: JsonWebKey, calls?: string[]): ExportSigner {
  const { alg: _alg, ...jwk } = privateJwk as JsonWebKey & { alg?: string };
  const key = createPrivateKey({ key: jwk as any, format: "jwk" });
  return {
    publicKey: publicFromPrivate(privateJwk),
    begin(): ExportSignature {
      const one: Uint8Array[] = [];
      const two: Uint8Array[] = [];
      let state = 0;
      return {
        nonce(c) { if (state !== 0) throw new Error("pass 1 has ended"); one.push(c.slice()); },
        challenge(c) { if (state === 0) state = 1; if (state !== 1) throw new Error("ended"); two.push(c.slice()); },
        finish() {
          calls?.push("finish");
          state = 2;
          const a = Buffer.concat(one);
          if (!a.equals(Buffer.concat(two))) throw new Error("signature refused: pass 2 did not feed the bytes pass 1 fed");
          return new Uint8Array(nodeSign(null, a, key));
        },
        dispose() { calls?.push("dispose"); state = 2; },
      };
    },
    dispose() {},
  };
}

const NOW = new Date("2026-10-13T05:07:00.000Z");
const TEXTS = ["plain ascii", "Latin-1 é ü ß", "dash — ellipsis … arrow →", "astral 😀 𝄞", "a lone \ud800 surrogate", "mixed —\u{1F600}é\udc00"];
const PRODUCERS: ProducerKey[] = [{ kid: "0123456789abcdef", public_key: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }, actor_id: "codex", name: "codex hook" }];

const input = (project: string, i: number, over: Partial<EventInput> = {}): EventInput => ({
  project,
  actor: { type: i % 3 ? "agent" : "human", id: i % 3 ? "claude-code" : "jordan@example.com" },
  action: (["edited", "created", "sent", "received", "instructed"] as const)[i % 5],
  artifacts: [{ id: `repo:acme/app#src/f${i % 7}.ts`, role: "generated" }, { id: `task:${i}` }],
  intent: `${TEXTS[i % TEXTS.length]} #${i} ${"x".repeat(i % 11)}`,
  method: { tool: "test", params: { n: i, "10": "ten", "2": "two", nested: { b: [i, "é"], a: null } } },
  tags: i % 4 ? ["t"] : [],
  ...over,
});

/** A pre-marker event: no hash_v, its hash over the payload with received_at (the legacy rule verifyChain accepts). */
async function appendLegacy(store: MemoryEventStore, e: EventInput, i: number) {
  const head = await store.head(e.project);
  const received_at = new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString();
  const base = { ...e, id: newId(), seq: head ? head.seq + 1 : 0, timestamp: received_at, prev_hash: head?.hash ?? GENESIS_HASH, received_at };
  await store.insert({ ...base, hash: await computeHash(base) } as Event);
}

const OWNER = { authorization: "Bearer owner-token-long-enough" };
async function putPolicy(store: MemoryEventStore, project: string, stamps: string[], ifMatch: string): Promise<string> {
  const h = createHandler(store, { token: "owner-token-long-enough", ownerPrincipal: { type: "human", id: "owner@example.com" }, ownerActor: { type: "human", id: "owner@example.com" } });
  const res = await h(new Request(`http://test/projects/${project}/policy`, {
    method: "PUT",
    headers: { ...OWNER, "content-type": "application/json", "if-match": ifMatch },
    body: JSON.stringify({ profile: POLICY_PROFILE, project, trusted_hook_stamps: stamps, unresolved_claims: "record", repositories: [], github_repos: [] }),
  }));
  assert.equal(res.status, 201);
  return ((await res.json()) as { digest: string }).digest;
}

/** n events with policy documents (two versions, referenced by later events), legacy-hash events, and one- to
 *  four-byte characters, lone surrogates included. */
async function ledger(n: number, project = "p"): Promise<MemoryEventStore> {
  const store = new MemoryEventStore();
  let policy: string | undefined;
  for (let i = 0; i < n; i++) {
    if (n >= 8 && i === Math.floor(n / 4)) policy = await putPolicy(store, project, ["assert:git hook (assert)"], "none");
    else if (n >= 8 && i === Math.floor(n / 2)) policy = await putPolicy(store, project, ["assert:git hook (assert)", "assert:release"], policy!);
    else if (i % 10 === 3 && i < n / 4) await appendLegacy(store, input(project, i), i);
    else {
      const head = await store.head(project);
      const ref = policy && i % 5 === 0 ? { context: { policy_digest: policy, read_head_seq: head!.seq } } : {};
      await appendEvent(store, input(project, i, ref.context ? { method: { tool: "test", params: { n: i, ...ref } } } : {}));
    }
  }
  return store;
}

function copy(store: MemoryEventStore): MemoryEventStore {
  const c = new MemoryEventStore();
  c.events = store.events.map((e) => structuredClone(e));
  c.policies = store.policies.map((d) => structuredClone(d));
  return c;
}

async function rehash(e: Event): Promise<Event> {
  const { hash: _h, ...rest } = e;
  return { ...rest, hash: await computeHash(rest) } as Event;
}

async function stream(source: ExportPageSource, project: string, opts: StreamingExportOptions) {
  const plan = await StreamedFullExport.plan(source, project, opts);
  const chunks: Uint8Array[] = [];
  await plan.write({ write: async (c) => { chunks.push(c); } });
  const bytes = Buffer.concat(chunks);
  return { plan, bytes, text: bytes.toString("utf8") };
}

const PAGES: Array<{ name: string; pageRows?: number; pageChars?: number }> = [
  { name: "default pages" },
  { name: "16-row pages", pageRows: 16 },
  { name: "1,500-character pages", pageChars: 1_500 },
];

test("streamed bytes equal JSON.stringify(buildExportBundle) for 0, 1, 2, 15, 16, 17 and 2,500 events, intact and broken", { timeout: 600_000 }, async () => {
  const key = await generateSigningKey();
  const cases: Array<[string, MemoryEventStore, boolean]> = [];
  for (const n of [0, 1, 2, 15, 16, 17, 2_500]) cases.push([`${n} events`, await ledger(n), true]);
  const base = await ledger(40);
  const tampered = copy(base);
  tampered.events[21] = { ...tampered.events[21]!, intent: `${tampered.events[21]!.intent} (edited)` };
  cases.push(["a tampered body", tampered, false]);
  const gap = copy(base);
  gap.events.splice(22, 1);
  cases.push(["a seq gap", gap, false]);
  const prev = copy(base);
  prev.events[23] = await rehash({ ...prev.events[23]!, prev_hash: "f".repeat(64) });
  cases.push(["a prev_hash mismatch", prev, false]);
  let legacySeen = 0;
  let policiesSeen = 0;
  for (const [name, store, intact] of cases) {
    const expected = JSON.stringify(await buildExportBundle(store, { project: "p" }, { signingKey: key.privateKey, now: NOW, producers: PRODUCERS }));
    const builtVerdict = await verifyExportBundle(JSON.parse(expected), key.publicKey);
    if (intact) assert.equal(exportVerdictOk(builtVerdict), true, `${name}: the reference bundle is valid`);
    else assert.equal(builtVerdict.chain_ok_at_export, false, `${name}: the reference bundle reports the break`);
    const parsed = JSON.parse(expected);
    legacySeen += parsed.chain.legacy_events ?? 0;
    policiesSeen += parsed.policies?.length ?? 0;
    for (const pages of PAGES) {
      const perPass = [0, 0, 0];
      const got = await stream(store, "p", { signer: referenceSigner(key.privateKey), now: NOW, producers: PRODUCERS, sha256, ...pages, onPage: (pg) => { perPass[pg.pass]!++; } });
      assert.equal(perPass[0], perPass[1], `${name}, ${pages.name}: passes 0 and 1 read the same pages`);
      assert.equal(perPass[0], perPass[2], `${name}, ${pages.name}: passes 0 and 2 read the same pages`);
      const rows = pages.pageRows ?? 1000;
      if (store.events.length > rows) assert.ok(perPass[0]! > 1, `${name}, ${pages.name}: more than one page`);
      if (pages.pageChars && store.events.length > 2) assert.ok(perPass[0]! >= Math.ceil(store.events.length / 6), `${name}, ${pages.name}: character-bounded pages (${perPass[0]})`);
      assert.equal(got.text, expected, `${name}, ${pages.name}: same text`);
      assert.ok(got.bytes.equals(Buffer.from(expected, "utf8")), `${name}, ${pages.name}: same bytes`);
      assert.equal(got.plan.bytes, got.bytes.length, `${name}, ${pages.name}: pass 0 counted the served length`);
      assert.deepEqual(await verifyExportBundle(JSON.parse(got.text), key.publicKey), builtVerdict, `${name}, ${pages.name}: same verdict`);
    }
  }
  assert.ok(legacySeen > 0, "the matrix includes legacy-hash events");
  assert.ok(policiesSeen > 0, "the matrix includes policy documents");
});

test("an unsigned streamed export equals the unsigned bundle", async () => {
  const store = await ledger(30);
  const expected = JSON.stringify(await buildExportBundle(store, { project: "p" }, { now: NOW }));
  const got = await stream(store, "p", { now: NOW, sha256, pageRows: 7 });
  assert.equal(got.text, expected);
  assert.equal(got.plan.bytes, got.bytes.length);
});

test("snapshot: events appended while the export is built stay out, and a document activated after the pinned head is left out", async () => {
  const key = await generateSigningKey();
  const store = await ledger(60);
  // An event in the snapshot claims a digest whose document only appears after the head is pinned.
  const late = "d".repeat(64);
  await appendEvent(store, input("p", 999, { method: { tool: "test", params: { context: { policy_digest: late, read_head_seq: 0 } } } }));
  const frozen = copy(store);
  const expected = JSON.stringify(await buildExportBundle(frozen, { project: "p" }, { signingKey: key.privateKey, now: NOW }));
  let appended = 0;
  let appends: Promise<unknown> = Promise.resolve();
  const source: ExportPageSource = {
    head: (p) => store.head(p),
    get: (id) => store.get(id),
    eventsPage: (...args) => store.eventsPage(...args),
    listPolicies: async (p, limit) => {
      // Lands between pinning the head and listing documents: a document whose activation event is past the head.
      const { event } = await appendEvent(store, input("p", 1000, { action: "other" }));
      store.policies.push({ ...structuredClone(store.policies[0]!), digest: late, envelope: { ...store.policies[0]!.envelope, version: 99, activation: { event_id: event.id, seq: event.seq } } });
      return store.listPolicies(p, limit);
    },
  };
  const got = await stream(source, "p", {
    signer: referenceSigner(key.privateKey), now: NOW, sha256, pageRows: 16,
    onPage: () => {
      const i = 2000 + appended++;
      appends = appends.then(() => appendEvent(store, input("p", i)));
    },
  });
  await appends;
  assert.ok(appended >= 12, "events were appended during every pass");
  assert.ok(store.events.length > frozen.events.length + 1);
  assert.equal(got.text, expected);
});

test("a pass that reads different events aborts before the signature exists; the sink never gets the closing bytes", async () => {
  const key = await generateSigningKey();
  for (const pass of [1, 2] as const) {
    const store = await ledger(400);
    const calls: string[] = [];
    let armed = false;
    const plan = await StreamedFullExport.plan(store, "p", {
      signer: referenceSigner(key.privateKey, calls), now: NOW, sha256, pageRows: 16,
      onPage: (page) => {
        if (armed && page.pass === pass && page.index === 0) store.events[300] = { ...store.events[300]!, intent: "changed between passes" };
      },
    });
    armed = true;
    let received = 0;
    await assert.rejects(() => plan.write({ write: async (c) => { received += c.length; } }), new RegExp(`pass ${pass} read different events from pass 0`));
    assert.deepEqual(calls, ["dispose"], `pass ${pass}: the signature was disposed, never finished`);
    assert.ok(received < plan.bytes, `pass ${pass}: the sink got ${received} of ${plan.bytes} bytes`);
    if (pass === 1) assert.equal(received, 0, "nothing is written before pass 2");
    else assert.ok(received > 0, "pass 2 had already written whole chunks when it failed");
  }
});

test("a pass that does not end at the pinned head aborts", async () => {
  const key = await generateSigningKey();
  const store = await ledger(40);
  const plan = await StreamedFullExport.plan(store, "p", { signer: referenceSigner(key.privateKey), now: NOW, sha256, pageRows: 16 });
  store.events = store.events.filter((e) => e.seq !== plan.head!.seq);
  await assert.rejects(() => plan.write({ write: async () => {} }), /pass 1 did not end at the pinned head/);
  const empty = await StreamedFullExport.plan(new MemoryEventStore(), "p", { now: NOW, sha256 });
  assert.equal(empty.head, null);
  assert.equal(empty.total_events, 0);
});

test("a page outside the snapshot window, or a store without eventsPage, throws", async () => {
  const store = await ledger(20);
  const head = (await store.head("p"))!;
  const bad: ExportPageSource = { head: (p) => store.head(p), get: (id) => store.get(id), eventsPage: async (p, after) => store.events.filter((e) => e.seq > after - 1).slice(0, 3) };
  await assert.rejects(() => StreamedFullExport.plan(bad, "p", { now: NOW, sha256 }), /outside the snapshot window or out of order/);
  const past: ExportPageSource = { head: async () => ({ seq: head.seq - 5, hash: "x" }), get: (id) => store.get(id), eventsPage: async () => store.events.slice(-2) };
  await assert.rejects(() => StreamedFullExport.plan(past, "p", { now: NOW, sha256 }), /outside the snapshot window or out of order/);
  const none: ExportPageSource = { head: (p) => store.head(p), get: (id) => store.get(id) };
  await assert.rejects(() => StreamedFullExport.plan(none, "p", { now: NOW, sha256 }), /the store has no eventsPage/);
  await assert.rejects(() => StreamedFullExport.plan(store, "p", { now: NOW, sha256, pageChars: 0 }), /page bounds must be positive integers/);
});

test("ChainVerifier gives verifyChain's result for every single-event corruption of a short chain", async () => {
  const store = await ledger(12);
  const events = await store.all("p");
  const variants: Event[][] = [events];
  for (let i = 0; i < events.length; i++) {
    variants.push(events.map((e, j) => (j === i ? { ...e, intent: "tampered" } : e)));
    variants.push(events.filter((_, j) => j !== i));
    variants.push(events.map((e, j) => (j === i ? { ...e, prev_hash: "0".repeat(64) } : e)));
    variants.push(events.map((e, j) => (j === i ? { ...e, seq: e.seq + 1 } : e)));
  }
  for (const v of variants) {
    const verifier = new ChainVerifier();
    for (const e of v) await verifier.push(e);
    assert.deepEqual(verifier.result(), await verifyChain(v));
    assert.deepEqual(Object.keys(verifier.result()), Object.keys(await verifyChain(v)));
  }
});

test("utf8Length equals TextEncoder's length, lone surrogates included", () => {
  const encoder = new TextEncoder();
  const units = [0x41, 0x7f, 0x80, 0xe9, 0x7ff, 0x800, 0x2014, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xfffd, 0xffff];
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 2_000; i++) {
    let s = "";
    const n = Math.floor(rand() * 20);
    for (let j = 0; j < n; j++) s += String.fromCharCode(units[Math.floor(rand() * units.length)]!);
    assert.equal(utf8Length(s), encoder.encode(s).length, JSON.stringify(s));
  }
  assert.equal(utf8Length("😀"), 4);
  assert.equal(utf8Length("\ud83d"), 3);
});
