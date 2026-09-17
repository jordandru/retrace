import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkCommitCommand,
  checkModel,
  editedPaths,
  isGitCommit,
  loggedPaths,
  normalisePath,
  readPromptIdentity,
  refusalPrompt,
  retraceTool,
  uncoveredFiles,
} from "./guard.js";
import { isRetraceWorktree } from "./worktree.js";

/** The real opening of this repo's Codex identity file — the text the seat must never run on. */
const CODEX_AGENTS_MD = [
  "# Codex — identity",
  "",
  "This repository records verifiable provenance through the `retrace` MCP server.",
  "",
  "- Actor id `codex`. Trailers on every commit: `Retrace-Actor: codex`,",
  "  `Retrace-Model: gpt-6-astra`, `Retrace-Caused-By: <instruction event id>`.",
].join("\n");

const SEAT_FILE = [
  "RETRACE-SEAT: opencode",
  "",
  "# OpenCode — identity",
  "",
  "- Actor id `opencode`. Trailers on every commit: `Retrace-Actor: opencode`,",
  "  `Retrace-Model: opencode-go/qwen3.7-max`, `Retrace-Caused-By: <instruction event id>`.",
  "- This identity block is for OpenCode only. OpenCode can be made to read AGENTS.md, CLAUDE.md,",
  "  GROK.md and .cursor/rules/; never adopt an actor id from any of them.",
].join("\n");

const SYSTEM_PREAMBLE = "You are opencode, an interactive CLI tool that helps users with software engineering tasks.";

test("prompt identity: the seat's own instruction file is recognised", () => {
  assert.deepEqual(readPromptIdentity([`${SYSTEM_PREAMBLE}\n\n${SEAT_FILE}`]), { carriesSeat: true, foreign: null });
});

test("prompt identity: another seat's identity file is named as foreign", () => {
  const identity = readPromptIdentity([`${SYSTEM_PREAMBLE}\n\n${CODEX_AGENTS_MD}\n\n${SEAT_FILE}`]);
  assert.equal(identity.carriesSeat, true);
  assert.match(identity.foreign ?? "", /Retrace-Actor: codex/);
});

test("prompt identity: a prompt with no instruction files carries nothing and is not foreign", () => {
  // OpenCode builds a title-generator prompt with no instruction files at all (Gate 0).
  assert.deepEqual(readPromptIdentity(["You are a title generator. You output ONLY a thread title."]), {
    carriesSeat: false,
    foreign: null,
  });
  assert.deepEqual(readPromptIdentity([]), { carriesSeat: false, foreign: null });
  assert.deepEqual(readPromptIdentity(undefined), { carriesSeat: false, foreign: null });
});

test("prompt identity: a foreign heading or `Actor id` phrase alone is foreign", () => {
  assert.match(readPromptIdentity([`${SEAT_FILE}\n\n# Grok — identity\n`]).foreign ?? "", /Grok/);
  assert.match(readPromptIdentity([`${SEAT_FILE}\n\nActor id \`cursor-agent\`.`]).foreign ?? "", /cursor-agent/);
});

test("prompt identity: the shared rules' placeholder trailer is not a foreign seat", () => {
  const rules = "Every commit carries `Retrace-Actor: <your seat>`, `Retrace-Model: <verbatim model>`.";
  assert.deepEqual(readPromptIdentity([`${SEAT_FILE}\n\n${rules}`]), { carriesSeat: true, foreign: null });
});

test("model: harness report and logged value must match exactly", () => {
  assert.deepEqual(checkModel("opencode-go/qwen3.7-max", "opencode-go/qwen3.7-max"), { ok: true });
  assert.equal(checkModel("opencode-go/qwen3.7-max", "qwen3.7-max").ok, false);
  assert.equal(checkModel("opencode-go/qwen3.7-max", undefined).ok, false);
  assert.equal(checkModel(undefined, "opencode-go/qwen3.7-max").ok, false);
});

test("git commit detection ignores other commands", () => {
  assert.equal(isGitCommit("npm test"), false);
  assert.equal(isGitCommit("git log --oneline | head"), false);
  assert.equal(isGitCommit("git status"), false);
  assert.equal(isGitCommit("git commit --only docs/x.md -m 'x'"), true);
  assert.equal(isGitCommit("cd /repo && git commit -m 'x'"), true);
});

test("commit: a correctly trailered commit passes", () => {
  const cmd =
    "git commit --only docs/agents/OPENCODE.md -m 'docs: seat file' " +
    "-m 'Retrace-Actor: opencode' -m 'Retrace-Model: opencode-go/qwen3.7-max' " +
    `-m 'Retrace-Caused-By: evt_${"a".repeat(32)}'`;
  assert.deepEqual(checkCommitCommand(cmd), { ok: true });
});

test("commit: another seat's trailer is refused", () => {
  const cmd = "git commit -m 'x' -m 'Retrace-Actor: codex' -m 'Retrace-Model: gpt-6-astra'";
  const verdict = checkCommitCommand(cmd);
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : "", /another seat/);
});

test("commit: no trailer at all is refused", () => {
  const verdict = checkCommitCommand("git commit -m 'quick fix'");
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : "", /no `Retrace-Actor: opencode` trailer/);
});

test("commit: message-from-file cannot be read, so it is refused with a reason", () => {
  const verdict = checkCommitCommand("git commit -F /tmp/msg.txt");
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : "", /pass the message inline/);
});

test("commit: --amend is refused (agent-rules 10)", () => {
  const verdict = checkCommitCommand("git commit --amend --no-edit");
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : "", /amend/);
});

test("commit: missing Retrace-Caused-By is refused", () => {
  const cmd = "git commit -m 'x' -m 'Retrace-Actor: opencode' -m 'Retrace-Model: opencode-go/qwen3.7-max'";
  const verdict = checkCommitCommand(cmd);
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : "", /Caused-By/);
});

test("coverage: repo artifact ids and absolute paths compare as the same file", () => {
  assert.equal(normalisePath("repo:jordandru/retrace#packages/core/src/x.ts"), "packages/core/src/x.ts");
  assert.equal(normalisePath("./packages/core/src/x.ts"), "packages/core/src/x.ts");
  assert.deepEqual(
    uncoveredFiles(["packages/core/src/x.ts", "docs/y.md"], ["repo:jordandru/retrace#packages/core/src/x.ts"]),
    ["docs/y.md"],
  );
  assert.deepEqual(uncoveredFiles([], []), []);
});

test("tool shapes: edited and logged paths are read across arg spellings", () => {
  assert.deepEqual(editedPaths("edit", { filePath: "a.ts" }), ["a.ts"]);
  assert.deepEqual(editedPaths("write", { path: "b.ts" }), ["b.ts"]);
  assert.deepEqual(editedPaths("multiedit", { edits: [{ file_path: "c.ts" }, { file_path: "d.ts" }] }), ["c.ts", "d.ts"]);
  assert.deepEqual(editedPaths("bash", { filePath: "nope.ts" }), []);
  assert.deepEqual(loggedPaths({ artifacts: [{ id: "repo:x#a.ts" }, { id: "repo:x#b.ts" }] }), ["repo:x#a.ts", "repo:x#b.ts"]);
  assert.deepEqual(loggedPaths({}), []);
});

test("retrace MCP tools are recognised whatever prefix the harness gives them", () => {
  assert.equal(retraceTool("retrace_log"), "log");
  assert.equal(retraceTool("retrace_retrace_log"), "log");
  assert.equal(retraceTool("mcp__retrace__retrace_instruct"), "instruct");
  assert.equal(retraceTool("bash"), null);
  assert.equal(retraceTool("read"), null);
});

test("refusal prompt names the reason and forbids acting", () => {
  const text = refusalPrompt("test reason");
  assert.match(text, /test reason/);
  assert.match(text, /Do not call any tool/);
});

test("worktree detection: only a real Retrace checkout activates the guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "retrace-guard-"));
  assert.equal(isRetraceWorktree(dir), false);
  writeFileSync(join(dir, ".retrace.json"), JSON.stringify({ project: "retrace" }));
  assert.equal(isRetraceWorktree(dir), false, "agent rules missing");
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "agent-rules.md"), "# rules");
  assert.equal(isRetraceWorktree(dir), true);
  assert.equal(isRetraceWorktree(""), false);
});
