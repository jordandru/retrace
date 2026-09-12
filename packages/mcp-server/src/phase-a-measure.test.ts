import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@retrace-dev/core";
import {
  claimDecisionOf,
  measureEvents,
  measureHandshakeSchemas,
  parsePendingSealFile,
  countHookLogFailures,
  percentile,
  renderMarkdown,
  inWindow,
  CLASSIFIER_STATUSES,
} from "./phase-a-measure.js";

const HOST_VARS = /^(RETRACE_|ORCA_|CLAUDE_CODE_SESSION_ID$|GROK_SESSION_ID$)/;
const withCleanEnv = async (fn: () => Promise<void>) => {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => HOST_VARS.test(k)));
  for (const k of Object.keys(saved)) delete process.env[k];
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

function ev(partial: Partial<Event> & Pick<Event, "id" | "seq" | "action" | "actor">): Event {
  return {
    project: "p",
    artifacts: [{ id: "repo:p#a.ts", role: "generated" }],
    timestamp: `2026-09-11T00:00:${String(partial.seq).padStart(2, "0")}.000Z`,
    prev_hash: "0".repeat(64),
    hash: "a".repeat(64),
    received_at: `2026-09-11T00:00:${String(partial.seq).padStart(2, "0")}.000Z`,
    ...partial,
  } as Event;
}

function seal(partial: Partial<Event> & Pick<Event, "id" | "seq" | "actor">): Event {
  return ev({
    action: "committed",
    method: { tool: "git", params: { sha: `sha${partial.seq}` } },
    artifacts: [
      { id: `commit:p@${partial.seq}`, kind: "commit", role: "generated" },
      { id: "repo:p#a.ts", role: "generated" },
    ],
    ...partial,
  });
}

test("percentile is defined on a single value and interpolates", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([0, 10], 50), 5);
});

test("claimDecisionOf reads decision.classification_ms inside claim_decision, never as a sibling", () => {
  const e = seal({
    id: "evt_s",
    seq: 3,
    actor: { type: "agent", id: "grok" },
    method: {
      tool: "git",
      params: {
        sha: "abc",
        claim_decision: {
          decision: { status: "unresolved", reason: "unrooted", classification_ms: 12, actor_written: "claim", shadow: true },
        },
      },
    },
  });
  const cd = claimDecisionOf(e);
  assert.equal(cd?.status, "unresolved");
  assert.equal(cd?.classification_ms, 12);
  assert.equal("classification_ms" in (e.method?.params?.claim_decision as object), false);
});

test("measureEvents labels pre-shadow seals absent, counts /1 as legacy_client, and splits agent events by actor", () => {
  const events: Event[] = [
    ev({ id: "evt_i", seq: 0, action: "instructed", actor: { type: "human", id: "jordan" } }),
    ev({ id: "evt_a", seq: 1, action: "edited", actor: { type: "agent", id: "grok" } }),
    ev({ id: "evt_b", seq: 2, action: "edited", actor: { type: "agent", id: "codex" } }),
    seal({
      id: "evt_c1",
      seq: 3,
      actor: { type: "agent", id: "grok" },
      producer_sig: { kid: "k".repeat(8), sig: "s".repeat(40) }, // /1 — absent format
    }),
    ev({ id: "evt_d", seq: 4, action: "edited", actor: { type: "agent", id: "grok" } }),
    seal({
      id: "evt_c2",
      seq: 5,
      actor: { type: "human", id: "jordan" },
      method: {
        tool: "git",
        params: {
          sha: "sha5",
          claim_decision: { decision: { status: "no_agent_evidence", classification_ms: 9 } },
        },
      },
      producer_sig: { kid: "k".repeat(8), sig: "s".repeat(40), format: "retrace-producer-sig/2" },
      duration_ms: 40,
    }),
  ];
  const r = measureEvents(events);
  assert.equal(r.histogram.seals, 2);
  assert.equal(r.histogram.by_status.absent, 1);
  assert.equal(r.histogram.by_status.no_agent_evidence, 1);
  assert.equal(r.histogram.with_claim_decision, 1);
  assert.equal(r.legacy_client.count, 1);
  assert.equal(r.legacy_client.kind, "census");
  assert.equal(r.hook_producer_sig.v1_legacy_client, 1);
  assert.equal(r.hook_producer_sig.v2, 1);
  assert.equal(r.logs_per_commit.unique_shas, 2);
  assert.equal(r.logs_per_commit.intervals, 1);
  assert.equal(r.logs_per_commit.first_commit_dropped, true);
  assert.equal(r.logs_per_commit.by_actor.grok, 1);
  assert.equal(r.logs_per_commit.by_actor.codex, undefined);
  assert.equal(r.logs_per_commit.max, 1);
  assert.equal(r.tokens.stored_canonical_bytes.kind, "proxy");
  assert.ok((r.tokens.stored_canonical_bytes.n ?? 0) >= 1);
  assert.equal(r.tokens.method_tokens.kind, "missing");
  assert.equal(r.hook_wall_clock.kind, "census");
  assert.equal(r.hook_wall_clock.present, 1);
  assert.equal(r.hook_wall_clock.p50, 40);
  assert.equal(r.classification_ms.kind, "census");
  assert.equal(r.classification_ms.present, 1);
  assert.equal(r.classification_ms.over_500ms, 0);
  assert.equal(r.recorded_commit_actors.by_type.agent, 1);
  assert.equal(r.recorded_commit_actors.by_type.human, 1);
  for (const s of CLASSIFIER_STATUSES) assert.ok(s in r.histogram.by_status);
});

test("measureEvents window filters seals and still bounds intervals by the previous seal in the full chain", () => {
  const events: Event[] = [
    ev({ id: "evt_a", seq: 1, action: "edited", actor: { type: "agent", id: "grok" }, timestamp: "2026-09-01T00:00:00.000Z" }),
    seal({ id: "evt_c1", seq: 2, actor: { type: "agent", id: "grok" }, timestamp: "2026-09-01T00:01:00.000Z" }),
    ev({ id: "evt_b", seq: 3, action: "edited", actor: { type: "agent", id: "codex" }, timestamp: "2026-09-10T00:00:00.000Z" }),
    seal({ id: "evt_c2", seq: 4, actor: { type: "agent", id: "codex" }, timestamp: "2026-09-10T00:01:00.000Z" }),
  ];
  const r = measureEvents(events, { since: "2026-09-10T00:00:00.000Z" });
  assert.equal(r.histogram.seals, 1);
  assert.equal(r.logs_per_commit.intervals, 1);
  assert.equal(r.logs_per_commit.by_actor.codex, 1);
  assert.equal(r.logs_per_commit.by_actor.grok, undefined);
});

test("pending-seal file and hook-log failures are per-machine counts", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase-a-"));
  writeFileSync(join(dir, "retrace-pending-seal"), "aaa\nbbb\naaa\n");
  writeFileSync(join(dir, "retrace-hook.log"), "2026-09-11T00:00:00.000Z commit aaa in /repo NOT logged: 503\nok\n");
  assert.deepEqual(parsePendingSealFile(join(dir, "retrace-pending-seal")).sort(), ["aaa", "bbb"]);
  assert.equal(countHookLogFailures(join(dir, "retrace-hook.log")), 1);
});

test("renderMarkdown refuses to present a proxy as a census", () => {
  const r = measureEvents([
    seal({ id: "evt_c", seq: 1, actor: { type: "human", id: "jordan" } }),
  ]);
  const md = renderMarkdown({
    generated_at: "2026-09-11T00:00:00.000Z",
    bundle: { project: "p", events: 1, head_seq: 1 },
    window: {},
    ...r,
    pending_seals: { kind: "per-machine", queued_shas: [], hook_log_failures: null, note: "x" },
  });
  assert.match(md, /stored canonical bytes/);
  assert.match(md, / \| proxy \| /);
  assert.match(md, /legacy_client/);
  assert.match(md, /Kind: \*\*missing\*\*/);
  assert.doesNotMatch(md, /item 2 is printed/);
});

test("/1-signed seal with a client-supplied supported is absent, never a server decision", () => {
  const events = [
    seal({
      id: "evt_v1",
      seq: 1,
      actor: { type: "agent", id: "grok" },
      producer_sig: { kid: "k".repeat(8), sig: "s".repeat(40) },
      method: {
        tool: "git",
        params: {
          sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          claim_decision: { decision: { status: "supported" } },
        },
      },
    }),
  ];
  const r = measureEvents(events);
  assert.equal(r.legacy_client.count, 1);
  assert.equal(r.histogram.by_status.supported, 0);
  assert.equal(r.histogram.by_status.absent, 1);
  assert.equal(r.histogram.with_claim_decision, 0);
  assert.equal(claimDecisionOf(events[0]), undefined);
});

test("unsigned seal with only a top-level conflicting does not count — require decision.status", () => {
  const events = [
    seal({
      id: "evt_top",
      seq: 1,
      actor: { type: "agent", id: "grok" },
      method: {
        tool: "git",
        params: {
          sha: "aa".repeat(20),
          claim_decision: { status: "conflicting" },
        },
      },
    }),
  ];
  const r = measureEvents(events);
  assert.equal(r.hook_producer_sig.unsigned, 1);
  assert.equal(r.histogram.by_status.conflicting, 0);
  assert.equal(r.histogram.by_status.absent, 1);
  assert.equal(r.histogram.with_claim_decision, 0);
});

test("inWindow compares epoch time so mixed-offset git author dates sit on the correct side of both edges", () => {
  const since = "2026-09-11T06:00:00.000Z";
  const until = "2026-09-12T00:00:00.000Z";
  // 00:30-06:00 = 06:30Z: AFTER 06:00Z, IN the window. Lexical string compare would exclude it.
  assert.equal(inWindow("2026-09-11T00:30:00-06:00", { since, until }), true);
  // 23:47-06:00 = 05:47Z next day: AFTER until midnight Z, OUT. Lexical would include (09-11 < 09-12).
  assert.equal(inWindow("2026-09-11T23:47:18-06:00", { since, until }), false);
  assert.equal(inWindow("2026-09-11T06:00:00.000Z", { since, until }), true);
  assert.equal(inWindow("2026-09-10T23:59:59-06:00", { since, until }), false);
});

test("calls-per-commit is one interval per unique SHA; hook+webhook of the same sha do not deflate the count", () => {
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const events = [
    ev({ id: "evt_e1", seq: 1, action: "edited", actor: { type: "agent", id: "grok" } }),
    seal({
      id: "evt_hook_a", seq: 2, actor: { type: "agent", id: "grok" },
      method: { tool: "git", params: { sha: shaA, sealed_by: "assert:git hook (assert)" } },
    }),
    seal({
      id: "evt_wh_a", seq: 3, actor: { type: "system", id: "webhook:github" },
      method: { tool: "git", params: { sha: shaA, sealed_by: "webhook:github" } },
    }),
    ev({ id: "evt_e2", seq: 4, action: "edited", actor: { type: "agent", id: "codex" } }),
    ev({ id: "evt_e3", seq: 5, action: "edited", actor: { type: "agent", id: "codex" } }),
    seal({
      id: "evt_hook_b", seq: 6, actor: { type: "agent", id: "codex" },
      method: { tool: "git", params: { sha: shaB, sealed_by: "assert:git hook (assert)" } },
    }),
    seal({
      id: "evt_wh_b", seq: 7, actor: { type: "system", id: "webhook:github" },
      method: { tool: "git", params: { sha: shaB, sealed_by: "webhook:github" } },
    }),
  ];
  const r = measureEvents(events);
  assert.equal(r.histogram.seals, 4);
  assert.equal(r.logs_per_commit.unique_shas, 2);
  assert.equal(r.logs_per_commit.intervals, 1);
  assert.equal(r.logs_per_commit.by_actor.codex, 2);
  assert.equal(r.logs_per_commit.by_actor.grok, undefined);
  assert.equal(r.logs_per_commit.max, 2);
  assert.equal(r.logs_per_commit.zero_share, 0);
});

test("the first commit has no previous commit so it does not get a ledger-start interval", () => {
  const events = [
    ev({ id: "evt_e", seq: 1, action: "edited", actor: { type: "agent", id: "grok" } }),
    seal({ id: "evt_c", seq: 2, actor: { type: "agent", id: "grok" } }),
  ];
  const r = measureEvents(events);
  assert.equal(r.logs_per_commit.unique_shas, 1);
  assert.equal(r.logs_per_commit.intervals, 0);
  assert.equal(r.logs_per_commit.by_actor.grok, undefined);
  assert.equal(r.logs_per_commit.first_commit_dropped, true);
});

test("handshake schema census lists 11 local tools and the 9-tool Worker subset", async () => {
  await withCleanEnv(async () => {
    const h = await measureHandshakeSchemas();
    assert.equal(h.kind, "census");
    assert.equal(h.tool_count, 11);
    assert.equal(h.worker_audit_tool_count, 9);
    assert.ok(h.total_bytes > h.worker_audit_subset_bytes);
    assert.ok(h.worker_audit_subset_bytes > 0);
    const names = h.tools.map((t) => t.name);
    assert.ok(names.includes("retrace_log"));
    assert.ok(names.includes("retrace_amend"));
    assert.ok(names.includes("retrace_share"));
  });
});
