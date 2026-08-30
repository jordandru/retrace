import { test } from "node:test";
import assert from "node:assert/strict";
import { Event } from "./schema.js";
import { collectProvenanceAmendments, collectRejectedAmendments } from "./amendment.js";

const evt = (over: Partial<Event> & { id: string; seq: number }): Event => ({
  project: "p",
  action: "other",
  action_detail: "amended",
  actor: { type: "agent", id: "auditor" },
  artifacts: [{ id: "event:x", role: "used" }],
  timestamp: "2026-08-29T00:00:00Z",
  received_at: "2026-08-29T00:00:00Z",
  prev_hash: "0",
  hash: "0",
  ...over,
});

const target = evt({
  id: "evt_target",
  seq: 0,
  action: "committed",
  action_detail: undefined,
  artifacts: [{ id: "commit:p@old" }],
});
const rootId = "evt_root";
const isRooted = (e: Event) => e.caused_by === rootId;

test("collectRejectedAmendments reports unrooted, missing, wrong-project, and not-older links", () => {
  const unrooted = evt({ id: "evt_unrooted", seq: 1, method: { tool: "retrace_amend", params: { target_event_id: target.id } } });
  const missing = evt({ id: "evt_missing", seq: 2, caused_by: rootId, method: { tool: "retrace_amend", params: { target_event_id: "evt_no_such" } } });
  const foreign = evt({ id: "evt_foreign", seq: 0, project: "other", action: "committed", action_detail: undefined, artifacts: [{ id: "commit:other@x" }] });
  const wrongProject = evt({ id: "evt_wrong", seq: 3, caused_by: rootId, method: { tool: "retrace_amend", params: { target_event_id: foreign.id } } });
  const notOlder = evt({ id: "evt_not_older", seq: 0, caused_by: rootId, method: { tool: "retrace_amend", params: { target_event_id: target.id } } });
  const ok = evt({ id: "evt_ok", seq: 4, caused_by: rootId, method: { tool: "retrace_amend", params: { target_event_id: target.id, attest_causal_root: true } } });

  const events = [target, unrooted, missing, foreign, wrongProject, notOlder, ok];
  const rejected = collectRejectedAmendments(events, isRooted);
  assert.deepEqual(rejected.map((r) => [r.event.id, r.reason]), [
    ["evt_unrooted", "unrooted"],
    ["evt_missing", "missing_target"],
    ["evt_wrong", "wrong_project"],
    ["evt_not_older", "not_older"],
  ]);
  const applied = collectProvenanceAmendments(events, isRooted);
  assert.equal(applied.get(target.id)?.length, 1);
  assert.equal(applied.get(target.id)?.[0].event.id, "evt_ok");
});
