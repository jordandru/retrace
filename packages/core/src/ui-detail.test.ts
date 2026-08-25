import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// Drives the real inline <script> from ui/retrace.html against a stub DOM: fixture
// events arrive through the stubbed fetch, a timeline row is clicked, and the
// assertions run on the detail pane's innerHTML.

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../ui/retrace.html"), "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)![1];

function runUI(events: any[]) {
  const clicks: ((ev: any) => void)[] = [];
  const els = new Map<string, any>();
  const makeEl = (): any => ({
    innerHTML: "", value: "", textContent: "", title: "", style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, querySelector: () => makeEl(), querySelectorAll: () => [],
    lastElementChild: { textContent: "" }, clientWidth: 1000,
  });
  const $ = (sel: string) => { if (!els.has(sel)) els.set(sel, makeEl()); return els.get(sel); };
  const doc = {
    querySelector: $,
    addEventListener: (type: string, fn: any) => { if (type === "click") clicks.push(fn); },
    createElement: () => makeEl(),
    body: { classList: { add() {} } },
    visibilityState: "hidden",
  };
  const fetchStub = async (url: any) => {
    const path = String(url);
    const body = path.includes("/verify") ? { ok: true, checked: events.length }
      : path.includes("/events") ? events
      : ["p"];
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  };
  new Function("document", "location", "fetch", "setInterval", "setTimeout", "URLSearchParams", "CSS", "window", "navigator", script)(
    doc, { search: "", pathname: "/", origin: "http://t" }, fetchStub, () => 0, setTimeout, URLSearchParams, { escape: (s: string) => s }, {}, {});
  const select = async (id: string): Promise<string> => {
    await new Promise((r) => setTimeout(r, 10)); // let boot() settle
    clicks[0]({ target: { closest: () => ({ dataset: { id }, classList: { contains: (c: string) => c === "ev" } }) }, stopPropagation() {}, preventDefault() {} });
    return $("#detail").innerHTML;
  };
  return { select, timeline: () => $("#timeline").innerHTML as string };
}

const ev = (seq: number, over: any) => ({
  project: "p",
  actor: { type: "agent", id: "claude-code", model: "claude-fable-5", on_behalf_of: "j@example.com" },
  action: "edited",
  artifacts: [{ id: "repo:x#f", kind: "file", label: "f" }],
  timestamp: "2026-08-20T18:41:04.000Z", received_at: "2026-08-20T18:46:18.000Z",
  id: `evt_${seq}`, seq, prev_hash: "0", hash: `h${seq}`,
  ...over,
});

const section = (detail: string, k: string) => {
  const m = detail.match(new RegExp(`<div class="k">${k}</div><div class="v[^"]*">([\\s\\S]*?)</div>\\n`));
  return m ? m[1] : null;
};

test("detail pane: git-hook committed event renders where, how and tags", async () => {
  const events = [ev(0, {
    action: "committed",
    location: { path: "/home/j/retrace", environment: "local", device: "JordansLaptop", system: "git" },
    method: { tool: "git", params: { branch: "main", sha: "abc" }, automated: true },
    tags: ["git"],
    intent: "ship the fix",
  })];
  const detail = await runUI(events).select("evt_0");
  assert.match(section(detail, "Where")!, /git · local · \/home\/j\/retrace · JordansLaptop/);
  assert.match(section(detail, "How")!, /<b>git<\/b>/);
  assert.match(section(detail, "How")!, /automated/);
  assert.match(section(detail, "Tags")!, /class="chip">git</);
  assert.ok(!detail.includes("(not recorded)"));
});

test("detail pane: sections without data say '(not recorded)' instead of vanishing", async () => {
  // The shape of an MCP retrace_log event logged without location/tags (e.g. a git push).
  const events = [ev(0, { action: "sent", method: { tool: "git push", automated: true } })];
  const detail = await runUI(events).select("evt_0");
  assert.match(section(detail, "Where")!, /\(not recorded\)/);
  assert.match(section(detail, "Tags")!, /\(not recorded\)/);
  assert.match(section(detail, "Why")!, /\(not recorded\)/);
  assert.match(section(detail, "How")!, /<b>git push<\/b>/);
  // The shape of the worker's ops audit event: no location, no method, no tags.
  const bare = await runUI([ev(1, { actor: { type: "system", id: "worker" }, action: "deleted", intent: "project deleted" })]).select("evt_1");
  for (const k of ["Where", "How", "Tags"]) assert.match(section(bare, k)!, /\(not recorded\)/);
  assert.match(section(bare, "Why")!, /project deleted/);
});

test("detail pane: gdrive renamed event renders", async () => {
  const events = [ev(0, {
    action: "renamed",
    artifacts: [{ id: "gdrive:doc1", kind: "document", label: "Fight Plan v2" }],
    location: { system: "gdrive", url: "https://docs.google.com/document/d/doc1" },
    method: { tool: "google-drive", automated: false },
  })];
  const detail = await runUI(events).select("evt_0");
  assert.match(section(detail, "What")!, /<b>renamed<\/b>/);
  assert.match(section(detail, "Where")!, /gdrive · https:\/\/docs.google.com/);
});

test("artifact chips: timeline and detail carry an in/out role marker; a role-less ref has none", async () => {
  const events = [ev(0, {
    artifacts: [
      { id: "repo:x#a", kind: "file", label: "a", role: "used" },
      { id: "repo:x#b", kind: "file", label: "b", role: "generated" },
      { id: "repo:x#c", kind: "file", label: "c", role: "both" },
      { id: "repo:x#d", kind: "file", label: "d" },
    ],
  })];
  const ui = runUI(events);
  const detail = await ui.select("evt_0");
  for (const html of [ui.timeline(), section(detail, "What")!]) {
    assert.ok(html.includes('<i class="role">in</i>a</span>'), "used → in");
    assert.ok(html.includes('<i class="role">out</i>b</span>'), "generated → out");
    assert.ok(html.includes('<i class="role">in/out</i>c</span>'), "both → in/out");
    assert.ok(html.includes('data-art="repo:x#d" title="repo:x#d">d</span>'), "unspecified → plain chip");
    assert.ok(html.includes('title="repo:x#a · used (input)"'));
  }
});

test("detail pane: one unrenderable section never blanks the rest", async () => {
  const params: any = { branch: "main" }; params.self = params; // JSON.stringify throws
  const events = [ev(0, {
    location: { system: "git", path: "/x" },
    method: { tool: "git", params, automated: true },
    tags: ["git"],
    intent: "still visible",
  })];
  const detail = await runUI(events).select("evt_0");
  assert.match(section(detail, "How")!, /could not render/);
  assert.match(section(detail, "Where")!, /git · \/x/);
  assert.match(section(detail, "Why")!, /still visible/);
  assert.match(section(detail, "Tags")!, /class="chip">git</);
  assert.ok(detail.includes("raw JSON")); // the guarded raw-JSON block rendered too
});
