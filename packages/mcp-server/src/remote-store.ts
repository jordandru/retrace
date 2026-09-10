/** Remote store: talks to the Retrace Cloudflare Worker over HTTP. Set RETRACE_URL (+ RETRACE_TOKEN). */
import { Event, EventStore, HistoryQuery, HistoryPage, VerifyResult, EventInput, Share, ProjectStatus, asHistoryPage, collectHistory, parseExportBundle, parseJsonRejectDuplicateKeys, PolicyError } from "@retrace-dev/core";

function parseRemoteJson(raw: string, what: string): unknown {
  try {
    return parseJsonRejectDuplicateKeys(raw);
  } catch (e) {
    if (e instanceof PolicyError) throw new Error(`${what}: ${e.message}`);
    throw e;
  }
}

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

export class RemoteCapabilityError extends Error {
  readonly kind = "capability_mismatch";
  readonly retryable = true;

  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    detail: string,
  ) {
    super(`${method} ${path} returned ${status}; ${detail}`);
    this.name = "RemoteCapabilityError";
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
  constructor(private baseUrl: string, private token?: string, private options: { deadlineMs?: number } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: retraceHeaders(this.token),
      body: body ? JSON.stringify(body) : undefined,
      signal: this.options.deadlineMs === undefined ? undefined : AbortSignal.timeout(this.options.deadlineMs),
    });
    if (!res.ok) throw new RemoteApiError(method, path, res.status, new Headers(res.headers), await res.text());
    return (await res.json()) as T;
  }
  async humanAuthority(): Promise<{actor: {type: "human"; id: string}; sealed_by: "owner"; attribution_profile: string}> { return this.req("GET", "/identity"); }
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
    const path = `/projects/${encodeURIComponent(scope.project)}/export?${p}`;
    const res = await fetch(this.baseUrl + path, {
      method: "GET",
      headers: retraceHeaders(this.token),
      signal: this.options.deadlineMs === undefined ? undefined : AbortSignal.timeout(this.options.deadlineMs),
    });
    if (!res.ok) throw new RemoteApiError("GET", path, res.status, new Headers(res.headers), await res.text());
    try {
      return parseExportBundle(await res.text());
    } catch (e: any) {
      throw new Error(`Retrace API GET ${path}: ${e?.message ?? e}`);
    }
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
    return parseRemoteJson(await res.text(), `Retrace API GET /events/${id}`) as Event;
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
