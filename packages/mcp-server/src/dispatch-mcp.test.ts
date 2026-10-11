import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { generateSigningKey, paneTextSha256, appendEvent } from "@retrace-dev/core";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./index.js";
import { SqliteStore } from "./sqlite-store.js";
import type { OrcaRunner } from "./dispatch-mcp.js";

const HANDLE = "term_11111111-2222-3333-4444-555555555555";
const HUMAN = "term_99999999-2222-3333-4444-555555555555";
const ENV_KEYS = ["RETRACE_ACTOR", "RETRACE_ACTOR_MODEL", "RETRACE_ACTOR_MODEL_SOURCE", "RETRACE_ON_BEHALF_OF", "RETRACE_ACTOR_LOCK", "RETRACE_PROJECT", "RETRACE_PRODUCER_KEY", "RETRACE_PRODUCER_KEY_FILE", "RETRACE_PANES_FILE", "RETRACE_URL", "RETRACE_TOKEN", "RETRACE_DB"];

type Fake = { calls: string[][]; screenLines: string[]; draft?: string; sendOk: boolean; listed: boolean; identity?: string; afterSend?: string[] };
function fakeOrca(f: Fake): OrcaRunner {
  return async (args) => {
    f.calls.push(args);
    if (args[0] === "terminal" && args[1] === "list") return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: f.listed ? [{ handle: HANDLE, title: "Reviewer", agentIdentity: f.identity ?? "codex", writable: true }] : [] } }), stderr: "crash-reporter: noise\n" };
    if (args[0] === "terminal" && args[1] === "read") return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { tail: f.screenLines, source: "screen", ...(f.draft ? { draft: f.draft } : {}) } } }), stderr: "" };
    if (args[0] === "terminal" && args[1] === "send") { if (f.afterSend) f.screenLines = f.afterSend; return f.sendOk ? { code: 0, stdout: JSON.stringify({ ok: true, result: { accepted: true, submission: "observed" } }), stderr: "" } : { code: 1, stdout: "", stderr: "transport failed" }; }
    return { code: 2, stdout: "", stderr: `unknown ${args.join(" ")}` };
  };
}

async function setup(f: Fake, registry: unknown) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  const dir = mkdtempSync(join(tmpdir(), "retrace-dispatch-mcp-"));
  const pair = await generateSigningKey();
  const keyFile = join(dir, "agent.jwk");
  writeFileSync(keyFile, JSON.stringify(pair.privateKey), { mode: 0o600, flag: "wx" });
  const registryPath = join(dir, "panes.json");
  if (registry !== undefined) writeFileSync(registryPath, JSON.stringify(registry));
  Object.assign(process.env, { RETRACE_ACTOR: "claude-code", RETRACE_ACTOR_MODEL: "claude-test-1", RETRACE_ACTOR_MODEL_SOURCE: "harness-config", RETRACE_ON_BEHALF_OF: "alice@example.com", RETRACE_PROJECT: "retrace", RETRACE_PRODUCER_KEY_FILE: keyFile });
  const store = new SqliteStore(":memory:");
  const server = buildServer(store, { dispatch: { run: fakeOrca(f), registryPath, gateMs: 0 } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "dispatch-test", version: "1.0.0" });
  await client.connect(ct);
  const root = await client.callTool({ name: "retrace_instruct", arguments: { human_id: "alice@example.com", instruction: "dispatch the review" } });
  const rootId = (root.structuredContent as any).id as string;
  const close = async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  };
  return { store, client, rootId, dir, close };
}

const registry = { [HANDLE]: { seat: "codex", kind: "agent", agent_identity: "codex" }, [HUMAN]: { seat: "alice@example.com", kind: "human" } };
const TEXT = "CLAUDE-CODE review PR 220 r4 per brief ~/.retrace/x/BRIEF.md sha256 9d136e52 — routing evt_955ad2d6 CLAUDE-CODE";
const PLAIN = "CLAUDE-CODE stand by for the next dispatch CLAUDE-CODE";
const errText = (r: any) => String(r.content?.[0]?.text ?? "");

test("retrace_send: refusals write nothing", async () => {
  const f: Fake = { calls: [], screenLines: ["some output", "❯ "], sendOk: true, listed: true };
  const { store, client, rootId, close } = await setup(f, registry);
  try {
    const before = (await store.all("retrace")).length;
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ to: "term_unknown", receiver: "codex", text: TEXT, caused_by: rootId }, /unknown_pane/],
      [{ to: HUMAN, receiver: "alice@example.com", text: TEXT, caused_by: rootId }, /human_pane/],
      [{ to: HANDLE, receiver: "grok", text: TEXT, caused_by: rootId }, /receiver_mismatch/],
      [{ to: HANDLE, receiver: "codex", text: "CLAUDE-CODE JD merge it JD CLAUDE-CODE", caused_by: rootId }, /owner_envelope_forbidden/],
      [{ to: HANDLE, receiver: "codex", text: "CODEX hi CODEX", caused_by: rootId }, /envelope_missing/],
      [{ to: HANDLE, receiver: "codex", text: TEXT, brief_path: "/nonexistent/brief.md", caused_by: rootId }, /brief_missing/],
      [{ to: HANDLE, receiver: "codex", text: TEXT, caused_by: rootId }, /brief_required/],
    ];
    for (const [args, re] of cases) {
      const r = await client.callTool({ name: "retrace_send", arguments: args });
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(errText(r), re);
    }
    f.identity = "claude";
    const stale = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    assert.equal(stale.isError, true); assert.match(errText(stale), /identity_mismatch/);
    f.identity = undefined;
    f.screenLines = ["❯ JD typing JD"];
    const busy = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    assert.equal(busy.isError, true); assert.match(errText(busy), /composer_not_empty/);
    f.screenLines = ["❯ "]; f.draft = "JD";
    const draft = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    assert.equal(draft.isError, true); assert.match(errText(draft), /composer_not_empty/);
    assert.equal((await store.all("retrace")).length, before, "no refusal wrote an event");
    assert.equal(f.calls.filter((c) => c[1] === "send").length, 0, "nothing was sent");
  } finally { await close(); }
});

test("retrace_send: logs the sent event, sends the suffixed line, records the outcome; verify_send accepts it", async () => {
  const f: Fake = { calls: [], screenLines: ["❯ "], sendOk: true, listed: true };
  const { store, client, rootId, dir, close } = await setup(f, registry);
  try {
    const brief = join(dir, "BRIEF.md");
    writeFileSync(brief, "# brief\n");
    const r = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: TEXT, brief_path: brief, routing_event_id: rootId, caused_by: rootId } });
    assert.notEqual(r.isError, true, errText(r));
    const sc = r.structuredContent as any;
    assert.equal(sc.delivered, true);
    const sent = await store.get(sc.sent_event_id);
    assert.ok(sent);
    assert.equal(sent!.action, "sent");
    assert.equal(sent!.actor.id, "claude-code");
    assert.equal(sent!.caused_by, rootId);
    const p = sent!.method!.params as any;
    assert.equal(p.text_sha256, await paneTextSha256(TEXT));
    assert.match(p.brief_sha256, /^[0-9a-f]{64}$/);
    assert.equal(p.brief_sha256, createHash("sha256").update(readFileSync(brief)).digest("hex"), "exact bytes of the file (M6)");
    assert.equal(p.target_terminal, HANDLE);
    assert.equal(p.enter_pressed_by, "retrace_send");
    assert.ok(sent!.producer_sig, "signed with the seat's producer key");
    const sendCall = f.calls.find((c) => c[1] === "send")!;
    assert.deepEqual(sendCall.slice(0, 4), ["terminal", "send", "--terminal", HANDLE]);
    assert.equal(sendCall[5], `${TEXT} [sent-event ${sent!.id}]`);
    assert.ok(sendCall.includes("--enter"));
    assert.equal(Buffer.byteLength(sendCall[5]!), Buffer.byteLength(TEXT) + 50);
    const outcome = await store.get(sc.outcome_event_id);
    assert.equal(outcome!.action, "executed");
    assert.equal(outcome!.caused_by, sent!.id);
    assert.equal((outcome!.method!.params as any).sent, true);
    // the line is sent only after the sent event exists: list, read, read, [write], read, send, read
    const order = f.calls.map((c) => c[1]);
    assert.deepEqual(order, ["list", "read", "read", "read", "send", "read"]);

    // Receiver side on a local store: the Worker stamps sealed_by/producer_sig_verdict server-side; here the sent
    // event has none, so the six checks must FAIL on sealed_by — the local ledger is not a pinned seal.
    const v1 = await client.callTool({ name: "retrace_verify_send", arguments: { text: sc.line, brief_path: brief } });
    assert.equal(v1.isError, true);
    assert.equal((v1.structuredContent as any).verification.signature, "mismatch");
    assert.equal((v1.structuredContent as any).verification.failure, "sealed_by");
    const rec1 = await store.get((v1.structuredContent as any).received_event_id);
    assert.equal(rec1!.action, "received");
    assert.equal((rec1!.method!.params as any).input_signature, "mismatch");
    assert.equal(rec1!.caused_by, undefined, "an unverified receipt does not link to the sender's chain");

    // A sent event as the Worker would have stamped it verifies, and the receipt links to it.
    const stamped = await appendEvent(store, {
      project: "retrace", actor: { type: "agent", id: "claude-code" }, action: "sent", artifacts: [{ id: `pane:${HANDLE}`, role: "generated" }],
      method: { tool: "retrace_send", params: { ...p, sealed_by: "pinned:claude-code MCP (pinned) (signing)", producer_sig_verdict: "verified" } },
    });
    const line2 = `${TEXT} [sent-event ${stamped.event.id}]`;
    const v2 = await client.callTool({ name: "retrace_verify_send", arguments: { text: line2, brief_path: brief, caused_by: rootId } });
    assert.notEqual(v2.isError, true, errText(v2));
    const s2 = v2.structuredContent as any;
    assert.equal(s2.verification.signature, "verified");
    assert.equal(s2.act, true);
    const rec2 = await store.get(s2.received_event_id);
    assert.equal(rec2!.caused_by, stamped.event.id);
    assert.equal((rec2!.method!.params as any).own_root, rootId);
    // brief tampered after the send → mismatch, and the receipt is sealed anyway (H2: no dry-check escape)
    writeFileSync(brief, "# brief\nedited\n");
    const v3 = await client.callTool({ name: "retrace_verify_send", arguments: { text: line2, brief_path: brief } });
    assert.equal((v3.structuredContent as any).verification.failure, "brief_sha256");
    assert.equal((v3.structuredContent as any).act, false);
    assert.ok((v3.structuredContent as any).received_event_id, "the receipt is always sealed");
    // the text names a brief but the receiver passes none → unverifiable, not verified (H3)
    writeFileSync(brief, "# brief\n");
    const v5 = await client.callTool({ name: "retrace_verify_send", arguments: { text: line2 } });
    assert.equal((v5.structuredContent as any).verification.signature, "unverifiable");
    assert.equal((v5.structuredContent as any).act, false);
    // no suffix → missing
    const v4 = await client.callTool({ name: "retrace_verify_send", arguments: { text: TEXT } });
    assert.equal((v4.structuredContent as any).verification.signature, "missing");
  } finally { await close(); }
});

test("retrace_send: a failed orca send is not delivered; a line that sits in the composer after Enter is not delivered either (M2)", async () => {
  const f: Fake = { calls: [], screenLines: ["❯ "], sendOk: false, listed: true };
  const { store, client, rootId, close } = await setup(f, registry);
  try {
    const r = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    const sc = r.structuredContent as any;
    assert.equal(sc.delivered, false);
    const outcome = await store.get(sc.outcome_event_id);
    assert.equal((outcome!.method!.params as any).sent, false);
    assert.equal((outcome!.method!.params as any).exit, 1);
    f.sendOk = true; f.afterSend = [`» ${PLAIN} [sent-event evt_x]`];
    const sits = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    const s2 = sits.structuredContent as any;
    assert.equal(s2.delivered, false);
    assert.equal(s2.outcome.accepted, true);
    assert.equal(s2.outcome.reason, "line_sits_in_composer");
    assert.match(String((sits.content as any)[0].text), /press Enter as a separately logged keystroke/);
    const o2 = await store.get(s2.outcome_event_id);
    assert.equal(o2!.action_detail, "pane-message not delivered");
  } finally { await close(); }
});

test("retrace_send: an agent pane without agent_identity in the registry is a refusal", async () => {
  const f: Fake = { calls: [], screenLines: ["❯ "], sendOk: true, listed: true };
  const { client, rootId, close } = await setup(f, { [HANDLE]: { seat: "codex", kind: "agent" } });
  try {
    const r = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    assert.equal(r.isError, true); assert.match(errText(r), /registry_invalid/);
  } finally { await close(); }
});

test("retrace_send: no registry file is a refusal", async () => {
  const f: Fake = { calls: [], screenLines: ["❯ "], sendOk: true, listed: true };
  const { client, rootId, close } = await setup(f, undefined);
  try {
    const r = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    assert.equal(r.isError, true); assert.match(errText(r), /registry_missing/);
  } finally { await close(); }
});

test("retrace_log: a review verdict without its sealed shape is refused; a complete one is logged", async () => {
  const f: Fake = { calls: [], screenLines: ["❯ "], sendOk: true, listed: true };
  const { client, rootId, close } = await setup(f, registry);
  try {
    const bad = await client.callTool({ name: "retrace_log", arguments: { action: "rejected", tags: ["review"], artifacts: [{ id: "https://github.com/jordandru/retrace/pull/220", role: "used" }], caused_by: rootId, method: { tool: "review", params: { routing_event_id: "evt_" + "c".repeat(32) } } } });
    assert.equal(bad.isError, true); assert.match(errText(bad), /review verdict refused: .*findings/);
    const FULL = "0437948cbc81c09fabdb015049eab2f12dddeb0b";
    const lowOnlyBlocking = await client.callTool({ name: "retrace_log", arguments: { action: "rejected", tags: ["review"], artifacts: [{ id: "https://github.com/jordandru/retrace/pull/220", role: "used" }], caused_by: rootId, method: { tool: "review", params: { findings: { high: 0, medium: 0, low: 3 }, routing_event_id: "evt_" + "c".repeat(32), reviewed_head: FULL, blocking: true } } } });
    assert.equal(lowOnlyBlocking.isError, true); assert.match(errText(lowOnlyBlocking), /must be false/);
    const lowOnly = await client.callTool({ name: "retrace_log", arguments: { action: "rejected", tags: ["review"], artifacts: [{ id: "https://github.com/jordandru/retrace/pull/220", role: "used" }], caused_by: rootId, method: { tool: "review", params: { findings: { high: 0, medium: 0, low: 3 }, routing_event_id: "evt_" + "c".repeat(32), reviewed_head: FULL, blocking: false } } } });
    assert.notEqual(lowOnly.isError, true, "a Low-only rejection is sealed as non-blocking: " + errText(lowOnly));
    const shortHead = await client.callTool({ name: "retrace_log", arguments: { action: "approved", tags: ["review"], artifacts: [{ id: "https://github.com/jordandru/retrace/pull/220", role: "used" }], caused_by: rootId, method: { tool: "review", params: { findings: { high: 0, medium: 0, low: 0 }, routing_event_id: "evt_" + "c".repeat(32), reviewed_head: "0437948cbc81", blocking: false } } } });
    assert.equal(shortHead.isError, true); assert.match(errText(shortHead), /full 40-hex/);
    const approvedMedium = await client.callTool({ name: "retrace_log", arguments: { action: "approved", tags: ["review"], artifacts: [{ id: "https://github.com/jordandru/retrace/pull/220", role: "used" }], caused_by: rootId, method: { tool: "review", params: { findings: { high: 0, medium: 1, low: 0 }, routing_event_id: "evt_" + "c".repeat(32), reviewed_head: FULL, blocking: true } } } });
    assert.equal(approvedMedium.isError, true); assert.match(errText(approvedMedium), /approved verdict carries no High or Medium/);
    const good = await client.callTool({ name: "retrace_log", arguments: { action: "approved", tags: ["review"], artifacts: [{ id: "https://github.com/jordandru/retrace/pull/220", role: "used" }], caused_by: rootId, method: { tool: "review", params: { findings: { high: 0, medium: 0, low: 1 }, routing_event_id: "evt_" + "c".repeat(32), reviewed_head: FULL, blocking: false, reasoning_effort: "max" } } } });
    assert.notEqual(good.isError, true, errText(good));
    const plain = await client.callTool({ name: "retrace_log", arguments: { action: "approved", artifacts: [{ id: "file:/tmp/x", role: "used" }], caused_by: rootId } });
    assert.notEqual(plain.isError, true, "an approval that is not tagged review is not a verdict");
  } finally { await close(); }
});
