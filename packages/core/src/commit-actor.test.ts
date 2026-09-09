import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCommitActor } from "./commit-actor.js";

test("resolveCommitActor reports every claim source without changing actor precedence", () => {
  const retraceActor = resolveCommitActor({
    message: "subject\n\nRetrace-Actor: github-copilot\nRetrace-Model: gpt-5.6-sol",
    authorName: "Jordan",
    authorEmail: "jordan@example.com",
  });
  assert.equal(retraceActor.claimSource, "retrace-actor");
  assert.deepEqual(retraceActor.actor, {
    type: "agent",
    id: "github-copilot",
    model: "gpt-5.6-sol",
    on_behalf_of: "jordan@example.com",
  });

  const coauthor = resolveCommitActor({
    message: "subject\n\nCo-Authored-By: GitHub Copilot <noreply@github.com>",
    authorName: "Jordan",
    authorEmail: "jordan@example.com",
  });
  assert.equal(coauthor.claimSource, "co-authored-by");
  assert.deepEqual(coauthor.actor, {
    type: "agent",
    id: "github-copilot",
    model: undefined,
    display_name: "GitHub Copilot",
    on_behalf_of: "jordan@example.com",
  });

  const bot = resolveCommitActor({
    message: "subject",
    authorName: "dependabot[bot]",
    authorEmail: "49699333+dependabot[bot]@users.noreply.github.com",
  });
  assert.equal(bot.claimSource, "bot-author");
  assert.equal(bot.actor.type, "system");

  const human = resolveCommitActor({
    message: "subject",
    authorName: "Jordan",
    authorEmail: "jordan@example.com",
  });
  assert.equal(human.claimSource, "human-author");
  assert.deepEqual(human.actor, { type: "human", id: "jordan@example.com", display_name: "Jordan" });

  const malformed = resolveCommitActor({
    message: "subject\n\nRetrace-Actor: https://invalid.example\nCo-Authored-By: Claude <noreply@anthropic.com>",
    authorName: "Jordan",
    authorEmail: "jordan@example.com",
  });
  assert.equal(malformed.claimSource, "malformed");
  assert.equal(malformed.actor.id, "claude", "invalid Retrace-Actor keeps the existing Co-Authored-By fallback");

  const literalNewlines = resolveCommitActor({
    message: String.raw`subject\n\nRetrace-Actor: github-copilot\nRetrace-Model: gpt-5.6-sol`,
    authorName: "Jordan",
    authorEmail: "jordan@example.com",
  });
  assert.equal(literalNewlines.claimSource, "malformed");
  assert.deepEqual(
    literalNewlines.actor,
    { type: "human", id: "jordan@example.com", display_name: "Jordan" },
    "the #2030 shape keeps today's actor fallback",
  );
});
