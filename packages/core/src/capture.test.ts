import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactKey, artifactLookup, sameArtifact, escapeGlobLiteral } from "./capture.js";

test("artifactKey is the comparison identity sameArtifact uses; no second normalizer", () => {
  assert.equal(artifactKey("repo:jordandru/retrace#a.ts"), "repo:jordandru/retrace#a.ts");
  assert.equal(artifactKey("task:1"), "task:1");
  assert.equal(sameArtifact("x", "x"), true);
  assert.equal(sameArtifact("x", "y"), false);
});

test("sameArtifact: owner/repo matches its basename alias; two full names do not match each other", () => {
  const full = "repo:jordandru/retrace#src/a.ts";
  const short = "repo:retrace#src/a.ts";
  const other = "repo:otherorg/retrace#src/a.ts";
  const foreign = "repo:jordandru/other#src/a.ts";
  assert.equal(sameArtifact(full, short), true);
  assert.equal(sameArtifact(short, full), true);
  assert.equal(sameArtifact(full, other), false, "two owner/repo forms are not aliases of each other");
  assert.equal(sameArtifact(full, foreign), false);
  assert.equal(sameArtifact(short, "repo:retrace#src/b.ts"), false);
});

test("artifactLookup expands the same owner/repo ↔ basename rule as sameArtifact", () => {
  const full = artifactLookup("repo:jordandru/retrace#a.ts");
  assert.deepEqual(full.equals.slice().sort(), ["repo:jordandru/retrace#a.ts", "repo:retrace#a.ts"].sort());
  assert.equal(full.suffix, undefined);

  const short = artifactLookup("repo:retrace#a.ts");
  assert.deepEqual(short.equals, ["repo:retrace#a.ts"]);
  assert.equal(short.suffix, "/retrace#a.ts");

  const other = artifactLookup("repo:otherorg/retrace#a.ts");
  assert.equal(other.equals.includes("repo:jordandru/retrace#a.ts"), false);

  const plain = artifactLookup("task:1");
  assert.deepEqual(plain, { equals: ["task:1"] });
});

test("escapeGlobLiteral keeps * ? [ from matching as wildcards in a path", () => {
  assert.equal(escapeGlobLiteral("a*b?[c]"), "a[*]b[?][[]c[]]");
});

test("alias suffix is equivalent to GLOB repo:*/alias#path for a hit and a near-miss", () => {
  // GLOB `repo:*/retrace#<path>` has one wildcard, `*`, which matches `/` and `#`. The matched set is
  // therefore keys that start with `repo:` and end with `/retrace#<path>`. Suffix equality is that
  // filter; the explicit `[repo:, repo;)` range supplies the prefix. `escapeGlobLiteral` protected
  // `*`, `?`, `[` in the GLOB form; a literal suffix compare does not need it and must not apply it.
  const path = "packages/core/src/store.ts";
  const query = `repo:retrace#${path}`;
  const look = artifactLookup(query);
  const suffix = `/retrace#${path}`;
  assert.equal(look.suffix, suffix);
  assert.equal("glob" in look, false);

  const match = `repo:jordandru/retrace#${path}`;
  const nearMiss = `repo:jordandru/retrace-extra#${path}`;
  assert.equal(sameArtifact(match, query), true);
  assert.equal(match.startsWith("repo:") && match.endsWith(suffix), true, "hit: owner/alias#path ends with the suffix");
  assert.equal(sameArtifact(nearMiss, query), false);
  assert.equal(nearMiss.endsWith(suffix), false, "near-miss: basename retrace-extra must not satisfy /retrace#path");

  const wild = artifactLookup("repo:retrace#file*[x].ts");
  assert.equal(wild.suffix, "/retrace#file*[x].ts", "suffix is literal; brackets from escapeGlobLiteral would search for the wrong key");
  assert.equal("repo:acme/retrace#file*[x].ts".endsWith(wild.suffix!), true);
  assert.equal("repo:acme/retrace#fileQ[x].ts".endsWith(wild.suffix!), false);

  const oldGlob = `repo:*/retrace#${"a".repeat(47)}`;
  assert.equal(new TextEncoder().encode(oldGlob).length, 62);
  assert.equal(artifactLookup(`repo:retrace#${"a".repeat(47)}`).suffix, `/${"retrace"}#${"a".repeat(47)}`);
});
