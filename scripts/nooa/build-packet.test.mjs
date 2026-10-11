import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseArgs, collectEventIds, renderEvent, extractRuleItems, citedRuleNumbers, gateLines, trimToBudget, build, DEFAULT_MAX_BYTES,
} from "./build-packet.mjs";

const HEAD = "6ac80c98c75b01118ca9aaabcf44b1957e1dc1ca";
const BASE = "f6e9ec225f5ee3a5b1f4babef6ed4f5bce74ced7";
const ROUTING = "evt_" + "a".repeat(32);
const CITED = "evt_" + "b".repeat(32);
const here = dirname(fileURLToPath(import.meta.url));

const argvOk = ["--pr", "222", "--head", HEAD, "--routing", ROUTING, "--round", "r1", "--rubric", "high", "--class", "a", "--rules-file", "rules.md"];

test("parseArgs: required flags and their shapes", () => {
  const o = parseArgs(argvOk);
  assert.equal(o.pr, 222); assert.equal(o.maxBytes, DEFAULT_MAX_BYTES); assert.equal(o.ci, false);
  assert.throws(() => parseArgs(argvOk.slice(2)), /--pr is required/);
  assert.throws(() => parseArgs([...argvOk.slice(0, 3), "6ac80c9", ...argvOk.slice(4)]), /--head/);
  assert.throws(() => parseArgs([...argvOk, "--routing", "evt_short"]), /--routing/);
  assert.throws(() => parseArgs([...argvOk, "--class", "x"]), /--class/);
  assert.equal(parseArgs([...argvOk, "--ci", "--status", "--max-bytes", "1000"]).maxBytes, 1000);
});

test("collectEventIds: full ids only, first occurrence order, no duplicates", () => {
  const ids = collectEventIds([`see ${CITED} and ${ROUTING}`, `again ${CITED} and evt_abc (short) and evt_${"c".repeat(32)}`, undefined]);
  assert.deepEqual(ids, [CITED, ROUTING, "evt_" + "c".repeat(32)]);
});

test("renderEvent: keeps what a witness needs, drops signature material, clips long text", () => {
  const raw = {
    id: CITED, seq: 5, timestamp: "2026-10-11T00:00:00.000Z", actor: { type: "agent", id: "claude-code", model: "m", model_source: "harness-runtime" },
    action: "sent", caused_by: ROUTING, tags: ["sent"], intent: "x".repeat(500),
    artifacts: [{ id: "commit:jordandru/retrace@6ac80c98c75b", role: "generated" }],
    producer_sig: { kid: "k", sig: "s".repeat(80) },
    method: { tool: "retrace_send", params: { sealed_by: "pinned:x", producer_sig_verdict: "verified", text_sha256: "t".repeat(64), secret_looking: "nope", target: { agent: "codex" } } },
  };
  const r = renderEvent(raw);
  assert.equal(r.producer_sig, undefined);
  assert.equal(r.sealed_by, "pinned:x"); assert.equal(r.commit, "commit:jordandru/retrace@6ac80c98c75b");
  assert.match(r.intent_head, /…\[500 chars\]$/);
  assert.equal(r.params.secret_looking, undefined); assert.equal(r.params.text_sha256, "t".repeat(64)); assert.deepEqual(r.params.target, { agent: "codex" });
  assert.equal(renderEvent({ id: "x", method: {} }).sealed_by, "(absent)");
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

function fakeIo(over = {}) {
  const calls = [];
  const io = {
    git: (args) => {
      calls.push(["git", ...args]);
      if (args[0] === "merge-base") return BASE + "\n";
      if (args[0] === "log") return `${HEAD}\nRetrace-Actor: claude-code\nRetrace-Caused-By: ${CITED}\n----MSG----\nfeat: thing\n\nbody mentions ${CITED}\n====END====\n`;
      if (args[0] === "diff" && args[1] === "-U3") return "diff --git a/docs/x.md b/docs/x.md\n+added\n";
      if (args[0] === "diff" && args[1] === "-U2") return "diff --git a/docs/x.md b/docs/x.md\n+inter\n";
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
      if (id === "evt_" + "c".repeat(32)) throw new Error("GET → 404");
      return { id, seq: 1, timestamp: "t", actor: { type: "agent", id: "claude-code" }, action: id === ROUTING ? "other" : "edited", method: { params: { sealed_by: "pinned:claude-code", producer_sig_verdict: "verified", head_sha: HEAD } }, producer_sig: { kid: "k", sig: "s" }, intent: "an intent" };
    },
    readFile: (p) => (p === "rules.md" ? "1. **Claims vs evidence (agent-rules 15).** Every id is in Appendix A.\n2. **Form.** One file." : p === "ctx.md" ? "This round fixes M1." : (() => { throw new Error("no file " + p); })()),
    now: () => "2026-10-11T22:00:00Z",
  };
  return { io, calls };
}

test("build: assembles every section, reads every cited event once, refuses a head that is not the PR's head", async () => {
  const o = parseArgs([...argvOk, "--prev-head", BASE, "--context-file", "ctx.md", "--ci", "--status", "--events", "evt_" + "c".repeat(32), "--instruction", CITED]);
  const { io, calls } = fakeIo();
  const r = await build(o, io);
  assert.ok(r.fits, `bytes ${r.bytes}`);
  assert.equal(r.packetName, "nooa-pr222-packet-r1.md"); assert.equal(r.launcherName, "launch-pr222-r1.sh");
  for (const h of ["# Review packet — Retrace PR 222", "## Your role", "## Rules to judge against", "## This round, as the coordinator describes it", "## PR body (verbatim", "## Commit messages (verbatim", "## Diff vs base", "## Interdiff vs previous head", "## Output contract", "# Appendix A", "# Appendix B", "# Appendix C", "# Appendix D", "# Appendix E", "FINDINGS: high=<n>", "BLOCKING: <yes|no>"]) assert.ok(r.packet.includes(h), h);
  assert.ok(r.packet.includes("Author per the head's hook seal: agent/claude-code (claude-mythos-5-1)"));
  assert.ok(r.packet.includes("15. **Fifteen.** rule fifteen text"), "cited rule text in Appendix C");
  assert.ok(r.packet.includes("run 1 — conclusion success") && r.packet.includes("run 2 — in_progress at build time"));
  assert.ok(!r.packet.includes('"sig"'), "no signature material");
  assert.deepEqual(r.events, [ROUTING, CITED, "evt_" + "c".repeat(32)]);
  assert.deepEqual(r.unreadable.map((u) => u.id), ["evt_" + "c".repeat(32)]);
  assert.ok(r.packet.includes("Unreadable at build time"));
  const fetches = calls.filter((c) => c[0] === "fetch" && c[1].startsWith("/events/")).map((c) => c[1]);
  assert.equal(new Set(fetches).size, fetches.length, "each event read once");
  assert.ok(r.launcher.includes(`export NOOA_REVIEWED_HEAD=${HEAD}`) && r.launcher.includes(`export NOOA_ROUTING_EVENT=${ROUTING}`) && r.launcher.includes("NOOA_REVIEW_FILE=review/nooa-pr222-packet-r1.md") && r.launcher.includes("export NOOA_FILES='docs/x.md'") && r.launcher.includes("NOOA_TAGS='pr-222,class-a,r1'"));
  const scoped = await build(parseArgs([...argvOk, "--files", "docs/x.md"]), fakeIo().io);
  assert.ok(scoped.packet.includes("1 file changed — `docs/x.md`"), "all files carried: no omission note");
  await assert.rejects(build(parseArgs([...argvOk, "--files", "docs/other.md"]), fakeIo().io), /does not change/);
  const mismatch = fakeIo({ ghHead: BASE });
  await assert.rejects(build(parseArgs(argvOk), mismatch.io), /head on GitHub is .* not --head/);
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

test("wrapper v2 self-test runs (python3 present) or is skipped", (t) => {
  const py = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (py.status !== 0) { t.skip("python3 not available"); return; }
  const out = execFileSync("python3", ["-I", join(here, "nooa-review-generic.py"), "--selftest"], { encoding: "utf8" });
  assert.match(out, /selftest: 11 cases OK/);
});
