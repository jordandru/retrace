/**
 * Test fixture for #237 PR 1 (the paged reader, verify and the MCP attribution note). Synthetic ledgers only, and the
 * comparison of today's path with the new one on the same stored rows.
 *
 * "Today's path" is the same store with `eventRowsPage` and `amendmentEventsUpTo` hidden: `verifyProject` then runs
 * `verifyChain(await store.all(project))` and the MCP note runs `collectAttributionAmendments(await store.all(project))`,
 * which is the code at main before this change, kept as the fallback.
 */
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SCHEMA_SQL, appendEvent, buildProjectStatus, createHandler, parseCredentials, verifyChain, verifyProject } from "@retrace-dev/core";
import type { EventInput, EventStore } from "@retrace-dev/core";
import { D1Store } from "./d1-store.js";
import { authenticateRemoteMcp, buildRemoteMcpServer } from "./mcp.js";

/** D1 over node:sqlite, as `d1-store.test.ts`'s shim, counting every statement it executes (a batch counts each). */
export class CountingSqliteD1 {
  queries = 0;
  constructor(readonly db: DatabaseSync) {}
  prepare(sql: string) {
    const db = this.db, self = this;
    let params: SQLInputValue[] = [];
    const stmt = {
      sql,
      bind(...p: unknown[]) { params = p as SQLInputValue[]; return stmt; },
      async first() { self.queries++; return db.prepare(sql).get(...params) ?? null; },
      async all() { self.queries++; return { results: db.prepare(sql).all(...params), meta: {} }; },
      async run() { self.queries++; return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } }; },
    };
    return stmt;
  }
  async batch(statements: Array<ReturnType<CountingSqliteD1["prepare"]>>) {
    this.db.exec("BEGIN");
    try {
      const out: unknown[] = [];
      for (const s of statements) out.push(/^\s*select/i.test(s.sql) ? (await s.all(), { meta: { changes: 0 } }) : await s.run());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    }
  }
}

export function sqliteD1(): { sqlite: DatabaseSync; d1: CountingSqliteD1; store: D1Store } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA_SQL);
  const d1 = new CountingSqliteD1(sqlite);
  return { sqlite, d1, store: new D1Store(d1 as unknown as D1Database) };
}

export const P = "retrace";
export const NOW = new Date("2026-10-14T12:00:00.000Z");
const OWNER = "owner-token-for-whole-ledger-tests-0000";
const MCP_TOKEN = "mcp-token-for-whole-ledger-tests-00000";
const CREDENTIALS = JSON.stringify([{ token: MCP_TOKEN, name: "whole-ledger test", actor: { type: "agent", id: "fixture-agent", on_behalf_of: "owner@example.com" }, trust: "pinned", projects: [P] }]);
/** One- to four-byte UTF-8 characters, so page character budgets and byte lengths differ. */
const CHARS = ["a", "é", "→", "😀"];

export interface LedgerOptions {
  /** Indices that are attribution amendments (action other, detail amended, tagged attribution). */
  amendments?: number[];
  /** Indices that look like amendments but are not: action edited, detail amended, tagged attribution. */
  decoys?: number[];
}

/** Append `n` synthetic events to `project`: agents, human instructions, causes, commits, amendments, wide characters. */
export async function seedLedger(store: EventStore, n: number, opts: LedgerOptions = {}, project = P): Promise<string[]> {
  const ids: string[] = [];
  const amend = new Set(opts.amendments ?? []), decoy = new Set(opts.decoys ?? []);
  for (let i = 0; i < n; i++) {
    const ch = CHARS[i % CHARS.length]!;
    let input: EventInput;
    if (amend.has(i) && ids.length) {
      input = {
        project, actor: { type: "human", id: "owner@example.com" }, action: "other", action_detail: "amended",
        artifacts: [{ id: `event:${ids[0]}`, role: "used" }], tags: ["amendment", "attribution"], intent: `amend ${i} ${ch}`,
        method: { tool: "retrace_amend", params: { target_event_id: ids[0], attribution: { from: { type: "agent", id: "a" }, to: { type: "agent", id: "b" }, artifacts: [], evidence: [] } } },
      };
    } else if (decoy.has(i)) {
      input = { project, actor: { type: "agent", id: "claude-code" }, action: "edited", action_detail: "amended", tags: ["attribution"], artifacts: [{ id: `task:decoy-${i}` }], intent: `decoy ${i}` };
    } else if (i % 11 === 0) {
      input = { project, actor: { type: "human", id: "owner@example.com" }, action: "instructed", artifacts: [{ id: `task:${i}`, role: "generated" }], intent: `task ${i} ${ch.repeat(3)}` };
    } else if (i % 13 === 5) {
      input = { project, actor: { type: "agent", id: "git-hook" }, action: "committed", artifacts: [{ id: `commit:${(i * 7919).toString(16).padStart(12, "0")}`, role: "generated" }], intent: `commit ${i}`, caused_by: ids.at(-1) };
    } else {
      input = {
        project, actor: { type: "agent", id: i % 3 ? "claude-code" : "codex", model: "fixture-model", model_source: "harness-runtime" }, action: "edited",
        artifacts: [{ id: `repo:acme/app#src/f${i % 7}.ts`, role: "generated" }], intent: `edit ${i} ${ch.repeat(1 + (i % 5))}`,
        ...(ids.length && i % 4 ? { caused_by: ids[Math.max(0, ids.length - 1 - (i % 9))] } : {}),
      };
    }
    ids.push((await appendEvent(store, input)).event.id);
  }
  return ids;
}

/** The same store as today's path sees it (see the header). */
export function todayStore(store: EventStore): EventStore {
  return new Proxy(store, {
    get(target, key) {
      if (key === "eventRowsPage" || key === "amendmentEventsUpTo") return undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The store with every `eventRowsPage` capped at `rows` rows and `chars` characters (tiny pages). */
export function tinyPages(store: EventStore, rows: number, chars = Number.MAX_SAFE_INTEGER): EventStore {
  return new Proxy(store, {
    get(target, key) {
      if (key === "eventRowsPage") return (p: string, a: number | null, t: number, l: number, c: number) => target.eventRowsPage!(p, a, t, Math.min(l, rows), Math.min(c, chars));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export interface Outcome { status: number; body: string }
const outcome = async (run: () => Promise<Outcome>): Promise<Outcome> => {
  try { return await run(); } catch (e) { return { status: -1, body: `threw ${(e as Error).name}: ${(e as Error).message}` }; }
};

/** Every response PR 1 moves, for one store: the route bodies, status JSON at a fixed `now`, and the MCP tool results. */
export async function responses(store: EventStore, opts: { whyEventId?: string } = {}): Promise<Record<string, Outcome>> {
  const handler = createHandler(store, { token: OWNER, credentials: parseCredentials(CREDENTIALS) });
  const get = (path: string) => outcome(async () => {
    const res = await handler(new Request(`https://retrace.example${path}`, { headers: { authorization: `Bearer ${OWNER}` } }));
    const body = await res.text();
    // A 500 carries a random reference; the message before it is what must agree.
    return { status: res.status, body: res.status === 500 ? body.replace(/ref [0-9a-z-]+/i, "ref <ref>") : body };
  });
  const shareId = `shr_${crypto.randomUUID().replace(/-/g, "")}`;
  await store.createShare({ id: shareId, project: P, created_at: NOW.toISOString() });
  const out: Record<string, Outcome> = {
    verify: await get(`/projects/${P}/verify`),
    share_verify: await get(`/s/${shareId}/verify`),
    status_json: await outcome(async () => ({ status: 200, body: JSON.stringify(await buildProjectStatus(store, P, NOW)) })),
    verify_direct: await outcome(async () => ({ status: 200, body: JSON.stringify(await verifyProject(store, P)) })),
  };
  const parsed = await authenticateRemoteMcp(new Request("https://retrace.example/mcp", { headers: { authorization: `Bearer ${MCP_TOKEN}` } }), CREDENTIALS);
  assert.ok(parsed);
  const server = buildRemoteMcpServer(store, parsed, { requestUrl: "https://retrace.example/mcp", apiHandler: handler });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "whole-ledger-test", version: "0.1" });
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) => outcome(async () => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: unknown; structuredContent?: unknown };
    return { status: r.isError ? 1 : 0, body: JSON.stringify({ content: r.content, structuredContent: r.structuredContent }) };
  });
  out.mcp_verify = await call("retrace_verify", {});
  out.mcp_history = await call("retrace_history", { limit: 7 });
  out.mcp_history_all = await call("retrace_history", {});
  if (opts.whyEventId) out.mcp_why = await call("retrace_why", { event_id: opts.whyEventId });
  await client.close();
  return out;
}

/** Today's path and the new one on the same rows give the same responses; `verifyProject` equals `verifyChain(all)`. */
export async function assertSameResponses(store: EventStore, label: string, opts: { whyEventId?: string } = {}) {
  const now = await responses(store, opts);
  const today = await responses(todayStore(store), opts);
  for (const key of Object.keys(today)) assert.deepEqual(now[key], today[key], `${label}: ${key} differs from today's path`);
  const all = await outcome(async () => ({ status: 200, body: JSON.stringify(await verifyChain(await store.all(P))) }));
  assert.deepEqual(now.verify_direct, all, `${label}: verifyProject differs from verifyChain(all)`);
  return now;
}
