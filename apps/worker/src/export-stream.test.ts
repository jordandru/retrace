/** The cached export as the Worker builds it: core's streaming builder with the Worker's two-pass Ed25519 signer, byte
 *  for byte against `JSON.stringify(await buildExportBundle(…))`, and accepted by `retrace-export verify`
 *  (export-cache handoff db4bb0d6 §6 test 2). */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  GENESIS_HASH, MemoryEventStore, POLICY_PROFILE, StreamedFullExport, appendEvent, buildExportBundle, computeHash, createHandler,
  exportVerdictOk, generateSigningKey, newId, verifyExportBundle,
} from "@retrace-dev/core";
import type { Event, EventInput, ProducerKey } from "@retrace-dev/core";
import { createStreamingEd25519Signer } from "./ed25519-stream.js";

const CLI = fileURLToPath(new URL("../../../packages/mcp-server/dist/export-cli.js", import.meta.url));
const NOW = new Date("2026-10-13T05:07:00.000Z");
const TEXTS = ["plain ascii", "Latin-1 é ü ß", "dash — ellipsis … arrow →", "astral 😀 𝄞", "a lone \ud800 surrogate"];
const PRODUCERS: ProducerKey[] = [{ kid: "0123456789abcdef", public_key: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }, actor_id: "codex" }];

const input = (i: number, over: Partial<EventInput> = {}): EventInput => ({
  project: "p",
  actor: { type: i % 3 ? "agent" : "human", id: i % 3 ? "claude-code" : "jordan@example.com" },
  action: (["edited", "created", "sent", "received", "instructed"] as const)[i % 5],
  artifacts: [{ id: `repo:acme/app#src/f${i % 7}.ts`, role: "generated" }],
  intent: `${TEXTS[i % TEXTS.length]} #${i} ${"y".repeat(i % 13)}`,
  method: { tool: "test", params: { n: i, "7": "seven", nested: { z: [i, "→"], a: null } } },
  ...over,
});

async function appendLegacy(store: MemoryEventStore, i: number) {
  const head = await store.head("p");
  const received_at = new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString();
  const base = { ...input(i), id: newId(), seq: head ? head.seq + 1 : 0, timestamp: received_at, prev_hash: head?.hash ?? GENESIS_HASH, received_at };
  await store.insert({ ...base, hash: await computeHash(base) } as Event);
}

async function putPolicy(store: MemoryEventStore, stamps: string[], ifMatch: string): Promise<string> {
  const h = createHandler(store, { token: "owner-token-long-enough", ownerPrincipal: { type: "human", id: "owner@example.com" }, ownerActor: { type: "human", id: "owner@example.com" } });
  const res = await h(new Request("http://test/projects/p/policy", {
    method: "PUT",
    headers: { authorization: "Bearer owner-token-long-enough", "content-type": "application/json", "if-match": ifMatch },
    body: JSON.stringify({ profile: POLICY_PROFILE, project: "p", trusted_hook_stamps: stamps, unresolved_claims: "record", repositories: [], github_repos: [] }),
  }));
  assert.equal(res.status, 201);
  return ((await res.json()) as { digest: string }).digest;
}

async function ledger(n: number): Promise<MemoryEventStore> {
  const store = new MemoryEventStore();
  let policy: string | undefined;
  for (let i = 0; i < n; i++) {
    if (n >= 8 && i === Math.floor(n / 4)) policy = await putPolicy(store, ["assert:git hook (assert)"], "none");
    else if (n >= 8 && i === Math.floor(n / 2)) policy = await putPolicy(store, ["assert:git hook (assert)", "assert:release"], policy!);
    else if (i % 10 === 3 && i < n / 4) await appendLegacy(store, i);
    else if (policy && i % 5 === 0) await appendEvent(store, input(i, { method: { tool: "test", params: { n: i, context: { policy_digest: policy, read_head_seq: (await store.head("p"))!.seq } } } }));
    else await appendEvent(store, input(i));
  }
  return store;
}

function broken(store: MemoryEventStore, how: "body" | "gap" | "prev"): MemoryEventStore {
  const c = new MemoryEventStore();
  c.events = store.events.map((e) => structuredClone(e));
  c.policies = store.policies.map((d) => structuredClone(d));
  const i = Math.floor(c.events.length * 0.6);
  if (how === "body") c.events[i] = { ...c.events[i]!, intent: "edited after sealing" };
  if (how === "gap") c.events.splice(i, 1);
  if (how === "prev") c.events[i] = { ...c.events[i]!, prev_hash: "e".repeat(64) };
  return c;
}

test("Worker signer + streaming builder: the same bytes as buildExportBundle, the same verdict, and retrace-export verify passes", { timeout: 900_000 }, async () => {
  const key = await generateSigningKey();
  const dir = mkdtempSync(join(tmpdir(), "retrace-export-stream-"));
  try {
    writeFileSync(join(dir, "pub.json"), JSON.stringify(key.publicKey));
    const cases: Array<[string, MemoryEventStore, boolean]> = [];
    for (const n of [0, 1, 2, 999, 1_000, 1_001, 2_500]) cases.push([`${n} events`, await ledger(n), true]);
    const base = await ledger(300);
    for (const how of ["body", "gap", "prev"] as const) cases.push([`broken (${how})`, broken(base, how), false]);
    for (const [name, store, intact] of cases) {
      const expected = JSON.stringify(await buildExportBundle(store, { project: "p" }, { signingKey: key.privateKey, now: NOW, producers: PRODUCERS, issuerName: "retrace-api" }));
      const verdict = await verifyExportBundle(JSON.parse(expected), key.publicKey);
      assert.equal(exportVerdictOk(verdict), intact, `${name}: reference verdict`);
      for (const pages of [{}, { pageRows: 16 }, { pageChars: 4_000 }]) {
        const signer = createStreamingEd25519Signer(key.privateKey);
        const plan = await StreamedFullExport.plan(store, "p", { signer, now: NOW, producers: PRODUCERS, issuerName: "retrace-api", sha256: () => sha256.create(), ...pages });
        const chunks: Uint8Array[] = [];
        await plan.write({ write: async (c) => { chunks.push(c); } });
        signer.dispose();
        const bytes = Buffer.concat(chunks);
        const label = `${name}, ${JSON.stringify(pages)}`;
        assert.equal(bytes.length, plan.bytes, `${label}: length as pass 0 counted it`);
        assert.ok(bytes.equals(Buffer.from(expected, "utf8")), `${label}: byte-identical`);
        assert.deepEqual(await verifyExportBundle(JSON.parse(bytes.toString("utf8")), key.publicKey), verdict, `${label}: same verdict`);
        if (Object.keys(pages).length === 0) {
          const file = join(dir, "bundle.json");
          writeFileSync(file, bytes);
          const run = spawnSync(process.execPath, [CLI, "verify", file, "--pubkey", join(dir, "pub.json")], {
            cwd: dir, encoding: "utf8", env: { ...process.env, RETRACE_URL: "", RETRACE_TOKEN: "", RETRACE_PUBKEY: "" },
          });
          assert.equal(run.status, intact ? 0 : 2, `${label}: retrace-export verify exit ${run.status}\n${run.stdout}\n${run.stderr}`);
          assert.match(run.stdout, intact ? /^VALID — signature: valid/ : /^NOT VALID/, label);
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
