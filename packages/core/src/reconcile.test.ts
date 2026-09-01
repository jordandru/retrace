import { test } from "node:test";
import assert from "node:assert/strict";
import { Event } from "./schema.js";
import { reconcile, artifactPath, renderReconcileReport, CommitFacts } from "./reconcile.js";

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
const sealed = (seq: number, c: string, actor: any, files: string[], action: Event["action"] = "committed") => ev(seq, actor, action, [cid(c), ...files.map((f) => `repo:${REPO}#${f}`)]);

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
    ev(11, claude, "other", [`commit:${REPO}@${sha("c").slice(0, 7)}`, "repo:retrace#z.ts"], { action_detail: "attributed", tags: ["correction"] }), // 7-char sha, as git prints it
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
  assert.match(text, /11 commits, 10 sealed — 1 missing, 3 misattributed, 0 producer-disagreement, 2 uncovered, 1 loose, 1 non-agent, 1 orphan path, 1 pending, 1 acknowledged → NOT OK/);
  assert.match(text, /ACK {2}misattributed .*corrected by #11/);

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
  assert.equal(level([...base, correction(10, codex)]).level, "fail", "the accused committer cannot acknowledge itself");
  const other = level([...base, correction(10, claude)]);
  assert.equal(other.level, "info"); assert.deepEqual(other.acknowledged?.actor, "claude-code");
  assert.equal(level([...base, correction(10, jordan)]).level, "info", "a human always may");
  assert.equal(level([...base, correction(10, claude)], { ackActors: ["jordan@example.com"] }).level, "fail", "ackActors restricts agents");
  assert.equal(level([...base, correction(10, jordan)], { ackActors: ["jordan@example.com"] }).level, "info");
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
  assert.deepEqual(kinds("c"), ["producer_disagreement:warn"]); assert.equal(by.c.sealed?.producer, "webhook");
  assert.deepEqual(by.c.coverage["c.ts"].actors, ["codex"], "a webhook-only seal still gets coverage evaluated");
  assert.deepEqual(kinds("d"), ["producer_disagreement:warn"]);
  assert.match(by.d.findings[0].detail, /never seen by the GitHub push webhook \(enabled since #3\)/);
  assert.deepEqual(kinds("e"), ["missing_commit:fail"], "a push-shaped event without the server's webhook stamp seals nothing");
  assert.equal(r.summary.producer_disagreement, 3);
  // before the webhook existed, a hook-only commit is simply normal
  const early = reconcile([commit("d", ["d.ts"])], [...edits, sealed(7, "d", codex, ["d.ts"])], opts);
  assert.deepEqual(early.commits[0].findings, []);
});
