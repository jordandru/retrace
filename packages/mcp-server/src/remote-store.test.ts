import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteStore } from "./remote-store.js";

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
