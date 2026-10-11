import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Event } from "./schema.js";
import { reconcile as reconcileCore, artifactPath, renderReconcileReport, CommitFacts } from "./reconcile.js";
import { effectiveBoundary } from "./capture.js";
/** every test names this repo's hook credential explicitly, as .retrace.json would */
const HOOK = "assert:retrace-git";
const reconcile: typeof reconcileCore = (c, e, o) => reconcileCore(c, e, { hookSealedBy: [HOOK], ...o });

const REPO = "jordandru/retrace";
const sha = (c: string) => c.repeat(40);
const cid = (c: string) => `commit:${REPO}@${sha(c).slice(0, 12)}`;
let n = 0;
function ev(seq: number, actor: { type: "agent" | "human" | "system"; id: string }, action: Event["action"], ids: string[], extra: Partial<Event> = {}): Event {
  return { id: `evt_${seq}_${n++}`, seq, project: "retrace", actor, action, artifacts: ids.map((id) => ({ id, ...(id.startsWith("commit:") ? { kind: "commit" } : {}) })), timestamp: "2026-09-01T00:00:00Z", received_at: "2026-09-01T00:00:00Z", prev_hash: "", hash: `h${seq}`, ...extra };
}
const codex = { type: "agent" as const, id: "codex" }, claude = { type: "agent" as const, id: "claude-code" }, grok = { type: "agent" as const, id: "grok" };
const jordan = { type: "human" as const, id: "jordan@example.com" };
const commit = (c: string, files: (string | { path: string; status: "R"; from: string })[], parents = ["p"]): CommitFacts => ({
  sha: sha(c), parents, files: files.map((f) => typeof f === "string" ? { path: f, status: "M" as const } : f), author: { email: "who@example.com" }, time: "2026-09-01T00:00:00Z",
});
/** stamp: the server's sealed_by; "" = unstamped (an explicit `undefined` would select the default) */
const sealed = (seq: number, c: string, actor: any, files: string[], action: Event["action"] = "committed", stamp: string = HOOK) =>
  ev(seq, actor, action, [cid(c), ...files.map((f) => `repo:${REPO}#${f}`)], { method: { tool: "git", automated: true, params: stamp ? { sealed_by: stamp } : {} }, idempotency_key: `git:${sha(c)}` });
const RESTRICTED = "pinned:claude-code-cloud";
const restrictedPolicy = [{ stamp: RESTRICTED, actor: { type: "agent", id: "claude-code-cloud" } }];
const cloud = { type: "agent" as const, id: "claude-code-cloud" };
const pushed = (seq: number, c: string, actor: any, files: string[]) =>
  ev(seq, actor, "committed", [cid(c), ...files.map((f) => `repo:${REPO}#${f}`)], {
    tags: ["github", "push"],
    method: { tool: "git", params: { producer: "github-push", sealed_by: "webhook:github", sha: sha(c) } },
    idempotency_key: `gh:push:${REPO}:${sha(c)}`,
  });
const restricted = (seq: number, c: string, actor: any, files: string[], extra: Partial<Event> = {}) =>
  ev(seq, actor, "committed", [cid(c), ...files.map((f) => `repo:${REPO}#${f}`)], {
    method: { tool: "git", params: { sealed_by: RESTRICTED, sha: sha(c) } },
    idempotency_key: `git:${sha(c)}`,
    ...extra,
  });

test("T3 reconcile consumes every restricted eligibility outcome and reports dropped paths", () => {
  const webhook = pushed(20, "c", cloud, ["x.ts", "y.ts"]);
  const options = { repoName: REPO, restrictedStamps: restrictedPolicy };
  const goodEvent = restricted(10, "c", cloud, ["x.ts", "z.ts"]);
  const good = reconcileCore([commit("c", ["x.ts", "y.ts"])], [goodEvent, webhook], options);
  assert.deepEqual(good.commits[0].coverage["x.ts"].window, { after: -1, before: 10 });
  assert.deepEqual(good.commits[0].coverage["y.ts"].window, { after: -1, before: 20 });
  assert.equal("z.ts" in good.commits[0].coverage, false);
  assert.deepEqual(good.restricted_hook_stamps, [{
    event_id: goodEvent.id, seq: 10, eligible: true,
    paths: [`repo:${REPO}#x.ts`], dropped: [`repo:${REPO}#z.ts`],
  }]);

  const twoCommits = restricted(10, "c", cloud, ["x.ts"]);
  twoCommits.artifacts.push({ id: cid("d") });
  const cases: { event: Event; webhooks: Event[]; reason: string }[] = [
    { event: { ...restricted(10, "c", cloud, ["x.ts"]), idempotency_key: undefined }, webhooks: [webhook], reason: "no_key" },
    { event: { ...restricted(10, "c", cloud, ["x.ts"]), idempotency_key: `git:${sha("d")}` }, webhooks: [webhook], reason: "key_mismatch" },
    { event: twoCommits, webhooks: [webhook], reason: "commit_mismatch" },
    { event: restricted(10, "c", cloud, ["x.ts"]), webhooks: [], reason: "no_webhook" },
    { event: restricted(10, "c", cloud, ["x.ts"]), webhooks: [pushed(20, "c", codex, ["x.ts"])], reason: "actor_mismatch" },
  ];
  for (const { event, webhooks, reason } of cases) {
    const report = reconcileCore([commit("c", ["x.ts"])], [event, ...webhooks], options);
    assert.deepEqual(report.restricted_hook_stamps, [{ event_id: event.id, seq: 10, eligible: false, reason }], reason);
    if (webhooks.length) assert.deepEqual(report.commits[0].coverage["x.ts"].window, { after: -1, before: 20 }, reason);
  }
});

test("restricted witnesses require an exact, unambiguous full webhook identity", () => {
  const full = "abcdef123456" + "a".repeat(28);
  const other = "abcdef123456" + "b".repeat(28);
  const ref = `commit:${REPO}@${full.slice(0, 12)}`;
  const candidate = ev(10, cloud, "committed", [ref, `repo:${REPO}#x.ts`], {
    method: { tool: "git", params: { sealed_by: RESTRICTED, sha: other } },
    idempotency_key: `git:${other}`,
  });
  const webhook = ev(20, cloud, "committed", [ref, `repo:${REPO}#x.ts`], {
    tags: ["github", "push"],
    method: { tool: "git", params: { sealed_by: "webhook:github", sha: full } },
    idempotency_key: `gh:push:${REPO}:${full}`,
  });
  const facts: CommitFacts[] = [{ ...commit("a", ["x.ts"]), sha: full }];

  const mismatch = reconcileCore(facts, [candidate, webhook], { repoName: REPO, restrictedStamps: restrictedPolicy });
  assert.deepEqual(mismatch.restricted_hook_stamps, [{ event_id: candidate.id, seq: 10, eligible: false, reason: "no_webhook" }]);
  assert.deepEqual(mismatch.commits[0].coverage["x.ts"].window, { after: -1, before: 20 });

  const exact = { ...candidate, idempotency_key: `git:${full}`, method: { tool: "git", params: { sealed_by: RESTRICTED, sha: full } } };
  const collidingWebhook = ev(21, cloud, "committed", [`commit:${REPO}@${other}`, `repo:${REPO}#x.ts`], {
    tags: ["github", "push"],
    method: { tool: "git", params: { sealed_by: "webhook:github", sha: other } },
    idempotency_key: `gh:push:${REPO}:${other}`,
  });
  const ambiguous = reconcileCore(facts, [exact, webhook, collidingWebhook], { repoName: REPO, restrictedStamps: restrictedPolicy });
  assert.deepEqual(ambiguous.restricted_hook_stamps, [{ event_id: candidate.id, seq: 10, eligible: false, reason: "ambiguous_commit" }]);
  assert.deepEqual(ambiguous.commits[0].coverage["x.ts"].window, { after: -1, before: 20 });
});

test("restricted capture rejects non-commit and non-git shapes and diagnoses both", () => {
  const webhook = pushed(20, "c", cloud, ["x.ts"]);
  const wrongAction = { ...restricted(10, "c", cloud, ["x.ts"]), action: "edited" as const };
  const wrongTool = { ...restricted(11, "c", cloud, ["x.ts"]), method: { tool: "mcp", params: { sealed_by: RESTRICTED, sha: sha("c") } } };
  const report = reconcileCore([commit("c", ["x.ts"])], [wrongAction, wrongTool, webhook], {
    repoName: REPO,
    restrictedStamps: restrictedPolicy,
  });
  assert.deepEqual(report.restricted_hook_stamps, [
    { event_id: wrongAction.id, seq: 10, eligible: false, reason: "wrong_action" },
    { event_id: wrongTool.id, seq: 11, eligible: false, reason: "wrong_tool" },
  ]);
  assert.deepEqual(report.commits[0].coverage["x.ts"].window, { after: -1, before: 20 });
});

test("T4 reconcile keeps Codex's poisoned B boundary out for no-key and keyed actor-mismatch variants", () => {
  const run = (candidate: Event, reason: "no_key" | "actor_mismatch") => {
    const events = [
      ev(5, codex, "edited", [`repo:${REPO}#x.ts`]),
      sealed(10, "b", codex, ["y.ts"]),
      pushed(11, "b", codex, ["y.ts"]),
      candidate,
      sealed(20, "a", claude, ["x.ts"]),
      pushed(21, "a", claude, ["x.ts"]),
    ];
    const report = reconcileCore([commit("b", ["y.ts"]), commit("a", ["x.ts"])], events, {
      repoName: REPO, hookSealedBy: [HOOK], restrictedStamps: restrictedPolicy,
    });
    const target = report.commits.find((item) => item.sha === sha("a"))!;
    assert.deepEqual(target.coverage["x.ts"].window, { after: -1, before: 20 }, reason);
    assert.ok(target.findings.some((finding) => finding.kind === "misattributed" && finding.level === "fail"), reason);
    assert.equal(report.ok, false, reason);
    assert.deepEqual(report.restricted_hook_stamps, [{ event_id: candidate.id, seq: 12, eligible: false, reason }]);
  };

  run({ ...restricted(12, "b", cloud, ["x.ts"]), idempotency_key: undefined }, "no_key");
  run(restricted(12, "b", cloud, ["x.ts"]), "actor_mismatch");
});

test("T7 a restricted seal without a webhook remains a claim", () => {
  const noWebhook = reconcileCore([commit("c", ["x.ts"])], [restricted(10, "c", cloud, ["x.ts"])], { repoName: REPO, restrictedStamps: restrictedPolicy });
  assert.equal(noWebhook.commits[0].sealed, undefined);
  assert.match(noWebhook.commits[0].findings[0].detail, /restricted witness ineligible: no_webhook/);
});

test("T5 restricted paths lower only their own boundary and dropped paths never enter the window", () => {
  const events = [
    ev(5, codex, "edited", [`repo:${REPO}#x.ts`]),
    restricted(10, "c", cloud, ["x.ts", "z.ts"]),
    ev(15, codex, "edited", [`repo:${REPO}#y.ts`]),
    pushed(20, "c", cloud, ["x.ts", "y.ts"]),
  ];
  const report = reconcileCore([commit("c", ["x.ts", "y.ts"])], events, { repoName: REPO, restrictedStamps: restrictedPolicy });
  assert.deepEqual(report.commits[0].coverage["x.ts"].window, { after: -1, before: 10 });
  assert.deepEqual(report.commits[0].coverage["y.ts"].window, { after: -1, before: 20 });
  assert.equal("z.ts" in report.commits[0].coverage, false);
  assert.equal(report.commits[0].sealed?.seq, 20, "the webhook remains the genuine coverage witness");
  assert.deepEqual(report.restricted_hook_stamps, [{
    event_id: events[1].id, seq: 10, eligible: true,
    paths: [`repo:${REPO}#x.ts`], dropped: [`repo:${REPO}#z.ts`],
  }]);
});

test("T12 a stamp in both general and restricted lists is a configuration error", () => {
  assert.throws(
    () => reconcileCore([], [], { repoName: REPO, hookSealedBy: [RESTRICTED], restrictedStamps: restrictedPolicy }),
    /context_conflict: stamp is both general and restricted/,
  );
});

test("T14 restricted lower bounds survive a later webhook and keep intervening edits visible", () => {
  const restrictedEvent = restricted(10, "c", cloud, ["x.ts"]);
  const events = [
    restrictedEvent,
    ev(15, codex, "edited", [`repo:${REPO}#x.ts`]),
    pushed(20, "c", cloud, ["x.ts", "w.ts"]),
    ev(22, codex, "edited", [`repo:${REPO}#w.ts`]),
    sealed(25, "a", cloud, ["x.ts", "w.ts"]),
    pushed(26, "a", cloud, ["x.ts", "w.ts"]),
  ];
  const report = reconcileCore([commit("a", ["x.ts", "w.ts"])], events, { repoName: REPO, hookSealedBy: [HOOK], restrictedStamps: restrictedPolicy });
  assert.deepEqual(report.commits[0].coverage["x.ts"].window, { after: 10, before: 25 });
  assert.deepEqual(report.commits[0].coverage["w.ts"].window, { after: 20, before: 25 });
  assert.deepEqual(report.commits[0].findings.map((finding) => `${finding.kind}:${finding.level}`), ["misattributed:fail"]);

  const withoutRestricted = events.filter((event) => event !== restrictedEvent);
  const baseline = reconcileCore([commit("a", ["x.ts", "w.ts"])], withoutRestricted, { repoName: REPO, hookSealedBy: [HOOK] });
  const configuredButAbsent = reconcileCore([commit("a", ["x.ts", "w.ts"])], withoutRestricted, {
    repoName: REPO, hookSealedBy: [HOOK], restrictedStamps: restrictedPolicy,
  });
  assert.deepEqual(configuredButAbsent, baseline, "no restricted witness preserves the existing report");
  assert.deepEqual(baseline.commits[0].coverage["x.ts"].window, { after: 20, before: 25 });
  assert.ok(baseline.commits[0].findings.some((finding) => finding.kind === "misattributed" && finding.level === "warn"));
});

test("T15 restricted upper bounds are per path, including a rename source", () => {
  const events = [
    ev(5, codex, "edited", [`repo:${REPO}#x.ts`]),
    restricted(10, "c", cloud, ["x.ts"]),
    ev(15, codex, "edited", [`repo:${REPO}#y.ts`, `repo:${REPO}#old.ts`]),
    pushed(20, "c", cloud, ["x.ts", "y.ts", "old.ts", "new.ts"]),
  ];
  const facts = [commit("c", ["x.ts", "y.ts", { path: "new.ts", status: "R", from: "old.ts" }])];
  const report = reconcileCore(facts, events, { repoName: REPO, restrictedStamps: restrictedPolicy });
  assert.deepEqual(report.commits[0].coverage["x.ts"].window, { after: -1, before: 10 });
  assert.deepEqual(report.commits[0].coverage["y.ts"].window, { after: -1, before: 20 });
  assert.deepEqual(report.commits[0].coverage["new.ts"].window, { after: -1, before: 20 });
  assert.equal(report.ok, false);
  assert.ok(report.commits[0].findings.some((finding) => finding.kind === "misattributed" && finding.level === "fail"));
});

test("T17 no restricted witness matches the 28c7e854 genuine-only golden report byte for byte", () => {
  assert.equal(effectiveBoundary({ seq: 7, paths: new Set(["x.ts"]) }, "x.ts"), 7);
  assert.equal(effectiveBoundary({ seq: 7, paths: new Set(["x.ts"]) }, "y.ts"), undefined);
  const legacySha = "c".repeat(40);
  const aeabSha = "aeab15b93887" + "a".repeat(28);
  const ffSha = "ff9e29712b2d" + "b".repeat(28);
  const ref = (fullSha: string) => `commit:${REPO}@${fullSha.slice(0,12)}`;
  const fixed = (seq: number, action: Event["action"], ids: string[], extra: Partial<Event> = {}) =>
    ev(seq,codex,action,ids,{id:`evt_${String(seq).padStart(32,"0")}`,...extra});
  const edit = (seq: number, path: string) => fixed(seq,"edited",[`repo:${REPO}#${path}`]);
  const legacy = (seq: number, fullSha: string, path: string) => fixed(seq,"committed",[ref(fullSha),`repo:${REPO}#${path}`],{
    method:{tool:"git",params:{}},idempotency_key:`git:${fullSha}`,
  });
  const hook = (seq: number, fullSha: string, path: string) => fixed(seq,"committed",[ref(fullSha),`repo:${REPO}#${path}`],{
    method:{tool:"git",params:{sealed_by:HOOK}},idempotency_key:`git:${fullSha}`,
  });
  const webhook = (seq: number, fullSha: string, path: string) => fixed(seq,"committed",[ref(fullSha),`repo:${REPO}#${path}`],{
    tags:["github","push"],method:{tool:"git",params:{sealed_by:"webhook:github",producer:"github-push"}},
    idempotency_key:`gh:push:${REPO}:${fullSha}`,
  });
  const facts: CommitFacts[] = [
    {sha:legacySha,parents:["parent"],files:[{path:"legacy.ts",status:"M"}],author:{email:"who@example.com"},time:"2026-09-01T00:00:00.000Z"},
    {sha:aeabSha,parents:["parent"],files:[{path:"aeab.ts",status:"M"}],author:{email:"who@example.com"},time:"2026-09-01T00:00:00.000Z"},
    {sha:ffSha,parents:["parent"],files:[{path:"ff.ts",status:"M"}],author:{email:"who@example.com"},time:"2026-09-01T00:00:00.000Z"},
  ];
  const events = [
    edit(90,"legacy.ts"),legacy(100,legacySha,"legacy.ts"),legacy(110,legacySha,"legacy.ts"),
    edit(2800,"aeab.ts"),webhook(2839,aeabSha,"aeab.ts"),hook(2918,aeabSha,"aeab.ts"),
    edit(3100,"ff.ts"),webhook(3122,ffSha,"ff.ts"),hook(3311,ffSha,"ff.ts"),
  ];
  const expected = JSON.parse(readFileSync(new URL("./fixtures/reconcile-genuine-baseline.json",import.meta.url),"utf8"));
  const actual = reconcileCore(facts,events,{
    repoName:REPO,hookSealedBy:[HOOK],allowUnstampedSeals:true,restrictedStamps:restrictedPolicy,
  });
  assert.deepEqual(actual,expected);
});

test("artifactPath maps hook, alias, file: and bare ids; ignores foreign schemes", () => {
  const o = { repoNames: new Set([REPO, "retrace"]), repoPath: "/home/u/retrace" };
  assert.deepEqual(artifactPath(`repo:${REPO}#a/b.ts`, o), { path: "a/b.ts", loose: false });
  assert.deepEqual(artifactPath("repo:retrace#a/b.ts", o), { path: "a/b.ts", loose: false });
  assert.deepEqual(artifactPath("repo:other#a/b.ts", o), { path: "a/b.ts", loose: true });
  assert.deepEqual(artifactPath("file:/home/u/retrace/a/b.ts", o), { path: "a/b.ts", loose: true });
  assert.equal(artifactPath("file:/home/u/elsewhere/a.ts", o), undefined);
  assert.deepEqual(artifactPath("./a/b.ts", o), { path: "a/b.ts", loose: true });
  assert.equal(artifactPath(cid("a"), o), undefined);
  assert.equal(artifactPath("https://example.com/x", o), undefined);
  assert.equal(artifactPath("/etc/passwd", o), undefined);
});

test("reconcile: covered, uncovered, misattributed (+acknowledged), partial sweep, loose, rename, missing, merge, human, reach-back, orphans, pending", () => {
  const events: Event[] = [
    ev(3, codex, "edited", ["repo:retrace#x.ts"]),
    sealed(4, "a", codex, ["x.ts"]),                                   // covered
    sealed(6, "b", codex, ["y.ts"]),                                   // uncovered
    ev(7, claude, "edited", ["repo:retrace#z.ts"]), ev(8, claude, "created", ["repo:retrace#w.ts"]),
    sealed(9, "c", codex, ["z.ts", "w.ts"]),                           // the bfe87c3 shape
    ev(11, jordan, "other", [`commit:${REPO}@${sha("c").slice(0, 7)}`, "repo:retrace#z.ts"], { action_detail: "attributed", tags: ["correction"] }), // 7-char sha, as git prints it; a human ack
    ev(12, claude, "edited", ["repo:retrace#p.ts"]), ev(13, codex, "edited", ["repo:retrace#q.ts"]),
    sealed(14, "d", codex, ["p.ts", "q.ts"]),                          // partial sweep of p.ts
    ev(15, codex, "edited", ["file:/repo/l.ts"]),
    sealed(16, "e", codex, ["l.ts"]),                                  // loose
    ev(17, codex, "renamed", ["repo:retrace#old.ts"]),
    sealed(18, "f", codex, ["new.ts"]),                                // rename covered via `from`
    sealed(19, "1", codex, ["m.ts"], "merged"),                        // merge: no coverage
    sealed(20, "2", jordan, ["h.ts"]),                                 // human
    ev(21, claude, "edited", ["repo:retrace#x.ts"]),                   // reach-back: edited after commit a, committed by i
    ev(22, grok, "edited", ["repo:retrace#o.ts"]),                     // orphan
    sealed(23, "3", claude, ["x.ts"]),
    ev(24, claude, "edited", ["repo:retrace#s.ts"]),
    sealed(25, "4", codex, ["s.ts", "t.ts"]),                          // partial story: one swept file, one uncovered
    ev(26, grok, "edited", ["repo:retrace#later.ts"]),                 // pending
  ];
  const commits = [commit("a", ["x.ts"]), commit("b", ["y.ts"]), commit("c", ["z.ts", "w.ts"]), commit("d", ["p.ts", "q.ts"]), commit("e", ["l.ts"]),
    commit("f", [{ path: "new.ts", status: "R", from: "old.ts" }]), commit("1", ["m.ts"], ["p1", "p2"]), commit("2", ["h.ts"]), commit("3", ["x.ts"]), commit("4", ["s.ts", "t.ts"]), commit("9", ["gone.ts"])];
  const r = reconcile(commits, events, { repoName: REPO, aliases: ["retrace"], repoPath: "/repo" });
  const by = Object.fromEntries(r.commits.map((v) => [v.sha[0], v]));
  const kinds = (c: string) => by[c].findings.map((f) => `${f.kind}:${f.level}${f.acknowledged ? ":ack" : ""}${f.file ? ":" + f.file : ""}`);

  assert.deepEqual(kinds("a"), []);
  assert.deepEqual(by.a.coverage["x.ts"].actors, ["codex"]);
  assert.deepEqual(kinds("b"), ["uncovered:warn:y.ts"]);
  assert.deepEqual(kinds("c"), ["misattributed:info:ack"]);
  assert.equal(by.c.findings[0].acknowledged?.seq, 11);
  assert.match(by.c.findings[0].detail, /sealed as codex, but every logged edit .* claude-code/);
  assert.deepEqual(kinds("d"), ["misattributed:warn:p.ts"]);
  assert.deepEqual(kinds("e"), ["loose_match:info:l.ts"]);
  assert.deepEqual(kinds("f"), []);
  assert.deepEqual(by.f.coverage["new.ts"].actors, ["codex"]);
  assert.deepEqual(kinds("1"), []);
  assert.deepEqual(kinds("2"), ["non_agent:info"]);
  assert.deepEqual(kinds("3"), []);
  assert.deepEqual(by["3"].coverage["x.ts"].window, { after: 4, before: 23 }, "window reaches back to the previous commit touching x.ts, not the parent");
  assert.deepEqual(kinds("4"), ["uncovered:warn:t.ts", "misattributed:warn:s.ts"], "a partial story warns per file; only a complete contradiction fails");
  assert.deepEqual(kinds("9"), ["missing_commit:fail"]);

  assert.deepEqual(r.orphans.map((o) => [o.path, o.actors, o.last_seq]), [["o.ts", ["grok"], 22]]);
  assert.deepEqual(r.pending.map((o) => o.path), ["later.ts"]);
  assert.equal(r.ok, false, "the missing commit is an unacknowledged failure");
  assert.equal(r.summary.acknowledged, 1);
  assert.equal(r.summary.misattributed, 3);
  const text = renderReconcileReport(r);
  assert.match(text, /11 commits, 10 sealed — 1 missing, 3 misattributed, 0 producer-disagreement, 0 unreachable-seal, 2 uncovered, 1 loose, 1 non-agent, 1 orphan path, 1 pending, 1 acknowledged → NOT OK/);
  assert.match(text, /ACK {2}misattributed .*corrected by #11, jordan@example.com/);

  // without the missing commit the report is OK; with uncovered=fail it is not
  const okReport = reconcile(commits.filter((c) => c.sha[0] !== "9"), events, { repoName: REPO, aliases: ["retrace"], repoPath: "/repo" });
  assert.equal(okReport.ok, true);
  const strict = reconcile(commits.filter((c) => c.sha[0] !== "9"), events, { repoName: REPO, aliases: ["retrace"], repoPath: "/repo", uncovered: "fail" });
  assert.equal(strict.ok, false);
});

test("reconcile: a commit missing from the ledger keeps the file window open to the head; human edits never cover", () => {
  const events = [ev(1, jordan, "edited", ["repo:retrace#a.ts"]), sealed(2, "a", codex, ["a.ts"])];
  const r = reconcile([commit("a", ["a.ts"])], events, { repoName: REPO });
  assert.deepEqual(r.commits[0].findings.map((f) => f.kind), ["uncovered"], "a human's edit event is not agent coverage");
  const r2 = reconcile([commit("c", ["a.ts"])], events, { repoName: REPO });
  assert.equal(r2.commits[0].findings[0].kind, "missing_commit");
  assert.equal(r2.commits[0].findings[0].level, "fail");
  assert.equal(r2.range.head_seq, 2);
  const bot = { ...commit("d", ["a.ts"]), author: { name: "retrace-checkpoint[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" } };
  const r3 = reconcile([bot], events, { repoName: REPO });
  assert.deepEqual([r3.commits[0].findings[0].kind, r3.commits[0].findings[0].level], ["missing_commit", "fail"], "a bot-looking author is still just a string the pusher typed");
  assert.equal(r3.ok, false);
});

test("adversarial (Codex review of 48d7914): forged bot author never downgrades a missing commit; only a webhook-sealed merge head does", () => {
  const events = [sealed(2, "a", codex, ["a.ts"])];
  const forged = { ...commit("b", ["x.ts"]), author: { name: "retrace-checkpoint[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" } };
  const r = reconcile([forged], events, { repoName: REPO });
  assert.deepEqual([r.commits[0].findings[0].kind, r.commits[0].findings[0].level], ["missing_commit", "fail"], "author strings are whatever the pusher typed");
  assert.equal(r.ok, false);
  // a merged event stamped by the server as sealed by the GitHub webhook, naming this commit as the PR head
  const merged = (seq: number, headSha: string, stamp?: string) => ev(seq, jordan, "merged", [`pr:${REPO}#7`, cid("e")], { method: { tool: "github", params: { head_sha: headSha, ...(stamp ? { sealed_by: stamp } : {}) } }, tags: ["github", "pr", "merge"] });
  const r2 = reconcile([forged], [...events, merged(3, sha("b"), "webhook:github")], { repoName: REPO });
  assert.deepEqual([r2.commits[0].findings[0].kind, r2.commits[0].findings[0].level], ["missing_commit", "warn"]);
  assert.match(r2.commits[0].findings[0].detail, /merge #3 was sealed by the GitHub webhook/);
  assert.equal(r2.ok, true);
  // the same merged event without the server stamp (or stamped as a pinned agent) proves nothing
  for (const stamp of [undefined, "pinned:agent/codex", "owner"]) {
    const r3 = reconcile([forged], [...events, merged(3, sha("b"), stamp)], { repoName: REPO });
    assert.equal(r3.commits[0].findings[0].level, "fail", `stamp ${stamp}`);
  }
});

test("adversarial: acknowledgements must be sealed after the commit, by someone other than the accused, and never apply to unsealed commits", () => {
  const base = [ev(7, claude, "edited", ["repo:retrace#z.ts"]), sealed(9, "c", codex, ["z.ts"])];
  const correction = (seq: number, actor: any) => ev(seq, actor, "other", [cid("c")], { action_detail: "attributed", tags: ["correction"] });
  const level = (evs: Event[], opts: Partial<Parameters<typeof reconcile>[2]> = {}) => reconcile([commit("c", ["z.ts"])], evs, { repoName: REPO, aliases: ["retrace"], ...opts }).commits[0].findings[0];
  assert.equal(level(base).level, "fail");
  assert.equal(level([...base, correction(8, claude)]).level, "fail", "a correction sealed before the commit is a pre-ack, not an acknowledgement");
  for (const type of ["agent", "human", "system"] as const) {
    const finding = level([...base, correction(10, { type, id: codex.id })], { ackActors: [codex.id] });
    assert.equal(finding.level, "fail", `the accused id cannot acknowledge itself as ${type}`);
    assert.equal(finding.acknowledged, undefined);
  }
  assert.equal(level([...base, correction(10, claude)]).level, "fail", "an agent cannot acknowledge by default — only a listed reviewer agent may");
  assert.equal(level([...base, correction(10, jordan)]).level, "info", "a human always may");
  const listed = level([...base, correction(10, claude)], { ackActors: ["claude-code"] });
  assert.equal(listed.level, "info"); assert.deepEqual(listed.acknowledged?.actor, "claude-code");
  assert.equal(level([...base, correction(10, jordan)], { ackActors: ["claude-code"] }).level, "info", "the allowlist never restricts humans");
  // an unsealed commit with a pre-logged correction (sha is computable before the commit exists) stays a failure
  const pre = reconcile([commit("d", ["q.ts"])], [...base, ev(10, jordan, "other", [cid("d")], { tags: ["correction"] })], { repoName: REPO });
  assert.equal(pre.commits[0].findings[0].level, "fail");
  assert.equal(pre.commits[0].findings[0].acknowledged, undefined);
});

test("adversarial: one edit event naming A+B where only A was committed still reports B as an orphan", () => {
  const events = [sealed(1, "0", codex, ["seed.ts"]), ev(2, codex, "edited", ["repo:retrace#a.ts", "repo:retrace#b.ts"]), sealed(3, "a", codex, ["a.ts"]), sealed(4, "e", codex, ["z.ts"])];
  const r = reconcile([commit("0", ["seed.ts"]), commit("a", ["a.ts"]), commit("e", ["z.ts"])], events, { repoName: REPO, aliases: ["retrace"] });
  assert.deepEqual(r.commits[1].findings, []);
  assert.deepEqual(r.orphans.map((o) => o.path), ["b.ts"]);
});

test("phase B: the GitHub push webhook is a second producer — agreement is silent, disagreement fails, a lone producer warns, an unstamped push event is not a seal", () => {
  const pushed = (seq: number, c: string, actor: any, files: string[], stamp?: string) => ev(seq, actor, "committed", [cid(c), ...files.map((f) => `repo:${REPO}#${f}`)], { tags: ["github", "push"], method: { tool: "git", params: { producer: "github-push", ...(stamp ? { sealed_by: stamp } : {}) } }, idempotency_key: `gh:push:${REPO}:${sha(c)}` });
  const edits = [ev(1, codex, "edited", ["repo:retrace#a.ts", "repo:retrace#b.ts", "repo:retrace#c.ts", "repo:retrace#d.ts", "repo:retrace#e.ts"])];
  const events: Event[] = [
    ...edits,
    sealed(2, "a", codex, ["a.ts"]), pushed(3, "a", codex, ["a.ts"], "webhook:github"),            // both agree
    sealed(4, "b", codex, ["b.ts"]), pushed(5, "b", claude, ["b.ts"], "webhook:github"),           // disagree on actor
    pushed(6, "c", codex, ["c.ts"], "webhook:github"),                                             // webhook only
    sealed(7, "d", codex, ["d.ts"]),                                                               // hook only, after the webhook was enabled
    pushed(8, "e", codex, ["e.ts"]),                                                               // unstamped push-shaped event: not GitHub
  ];
  const opts = { repoName: REPO, aliases: ["retrace"] };
  const r = reconcile([commit("a", ["a.ts"]), commit("b", ["b.ts"]), commit("c", ["c.ts"]), commit("d", ["d.ts"]), commit("e", ["e.ts"])], events, opts);
  const by = Object.fromEntries(r.commits.map((v) => [v.sha[0], v]));
  const kinds = (c: string) => by[c].findings.map((f) => `${f.kind}:${f.level}`);
  assert.deepEqual(kinds("a"), []); assert.equal(by.a.sealed?.producer, "hook"); assert.equal(by.a.webhook?.seq, 3);
  assert.deepEqual(kinds("b"), ["producer_disagreement:fail"]);
  assert.match(by.b.findings[0].detail, /git hook #4 sealed .* as agent codex; the GitHub push webhook #5 resolved agent claude-code/);
  assert.deepEqual(kinds("c"), ["producer_disagreement:fail"], "an agent commit only GitHub saw fails under the default dual-witness policy"); assert.equal(by.c.sealed?.producer, "webhook");
  assert.deepEqual(by.c.coverage["c.ts"].actors, ["codex"], "a webhook-only seal still gets coverage evaluated");
  assert.deepEqual(kinds("d"), ["producer_disagreement:fail"]);
  assert.match(by.d.findings[0].detail, /never seen by the GitHub push webhook \(enabled since #3\)/);
  const lenient = reconcile([commit("c", ["c.ts"]), commit("d", ["d.ts"])], events, { ...opts, dualWitness: "warn" });
  assert.deepEqual(lenient.commits.map((v) => v.findings[0].level), ["warn", "warn"], "--dual-witness warn for local, unpushed work");
  assert.equal(lenient.ok, true);
  assert.deepEqual(kinds("e"), ["missing_commit:fail"], "a push-shaped event without the server's webhook stamp seals nothing");
  assert.match(by.e.findings[0].detail, /sealed as unstamped by agent codex — not this repo's git hook credential and not the GitHub webhook/);
  assert.equal(r.summary.producer_disagreement, 3);
  // before the webhook existed, a hook-only commit is simply normal
  const early = reconcile([commit("d", ["d.ts"])], [...edits, sealed(7, "d", codex, ["d.ts"])], opts);
  assert.deepEqual(early.commits[0].findings, []);
});

test("coverage honours PROV roles: an executed/other event whose artifact is generated/both covers the file; used/read refs never do", () => {
  const withRole = (seq: number, action: Event["action"], role: "generated" | "both" | "used") => ({ ...ev(seq, codex, action, []), artifacts: [{ id: "repo:retrace#w.toml", role }] });
  const run = (e: Event) => reconcile([commit("a", ["w.toml"])], [e, sealed(9, "a", codex, ["w.toml"])], { repoName: REPO, aliases: ["retrace"] }).commits[0];
  assert.deepEqual(run(withRole(1, "executed", "both")).findings, []);
  assert.deepEqual(run(withRole(1, "other", "generated")).findings, []);
  assert.deepEqual(run(withRole(1, "executed", "used")).findings.map((f) => f.kind), ["uncovered"]);
  assert.deepEqual(run(withRole(1, "read", "used")).findings.map((f) => f.kind), ["uncovered"]);
});

test("adversarial (Codex review of 1491c67): a committed-shaped event from a pinned agent credential is a claim, not a hook seal", () => {
  // shape is perfect: action committed, tool git, git: key — only the server stamp says who really sealed it
  const claim = sealed(5, "a", codex, ["a.ts"], "committed", "pinned:agent/codex");
  const edits = [ev(1, codex, "edited", ["repo:retrace#a.ts"])];
  const r = reconcile([commit("a", ["a.ts"])], [...edits, claim], { repoName: REPO, aliases: ["retrace"] });
  assert.equal(r.commits[0].sealed, undefined);
  assert.deepEqual([r.commits[0].findings[0].kind, r.commits[0].findings[0].level], ["missing_commit", "fail"]);
  assert.match(r.commits[0].findings[0].detail, /sealed as pinned:agent\/codex by agent codex — not this repo's git hook credential/);
  // …and it cannot "agree" with the real webhook to look dual-witnessed: the webhook alone is a lone producer
  const push = ev(6, codex, "committed", [cid("a"), `repo:${REPO}#a.ts`], { tags: ["github", "push"], method: { tool: "git", params: { producer: "github-push", sealed_by: "webhook:github" } }, idempotency_key: `gh:push:${REPO}:${sha("a")}` });
  const r2 = reconcile([commit("a", ["a.ts"])], [...edits, claim, push], { repoName: REPO, aliases: ["retrace"] });
  assert.equal(r2.commits[0].sealed?.producer, "webhook");
  assert.deepEqual(r2.commits[0].findings.map((f) => `${f.kind}:${f.level}`), ["producer_disagreement:fail"]);
  for (const stamp of ["", "unauthenticated", "webhook:github"]) {
    const r3 = reconcile([commit("a", ["a.ts"])], [...edits, sealed(5, "a", codex, ["a.ts"], "committed", stamp)], { repoName: REPO, aliases: ["retrace"] });
    assert.equal(r3.commits[0].sealed, undefined, `stamp ${stamp} is not a hook seal`);
  }
  // pre-stamp history is only accepted when the run says so
  const legacy = reconcile([commit("a", ["a.ts"])], [...edits, sealed(5, "a", codex, ["a.ts"], "committed", "")], { repoName: REPO, aliases: ["retrace"], allowUnstampedSeals: true });
  assert.equal(legacy.commits[0].sealed?.producer, "hook");
  assert.deepEqual(legacy.commits[0].findings, []);
  // NEGATIVE (Jordan/Codex refinement): a DIFFERENT assert credential — the Drive forwarder — with a perfect git key,
  // tool and action is not the hook. Trust is the exact configured stamp, never the credential class.
  const drive = reconcile([commit("a", ["a.ts"])], [...edits, sealed(5, "a", codex, ["a.ts"], "committed", "assert:Drive forwarder (assert)")], { repoName: REPO, aliases: ["retrace"] });
  assert.equal(drive.commits[0].sealed, undefined);
  assert.match(drive.commits[0].findings[0].detail, /sealed as assert:Drive forwarder \(assert\) .* not this repo's git hook credential/);
  // no configured hook credential at all → nothing is a hook seal, and the finding says what to set
  const unconfigured = reconcileCore([commit("a", ["a.ts"])], [...edits, sealed(5, "a", codex, ["a.ts"])], { repoName: REPO, aliases: ["retrace"] });
  assert.equal(unconfigured.commits[0].sealed, undefined);
  assert.match(unconfigured.commits[0].findings[0].detail, /set reconcile.hook_sealed_by to \["assert:retrace-git"\]/);
  // owner seals: an explicit, documented operator override — off by default
  assert.equal(reconcile([commit("a", ["a.ts"])], [...edits, sealed(5, "a", codex, ["a.ts"], "committed", "owner")], { repoName: REPO, aliases: ["retrace"] }).commits[0].sealed, undefined);
  assert.equal(reconcile([commit("a", ["a.ts"])], [...edits, sealed(5, "a", codex, ["a.ts"], "committed", "owner")], { repoName: REPO, aliases: ["retrace"], ownerSeals: true }).commits[0].sealed?.producer, "hook");
  // the stamp must match exactly: a prefix or a look-alike name is not it
  for (const near of ["assert:retrace-git-2", "assert:retrace-gi", "pinned:retrace-git", "assert:", "assert:retrace-git (assert)"]) {
    assert.equal(reconcile([commit("a", ["a.ts"])], [...edits, sealed(5, "a", codex, ["a.ts"], "committed", near)], { repoName: REPO, aliases: ["retrace"] }).commits[0].sealed, undefined, near);
  }
});

test("adversarial: an amend after the hook ran leaves the old seal behind and makes the new sha webhook-only — both are reported", () => {
  const edits = [ev(1, codex, "edited", ["repo:retrace#a.ts"])];
  const oldSeal = sealed(2, "a", codex, ["a.ts"]);                                                      // hook sealed the original sha
  const pushNew = ev(3, codex, "committed", [cid("b"), `repo:${REPO}#a.ts`], { tags: ["github", "push"], method: { tool: "git", params: { producer: "github-push", sealed_by: "webhook:github" } }, idempotency_key: `gh:push:${REPO}:${sha("b")}` });
  const r0 = reconcile([commit("b", ["a.ts"])], [...edits, oldSeal, pushNew], { repoName: REPO, aliases: ["retrace"] }); // caller has not checked git yet
  assert.deepEqual(r0.seals, [{ sha12: sha("a").slice(0, 12), seq: 2 }, { sha12: sha("b").slice(0, 12), seq: 3 }], "core hands back every seal for the caller to check against git reachability");
  // the caller found sha a is gone from the repository
  const r = reconcile([commit("b", ["a.ts"])], [...edits, oldSeal, pushNew], { repoName: REPO, aliases: ["retrace"], unreachableShas: [sha("a")] });
  assert.deepEqual(r.commits[0].findings.map((f) => `${f.kind}:${f.level}`), ["producer_disagreement:fail"], "the abandoned seal must not swallow the edit the amended commit carried");
  assert.deepEqual(r.commits[0].coverage["a.ts"].actors, ["codex"]);
  assert.match(r.commits[0].findings[0].detail, /amended\/rebased after it ran/);
  assert.equal(r.ok, false);
  assert.deepEqual(r.commits[1].findings.map((f) => `${f.kind}:${f.level}`), ["unreachable_seal:warn"]);
  assert.match(r.commits[1].findings[0].detail, new RegExp(`${sha("a").slice(0, 12)} was sealed by the git hook #2 as agent codex but no longer exists`));
  assert.equal(r.summary.unreachable_seal, 1);
});

test("adversarial: window boundaries are one per sha at the hook's seq — the webhook's later copy must not swallow an edit", () => {
  const push = (seq: number, c: string) => ev(seq, codex, "committed", [cid(c), `repo:${REPO}#a.ts`, `repo:${REPO}#b.ts`], { tags: ["github", "push"], method: { tool: "git", params: { producer: "github-push", sealed_by: "webhook:github" } }, idempotency_key: `gh:push:${REPO}:${sha(c)}` });
  // hook A #1 (touches b.ts), edit b.ts #2, webhook A #3, hook B #4
  const events = [sealed(1, "a", codex, ["a.ts", "b.ts"]), ev(2, codex, "edited", ["repo:retrace#b.ts"]), push(3, "a"), sealed(4, "b", codex, ["b.ts"]), push(5, "b")];
  const r = reconcile([commit("a", ["a.ts", "b.ts"]), commit("b", ["b.ts"])], events, { repoName: REPO, aliases: ["retrace"] });
  const b = r.commits[1];
  assert.deepEqual(b.coverage["b.ts"].window, { after: 1, before: 4 }, "boundary is the hook seal #1, not the webhook copy #3");
  assert.deepEqual(b.coverage["b.ts"].actors, ["codex"]);
  assert.deepEqual(b.findings, []);
});

test("adversarial: an explicit artifact role is authoritative — `edited` with role `used` does not cover; a role-less ref falls back to the verb", () => {
  const withRole = (role?: "generated" | "both" | "used") => ({ ...ev(1, codex, "edited", []), artifacts: [{ id: "repo:retrace#w.toml", ...(role ? { role } : {}) }] });
  const run = (e: Event) => reconcile([commit("a", ["w.toml"])], [e, sealed(9, "a", codex, ["w.toml"])], { repoName: REPO, aliases: ["retrace"] }).commits[0];
  assert.deepEqual(run(withRole("used")).findings.map((f) => f.kind), ["uncovered"], "edited + used is a declared input, not a change");
  assert.deepEqual(run(withRole("both")).findings, []);
  assert.deepEqual(run(withRole(undefined)).findings, [], "no role: the verb decides");
});

test("legacy unstamped seals bound windows but are not trusted; an unstamped commit event after the first stamp bounds nothing", () => {
  const push = (seq: number, c: string, files: string[]) => ev(seq, claude, "committed", [cid(c), ...files.map((f) => `repo:${REPO}#${f}`)], { tags: ["github", "push"], method: { tool: "git", params: { producer: "github-push", sealed_by: "webhook:github" } }, idempotency_key: `gh:push:${REPO}:${sha(c)}` });
  // the aecf567 shape: grok edited package.json (#3); a pre-stamp commit carried it (#5, unstamped); the server started
  // stamping at #6; claude-code then bumped package.json without logging and committed (#9, stamped) — that is
  // `uncovered`, not "misattributed to grok": the legacy seal at #5 closes grok's edit out of the new window.
  const events = [
    ev(3, grok, "edited", ["repo:retrace#package.json"]),
    sealed(5, "a", grok, ["package.json"], "committed", ""),
    ev(6, claude, "edited", ["repo:retrace#other.ts"], { method: { tool: "mcp", params: { sealed_by: "pinned:claude" } } }),
    sealed(9, "b", claude, ["package.json"]), push(10, "b", ["package.json"]),
  ];
  const r = reconcile([commit("b", ["package.json"])], events, { repoName: REPO, aliases: ["retrace"] });
  assert.deepEqual(r.commits[0].findings.map((f) => `${f.kind}:${f.level}`), ["uncovered:warn"]);
  assert.deepEqual(r.commits[0].coverage["package.json"].window, { after: 5, before: 9 });
  // the legacy commit itself is still not a trusted seal without the flag…
  const legacy = reconcile([commit("a", ["package.json"])], events, { repoName: REPO, aliases: ["retrace"] });
  assert.equal(legacy.commits[0].findings[0].kind, "missing_commit");
  // …and an UNSTAMPED commit event AFTER stamping began (a planted claim) bounds nothing: grok's edit stays in the window
  const planted = [events[0], sealed(7, "a", codex, ["package.json"], "committed", ""), ev(6, claude, "edited", ["repo:retrace#other.ts"], { method: { tool: "mcp", params: { sealed_by: "pinned:claude" } } }), sealed(9, "b", claude, ["package.json"]), push(10, "b", ["package.json"])];
  const r2 = reconcile([commit("b", ["package.json"])], planted, { repoName: REPO, aliases: ["retrace"] });
  assert.deepEqual(r2.commits[0].coverage["package.json"].window, { after: -1, before: 9 });
  assert.deepEqual(r2.commits[0].findings.map((f) => `${f.kind}:${f.level}`), ["misattributed:fail"]);
});

test("adversarial (event #1227): the accused model re-pinned as another harness cannot acknowledge its own commit, allowlisted or not", () => {
  const grokSeal = { ...sealed(9, "c", { type: "agent", id: "grok", model: "grok-4.6" }, ["z.ts"]), location: { session: "sess-1" } };
  const base: Event[] = [ev(7, claude, "edited", ["repo:retrace#z.ts"]), grokSeal];
  const ack = (seq: number, actor: any, session?: string) => ev(seq, actor, "other", [cid("c")], { action_detail: "attributed", tags: ["correction"], ...(session ? { location: { session } } : {}) });
  const run = (evs: Event[], ackActors?: string[]) => reconcile([commit("c", ["z.ts"])], evs, { repoName: REPO, aliases: ["retrace"], ackActors }).commits[0].findings[0];
  const cursorOnGrok = { type: "agent", id: "cursor-agent", model: "grok-4.6" };
  assert.equal(run([...base, ack(10, cursorOnGrok)]).level, "fail", "different pinned id, same model, not listed");
  assert.equal(run([...base, ack(10, cursorOnGrok)], ["cursor-agent"]).level, "fail", "listed, but the same model as the accused seal");
  assert.equal(run([...base, ack(10, { type: "agent", id: "cursor-agent", model: "claude-fable-5" }, "sess-1")], ["cursor-agent"]).level, "fail", "listed, different model, but the same session");
  const clean = run([...base, ack(10, { type: "agent", id: "cursor-agent", model: "claude-fable-5" }, "sess-2")], ["cursor-agent"]);
  assert.equal(clean.level, "info"); assert.equal(clean.acknowledged?.actor, "cursor-agent");
  assert.equal(run([...base, ack(10, jordan)]).level, "info", "the human owner's acknowledgement stands");
});

test("T13 owner-login account merge keeps webhook missing_commit downgrade without becoming a witness", () => {
  const account = { type: "system" as const, id: "github:jordandru", display_name: "jordandru (GitHub account, shared)" };
  const merge = ev(3, account, "merged", [`pr:${REPO}#7`, cid("e")], { method: { tool: "github", params: { head_sha: sha("b"), sealed_by: "webhook:github" } }, tags: ["github", "pr", "merge"] });
  const report = reconcile([commit("b", ["x.ts"])], [merge], { repoName: REPO });
  assert.deepEqual([report.commits[0].findings[0].kind, report.commits[0].findings[0].level], ["missing_commit", "warn"]);
});

test("#195 the report states whether attribution amendments were evaluated", () => {
  const seal = sealed(10, "a", codex, ["x.ts"]);
  const none = reconcile([commit("a", ["x.ts"])], [seal], { repoName: REPO });
  assert.deepEqual(none.attribution, { status: "not_needed" });
  const amendment = ev(11, jordan, "other", ["event:" + seal.id], { action_detail: "amended", tags: ["amendment", "attribution"], method: { tool: "retrace_amend", params: { sealed_by: "owner", target_event_id: seal.id, attribution: {} } } });
  const unavailable = reconcile([commit("a", ["x.ts"])], [seal, amendment], { repoName: REPO });
  assert.deepEqual(unavailable.attribution, { status: "unavailable", reason: "untrusted_snapshot" });
  const named = reconcile([commit("a", ["x.ts"])], [seal, amendment], { repoName: REPO, attributionUnavailable: "context_missing: full commit identity commit:b96676bc" });
  assert.deepEqual(named.attribution, { status: "unavailable", reason: "context_missing: full commit identity commit:b96676bc" });
  assert.match(JSON.stringify(named), /"attribution":\{"status":"unavailable","reason":"context_missing/);
});
