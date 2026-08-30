/** Printable provenance report (HTML → "Save as PDF" in any browser). Self-contained, no scripts required. */
import { ExportBundle, ExportVerdict } from "./export.js";
import { latestArtifactLabels } from "./lineage.js";
import { roleMark } from "./explain.js";
import { Event } from "./schema.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const actorName = (e: Event) => e.actor.display_name ?? e.actor.id;
const verb = (e: Event) => (e.action === "other" ? e.action_detail ?? "acted on" : e.action);

export function renderReportHtml(bundle: ExportBundle, verdict?: ExportVerdict, opts: { title?: string; baseUrl?: string } = {}): string {
  const title = opts.title ?? `Provenance report — ${bundle.scope.project}${bundle.scope.artifact_id ? " · " + bundle.scope.artifact_id : ""}`;
  const events = [...bundle.events].sort((a, b) => a.seq - b.seq);
  const byId = new Map(events.map((e) => [e.id, e]));
  const labels = latestArtifactLabels(events);
  const humans = new Set(events.filter((e) => e.actor.type === "human").map((e) => e.actor.id));
  const agents = new Set(events.filter((e) => e.actor.type === "agent").map((e) => e.actor.id));
  const arts = new Set(events.flatMap((e) => e.artifacts.map((a) => a.id)));
  const first = events[0]?.timestamp, last = events.at(-1)?.timestamp;
  const sigLine = !bundle.signature ? "unsigned" : verdict ? (verdict.signature === "valid" ? "valid" : "INVALID") : "present (not verified here)";
  const chainLine = bundle.chain.ok ? `intact — ${bundle.chain.checked} of ${bundle.chain.total_events} events verified at export` : `BROKEN at #${bundle.chain.first_bad_seq}: ${bundle.chain.reason}`;
  // Omission: a chain proves present events were not altered; coverage says whether any were left out (full exports only).
  const cov = verdict?.coverage;
  const coverageLine = !cov ? "not verified here"
    : cov.scope === "scoped" ? `scoped — ${cov.events} of ${cov.total_events} project events; omission within the scope is not checkable offline`
    : cov.complete ? `complete — all ${cov.total_events} events present, contiguous, ending at the claimed head`
    : `INCOMPLETE — ${cov.events} of ${cov.total_events} claimed events${cov.missing_seqs?.length ? " (missing #" + cov.missing_seqs.slice(0, 10).join(", #") + (cov.missing_seqs.length > 10 ? " …" : "") + ")" : ""}`;
  const coverageClass = !cov || cov.scope === "scoped" ? "" : cov.complete ? "ok" : "bad";

  const rows = events.map((e) => {
    const cause = e.caused_by ? byId.get(e.caused_by) : undefined;
    // each part is escaped individually (intent, actor names, verbs and caused_by ids are caller-supplied) and only
    // then joined with a literal <br> — the one piece of markup this cell is allowed to contain
    const why = [e.intent, cause ? `↳ because #${cause.seq} (${actorName(cause)} ${verb(cause)})` : e.caused_by ? `↳ caused by ${e.caused_by}` : ""].filter(Boolean).map(esc).join("<br>");
    const where = [e.location?.system, e.location?.environment, e.location?.path ?? e.location?.url].filter(Boolean).join(" · ");
    const how = [e.method?.tool, e.method?.automated == null ? "" : e.method.automated ? "automated" : "manual", e.method?.tokens != null ? `${e.method.tokens} tokens` : ""].filter(Boolean).join(" · ");
    return `<tr class="${esc(e.actor.type)}">
      <td class="mono">#${e.seq}<br><small>${esc(new Date(e.timestamp).toISOString().replace("T", " ").slice(0, 19))}Z</small></td>
      <td><b>${esc(actorName(e))}</b><br><small>${esc(e.actor.type)}${e.actor.model ? " · " + esc(e.actor.model) : ""}${e.actor.on_behalf_of ? "<br>for " + esc(e.actor.on_behalf_of) : ""}</small></td>
      <td><b>${esc(verb(e))}</b> ${e.artifacts.map((a) => `${roleMark(a.role) ? `<small class="role">${roleMark(a.role)}</small>` : ""}<code>${esc(labels.get(a.id) ?? a.label ?? a.id)}</code>`).join(" ")}${e.change?.summary ? `<br><small>${esc(e.change.summary)}</small>` : ""}</td>
      <td><small>${esc(where)}</small></td>
      <td>${why}</td>
      <td><small>${esc(how)}</small></td>
      <td class="mono"><small>${esc(e.hash.slice(0, 12))}…</small></td>
    </tr>`;
  }).join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
 body{font:12px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:32px;max-width:1100px}
 h1{font-size:20px;margin:0 0 4px} h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#666;margin:22px 0 8px}
 .meta{display:grid;grid-template-columns:140px 1fr;gap:4px 12px;font-size:12px} .meta .k{color:#666}
 table{border-collapse:collapse;width:100%;font-size:11.5px} th,td{border-top:1px solid #ddd;padding:6px 6px;vertical-align:top;text-align:left}
 th{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:#666;border-top:0}
 tr.human td:first-child{border-left:3px solid #f2a93b} tr.agent td:first-child{border-left:3px solid #5aa9ff} tr.system td:first-child{border-left:3px solid #9aa3b5}
 code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;background:#f2f3f5;padding:0 3px;border-radius:3px}
 .mono{font-family:ui-monospace,Menlo,Consolas,monospace} small{color:#555}
 .role{font-size:8.5px;text-transform:uppercase;letter-spacing:.05em;color:#777;margin-right:2px;vertical-align:middle}
 .ok{color:#178f4f;font-weight:600} .bad{color:#d1303f;font-weight:600}
 .box{border:1px solid #ddd;border-radius:6px;padding:10px 12px;background:#fafbfc}
 .print{position:fixed;top:12px;right:12px;padding:8px 12px;border:1px solid #bbb;border-radius:6px;background:#fff;cursor:pointer}
 @media print{.print{display:none} body{margin:12mm}}
</style></head><body>
<button class="print" onclick="window.print()">Print / Save as PDF</button>
<h1>${esc(title)}</h1>
<div><small>Generated ${esc(bundle.generated_at)} · Retrace ${esc(bundle.format)}</small></div>

<h2>Summary</h2>
<div class="meta">
  <div class="k">Project</div><div>${esc(bundle.scope.project)}</div>
  ${bundle.scope.artifact_id ? `<div class="k">Artifact</div><div><code>${esc(bundle.scope.artifact_id)}</code></div>` : ""}
  <div class="k">Events</div><div>${events.length}${bundle.context_events ? ` (${bundle.context_events} included as causal context)` : ""}${first ? ` — from ${esc(first)} to ${esc(last)}` : ""}</div>
  <div class="k">Actors</div><div>${[humans.size ? `${humans.size} human${humans.size === 1 ? "" : "s"} (${esc([...humans].join(", "))})` : "", agents.size ? `${agents.size} agent${agents.size === 1 ? "" : "s"} (${esc([...agents].join(", "))})` : ""].filter(Boolean).join("; ") || "—"}</div>
  <div class="k">Artifacts</div><div>${arts.size}</div>
  <div class="k">Chain integrity</div><div class="${bundle.chain.ok ? "ok" : "bad"}">${esc(chainLine)}</div>
  <div class="k">Coverage</div><div class="${coverageClass}">${esc(coverageLine)}</div>
  <div class="k">Signature</div><div class="${sigLine === "valid" ? "ok" : sigLine === "INVALID" ? "bad" : ""}">${esc(sigLine)}${bundle.issuer ? ` · Ed25519 key <span class="mono">${esc(bundle.issuer.kid)}</span>${bundle.issuer.name ? " · " + esc(bundle.issuer.name) : ""}` : ""}</div>
  ${bundle.chain.head_hash ? `<div class="k">Head hash</div><div class="mono">${esc(bundle.chain.head_hash)}</div>` : ""}
</div>

<h2>Timeline — who · what · where · why · how</h2>
<table><thead><tr><th>#/when (UTC)</th><th>who</th><th>what</th><th>where</th><th>why</th><th>how</th><th>hash</th></tr></thead><tbody>
${rows}
</tbody></table>

<h2>How to verify this report</h2>
<div class="box">
  Each event is hashed (SHA-256) together with the previous event's hash, so any alteration or deletion breaks the chain. The JSON bundle this report was rendered from is signed with the issuer's Ed25519 key${bundle.issuer ? ` (kid <span class="mono">${esc(bundle.issuer.kid)}</span>)` : ""}.
  Verify offline with <code>retrace-export verify bundle.json</code>${opts.baseUrl ? `, or fetch the issuer's public key from <code>${esc(opts.baseUrl)}/.well-known/retrace-pubkey</code>` : ""}.
  ${bundle.issuer ? `<br><br>Issuer public key (JWK): <span class="mono">${esc(JSON.stringify(bundle.issuer.public_key))}</span>` : ""}
  ${bundle.signature ? `<br>Signature: <span class="mono" style="word-break:break-all">${esc(bundle.signature)}</span>` : ""}
</div>
</body></html>`;
}
