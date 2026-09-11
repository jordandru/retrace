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
  assert.equal(rules.routing_event.head_sha_format, "^[0-9a-f]{40}$");
  for (const field of ["rules_digest", "models_digest", "head_sha", "surface_class", "target"]) {
    assert.ok(rules.routing_event.required_params.includes(field), field);
  }
  assert.equal(rules.escalation.record_before_relaunch, true);
  assert.ok(rules.escalation.required_params.includes("escalated_from"));
  assert.ok(rules.escalation.required_params.includes("head_sha"));
  assert.equal(rules.classification.reclassify_on_head_change, true);
  assert.equal(rules.classification.default_surface_class, "S");
  assert.equal(rules.classification.default_surface_class, rules.classification.class_order[0]);
  assert.ok(rules.routing_event.required_params.includes("unmatched_paths"));
  assert.match(digest("routing-rules/1.json"), /^[0-9a-f]{64}$/);
  assert.match(digest("routing-rules/models.json"), /^[0-9a-f]{64}$/);
});

type RoutingRules = {
  classification: { highest_class_wins: boolean; class_order: string[]; default_surface_class: string };
  surface_classes: Record<string, { path_patterns?: string[] }>;
  routing_event: { required_params: string[] };
};

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "@@GS@@")
    .replace(/\*\*/g, "@@G@@")
    .replace(/\*/g, "[^/]*")
    .replace(/@@GS@@/g, "(?:.*/)?")
    .replace(/@@G@@/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function classifyReviewPaths(paths: string[], rules: RoutingRules): { surface_class: string; unmatched_paths: string[] } {
  const order = rules.classification.class_order;
  const rank = (cls: string) => {
    const index = order.indexOf(cls);
    return index === -1 ? order.length : index;
  };
  const unmatched_paths: string[] = [];
  let surface_class: string | undefined;
  for (const path of paths) {
    let matched: string | undefined;
    for (const cls of order) {
      if (cls === "F") continue;
      const patterns = rules.surface_classes[cls]?.path_patterns ?? [];
      if (patterns.some((pattern) => globToRegExp(pattern).test(path))) {
        matched = cls;
        break;
      }
    }
    if (!matched) {
      unmatched_paths.push(path);
      matched = rules.classification.default_surface_class;
    }
    if (surface_class === undefined || rank(matched) < rank(surface_class)) surface_class = matched;
  }
  return { surface_class: surface_class ?? rules.classification.default_surface_class, unmatched_paths };
}

test("review effort: unmatched paths default to S and are recorded on the routing event", () => {
  const rules = json<RoutingRules>("routing-rules/1.json");
  const skill = read("SKILL.md").toString("utf8");
  const unmatched = "brand-new/unclassified.ts";
  const tests = "packages/mcp-server/src/doctor.test.ts";

  const onlyUnmatched = classifyReviewPaths([unmatched], rules);
  assert.equal(onlyUnmatched.surface_class, "S");
  assert.notEqual(onlyUnmatched.surface_class, "C");
  assert.deepEqual(onlyUnmatched.unmatched_paths, [unmatched]);

  const withTests = classifyReviewPaths([unmatched, tests], rules);
  assert.equal(rules.classification.highest_class_wins, true);
  assert.equal(withTests.surface_class, "S");
  assert.deepEqual(withTests.unmatched_paths, [unmatched]);

  const params = {
    surface_class: withTests.surface_class,
    unmatched_paths: withTests.unmatched_paths,
  };
  assert.ok(rules.routing_event.required_params.includes("unmatched_paths"));
  assert.deepEqual(params.unmatched_paths, [unmatched]);
  assert.match(skill, /"unmatched_paths"/);
});

test("review effort R4: class S cannot route below high and pins cannot lower the rubric", () => {
  const rules = json<any>("routing-rules/1.json");
  assert.equal(rules.surface_classes.S.first_pass, "high");
  assert.equal(rules.surface_classes.S.minimum_first_pass, "high");
  assert.ok(rules.surface_classes.S.path_patterns.includes("packages/core/src/schema.ts"));
  assert.ok(rules.surface_classes.S.path_patterns.includes(".claude/skills/review-effort/**"));
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
