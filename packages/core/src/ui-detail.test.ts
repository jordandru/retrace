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

function runUI(events: any[], opts: { status?: any; search?: string; apiTokens?: Record<string, string>; historyPage?: { truncated?: boolean; next_before_seq?: number } } = {}) {
  const clicks: ((ev: any) => void)[] = [];
  const els = new Map<string, any>();
  const makeEl = (): any => {
    const listeners = new Map<string, (ev: any) => void>();
    const el: any = {
      innerHTML: "", value: "", textContent: "", title: "", style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener(type: string, fn: (ev: any) => void) { listeners.set(type, fn); },
      dispatch(type: string) { return listeners.get(type)?.({ target: el }); },
      querySelector: () => makeEl(), querySelectorAll: () => [],
      lastElementChild: { textContent: "" }, clientWidth: 1000,
    };
    return el;
  };
  const $ = (sel: string) => { if (!els.has(sel)) els.set(sel, makeEl()); return els.get(sel); };
  const doc = {
    querySelector: $,
    addEventListener: (type: string, fn: any) => { if (type === "click") clicks.push(fn); },
    createElement: () => makeEl(),
    body: { classList: { add() {} } },
    visibilityState: "hidden",
  };
  const apiTokens = new Map(Object.entries(opts.apiTokens ?? {}));
  const replacedUrls: string[] = [];
  const windowStub = {
    localStorage: {
      getItem: (key: string) => apiTokens.get(key) ?? null,
      setItem: (key: string, value: string) => apiTokens.set(key, value),
      removeItem: (key: string) => apiTokens.delete(key),
    },
    history: { replaceState: (_state: any, _title: string, url: string) => replacedUrls.push(url) },
  };
  const locationStub = { search: opts.search ?? "", pathname: "/", origin: "http://t", hash: "", href: `http://t/${opts.search ?? ""}` };
  const fetchStub = async (url: any) => {
    const path = String(url);
    const body = path.includes("/verify") ? { ok: true, checked: events.length }
      : path.includes("/status") ? (opts.status ?? null)
      : path.includes("/events") ? (opts.historyPage ? { events, truncated: !!opts.historyPage.truncated, next_before_seq: opts.historyPage.next_before_seq } : events)
      : ["p"];
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  };
  // Timers the UI arms (the toast auto-hide) must not keep the test process alive.
  const timer = (fn: any, ms: number) => { const t = setTimeout(fn, ms); t.unref(); return t; };
  new Function("document", "location", "fetch", "setInterval", "setTimeout", "URLSearchParams", "CSS", "window", "navigator", script)(
    doc, locationStub, fetchStub, () => 0, timer, URLSearchParams, { escape: (s: string) => s }, windowStub, {});
  const select = async (id: string): Promise<string> => {
    await new Promise((r) => setTimeout(r, 10)); // let boot() settle
    clicks[0]({ target: { closest: () => ({ dataset: { id }, classList: { contains: (c: string) => c === "ev" } }) }, stopPropagation() {}, preventDefault() {} });
    return $("#detail").innerHTML;
  };
  /** Click a rendered chip. `closest(selector)` is honoured for real: the element matches only if the delegated
   *  selector actually lists one of its data-attributes — which is exactly how a handler branch whose attribute is
   *  missing from that selector shows up as dead (it did: [data-q] was absent, so the chips were inert). */
  const clickChip = async (dataset: Record<string, string>) => {
    const el = { dataset, classList: { contains: () => false } };
    const closest = (sel: string) => (Object.keys(dataset).some((k) => sel.includes(`[data-${k}]`)) ? el : null);
    clicks[0]({ target: { closest }, stopPropagation() {}, preventDefault() {} });
  };
  return {
    select, clickChip,
    search: () => $("#q").value as string, setSearch: (v: string) => { $("#q").value = v; },
    ftype: () => $("#ftype").value as string,
    timeline: () => $("#timeline").innerHTML as string, detail: () => $("#detail").innerHTML as string,
    toast: () => $("#toast").textContent as string,
    tokenInput: () => $("#apiTok").value as string,
    storedToken: (key: string) => apiTokens.get(key),
    replacedUrl: () => replacedUrls.at(-1),
    connect: (base: string, nextToken: string) => { $("#apiUrl").value = base; $("#apiTok").value = nextToken; $("#connect").dispatch("click"); },
  };
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

test("connection token: a query bootstrap is stored per API endpoint and scrubbed from browser history", () => {
  assert.match(html, /<meta name="referrer" content="no-referrer" \/>/);
  const ui = runUI([], { search: "?project=p&token=one-time-secret" });
  assert.equal(ui.tokenInput(), "one-time-secret");
  assert.equal(ui.storedToken("retrace.ui.token:http://t"), "one-time-secret");
  assert.equal(ui.replacedUrl(), "/?project=p");
});

test("connection token: a saved endpoint token is restored, updated, and cleared from settings", () => {
  const remoteKey = "retrace.ui.token:https://api.example.test";
  const ui = runUI([], {
    search: "?api=https%3A%2F%2Fapi.example.test",
    apiTokens: { [remoteKey]: "remembered-secret" },
  });
  assert.equal(ui.tokenInput(), "remembered-secret");
  ui.connect("https://next.example.test/", "replacement-secret");
  assert.equal(ui.storedToken("retrace.ui.token:https://next.example.test"), "replacement-secret");
  ui.connect("https://next.example.test", "");
  assert.equal(ui.storedToken("retrace.ui.token:https://next.example.test"), undefined);
});

test("connection token: report and export URLs never include the credential", () => {
  const exportLine = script.match(/exportUrl:[^\n]+/)?.[0] ?? "";
  const reportLine = script.match(/reportUrl:[^\n]+/)?.[0] ?? "";
  assert.ok(exportLine && reportLine);
  assert.doesNotMatch(exportLine, /token/);
  assert.doesNotMatch(reportLine, /token/);
});

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
  assert.match(section(detail, "Tags")!, /class="chip" data-q="git"[^>]*>git</);
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
  assert.match(section(detail, "Tags")!, /class="chip" data-q="git"[^>]*>git</);
  assert.ok(detail.includes("raw JSON")); // the guarded raw-JSON block rendered too
});

test("detail pane: WHERE carries the MCP client, the IDE workspace, the session and the terminal surface", async () => {
  const events = [ev(0, {
    action: "committed",
    location: {
      path: "/home/j/retrace", environment: "local", device: "JordansLaptop", system: "git",
      client: "claude-code@2.1.250", ide: "orca", workspace: "wt_feature_x",
      session: "e09a0ccf-5eef-4c17-bc88-284d03d778e2", surface: "agent",
    },
  })];
  const detail = await runUI(events).select("evt_0");
  const where = section(detail, "Where")!;
  // client is APPENDED to the one-line summary: the existing assertions on that line are substring matches.
  assert.match(where, /git · local · \/home\/j\/retrace · JordansLaptop · claude-code@2\.1\.250/);
  assert.match(where, /in <b>orca<\/b>/);
  assert.match(where, /workspace <span class="chip" data-q="wt_feature_x"/);
  assert.match(where, /session <span class="chip" data-q="e09a0ccf-5eef-4c17-bc88-284d03d778e2"/);
  assert.match(where, /no terminal · agent-driven/);
});

test("detail pane: a human's terminal commit says so, and a location without the new fields renders exactly as before", async () => {
  const tty = await runUI([ev(0, { location: { system: "git", path: "/x", surface: "tty" } })]).select("evt_0");
  assert.match(section(tty, "Where")!, /at a terminal/);
  // Absent = says nothing at all; no empty "workspace"/"session" scaffolding, no "(not recorded)" for the section.
  const bare = await runUI([ev(0, { location: { system: "git", path: "/x" } })]).select("evt_0");
  assert.equal(section(bare, "Where")!.trim(), "git · /x");
});

test("detail pane: clicking a session or workspace chip actually searches for it", async () => {
  const ui = runUI([ev(0, { location: { system: "git", session: "sess-abc", workspace: "wt_feature_x" } })]);
  const where = section(await ui.select("evt_0"), "Where")!;
  assert.match(where, /data-q="sess-abc"/);
  await ui.clickChip({ q: "sess-abc" });
  assert.equal(ui.search(), "sess-abc", "the chip must reach the search box — asserting the markup alone missed that [data-q] was not in the delegated click selector");
  await ui.clickChip({ q: "wt_feature_x" });
  assert.equal(ui.search(), "wt_feature_x");
});

// ---- "looks clickable, does nothing" regressions. Each of these was inert before 2026-08-29: the markup had the
// affordance (cursor, hover, chip styling) but no branch in the delegated click handler, or the branch changed state
// that nothing on screen reflected.

test("tag chips search for the tag", async () => {
  const ui = runUI([ev(0, { tags: ["git", "release"] })]);
  const detail = await ui.select("evt_0");
  assert.match(section(detail, "Tags")!, /data-q="release"/);
  await ui.clickChip({ q: "release" });
  assert.equal(ui.search(), "release");
});

test("actor names filter the timeline, and clicking the active one again clears it", async () => {
  const ui = runUI([ev(0, {}), ev(1, { actor: { type: "human", id: "j@example.com" }, action: "instructed" })]);
  const detail = await ui.select("evt_0");
  assert.match(section(detail, "Who")!, /class="who" data-actor="claude-code"/);
  await ui.clickChip({ actor: "claude-code" });
  assert.match(ui.timeline(), /actor: <span class="chip" data-clear="actor"/);
  assert.ok(!ui.timeline().includes('data-id="evt_1"'), "the human's event is filtered out");
  await ui.clickChip({ actor: "claude-code" });
  assert.ok(!ui.timeline().includes('data-clear="actor"'), "second click on the same actor clears the filter");
  assert.ok(ui.timeline().includes('data-id="evt_1"'));
});

test("artifact chips toggle: the second click on the filtered artifact clears the filter", async () => {
  const ui = runUI([ev(0, {})]);
  await ui.select("evt_0");
  await ui.clickChip({ art: "repo:x#f" });
  assert.match(ui.timeline(), /artifact: <span class="chip" data-clear="artifact"/);
  await ui.clickChip({ art: "repo:x#f" });
  assert.ok(!ui.timeline().includes('data-clear="artifact"'));
});

test("legend / stat counts filter by actor type and toggle off", async () => {
  const ui = runUI([ev(0, {}), ev(1, { actor: { type: "human", id: "j@example.com" }, action: "instructed" })]);
  await ui.select("evt_0");
  assert.match(ui.timeline(), /<span data-ftype="human"[^>]*><b>1<\/b> humans/);
  await ui.clickChip({ ftype: "human" });
  assert.equal(ui.ftype(), "human");
  assert.ok(!ui.timeline().includes('data-id="evt_0"') && ui.timeline().includes('data-id="evt_1"'));
  assert.match(ui.timeline(), /data-ftype="human" class="on"/);
  await ui.clickChip({ ftype: "human" });
  assert.equal(ui.ftype(), "");
});

test("a caused-by jump lifts the filter that would hide its target, and says so", async () => {
  const ui = runUI([
    ev(0, { actor: { type: "human", id: "j@example.com" }, action: "instructed", intent: "do the thing" }),
    ev(1, { caused_by: "evt_0" }),
  ]);
  await ui.select("evt_1");
  ui.setSearch("nothing-matches-this");
  await ui.clickChip({ goto: "evt_0" });
  assert.equal(ui.search(), "", "search cleared so the target is visible");
  assert.match(ui.detail(), /Event #0/);
  assert.match(ui.toast(), /Cleared the search/);
  // A jump to an id that is not loaded cannot select anything: it says so instead of silently doing nothing.
  await ui.clickChip({ goto: "evt_nope" });
  assert.match(ui.toast(), /evt_nope is not among the loaded events/);
  assert.match(ui.detail(), /Event #0/, "selection unchanged");
});

test("timeline 'caused by' is a link only when the parent is in view", async () => {
  const ui = runUI([
    ev(0, { actor: { type: "human", id: "j@example.com" }, action: "instructed" }),
    ev(1, { caused_by: "evt_0" }),
    ev(2, { caused_by: "evt_elsewhere" }),
  ]);
  await ui.select("evt_1");
  assert.match(ui.timeline(), /data-goto="evt_0"/);
  assert.ok(!ui.timeline().includes('data-goto="evt_elsewhere"'), "no dead link to an event that is not loaded");
  assert.match(ui.timeline(), /evt_elsewhere… <i>\(not in view\)<\/i>/);
});

test("'no events match' offers a clear-all chip that resets every filter", async () => {
  const ui = runUI([ev(0, {})]);
  await ui.select("evt_0");
  await ui.clickChip({ q: "zzz-no-match" });
  assert.match(ui.timeline(), /No events match these filters\. <span class="chip" data-clear="all"/);
  await ui.clickChip({ clear: "all" });
  assert.equal(ui.search(), "");
  assert.match(ui.timeline(), /data-id="evt_0"/);
});

test("the header badges open a status pane whose numbers are the ledger's own /status answer", async () => {
  const status = {
    project: "p", generated_at: "2026-08-29T02:18:50.128Z",
    integrity: { ok: true, checked: 2 }, events: { total: 2, last_event_at: "2026-08-29T02:18:28.000Z" },
    capture: { artifact_refs: 3, artifact_refs_without_role: 1, amended_artifact_refs: 0, agent_events: 1, agent_events_without_model: 0, instructions: 1, instructions_without_followup: 0, commits: 4, unlinked_commits: 2, amended_unlinked_commits: 0, ineffective_amendments: 0, unverified_links: 0 },
    causality: { eligible_events: 4, rooted_in_human_instruction: 3, attested_events: 0, broken_links: 0, unlinked: 1, coverage_pct: 75 },
    actors: [
      { type: "agent", id: "claude-code", events: 1, last_seen: "2026-08-29T01:56:35.759Z", models: ["claude-fable-5"] },
      { type: "agent", id: "mystery", events: 1, last_seen: "2026-08-20T18:41:04.000Z", models: [] },
      { type: "human", id: "j@example.com", events: 1, last_seen: "2026-08-29T02:18:27.805Z", models: [] },
    ],
    integrations: [{ system: "git", events: 4, last_seen: "2026-08-29T02:18:28.000Z" }],
  };
  const ui = runUI([ev(0, {}), ev(1, { actor: { type: "human", id: "j@example.com" }, action: "instructed" })], { status });
  await ui.select("evt_0");
  await ui.clickChip({ pane: "status" });
  const d = ui.detail();
  assert.match(d, /Project status · p/);
  assert.match(d, /<span class="num ok">intact<\/span> · 2 events re-hashed/);
  assert.match(d, /<span class="num bad">75<\/span>% — 3 rooted of 4 eligible events/);
  assert.match(d, /append-only amendments<\/td><td>0 commits · 0 roles/);
  assert.match(d, /unverified caused_by links<\/td><td><span class="num ok">0<\/span>/);
  assert.match(d, /commits without a causal root<\/td><td><span class="num bad">2<\/span> \/ 4/);
  assert.match(d, /agent events without a model<\/td><td><span class="num ok">0<\/span> \/ 1/);
  assert.match(d, /data-actor="claude-code"[^>]*>claude-code<\/span>/);
  assert.match(d, /data-actor="mystery"[^>]*>mystery<\/span>.*<span class="num bad">none recorded<\/span>/);
  assert.match(d, /data-q="git"/);
  // Actors in the pane filter the timeline like everywhere else, and the pane stays open while they do.
  await ui.clickChip({ actor: "j@example.com" });
  assert.match(ui.timeline(), /actor: <span class="chip" data-clear="actor"/);
  assert.match(ui.detail(), /Project status/);
  // Selecting an event leaves the pane.
  await ui.select("evt_1");
  assert.match(ui.detail(), /Event #1/);
});

test("status pane without a /status answer says why, instead of showing nothing", async () => {
  const ui = runUI([ev(0, {})]);
  await ui.select("evt_0");
  await ui.clickChip({ pane: "status" });
  assert.match(ui.detail(), /intact<\/span> · 1 events re-hashed/);
  assert.match(ui.detail(), /\/status<\/span> endpoint, which did not answer/);
});

test("timeline: a truncated history page shows load-older instead of silently dropping the head", async () => {
  const events = [ev(10, {}), ev(11, {}), ev(12, {})];
  const ui = runUI(events, { historyPage: { truncated: true, next_before_seq: 10 } });
  await ui.select("evt_12");
  assert.match(ui.timeline(), /load older/);
  assert.match(ui.timeline(), /#10[–-]#12/);
  assert.match(ui.timeline(), /data-older="1"/);
});
