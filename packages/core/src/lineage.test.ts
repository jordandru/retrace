import { test } from "node:test";
import assert from "node:assert/strict";
import { sealEvent, buildLineage, layerLineage, latestArtifactLabels, renderLineageDot, renderLineageMermaid, renderLineageText, renderReportHtml, EventInput, Event } from "./index.js";

async function chain(inputs: EventInput[]): Promise<Event[]> {
  const out: Event[] = []; let prev: { seq: number; hash: string } | null = null;
  for (const i of inputs) { const e = await sealEvent(i, prev); out.push(e); prev = { seq: e.seq, hash: e.hash }; }
  return out;
}

test("lineage: derived + causal flow edges, layering, renderers", async () => {
  const base = { project: "p" } as const;
  const [ins] = await chain([{ ...base, actor: { type: "human", id: "jordan" }, action: "instructed", artifacts: [{ id: "task:jab", kind: "task", label: "Jab counter" }] }]);
  const rest = await chain([
    { ...base, actor: { type: "agent", id: "claude" }, action: "read", artifacts: [{ id: "f:loop", kind: "file" }], caused_by: ins.id },
  ]);
  // rebuild as one chain for simplicity
  const events = await chain([
    { ...base, actor: { type: "human", id: "jordan" }, action: "instructed", artifacts: [{ id: "task:jab", kind: "task", label: "Jab counter" }] },
  ]);
  const e0 = events[0];
  const e1 = await sealEvent({ ...base, actor: { type: "agent", id: "claude" }, action: "read", artifacts: [{ id: "f:loop", kind: "file" }], caused_by: e0.id }, { seq: 0, hash: e0.hash });
  const e2 = await sealEvent({ ...base, actor: { type: "agent", id: "claude" }, action: "created", artifacts: [{ id: "f:hud", kind: "file", derived_from: ["f:loop"] }], caused_by: e1.id }, { seq: 1, hash: e1.hash });
  const e3 = await sealEvent({ ...base, actor: { type: "human", id: "jordan" }, action: "approved", artifacts: [{ id: "pr:57", kind: "pr" }], caused_by: e2.id }, { seq: 2, hash: e2.hash });
  const all = [e0, e1, e2, e3];
  void rest;

  const l = buildLineage(all);
  const arts = l.nodes.filter((n) => n.type === "artifact").map((n) => n.id).sort();
  assert.deepEqual(arts, ["f:hud", "f:loop", "pr:57", "task:jab"]);
  const has = (from: string, to: string, type: string) => l.edges.some((e) => e.from === from && e.to === to && e.type === type);
  assert.ok(has("f:loop", "f:hud", "derived"), "explicit derived_from");
  assert.ok(has("task:jab", "f:loop", "flow"), "instruction → read");
  assert.ok(has("f:loop", "f:hud", "flow"), "read → create (causal)");
  assert.ok(has("f:hud", "pr:57", "flow"), "create → approve");
  assert.equal(l.nodes.find((n) => n.id === "f:hud")!.actors!.join(), "claude");

  const layers = layerLineage(l);
  assert.equal(layers.get("task:jab"), 0);
  assert.equal(layers.get("f:loop"), 1);
  assert.equal(layers.get("f:hud"), 2);
  assert.equal(layers.get("pr:57"), 3);

  const withActors = buildLineage(all, { includeActors: true });
  assert.ok(withActors.nodes.some((n) => n.type === "actor" && n.id === "claude"));
  assert.ok(withActors.edges.some((e) => e.type === "touched" && e.from === "u:claude" && e.to === "f:hud"));

  assert.match(renderLineageDot(l), /digraph retrace/);
  assert.match(renderLineageMermaid(l), /graph LR/);
  assert.match(renderLineageText(l), /4 artifacts/);
});

test("latest label: created 'Untitled' → renamed; resolver, graph nodes and report use it, events keep as-at labels", async () => {
  const base = { project: "p", actor: { type: "human", id: "jordan" } } as const;
  const doc = (label?: string) => [{ id: "gdoc:D1", kind: "doc" as const, ...(label ? { label } : {}) }];
  const events = await chain([
    { ...base, action: "created", artifacts: doc("Untitled") },
    { ...base, action: "renamed", artifacts: doc("Dogfood log") },
    { ...base, action: "edited", artifacts: doc() }, // no label — must not clear the latest one
  ]);

  const labels = latestArtifactLabels(events);
  assert.equal(labels.get("gdoc:D1"), "Dogfood log");
  // order-independent: resolution sorts by seq itself
  assert.equal(latestArtifactLabels([...events].reverse()).get("gdoc:D1"), "Dogfood log");
  // the events themselves keep their as-at labels
  assert.equal(events[0].artifacts[0].label, "Untitled");

  const node = buildLineage(events).nodes.find((n) => n.id === "gdoc:D1")!;
  assert.equal(node.label, "Dogfood log");

  const html = renderReportHtml({ format: "retrace-export/1", generated_at: events[0].timestamp, scope: { project: "p" }, chain: { ok: true, checked: events.length, total_events: events.length }, events });
  assert.equal((html.match(/<code>Dogfood log<\/code>/g) ?? []).length, 3, "every report row names the artifact by its latest label");
  assert.ok(!html.includes("<code>Untitled</code>"));
});
