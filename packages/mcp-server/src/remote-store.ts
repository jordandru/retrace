/** Remote store: talks to the Retrace Cloudflare Worker over HTTP. Set RETRACE_URL (+ RETRACE_TOKEN). */
import { Event, EventStore, HistoryQuery, VerifyResult, EventInput, Share, ExportBundle, ProjectStatus } from "@retrace-dev/core";

/** Consistent headers for CLI-originated requests, including runtimes that require an explicit user agent. */
export function retraceHeaders(token?: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "@retrace-dev/cli/0.1.1",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export class RemoteStore implements EventStore {
  constructor(private baseUrl: string, private token?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: retraceHeaders(this.token),
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
  async status(project: string): Promise<ProjectStatus> {
    return this.req("GET", `/projects/${encodeURIComponent(project)}/status`);
  }
  async createShare(): Promise<void> { throw new Error("use share()"); }
  async getShare(id: string) { return this.req<Share | null>("GET", `/s/${encodeURIComponent(id)}/meta`); }
  /** Server-side share creation; returns share + url. */
  async share(body: { project: string; artifact_id?: string; label?: string; expires_in_days?: number }) {
    return this.req<{ share: Share; url: string }>("POST", `/projects/${encodeURIComponent(body.project)}/share`, body);
  }
  async export(scope: { project: string; artifact_id?: string }) {
    const p = new URLSearchParams(); if (scope.artifact_id) p.set("artifact_id", scope.artifact_id);
    return this.req<ExportBundle>("GET", `/projects/${encodeURIComponent(scope.project)}/export?${p}`);
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
