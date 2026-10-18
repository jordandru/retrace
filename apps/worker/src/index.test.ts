import assert from "node:assert/strict";
import test from "node:test";
import { parseSigningKey } from "@retrace-dev/core";
import { createStreamingEd25519Signer } from "./ed25519-stream.js";
import { allCredentials } from "./index.js";
import { authenticateRemoteMcp } from "./mcp.js";

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

// #232: no part of a secret's value in a log line or a thrown error. Each secret parse gets a non-JSON value and JSON that
// fails the schema in a way zod's messages would quote (invalid enum values). Every value is made up.
const NOT_JSON = "tok_FAKEqzwxVBNM7531";
const BAD_ENUMS = JSON.stringify([
  { token: "tok_FAKEplmoKIJN8642", actor: { type: "robot_FAKEuyhg", id: "seat_FAKEtrfd" }, trust: "tok_FAKEqwrtWSXE9753" },
]);
const MAIN = arr(cred("claude-code", "tok-claude-code-000000000000"));

function stringLeaves(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(stringLeaves);
  if (v && typeof v === "object") return Object.values(v).flatMap(stringLeaves);
  return [];
}

/** No 4-character run of any input value: the whole input when it is not JSON, every string value when it is (the keys
 *  are the schema's own names, which the issue paths name on purpose). */
function assertNoFragment(text: string, raw: string): void {
  let values: string[];
  try { values = stringLeaves(JSON.parse(raw)); } catch { values = [raw]; }
  for (const value of values) {
    for (let i = 0; i + 4 <= value.length; i++) {
      const gram = value.slice(i, i + 4);
      assert.ok(!text.includes(gram), `"${gram}" of an input value appears in: ${text}`);
    }
  }
}

function captureConsoleError<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    return { result: fn(), lines };
  } finally {
    console.error = original;
  }
}

function thrown(fn: () => unknown): Error {
  try { fn(); } catch (e) { return e as Error; }
  assert.fail("expected a throw");
}

for (const [label, raw, expected] of [
  ["non-JSON", NOT_JSON, /^RETRACE_CREDENTIALS_EXTRA ignored \(malformed\): not JSON$/],
  ["schema-invalid", BAD_ENUMS, /^RETRACE_CREDENTIALS_EXTRA ignored \(malformed\): schema issues \[0\]\.actor\.type invalid_enum_value, \[0\]\.trust invalid_enum_value$/],
] as const) {
  test(`#232 allCredentials: a ${label} overflow is still ignored and logged, naming no part of it`, () => {
    const { result, lines } = captureConsoleError(() => allCredentials({ RETRACE_CREDENTIALS: MAIN, RETRACE_CREDENTIALS_EXTRA: raw } as never));
    assert.deepEqual(result.map((c) => c.actor.id), ["claude-code"]);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, expected);
    assertNoFragment(lines[0]!, raw);
  });

  test(`#232 allCredentials: a ${label} MAIN secret still throws, naming no part of it`, () => {
    const { lines } = captureConsoleError(() => {
      const e = thrown(() => allCredentials({ RETRACE_CREDENTIALS: raw } as never));
      assert.match(e.message, /^RETRACE_CREDENTIALS is malformed: (not JSON|schema issues )/);
      assertNoFragment(`${e.message}\n${e.stack}\n${String(e)}`, raw);
    });
    assert.deepEqual(lines, []);
  });

  test(`#232 authenticateRemoteMcp: a ${label} RETRACE_CREDENTIALS still throws, naming no part of it`, async () => {
    const req = new Request("https://example.test/mcp", { headers: { authorization: "Bearer tok-claude-code-000000000000" } });
    const e = await authenticateRemoteMcp(req, raw).then(() => assert.fail("expected a rejection"), (err: Error) => err);
    assert.match(e.message, /^RETRACE_CREDENTIALS is malformed: /);
    assertNoFragment(`${e.message}\n${e.stack}`, raw);
  });
}

test("#232 allCredentials: a valid overflow logs nothing", () => {
  const { result, lines } = captureConsoleError(() => allCredentials({ RETRACE_CREDENTIALS: MAIN, RETRACE_CREDENTIALS_EXTRA: arr(cred("nooa", "tok-nooa-0000000000000000000")) } as never));
  assert.deepEqual(result.map((c) => c.actor.id), ["claude-code", "nooa"]);
  assert.deepEqual(lines, []);
});

test("#232 RETRACE_SIGNING_KEY: a non-JSON key throws the fixed message", () => {
  const e = thrown(() => parseSigningKey(NOT_JSON));
  assert.equal(e.message, "RETRACE_SIGNING_KEY is not a JWK (JSON or base64 JSON)");
  assertNoFragment(`${e.message}\n${e.stack}`, NOT_JSON);
});

test("#232 RETRACE_SIGNING_KEY: JSON that is not an Ed25519 JWK fails at the cron's signer, naming no part of it", () => {
  // parseSigningKey has no schema and returns the JSON unchanged (behaviour kept); the scheduled export signer is where a
  // bad key fails, and index.ts logs and records that message.
  for (const jwk of [
    { kty: "tok_FAKEktyQAZX4826", crv: "tok_FAKEcrvMNBV1593", d: "tok_FAKEdddPOIU1357", x: "tok_FAKExxxLKJH2468" },
    { kty: "OKP", crv: "Ed25519", d: "tok_FAKEdddPOIU1357", x: "A".repeat(43) },
  ]) {
    const raw = JSON.stringify(jwk);
    const key = parseSigningKey(raw);
    assert.deepEqual(key, jwk);
    const e = thrown(() => createStreamingEd25519Signer(key as JsonWebKey));
    assert.match(e.message, /^signing key: /);
    // The algorithm's public names ("OKP", "Ed25519") are not key material; every other value is checked.
    const material = Object.values(jwk).filter((v) => v !== "OKP" && v !== "Ed25519");
    assertNoFragment(`${e.message}\n${e.stack}`, JSON.stringify(material));
  }
});
