import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { RemoteStore, fetchRetryingSocketFailure } from "./remote-store.js";
import { retryableHookFailure } from "./git-hook.js";

test("F2b: duplicate key in a fetched export bundle is refused", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    '{"format":"retrace-export/1","trusted_hook_stamps":["X"],"trusted_hook_stamps":["Y"]}',
    { status: 200, headers: { "content-type": "application/json" } },
  );
  try {
    await assert.rejects(
      () => new RemoteStore("https://mock.test").export({ project: "p" }),
      /duplicate object key|invalid export bundle/,
    );
  } finally {
    globalThis.fetch = saved;
  }
});

test("F2b: duplicate key in a fetched event is refused", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    '{"id":"evt_1","id":"evt_1"}',
    { status: 200, headers: { "content-type": "application/json" } },
  );
  try {
    await assert.rejects(
      () => new RemoteStore("https://mock.test").get("evt_1"),
      /duplicate object key/,
    );
  } finally {
    globalThis.fetch = saved;
  }
});

test("#163 an idempotent GET whose socket the server closed is sent once more on a fresh connection; a POST is not", async () => {
  // the first connection to each path is destroyed before any response, as a keep-alive socket closed during a long
  // blocking step looks to the client; the second request on that path is answered
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    seen.push(key);
    if (seen.filter((k) => k === key).length === 1) { req.socket.destroy(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.method === "GET" ? { seq: 7, hash: "h" } : { event: { id: "evt_x" }, deduped: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const store = new RemoteStore(url, "tok");
    assert.deepEqual(await store.head("p"), { seq: 7, hash: "h" }, "the GET succeeded on its second attempt");
    assert.equal(seen.filter((k) => k === "GET /projects/p/head").length, 2);
    await assert.rejects(
      () => store.append({ project: "p", actor: { type: "agent", id: "a" }, action: "edited", artifacts: [{ id: "x" }] }),
      (e: unknown) => {
        assert.match((e as Error).message, /Retrace API POST .*\/events: fetch failed \(cause: /);
        // the ORIGINAL error is rethrown, not a wrapper: the git hook classifies a transport failure by its type and
        // queues the seal; a plain Error wrapper hid the TypeError and the seal was lost (Codex, fresh round, 2026-10-10)
        assert.ok(e instanceof TypeError, "the socket failure keeps its TypeError identity");
        assert.equal(retryableHookFailure(e), true, "the hook still queues it for a later seal");
        return true;
      },
    );
    assert.equal(seen.filter((k) => k === "POST /events").length, 1, "a POST is never repeated: it may have reached the server");
    // a second socket failure in a row is reported, with its cause, not retried forever
    const twice = createServer((req) => req.socket.destroy());
    await new Promise<void>((resolve) => twice.listen(0, "127.0.0.1", resolve));
    try {
      const dead = `http://127.0.0.1:${(twice.address() as AddressInfo).port}`;
      await assert.rejects(() => fetchRetryingSocketFailure(`${dead}/x`, { method: "GET" }), /Retrace API GET .*\/x: fetch failed \(cause: /);
      // a deadline keeps its name too: AbortSignal.timeout rejects with a TimeoutError the hook recognises
      const slow = createServer(() => { /* never answers */ });
      await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
      try {
        const stuck = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
        await assert.rejects(
          () => fetchRetryingSocketFailure(`${stuck}/y`, { method: "POST", signal: AbortSignal.timeout(100) }),
          (e: unknown) => { assert.equal((e as Error).name, "TimeoutError"); assert.equal(retryableHookFailure(e), true); assert.match(String((e as Error).cause), /Retrace API POST .*\/y: /, "a read-only DOMException message: the diagnosis rides on cause"); return true; },
        );
      } finally { slow.closeAllConnections?.(); slow.close(); }
    } finally { twice.close(); }
  } finally {
    server.close();
  }
});

test("#237 RemoteStore.all reads a ledger larger than the history cap in capped pages; a request for 100,000 rows is clamped", async () => {
  const { HISTORY_LIMIT_MAX, MemoryEventStore, createHandler } = await import("@retrace-dev/core");
  const TOKEN = "owner-token-for-history-cap-test-0000";
  const ledger = new MemoryEventStore();
  const total = HISTORY_LIMIT_MAX * 2 + 3;
  for (let seq = 0; seq < total; seq++) {
    await ledger.insert({
      id: `evt_${seq}`, project: "p", seq, timestamp: "2026-09-01T00:00:00.000Z", received_at: "2026-09-01T00:00:00.000Z",
      actor: { type: "agent", id: "x" }, action: "edited", artifacts: [{ id: "a" }], prev_hash: "0", hash: `h${seq}`,
    });
  }
  const handler = createHandler(ledger, { token: TOKEN });
  const searches: string[] = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const req = new Request(input as string, init);
    searches.push(new URL(req.url).search);
    return handler(req);
  };
  try {
    const all = await new RemoteStore("https://mock.test", TOKEN).all("p");
    assert.equal(all.length, total);
    assert.deepEqual(all.map((e) => e.seq), Array.from({ length: total }, (_, seq) => seq), "every event, ascending, none twice");
    assert.equal(searches.length, 3, "two full pages and the remainder");
    for (const search of searches) assert.match(search, new RegExp(`[?&]limit=${HISTORY_LIMIT_MAX}(&|$)`));
    const res = await handler(new Request("https://mock.test/projects/p/events?limit=100000", { headers: { authorization: `Bearer ${TOKEN}` } }));
    assert.equal(res.status, 200);
    const page = await res.json() as { events: Array<{ seq: number }>; truncated: boolean; next_before_seq?: number };
    assert.equal(page.events.length, HISTORY_LIMIT_MAX);
    assert.equal(page.truncated, true);
    assert.equal(page.next_before_seq, total - HISTORY_LIMIT_MAX);
    assert.equal(page.events.at(-1)?.seq, total - 1);
  } finally {
    globalThis.fetch = saved;
  }
});

