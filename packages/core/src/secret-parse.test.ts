// #232: no part of a secret's value may reach a log or an error that can reach one. V8's JSON.parse message quotes the
// start of its input and zod quotes the received value for some issue types, so each secret parse is tried here with a
// non-JSON value and with JSON that fails the schema in a way zod would quote. Every value below is made up.
import assert from "node:assert/strict";
import test from "node:test";
import { parseCredentials, parseSigningKey, signCanonical } from "./index.js";

const NOT_JSON = "tok_FAKEqzwxVBNM7531";
/** Valid JSON, valid token length; `trust` and `actor.type` are invalid enum values, which zod's messages quote. */
const BAD_ENUMS = JSON.stringify([
  { token: "tok_FAKEplmoKIJN8642", actor: { type: "robot_FAKEuyhg", id: "seat_FAKEtrfd" }, trust: "tok_FAKEqwrtWSXE9753" },
]);

function stringLeaves(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(stringLeaves);
  if (v && typeof v === "object") return Object.values(v).flatMap(stringLeaves);
  return [];
}

/** The text carries no 4-character run of any input value. For a non-JSON input the value is the whole input; for JSON
 *  it is every string value — the keys are the schema's own names, which the issue paths name on purpose. */
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

function thrown(fn: () => unknown): Error {
  try { fn(); } catch (e) { return e as Error; }
  assert.fail("expected a throw");
}

test("#232 parseCredentials: a non-JSON secret throws a message that names no part of it", () => {
  const e = thrown(() => parseCredentials(NOT_JSON));
  assert.match(e.message, /^RETRACE_CREDENTIALS is malformed: not JSON$/);
  assertNoFragment(`${e.message}\n${e.stack}\n${String(e)}`, NOT_JSON);
  assert.equal((e as { cause?: unknown }).cause, undefined);
});

test("#232 parseCredentials: a schema failure names issue paths and codes, never a received value", () => {
  const e = thrown(() => parseCredentials(BAD_ENUMS));
  assert.match(e.message, /^RETRACE_CREDENTIALS is malformed: schema issues /);
  assert.match(e.message, /\[0\]\.actor\.type invalid_enum_value/);
  assert.match(e.message, /\[0\]\.trust invalid_enum_value/);
  assertNoFragment(`${e.message}\n${e.stack}\n${String(e)}`, BAD_ENUMS);
  assert.equal((e as { cause?: unknown }).cause, undefined);
});

test("#232 parseCredentials: the error names the secret it was given", () => {
  assert.match(thrown(() => parseCredentials(NOT_JSON, "RETRACE_CREDENTIALS_EXTRA")).message, /^RETRACE_CREDENTIALS_EXTRA is malformed: not JSON$/);
});

test("#232 parseSigningKey: a non-JSON secret throws the fixed message", () => {
  const e = thrown(() => parseSigningKey(NOT_JSON));
  assert.equal(e.message, "RETRACE_SIGNING_KEY is not a JWK (JSON or base64 JSON)");
  assertNoFragment(`${e.message}\n${e.stack}`, NOT_JSON);
});

test("#232 parseSigningKey: JSON that is not an Ed25519 JWK parses as before and fails at signing without quoting it", async () => {
  // parseSigningKey has no schema: it returns any JSON unchanged (behaviour kept). The bad key fails where it is used;
  // this is Node's WebCrypto message, which the test can measure, not workerd's.
  const raw = JSON.stringify({ kty: "tok_FAKEktyQAZX4826", crv: "tok_FAKEcrvMNBV1593", d: "tok_FAKEdddPOIU1357", x: "tok_FAKExxxLKJH2468" });
  const key = parseSigningKey(raw);
  assert.deepEqual(key, JSON.parse(raw));
  const e = await signCanonical(key as JsonWebKey, { a: 1 }).then(() => assert.fail("expected a rejection"), (err: Error) => err);
  assertNoFragment(`${e.message}\n${e.stack}`, raw);
});
