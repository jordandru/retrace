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
import { Event } from "./schema.js";

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
  type: "derived" | "flow" | "touched";
  weight: number;             // number of supporting events
  via?: string[];             // event ids supporting the edge (capped)
}
export interface Lineage { nodes: LineageNode[]; edges: LineageEdge[] }

export interface LineageOptions { includeActors?: boolean; maxVia?: number }

export function buildLineage(events: Event[], opts: LineageOptions = {}): Lineage {
  const maxVia = opts.maxVia ?? 5;
  const nodes = new Map<string, LineageNode>();
  const edges = new Map<string, LineageEdge>();
  const byId = new Map(events.map((e) => [e.id, e]));
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  const artNode = (id: string, label?: string, kind?: string, seq = 0): LineageNode => {
    let n = nodes.get("a:" + id);
    if (!n) { n = { id, type: "artifact", label: label ?? id, kind, events: 0, first_seq: seq, last_seq: seq, actors: [], actions: {} }; nodes.set("a:" + id, n); }
    if (label && n.label === n.id) n.label = label;
    if (kind && !n.kind) n.kind = kind;
    return n;
  };
  const actorNode = (e: Event): LineageNode => {
    const id = e.actor.id;
    let n = nodes.get("u:" + id);
    if (!n) { n = { id, type: "actor", label: e.actor.display_name ?? id, kind: e.actor.type, events: 0, first_seq: e.seq, last_seq: e.seq }; nodes.set("u:" + id, n); }
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
      if (!n.actors!.includes(e.actor.id)) n.actors!.push(e.actor.id);
      n.actions![e.action] = (n.actions![e.action] ?? 0) + 1;
      for (const src of a.derived_from ?? []) { artNode(src, undefined, undefined, e.seq); addEdge(src, a.id, "derived", e.id); }
      if (opts.includeActors) { const u = actorNode(e); u.events++; u.last_seq = e.seq; addEdge("u:" + e.actor.id, a.id, "touched", e.id); }
    }
    if (e.caused_by) {
      const parent = byId.get(e.caused_by);
      if (parent) {
        for (const pa of parent.artifacts) for (const ca of e.artifacts) if (pa.id !== ca.id) addEdge(pa.id, ca.id, "flow", e.id);
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Roots → leaves layering by longest path (cycles broken by seq order). Returns node id → layer. */
export function layerLineage(l: Lineage): Map<string, number> {
  const ids = l.nodes.filter((n) => n.type === "artifact").map((n) => n.id);
  const inc = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of l.edges) if (e.type !== "touched" && inc.has(e.to) && inc.has(e.from)) inc.get(e.to)!.push(e.from);
  const seq = new Map(l.nodes.map((n) => [n.id, n.first_seq]));
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

const q = (s: string) => JSON.stringify(s);

export function renderLineageDot(l: Lineage): string {
  const shape = (n: LineageNode) => n.type === "actor" ? (n.kind === "human" ? "ellipse" : "hexagon") : n.kind === "commit" ? "note" : n.kind === "task" ? "folder" : "box";
  const lines = ["digraph retrace {", "  rankdir=LR; node [fontname=Helvetica, fontsize=10]; edge [fontsize=9];"];
  for (const n of l.nodes) lines.push(`  ${q((n.type === "actor" ? "u:" : "") + n.id)} [label=${q(`${n.label}${n.type === "artifact" ? `\n${n.events} event${n.events === 1 ? "" : "s"}` : ""}`)}, shape=${shape(n)}${n.type === "actor" ? ", style=dashed" : ""}];`);
  for (const e of l.edges) lines.push(`  ${q(e.from)} -> ${q(e.to)} [label=${q(e.type === "derived" ? "derived" : e.type === "flow" ? `flow ×${e.weight}` : "")}${e.type === "derived" ? ", penwidth=2" : e.type === "touched" ? ", style=dashed, color=gray" : ""}];`);
  lines.push("}");
  return lines.join("\n");
}

export function renderLineageMermaid(l: Lineage): string {
  const idOf = new Map<string, string>(); let i = 0;
  const nid = (s: string) => { if (!idOf.has(s)) idOf.set(s, "n" + i++); return idOf.get(s)!; };
  const lines = ["graph LR"];
  for (const n of l.nodes) {
    const key = (n.type === "actor" ? "u:" : "") + n.id;
    const lbl = `${n.label}${n.type === "artifact" ? ` (${n.events})` : ""}`.replace(/"/g, "'");
    lines.push(n.type === "actor" ? `  ${nid(key)}(["${lbl}"])` : `  ${nid(key)}["${lbl}"]`);
  }
  for (const e of l.edges) lines.push(`  ${nid(e.from)} ${e.type === "derived" ? "==>" : e.type === "flow" ? "-->" : "-.->"}${e.type === "flow" && e.weight > 1 ? `|×${e.weight}|` : ""} ${nid(e.to)}`);
  return lines.join("\n");
}

export function renderLineageText(l: Lineage): string {
  const arts = l.nodes.filter((n) => n.type === "artifact");
  const out = [`${arts.length} artifacts, ${l.edges.length} edges`];
  for (const n of arts) {
    const ins = l.edges.filter((e) => e.to === n.id && e.type !== "touched").map((e) => `${e.from} (${e.type})`);
    const outs = l.edges.filter((e) => e.from === n.id && e.type !== "touched").map((e) => `${e.to} (${e.type})`);
    out.push(`- ${n.label}${n.kind ? ` [${n.kind}]` : ""} · ${n.events} ev · by ${n.actors?.join(", ")}${ins.length ? `\n    ← ${ins.join("; ")}` : ""}${outs.length ? `\n    → ${outs.join("; ")}` : ""}`);
  }
  return out.join("\n");
}
