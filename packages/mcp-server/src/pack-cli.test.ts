import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

test("packed CLI resolves PRODUCER_SIG_FORMAT_V2 and parseTrailerPolicy from packed core 0.1.8", { timeout: 180_000 }, async () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), "retrace-pack-cli-"));
  execFileSync("npm", ["pack", "--pack-destination", tmp], { cwd: join(repoRoot, "packages/core"), encoding: "utf8" });
  execFileSync("npm", ["pack", "--pack-destination", tmp], { cwd: join(repoRoot, "packages/mcp-server"), encoding: "utf8" });
  const tarballs = readdirSync(tmp).filter((name) => name.endsWith(".tgz"));
  const coreTgz = tarballs.find((name) => name.includes("core-0.1.8"));
  const cliTgz = tarballs.find((name) => name.includes("cli-0.1.8"));
  assert.ok(coreTgz, `core 0.1.8 tarball in ${tarballs.join(", ")}`);
  assert.ok(cliTgz, `cli 0.1.8 tarball in ${tarballs.join(", ")}`);

  const app = join(tmp, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "pack-probe", private: true, type: "module" }));
  execFileSync("npm", ["install", "--omit=dev", join(tmp, coreTgz!), join(tmp, cliTgz!)], { cwd: app, encoding: "utf8" });

  const core = await import(pathToFileURL(join(app, "node_modules/@retrace-dev/core/dist/index.js")).href) as {
    PRODUCER_SIG_FORMAT_V2: string;
    parseTrailerPolicy: (raw?: string | null) => string;
  };
  assert.equal(core.PRODUCER_SIG_FORMAT_V2, "retrace-producer-sig/2");
  assert.equal(core.parseTrailerPolicy("shadow"), "shadow");
});
