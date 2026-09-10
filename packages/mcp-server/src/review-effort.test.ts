import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const skillRoot = resolve(root, ".claude/skills/review-effort");
const read = (name: string) => readFileSync(resolve(skillRoot, name));
const json = <T>(name: string): T => JSON.parse(read(name).toString("utf8")) as T;
const digest = (name: string) => createHash("sha256").update(read(name)).digest("hex");

test("review effort R1/R5/R6/R7: routing data requires digests, immutable heads, and record-before-launch ordering", () => {
  const rules = json<any>("routing-rules/1.json");
  assert.equal(rules.rule_version, "effort-routing/1");
  assert.equal(rules.routing_event.record_before_launch, true);
  for (const field of ["rules_digest", "models_digest", "head_sha", "surface_class", "target"]) {
    assert.ok(rules.routing_event.required_params.includes(field), field);
  }
  assert.equal(rules.escalation.record_before_relaunch, true);
  assert.ok(rules.escalation.required_params.includes("escalated_from"));
  assert.ok(rules.escalation.required_params.includes("head_sha"));
  assert.equal(rules.classification.reclassify_on_head_change, true);
  assert.match(digest("routing-rules/1.json"), /^[0-9a-f]{64}$/);
  assert.match(digest("routing-rules/models.json"), /^[0-9a-f]{64}$/);
});

test("review effort R4: class S cannot route below high and pins cannot lower the rubric", () => {
  const rules = json<any>("routing-rules/1.json");
  assert.equal(rules.surface_classes.S.first_pass, "high");
  assert.equal(rules.surface_classes.S.minimum_first_pass, "high");
  assert.equal(rules.pins.direction, "raise_only");
  assert.equal(rules.pins.below_rubric_action, "refuse");
  assert.equal(rules.pins.source, "stamped_ledger_event");
  assert.deepEqual(rules.pins.accepted_stamps, ["owner", "pinned"]);
  assert.match(rules.pins.authorised_principal, /set_by|owner/);
});

test("review effort R2/R3: registry has the specified capability shape and skill requires truthful linked reviews", () => {
  const models = json<Record<string, { supports_effort: boolean; levels: string[] }>>("routing-rules/models.json");
  assert.ok(Object.keys(models).length > 0);
  for (const value of Object.values(models)) {
    assert.equal(typeof value.supports_effort, "boolean");
    assert.ok(Array.isArray(value.levels));
    assert.equal(value.supports_effort || value.levels.length === 0, true);
  }
  const skill = read("SKILL.md").toString("utf8");
  assert.match(skill, /recorded before launch/i);
  assert.match(skill, /reasoning_effort/);
  assert.match(skill, /routing_event_id/);
  assert.match(skill, /review event is the truth/i);
});
