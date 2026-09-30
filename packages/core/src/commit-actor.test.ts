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

test("resolveCommitActor: Retrace-Model-Source trailer, Decision A, Decision B", () => {
  const sources = ["harness-runtime", "harness-config", "harness-display", "credential-pinned", "operator-stated", "self-report"] as const;
  for (const source of sources) {
    const r = resolveCommitActor({
      message: `subject\n\nRetrace-Actor: github-copilot\nRetrace-Model: gpt-5.6-sol\nRetrace-Model-Source: ${source}`,
      authorName: "Jordan",
      authorEmail: "jordan@example.com",
    });
    assert.equal(r.modelClaim, "complete", source);
    assert.equal(r.actor.model, "gpt-5.6-sol");
    assert.equal(r.actor.model_source, source);
  }

  const none = resolveCommitActor({
    message: "subject\n\nRetrace-Actor: github-copilot\nRetrace-Model-Source: none",
    authorName: "Jordan",
    authorEmail: "jordan@example.com",
  });
  assert.equal(none.modelClaim, "none");
  assert.equal(none.actor.model, undefined);
  assert.equal(none.actor.model_source, "none");

  const missing = resolveCommitActor({
    message: "subject\n\nRetrace-Actor: github-copilot\nRetrace-Model: gpt-5.6-sol",
    authorName: "Jordan",
    authorEmail: "jordan@example.com",
  });
  assert.equal(missing.modelClaim, "source-missing");
  assert.equal(missing.actor.model_source, undefined);

  const absent = resolveCommitActor({
    message: "subject\n\nRetrace-Actor: github-copilot",
    authorName: "Jordan",
    authorEmail: "jordan@example.com",
  });
  assert.equal(absent.modelClaim, "absent");
  assert.equal(absent.actor.model_source, undefined);

  const noneBesideModel = resolveCommitActor({
    message: "subject\n\nRetrace-Actor: github-copilot\nRetrace-Model: gpt-5.6-sol\nRetrace-Model-Source: none",
    authorName: "Jordan",
    authorEmail: "jordan@example.com",
  });
  assert.equal(noneBesideModel.modelClaim, "inconsistent");
  assert.equal(noneBesideModel.actor.model, "gpt-5.6-sol");
  assert.equal(noneBesideModel.actor.model_source, undefined, "Decision A: omit model_source so the actor still parses");

  const sourceWithoutModel = resolveCommitActor({
    message: "subject\n\nRetrace-Actor: github-copilot\nRetrace-Model-Source: harness-runtime",
    authorName: "Jordan",
    authorEmail: "jordan@example.com",
  });
  assert.equal(sourceWithoutModel.modelClaim, "inconsistent");
  assert.equal(sourceWithoutModel.actor.model_source, undefined);

  const unknownSource = resolveCommitActor({
    message: "subject\n\nRetrace-Actor: github-copilot\nRetrace-Model: gpt-5.6-sol\nRetrace-Model-Source: made-up",
    authorName: "Jordan",
    authorEmail: "jordan@example.com",
  });
  assert.equal(unknownSource.modelClaim, "inconsistent");
  assert.equal(unknownSource.actor.model, "gpt-5.6-sol");
  assert.equal(unknownSource.actor.model_source, undefined);

  const unknownSourceNoModel = resolveCommitActor({
    message: "subject\n\nRetrace-Actor: github-copilot\nRetrace-Model-Source: not-a-source",
    authorName: "Jordan",
    authorEmail: "jordan@example.com",
  });
  assert.equal(unknownSourceNoModel.modelClaim, "inconsistent");
  assert.equal(unknownSourceNoModel.actor.model_source, undefined);

  const coauthor = resolveCommitActor({
    message: "subject\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
    authorName: "Jordan",
    authorEmail: "jordan@example.com",
  });
  assert.equal(coauthor.claimSource, "co-authored-by");
  assert.equal(coauthor.actor.model, "claude-fable-5");
  assert.equal(coauthor.actor.model_source, undefined, "Decision B: coauthor model is legacy, no model_source");
  assert.equal(coauthor.modelClaim, "source-missing");

  const coauthorWithSource = resolveCommitActor({
    message: "subject\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nRetrace-Model-Source: harness-config",
    authorName: "Jordan",
    authorEmail: "jordan@example.com",
  });
  assert.equal(coauthorWithSource.modelClaim, "complete");
  assert.equal(coauthorWithSource.actor.model_source, "harness-config");

  const coauthorNone = resolveCommitActor({
    message: "subject\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\nRetrace-Model-Source: none",
    authorName: "Jordan",
    authorEmail: "jordan@example.com",
  });
  assert.equal(coauthorNone.modelClaim, "inconsistent");
  assert.equal(coauthorNone.actor.model_source, undefined);
  assert.equal(coauthorNone.actor.model, "claude-fable-5");

  const coauthorFamilyOnly = resolveCommitActor({
    message: "subject\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
    authorName: "Jordan",
    authorEmail: "jordan@example.com",
  });
  assert.equal(coauthorFamilyOnly.actor.model, undefined);
  assert.equal(coauthorFamilyOnly.modelClaim, "absent");
});
