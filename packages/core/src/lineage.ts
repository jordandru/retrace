/**
 * Artifact lineage graph.
 *   Nodes: artifacts (+ optionally actors).
 *   Edges:
 *     derived   — explicit ArtifactRef.derived_from (strongest signal)
 *     flow      — causal: event B (caused_by A) touched artifact Y while A touched artifact X, X≠Y  ⇒ X → Y
 *                 (e.g. human instructs on task T → agent edits file F  ⇒ T → F; agent reads F1 → then creates F2 ⇒ F1 → F2)
 *     touched   — actor → artifact (only when includeActors)
 * Pure function of events; the same code runs in the UI (embedded), MCP server and Worker.
 */
import { collectAttributionAmendments, effectiveActor, type AttributionCollection } from "./attribution.js";
import { Event } from "./schema.js";
import { eventReferenceForModel, markUntrustedText } from "./explain.js";

export interface LineageNode {
  id: string;
  type: "artifact" | "actor";
  label: string;
  kind?: string;              // file, doc, commit, task, pr, command … (artifacts) or human/agent/system (actors)
  events: number;             // how many events touched it
  first_seq: number;
  last_seq: number;
  actors?: string[];          // artifact: distinct actor ids that touched it
  actions?: Record<string, number>;
}
export interface LineageEdge {
  from: string;
  to: string;
  type: "derived" | "flow" | "touched" | "recorded-as";
  weight: number;             // number of supporting events
  via?: string[];             // event ids supporting the edge (capped)
}
export interface Lineage { nodes: LineageNode[]; edges: LineageEdge[]; attribution_unavailable?: string }

export interface LineageOptions { includeActors?: boolean; maxVia?: number; attribution?: AttributionCollection }

/**
 * Latest known label per artifact id: the label on the last event (by seq) that carries one.
 * Drive "created" events arrive titled "Untitled" and later edits/renames carry the real title,
 * so anywhere the UI names an artifact it should resolve through this. Events stay untouched —
 * an individual event keeps its own as-at label.
 */
export function latestArtifactLabels(events: Pick<Event, "seq" | "artifacts">[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq))
    for (const a of e.artifacts) if (a.label) out.set(a.id, a.label);
  return out;
}

export function buildLineage(events: Event[], opts: LineageOptions = {}): Lineage {
  const attribution=opts.attribution ?? collectAttributionAmendments(events);
  const effective = attribution.unavailable ? new Map() : attribution.effective;
  const maxVia = opts.maxVia ?? 5;
  const nodes = new Map<string, LineageNode>();
  const edges = new Map<string, LineageEdge>();
  const byId = new Map(events.map((e) => [e.id, e]));
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  const artNode = (id: string, label?: string, kind?: string, seq = 0): LineageNode => {
    let n = nodes.get("a:" + id);
    if (!n) { n = { id, type: "artifact", label: label ?? id, kind, events: 0, first_seq: seq, last_seq: seq, actors: [], actions: {} }; nodes.set("a:" + id, n); }
    if (label) n.label = label; // events arrive in seq order, so the last label seen is the latest
    if (kind && !n.kind) n.kind = kind;
    return n;
  };
  const actorNode = (e: Event): LineageNode => {
    const id = `${e.actor.type}/${e.actor.id}`;
    let n = nodes.get("u:" + id);
    if (!n) { n = { id, type: "actor", label: e.actor.display_name ?? e.actor.id, kind: e.actor.type, events: 0, first_seq: e.seq, last_seq: e.seq }; nodes.set("u:" + id, n); }
    return n;
  };
  const addEdge = (from: string, to: string, type: LineageEdge["type"], via?: string) => {
    if (from === to) return;
    const k = `${type}|${from}|${to}`;
    let ed = edges.get(k);
    if (!ed) { ed = { from, to, type, weight: 0, via: [] }; edges.set(k, ed); }
    ed.weight++;
    if (via && ed.via!.length < maxVia) ed.via!.push(via);
  };

  for (const e of sorted) {
    for (const a of e.artifacts) {
      const n = artNode(a.id, a.label, a.kind, e.seq);
      n.events++; n.last_seq = e.seq; n.first_seq = Math.min(n.first_seq, e.seq);
      const view=effectiveActor(e,effective);
      const canonical=attribution.context?.canonicalArtifact(a.id,e.seq) ?? a.id;
      const changed=view.by_artifact.get(canonical);
      const who=changed?.actor ?? e.actor;
      if (!n.actors!.includes(`${who.type}/${who.id}`)) n.actors!.push(`${who.type}/${who.id}`);
      n.actions![e.action] = (n.actions![e.action] ?? 0) + 1;
      for (const src of a.derived_from ?? []) { artNode(src, undefined, undefined, e.seq); addEdge(src, a.id, "derived", e.id); }
      if (opts.includeActors) { const u = actorNode({...e,actor:who}); u.events++; u.last_seq = e.seq; addEdge("u:" + u.id, a.id, "touched", e.id); if(changed) {const recorded=actorNode(e);addEdge("u:"+u.id,"u:"+recorded.id,"recorded-as",changed.amended.amendment_id);} }
    }
    if (e.caused_by) {
      const parent = byId.get(e.caused_by);
      if (parent) {
        for (const pa of parent.artifacts) for (const ca of e.artifacts) if (pa.id !== ca.id) addEdge(pa.id, ca.id, "flow", e.id);
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], ...(attribution.unavailable?{attribution_unavailable:attribution.unavailable}:{}) };
}

/** Roots → leaves layering by longest path (cycles broken by seq order). Returns node id → layer. */
export function layerLineage(l: Lineage): Map<string, number> {
  const ids = l.nodes.filter((n) => n.type === "artifact").map((n) => n.id);
  const inc = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of l.edges) if (e.type !== "touched" && inc.has(e.to) && inc.has(e.from)) inc.get(e.to)!.push(e.from);
  const seq = new Map(l.nodes.filter((n) => n.type === "artifact").map((n) => [n.id, n.first_seq]));
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const p of inc.get(id) ?? []) if ((seq.get(p) ?? 0) <= (seq.get(id) ?? 0)) d = Math.max(d, depth(p) + 1);
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  for (const id of ids) depth(id);
  return layer;
}

export type ModelLineage = {
  attribution_unavailable?: string;
  nodes: Array<{
    key: string;
    type: LineageNode["type"];
    label_display: string;
    kind_display?: string;
    events: number;
    first_seq: number;
    last_seq: number;
    actors_display?: string[];
    actions?: Record<string, number>;
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: LineageEdge["type"];
    weight: number;
    via?: string[];
  }>;
};

const lineageNodeKey = (type: LineageNode["type"], id: string) => `${type}\0${id}`;
const touchedActorId = (edge: LineageEdge) =>
  (edge.type === "touched" || edge.type === "recorded-as") && edge.from.startsWith("u:") ? edge.from.slice(2) : edge.from;

export function lineageForModel(lineage: Lineage): ModelLineage {
  const keys = new Map<string, string>();
  lineage.nodes.forEach((node, index) => keys.set(lineageNodeKey(node.type, node.id), `n${index}`));
  const keyFor = (type: LineageNode["type"], id: string) => keys.get(lineageNodeKey(type, id)) ?? "missing";
  return {
    ...(lineage.attribution_unavailable ? { attribution_unavailable: markUntrustedText(lineage.attribution_unavailable) } : {}),
    nodes: lineage.nodes.map((node) => ({
      key: keyFor(node.type, node.id),
      type: node.type,
      label_display: markUntrustedText(node.label),
      ...(node.kind === undefined ? {} : { kind_display: markUntrustedText(node.kind) }),
      events: node.events,
      first_seq: node.first_seq,
      last_seq: node.last_seq,
      ...(node.actors === undefined ? {} : { actors_display: node.actors.map(markUntrustedText) }),
      ...(node.actions === undefined ? {} : { actions: node.actions }),
    })),
    edges: lineage.edges.map((edge) => ({
      from: keyFor(edge.type === "touched" || edge.type === "recorded-as" ? "actor" : "artifact", touchedActorId(edge)),
      to: keyFor(edge.type === "recorded-as" ? "actor" : "artifact", edge.type === "recorded-as" ? edge.to.slice(2) : edge.to),
      type: edge.type,
      weight: edge.weight,
      ...(edge.via === undefined ? {} : { via: edge.via.map(eventReferenceForModel) }),
    })),
  };
}

const q = (s: string) => JSON.stringify(s);

export function renderLineageDot(l: Lineage): string {
  const shape = (n: LineageNode) => n.type === "actor" ? (n.kind === "human" ? "ellipse" : "hexagon") : n.kind === "commit" ? "note" : n.kind === "task" ? "folder" : "box";
  const ids = new Map<string, string>(); let i = 0;
  const nodeId = (type: LineageNode["type"], id: string) => {
    const key = lineageNodeKey(type, id);
    if (!ids.has(key)) ids.set(key, `n${i++}`);
    return ids.get(key)!;
  };
  const lines = ["digraph retrace {", "  rankdir=LR; node [fontname=Helvetica, fontsize=10]; edge [fontsize=9];"];
  if (l.attribution_unavailable) lines.push(`  label=${q(`attribution evaluation unavailable: ${markUntrustedText(l.attribution_unavailable)}`)};`);
  for (const n of l.nodes) lines.push(`  ${q(nodeId(n.type, n.id))} [label=${q(`${markUntrustedText(n.label)}${n.type === "artifact" ? `\n${n.events} event${n.events === 1 ? "" : "s"}` : ""}`)}, shape=${shape(n)}${n.type === "actor" ? ", style=dashed" : ""}];`);
  for (const e of l.edges) {
    const fromType = e.type === "touched" || e.type === "recorded-as" ? "actor" : "artifact";
    const fromId = touchedActorId(e);
    lines.push(`  ${q(nodeId(fromType, fromId))} -> ${q(nodeId(e.type === "recorded-as" ? "actor" : "artifact", e.type === "recorded-as" ? e.to.slice(2) : e.to))} [label=${q(e.type === "derived" ? "derived" : e.type === "flow" ? `flow ×${e.weight}` : e.type === "recorded-as" ? "recorded-as" : "")}${e.type === "derived" ? ", penwidth=2" : e.type === "touched" || e.type === "recorded-as" ? ", style=dashed, color=gray" : ""}];`);
  }
  lines.push("}");
  return lines.join("\n");
}

export function renderLineageMermaid(l: Lineage): string {
  const idOf = new Map<string, string>(); let i = 0;
  const nid = (type: LineageNode["type"], id: string) => {
    const key = lineageNodeKey(type, id);
    if (!idOf.has(key)) idOf.set(key, "n" + i++);
    return idOf.get(key)!;
  };
  const lines = ["graph LR"];
  if (l.attribution_unavailable) lines.push(`  attribution_notice["attribution evaluation unavailable: ${markUntrustedText(l.attribution_unavailable).replace(/[^a-zA-Z0-9 :_-]/g, " ")}"]`);
  for (const n of l.nodes) {
    const lbl = `${markUntrustedText(n.label)}${n.type === "artifact" ? ` (${n.events})` : ""}`.replace(/"/g, "'");
    lines.push(n.type === "actor" ? `  ${nid(n.type, n.id)}(["${lbl}"])` : `  ${nid(n.type, n.id)}["${lbl}"]`);
  }
  for (const e of l.edges) {
    const fromType = e.type === "touched" || e.type === "recorded-as" ? "actor" : "artifact";
    const fromId = touchedActorId(e);
    lines.push(`  ${nid(fromType, fromId)} ${e.type === "derived" ? "==>" : e.type === "flow" ? "-->" : "-.->"}${e.type === "flow" && e.weight > 1 ? `|×${e.weight}|` : ""} ${nid(e.type === "recorded-as" ? "actor" : "artifact", e.type === "recorded-as" ? e.to.slice(2) : e.to)}`);
  }
  return lines.join("\n");
}

export function renderLineageText(l: Lineage): string {
  const arts = l.nodes.filter((n) => n.type === "artifact");
  const out = [...(l.attribution_unavailable ? [`attribution evaluation unavailable: ${l.attribution_unavailable}`] : []), `${arts.length} artifacts, ${l.edges.length} edges`];
  for (const n of arts) {
    const ins = l.edges.filter((e) => e.to === n.id && e.type !== "touched").map((e) => `${markUntrustedText(e.from)} (${e.type})`);
    const outs = l.edges.filter((e) => e.from === n.id && e.type !== "touched").map((e) => `${markUntrustedText(e.to)} (${e.type})`);
    const kind = n.kind ? ` [${markUntrustedText(n.kind)}]` : "";
    const actors = n.actors?.map(markUntrustedText).join(", ");
    out.push(`- ${markUntrustedText(n.label)}${kind} · ${n.events} ev · by ${actors}${ins.length ? `\n    ← ${ins.join("; ")}` : ""}${outs.length ? `\n    → ${outs.join("; ")}` : ""}`);
  }
  return out.join("\n");
}
