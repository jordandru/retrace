import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adapterIdempotencyError, AdapterIdempotencyError, CAUSED_BY_UNVERIFIED_TAG, appendEvent,
  EventInput, Event, EventStore, Share, likeContains, clampHistoryLimit, HISTORY_LIMIT_MAX,
  pageHistoryNewest, collectHistory, asHistoryPage, explainEvent,
  artifactIndexRows, eventsReferencingArtifactKeys, artifactKeyMatchSql, BACKFILL_ARTIFACT_INDEX_SQL, eventsReferencingArtifactsSql, eventsReferencingArtifactsStatements, prefixRangeUpperBound, ARTIFACT_INDEX_MAX_TERMS, D1_MAX_BOUND_PARAMS, D1_MAX_COMPOUND_SELECT_TERMS,
  ARTIFACT_INDEX_DEFAULT_ROW_CAP, D1_LIKE_GLOB_PATTERN_MAX_BYTES, ALIAS_KEY_RANGE_LO,
  InvalidArtifactIdError,
} from "./index.js";

class MemStore implements EventStore {
  events: Event[] = [];
  async head(p: string) { const e = this.events.filter((x) => x.project === p).at(-1); return e ? { seq: e.seq, hash: e.hash } : null; }
  async insert(e: Event) { this.events.push(e); }
  async byIdempotencyKey(p: string, k: string) { return this.events.find((e) => e.project === p && e.idempotency_key === k) ?? null; }
  async get(id: string) { return this.events.find((e) => e.id === id) ?? null; }
  async all(p: string) { return this.events.filter((e) => e.project === p); }
  async projects() { return [...new Set(this.events.map((e) => e.project))]; }
  async history(q: { project: string }) { return pageHistoryNewest(this.events, q); }
  async createShare(_s: Share) {}
  async getShare() { return null; }
}

const ev = (over: Partial<EventInput>): EventInput => ({
  project: "p", actor: { type: "agent", id: "grok" }, action: "edited", artifacts: [{ id: "a" }], ...over,
});

test("likeContains treats % and _ as literals; clampHistoryLimit binds a finite cap", () => {
  assert.equal(likeContains("100%").pattern, "%100!%%");
  assert.equal(likeContains("a_b").pattern, "%a!_b%");
  assert.equal(likeContains("a!b").pattern, "%a!!b%");
  assert.match(likeContains("x").sql, /ESCAPE '!'/);
  assert.equal(clampHistoryLimit(undefined), 100);
  assert.equal(clampHistoryLimit(NaN), 100);
  assert.equal(clampHistoryLimit(-4), 100);
  assert.equal(clampHistoryLimit(3.9), 3);
  assert.equal(clampHistoryLimit(HISTORY_LIMIT_MAX + 1), HISTORY_LIMIT_MAX);
});

test("pageHistoryNewest: default limit is the newest 100, not genesis; cursor walks older pages", () => {
  const events = Array.from({ length: 130 }, (_, seq) => ({
    id: `evt_${seq}`, project: "p", seq, timestamp: "2026-09-01T00:00:00.000Z", received_at: "2026-09-01T00:00:00.000Z",
    actor: { type: "agent" as const, id: "claude-code" }, action: "edited" as const, artifacts: [{ id: "a" }],
    prev_hash: "0", hash: `h${seq}`,
  }));
  const def = pageHistoryNewest(events, { project: "p" });
  assert.equal(def.events.length, 100);
  assert.equal(def.events[0].seq, 30);
  assert.equal(def.events.at(-1)?.seq, 129);
  assert.equal(def.truncated, true);
  assert.equal(def.next_before_seq, 30);
  const older = pageHistoryNewest(events, { project: "p", before_seq: def.next_before_seq, limit: 100 });
  assert.equal(older.events[0].seq, 0);
  assert.equal(older.events.at(-1)?.seq, 29);
  assert.equal(older.truncated, false);
  assert.equal(older.next_before_seq, undefined);
  const small = pageHistoryNewest(events, { project: "p", limit: 3 });
  assert.deepEqual(small.events.map((e) => e.seq), [127, 128, 129]);
  assert.equal(small.next_before_seq, 127);
});

test("asHistoryPage: a legacy Event[] is a complete page; a wrapper keeps truncated", () => {
  const ev0 = { id: "e", project: "p", seq: 0, timestamp: "2026-09-01T00:00:00.000Z", received_at: "2026-09-01T00:00:00.000Z", actor: { type: "agent" as const, id: "x" }, action: "edited" as const, artifacts: [] as { id: string }[], prev_hash: "0", hash: "h" };
  assert.deepEqual(asHistoryPage([ev0]), { events: [ev0], truncated: false });
  assert.equal(asHistoryPage({ events: [ev0], truncated: true, next_before_seq: 4 }).truncated, true);
  assert.throws(() => asHistoryPage({}), /neither/);
});

test("collectHistory: pages until the window is complete and returns ascending seq", async () => {
  const events = Array.from({ length: 250 }, (_, seq) => ({
    id: `evt_${seq}`, project: "p", seq, timestamp: "2026-09-01T00:00:00.000Z", received_at: "2026-09-01T00:00:00.000Z",
    actor: { type: "agent" as const, id: "claude-code" }, action: "edited" as const, artifacts: [{ id: "a" }],
    prev_hash: "0", hash: `h${seq}`,
  }));
  const store = { history: async (q: { project: string; limit?: number; before_seq?: number }) => pageHistoryNewest(events, { ...q, limit: 80 }) };
  const all = await collectHistory(store, { project: "p" });
  assert.equal(all.length, 250);
  assert.equal(all[0].seq, 0);
  assert.equal(all.at(-1)?.seq, 249);
});

test("adapter idempotency: git:/gd:/gh: are reserved unless the event is adapter-shaped", () => {
  assert.ok(adapterIdempotencyError(ev({ idempotency_key: "git:abc" })));
  assert.ok(adapterIdempotencyError(ev({ idempotency_key: "git:abc", method: { tool: "git" }, action: "edited" })));
  assert.equal(adapterIdempotencyError(ev({ idempotency_key: "git:abc", method: { tool: "git" }, action: "committed" })), undefined);
  assert.equal(adapterIdempotencyError(ev({ idempotency_key: "git:abc", method: { tool: "git" }, action: "merged" })), undefined);

  assert.ok(adapterIdempotencyError(ev({ idempotency_key: "gd:x" })));
  assert.equal(adapterIdempotencyError(ev({ idempotency_key: "gd:x", tags: ["google-drive"] })), undefined);
  assert.equal(adapterIdempotencyError(ev({ idempotency_key: "gd:x", method: { tool: "google-docs" } })), undefined);

  assert.ok(adapterIdempotencyError(ev({ idempotency_key: "gh:d1" })));
  assert.equal(adapterIdempotencyError(ev({ idempotency_key: "gh:d1", method: { tool: "github" } })), undefined);
  assert.equal(adapterIdempotencyError(ev({ idempotency_key: "gh:d1", tags: ["github"] })), undefined);

  assert.equal(adapterIdempotencyError(ev({ idempotency_key: "k1" })), undefined);
  assert.equal(adapterIdempotencyError(ev({})), undefined);
  assert.match(adapterIdempotencyError(ev({ idempotency_key: "policy:p:1" })) ?? "", /policy:/);
  assert.match(adapterIdempotencyError(ev({ idempotency_key: "policy:p:1", method: { tool: "retrace-api" }, action: "created" })) ?? "", /policy:/);
});

test("appendEvent: a planted git: key on a non-commit does not shadow a later git-hook event", async () => {
  const store = new MemStore();
  await assert.rejects(
    () => appendEvent(store, ev({ idempotency_key: "git:deadbeef", action: "edited", method: { tool: "Edit" } })),
    (e: unknown) => e instanceof AdapterIdempotencyError && /git:/.test((e as Error).message),
  );
  assert.equal(store.events.length, 0);
  const { event, deduped } = await appendEvent(store, ev({
    action: "committed", method: { tool: "git" }, idempotency_key: "git:deadbeef",
    artifacts: [{ id: "commit:p@deadbeefcafe", kind: "commit" }],
  }));
  assert.equal(deduped, false);
  assert.equal(event.action, "committed");
  const again = await appendEvent(store, ev({
    action: "committed", method: { tool: "git" }, idempotency_key: "git:deadbeef",
    artifacts: [{ id: "commit:p@deadbeefcafe", kind: "commit" }],
  }));
  assert.equal(again.deduped, true);
  assert.equal(again.event.id, event.id);
});

test("appendEvent: caused_by is optional; dangling/cross-project/newer is sealed with the link kept", async () => {
  const store = new MemStore();
  const root = (await appendEvent(store, ev({ action: "instructed", actor: { type: "human", id: "j@x" }, artifacts: [{ id: "task:1" }] }))).event;
  const child = await appendEvent(store, ev({ caused_by: root.id }));
  assert.equal(child.event.caused_by, root.id);
  assert.ok(!child.event.tags?.includes(CAUSED_BY_UNVERIFIED_TAG));

  const missing = (await appendEvent(store, ev({ caused_by: "evt_deadbeefdeadbeefdeadbeefdeadbeef" }))).event;
  assert.equal(missing.caused_by, "evt_deadbeefdeadbeefdeadbeefdeadbeef");
  assert.ok(missing.tags?.includes(CAUSED_BY_UNVERIFIED_TAG));
  assert.equal(missing.method?.params?.caused_by_problem, "missing");

  const other = (await appendEvent(store, ev({ project: "other", action: "instructed", actor: { type: "human", id: "j@x" } }))).event;
  const cross = (await appendEvent(store, ev({ caused_by: other.id }))).event;
  assert.equal(cross.caused_by, other.id);
  assert.ok(cross.tags?.includes(CAUSED_BY_UNVERIFIED_TAG));
  assert.equal(cross.method?.params?.caused_by_problem, "wrong_project");

  const newer = (await appendEvent(store, ev({
    caused_by: root.id,
    timestamp: "2020-01-01T00:00:00.000Z",
  }))).event;
  assert.equal(newer.caused_by, root.id);
  assert.ok(newer.tags?.includes(CAUSED_BY_UNVERIFIED_TAG));
  assert.equal(newer.method?.params?.caused_by_problem, "not_older");

  const none = await appendEvent(store, ev({}));
  assert.equal(none.event.caused_by, undefined);
});

test("explainEvent never follows an unverified caused_by link into another project", async () => {
  const store = new MemStore();
  const foreign = (await appendEvent(store, ev({
    project: "foreign",
    action: "instructed",
    actor: { type: "human", id: "private@example.com" },
    intent: "foreign project secret",
  }))).event;
  const local = (await appendEvent(store, ev({ project: "p", caused_by: foreign.id }))).event;

  assert.ok(local.tags?.includes(CAUSED_BY_UNVERIFIED_TAG), "fixture retains the rejected cross-project claim");
  assert.deepEqual((await explainEvent(store, local.id)).map((event) => event.id), [local.id]);
});

test("artifactIndexRows uses artifactKey and records sealed_by + role", () => {
  const e: Event = {
    id: "evt_1", project: "p", seq: 3, timestamp: "2026-09-08T00:00:00.000Z", received_at: "2026-09-08T00:00:00.000Z",
    actor: { type: "agent", id: "codex" }, action: "edited",
    artifacts: [{ id: "repo:jordandru/retrace#a.ts", role: "both" }, { id: "repo:jordandru/retrace#a.ts", role: "used" }, { id: "task:1" }],
    method: { params: { sealed_by: "pinned:codex" } },
    prev_hash: "0", hash: "h",
  };
  const rows = artifactIndexRows(e);
  assert.equal(rows.length, 2, "duplicate artifactKey collapsed");
  assert.deepEqual(rows[0], {
    project: "p", artifact_key: "repo:jordandru/retrace#a.ts", seq: 3,
    actor_type: "agent", actor_id: "codex", role: "both", sealed_by: "pinned:codex",
  });
  assert.equal(rows[1].artifact_key, "task:1");
  assert.equal(rows[1].role, null);
});

test("eventsReferencingArtifactKeys: sameArtifact aliases, seq window, budget and deadline", () => {
  const evAt = (seq: number, ids: string[], project = "p"): Event => ({
    id: `evt_${seq}`, project, seq, timestamp: "2026-09-08T00:00:00.000Z", received_at: "2026-09-08T00:00:00.000Z",
    actor: { type: "agent", id: "codex" }, action: "edited", artifacts: ids.map((id) => ({ id })),
    prev_hash: "0", hash: `h${seq}`,
  });
  const events = [
    evAt(1, ["repo:jordandru/retrace#a.ts"]),
    evAt(2, ["repo:retrace#a.ts"]),
    evAt(3, ["repo:otherorg/retrace#a.ts"]),
    evAt(4, ["repo:jordandru/retrace#b.ts"]),
    evAt(5, ["repo:jordandru/retrace#a.ts"], "other"),
  ];
  const q = { project: "p", artifact_keys: ["repo:jordandru/retrace#a.ts"], after_seq: 0, through_seq: 10, row_cap: 20_000, deadline: 1 };
  const hit = eventsReferencingArtifactKeys(events, q, 0);
  assert.equal(hit.ok, true);
  if (hit.ok) assert.deepEqual(hit.events.map((e) => e.seq), [1, 2], "full name matches basename alias; other owner/repo does not");

  const windowed = eventsReferencingArtifactKeys(events, { ...q, after_seq: 1, through_seq: 2 }, 0);
  assert.equal(windowed.ok, true);
  if (windowed.ok) assert.deepEqual(windowed.events.map((e) => e.seq), [2]);

  assert.deepEqual(eventsReferencingArtifactKeys(events, { ...q, deadline: 0 }, 0), { ok: false, reason: "deadline" });
  assert.deepEqual(eventsReferencingArtifactKeys(events, { ...q, row_cap: 1 }, 0), { ok: false, reason: "budget" });
  assert.equal(ARTIFACT_INDEX_DEFAULT_ROW_CAP, 20_000);
  const empty = eventsReferencingArtifactKeys(events, { ...q, artifact_keys: [] }, 0);
  assert.deepEqual(empty, { ok: true, events: [] });
});

test("eventsReferencingArtifactsStatements binds the window once and one json_each-driven UNION member per kind of term", () => {
  const sha = "a1234567890b".padEnd(40, "c");
  const prefix = `commit:jordandru/retrace@${sha.slice(0, 7)}`;
  const q = {
    project: "p", artifact_keys: ["repo:jordandru/retrace#a.ts", "repo:retrace#b.ts"], artifact_prefixes: [prefix],
    after_seq: 3, through_seq: 9, row_cap: 10, deadline: 0,
  };
  const [only, ...rest] = eventsReferencingArtifactsStatements(q);
  assert.equal(rest.length, 0);
  const { sql, params } = only!;
  assert.doesNotMatch(sql, /INDEXED BY/);
  assert.match(sql, /^WITH w\(project, after_seq, through_seq\) AS \(SELECT \?, \?, \?\) SELECT e\.body, m\.seq, m\.artifact_key FROM \(/);
  assert.match(sql, /\) m CROSS JOIN events e ON e\.project = \? AND e\.seq = m\.seq ORDER BY m\.seq ASC, m\.artifact_key ASC LIMIT \?$/);
  assert.equal((sql.match(/ UNION /g) ?? []).length, 2, "equality member + prefix member + suffix member, whatever the key count");
  assert.equal((sql.match(/SELECT DISTINCT i\.seq, i\.artifact_key FROM w CROSS JOIN json_each\(\?\) t CROSS JOIN event_artifact_index i/g) ?? []).length, 3, "json_each is the outer loop of every member; DISTINCT folds overlapping terms of one kind before LIMIT");
  assert.match(sql, /i\.artifact_key = t\.value AND i\.seq > w\.after_seq AND i\.seq <= w\.through_seq/);
  assert.match(sql, /i\.artifact_key >= json_extract\(t\.value, '\$\[0\]'\) AND i\.artifact_key < json_extract\(t\.value, '\$\[1\]'\)/);
  assert.match(sql, /i\.artifact_key >= json_extract\(t\.value, '\$\[0\]'\) AND i\.artifact_key < json_extract\(t\.value, '\$\[1\]'\) AND i\.seq > w\.after_seq AND i\.seq <= w\.through_seq AND substr\(CAST\(i\.artifact_key AS BLOB\), -length\(CAST\(json_extract\(t\.value, '\$\[2\]'\) AS BLOB\)\)\) = CAST\(json_extract\(t\.value, '\$\[2\]'\) AS BLOB\)/, "an alias suffix seeks the repo: key range, then filters by byte-oriented suffix (length on BLOB, not TEXT)");
  assert.doesNotMatch(sql, /\bGLOB\b|\bLIKE\b/, "classify SQL must not bind a LIKE/GLOB pattern");
  assert.doesNotMatch(sql, /artifact_key (=|>=|<|GLOB) \?/, "no per-term SQL parameters");
  assert.deepEqual(params.slice(0, 3), ["p", 3, 9]);
  assert.equal(params.length, 3 + 3 + 2, "window once, one JSON array per member, join project, limit");
  assert.deepEqual(JSON.parse(params[3] as string), ["repo:jordandru/retrace#a.ts", "repo:retrace#a.ts", "repo:retrace#b.ts"]);
  assert.deepEqual(JSON.parse(params[4] as string), [[prefix, "commit:jordandru/retrace@a123457"]], "prefix and its exclusive upper bound");
  assert.deepEqual(JSON.parse(params[5] as string), [[ALIAS_KEY_RANGE_LO, prefixRangeUpperBound(ALIAS_KEY_RANGE_LO), "/retrace#b.ts"]], "suffix with the repo: key range");
  assert.equal(params.at(-1), 11, "LIMIT is row_cap + 1");
  assert.deepEqual(eventsReferencingArtifactsStatements({ project: "p", artifact_keys: [], after_seq: -1, through_seq: 1, row_cap: 1, deadline: 0 }), []);
  assert.deepEqual(eventsReferencingArtifactsSql(q), only);
});

test("eventsReferencingArtifactsStatements keeps every statement under D1's parameter and compound-SELECT limits", () => {
  const base = { project: "p", after_seq: -1, through_seq: 9, row_cap: 10, deadline: 0 };
  const compoundTerms = (sql: string) => (sql.match(/ UNION /g) ?? []).length + 1;
  // the real four-file classifier shape under a policy with two owner-less aliases: 4 files × 3 exact spellings
  // + 4 files × 2 alias suffixes — 114 parameters in round 5 (Codex F4), 28 compound terms in round 6 (D1 allows 5)
  const fourFiles = ["a.ts", "b.ts", "c.ts", "d.ts"].flatMap((f) => [`repo:acme/app#${f}`, `repo:app#${f}`, `repo:old-name#${f}`]);
  const statements = eventsReferencingArtifactsStatements({ ...base, artifact_keys: fourFiles });
  assert.equal(statements.length, 1, "the four-file query is one statement");
  assert.equal(statements[0]!.params.length, 3 + 2 + 2, "window, equality JSON, suffix JSON, join project, limit");
  assert.equal(compoundTerms(statements[0]!.sql), 2);
  assert.deepEqual(JSON.parse(statements[0]!.params[3] as string), fourFiles);
  assert.equal((JSON.parse(statements[0]!.params[4] as string) as string[][]).length, 8, "two alias suffixes per file");
  assert.doesNotMatch(statements[0]!.sql, /\bGLOB\b|\bLIKE\b/);
  const many = eventsReferencingArtifactsStatements({ ...base, artifact_keys: Array.from({ length: 501 }, (_, i) => `task:${i}`), artifact_prefixes: ["task:1", ""] });
  assert.equal(many.length, 2, "501 keys + 2 prefixes batch under ARTIFACT_INDEX_MAX_TERMS");
  let carried = 0;
  for (const st of many) {
    assert.ok(st.params.length <= D1_MAX_BOUND_PARAMS);
    assert.ok(compoundTerms(st.sql) <= D1_MAX_COMPOUND_SELECT_TERMS, `${compoundTerms(st.sql)} compound terms`);
    let inStatement = 0;
    for (const p of st.params.slice(3, -2)) inStatement += (JSON.parse(p as string) as unknown[]).length;
    assert.ok(inStatement <= ARTIFACT_INDEX_MAX_TERMS);
    carried += inStatement;
  }
  assert.equal(carried, 503, "every term reaches exactly one statement");
  assert.throws(() => eventsReferencingArtifactsSql({ ...base, artifact_keys: Array.from({ length: 501 }, (_, i) => `task:${i}`) }), /needs \d+ statements/);
  const small = eventsReferencingArtifactsStatements({ ...base, artifact_keys: ["task:1", "task:2", "task:3"] }, { maxTerms: 2 });
  assert.equal(small.length, 2, "maxTerms splits terms across statements");
  const unbounded = eventsReferencingArtifactsStatements({ ...base, artifact_keys: [], artifact_prefixes: [""] });
  assert.match(unbounded[0]!.sql, /i\.artifact_key >= t\.value AND i\.seq/);
  assert.doesNotMatch(unbounded[0]!.sql, /json_extract/, "an empty prefix is an unbounded range with no upper bound");
  assert.deepEqual(JSON.parse(unbounded[0]!.params[3] as string), [""]);
});

test("prefixRangeUpperBound is the exclusive end of a code-point (BINARY) prefix range", () => {
  assert.equal(prefixRangeUpperBound("commit:acme/app@a12"), "commit:acme/app@a13");
  assert.equal(prefixRangeUpperBound("repo:x#z"), "repo:x#{");
  assert.equal(prefixRangeUpperBound(""), undefined, "empty prefix: unbounded");
  assert.equal(prefixRangeUpperBound("x:\uffff"), "x:\u{10000}", "U+FFFF steps into the supplementary plane, not a false ceiling");
  assert.equal(prefixRangeUpperBound("x:\ud7ff"), "x:\ue000", "never a lone surrogate");
  assert.equal(prefixRangeUpperBound("x:\u{10ffff}"), "x;", "carry past U+10FFFF into the previous code point");
  assert.equal(prefixRangeUpperBound("\u{10ffff}\u{10ffff}"), undefined, "all-max prefix: unbounded");
});

test("artifactKeyMatchSql and backfill SQL are bound, not interpolated; backfill reads json artifact ids", () => {
  const match = artifactKeyMatchSql(["repo:jordandru/retrace#a.ts", "repo:retrace#b.ts"]);
  assert.match(match.sql, /i\.artifact_key IN \(\?(,\?)+\)/);
  assert.match(match.sql, /substr\(CAST\(i\.artifact_key AS BLOB\), -length\(CAST\(\? AS BLOB\)\)\) = CAST\(\? AS BLOB\)/);
  assert.doesNotMatch(match.sql, /\bGLOB\b/);
  assert.ok(match.params.includes("repo:jordandru/retrace#a.ts"));
  assert.ok(match.params.includes("repo:retrace#a.ts"), "full name also looks up the basename alias");
  assert.ok(match.params.includes("/retrace#b.ts"));
  assert.ok(match.params.includes(ALIAS_KEY_RANGE_LO));
  assert.ok(match.params.includes(prefixRangeUpperBound(ALIAS_KEY_RANGE_LO)!));
  assert.match(BACKFILL_ARTIFACT_INDEX_SQL, /INSERT OR IGNORE INTO event_artifact_index/);
  assert.match(BACKFILL_ARTIFACT_INDEX_SQL, /json_extract\(a\.value, '\$\.id'\)/);
});

test("alias suffix SQL matches the GLOB-equivalent hit and rejects the near-miss", () => {
  const path = "packages/mcp-server/src/sqlite-store.test.ts";
  const oldGlob = `repo:*/retrace#${path}`;
  assert.ok(new TextEncoder().encode(oldGlob).length > D1_LIKE_GLOB_PATTERN_MAX_BYTES, "the pattern this query used to bind would have thrown on D1");
  const q = {
    project: "p", artifact_keys: [`repo:retrace#${path}`], after_seq: -1, through_seq: 10, row_cap: 10, deadline: 0,
  };
  const [only] = eventsReferencingArtifactsStatements(q);
  assert.doesNotMatch(only!.sql, /\bGLOB\b|\bLIKE\b/);
  const suffixPayload = JSON.parse(only!.params[4] as string) as [string, string, string][];
  assert.deepEqual(suffixPayload, [[ALIAS_KEY_RANGE_LO, prefixRangeUpperBound(ALIAS_KEY_RANGE_LO), `/retrace#${path}`]]);
  const suffix = suffixPayload[0]![2];
  const hit = `repo:jordandru/retrace#${path}`;
  const miss = `repo:jordandru/retrace-extra#${path}`;
  assert.equal(hit.startsWith(suffixPayload[0]![0]) && hit < suffixPayload[0]![1] && hit.endsWith(suffix), true);
  assert.equal(miss.endsWith(suffix), false);
});

test("alias suffix SQL uses BLOB length so a NUL in the path is not a terminator", () => {
  const path = `a\0b`;
  const q = {
    project: "p", artifact_keys: [`repo:retrace#${path}`], after_seq: -1, through_seq: 10, row_cap: 10, deadline: 0,
  };
  const [only] = eventsReferencingArtifactsStatements(q);
  assert.match(only!.sql, /CAST\(i\.artifact_key AS BLOB\)/);
  assert.doesNotMatch(only!.sql, /\bGLOB\b|\bLIKE\b/);
  const suffixPayload = JSON.parse(only!.params[4] as string) as [string, string, string][];
  assert.equal(suffixPayload[0]![2], `/retrace#${path}`);
  assert.ok(suffixPayload[0]![2].includes("\0"));
});

test("appendEvent refuses NUL and unpaired surrogates and accepts an astral-plane path", async () => {
  const store = new MemStore();
  const high = "repo:o/retrace#a\uD800b";
  const low = "repo:o/retrace#a\uDC00b";
  const nul = "repo:o/retrace#a\0b";
  const astral = "repo:o/retrace#😀.ts";
  for (const [id, re] of [[nul, /U\+0000/], [high, /unpaired surrogates/], [low, /unpaired surrogates/]] as const) {
    await assert.rejects(
      () => appendEvent(store, ev({ artifacts: [{ id }] })),
      (e: unknown) => e instanceof InvalidArtifactIdError && re.test((e as Error).message),
    );
  }
  assert.equal(store.events.length, 0, "refused ids must not be sealed");
  const { event } = await appendEvent(store, ev({ artifacts: [{ id: astral }] }));
  assert.equal(event.artifacts[0]?.id, astral);
});
