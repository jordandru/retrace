import assert from "node:assert/strict";
import test from "node:test";
import { allCredentials } from "./index.js";

const cred = (id: string, token: string) => ({ token, actor: { type: "agent", id }, projects: [id] });
const arr = (...c: object[]) => JSON.stringify(c);

test("allCredentials: merges the overflow secret after the main one", () => {
  const env = {
    RETRACE_CREDENTIALS: arr(cred("claude-code", "tok-claude-code-000000000000")),
    RETRACE_CREDENTIALS_EXTRA: arr(cred("nooa", "tok-nooa-0000000000000000000")),
  } as never;
  const all = allCredentials(env);
  assert.deepEqual(all.map((c) => c.actor.id), ["claude-code", "nooa"]);
});

test("allCredentials: no overflow secret returns the main set unchanged", () => {
  const env = { RETRACE_CREDENTIALS: arr(cred("claude-code", "tok-claude-code-000000000000")) } as never;
  assert.deepEqual(allCredentials(env).map((c) => c.actor.id), ["claude-code"]);
});

test("allCredentials: a malformed overflow is ignored, never masking the main set", () => {
  const env = {
    RETRACE_CREDENTIALS: arr(cred("claude-code", "tok-claude-code-000000000000")),
    RETRACE_CREDENTIALS_EXTRA: "{ not valid json",
  } as never;
  // main auth survives a bad experimental credential — the isolation guarantee
  assert.deepEqual(allCredentials(env).map((c) => c.actor.id), ["claude-code"]);
});

test("allCredentials: a malformed MAIN secret still throws (fail-loud primary)", () => {
  const env = { RETRACE_CREDENTIALS: "{ not valid json" } as never;
  assert.throws(() => allCredentials(env));
});
