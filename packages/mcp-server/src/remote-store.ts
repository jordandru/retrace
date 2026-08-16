/** Remote store: talks to the Retrace Cloudflare Worker over HTTP. Set RETRACE_URL (+ RETRACE_TOKEN). */
import { Event, EventStore, HistoryQuery, VerifyResult, EventInput } from "@retrace/core";

export class RemoteStore implements EventStore {
  constructor(private baseUrl: string, private token?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Retrace API ${method} ${path} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }
  /** Remote appends server-side (chain sealing must happen where the head lives). */
  async append(input: EventInput): Promise<{ event: Event; deduped: boolean }> {
    return this.req("POST", "/events", input);
  }
  async verify(project: string): Promise<VerifyResult> {
    return this.req("GET", `/projects/${encodeURIComponent(project)}/verify`);
  }
  async head(project: string) {
    return this.req<{ seq: number; hash: string } | null>("GET", `/projects/${encodeURIComponent(project)}/head`);
  }
  async insert(): Promise<void> {
    throw new Error("RemoteStore.insert is not supported; use append()");
  }
  async byIdempotencyKey(): Promise<Event | null> {
    return null;
  }
  async get(id: string) {
    return this.req<Event | null>("GET", `/events/${encodeURIComponent(id)}`);
  }
  async all(project: string) {
    return this.req<Event[]>("GET", `/projects/${encodeURIComponent(project)}/events?limit=100000`);
  }
  async projects() {
    return this.req<string[]>("GET", `/projects`);
  }
  async history(q: HistoryQuery) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && k !== "project") p.set(k, String(v));
    return this.req<Event[]>("GET", `/projects/${encodeURIComponent(q.project)}/events?${p}`);
  }
}
