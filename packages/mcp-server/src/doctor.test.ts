import { test } from "node:test";
import assert from "node:assert/strict";
import { Credential, Event, schemaSurface } from "@retrace-dev/core";
import { credentialAuthorization, headDelivery, instructRootFinding, missingSchema, parseDoctorArgs } from "./doctor.js";

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
