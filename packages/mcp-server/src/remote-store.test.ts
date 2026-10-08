import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { RemoteStore, fetchRetryingSocketFailure } from "./remote-store.js";

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
      (e: unknown) => { assert.match((e as Error).message, /Retrace API POST .*\/events: fetch failed \(cause: /); return true; },
    );
    assert.equal(seen.filter((k) => k === "POST /events").length, 1, "a POST is never repeated: it may have reached the server");
    // a second socket failure in a row is reported, with its cause, not retried forever
    const twice = createServer((req) => req.socket.destroy());
    await new Promise<void>((resolve) => twice.listen(0, "127.0.0.1", resolve));
    try {
      const dead = `http://127.0.0.1:${(twice.address() as AddressInfo).port}`;
      await assert.rejects(() => fetchRetryingSocketFailure(`${dead}/x`, { method: "GET" }), /Retrace API GET .*\/x: fetch failed \(cause: /);
    } finally { twice.close(); }
  } finally {
    server.close();
  }
});
