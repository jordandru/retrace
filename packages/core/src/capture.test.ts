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
  assert.equal(full.glob, undefined);

  const short = artifactLookup("repo:retrace#a.ts");
  assert.deepEqual(short.equals, ["repo:retrace#a.ts"]);
  assert.equal(short.glob, "repo:*/retrace#a.ts");

  const other = artifactLookup("repo:otherorg/retrace#a.ts");
  assert.equal(other.equals.includes("repo:jordandru/retrace#a.ts"), false);

  const plain = artifactLookup("task:1");
  assert.deepEqual(plain, { equals: ["task:1"] });
});

test("escapeGlobLiteral keeps * ? [ from matching as wildcards in a path", () => {
  assert.equal(escapeGlobLiteral("a*b?[c]"), "a[*]b[?][[]c[]]");
  const look = artifactLookup("repo:retrace#file*[x].ts");
  assert.equal(look.glob, "repo:*/retrace#file[*][[]x[]].ts");
});
