import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

test("packed CLI resolves PRODUCER_SIG_FORMAT_V2 and parseTrailerPolicy from the packed core at the manifest versions", { timeout: 180_000 }, async () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  // Versions come from the manifests, never from a literal: a release bump must not break this test (PR 121, Codex F1).
  const coreVersion = (JSON.parse(readFileSync(join(repoRoot, "packages/core/package.json"), "utf8")) as { version: string }).version;
  const cliVersion = (JSON.parse(readFileSync(join(repoRoot, "packages/mcp-server/package.json"), "utf8")) as { version: string }).version;
  const tmp = mkdtempSync(join(tmpdir(), "retrace-pack-cli-"));
  // --ignore-scripts: both packages run `npm run build` on prepack, which rewrites dist while the other test files in
  // this suite are still importing it (the hook end-to-end test loaded a half-written attribution.js in CI run
  // 36059452538 on PR 121; issue #108 has the same shape). dist is built by the step before `npm test`; pack it as is.
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", tmp], { cwd: join(repoRoot, "packages/core"), encoding: "utf8" });
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", tmp], { cwd: join(repoRoot, "packages/mcp-server"), encoding: "utf8" });
  const tarballs = readdirSync(tmp).filter((name) => name.endsWith(".tgz"));
  const coreTgz = tarballs.find((name) => name.includes(`core-${coreVersion}`));
  const cliTgz = tarballs.find((name) => name.includes(`cli-${cliVersion}`));
  assert.ok(coreTgz, `core ${coreVersion} tarball in ${tarballs.join(", ")}`);
  assert.ok(cliTgz, `cli ${cliVersion} tarball in ${tarballs.join(", ")}`);

  const app = join(tmp, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "pack-probe", private: true, type: "module" }));
  execFileSync("npm", ["install", "--omit=dev", join(tmp, coreTgz!), join(tmp, cliTgz!)], { cwd: app, encoding: "utf8" });

  const core = await import(pathToFileURL(join(app, "node_modules/@retrace-dev/core/dist/index.js")).href) as {
    PRODUCER_SIG_FORMAT_V2: string;
    parseTrailerPolicy: (raw?: string | null) => string;
    policyDocumentFromRow: unknown;
  };
  assert.equal(core.PRODUCER_SIG_FORMAT_V2, "retrace-producer-sig/2");
  assert.equal(core.parseTrailerPolicy("shadow"), "shadow");
  assert.equal(typeof core.policyDocumentFromRow, "function");
});
