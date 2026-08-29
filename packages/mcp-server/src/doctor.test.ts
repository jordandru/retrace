import { test } from "node:test";
import assert from "node:assert/strict";
import { Credential, schemaSurface } from "@retrace/core";
import { credentialAuthorization, missingSchema } from "./doctor.js";

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
