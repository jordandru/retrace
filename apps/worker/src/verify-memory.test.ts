/**
 * The memory test of #237 PR 1 (§6 test 2), after `export-memory.test.ts`: a 50,000-event ledger, 40% of events holding a
 * character above U+00FF and about 2.3 KB each, verified through the router's `GET /projects/:p/verify` in a child Node
 * process capped at --max-old-space-size=64. The paged verify completes; today's path (`verifyChain(await store.all(p))`,
 * the store without `eventRowsPage`) fails under the same cap.
 *
 * As there, the fixture keeps the ledger off the JS heap: the 50,000 event hashes sit in one Buffer, and each row is
 * generated from its seq, serialised and parsed again as D1 rows would be.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GENESIS_HASH, computeHash, createHandler } from "@retrace-dev/core";
import type { Event, EventRow, EventStore } from "@retrace-dev/core";

const MODE = process.env.RETRACE_VERIFY_MEMORY_CHILD;
const N = 50_000;
const RESULT = "VERIFY_MEMORY_RESULT ";
const TOKEN = "verify-memory-owner-token-0000000000";

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
  const row = (seq: number) => JSON.stringify({ ...body(seq, seq ? hex(seq - 1) : GENESIS_HASH), hash: hex(seq) });
  let pages = 0, heapUsed = 0;
  const base = { head: async () => ({ seq: N - 1, hash: hex(N - 1) }), all: async () => Array.from({ length: N }, (_, seq) => JSON.parse(row(seq)) as Event) };
  const store = (mode === "today" ? base : {
    ...base,
    all: async () => { throw new Error("the paged verify must not call all"); },
    eventRowsPage: async (_project: string, after: number | null, through: number, limit: number, maxChars: number) => {
      const page: EventRow[] = [];
      let chars = 0;
      for (let seq = after === null ? 0 : after + 1; seq <= through && page.length < limit && chars < maxChars; seq++) {
        const text = row(seq);
        chars += text.length;
        page.push({ seq, event: JSON.parse(text) as Event });
      }
      pages++;
      heapUsed = Math.max(heapUsed, process.memoryUsage().heapUsed);
      return page;
    },
  }) as unknown as EventStore;
  const started = Date.now();
  const res = await createHandler(store, { token: TOKEN })(new Request("https://retrace.example/projects/big/verify", { headers: { authorization: `Bearer ${TOKEN}` } }));
  const verdict = await res.json();
  process.stdout.write(`${RESULT}${JSON.stringify({ mode, status: res.status, verdict, pages, heapUsed, rss: process.memoryUsage().rss, ms: Date.now() - started })}\n`);
}

function run(mode: "paged" | "today") {
  const result = spawnSync(process.execPath, ["--max-old-space-size=64", fileURLToPath(import.meta.url)], {
    encoding: "utf8",
    env: { ...process.env, RETRACE_VERIFY_MEMORY_CHILD: mode },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 600_000,
  });
  const line = result.stdout.split("\n").find((l) => l.startsWith(RESULT));
  return { status: result.status, signal: result.signal, stderr: result.stderr, result: line ? JSON.parse(line.slice(RESULT.length)) : undefined };
}

if (MODE) {
  await child(MODE);
} else {
  test("50,000 events under --max-old-space-size=64: the paged /verify completes; today's path runs out of heap", { timeout: 1_200_000 }, (t) => {
    const paged = run("paged");
    assert.equal(paged.status, 0, `paged child: ${paged.signal ?? ""} ${paged.stderr.slice(-2_000)}`);
    const r = paged.result;
    assert.ok(r, "the paged child reported a result");
    assert.equal(r.status, 200);
    assert.deepEqual(r.verdict, { ok: true, checked: N, legacy_events: 0 });
    assert.ok(r.pages > 1, "more than one page");
    t.diagnostic(`paged /verify: ${r.verdict.checked} events in ${r.pages} pages, ${r.ms} ms, peak heapUsed ${(r.heapUsed / 2 ** 20).toFixed(1)} MiB, rss ${(r.rss / 2 ** 20).toFixed(1)} MiB`);

    const today = run("today");
    assert.notEqual(today.status, 0, `today's path completed under the cap: ${JSON.stringify(today.result)}`);
    assert.equal(today.result, undefined);
    assert.match(today.stderr, /heap out of memory|Reached heap limit/, today.stderr.slice(-2_000));
    t.diagnostic(`today's /verify: exit ${today.status} ${today.signal ?? ""}, ${today.stderr.match(/(Reached heap limit|heap out of memory)[^\n]*/)?.[0] ?? ""}`);
  });
}
