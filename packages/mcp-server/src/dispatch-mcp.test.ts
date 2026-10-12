import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { generateSigningKey, paneTextSha256, appendEvent } from "@retrace-dev/core";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./index.js";
import { SqliteStore } from "./sqlite-store.js";
import { deliveryFromScreen, ENTER_PRESSED_BY, type OrcaRunner, type ScreenRead } from "./dispatch-mcp.js";

const HANDLE = "term_11111111-2222-3333-4444-555555555555";
const HUMAN = "term_99999999-2222-3333-4444-555555555555";
const OWN = "term_00000000-2222-3333-4444-555555555555";
const INC = "977b50fe-87d7-435e-8e21-1b57da749867";
const ENV_KEYS = ["RETRACE_ACTOR", "RETRACE_ACTOR_MODEL", "RETRACE_ACTOR_MODEL_SOURCE", "RETRACE_ON_BEHALF_OF", "RETRACE_ACTOR_LOCK", "RETRACE_PROJECT", "RETRACE_PRODUCER_KEY", "RETRACE_PRODUCER_KEY_FILE", "RETRACE_PANES_FILE", "RETRACE_URL", "RETRACE_TOKEN", "RETRACE_DB", "RETRACE_TERMINAL", "ORCA_TERMINAL_HANDLE"];

type Screen = { lines?: string[]; draft?: string; source?: string; fail?: boolean };
type Fake = { calls: string[][]; screenLines: string[]; draft?: string; sendOk: boolean; listed: boolean; identity?: string; incarnation?: string; afterSend?: Screen[]; pending?: Screen[]; sentLine?: string };
function fakeOrca(f: Fake): OrcaRunner {
  return async (args) => {
    f.calls.push(args);
    if (args[0] === "terminal" && args[1] === "list") return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: f.listed ? [{ handle: HANDLE, title: "Reviewer", agentIdentity: f.identity ?? "codex", incarnationId: f.incarnation ?? INC, writable: true }] : [] } }), stderr: "crash-reporter: noise\n" };
    if (args[0] === "terminal" && args[1] === "read") {
      const s = f.pending?.shift();
      if (s?.fail) return { code: 1, stdout: "", stderr: "read failed" };
      const lines = (s?.lines ?? f.screenLines).map((l) => l.replace("__LINE__", f.sentLine ?? "__LINE__"));
      const draft = s ? s.draft : f.draft;
      return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { tail: lines, source: s?.source ?? "screen", truncated: true, ...(draft ? { draft } : {}) } } }), stderr: "" };
    }
    if (args[0] === "terminal" && args[1] === "send") { f.sentLine = args[5]; if (f.afterSend) f.pending = [...f.afterSend]; return f.sendOk ? { code: 0, stdout: JSON.stringify({ ok: true, result: { accepted: true, submission: "observed" } }), stderr: "" } : { code: 1, stdout: "", stderr: "transport failed" }; }
    return { code: 2, stdout: "", stderr: `unknown ${args.join(" ")}` };
  };
}

async function setup(f: Fake, registry: unknown, own: string | null = OWN) {
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
  // `dir` is the fake home: `~/.retrace/x/BRIEF.md` in the texts below is `${dir}/.retrace/x/BRIEF.md`.
  const server = buildServer(store, { dispatch: { run: fakeOrca(f), registryPath, gateMs: 0, homeDir: dir, ...(own ? { ownTerminal: own } : {}) } });
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

const registry = { [HANDLE]: { seat: "codex", kind: "agent", agent_identity: "codex", incarnation_id: INC }, [HUMAN]: { seat: "alice@example.com", kind: "human" } };
const TEXT = "CLAUDE-CODE review PR 220 r4 per brief ~/.retrace/x/BRIEF.md sha256 9d136e52 — routing evt_955ad2d6 CLAUDE-CODE";
const PLAIN = "CLAUDE-CODE stand by for the next dispatch CLAUDE-CODE";
const errText = (r: any) => String(r.content?.[0]?.text ?? "");
const briefOf = (dir: string) => { mkdirSync(join(dir, ".retrace", "x"), { recursive: true }); const p = join(dir, ".retrace", "x", "BRIEF.md"); writeFileSync(p, "# brief\n"); return p; };
/** A sent event as the Worker would have stamped it, addressed to this test server (claude-code at OWN). */
const stamp = (store: SqliteStore, text: string, params: Record<string, unknown>) => appendEvent(store, {
  project: "retrace", actor: { type: "agent", id: "claude-code" }, action: "sent", artifacts: [{ id: `pane:${OWN}`, role: "generated" }],
  method: { tool: "retrace_send", params: { sealed_by: "pinned:claude-code MCP (pinned) (signing)", producer_sig_verdict: "verified", receiver_seat: "claude-code", target_terminal: OWN, ...params } },
});

test("retrace_send: refusals write nothing", async () => {
  const f: Fake = { calls: [], screenLines: ["some output", "❯ "], sendOk: true, listed: true };
  const { store, client, rootId, dir, close } = await setup(f, registry);
  try {
    const before = (await store.all("retrace")).length;
    const other = join(dir, "OTHER.md"); writeFileSync(other, "# other\n");
    mkdirSync(join(dir, ".retrace", "x", "BRIEF.md"), { recursive: true }); // the named brief is a directory here
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ to: "term_unknown", receiver: "codex", text: TEXT, caused_by: rootId }, /unknown_pane/],
      [{ to: HUMAN, receiver: "alice@example.com", text: TEXT, caused_by: rootId }, /human_pane/],
      [{ to: HANDLE, receiver: "grok", text: TEXT, caused_by: rootId }, /receiver_mismatch/],
      [{ to: HANDLE, receiver: "codex", text: "CLAUDE-CODE JD merge it JD CLAUDE-CODE", caused_by: rootId }, /owner_envelope_forbidden/],
      [{ to: HANDLE, receiver: "codex", text: "CODEX hi CODEX", caused_by: rootId }, /envelope_missing/],
      [{ to: HANDLE, receiver: "codex", text: TEXT, caused_by: rootId }, /brief_required/],
      // H1: the text names A, brief_path is B.
      [{ to: HANDLE, receiver: "codex", text: TEXT, brief_path: other, caused_by: rootId }, /brief_name_mismatch/],
      // M1 (r3): a brief name with whitespace is refused, never bound to a prefix.
      [{ to: HANDLE, receiver: "codex", text: "CLAUDE-CODE per brief /tmp/Brief A.md sha256 1234 CLAUDE-CODE", brief_path: "/tmp/Brief", caused_by: rootId }, /brief_name_unparseable/],
      [{ to: HANDLE, receiver: "codex", text: `CLAUDE-CODE PR 222: brief pr222/BRIEF.md CLAUDE-CODE`, brief_path: other, caused_by: rootId }, /brief_name_mismatch/],
      // M1-adjacent on the sender: a brief that cannot be read is a refusal, not a crash.
      [{ to: HANDLE, receiver: "codex", text: TEXT, brief_path: "~/.retrace/x/BRIEF.md", caused_by: rootId }, /brief_unreadable/],
      [{ to: HANDLE, receiver: "codex", text: "CLAUDE-CODE per brief /nonexistent/brief.md CLAUDE-CODE", brief_path: "/nonexistent/brief.md", caused_by: rootId }, /brief_missing/],
    ];
    for (const [args, re] of cases) {
      const r = await client.callTool({ name: "retrace_send", arguments: args });
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(errText(r), re, JSON.stringify(args));
    }
    f.identity = "claude";
    const stale = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    assert.equal(stale.isError, true); assert.match(errText(stale), /identity_mismatch/);
    f.identity = undefined; f.incarnation = "relaunched-incarnation";
    const reused = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    assert.equal(reused.isError, true); assert.match(errText(reused), /incarnation_mismatch/, "M3: same identity, new incarnation");
    f.incarnation = undefined;
    f.screenLines = ["❯ JD typing JD"];
    const busy = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    assert.equal(busy.isError, true); assert.match(errText(busy), /composer_not_empty/);
    f.screenLines = ["❯ "]; f.draft = "JD";
    const draft = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    assert.equal(draft.isError, true); assert.match(errText(draft), /composer_not_empty/);
    assert.equal((await store.all("retrace")).length, before, "no refusal wrote an event");
    assert.equal(f.calls.filter((c) => c[1] === "send").length, 0, "nothing was sent");
  } finally { await close(); }
});

test("retrace_send: logs the sent event, sends the suffixed line, proves delivery from the screen; verify_send binds brief and receiver", async () => {
  const f: Fake = { calls: [], screenLines: ["❯ "], sendOk: true, listed: true, afterSend: [{ lines: ["older output", "> __LINE__", "❯ "] }] };
  const { store, client, rootId, dir, close } = await setup(f, registry);
  try {
    const brief = briefOf(dir);
    // The caller's enter_pressed_by is not an input any more (M4); passing it changes nothing.
    const r = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: TEXT, brief_path: "~/.retrace/x/BRIEF.md", routing_event_id: rootId, caused_by: rootId, enter_pressed_by: "alice@example.com" } });
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
    assert.equal(p.brief_path, brief, "the brief path is sealed resolved, so the receiver can bind to it (H1)");
    assert.equal(p.brief_named, "~/.retrace/x/BRIEF.md");
    assert.equal(p.target_terminal, HANDLE);
    assert.equal(p.receiver_seat, "codex");
    assert.equal(p.enter_pressed_by, ENTER_PRESSED_BY, "M4: the tool pressed Enter and says so, whatever the caller claims");
    assert.equal(p.target_incarnation_id, INC); assert.equal(p.pane_binding, "handle+identity+incarnation");
    assert.ok(sent!.producer_sig, "signed with the seat's producer key");
    const sendCall = f.calls.find((c) => c[1] === "send")!;
    assert.deepEqual(sendCall.slice(0, 4), ["terminal", "send", "--terminal", HANDLE]);
    assert.equal(sendCall[5], `${TEXT} [sent-event ${sent!.id}]`);
    assert.ok(sendCall.includes("--enter"));
    const outcome = await store.get(sc.outcome_event_id);
    assert.equal(outcome!.action, "executed"); assert.equal(outcome!.action_detail, "pane-message delivered");
    assert.equal(outcome!.caused_by, sent!.id);
    assert.equal((outcome!.method!.params as any).sent, true);
    assert.equal((outcome!.method!.params as any).enter_pressed_by, ENTER_PRESSED_BY);
    // the line is sent only after the sent event exists: list, read, read, [write], read, send, read
    assert.deepEqual(f.calls.map((c) => c[1]), ["list", "read", "read", "read", "send", "read"]);

    // Receiver side on a local store: the Worker stamps sealed_by/producer_sig_verdict server-side; here the sent
    // event has none, so the checks must FAIL on sealed_by — the local ledger is not a pinned seal.
    const v1 = await client.callTool({ name: "retrace_verify_send", arguments: { text: sc.line, brief_path: brief } });
    assert.equal(v1.isError, true);
    assert.equal((v1.structuredContent as any).verification.signature, "mismatch");
    assert.equal((v1.structuredContent as any).verification.failure, "sealed_by");
    const rec1 = await store.get((v1.structuredContent as any).received_event_id);
    assert.equal(rec1!.action, "received");
    assert.equal((rec1!.method!.params as any).input_signature, "mismatch");
    assert.equal((rec1!.method!.params as any).receiver_terminal, OWN);
    assert.equal(rec1!.caused_by, undefined, "an unverified receipt does not link to the sender's chain");

    // A sent event as the Worker would have stamped it, addressed to this seat at this terminal, verifies; the receipt links to it.
    const stamped = await stamp(store, TEXT, { text_sha256: p.text_sha256, brief_sha256: p.brief_sha256, brief_path: p.brief_path });
    const line2 = `${TEXT} [sent-event ${stamped.event.id}]`;
    const v2 = await client.callTool({ name: "retrace_verify_send", arguments: { text: line2, brief_path: brief, caused_by: rootId } });
    assert.notEqual(v2.isError, true, errText(v2));
    const s2 = v2.structuredContent as any;
    assert.equal(s2.verification.signature, "verified", JSON.stringify(s2.verification.checks));
    assert.equal(s2.act, true);
    const rec2 = await store.get(s2.received_event_id);
    assert.equal(rec2!.caused_by, stamped.event.id);
    assert.equal((rec2!.method!.params as any).own_root, rootId);
    assert.equal((rec2!.method!.params as any).brief_path, brief);
    // The receiver need not pass brief_path: the brief the text names is resolved and read (H1).
    const v2b = await client.callTool({ name: "retrace_verify_send", arguments: { text: line2 } });
    assert.equal((v2b.structuredContent as any).verification.signature, "verified", JSON.stringify((v2b.structuredContent as any).verification.checks));
    // A receiver that supplies a different file than the text names is refused (H1), receipt sealed.
    const other = join(dir, "OTHER.md"); writeFileSync(other, "# brief\n");
    const v2c = await client.callTool({ name: "retrace_verify_send", arguments: { text: line2, brief_path: other } });
    assert.equal((v2c.structuredContent as any).verification.failure, "brief_path"); assert.ok((v2c.structuredContent as any).received_event_id);
    // brief tampered after the send → mismatch, and the receipt is sealed anyway (H2 r1: no dry-check escape)
    writeFileSync(brief, "# brief\nedited\n");
    const v3 = await client.callTool({ name: "retrace_verify_send", arguments: { text: line2, brief_path: brief } });
    assert.equal((v3.structuredContent as any).verification.failure, "brief_sha256");
    assert.equal((v3.structuredContent as any).act, false);
    assert.ok((v3.structuredContent as any).received_event_id, "the receipt is always sealed");
    writeFileSync(brief, "# brief\n");
    // H2: the same valid dispatch addressed to another seat, or to another terminal, is refused here.
    const toGrok = await stamp(store, TEXT, { text_sha256: p.text_sha256, brief_sha256: p.brief_sha256, brief_path: p.brief_path, receiver_seat: "grok" });
    const vg = await client.callTool({ name: "retrace_verify_send", arguments: { text: `${TEXT} [sent-event ${toGrok.event.id}]` } });
    assert.equal((vg.structuredContent as any).verification.failure, "receiver_seat"); assert.equal((vg.structuredContent as any).act, false);
    const toOther = await stamp(store, TEXT, { text_sha256: p.text_sha256, brief_sha256: p.brief_sha256, brief_path: p.brief_path, target_terminal: HANDLE });
    const vt = await client.callTool({ name: "retrace_verify_send", arguments: { text: `${TEXT} [sent-event ${toOther.event.id}]` } });
    assert.equal((vt.structuredContent as any).verification.failure, "target_terminal"); assert.equal((vt.structuredContent as any).act, false);
    // H1: the relative form resolves through the event's brief_path and only to that file.
    mkdirSync(join(dir, ".retrace", "ops-2026-10-11", "pr222"), { recursive: true });
    const relBrief = join(dir, ".retrace", "ops-2026-10-11", "pr222", "BRIEF-222-r2.md"); writeFileSync(relBrief, "# r2\n");
    const relSha = createHash("sha256").update(readFileSync(relBrief)).digest("hex");
    const REL = "CLAUDE-CODE PR 222 round 2: brief pr222/BRIEF-222-r2.md sha256 abcd CLAUDE-CODE";
    const relOk = await stamp(store, REL, { text_sha256: await paneTextSha256(REL), brief_sha256: relSha, brief_path: relBrief });
    const vr = await client.callTool({ name: "retrace_verify_send", arguments: { text: `${REL} [sent-event ${relOk.event.id}]` } });
    assert.equal((vr.structuredContent as any).verification.signature, "verified", JSON.stringify((vr.structuredContent as any).verification.checks));
    const relNoBrief = await stamp(store, REL, { text_sha256: await paneTextSha256(REL) });
    const vn = await client.callTool({ name: "retrace_verify_send", arguments: { text: `${REL} [sent-event ${relNoBrief.event.id}]` } });
    assert.equal((vn.structuredContent as any).verification.signature, "mismatch", "a relative pointer with no brief on the event no longer verifies (H1)");
    assert.equal((vn.structuredContent as any).verification.failure, "brief_path");
    const relOtherFile = await stamp(store, REL, { text_sha256: await paneTextSha256(REL), brief_sha256: relSha, brief_path: other });
    const vo = await client.callTool({ name: "retrace_verify_send", arguments: { text: `${REL} [sent-event ${relOtherFile.event.id}]` } });
    assert.equal((vo.structuredContent as any).verification.failure, "brief_path", "a relative pointer bound to another file is refused (H1)");
    // H1 (r3): the receiver supplies the same tail under another ops-* directory (an identical file) → refused; the event's own path → verified.
    mkdirSync(join(dir, ".retrace", "ops-2026-10-12", "pr222"), { recursive: true });
    const otherOps = join(dir, ".retrace", "ops-2026-10-12", "pr222", "BRIEF-222-r2.md"); writeFileSync(otherOps, "# r2\n");
    const vx = await client.callTool({ name: "retrace_verify_send", arguments: { text: `${REL} [sent-event ${relOk.event.id}]`, brief_path: otherOps } });
    assert.equal((vx.structuredContent as any).verification.failure, "brief_path", "same tail, other ops-* directory: brief_path_mismatch");
    assert.match((vx.structuredContent as any).verification.checks.brief_path.detail, /^brief_path_mismatch/); assert.equal((vx.structuredContent as any).act, false);
    const vy = await client.callTool({ name: "retrace_verify_send", arguments: { text: `${REL} [sent-event ${relOk.event.id}]`, brief_path: relBrief } });
    assert.equal((vy.structuredContent as any).verification.signature, "verified", JSON.stringify((vy.structuredContent as any).verification.checks));
    assert.equal((await store.get((vy.structuredContent as any).received_event_id))!.method!.params!.brief_path, relBrief, "the file read is the event's path");
    // M1 (r3): an unparseable brief name on a received line is a failing check, not a prefix binding.
    const SP = "CLAUDE-CODE per brief /tmp/Brief A.md sha256 1234 CLAUDE-CODE";
    const spaced = await stamp(store, SP, { text_sha256: await paneTextSha256(SP), brief_sha256: "1".repeat(64), brief_path: "/tmp/Brief" });
    const vs = await client.callTool({ name: "retrace_verify_send", arguments: { text: `${SP} [sent-event ${spaced.event.id}]` } });
    assert.equal((vs.structuredContent as any).verification.failure, "brief_path"); assert.match((vs.structuredContent as any).verification.checks.brief_path.detail, /^brief_name_unparseable/);
    assert.ok((vs.structuredContent as any).received_event_id);
    // no suffix → missing
    const v4 = await client.callTool({ name: "retrace_verify_send", arguments: { text: TEXT } });
    assert.equal((v4.structuredContent as any).verification.signature, "missing");
  } finally { await close(); }
});

test("retrace_verify_send: every failure after the split still writes the received record (M1)", async () => {
  const f: Fake = { calls: [], screenLines: ["❯ "], sendOk: true, listed: true };
  const { store, client, dir, close } = await setup(f, registry);
  try {
    const before = (await store.all("retrace")).length;
    // The brief the text names is a directory: EISDIR on read.
    const dirBrief = join(dir, "dirbrief.md"); mkdirSync(dirBrief);
    const DTEXT = `CLAUDE-CODE per brief ${dirBrief} CLAUDE-CODE`;
    const ev = await stamp(store, DTEXT, { text_sha256: await paneTextSha256(DTEXT), brief_sha256: "1".repeat(64), brief_path: dirBrief });
    const v = await client.callTool({ name: "retrace_verify_send", arguments: { text: `${DTEXT} [sent-event ${ev.event.id}]`, brief_path: dirBrief } });
    assert.equal(v.isError, true);
    const sc = v.structuredContent as any;
    assert.equal(sc.verification.signature, "unverifiable"); assert.equal(sc.verification.failure, "brief_sha256");
    assert.match(sc.verification.checks.brief_sha256.detail, /EISDIR/);
    assert.ok(sc.received_event_id, "a received record names the failure");
    const rec = await store.get(sc.received_event_id);
    assert.equal((rec!.method!.params as any).input_signature, "unverifiable");
    assert.match((rec!.method!.params as any).checks.brief_sha256, /FAIL: the brief could not be read/);
    // A receiver-supplied directory for a plain text, and a nonexistent event: both leave a receipt.
    const ev2 = await stamp(store, PLAIN, { text_sha256: await paneTextSha256(PLAIN) });
    const v2 = await client.callTool({ name: "retrace_verify_send", arguments: { text: `${PLAIN} [sent-event ${ev2.event.id}]`, brief_path: dirBrief } });
    assert.equal((v2.structuredContent as any).act, false); assert.ok((v2.structuredContent as any).received_event_id);
    const v3 = await client.callTool({ name: "retrace_verify_send", arguments: { text: `${PLAIN} [sent-event evt_${"f".repeat(32)}]` } });
    assert.equal((v3.structuredContent as any).verification.failure, "exists"); assert.ok((v3.structuredContent as any).received_event_id);
    assert.equal((await store.all("retrace")).length - before, 5, "every call wrote exactly one receipt (plus the two stamped events)");
  } finally { await close(); }
});

test("retrace_verify_send: a server that does not know its own terminal cannot bind the dispatch and says so (H2)", async () => {
  const f: Fake = { calls: [], screenLines: ["❯ "], sendOk: true, listed: true };
  const { store, client, close } = await setup(f, registry, null);
  try {
    const ev = await stamp(store, PLAIN, { text_sha256: await paneTextSha256(PLAIN) });
    const v = await client.callTool({ name: "retrace_verify_send", arguments: { text: `${PLAIN} [sent-event ${ev.event.id}]` } });
    const sc = v.structuredContent as any;
    assert.equal(sc.verification.signature, "unverifiable"); assert.equal(sc.verification.failure, "target_terminal");
    assert.match(sc.verification.checks.target_terminal.detail, /does not know its own terminal handle/);
    assert.equal(sc.act, false);
    const rec = await store.get(sc.received_event_id);
    assert.equal((rec!.method!.params as any).receiver_terminal, "unknown");
  } finally { await close(); }
});

test("deliveryFromScreen: true only on positive evidence; sitting lines false; everything else unknown with a reason (M2)", () => {
  const id = "evt_" + "b".repeat(32);
  const read = (over: Partial<ScreenRead>): ScreenRead => ({ empty: true, last_line: "❯ ", rows: ["x", "❯ "], source: "screen", ...over });
  assert.deepEqual(deliveryFromScreen(read({ rows: ["older", `> ${PLAIN} [sent-event ${id}]`, "❯ "] }), PLAIN, id), { delivered: true });
  assert.deepEqual(deliveryFromScreen(read({ rows: ["older", `> ${PLAIN.slice(0, 30)}`, `${PLAIN.slice(30)} [sent-event ${id}]`, "⠋ thinking"], last_line: "⠋ thinking", empty: false }), PLAIN, id), { delivered: true }, "echoed and wrapped, the id on the continuation row, harness busy: delivered");
  assert.deepEqual(deliveryFromScreen(read({ rows: ["older", `> ${PLAIN} [sent-event ${id.slice(0, 20)}`, `${id.slice(20)}]`, "❯ "] }), PLAIN, id), { delivered: true }, "the id split across a wrap");
  // M2 (r3, Codex's probe): a row that matches only the text prefix is some earlier send of the same words, not this one.
  assert.deepEqual(deliveryFromScreen(read({ rows: ["older", `> ${PLAIN} [sent-event evt_${"0".repeat(32)}]`, "❯ "] }), PLAIN, id), { delivered: "unknown", reason: "stale_prefix_only" }, "an older row with another id");
  assert.deepEqual(deliveryFromScreen(read({ rows: ["older", `> ${PLAIN}`, "❯ "] }), PLAIN, id), { delivered: "unknown", reason: "stale_prefix_only" }, "a row with the text and no id");
  assert.deepEqual(deliveryFromScreen(read({ rows: ["older", `> ${PLAIN.slice(0, 30)}`, "⠋ thinking"], last_line: "⠋ thinking", empty: false }), PLAIN, id), { delivered: "unknown", reason: "stale_prefix_only" }, "cut off before the id: not evidence");
  assert.deepEqual(deliveryFromScreen(read({ error: "orca-ide terminal read exited 1" }), PLAIN, id), { delivered: "unknown", reason: "post_send_read_failed: orca-ide terminal read exited 1" });
  assert.deepEqual(deliveryFromScreen(read({ source: "screen-unavailable" }), PLAIN, id), { delivered: "unknown", reason: "post_send_screen_unavailable: source screen-unavailable" });
  assert.deepEqual(deliveryFromScreen(read({ rows: [], last_line: "", empty: false }), PLAIN, id), { delivered: "unknown", reason: "post_send_screen_empty" });
  assert.deepEqual(deliveryFromScreen(read({ rows: ["x", `» ${PLAIN} [sent-event ${id}]`], last_line: `» ${PLAIN} [sent-event ${id}]`, empty: false }), PLAIN, id), { delivered: false, reason: "line_sits_in_composer" });
  assert.deepEqual(deliveryFromScreen(read({ rows: ["x", `» ${PLAIN.slice(0, 30)}`], last_line: `» ${PLAIN.slice(0, 30)}`, empty: false }), PLAIN, id), { delivered: false, reason: "line_sits_in_composer" }, "a stuck line cut off by the screen width still sits");
  assert.deepEqual(deliveryFromScreen(read({ rows: ["x", `[sent-event ${id}]`], last_line: `[sent-event ${id}]`, empty: false }), PLAIN, id), { delivered: false, reason: "line_sits_in_composer" }, "a wrapped stuck line shows its suffix on the last row");
  assert.deepEqual(deliveryFromScreen(read({ draft: PLAIN.slice(0, 50) }), PLAIN, id), { delivered: false, reason: "line_sits_in_composer" });
  assert.deepEqual(deliveryFromScreen(read({}), PLAIN, id), { delivered: "unknown", reason: "line_not_on_screen" }, "a frame that shows the line nowhere is lag or loss, not delivery");
});

test("retrace_send: a failed orca send is not delivered; a stuck line is not delivered; an unreadable or lagging screen is unknown (M2)", async () => {
  const f: Fake = { calls: [], screenLines: ["❯ "], sendOk: false, listed: true };
  const { store, client, rootId, close } = await setup(f, registry);
  try {
    const r = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    const sc = r.structuredContent as any;
    assert.equal(sc.delivered, false);
    const outcome = await store.get(sc.outcome_event_id);
    assert.equal((outcome!.method!.params as any).sent, false);
    assert.equal((outcome!.method!.params as any).exit, 1);
    // The stuck line, cut off by the screen: still sits.
    f.sendOk = true; f.afterSend = [{ lines: [`» ${PLAIN.slice(0, 28)}`] }];
    const sits = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    const s2 = sits.structuredContent as any;
    assert.equal(s2.delivered, false); assert.equal(s2.outcome.accepted, true); assert.equal(s2.outcome.reason, "line_sits_in_composer");
    assert.match(String((sits.content as any)[0].text), /a human presses Enter as a separately logged keystroke/);
    assert.equal((await store.get(s2.outcome_event_id))!.action_detail, "pane-message not delivered");
    // The post-send read fails: unknown, never true.
    f.afterSend = [{ fail: true }];
    const unread = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    const s3 = unread.structuredContent as any;
    assert.equal(s3.delivered, "unknown"); assert.match(s3.outcome.reason, /^post_send_read_failed/);
    const o3 = await store.get(s3.outcome_event_id);
    assert.equal(o3!.action_detail, "pane-message delivery unknown"); assert.equal((o3!.method!.params as any).delivered, "unknown");
    assert.match(String((unread.content as any)[0].text), /delivery UNKNOWN/);
    // One read late: the first frame still shows the pre-send prompt; the second shows the echo with this send's id → delivered after a second look.
    f.afterSend = [{ lines: ["❯ "] }, { lines: ["> __LINE__", "❯ "] }];
    const lag = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    assert.equal((lag.structuredContent as any).delivered, true, JSON.stringify((lag.structuredContent as any).outcome));
    // M2 (r3): the transcript shows an earlier send of the same words (another id); this send's id never appears → unknown, not true, after two reads.
    f.afterSend = [{ lines: [`> ${PLAIN} [sent-event evt_${"0".repeat(32)}]`, "❯ "] }, { lines: [`> ${PLAIN} [sent-event evt_${"0".repeat(32)}]`, "❯ "] }];
    const stale2 = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    assert.equal((stale2.structuredContent as any).delivered, "unknown"); assert.equal((stale2.structuredContent as any).outcome.reason, "stale_prefix_only");
    assert.equal((await store.get((stale2.structuredContent as any).outcome_event_id))!.action_detail, "pane-message delivery unknown");
    // Two frames with the line nowhere: unknown, with the reason.
    f.afterSend = [{ lines: ["❯ "] }, { lines: ["❯ "] }];
    const lost = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    assert.equal((lost.structuredContent as any).delivered, "unknown"); assert.equal((lost.structuredContent as any).outcome.reason, "line_not_on_screen");
    // An empty frame: unknown.
    f.afterSend = [{ lines: [] }];
    const empty = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    assert.equal((empty.structuredContent as any).delivered, "unknown"); assert.equal((empty.structuredContent as any).outcome.reason, "post_send_screen_empty");
  } finally { await close(); }
});

test("retrace_send: an agent pane without agent_identity or incarnation_id in the registry is a refusal", async () => {
  const f: Fake = { calls: [], screenLines: ["❯ "], sendOk: true, listed: true };
  const a = await setup(f, { [HANDLE]: { seat: "codex", kind: "agent", incarnation_id: INC } });
  try {
    const r = await a.client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: a.rootId } });
    assert.equal(r.isError, true); assert.match(errText(r), /registry_invalid.*agent_identity/);
  } finally { await a.close(); }
  const b = await setup(f, { [HANDLE]: { seat: "codex", kind: "agent", agent_identity: "codex" } });
  try {
    const r = await b.client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: b.rootId } });
    assert.equal(r.isError, true); assert.match(errText(r), /registry_invalid.*incarnation_id/);
  } finally { await b.close(); }
});

test("retrace_send: no registry file is a refusal", async () => {
  const f: Fake = { calls: [], screenLines: ["❯ "], sendOk: true, listed: true };
  const { client, rootId, close } = await setup(f, undefined);
  try {
    const r = await client.callTool({ name: "retrace_send", arguments: { to: HANDLE, receiver: "codex", text: PLAIN, caused_by: rootId } });
    assert.equal(r.isError, true); assert.match(errText(r), /registry_missing/);
  } finally { await close(); }
});

test("retrace_log: a review verdict without its sealed shape is refused; a complete one is logged", async () => {
  const f: Fake = { calls: [], screenLines: ["❯ "], sendOk: true, listed: true };
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
