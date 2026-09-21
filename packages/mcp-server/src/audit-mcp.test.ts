import assert from "node:assert/strict";
import test from "node:test";
import { EventInput } from "@retrace-dev/core";
import { LogArgs } from "./audit-mcp.js";

test("shared retrace_log schema covers every client-suppliable core EventInput field", () => {
  // producer_sig belongs to the producer-signing adapter, not the compatibility-first audit MCP surface.
  // All other EventInput keys must be accepted here or zod will silently strip a new field before handlers see it.
  const expected = Object.keys(EventInput.shape).filter((key) => key !== "producer_sig").sort();
  const actual = Object.keys(LogArgs.shape).sort();
  assert.deepEqual(actual, expected);
});

test("shared retrace_log schema retains capture-role and causal-link operating guidance", () => {
  assert.match(LogArgs.shape.artifacts.description ?? "", /Always set role explicitly for OUTPUTS/);
  assert.match(LogArgs.shape.caused_by.description ?? "", /existing same-project event/);
  assert.match(LogArgs.shape.caused_by.description ?? "", /dangling or cross-project ids are rejected/);
});

test("shared retrace_log schema refuses NUL and unpaired surrogates and accepts an astral pair", () => {
  const base = { action: "edited" as const, artifacts: [{ id: "a" }] };
  assert.equal(LogArgs.safeParse({ ...base, artifacts: [{ id: "repo:o/retrace#a\0b" }] }).success, false);
  assert.equal(LogArgs.safeParse({ ...base, artifacts: [{ id: "repo:o/retrace#a\uD800b" }] }).success, false);
  assert.equal(LogArgs.safeParse({ ...base, artifacts: [{ id: "repo:o/retrace#a\uDC00b" }] }).success, false);
  assert.equal(LogArgs.safeParse({ ...base, artifacts: [{ id: "repo:o/retrace#😀.ts" }] }).success, true);
});
