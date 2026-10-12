import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseArgs, collectEventIds, renderEvent, routingProblem, credentialNamesSeat, extractRuleItems, citedRuleNumbers, gateLines, trimToBudget,
  reviewSurface, build, DEFAULT_MAX_BYTES, NOOA_MODEL, PARAM_KEYS_CARRIED,
} from "./build-packet.mjs";

const HEAD = "6ac80c98c75b01118ca9aaabcf44b1957e1dc1ca";
const BASE = "f6e9ec225f5ee3a5b1f4babef6ed4f5bce74ced7";
const ROUTING = "evt_" + "a".repeat(32);
const CITED = "evt_" + "b".repeat(32);
const DIFF_ONLY = "evt_" + "e".repeat(32);
const INTERDIFF_ONLY = "evt_" + "f".repeat(32);
const here = dirname(fileURLToPath(import.meta.url));

const argvOk = ["--pr", "222", "--head", HEAD, "--routing", ROUTING, "--round", "r1", "--rubric", "high", "--class", "a", "--rules-file", "rules.md"];

/** A routing event as the coordinator seals them (shape of evt_8d2412b6, PR 225 r1, NOOA seat). */
function routingEvent(over = {}) {
  const { params: paramsOver = {}, ...top } = over;
  return {
    id: ROUTING, seq: 17773, timestamp: "2026-10-11T22:47:53.217Z", action: "other", action_detail: "review-routing",
    actor: { type: "agent", id: "claude-code", model: "claude-mythos-5-1", model_source: "harness-runtime" },
    tags: ["pr-222", "class-a", "routing", "nooa", "r1"], intent: "Route the witness review",
    artifacts: [{ id: "https://github.com/jordandru/retrace/pull/222", kind: "pull_request", role: "used" }],
    producer_sig: { kid: "k", sig: "s".repeat(80) }, hash: "h", prev_hash: "p", hash_v: 2, location: { device: "laptop" },
    method: { tool: "routing", params: {
      pr: 222, round: "r1", class: "a", seat: "nooa", seat_order: "witness", reviewer_actor: "nooa", model: NOOA_MODEL, reasoning_effort: "high",
      head_sha: HEAD, base_sha: BASE, sealed_by: "pinned:claude-code MCP (pinned) (signing)", producer_sig_verdict: "verified", ...paramsOver,
    } },
    ...top,
  };
}

test("parseArgs: required flags and their shapes; --model and unknown flags are refused", () => {
  const o = parseArgs(argvOk);
  assert.equal(o.pr, 222); assert.equal(o.maxBytes, DEFAULT_MAX_BYTES); assert.equal(o.ci, false); assert.equal(o.model, NOOA_MODEL);
  assert.throws(() => parseArgs(argvOk.slice(2)), /--pr is required/);
  assert.throws(() => parseArgs([...argvOk.slice(0, 3), "6ac80c9", ...argvOk.slice(4)]), /--head/);
  assert.throws(() => parseArgs([...argvOk, "--routing", "evt_short"]), /--routing/);
  assert.throws(() => parseArgs([...argvOk, "--class", "x"]), /--class/);
  assert.throws(() => parseArgs([...argvOk, "--model", "nvidia_nim/not-the-routed-model"]), /--model is not a flag/, "M2: the model is pinned, not chosen");
  assert.throws(() => parseArgs([...argvOk, "--modle", "x"]), /unknown flag --modle/);
  assert.equal(parseArgs([...argvOk, "--ci", "--status", "--max-bytes", "1000"]).maxBytes, 1000);
});

test("collectEventIds: full ids only, first occurrence order, no duplicates", () => {
  const ids = collectEventIds([`see ${CITED} and ${ROUTING}`, `again ${CITED} and evt_abc (short) and evt_${"c".repeat(32)}`, undefined]);
  assert.deepEqual(ids, [CITED, ROUTING, "evt_" + "c".repeat(32)]);
});

test("credentialNamesSeat: the pinned credential must carry the seat id as a word", () => {
  assert.ok(credentialNamesSeat("pinned:claude-code MCP (pinned) (signing)", "claude-code"));
  assert.ok(credentialNamesSeat("pinned:codex (signing)", "codex"));
  assert.ok(!credentialNamesSeat("pinned:grok MCP (pinned) (signing)", "claude-code"));
  assert.ok(!credentialNamesSeat("pinned:claude-code-cloud (signing)", "claude-code"), "a longer id containing the seat is another seat");
  assert.ok(!credentialNamesSeat("claude-code MCP (pinned) (signing)", "claude-code"), "not pinned");
  assert.ok(!credentialNamesSeat(undefined, "claude-code"));
});

test("routingProblem: authenticates and binds the routing event to the build request (H3, M2)", () => {
  const o = parseArgs(argvOk);
  assert.equal(routingProblem(routingEvent(), o), undefined);
  assert.match(routingProblem(undefined, o), /could not be read/);
  assert.match(routingProblem(routingEvent({ id: CITED }), o), /not evt_a/);
  assert.match(routingProblem(routingEvent({ method: { tool: "retrace_log", params: routingEvent().method.params } }), o), /method.tool is "retrace_log"/);
  assert.match(routingProblem(routingEvent({ actor: { type: "agent", id: "grok" } }), o), /actor is agent\/grok/);
  assert.match(routingProblem(routingEvent({ actor: { type: "human", id: "claude-code" } }), o), /actor is human\/claude-code/);
  assert.match(routingProblem(routingEvent({ params: { sealed_by: "pinned:grok MCP (pinned) (signing)" } }), o), /sealed_by .* not the pinned claude-code credential/);
  assert.match(routingProblem(routingEvent({ params: { sealed_by: undefined } }), o), /sealed_by is null/);
  assert.match(routingProblem(routingEvent({ params: { producer_sig_verdict: "unverified" } }), o), /producer_sig_verdict is "unverified"/);
  assert.match(routingProblem(routingEvent({ params: { pr: 223 } }), o), /params.pr is 223, not 222/);
  assert.match(routingProblem(routingEvent({ params: { head_sha: BASE } }), o), /params.head_sha is/);
  assert.match(routingProblem(routingEvent({ params: { head_sha: HEAD.slice(0, 12) } }), o), /params.head_sha is "6ac80c98c75b"/, "a prefix is not the full head");
  assert.match(routingProblem(routingEvent({ params: { class: "c" } }), o), /params.class is "c", not "a"/);
  assert.match(routingProblem(routingEvent({ params: { round: "r2" } }), o), /params.round is "r2"/);
  assert.match(routingProblem(routingEvent({ params: { reasoning_effort: "max" } }), o), /params.reasoning_effort is "max", not "high"/);
  assert.match(routingProblem(routingEvent({ params: { seat: "codex", reviewer_actor: "codex" } }), o), /params.seat is "codex", not "nooa"/);
  assert.match(routingProblem(routingEvent({ params: { reviewer_actor: "codex" } }), o), /params.reviewer_actor is "codex"/);
  assert.match(routingProblem(routingEvent({ params: { model: "nvidia_nim/not-the-routed-model" } }), o), /params.model is "nvidia_nim\/not-the-routed-model"/, "M2: a prefix match is not a pin");
  assert.match(routingProblem(routingEvent({ params: { model: "gpt-daybreak-blue-latest", seat: "codex", reviewer_actor: "codex" } }), o), /params.seat/, "the first seat's routing does not authorize a witness build");
});

test("renderEvent: a labelled projection — carries actor, artifacts, change and listed params; lists every omitted field name; never signature material", () => {
  const raw = {
    id: CITED, seq: 5, timestamp: "2026-10-11T00:00:00.000Z", actor: { type: "agent", id: "claude-code", model: "m", model_source: "harness-runtime", on_behalf_of: "o" },
    action: "sent", caused_by: ROUTING, tags: ["sent"], intent: "x".repeat(500), project: "retrace", location: { device: "laptop" }, idempotency_key: "i", received_at: "t", hash: "h", prev_hash: "p", hash_v: 2,
    artifacts: [{ id: "commit:jordandru/retrace@6ac80c98c75b", role: "generated" }, { id: "https://github.com/jordandru/retrace/pull/222", kind: "pull_request", role: "used", label: "L".repeat(200) }],
    change: { after_hash: "a".repeat(64), summary: "exact text", diff: "d".repeat(400) },
    producer_sig: { kid: "k", sig: "s".repeat(80) },
    method: { tool: "retrace_send", automated: true, params: { sealed_by: "pinned:x", producer_sig_verdict: "verified", text_sha256: "t".repeat(64), secret_looking: "nope", target: { agent: "codex" } } },
  };
  const r = renderEvent(raw);
  assert.equal(r.producer_sig, undefined); assert.ok(!JSON.stringify(r).includes("s".repeat(80)), "no signature material");
  assert.equal(r.sealed_by, "pinned:x"); assert.equal(r.method_tool, "retrace_send");
  assert.deepEqual(r.actor, raw.actor, "the whole actor block");
  assert.equal(r.artifacts.length, 2, "every artifact, not only a generated commit"); assert.equal(r.artifacts[0].id, "commit:jordandru/retrace@6ac80c98c75b"); assert.match(r.artifacts[1].label, /…\[200 chars\]$/);
  assert.equal(r.change.after_hash, "a".repeat(64)); assert.equal(r.change.summary, "exact text"); assert.match(r.change.diff, /…\[400 chars\]$/);
  assert.match(r.intent_head, /…\[500 chars\]$/);
  assert.equal(r.params.secret_looking, undefined); assert.equal(r.params.text_sha256, "t".repeat(64)); assert.deepEqual(r.params.target, { agent: "codex" });
  assert.deepEqual(r.omitted, { fields: ["hash", "hash_v", "idempotency_key", "location", "prev_hash", "producer_sig", "project", "received_at"], method: ["automated"], params: ["secret_looking"] }, "M4: every omitted name is listed");
  const bare = renderEvent({ id: "x", method: {} });
  assert.equal(bare.sealed_by, "(absent)"); assert.deepEqual(bare.omitted, { fields: [], method: [], params: [] });
  assert.ok(!PARAM_KEYS_CARRIED.includes("review_scope"), "long prose params are omitted by name, not silently");
});

/** Every key present in `raw` is either rendered or named under `omitted` (the Appendix A guarantee), empty objects and null included (M1 r2, r3). */
function assertAccounted(raw, r) {
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  for (const k of Object.keys(raw)) {
    const carried = k === "method" ? isObj(raw.method) : k === "intent" ? "intent_head" in r : k in r;
    assert.ok(carried !== r.omitted.fields.includes(k), `top-level ${k}: carried ${carried}, omitted ${r.omitted.fields.includes(k)}`);
  }
  if (isObj(raw.method)) {
    if (Object.keys(raw.method).length === 0) assert.deepEqual(r.method, {}, "an empty method object is carried as {}");
    for (const k of Object.keys(raw.method)) {
      const carried = k === "tool" ? "method_tool" in r : k === "params" ? "params" in r : false;
      assert.ok(carried !== r.omitted.method.includes(k), `method.${k}: carried ${carried}`);
    }
    if ("params" in raw.method && !isObj(raw.method.params)) assert.ok(r.omitted.method.includes("params"), "a null or non-object params is named");
  }
  if (isObj(raw.method?.params)) {
    if (Object.keys(raw.method.params).length === 0) assert.deepEqual(r.params, {}, "an empty params object is carried as {}");
    for (const k of Object.keys(raw.method.params)) {
      const carried = k === "sealed_by" || k === "producer_sig_verdict" ? true : Boolean(r.params) && k in r.params;
      assert.ok(carried !== r.omitted.params.includes(k), `params.${k}`);
    }
  }
}

test("renderEvent: empty present values are carried, not dropped, and omission is computed from what was emitted (M2)", () => {
  const raw = { id: CITED, seq: 7, timestamp: "t", action: "other", action_detail: "", tags: [], intent: "", caused_by: "", artifacts: [], change: {},
    method: { tool: "", automated: false, params: { sealed_by: "", producer_sig_verdict: "", pr: 0, round: "", findings: {}, blocking: false, review_scope: "" } }, producer_sig: {}, hash: "" };
  const r = renderEvent(raw);
  assert.equal(r.action_detail, ""); assert.deepEqual(r.tags, []); assert.equal(r.method_tool, ""); assert.equal(r.intent_head, ""); assert.equal(r.caused_by, "");
  assert.deepEqual(r.artifacts, []); assert.deepEqual(r.change, {}); assert.equal(r.sealed_by, ""); assert.equal(r.producer_sig_verdict, "");
  assert.deepEqual(r.params, { pr: 0, round: "", findings: {}, blocking: false }, "falsy but present params are carried");
  assert.deepEqual(r.omitted, { fields: ["hash", "producer_sig"], method: ["automated"], params: ["review_scope"] }, "only what was not emitted is named");
  assertAccounted(raw, r);
  assertAccounted(routingEvent(), renderEvent(routingEvent()));
  const noParams = renderEvent({ id: "x", method: { tool: "routing" } });
  assert.equal(noParams.method_tool, "routing"); assert.equal(noParams.sealed_by, "(absent)"); assert.deepEqual(noParams.omitted, { fields: [], method: [], params: [] });
  const noMethod = renderEvent({ id: "x", method: null, extra: null });
  assert.deepEqual(noMethod.omitted, { fields: ["extra", "method"], method: [], params: [] }, "a method that is not an object is named as omitted");
  assertAccounted({ id: "x", method: null, extra: null }, noMethod);
  // M1 (r3): present empty objects are carried as {}, never dropped with empty omitted lists.
  const emptyMethod = renderEvent({ id: "x", method: {} });
  assert.deepEqual(emptyMethod.method, {}); assert.deepEqual(emptyMethod.omitted, { fields: [], method: [], params: [] });
  assertAccounted({ id: "x", method: {} }, emptyMethod);
  const emptyParams = renderEvent({ id: "x", method: { tool: "t", params: {} } });
  assert.deepEqual(emptyParams.params, {}); assert.equal(emptyParams.method, undefined); assert.deepEqual(emptyParams.omitted, { fields: [], method: [], params: [] });
  assertAccounted({ id: "x", method: { tool: "t", params: {} } }, emptyParams);
  const nullParams = renderEvent({ id: "x", method: { tool: "t", params: null } });
  assert.equal(nullParams.params, undefined); assert.deepEqual(nullParams.omitted, { fields: [], method: ["params"], params: [] }, "null params is named, not dropped");
  assertAccounted({ id: "x", method: { tool: "t", params: null } }, nullParams);
  const arrMethod = renderEvent({ id: "x", method: [] });
  assert.deepEqual(arrMethod.omitted.fields, ["method"], "a non-object method is named");
  const onlyAutomated = renderEvent({ id: "x", method: { automated: true } });
  assert.equal(onlyAutomated.method, undefined); assert.deepEqual(onlyAutomated.omitted, { fields: [], method: ["automated"], params: [] });
  assertAccounted({ id: "x", method: { automated: true } }, onlyAutomated);
});

test("extractRuleItems and citedRuleNumbers over a rules document", () => {
  const md = "# Agent rules\n\nintro\n\n1. **One.** first\n   more\n\n2. **Two.** second\n\n15. **Fifteen.** last item\n   tail\n\nRoles, review order, and budgets: elsewhere.\n";
  const items = extractRuleItems(md, [1, 15, 99]);
  assert.equal(items[1], "1. **One.** first\n   more");
  assert.equal(items[15], "15. **Fifteen.** last item\n   tail");
  assert.equal(items[99], undefined);
  assert.deepEqual(citedRuleNumbers("judge against agent-rules 15 and rule 6; rules 11, 12 and 3; agent-ops 18"), [3, 6, 11, 12, 15], "agent-ops items are not agent-rules");
});

test("gateLines: only the doctor step's verdict lines, timestamps stripped", () => {
  const log = [
    "gate\tRun npm test\t2026-10-11T20:22:28Z ok 76 - doctor: instruct root is required",
    "gate\tRun node packages/mcp-server/dist/doctor.js doctor --gate\t﻿2026-10-11T20:23:33.59Z ##[group]Run node …",
    "gate\tRun node packages/mcp-server/dist/doctor.js doctor --gate\t2026-10-11T20:24:40.27Z READY — 16 passed, 172 warnings, 0 failures",
    "gate\tRun node packages/mcp-server/dist/doctor.js doctor --gate\t2026-10-11T20:24:40.28Z PASS  instruct root — evt_x ← evt_y",
    "gate\tRun node packages/mcp-server/dist/doctor.js doctor --gate\t2026-10-11T20:24:40.29Z FAIL  instruct root — evt_z is not rooted",
    "gate\tRun node packages/mcp-server/dist/doctor.js doctor --gate\t2026-10-11T20:24:40.30Z WARN  export-cache — stale",
  ].join("\n");
  assert.deepEqual(gateLines(log), ["READY — 16 passed, 172 warnings, 0 failures", "PASS  instruct root — evt_x ← evt_y", "FAIL  instruct root — evt_z is not rooted"]);
});

test("trimToBudget: drops optional sections in order and records how to get them; core sections stay", () => {
  const big = "x".repeat(2000);
  const sections = { header: "H", role: "R", rules: "U", body: "B", commits: "C", diff: "D", contract: "K", events: `"intent_head": "${"y".repeat(300)}"`, ci: big, status: big, rulesText: big, interdiff: big, instruction: big };
  const r = trimToBudget({ ...sections }, 4500);
  assert.deepEqual(r.omitted.map((o) => o.section), ["ci", "status", "rulesText"]);
  assert.ok(r.omitted.every((o) => o.how.length > 10 && o.bytes === 2000));
  assert.ok(r.fits, `bytes ${r.bytes}`);
  assert.equal(r.sections.diff, "D"); assert.equal(r.sections.interdiff, big);
  const tiny = trimToBudget({ ...sections }, 100);
  assert.ok(tiny.omitted.some((o) => o.section === "events.intent_head"));
  assert.equal(tiny.fits, false, "core sections are never dropped; over budget is reported, not hidden");
});

test("reviewSurface: the routed class and the files under review, from agent-rules 12", () => {
  assert.equal(reviewSurface("c", ["a.mjs", "b.py"]), "class (c): code or scripts under the code order of docs/team-roles.md (agent-rules 12); files under review: a.mjs, b.py");
  assert.match(reviewSurface("a", ["1", "2", "3", "4", "5", "6", "7", "8"]), /class \(a\): a governing change under the design gate .*; files under review: 1, 2, 3, 4, 5, 6 and 2 more$/);
});

function fakeIo(over = {}) {
  const calls = [];
  const io = {
    git: (args) => {
      calls.push(["git", ...args]);
      if (args[0] === "merge-base") return BASE + "\n";
      if (args[0] === "log") return `${HEAD}\nRetrace-Actor: claude-code\nRetrace-Caused-By: ${CITED}\n----MSG----\nfeat: thing\n\nbody mentions ${CITED}\n====END====\n`;
      if (args[0] === "diff" && args[1] === "-U3") return `diff --git a/docs/x.md b/docs/x.md\n+added, sealed as ${DIFF_ONLY}\n`;
      if (args[0] === "diff" && args[1] === "-U2") return `diff --git a/docs/x.md b/docs/x.md\n+inter ${INTERDIFF_ONLY}\n`;
      if (args[0] === "show") return "1. **One.** first\n\n15. **Fifteen.** rule fifteen text\n\nRoles, review order, and budgets: x\n";
      throw new Error("unexpected git " + args.join(" "));
    },
    gh: (args) => {
      calls.push(["gh", ...args]);
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ title: "feat: thing (class a)", body: `## What\n\nsee ${ROUTING} and ${CITED}`, headRefOid: over.ghHead ?? HEAD, baseRefName: "main", files: [{ path: "docs/x.md" }], author: { login: "jordandru" } });
      if (args[0] === "run" && args[1] === "list") return JSON.stringify([{ databaseId: 1, conclusion: "success", status: "completed", createdAt: "2026-10-11T21:52:23Z" }, { databaseId: 2, conclusion: null, status: "in_progress", createdAt: "2026-10-11T21:53:00Z" }]);
      if (args[0] === "run" && args[1] === "view") return "gate\tRun node packages/mcp-server/dist/doctor.js doctor --gate\t2026-10-11T20:24:40Z READY — 16 passed, 0 failures\n";
      throw new Error("unexpected gh " + args.join(" "));
    },
    fetchJson: async (path) => {
      calls.push(["fetch", path]);
      if (path.startsWith("/projects/retrace/events")) return { events: [{ id: "evt_" + "d".repeat(32), action: "committed", actor: { type: "agent", id: "claude-code", model: "claude-mythos-5-1" }, artifacts: [{ id: `commit:jordandru/retrace@${HEAD.slice(0, 12)}`, role: "generated" }] }] };
      if (path === "/projects/retrace/status") return { generated_at: "t", events: { total: 1 }, capture: { commits: 2, unlinked_commits: 3 }, causality: { coverage_pct: 97.2 } };
      const id = path.split("/").pop();
      if (id === ROUTING) { if (over.routing === "unreadable") throw new Error("GET → 503"); return over.routing ?? routingEvent(); }
      if (id === "evt_" + "c".repeat(32)) throw new Error("GET → 404");
      return { id, seq: 1, timestamp: "t", actor: { type: "agent", id: "claude-code" }, action: "edited", method: { params: { sealed_by: "pinned:claude-code", producer_sig_verdict: "verified", head_sha: HEAD } }, producer_sig: { kid: "k", sig: "s" }, intent: "an intent" };
    },
    readFile: (p) => (p === "rules.md" ? "1. **Claims vs evidence (agent-rules 15).** Every id is in Appendix A.\n2. **Form.** One file." : p === "ctx.md" ? "This round fixes M1." : (() => { throw new Error("no file " + p); })()),
    now: () => "2026-10-11T22:00:00Z",
  };
  return { io, calls };
}

test("build: assembles every section, reads every cited event once (diff and interdiff included), refuses a head that is not the PR's head", async () => {
  const o = parseArgs([...argvOk, "--prev-head", BASE, "--context-file", "ctx.md", "--ci", "--status", "--events", "evt_" + "c".repeat(32), "--instruction", CITED]);
  const { io, calls } = fakeIo();
  const r = await build(o, io);
  assert.ok(r.fits, `bytes ${r.bytes}`);
  assert.equal(r.packetName, "nooa-pr222-packet-r1.md"); assert.equal(r.launcherName, "launch-pr222-r1.sh");
  for (const h of ["# Review packet — Retrace PR 222", "## Your role", "## Rules to judge against", "## This round, as the coordinator describes it", "## PR body (verbatim", "## Commit messages (verbatim", "## Diff vs base", "## Interdiff vs previous head", "## Output contract", "# Appendix A — selected fields", "# Appendix B", "# Appendix C", "# Appendix D", "# Appendix E", "FINDINGS: high=<n>", "BLOCKING: <yes|no>", "no REASON line and no override", "read raw by the builder and authenticated", "starting at column zero", "is sealed as the action `rejected`; with\nonly Lows it is allowed"]) assert.ok(r.packet.includes(h), h);
  assert.ok(!r.packet.includes("REASON: <why"), "H1: the contract no longer offers an override");
  assert.ok(!r.packet.includes("needs at least one Medium"), "M1 (r2): one statement, the validator's: a Low-only `needs changes` is allowed");
  assert.ok(r.launcher.includes("the wrapper takes its values as given and re-verifies none of them"), "H1 (r2): the launcher says what it is");
  assert.ok(r.packet.includes("Author per the head's hook seal: agent/claude-code (claude-mythos-5-1)"));
  assert.ok(r.packet.includes("15. **Fifteen.** rule fifteen text"), "cited rule text in Appendix C");
  assert.ok(r.packet.includes("run 1 — conclusion success") && r.packet.includes("run 2 — in_progress at build time"));
  assert.ok(!r.packet.includes('"sig"'), "no signature material");
  assert.ok(r.packet.includes('"omitted": {') && r.packet.includes('"producer_sig"'), "M4: omitted field names are listed per event");
  assert.deepEqual(r.events, [ROUTING, CITED, DIFF_ONLY, INTERDIFF_ONLY, "evt_" + "c".repeat(32)], "M1: ids that appear only in the diff or interdiff are read too");
  assert.deepEqual(r.unreadable.map((u) => u.id), ["evt_" + "c".repeat(32)]);
  assert.ok(r.packet.includes("Unreadable at build time"));
  const fetches = calls.filter((c) => c[0] === "fetch" && c[1].startsWith("/events/")).map((c) => c[1]);
  assert.equal(new Set(fetches).size, fetches.length, "each event read once, the routing event included");
  assert.equal(calls[0][0], "fetch", "the routing event is read before anything else"); assert.equal(calls[0][1], `/events/${ROUTING}`);
  for (const line of [`export NOOA_REVIEWED_HEAD=${HEAD}`, `export NOOA_ROUTING_EVENT=${ROUTING}`, "NOOA_REVIEW_FILE=review/nooa-pr222-packet-r1.md", "export NOOA_FILES='docs/x.md'", "NOOA_TAGS='pr-222,class-a,r1'", "export NOOA_CLASS=a", `export NOOA_MODEL='${NOOA_MODEL}'`, "export NOOA_SURFACE='class (a): a governing change under the design gate (agent-rules 12); files under review: docs/x.md'"]) assert.ok(r.launcher.includes(line), line);
  const scoped = await build(parseArgs([...argvOk, "--files", "docs/x.md"]), fakeIo().io);
  assert.ok(scoped.packet.includes("1 file changed — `docs/x.md`"), "all files carried: no omission note");
  await assert.rejects(build(parseArgs([...argvOk, "--files", "docs/other.md"]), fakeIo().io), /does not change/);
  const mismatch = fakeIo({ ghHead: BASE });
  await assert.rejects(build(parseArgs(argvOk), mismatch.io), /head on GitHub is .* not --head/);
});

test("build: refuses before reading anything else when the routing event does not authorize this build (H3)", async () => {
  // PR 225's routing event (pr: 225) offered for a PR 223 build: nothing is read from git or gh, nothing is built.
  const route225 = routingEvent({ params: { pr: 225 } });
  const wrongPr = fakeIo({ routing: route225 });
  await assert.rejects(build(parseArgs(["--pr", "223", ...argvOk.slice(2)]), wrongPr.io), /does not authorize this build: params.pr is 225, not 223/);
  assert.deepEqual(wrongPr.calls, [["fetch", `/events/${ROUTING}`]], "only the routing read happened");
  const otherSeat = fakeIo({ routing: routingEvent({ params: { seat: "codex", reviewer_actor: "codex", model: "gpt-daybreak-blue-latest", reasoning_effort: "max" } }) });
  await assert.rejects(build(parseArgs(argvOk), otherSeat.io), /does not authorize this build/);
  const unsealed = fakeIo({ routing: routingEvent({ params: { producer_sig_verdict: "unverified" } }) });
  await assert.rejects(build(parseArgs(argvOk), unsealed.io), /producer_sig_verdict is "unverified"/);
  const wrongHead = fakeIo({ routing: routingEvent({ params: { head_sha: BASE } }) });
  await assert.rejects(build(parseArgs(argvOk), wrongHead.io), /params.head_sha is/);
  const unreadable = fakeIo({ routing: "unreadable" });
  await assert.rejects(build(parseArgs(argvOk), unreadable.io), /could not be read raw .*503.*nothing built/);
  assert.deepEqual(unreadable.calls, [["fetch", `/events/${ROUTING}`]]);
});

test("build: a tight budget drops the appendices in order and says so in the packet", async () => {
  const full = await build(parseArgs([...argvOk, "--ci", "--status"]), fakeIo().io);
  assert.equal(full.omitted.length, 0);
  const budget = full.bytes - 50;
  const r = await build(parseArgs([...argvOk, "--ci", "--status", "--max-bytes", String(budget)]), fakeIo().io);
  assert.ok(r.omitted.length >= 1, JSON.stringify(r.omitted));
  assert.equal(r.omitted[0].section, "ci");
  assert.ok(r.fits, `bytes ${r.bytes} budget ${budget}`);
  assert.ok(r.packet.includes(`# Omitted for size (packet budget ${budget} bytes)`));
  assert.ok(r.packet.includes("gh run view <id> --log"));
});

test("wrapper v2.4 self-test runs (python3 present) or is skipped", (t) => {
  const py = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (py.status !== 0) { t.skip("python3 not available"); return; }
  const out = execFileSync("python3", ["-I", join(here, "nooa-review-generic.py"), "--selftest"], { encoding: "utf8" });
  assert.match(out, /selftest: 48 cases OK/);
  const src = execFileSync("cat", [join(here, "nooa-review-generic.py")], { encoding: "utf8" });
  assert.ok(!src.includes("routing_binding") && src.includes('"launcher_trust": LAUNCHER_TRUST'), "H1 (r2): the seal names the launcher values as given");
  assert.ok(!/outcome event records/.test(src) && /coordinator's act outside this code/.test(src), "H1 (r3): no claim that the launch script records anything");
  const readme = execFileSync("cat", [join(here, "README.md")], { encoding: "utf8" });
  assert.ok(!/in its outcome event/.test(readme) && !/whose `sent` event/.test(readme) && /writes nothing to the ledger\*\*/.test(readme), "H1 (r3): the README says what push-and-launch.sh does");
  assert.ok(!/needs changes" needs\s+at least one/.test(src), "M1 (r2): the prompt no longer directs Low-only results to approval");
});

test("wrapper v2.4 refuses to start on a model that is not the pinned witness model or on a malformed launcher value (M2, H3)", (t) => {
  const py = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (py.status !== 0) { t.skip("python3 not available"); return; }
  const env = { PATH: process.env.PATH, HOME: "/nonexistent-home", NOOA_PR: "222", NOOA_PR_TITLE: "t", NOOA_JUDGEMENT: "j", NOOA_TAGS: "pr-222", NOOA_ROUTING_EVENT: ROUTING, NOOA_REVIEWED_HEAD: HEAD, NOOA_FILES: "docs/x.md", NOOA_ROUND: "r1", NOOA_RUBRIC: "high", NOOA_SCOPE: "s", NOOA_CLASS: "a", NOOA_SURFACE: "class (a)", NOOA_MODEL: NOOA_MODEL };
  const run = (over) => spawnSync("python3", ["-I", join(here, "nooa-review-generic.py")], { encoding: "utf8", env: { ...env, ...over } });
  const prefixOnly = run({ NOOA_MODEL: "nvidia_nim/not-the-routed-model" });
  assert.notEqual(prefixOnly.status, 0); assert.match(prefixOnly.stderr, /REFUSED: NOOA_MODEL must equal/);
  const shortHead = run({ NOOA_REVIEWED_HEAD: HEAD.slice(0, 12) });
  assert.notEqual(shortHead.status, 0); assert.match(shortHead.stderr, /REFUSED: NOOA_REVIEWED_HEAD=/);
  const noClass = run({ NOOA_CLASS: "" });
  assert.notEqual(noClass.status, 0); assert.match(noClass.stderr, /REFUSED: NOOA_CLASS is not set/);
  const badClass = run({ NOOA_CLASS: "design" });
  assert.notEqual(badClass.status, 0); assert.match(badClass.stderr, /REFUSED: NOOA_CLASS='design' is not one of/);
  const allGood = run({});
  assert.notEqual(allGood.status, 0); assert.ok(!/REFUSED/.test(allGood.stderr), `with every value well-formed the wrapper gets past its own checks (then fails here for want of the host runner): ${allGood.stderr.slice(0, 200)}`);
});
