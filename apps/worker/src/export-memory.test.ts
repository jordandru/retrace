/**
 * The memory test of export-cache handoff db4bb0d6 §6 (test 4): a 50,000-event ledger, about 40% of events holding a
 * character above U+00FF and about 2.3 KB each, built in a child Node process capped at --max-old-space-size=64.
 * The streaming build (core's builder with the Worker's signer) completes; today's builder (buildExportBundle,
 * JSON.stringify, TextEncoder, as the refresh did it) fails under the same cap.
 *
 * The fixture keeps the ledger off the JS heap: the 50,000 event hashes sit in one Buffer, and each page's events are
 * generated from their seq, serialised and parsed again as D1 rows would be. The sink counts the bytes and discards
 * them. Otherwise the test would measure the fixture, not the builder.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { GENESIS_HASH, StreamedFullExport, buildExportBundle, computeHash, generateSigningKey } from "@retrace-dev/core";
import type { Event, EventStore, ExportPageSource } from "@retrace-dev/core";
import { createStreamingEd25519Signer } from "./ed25519-stream.js";

const MODE = process.env.RETRACE_EXPORT_MEMORY_CHILD;
const N = 50_000;
const RESULT = "EXPORT_MEMORY_RESULT ";

/** Event seq, about 2.3 KB of JSON; seq % 5 < 2 (40%) carries em dashes, arrows and ellipses. */
function body(seq: number, prev_hash: string): Omit<Event, "hash"> {
  const wide = seq % 5 < 2;
  const phrase = wide ? `ledger entry ${seq} — moved → archived … ` : `ledger entry ${seq} - moved to archived ... `;
  const at = new Date(Date.UTC(2026, 8, 1) + seq * 1_000).toISOString();
  return {
    project: "big",
    actor: { type: "agent", id: "claude-code", model: "claude-opus-5-5", model_source: "harness-runtime" },
    action: "edited",
    artifacts: [{ id: `repo:acme/app#src/module-${seq % 97}/file-${seq % 13}.ts`, kind: "file", role: "generated" }],
    intent: phrase.repeat(Math.ceil(1_700 / phrase.length)).slice(0, 1_700),
    method: { tool: "fixture", params: { seq, note: `page fixture ${seq}`, list: [seq % 3, seq % 7, seq % 11] } },
    tags: ["fixture"],
    id: `evt_${seq.toString(16).padStart(32, "0")}`,
    seq,
    timestamp: at,
    prev_hash,
    received_at: at,
    hash_v: 2,
  } as Omit<Event, "hash">;
}

async function child(mode: string) {
  const hashes = Buffer.alloc(N * 32);
  const hex = (seq: number) => hashes.subarray(seq * 32, seq * 32 + 32).toString("hex");
  for (let seq = 0; seq < N; seq++) {
    const h = await computeHash(body(seq, seq ? hex(seq - 1) : GENESIS_HASH));
    hashes.write(h, seq * 32, "hex");
  }
  const event = (seq: number) => JSON.parse(JSON.stringify({ ...body(seq, seq ? hex(seq - 1) : GENESIS_HASH), hash: hex(seq) })) as Event;
  const key = await generateSigningKey();
  const started = Date.now();
  if (mode === "today") {
    const store = { all: async () => Array.from({ length: N }, (_, seq) => event(seq)), get: async () => null, listPolicies: async () => [] } as unknown as EventStore;
    const bundle = await buildExportBundle(store, { project: "big" }, { signingKey: key.privateKey });
    const bytes = new TextEncoder().encode(JSON.stringify(bundle)).length;
    process.stdout.write(`${RESULT}${JSON.stringify({ mode, bytes, ms: Date.now() - started })}\n`);
    return;
  }
  const source: ExportPageSource = {
    head: async () => ({ seq: N - 1, hash: hex(N - 1) }),
    get: async () => null,
    listPolicies: async () => [],
    eventsPage: async (_project, after, through, limit, maxChars) => {
      const page: Event[] = [];
      let chars = 0;
      for (let seq = after + 1; seq <= through && page.length < limit && chars < maxChars; seq++) {
        const row = JSON.stringify({ ...body(seq, seq ? hex(seq - 1) : GENESIS_HASH), hash: hex(seq) });
        chars += row.length;
        page.push(JSON.parse(row) as Event);
      }
      return page;
    },
  };
  const peaks = [0, 1, 2].map(() => ({ pages: 0, heapUsed: 0, arrayBuffers: 0, rss: 0 }));
  const signer = createStreamingEd25519Signer(key.privateKey);
  const plan = await StreamedFullExport.plan(source, "big", {
    signer,
    sha256: () => sha256.create(),
    onPage: ({ pass }) => {
      const m = process.memoryUsage();
      const p = peaks[pass]!;
      p.pages++;
      p.heapUsed = Math.max(p.heapUsed, m.heapUsed);
      p.arrayBuffers = Math.max(p.arrayBuffers, m.arrayBuffers);
      p.rss = Math.max(p.rss, m.rss);
    },
  });
  let written = 0;
  let tail = new Uint8Array(0);
  await plan.write({ write: async (chunk) => { written += chunk.length; tail = chunk.slice(-120); } });
  signer.dispose();
  const closing = new TextDecoder().decode(tail);
  process.stdout.write(`${RESULT}${JSON.stringify({ mode, events: plan.total_events, bytes: written, planBytes: plan.bytes, ok: plan.chain.ok, signed: /"signature":"[A-Za-z0-9_-]{86}"}$/.test(closing), peaks, ms: Date.now() - started })}\n`);
}

function run(mode: "stream" | "today") {
  const result = spawnSync(process.execPath, ["--max-old-space-size=64", fileURLToPath(import.meta.url)], {
    encoding: "utf8",
    env: { ...process.env, RETRACE_EXPORT_MEMORY_CHILD: mode },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 600_000,
  });
  const line = result.stdout.split("\n").find((l) => l.startsWith(RESULT));
  return { status: result.status, signal: result.signal, stderr: result.stderr, result: line ? JSON.parse(line.slice(RESULT.length)) : undefined };
}

if (MODE) {
  await child(MODE);
} else {
  test("50,000 events under --max-old-space-size=64: the streaming build completes; today's builder runs out of heap", { timeout: 1_200_000 }, (t) => {
    const stream = run("stream");
    assert.equal(stream.status, 0, `streaming child: ${stream.signal ?? ""} ${stream.stderr.slice(-2_000)}`);
    const r = stream.result;
    assert.ok(r, "the streaming child reported a result");
    assert.equal(r.events, N);
    assert.equal(r.ok, true, "the fixture chain verifies");
    assert.equal(r.signed, true, "the output ends with the signature");
    assert.equal(r.bytes, r.planBytes, "exactly the length pass 0 counted");
    assert.ok(r.bytes > 100_000_000, `about 2.3 KB per event (${r.bytes} bytes)`);
    for (const pass of [0, 1, 2]) assert.ok(r.peaks[pass].pages > 1, `pass ${pass} read more than one page`);
    t.diagnostic(`streaming: ${r.events} events, ${r.bytes} bytes in ${r.ms} ms; per pass [pages, peak heapUsed MiB, peak arrayBuffers MiB, peak rss MiB]: ${JSON.stringify(r.peaks.map((p: { pages: number; heapUsed: number; arrayBuffers: number; rss: number }) => [p.pages, +(p.heapUsed / 2 ** 20).toFixed(1), +(p.arrayBuffers / 2 ** 20).toFixed(1), +(p.rss / 2 ** 20).toFixed(1)]))}`);

    const today = run("today");
    assert.notEqual(today.status, 0, `today's builder completed under the cap: ${JSON.stringify(today.result)}`);
    assert.equal(today.result, undefined);
    assert.match(today.stderr, /heap out of memory|Reached heap limit/, today.stderr.slice(-2_000));
    t.diagnostic(`today's builder: exit ${today.status} ${today.signal ?? ""}, ${today.stderr.match(/(Reached heap limit|heap out of memory)[^\n]*/)?.[0] ?? ""}`);
  });
}
