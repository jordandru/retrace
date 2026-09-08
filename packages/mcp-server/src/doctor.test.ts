import { test } from "node:test";
import assert from "node:assert/strict";
import { Credential, Event, EventInput, EventStore, Share, appendEvent, buildExportBundle, generateSigningKey, pageHistoryNewest, schemaSurface, signCanonical } from "@retrace-dev/core";
import { attributionFinding, credentialAuthorization, doctorHistoryEvents, gateRemoteAuthorization, headDelivery, instructRootFinding, missingSchema, parseDoctorArgs, pinSessionFinding, remoteCaptureCoverage, sealedCommitEvent, sealedLooksAgent } from "./doctor.js";
import { RemoteStore } from "./remote-store.js";

const why = (rows: Array<{ id: string; action: Event["action"]; type: Event["actor"]["type"]; caused_by?: string }>): Event[] =>
  rows.map((r, seq) => ({
    id: r.id, project: "retrace", seq, action: r.action, actor: { type: r.type, id: r.type === "human" ? "jordan@example.com" : "grok" },
    artifacts: [{ id: "a", role: "generated" }], timestamp: "2026-08-29T00:00:00Z", received_at: "2026-08-29T00:00:00Z",
    prev_hash: "0", hash: "0", caused_by: r.caused_by,
  }));

test("doctor: schema comparison names only fields the deployment would drop", () => {
  const local = schemaSurface();
  const remote = structuredClone(local);
  remote.location = remote.location.filter((k) => k !== "workspace");
  assert.deepEqual(missingSchema(remote), ["location.workspace"]);
  assert.deepEqual(missingSchema({ ...local, future: ["x"] }), []);
});

test("doctor: assert credentials authorize the exact actor type/id pair", () => {
  const credential = Credential.parse({
    token: "doctor-token-0123456789abcdef",
    actor: { type: "system", id: "retrace-git" },
    trust: "assert",
    allowed_actors: [{ type: "agent", id: "codex" }, { type: "agent", id: "grok" }],
  });
  assert.equal(credentialAuthorization(credential, { type: "agent", id: "codex" }).level, "pass");
  assert.equal(credentialAuthorization(credential, { type: "agent", id: "grok" }).level, "pass");
  const denied = credentialAuthorization(credential, { type: "agent", id: "claude-code" });
  assert.equal(denied.level, "fail");
  assert.match(denied.detail, /claude-code.*allowed_actors/);
});

test("doctor: pinned credentials require the commit actor to match", () => {
  const credential = Credential.parse({ token: "doctor-token-0123456789abcdef", actor: { type: "agent", id: "codex" } });
  assert.equal(credentialAuthorization(credential, { type: "agent", id: "codex", model: "gpt-5.6-sol" }).level, "pass");
  assert.equal(credentialAuthorization(credential, { type: "human", id: "dev@example.com" }).level, "fail");
});

test("doctor: --gate is a flag, not a repo path", () => {
  assert.deepEqual(parseDoctorArgs(["doctor", "--gate"]), { command: "doctor", gate: true, json: false, local: false, repo: undefined });
  assert.deepEqual(parseDoctorArgs(["--gate", "/tmp/repo"]), { command: "doctor", gate: true, json: false, local: false, repo: "/tmp/repo" });
  assert.deepEqual(parseDoctorArgs(["status", "retrace", "--json"]), { command: "status", gate: false, json: true, local: false, statusProject: "retrace" });
  assert.equal(parseDoctorArgs(["doctor", "."]).gate, false);
});

test("doctor: missing HEAD delivery is warn locally and fail in --gate", () => {
  assert.equal(headDelivery(false, "commit:retrace@abc123def456", true).level, "pass");
  assert.equal(headDelivery(false, "commit:retrace@abc123def456", false).level, "warn");
  assert.equal(headDelivery(true, "commit:retrace@abc123def456", false).level, "fail");
  assert.equal(headDelivery(true, undefined, false).level, "fail");
});

test("doctor: HEAD history accepts current paginated responses and legacy arrays", () => {
  const event = why([{ id: "evt_commit", action: "committed", type: "agent" }])[0];
  assert.deepEqual(doctorHistoryEvents({ events: [event], truncated: false }), [event]);
  assert.deepEqual(doctorHistoryEvents([event]), [event]);
});

test("doctor: instruct root is required for agent commits only", () => {
  const rooted = why([
    { id: "evt_commit", action: "committed", type: "agent", caused_by: "evt_instruct" },
    { id: "evt_instruct", action: "instructed", type: "human" },
  ]);
  assert.equal(instructRootFinding("agent", rooted).level, "pass");
  assert.equal(instructRootFinding("human", []).level, "pass");
  assert.equal(instructRootFinding("agent", []).level, "fail");
  assert.equal(instructRootFinding("agent", why([{ id: "evt_commit", action: "committed", type: "agent" }])).level, "fail");
  assert.equal(instructRootFinding("agent", why([{ id: "evt_commit", action: "committed", type: "agent", caused_by: "evt_missing" }])).level, "fail");
});

const commitEvt = (over: Partial<Event> & { id: string; seq: number }): Event => ({
  project: "retrace", action: "committed", actor: { type: "human", id: "jordan@example.com" },
  artifacts: [{ id: "commit:retrace@abc123def456", kind: "commit", role: "generated" }],
  timestamp: "2026-08-29T00:00:00Z", received_at: "2026-08-29T00:00:00Z", prev_hash: "0", hash: "0",
  ...over,
});

test("doctor: human+surface=agent fails instruct-root under --gate; human+tty and replay pass", () => {
  const tty = commitEvt({ id: "evt_tty", seq: 1, location: { surface: "tty" } });
  const replay = commitEvt({ id: "evt_replay", seq: 2 });
  const omitted = commitEvt({ id: "evt_omit", seq: 3, location: { surface: "agent" } });
  assert.equal(attributionFinding(true, tty).level, "pass");
  assert.equal(instructRootFinding(tty.actor.type, [tty]).level, "pass");
  assert.equal(sealedLooksAgent(tty), false);
  assert.equal(attributionFinding(true, replay).level, "pass");
  assert.equal(sealedLooksAgent(replay), false);
  assert.equal(attributionFinding(false, omitted).level, "warn");
  assert.equal(attributionFinding(true, omitted).level, "fail");
  assert.equal(sealedLooksAgent(omitted), true);
  assert.equal(instructRootFinding("agent", [omitted]).level, "fail");
});

test("doctor: a later non-commit event on the same artifact cannot shadow the commit", () => {
  const commit = commitEvt({ id: "evt_commit", seq: 4, location: { surface: "tty" } });
  const later = commitEvt({
    id: "evt_amend", seq: 9, action: "other", action_detail: "amended",
    actor: { type: "agent", id: "auditor" }, location: { surface: "agent" },
  });
  const picked = sealedCommitEvent([commit, later]);
  assert.equal(picked?.id, "evt_commit");
  assert.equal(attributionFinding(true, picked!).level, "pass");
  assert.equal(sealedLooksAgent(picked!), false);
});

test("doctor: pin/session compares sealed commit to MCP peers, never process env", () => {
  const instruct = commitEvt({ id: "evt_ins", seq: 0, action: "instructed", actor: { type: "human", id: "jordan@example.com" } });
  const edit = commitEvt({
    id: "evt_edit", seq: 1, action: "edited",
    actor: { type: "agent", id: "grok" }, location: { session: "sess-a", surface: "agent" }, caused_by: instruct.id,
  });
  const commit = commitEvt({
    id: "evt_c", seq: 2, actor: { type: "agent", id: "grok" },
    location: { session: "sess-a", surface: "agent" }, caused_by: edit.id,
  });
  const why = [commit, edit, instruct];
  assert.equal(pinSessionFinding(true, commit, why).level, "pass");

  const wrongPin = { ...commit, actor: { type: "agent" as const, id: "claude-code" } };
  const pin = pinSessionFinding(true, wrongPin, why);
  assert.equal(pin.level, "fail");
  assert.match(pin.detail, /claude-code/);
  assert.match(pin.detail, /agent\/grok/);
  assert.equal(pinSessionFinding(false, wrongPin, why).level, "warn");

  const wrongSess = { ...commit, location: { session: "sess-b", surface: "agent" as const } };
  const sess = pinSessionFinding(true, wrongSess, [wrongSess, edit, instruct]);
  assert.equal(sess.level, "fail");
  assert.match(sess.detail, /sess-b/);
  assert.match(sess.detail, /sess-a/);

  const replay = commitEvt({ id: "evt_replay_c", seq: 2, actor: { type: "agent", id: "grok" }, caused_by: edit.id });
  assert.equal(pinSessionFinding(true, replay, [replay, edit, instruct]).level, "pass", "replay with no session is not a miss");

  const direct = commitEvt({ id: "evt_direct", seq: 1, actor: { type: "agent", id: "grok" }, location: { session: "sess-a", surface: "agent" }, caused_by: instruct.id });
  assert.equal(pinSessionFinding(true, direct, [direct, instruct]).level, "pass", "commit → instruct with no MCP peers");
});

import { captureCoverageFinding } from "./doctor.js";
import type { ReconcileReport } from "@retrace-dev/core";

test("captureCoverageFinding: worst unacknowledged level wins; acknowledged and info-only reports pass", () => {
  const base = (findings: ReconcileReport["commits"][0]["findings"], coverage: ReconcileReport["commits"][0]["coverage"] = { "a.ts": { actors: ["claude-code"], events: 1, loose: false, window: { after: 1, before: 5 } } }): ReconcileReport =>
    ({ format: "retrace-reconcile/1", repo_name: "r", range: { commits: 1, first_seq: 5, last_seq: 5, head_seq: 5 }, commits: [{ sha: "a".repeat(40), short: "a".repeat(12), coverage, findings }], orphans: [], pending: [], seals: [], summary: {} as ReconcileReport["summary"], ok: true });
  assert.equal(captureCoverageFinding(base([])).level, "pass");
  assert.match(captureCoverageFinding(base([])).detail, /1 file covered by claude-code/);
  assert.equal(captureCoverageFinding(base([{ kind: "uncovered", level: "warn", file: "b.ts", detail: "b.ts: no edit event" }])).level, "warn");
  const fail = captureCoverageFinding(base([{ kind: "uncovered", level: "warn", detail: "u" }, { kind: "misattributed", level: "fail", detail: "sealed as codex, but every logged edit is by claude-code" }]));
  assert.equal(fail.level, "fail");
  assert.match(fail.detail, /^misattributed: sealed as codex/);
  const acked = captureCoverageFinding(base([{ kind: "misattributed", level: "info", detail: "x", acknowledged: { seq: 9, id: "evt_9", actor: "jordan@example.com" } }]));
  assert.equal(acked.level, "pass");
  assert.match(acked.detail, /acknowledged by a correction event/);
  assert.equal(captureCoverageFinding(base([{ kind: "non_agent", level: "info", detail: "sealed as human jordan; coverage is not evaluated" }], {})).detail, "sealed as human jordan; coverage is not evaluated");
  assert.equal(captureCoverageFinding({ ...base([]), commits: [] }).level, "fail");
});

class DoctorMemStore implements EventStore {
  events: Event[] = [];
  async head(project: string) { const event = this.events.filter((item) => item.project === project).at(-1); return event ? { seq: event.seq, hash: event.hash } : null; }
  async insert(event: Event) { this.events.push(event); }
  async byIdempotencyKey() { return null; }
  async get(id: string) { return this.events.find((event) => event.id === id) ?? null; }
  async history(query: any) { return pageHistoryNewest(this.events, query); }
  async all(project: string) { return this.events.filter((event) => event.project === project); }
  async projects() { return ["p"]; }
  async createShare(_share: Share) {}
  async getShare() { return null; }
}

test("doctor capture coverage sees a HEAD seal after the signed cache without requesting fresh export", async () => {
  const repo = mkTemp(joinP(tmpD(), "retrace-doctor-tail-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  const g = (...args: string[]) => execGit("git", ["-C", repo, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  g("init", "-q", "-b", "main"); writeF(joinP(repo, "a.ts"), "one\n"); g("add", "a.ts"); g("commit", "-q", "-m", "one");
  const sha = g("rev-parse", "HEAD");
  const store = new DoctorMemStore();
  const edit: EventInput = {
    project: "p", actor: { type: "agent", id: "github-copilot" }, action: "edited",
    artifacts: [{ id: "repo:o/r#a.ts" }],
  };
  await appendEvent(store, edit);
  const issuer = await generateSigningKey();
  const cached = await buildExportBundle(store, { project: "p" }, { signingKey: issuer.privateKey, issuerName: "test" });
  await appendEvent(store, {
    project: "p", actor: { type: "agent", id: "github-copilot" }, action: "committed",
    artifacts: [{ id: `commit:o/r@${sha.slice(0, 12)}`, kind: "commit" }, { id: "repo:o/r#a.ts" }],
    method: { tool: "git", params: { sealed_by: "assert:retrace-git" } },
  });
  await appendEvent(store, {
    project: "p", actor: { type: "agent", id: "github-copilot" }, action: "committed", tags: ["push"],
    artifacts: [{ id: `commit:o/r@${sha.slice(0, 12)}`, kind: "commit" }, { id: "repo:o/r#a.ts" }],
    method: { tool: "github-webhook", params: { sealed_by: "webhook:github" } },
  });
  const savedFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/projects/p/export?cached=1")) return Response.json(cached);
    if (url.endsWith("/projects/p/head?signed=1")) {
      const signed_at = new Date().toISOString();
      const payload = { project: "p", seq: 2, hash: store.events[2].hash, signed_at };
      return Response.json({
        ...payload,
        issuer: { kid: issuer.kid, alg: "Ed25519", public_key: issuer.publicKey },
        signature: await signCanonical(issuer.privateKey, payload),
      });
    }
    if (url.includes("/projects/p/events?")) return Response.json({ events: store.events.slice(1), truncated: false });
    if (url.includes("fresh=1")) return new Response("mock 503", { status: 503 });
    return new Response("not found", { status: 404 });
  };
  try {
    const finding = await remoteCaptureCoverage(
      repo,
      "p",
      new RemoteStore("https://mock.test"),
      { repoName: "o/r", reconcile: { hook_sealed_by: ["assert:retrace-git"] } },
      { gate: true, local: false },
      JSON.stringify(issuer.publicKey),
    );
    assert.equal(finding.level, "pass", finding.detail);
    assert.match(finding.detail, /signed cache through #0; chain-verified tail #1\.\.#2/);
    assert.equal(calls.some((url) => url.includes("fresh=1")), false);
  } finally { globalThis.fetch = savedFetch; }
});

test("gate authorization: unsigned /events cannot turn an unrooted agent seal into a system pass", async () => {
  const store = new DoctorMemStore();
  const commitId = "commit:o/r@abc123def456";
  await appendEvent(store, {
    project: "p", actor: { type: "agent", id: "codex" }, action: "committed",
    artifacts: [{ id: commitId, kind: "commit" }],
  });
  const issuer = await generateSigningKey();
  const cached = await buildExportBundle(store, { project: "p" }, { signingKey: issuer.privateKey, issuerName: "test" });
  const forgedSystem = {
    ...store.events[0],
    actor: { type: "system" as const, id: "retrace-git" },
  };
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/projects/p/export?cached=1")) return Response.json(cached);
    if (url.endsWith("/projects/p/head?signed=1")) {
      const signed_at = new Date().toISOString();
      const payload = { project: "p", seq: 0, hash: store.events[0].hash, signed_at };
      return Response.json({
        ...payload,
        issuer: { kid: issuer.kid, alg: "Ed25519", public_key: issuer.publicKey },
        signature: await signCanonical(issuer.privateKey, payload),
      });
    }
    if (url.includes("/projects/p/events?")) return Response.json({ events: [forgedSystem], truncated: false });
    if (url.includes("/why")) return Response.json([forgedSystem]);
    return new Response("not found", { status: 404 });
  };
  try {
    const { findings } = await gateRemoteAuthorization(commitId, new RemoteStore("https://mock.test"), "p", JSON.stringify(issuer.publicKey));
    const delivery = findings.find((f) => f.label === "HEAD delivery")!;
    const root = findings.find((f) => f.label === "instruct root")!;
    assert.equal(delivery.level, "pass", delivery.detail);
    assert.equal(root.level, "fail", root.detail);
    assert.match(root.detail, /not rooted|no why-chain/);
  } finally { globalThis.fetch = savedFetch; }
});

test("gate authorization: unsigned /events omitting the seal cannot hide a verified HEAD delivery", async () => {
  const store = new DoctorMemStore();
  const commitId = "commit:o/r@fedcba987654";
  await appendEvent(store, {
    project: "p", actor: { type: "human", id: "jordan@example.com" }, action: "instructed",
    artifacts: [{ id: "task:1" }],
  });
  await appendEvent(store, {
    project: "p", actor: { type: "agent", id: "codex" }, action: "committed",
    artifacts: [{ id: commitId, kind: "commit" }],
    caused_by: store.events[0].id,
  });
  const issuer = await generateSigningKey();
  const cached = await buildExportBundle(store, { project: "p" }, { signingKey: issuer.privateKey, issuerName: "test" });
  const savedFetch = globalThis.fetch;
  const eventsCalls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/projects/p/events?")) eventsCalls.push(url);
    if (url.endsWith("/projects/p/export?cached=1")) return Response.json(cached);
    if (url.endsWith("/projects/p/head?signed=1")) {
      const signed_at = new Date().toISOString();
      const payload = { project: "p", seq: 1, hash: store.events[1].hash, signed_at };
      return Response.json({
        ...payload,
        issuer: { kid: issuer.kid, alg: "Ed25519", public_key: issuer.publicKey },
        signature: await signCanonical(issuer.privateKey, payload),
      });
    }
    if (url.includes("/projects/p/events?")) return Response.json({ events: [], truncated: false });
    return new Response("not found", { status: 404 });
  };
  try {
    const { findings } = await gateRemoteAuthorization(commitId, new RemoteStore("https://mock.test"), "p", JSON.stringify(issuer.publicKey));
    const delivery = findings.find((f) => f.label === "HEAD delivery")!;
    assert.equal(delivery.level, "pass", delivery.detail);
    assert.match(delivery.detail, new RegExp(commitId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(eventsCalls.length, 0, "gate authorization must not consult unsigned /events for HEAD delivery");
  } finally { globalThis.fetch = savedFetch; }
});

import { gateDualWitness, hookFindings, objectStoreFinding, parseDoctorArgs as parseArgs2 } from "./doctor.js";
import { execFileSync as execGit } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync as mkTemp, readFileSync, readdirSync, statSync, truncateSync, writeFileSync as writeF } from "node:fs";
import { tmpdir as tmpD } from "node:os";
import { join as joinP } from "node:path";

function objectStoreRepo(): { repo: string; g: (...args: string[]) => string; commit: (content: string) => string; objectPath: (sha: string) => string } {
  const repo = mkTemp(joinP(tmpD(), "retrace-object-store-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  const g = (...args: string[]) => execGit("git", ["-C", repo, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  g("init", "-q", "-b", "main");
  let n = 0;
  const commit = (content: string) => {
    writeF(joinP(repo, "object-store.txt"), content);
    g("add", "object-store.txt");
    g("commit", "-q", "-m", `commit ${++n}`);
    return g("rev-parse", "HEAD");
  };
  return { repo, g, commit, objectPath: (sha) => joinP(repo, ".git", "objects", sha.slice(0, 2), sha.slice(2)) };
}

function objectStoreSnapshot(root: string, relative = ""): Array<[string, string]> {
  const dir = joinP(root, relative);
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = joinP(relative, entry.name);
    return entry.isDirectory() ? objectStoreSnapshot(root, path) : [[path, readFileSync(joinP(root, path)).toString("hex")]];
  });
}

test("objectStoreFinding: rev-parse HEAD can succeed while its zero-byte loose commit object fails integrity", () => {
  const fixture = objectStoreRepo();
  const sha = fixture.commit("one\n");
  const path = fixture.objectPath(sha);
  const original = readFileSync(path);
  chmodSync(path, 0o600);
  truncateSync(path, 0);

  assert.equal(fixture.g("rev-parse", "HEAD"), sha);
  const failed = objectStoreFinding(fixture.repo);
  assert.equal(failed.level, "fail");
  assert.match(failed.detail, /1 empty loose object/);
  assert.match(failed.detail, /HEAD.*empty/i);
  assert.match(failed.detail, /rev-parse.*not proof/i);
  assert.match(failed.detail, /do not reset\/pull/i);
  assert.doesNotMatch(failed.detail, /WSL|outage|2026/i);
  assert.equal(statSync(path).size, 0, "doctor must not repair or otherwise mutate the empty object");

  writeF(path, original);
  assert.equal(objectStoreFinding(fixture.repo).level, "pass");
});

test("objectStoreFinding: readable HEAD still fails when origin/main points at a zero-byte object", () => {
  const fixture = objectStoreRepo();
  const originMain = fixture.commit("origin\n");
  fixture.g("update-ref", "refs/remotes/origin/main", originMain);
  const head = fixture.commit("head\n");
  const originPath = fixture.objectPath(originMain);
  chmodSync(originPath, 0o600);
  truncateSync(originPath, 0);

  assert.equal(fixture.g("rev-parse", "origin/main"), originMain);
  assert.equal(fixture.g("cat-file", "-t", head), "commit");
  const finding = objectStoreFinding(fixture.repo);
  assert.equal(finding.level, "fail");
  assert.match(finding.detail, /origin\/main.*empty/i);
  assert.match(finding.detail, /git fetch origin/);
  assert.match(finding.detail, /healthy clone/);
  assert.match(finding.detail, /git cat-file -t origin\/main.*commit/);
  assert.equal(statSync(originPath).size, 0, "doctor must leave the damaged origin/main object untouched");
});

test("objectStoreFinding: an origin/main ref pointing to a missing object fails without mutation", () => {
  const fixture = objectStoreRepo();
  fixture.commit("healthy head\n");
  const ref = joinP(fixture.repo, ".git", "refs", "remotes", "origin", "main");
  const missingSha = "f".repeat(40);
  mkdirSync(joinP(fixture.repo, ".git", "refs", "remotes", "origin"), { recursive: true });
  writeF(ref, `${missingSha}\n`);
  const refBefore = readFileSync(ref, "utf8");
  const objectsDir = joinP(fixture.repo, ".git", "objects");
  const objectsBefore = objectStoreSnapshot(objectsDir);

  assert.equal(fixture.g("rev-parse", "origin/main"), missingSha);
  assert.equal(fixture.g("cat-file", "-t", "HEAD"), "commit");
  const finding = objectStoreFinding(fixture.repo);

  assert.equal(finding.level, "fail");
  assert.match(finding.detail, /origin\/main ref lookup failed/i);
  assert.match(finding.detail, /origin\/main is not a readable commit/i);
  assert.equal(readFileSync(ref, "utf8"), refBefore, "doctor must not modify the corrupt ref");
  assert.deepEqual(objectStoreSnapshot(objectsDir), objectsBefore, "doctor must not modify the object store");
});

test("objectStoreFinding: clean repo without origin/main passes", () => {
  const fixture = objectStoreRepo();
  fixture.commit("clean\n");
  assert.equal(objectStoreFinding(fixture.repo).level, "pass");
});

test("objectStoreFinding: packed-only commit objects pass without loose files", () => {
  const fixture = objectStoreRepo();
  const sha = fixture.commit("packed\n");
  const loose = fixture.objectPath(sha);
  fixture.g("gc", "--prune=now");
  assert.equal(existsSync(loose), false);
  assert.equal(fixture.g("cat-file", "-t", "HEAD"), "commit");
  assert.equal(objectStoreFinding(fixture.repo).level, "pass");
});

test("hookFindings: linked worktrees use hooks from the common Git directory", () => {
  const fixture = objectStoreRepo();
  fixture.commit("hooks\n");
  writeF(joinP(fixture.repo, ".git", "hooks", "post-commit"), "#!/bin/sh\n# retrace-git hook\n");
  writeF(joinP(fixture.repo, ".git", "hooks", "post-merge"), "#!/bin/sh\n# retrace-git hook\n");
  const parent = mkTemp(joinP(tmpD(), "retrace-hook-worktree-"));
  const worktree = joinP(parent, "linked");
  fixture.g("worktree", "add", "-q", "-b", "feature", worktree);

  const findings = hookFindings(worktree);
  assert.deepEqual(findings.map((finding) => finding.level), ["pass", "pass"]);
  assert.ok(findings.every((finding) => finding.detail.startsWith(joinP(fixture.repo, ".git", "hooks"))));
});

test("gate dual witness never infers leniency from the ref layout: a detached, pushed sha with no refs/remotes branch containing HEAD still fails on a lone producer; --local is explicit and refused under CI", () => {
  // a checkout the way actions/checkout does it for pull_request: detached at an explicit sha, no remote-tracking branch contains it
  const origin = mkTemp(joinP(tmpD(), "retrace-origin-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  const g = (repo: string, ...a: string[]) => execGit("git", ["-C", repo, ...a], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  g(origin, "init", "-q", "-b", "main"); writeF(joinP(origin, "a"), "1"); g(origin, "add", "a"); g(origin, "commit", "-q", "-m", "one");
  g(origin, "checkout", "-q", "-b", "feature"); writeF(joinP(origin, "a"), "2"); g(origin, "commit", "-q", "-am", "pr head"); const head = g(origin, "rev-parse", "HEAD");
  const work = mkTemp(joinP(tmpD(), "retrace-work-"));
  g(work, "init", "-q", "-b", "main"); g(work, "remote", "add", "origin", origin);
  g(work, "fetch", "-q", "origin", head); g(work, "checkout", "-q", "--detach", head); // exactly what the gate does with pull_request.head.sha
  assert.equal(g(work, "branch", "-r", "--contains", "HEAD"), "", "no remote-tracking branch contains HEAD, yet the commit IS pushed");
  // the decision must not look at that at all
  assert.deepEqual(gateDualWitness({ gate: true, local: false }, {}), {});
  assert.deepEqual(gateDualWitness({ gate: true, local: false }, { GITHUB_ACTIONS: "true" }), {});
  assert.deepEqual(gateDualWitness({ gate: true, local: true }, {}), { dualWitness: "warn" });
  assert.throws(() => gateDualWitness({ gate: true, local: true }, { GITHUB_ACTIONS: "true" }), /not allowed under CI/);
  assert.throws(() => gateDualWitness({ gate: true, local: true }, { CI: "1" }), /not allowed under CI/);
  assert.equal(parseArgs2(["doctor", "--gate", "--local"]).local, true);
  assert.equal(parseArgs2(["doctor", "--gate"]).local, false);
});
