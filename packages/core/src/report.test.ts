import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReportHtml } from "./report.js";
import { ExportBundle } from "./export.js";
import { Event } from "./schema.js";

/** Minimal sealed-looking events with attacker-controlled text in every field the "why" cell renders. */
const evt = (over: Partial<Event>): Event =>
  ({
    id: "evt_0", project: "p", seq: 0, timestamp: "2026-08-23T00:00:00Z", received_at: "2026-08-23T00:00:00Z",
    actor: { type: "human", id: "jordan@example.com" }, action: "created", artifacts: [{ id: "a" }],
    prev_hash: "0".repeat(64), hash: "f".repeat(64),
    ...over,
  }) as Event;

const bundle = (events: Event[]): ExportBundle =>
  ({ format: "retrace-export/1", generated_at: "2026-08-23T00:00:00Z", scope: { project: "p" },
     chain: { ok: true, checked: events.length, total_events: events.length }, events }) as ExportBundle;

test("report: why cell escapes intent, caused_by, causing actor name and verb (pre-auth shared-report XSS)", () => {
  const XSS = "<script>alert(1)</script>";
  const cause = evt({
    id: "evt_cause", seq: 0,
    actor: { type: "agent", id: "a1", display_name: `<img src=x onerror=alert(2)>` },
    action: "other", action_detail: `<b onclick=x>evil-verb</b>`,
  });
  const withCause = evt({ id: "evt_1", seq: 1, intent: `intent ${XSS}`, caused_by: "evt_cause" });
  const dangling = evt({ id: "evt_2", seq: 2, caused_by: `evt_<script>alert(3)</script>` });
  const html = renderReportHtml(bundle([cause, withCause, dangling]));
  assert.ok(!html.includes("<script>alert("), "raw script tags must not survive");
  assert.ok(!html.includes("<img src=x"), "raw attribute payloads must not survive");
  assert.ok(!html.includes("<b onclick"), "raw action_detail markup must not survive");
  assert.ok(html.includes("intent &lt;script&gt;alert(1)&lt;/script&gt;"), "intent is escaped, not dropped");
  assert.ok(html.includes("↳ caused by evt_&lt;script&gt;alert(3)&lt;/script&gt;"), "dangling caused_by is escaped, not dropped");
  assert.ok(html.includes("&lt;img src=x onerror=alert(2)&gt;"), "causing actor display_name is escaped, not dropped");
  // the one piece of markup the cell owns survives: the <br> join between intent and cause line
  const whyCell = html.match(/<td>intent [^<]*(?:<br>)?.*?<\/td>/s);
  assert.ok(whyCell && whyCell[0].includes("<br>"), "multi-part why keeps its <br> join");
});

test("report: artifact cells carry an in/out role marker; a role-less ref renders unchanged", () => {
  const html = renderReportHtml(bundle([evt({ artifacts: [{ id: "a", role: "used" }, { id: "b", role: "generated" }, { id: "c", role: "both" }, { id: "d" }] })]));
  assert.ok(html.includes('<small class="role">in</small><code>a</code>'));
  assert.ok(html.includes('<small class="role">out</small><code>b</code>'));
  assert.ok(html.includes('<small class="role">in/out</small><code>c</code>'));
  assert.ok(html.includes(" <code>d</code>"), "no marker for an unspecified role");
  assert.ok(!html.includes('</small><code>d</code>'));
});

test("report: row class attribute cannot be escaped out of by a hostile actor.type", () => {
  const weird = evt({ actor: { type: '"><script>alert(4)</script>' as any, id: "x" } });
  const html = renderReportHtml(bundle([weird]));
  assert.ok(!html.includes('"><script>'), "actor.type is escaped in the class attribute");
});
