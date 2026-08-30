import { test } from "node:test";
import assert from "node:assert/strict";
import { Credential, Event, schemaSurface } from "@retrace-dev/core";
import { attributionFinding, credentialAuthorization, headDelivery, instructRootFinding, missingSchema, parseDoctorArgs, pinSessionFinding, sealedCommitEvent, sealedLooksAgent } from "./doctor.js";

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
  assert.deepEqual(parseDoctorArgs(["doctor", "--gate"]), { command: "doctor", gate: true, json: false, repo: undefined });
  assert.deepEqual(parseDoctorArgs(["--gate", "/tmp/repo"]), { command: "doctor", gate: true, json: false, repo: "/tmp/repo" });
  assert.deepEqual(parseDoctorArgs(["status", "retrace", "--json"]), { command: "status", gate: false, json: true, statusProject: "retrace" });
  assert.equal(parseDoctorArgs(["doctor", "."]).gate, false);
});

test("doctor: missing HEAD delivery is warn locally and fail in --gate", () => {
  assert.equal(headDelivery(false, "commit:retrace@abc123def456", true).level, "pass");
  assert.equal(headDelivery(false, "commit:retrace@abc123def456", false).level, "warn");
  assert.equal(headDelivery(true, "commit:retrace@abc123def456", false).level, "fail");
  assert.equal(headDelivery(true, undefined, false).level, "fail");
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
