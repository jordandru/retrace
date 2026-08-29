import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isMainModule } from "./is-main.js";

test("recognizes a direct module entry point", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-is-main-"));
  const target = join(dir, "cli.js");
  writeFileSync(target, "");
  assert.equal(isMainModule(pathToFileURL(target).href, target), true);
});

test("recognizes an npm-style symlinked bin entry point", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-is-main-"));
  const target = join(dir, "cli.js");
  const bin = join(dir, "retrace");
  writeFileSync(target, "");
  symlinkSync(target, bin);
  assert.equal(isMainModule(pathToFileURL(target).href, bin), true);
});

test("rejects a different entry point", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-is-main-"));
  const module = join(dir, "module.js");
  const entry = join(dir, "entry.js");
  writeFileSync(module, "");
  writeFileSync(entry, "");
  assert.equal(isMainModule(pathToFileURL(module).href, entry), false);
});
