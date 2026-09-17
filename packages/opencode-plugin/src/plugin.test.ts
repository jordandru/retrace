import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import RetraceGuardPlugin, * as entrypoint from "./index.js";

const SEAT_PROMPT =
  "You are opencode, an interactive CLI tool.\n\nRETRACE-SEAT: opencode\n\n# OpenCode — identity\n- Actor id `opencode`.";
/** OpenCode asks a small model for a thread title with a prompt that carries no instructions. */
const TITLE_PROMPT = "You are a title generator. You output ONLY a thread title.";
const CODEX_PROMPT = `${SEAT_PROMPT}\n\n# Codex — identity\n- Actor id \`codex\`. Trailers: \`Retrace-Actor: codex\`.`;

function worktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "retrace-seat-"));
  writeFileSync(join(dir, ".retrace.json"), JSON.stringify({ project: "retrace" }));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "agent-rules.md"), "# rules");
  return dir;
}

async function hooks() {
  return (await RetraceGuardPlugin({ worktree: worktree() })) as any;
}

const commit = (extra = "") =>
  `git commit --only x.ts -m 'x' -m 'Retrace-Actor: opencode' -m 'Retrace-Model: probe/m' -m 'Retrace-Caused-By: evt_${"a".repeat(32)}'${extra}`;

test("outside a Retrace worktree the guard does nothing at all", async () => {
  const h = (await RetraceGuardPlugin({ worktree: mkdtempSync(join(tmpdir(), "plain-")) })) as any;
  assert.deepEqual(h, {});
});

test("a title prompt without the seat file does not by itself refuse, but the session still cannot act", async () => {
  const h = await hooks();
  const out = { system: [TITLE_PROMPT] };
  await h["experimental.chat.system.transform"]({ sessionID: "s1" }, out);
  assert.deepEqual(out.system, [TITLE_PROMPT], "the title prompt is left alone");
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "bash", sessionID: "s1" }, { args: { command: "ls" } }),
    /no prompt in this session carried the seat instruction file/,
  );
});

test("a session on the seat's own instruction file may act", async () => {
  const h = await hooks();
  const out = { system: [TITLE_PROMPT] };
  await h["experimental.chat.system.transform"]({ sessionID: "s2" }, out);
  await h["experimental.chat.system.transform"]({ sessionID: "s2" }, { system: [SEAT_PROMPT] });
  await h["tool.execute.before"]({ tool: "bash", sessionID: "s2" }, { args: { command: "ls" } });
});

test("another seat's identity in any prompt replaces it and stops the session acting", async () => {
  const h = await hooks();
  const out = { system: [CODEX_PROMPT] };
  await h["experimental.chat.system.transform"]({ sessionID: "s3" }, out);
  assert.match(out.system[0], /RETRACE GUARD/);
  assert.match(out.system[0], /Retrace-Actor: codex/);
  const permission = { status: "allow" as "ask" | "deny" | "allow" };
  await h["permission.ask"]({ sessionID: "s3" }, permission);
  assert.equal(permission.status, "deny");
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "bash", sessionID: "s3" }, { args: { command: "ls" } }),
    /Retrace-Actor: codex/,
  );
});

test("a retrace_log whose actor.model is not what the harness reports is refused", async () => {
  const h = await hooks();
  await h["experimental.chat.system.transform"]({ sessionID: "s4" }, { system: [SEAT_PROMPT] });
  await h["chat.message"]({ sessionID: "s4", model: { providerID: "opencode-go", modelID: "qwen3.7-max" } });
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "retrace_log", sessionID: "s4" }, { args: { actor: { model: "qwen3.7-max" } } }),
    /is not what OpenCode reports/,
  );
  await h["tool.execute.before"](
    { tool: "retrace_log", sessionID: "s4" },
    { args: { actor: { model: "opencode-go/qwen3.7-max" }, artifacts: [{ id: "repo:jordandru/retrace#x.ts" }] } },
  );
});

test("a commit is refused while an edited file has never been logged, and passes once it has", async () => {
  const h = await hooks();
  await h["experimental.chat.system.transform"]({ sessionID: "s5" }, { system: [SEAT_PROMPT] });
  await h["chat.message"]({ sessionID: "s5", model: { providerID: "probe", modelID: "m" } });
  await h["tool.execute.after"]({ tool: "edit", sessionID: "s5", args: { filePath: "x.ts" } });
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "bash", sessionID: "s5" }, { args: { command: commit() } }),
    /edited but never named in a retrace_log/,
  );
  await h["tool.execute.before"](
    { tool: "retrace_log", sessionID: "s5" },
    { args: { actor: { model: "probe/m" }, artifacts: [{ id: "repo:jordandru/retrace#x.ts" }] } },
  );
  await h["tool.execute.before"]({ tool: "bash", sessionID: "s5" }, { args: { command: commit() } });
});

test("a commit trailered for another seat is refused even in a clean session", async () => {
  const h = await hooks();
  await h["experimental.chat.system.transform"]({ sessionID: "s6" }, { system: [SEAT_PROMPT] });
  await assert.rejects(
    () => h["tool.execute.before"]({ tool: "bash", sessionID: "s6" }, { args: { command: "git commit -m 'x' -m 'Retrace-Actor: codex'" } }),
    /another seat/,
  );
});

// OpenCode invokes every unique exported function with PluginInput, not just the default.
test("every runtime entrypoint export is a plugin factory", async () => {
  const input = { worktree: worktree() };
  const factories = new Set(Object.values(entrypoint));
  for (const factory of factories) {
    const h = await (factory as (value: { worktree: string }) => Promise<any>)(input);
    assert.equal(typeof h["experimental.chat.system.transform"], "function");
  }
});

for (const source of ["project AGENTS.md", "global AGENTS.md"]) {
  test(`${source}: refusal reaches the original provider array and remains blocked`, async () => {
    const h = await hooks();
    // The runtime keeps this reference after invoking the hook with { system }.
    const providerSystem = [SEAT_PROMPT, `Instructions from: ${source}\n${CODEX_PROMPT}`, "FOREIGN_MARKER"];
    const out = { system: providerSystem };
    await h["experimental.chat.system.transform"]({ sessionID: "foreign" }, out);
    assert.equal(out.system, providerSystem, "must retain the runtime's array reference");
    assert.equal(providerSystem.length, 1);
    assert.match(providerSystem[0], /RETRACE GUARD/);
    assert.doesNotMatch(providerSystem[0], /FOREIGN_MARKER|RETRACE-SEAT: opencode/);
    // A later clean prompt must not clear the refusal state.
    await h["experimental.chat.system.transform"]({ sessionID: "foreign" }, { system: [SEAT_PROMPT] });
    await assert.rejects(
      () => h["tool.execute.before"]({ tool: "bash", sessionID: "foreign" }, { args: { command: "ls" } }),
      /Retrace-Actor: codex/,
    );
  });
}
