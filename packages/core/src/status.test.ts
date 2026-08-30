import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent } from "./store.js";
import { Event, EventStore, Share } from "./index.js";
import { buildProjectStatus, causalRootState, renderProjectStatus } from "./status.js";

class MemStore implements EventStore {
  events: Event[] = [];
  async head(project: string) { const e = this.events.filter((x) => x.project === project).at(-1); return e ? { seq: e.seq, hash: e.hash } : null; }
  async insert(e: Event) { this.events.push(e); }
  async byIdempotencyKey() { return null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(project: string) { return this.events.filter((e) => e.project === project); }
  async projects() { return [...new Set(this.events.map((e) => e.project))]; }
  async history(q: any) { return this.events.filter((e) => e.project === q.project); }
  async createShare(_s: Share) {} async getShare() { return null; }
}

test("project status: integrity, causal coverage, capture gaps, actors and integrations share one model", async () => {
  const store = new MemStore();
  const root = (await appendEvent(store, { project: "p", actor: { type: "human", id: "jordan@example.com" }, action: "instructed", artifacts: [{ id: "task:1", role: "generated" }], location: { system: "gemini-cli" } })).event;
  const edit = (await appendEvent(store, { project: "p", actor: { type: "agent", id: "gemini", model: "gemini-pro" }, action: "edited", artifacts: [{ id: "repo:p#a.ts", role: "both" }], caused_by: root.id, location: { system: "gemini-cli" } })).event;
  await appendEvent(store, { project: "p", actor: { type: "agent", id: "gemini" }, action: "committed", artifacts: [{ id: "commit:p@abc", role: "generated" }], caused_by: edit.id, location: { system: "git" } });
  await appendEvent(store, { project: "p", actor: { type: "human", id: "jordan@example.com" }, action: "committed", artifacts: [{ id: "commit:p@orphan" }], location: { system: "git" } });
  const s = await buildProjectStatus(store, "p", new Date("2026-01-01T00:00:00Z"));
  assert.equal(s.integrity.ok, true);
  assert.deepEqual(s.causality, { eligible_events: 3, rooted_in_human_instruction: 2, attested_events: 0, broken_links: 0, unlinked: 1, coverage_pct: 66.7 });
  assert.equal(s.capture.unlinked_commits, 1);
  assert.equal(s.capture.agent_events_without_model, 1);
  assert.equal(s.capture.instructions_without_followup, 0);
  assert.equal(s.capture.artifact_refs_without_role, 1);
  assert.equal(s.capture.amended_artifact_refs, 0);
  assert.equal(s.capture.amended_unlinked_commits, 0);
  assert.equal(s.capture.ineffective_amendments, 0);
  assert.deepEqual(s.actors.map((a) => [a.type, a.id, a.events]), [["agent", "gemini", 2], ["human", "jordan@example.com", 2]]);
  assert.deepEqual(s.integrations.map((i) => [i.system, i.events]), [["gemini-cli", 2], ["git", 2]]);
});

test("rooted append-only amendments resolve debt without changing sealed targets", async () => {
  const store = new MemStore();
  const root = (await appendEvent(store, { project: "p", actor: { type: "human", id: "jordan@example.com" }, action: "instructed", artifacts: [{ id: "task:repair", role: "generated" }] })).event;
  const target = (await appendEvent(store, { project: "p", actor: { type: "agent", id: "legacy", model: "old" }, action: "committed", artifacts: [{ id: "commit:p@old" }] })).event;
  await appendEvent(store, {
    project: "p", actor: { type: "agent", id: "auditor", model: "new" }, action: "other", action_detail: "amended",
    artifacts: [{ id: `event:${target.id}`, role: "used" }], caused_by: root.id,
    method: { tool: "retrace_amend", params: { target_event_id: target.id, artifact_roles: [{ index: 0, role: "generated" }], attest_causal_root: true } },
  });
  const s = await buildProjectStatus(store, "p");
  assert.equal(s.capture.unlinked_commits, 0);
  assert.equal(s.capture.amended_unlinked_commits, 1);
  assert.equal(s.capture.artifact_refs_without_role, 0);
  assert.equal(s.capture.amended_artifact_refs, 1);
  assert.equal(s.causality.attested_events, 1);
  assert.equal(s.causality.coverage_pct, 100);
  assert.equal(s.capture.ineffective_amendments, 0);
  assert.equal(target.artifacts[0].role, undefined, "sealed target remains unchanged");
});

test("status counts sealed amendments that fail exists/older/same-project instead of dropping them", async () => {
  const store = new MemStore();
  const root = (await appendEvent(store, { project: "p", actor: { type: "human", id: "jordan@example.com" }, action: "instructed", artifacts: [{ id: "task:1", role: "generated" }] })).event;
  await appendEvent(store, {
    project: "p", actor: { type: "agent", id: "auditor", model: "new" }, action: "other", action_detail: "amended",
    artifacts: [{ id: "event:missing", role: "used" }], caused_by: root.id,
    method: { tool: "retrace_amend", params: { target_event_id: "evt_no_such_target", attest_causal_root: true } },
  });
  const s = await buildProjectStatus(store, "p");
  assert.equal(s.capture.ineffective_amendments, 1);
  assert.equal(s.capture.amended_unlinked_commits, 0);
  assert.match(renderProjectStatus(s), /1 rejected links/);
});

test("causalRootState distinguishes missing parents and absent links", async () => {
  const store = new MemStore();
  const unlinked = (await appendEvent(store, { project: "p", actor: { type: "agent", id: "a" }, action: "edited", artifacts: [{ id: "x" }] })).event;
  const broken = { ...unlinked, id: "broken", caused_by: "missing" };
  const byId = new Map([[unlinked.id, unlinked]]);
  assert.equal(causalRootState(unlinked, byId), "unlinked");
  assert.equal(causalRootState(broken, byId), "broken");
});
