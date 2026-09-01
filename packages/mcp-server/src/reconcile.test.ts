import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKey, appendEvent, buildExportBundle, EventStore, Event, Share, EventInput } from "@retrace-dev/core";
import { parseNameStatus, verifiedExportEvents } from "./reconcile.js";

class MemStore implements EventStore {
  events: Event[] = []; shares = new Map<string, Share>();
  async head(p: string) { const e = this.events.filter((x) => x.project === p).at(-1); return e ? { seq: e.seq, hash: e.hash } : null; }
  async insert(e: Event) { this.events.push(e); }
  async byIdempotencyKey() { return null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(p: string) { return this.events.filter((e) => e.project === p); }
  async projects() { return ["p"]; }
  async history() { return this.events; }
  async createShare(s: Share) { this.shares.set(s.id, s); }
  async getShare(id: string) { return this.shares.get(id) ?? null; }
}
const ev = (): EventInput => ({ project: "p", actor: { type: "agent", id: "claude-code" }, action: "edited", artifacts: [{ id: "repo:p#a.ts" }] });

test("parseNameStatus: modify, add, delete, rename with source", () => {
  assert.deepEqual(parseNameStatus("M\ta.ts\nA\tb.ts\nD\tc.ts\nR095\told.ts\tnew.ts\nC100\tsrc.ts\tdst.ts\n"), [
    { path: "a.ts", status: "M" }, { path: "b.ts", status: "A" }, { path: "c.ts", status: "D" }, { path: "new.ts", status: "R", from: "old.ts" }, { path: "dst.ts", status: "C", from: "src.ts" },
  ]);
});

test("verifiedExportEvents fails closed: no trusted key, wrong key, tampered events, self-attested; passes only a valid signed full export", async () => {
  const store = new MemStore();
  await appendEvent(store, ev()); await appendEvent(store, ev());
  const issuer = await generateSigningKey();
  const bundle = await buildExportBundle(store, { project: "p" }, { signingKey: issuer.privateKey, issuerName: "test" });
  const flag = JSON.stringify(issuer.publicKey);
  const good = await verifiedExportEvents(bundle, flag);
  assert.equal(good.events.length, 2);
  assert.match(good.note, /verified against --pubkey/);
  const saved = process.env.RETRACE_PUBKEY; delete process.env.RETRACE_PUBKEY;
  try {
    await assert.rejects(() => verifiedExportEvents(bundle, undefined, "http://plain.example"), /no trusted issuer key/);
    await assert.rejects(() => verifiedExportEvents(bundle, undefined, ""), /no trusted issuer key/);
  } finally { if (saved !== undefined) process.env.RETRACE_PUBKEY = saved; }
  const stranger = await generateSigningKey();
  await assert.rejects(() => verifiedExportEvents(bundle, JSON.stringify(stranger.publicKey)), /does not verify/);
  const tampered = { ...bundle, events: [{ ...bundle.events[0], actor: { type: "agent" as const, id: "codex" } }, bundle.events[1]] };
  await assert.rejects(() => verifiedExportEvents(tampered, flag), /does not verify/);
  const unsigned = await buildExportBundle(store, { project: "p" }, {});
  await assert.rejects(() => verifiedExportEvents(unsigned, flag), /does not verify/);
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unreachableSeals, reconcileWithGit, commitFacts } from "./reconcile.js";

function tempRepo(): { repo: string; g: (...a: string[]) => string; write: (f: string, c: string) => void } {
  const repo = mkdtempSync(join(tmpdir(), "retrace-rec-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  g("init", "-q", "-b", "main");
  return { repo, g, write: (f, c) => writeFileSync(join(repo, f), c) };
}

test("unreachableSeals: ref reachability with a horizon — an amended original that still exists as an object IS unreachable; history older than the checkout is NOT", () => {
  const { repo, g, write } = tempRepo();
  write("a.txt", "1"); g("add", "a.txt"); g("commit", "-q", "-m", "c1"); const c1 = g("rev-parse", "HEAD").slice(0, 12);
  write("a.txt", "2"); g("commit", "-q", "-am", "c2"); const c2 = g("rev-parse", "HEAD").slice(0, 12);
  write("a.txt", "3"); g("commit", "-q", "-am", "c3"); const c3orig = g("rev-parse", "HEAD").slice(0, 12);
  g("commit", "-q", "--amend", "-m", "c3 amended"); const c3 = g("rev-parse", "HEAD").slice(0, 12);
  // the amended original still exists as an object (reflog) — existence must not be the test
  execFileSync("git", ["-C", repo, "cat-file", "-e", `${c3orig}^{commit}`]);
  const gone = "0123456789ab";
  const seals = [{ sha12: gone, seq: 1 }, { sha12: c1, seq: 2 }, { sha12: c2, seq: 3 }, { sha12: c3orig, seq: 4 }, { sha12: c3, seq: 5 }, { sha12: "fedcba987654", seq: 6 }];
  assert.deepEqual(unreachableSeals(repo, seals), [c3orig, "fedcba987654"], "older-than-horizon sha is unfetched history, not a rewrite");
  assert.deepEqual(unreachableSeals(repo, [{ sha12: gone, seq: 1 }]), [], "nothing reachable → nothing excluded");
  assert.deepEqual(unreachableSeals(repo, []), []);
});

test("shallow-clone regression (Codex review of 05c61f9): history the checkout never fetched keeps bounding windows, so a stale edit cannot cover an unlogged HEAD change", () => {
  const src = tempRepo();
  src.write("x.ts", "1"); src.g("add", "x.ts"); src.g("commit", "-q", "-m", "c1"); const c1 = src.g("rev-parse", "HEAD");
  src.write("x.ts", "2"); src.g("commit", "-q", "-am", "c2"); const c2 = src.g("rev-parse", "HEAD");
  src.write("x.ts", "3"); src.g("commit", "-q", "-am", "c3"); const c3 = src.g("rev-parse", "HEAD");
  const shallow = mkdtempSync(join(tmpdir(), "retrace-shallow-"));
  execFileSync("git", ["clone", "-q", "--depth", "2", `file://${src.repo}`, shallow], { stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(execFileSync("git", ["-C", shallow, "rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim(), "true");
  const REPO = "o/r"; const HOOK = "assert:retrace-git";
  const ev = (seq: number, actor: any, action: any, ids: string[], extra: any = {}): Event => ({ id: `e${seq}`, seq, project: "p", actor, action, artifacts: ids.map((id) => ({ id, ...(id.startsWith("commit:") ? { kind: "commit" } : {}) })), timestamp: "2026-09-01T00:00:00Z", received_at: "2026-09-01T00:00:00Z", prev_hash: "", hash: `h${seq}`, ...extra });
  const codex = { type: "agent", id: "codex" };
  const seal = (seq: number, sha: string) => ev(seq, codex, "committed", [`commit:${REPO}@${sha.slice(0, 12)}`, `repo:${REPO}#x.ts`], { method: { tool: "git", params: { sealed_by: HOOK } }, idempotency_key: `git:${sha}` });
  // old edit #1 → sealed into c1 (#2, NOT in the shallow clone) → c2 (#3) → HEAD c3 (#4) with no edit logged
  const events = [ev(1, codex, "edited", [`repo:${REPO}#x.ts`]), seal(2, c1), seal(3, c2), seal(4, c3)];
  const facts = commitFacts(shallow, "HEAD");
  const r = reconcileWithGit(shallow, [facts], events, { repoName: REPO, hookSealedBy: [HOOK] });
  assert.deepEqual(r.commits[0].findings.map((f) => `${f.kind}:${f.level}`), ["uncovered:warn"], "the unfetched seal of c1 still bounds the window; edit #1 must not cover HEAD");
  assert.deepEqual(r.commits[0].coverage["x.ts"].window, { after: 3, before: 4 });
  assert.equal(r.summary.unreachable_seal, 0);
});
