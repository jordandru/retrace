/**
 * NOOA audit durable fix, step 2: parseJsonRejectDuplicateKeys builds each string in one step instead of one character at a
 * time. Equivalence is the spec: for every input, the value must pass assert.deepStrictEqual against today's value, with the
 * same key order, or the call must throw the same error class with the same message. The reference below is
 * parseJsonRejectDuplicateKeys as it stood on main at e4063935, copied verbatim except for its name. Synthetic inputs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyError, parseJsonRejectDuplicateKeys } from "./policy.js";

// ---- Reference: main at e4063935, packages/core/src/policy.ts lines 215–319 ----

function referenceParseJsonRejectDuplicateKeys(raw: string): unknown {
  const s = raw;
  let i = 0;
  const skipWs = () => { while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++; };
  const fail = (m: string): never => { throw new PolicyError(400, m); };
  const parseString = (): string => {
    if (s[i] !== "\"") fail("invalid JSON string");
    i++;
    let out = "";
    while (i < s.length) {
      const c = s[i]!;
      if (c === "\"") { i++; return out; }
      if (c === "\\") {
        const e = s[++i];
        i++;
        if (e === "\"" || e === "\\" || e === "/") out += e;
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "n") out += "\n";
        else if (e === "r") out += "\r";
        else if (e === "t") out += "\t";
        else if (e === "u") {
          const hex = s.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else fail("invalid escape");
      } else {
        if (c.charCodeAt(0) < 0x20) fail("unescaped control character in JSON string");
        out += c;
        i++;
      }
    }
    return fail("unterminated string");
  };
  const parseNumber = (): number => {
    const start = i;
    if (s[i] === "-") i++;
    if (s[i] === "0") i++;
    else if (s[i] && s[i]! >= "1" && s[i]! <= "9") { while (s[i] && s[i]! >= "0" && s[i]! <= "9") i++; }
    else fail("invalid number");
    if (s[i] === ".") { i++; if (!(s[i] && s[i]! >= "0" && s[i]! <= "9")) fail("invalid number"); while (s[i] && s[i]! >= "0" && s[i]! <= "9") i++; }
    if (s[i] === "e" || s[i] === "E") {
      i++;
      if (s[i] === "+" || s[i] === "-") i++;
      if (!(s[i] && s[i]! >= "0" && s[i]! <= "9")) fail("invalid number");
      while (s[i] && s[i]! >= "0" && s[i]! <= "9") i++;
    }
    const n = Number(s.slice(start, i));
    if (!Number.isFinite(n)) fail("invalid number");
    return n;
  };
  const parseValue = (): unknown => {
    skipWs();
    const c = s[i];
    if (c === "{") {
      i++;
      skipWs();
      const obj = Object.create(null) as Record<string, unknown>;
      const seen = new Set<string>();
      if (s[i] === "}") { i++; return obj; }
      while (i < s.length) {
        skipWs();
        const key = parseString();
        if (key === "__proto__" || key === "constructor" || key === "prototype")
          fail(`forbidden object key ${JSON.stringify(key)}`);
        if (seen.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
        seen.add(key);
        skipWs();
        if (s[i] !== ":") fail("expected ':'");
        i++;
        obj[key] = parseValue();
        skipWs();
        if (s[i] === "}") { i++; return obj; }
        if (s[i] !== ",") fail("expected ',' or '}'");
        i++;
      }
      fail("unterminated object");
    }
    if (c === "[") {
      i++;
      skipWs();
      const arr: unknown[] = [];
      if (s[i] === "]") { i++; return arr; }
      while (i < s.length) {
        arr.push(parseValue());
        skipWs();
        if (s[i] === "]") { i++; return arr; }
        if (s[i] !== ",") fail("expected ',' or ']'");
        i++;
      }
      fail("unterminated array");
    }
    if (c === "\"") return parseString();
    if (c === "t" && s.slice(i, i + 4) === "true") { i += 4; return true; }
    if (c === "f" && s.slice(i, i + 5) === "false") { i += 5; return false; }
    if (c === "n" && s.slice(i, i + 4) === "null") { i += 4; return null; }
    if (c === "-" || (c && c >= "0" && c <= "9")) return parseNumber();
    fail("invalid JSON");
  };
  const value = parseValue();
  skipWs();
  if (i !== s.length) fail("trailing data after JSON value");
  return value;
}

// ---- Comparison ----

/** Object.keys order at every depth, and whether each object has a null prototype. deepStrictEqual checks neither order. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shape);
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v);
    return { nullProto: Object.getPrototypeOf(v) === null, keys, values: keys.map((k) => shape((v as Record<string, unknown>)[k])) };
  }
  return typeof v;
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

function run(parse: (raw: string) => unknown, raw: string): Outcome {
  try { return { ok: true, value: parse(raw) }; } catch (error) { return { ok: false, error }; }
}

/** Asserts that the new parser and the reference agree on `raw`. Returns whether the input parsed. */
function assertSame(raw: string, label: string): boolean {
  const expected = run(referenceParseJsonRejectDuplicateKeys, raw);
  const actual = run(parseJsonRejectDuplicateKeys, raw);
  if (expected.ok) {
    assert.ok(actual.ok, `${label}: reference parsed, new threw ${actual.ok ? "" : String(actual.error)} on ${JSON.stringify(raw.slice(0, 200))}`);
    assert.deepStrictEqual(actual.value, expected.value, `${label}: value`);
    assert.deepStrictEqual(shape(actual.value), shape(expected.value), `${label}: key order and prototypes`);
    return true;
  }
  assert.ok(!actual.ok, `${label}: reference threw ${String(expected.error)}, new parsed ${JSON.stringify(raw.slice(0, 200))}`);
  const e = expected.error as Error;
  const a = actual.error as Error;
  assert.equal(a.constructor, e.constructor, `${label}: error class`);
  assert.equal(a.message, e.message, `${label}: error message on ${JSON.stringify(raw.slice(0, 200))}`);
  if (e instanceof PolicyError) assert.equal((a as PolicyError).status, e.status, `${label}: status`);
  return false;
}

// ---- Seeded generator ----

type Random = () => number;

function xorshift(seed: number): Random {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

const ESCAPES = ["\\\"", "\\\\", "\\/", "\\b", "\\f", "\\n", "\\r", "\\t"];
const RAW_PIECES = ["a", "Z", "0", " ", "~", "\u007f", "é", "ü", "中", "\u2028", "😀", "𝄞", "\ud800", "\udfff", "'", "{", "]", ":", ","];

function hex4(r: (n: number) => number, lo: number, hi: number): string {
  const n = lo + r(hi - lo + 1);
  const h = n.toString(16).padStart(4, "0");
  return r(2) ? h.toUpperCase() : h;
}

/** One piece of a string literal's body: a raw character, an escape, or a \u escape (lone or paired surrogates included). */
function piece(r: (n: number) => number): string {
  const roll = r(10);
  if (roll < 5) return RAW_PIECES[r(RAW_PIECES.length)]!;
  if (roll < 7) return ESCAPES[r(ESCAPES.length)]!;
  if (roll === 7) return "\\u" + hex4(r, 0, 0xffff);
  if (roll === 8) return "\\u" + hex4(r, r(2) ? 0xd800 : 0xdc00, r(2) ? 0xdbff : 0xdfff);
  return "\\u" + hex4(r, 0xd800, 0xdbff) + "\\u" + hex4(r, 0xdc00, 0xdfff);
}

/** A string literal body of about n pieces. Lengths 0, 1, 12, 13 and 14 sit on either side of V8's 13-character cons threshold. */
function stringBody(r: (n: number) => number): string {
  const lengths = [0, 1, 2, 12, 13, 14, 5, 40];
  const n = r(200) === 0 ? 2000 + r(20000) : lengths[r(lengths.length)]!;
  let out = "";
  for (let k = 0; k < n; k++) out += r(3) ? String.fromCharCode(0x61 + r(26)) : piece(r);
  return out;
}

function numberLiteral(r: (n: number) => number): string {
  const forms = ["0", "-0", "1", "-1", "123", "0.5", "-0.0", "1e5", "1E+2", "2e-3", "-1.25e-7", "9007199254740993", "1e400", "-1e400", "1e-400", "4.9e-324"];
  if (r(3)) return forms[r(forms.length)]!;
  return (r(2) ? "-" : "") + String(r(100000)) + (r(2) ? "." + String(r(1000)) : "") + (r(3) === 0 ? (r(2) ? "e" : "E") + ["", "+", "-"][r(3)] + String(r(30)) : "");
}

function ws(r: (n: number) => number): string {
  if (r(3)) return "";
  return [" ", "\t", "\n", "\r", "  ", "\r\n"][r(6)]!;
}

/** Keys: plain, colliding after escape decoding ("a" and "\u0061"), or forbidden keys spelled with escapes. */
function key(r: (n: number) => number, used: string[]): string {
  const roll = r(40);
  if (roll === 0) return ["__proto__", "constructor", "prototype", "__\\u0070roto__", "\\u0063onstructor", "prot\\u006ftype"][r(6)]!;
  if (roll === 1 && used.length) return used[r(used.length)]!;
  if (roll === 2) return ["a", "\\u0061", "\\u0041", "\\/"][r(4)]!;
  if (roll < 8) return stringBody(r);
  return String.fromCharCode(0x61 + r(26)) + (r(2) ? String(r(10)) : "");
}

function value(r: (n: number) => number, depth: number): string {
  const roll = depth > 3 ? 4 + r(5) : r(9);
  if (roll < 2) {
    const n = r(5);
    const used: string[] = [];
    const members: string[] = [];
    for (let k = 0; k < n; k++) {
      const k1 = key(r, used);
      used.push(k1);
      members.push(ws(r) + "\"" + k1 + "\"" + ws(r) + ":" + value(r, depth + 1) + ws(r));
    }
    return ws(r) + "{" + (n ? members.join(",") : ws(r)) + "}" + ws(r);
  }
  if (roll < 4) {
    const n = r(5);
    const items: string[] = [];
    for (let k = 0; k < n; k++) items.push(value(r, depth + 1));
    return ws(r) + "[" + (n ? items.join(",") : ws(r)) + "]" + ws(r);
  }
  if (roll < 6) return ws(r) + "\"" + stringBody(r) + "\"" + ws(r);
  if (roll < 8) return ws(r) + numberLiteral(r) + ws(r);
  return ws(r) + ["true", "false", "null"][r(3)]! + ws(r);
}

const MUTATION_CHARS = ["\"", "\\", "{", "}", "[", "]", ",", ":", "0", "-", "1", "e", "E", ".", "+", "t", "f", "n", "u", " ", "\n", "\u0000", "\u001f", "a", "x", "G", "\ud800"];

test("durable fix step 2: the parser equals main's on 20,000+ seeded valid and invalid inputs", () => {
  const random = xorshift(0x15e0f2);
  const r = (n: number) => random() % n;
  let valid = 0;
  let invalid = 0;
  const count = (ok: boolean) => { if (ok) valid++; else invalid++; };
  for (let k = 0; k < 6000; k++) {
    const doc = value(r, 0);
    count(assertSame(doc, `doc ${k}`));
    // Single-character mutations: replace, insert or delete one code unit.
    for (let m = 0; m < 3 && doc.length; m++) {
      const at = r(doc.length);
      const c = MUTATION_CHARS[r(MUTATION_CHARS.length)]!;
      const kind = r(3);
      const mutated = kind === 0 ? doc.slice(0, at) + c + doc.slice(at + 1) : kind === 1 ? doc.slice(0, at) + c + doc.slice(at) : doc.slice(0, at) + doc.slice(at + 1);
      count(assertSame(mutated, `doc ${k} mutation ${m}`));
    }
    // Every prefix of the shorter documents: unterminated strings, objects and arrays, and cut escapes and numbers.
    if (k % 20 === 0 && doc.length < 400) for (let p = 0; p < doc.length; p++) count(assertSame(doc.slice(0, p), `doc ${k} prefix ${p}`));
  }
  // Targeted invalid shapes.
  const bad = [
    "\"\\x\"", "\"\\u12G4\"", "\"\\u12\"", "\"\\u\"", "\"\\", "\"abc\\", "\"\\u00e9", "\"a\\\"", "{\"a\\q\":1}",
    ...Array.from({ length: 32 }, (_, c) => "\"a" + String.fromCharCode(c) + "b\""),
    "01", "-01", "00", "-", "1.", "1.e3", ".5", "1e", "1e+", "+1", "0x10", "Infinity", "NaN",
    "{} x", "1 2", "[]]", "{}}", "\"a\"\"b\"", "nul", "tru", "fals", "truex",
    "\"abc", "{", "{\"a\"", "{\"a\":", "{\"a\":1", "{\"a\":1,", "[", "[1", "[1,", "[1 2]", "{\"a\" 1}", "{\"a\":1 \"b\":2}", "{a:1}", "{,}", "[,]",
    "", " ", "\uFEFF{}", "\u00a0{}",
  ];
  for (const raw of bad) count(assertSame(raw, `bad ${JSON.stringify(raw)}`));
  assert.ok(valid + invalid >= 20_000, `only ${valid + invalid} inputs`);
  assert.ok(valid >= 2000 && invalid >= 10_000, `valid ${valid}, invalid ${invalid}`);
  console.log(`# ${valid} valid and ${invalid} invalid inputs`);
});

// ---- Hand-written cases, so a failure names its case ----

function assertThrowsSame(raw: string, message: string) {
  assert.throws(() => parseJsonRejectDuplicateKeys(raw), (e: unknown) => e instanceof PolicyError && e.status === 400 && e.message === message, `${JSON.stringify(raw)}: ${message}`);
  assert.equal(assertSame(raw, JSON.stringify(raw)), false);
}

test("durable fix step 2: each error message, as main gives it", () => {
  assertThrowsSame("{a:1}", "invalid JSON string");
  assertThrowsSame("\"\\u12G4\"", "invalid \\u escape");
  assertThrowsSame("\"\\u12\"", "invalid \\u escape");
  assertThrowsSame("\"\\x\"", "invalid escape");
  assertThrowsSame("\"abc\\", "invalid escape");
  assertThrowsSame("\"a\nb\"", "unescaped control character in JSON string");
  assertThrowsSame("\"a\u0000\\x\"", "unescaped control character in JSON string");
  assertThrowsSame("\"a\\x\u0000\"", "invalid escape");
  assertThrowsSame("\"abc", "unterminated string");
  assertThrowsSame("\"a\\\"", "unterminated string");
  assertThrowsSame("\"\\u0041", "unterminated string");
  assertThrowsSame("-", "invalid number");
  assertThrowsSame("1.", "invalid number");
  assertThrowsSame("1e+", "invalid number");
  assertThrowsSame("1e400", "invalid number");
  assertThrowsSame("{\"__proto__\":1}", "forbidden object key \"__proto__\"");
  assertThrowsSame("{\"__\\u0070roto__\":1}", "forbidden object key \"__proto__\"");
  assertThrowsSame("{\"\\u0063onstructor\":1}", "forbidden object key \"constructor\"");
  assertThrowsSame("{\"prot\\u006ftype\":1}", "forbidden object key \"prototype\"");
  assertThrowsSame("{\"a\":1,\"\\u0061\":2}", "duplicate object key \"a\"");
  assertThrowsSame("{\"x\":{\"b\":1,\"b\":2}}", "duplicate object key \"b\"");
  assertThrowsSame("{\"a\" 1}", "expected ':'");
  assertThrowsSame("{\"a\":1 \"b\":2}", "expected ',' or '}'");
  assertThrowsSame("{\"a\":1,", "unterminated object");
  assertThrowsSame("[1 2]", "expected ',' or ']'");
  assertThrowsSame("[1,", "unterminated array");
  assertThrowsSame("nul", "invalid JSON");
  assertThrowsSame("", "invalid JSON");
  assertThrowsSame("{} x", "trailing data after JSON value");
  assertThrowsSame("01", "trailing data after JSON value");
});

test("durable fix step 2: values keep null prototypes, key order, -0 and every decoded code unit", () => {
  const raw = "{\"z\":1,\"a\":{\"m\":[],\"b\":{}},\"n\":-0,\"s\":\"\\ud83d\\ude00 \\ud800 \\udfff \u{1F600} \\\" \\\\ \\/ \\b \\f \\n \\r \\t \\u00e9\"}";
  const v = parseJsonRejectDuplicateKeys(raw) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(v), null);
  assert.equal(Object.getPrototypeOf(v.a), null);
  assert.deepEqual(Object.keys(v), ["z", "a", "n", "s"]);
  assert.ok(Object.is(v.n, -0));
  assert.equal(v.s, "\u{1F600} \ud800 \udfff \u{1F600} \" \\ / \b \f \n \r \t é");
  assert.equal(assertSame(raw, "mixed"), true);
  for (const n of [0, 1, 12, 13, 14, 100_000]) {
    const body = "x".repeat(n);
    assert.equal(parseJsonRejectDuplicateKeys(`"${body}"`), body);
    assert.equal(parseJsonRejectDuplicateKeys(`["${body}\\n${body}"]`) instanceof Array, true);
    assert.equal(assertSame(`{"k${body}":"${body}\\u0041${body}"}`, `length ${n}`), true);
  }
});
