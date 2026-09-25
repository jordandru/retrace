import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { countCapturingGroups, loadRoutingModels, resolveRoutingModel } from "./doctor.js";

const row = { supports_effort: true, levels: ["low", "medium", "high", "xhigh"] };

function writeRegistry(models: unknown): string {
  const repo = mkdtempSync(join(tmpdir(), "retrace-routing-models-"));
  const dir = join(repo, ".claude", "skills", "review-effort", "routing-rules");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "models.json"), JSON.stringify(models));
  return repo;
}

test("resolver order is exact key, then alias, then display_pattern", () => {
  const models = loadRoutingModels(writeRegistry({
    "grok-4.6": {
      ...row,
      aliases: ["Cursor Grok 4.6"],
      display_patterns: ["^(?:Cursor )?Grok 4\\.6(?: \\((low|medium|high|xhigh)\\))?$"],
    },
    "other": { ...row, display_patterns: ["^grok-4\\.6$"] },
  }))!;
  assert.equal(resolveRoutingModel(models, "grok-4.6")?.id, "grok-4.6", "exact key wins over a later pattern");
  assert.equal(resolveRoutingModel(models, "Cursor Grok 4.6")?.id, "grok-4.6");
  assert.equal(resolveRoutingModel(models, "Cursor Grok 4.6")?.captured_level, undefined, "alias match does not capture a level");
  const withSuffix = resolveRoutingModel(models, "Cursor Grok 4.6 (high)");
  assert.equal(withSuffix?.id, "grok-4.6");
  assert.equal(withSuffix?.captured_level, "high");
  const bare = resolveRoutingModel(models, "Grok 4.6");
  assert.equal(bare?.id, "grok-4.6");
  assert.equal(bare?.captured_level, undefined);
  assert.equal(resolveRoutingModel(models, "not-a-registered-model"), undefined);
});

test("shipped grok-4.6 patterns match display strings and Cursor launch ids", () => {
  const models = loadRoutingModels(fileURLToPath(new URL("../../../", import.meta.url)))!;
  assert.equal(resolveRoutingModel(models, "Grok 4.6 (xhigh)")?.id, "grok-4.6");
  assert.equal(resolveRoutingModel(models, "Grok 4.6 (xhigh)")?.captured_level, "xhigh");
  assert.equal(resolveRoutingModel(models, "Cursor Grok 4.6 (low)")?.captured_level, "low");
  const launch = resolveRoutingModel(models, "cursor-grok-4.6-high");
  assert.equal(launch?.id, "grok-4.6");
  assert.equal(launch?.captured_level, "high");
  assert.equal(resolveRoutingModel(models, "cursor-grok-4.6")?.id, "grok-4.6");
  assert.equal(resolveRoutingModel(models, "cursor-grok-4.6")?.captured_level, undefined);
  assert.equal(resolveRoutingModel(models, "cursor-GROK-4.6-high"), undefined, "pattern match is case-sensitive");
  assert.equal(resolveRoutingModel(models, "gpt-6-astra-high"), undefined);
});

test("loader rejects a pattern that does not compile or has two capturing groups", () => {
  assert.throws(
    () => loadRoutingModels(writeRegistry({ a: { ...row, display_patterns: ["("] } })),
    /a display pattern "\(" failed to compile/,
  );
  assert.throws(
    () => loadRoutingModels(writeRegistry({ a: { ...row, display_patterns: ["^(a)(b)$"] } })),
    /a display pattern "\^\(a\)\(b\)\$" has 2 capturing groups/,
  );
  assert.equal(countCapturingGroups("^(?:Cursor )?(x)$"), 1);
  assert.equal(countCapturingGroups("[(](a)"), 1);
});
