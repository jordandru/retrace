/**
 * Retrace API — Cloudflare Worker + D1.
 *   POST /events                         append an event (body = EventInput)
 *   GET  /events/:id                     fetch one
 *   GET  /events/:id/why                 causal chain
 *   GET  /projects                       list projects
 *   GET  /projects/:p/events?...         history (filters: artifact_id, actor_id, actor_type, action, since, until, text, limit)
 *   GET  /projects/:p/head               chain head
 *   GET  /projects/:p/verify             verify chain
 * Auth: Bearer RETRACE_TOKEN (if the secret is set). Serialization: appends are serialized per project
 * via a retry loop on the UNIQUE(project, seq) constraint.
 */
import { EventInput, appendEvent, verifyProject, explainEvent } from "@retrace/core";
import { D1Store } from "./d1-store.js";

export interface Env {
  DB: D1Database;
  RETRACE_TOKEN?: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" } });
    if (env.RETRACE_TOKEN && req.headers.get("authorization") !== `Bearer ${env.RETRACE_TOKEN}`) return json({ error: "unauthorized" }, 401);

    const store = new D1Store(env.DB);
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (req.method === "POST" && parts[0] === "events" && parts.length === 1) {
        const parsed = EventInput.safeParse(await req.json());
        if (!parsed.success) return json({ error: "invalid event", issues: parsed.error.issues }, 400);
        // Retry on seq collision (concurrent appends to same project)
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const r = await appendEvent(store, parsed.data);
            return json(r, r.deduped ? 200 : 201);
          } catch (e: any) {
            if (!/UNIQUE/i.test(String(e?.message)) || attempt === 4) throw e;
          }
        }
      }
      if (req.method === "GET" && parts[0] === "events" && parts[1]) {
        if (parts[2] === "why") return json(await explainEvent(store, parts[1]));
        const e = await store.get(parts[1]);
        return e ? json(e) : json({ error: "not found" }, 404);
      }
      if (req.method === "GET" && parts[0] === "projects") {
        if (parts.length === 1) return json(await store.projects());
        const project = decodeURIComponent(parts[1]);
        if (parts[2] === "head") return json(await store.head(project));
        if (parts[2] === "verify") return json(await verifyProject(store, project));
        if (parts[2] === "events") {
          const q = Object.fromEntries(url.searchParams) as Record<string, string>;
          return json(await store.history({ ...q, project, limit: q.limit ? Number(q.limit) : undefined }));
        }
      }
      if (parts.length === 0) return json({ name: "retrace-api", version: "0.1.0", ok: true });
      return json({ error: "not found" }, 404);
    } catch (e: any) {
      return json({ error: String(e?.message ?? e) }, 500);
    }
  },
};
