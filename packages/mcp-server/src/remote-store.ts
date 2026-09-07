/** Remote store: talks to the Retrace Cloudflare Worker over HTTP. Set RETRACE_URL (+ RETRACE_TOKEN). */
import { Event, EventStore, HistoryQuery, HistoryPage, VerifyResult, EventInput, Share, ExportBundle, ProjectStatus, asHistoryPage, collectHistory } from "@retrace-dev/core";

export class RemoteApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly headers: Headers,
    detail: string,
  ) {
    super(`Retrace API ${method} ${path} → ${status}: ${detail}`);
    this.name = "RemoteApiError";
  }
}

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
    if (!res.ok) throw new RemoteApiError(method, path, res.status, new Headers(res.headers), await res.text());
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
  /** `cached` requests only the cron-precomputed signed full export and reports a miss instead of building live.
   *  `fresh` explicitly requests the O(n) live rebuild. Reconcile/doctor use cached + head + history tail, reserving
   *  fresh for projects that have no cached bundle yet. */
  async export(scope: { project: string; artifact_id?: string }, opts: { fresh?: boolean; cached?: boolean } = {}) {
    const p = new URLSearchParams();
    if (scope.artifact_id) p.set("artifact_id", scope.artifact_id);
    if (opts.fresh) p.set("fresh", "1");
    if (opts.cached) p.set("cached", "1");
    return this.req<ExportBundle>("GET", `/projects/${encodeURIComponent(scope.project)}/export?${p}`);
  }
  async head(project: string) {
    return this.req<{ seq: number; hash: string } | null>("GET", `/projects/${encodeURIComponent(project)}/head`);
  }
  async signedHead(project: string) {
    return this.req<{
      project: string;
      seq: number;
      hash: string;
      signed_at: string;
      issuer: { kid: string; alg: "Ed25519"; public_key: JsonWebKey };
      signature: string;
    } | null>("GET", `/projects/${encodeURIComponent(project)}/head?signed=1`);
  }
  async insert(): Promise<void> {
    throw new Error("RemoteStore.insert is not supported; use append()");
  }
  async byIdempotencyKey(): Promise<Event | null> {
    return null;
  }
  async get(id: string) {
    const res = await fetch(this.baseUrl + `/events/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: retraceHeaders(this.token),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Retrace API GET /events/${id} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as Event;
  }
  async all(project: string) {
    return collectHistory(this, { project });
  }
  async projects() {
    return this.req<string[]>("GET", `/projects`);
  }
  async history(q: HistoryQuery): Promise<HistoryPage> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && k !== "project") p.set(k, String(v));
    return asHistoryPage(await this.req<unknown>("GET", `/projects/${encodeURIComponent(q.project)}/events?${p}`));
  }
}
