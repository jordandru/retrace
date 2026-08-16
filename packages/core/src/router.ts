/**
 * Shared HTTP router (fetch API) — used by the Cloudflare Worker and the local Node server.
 *   GET  /                               UI
 *   GET  /ui                             UI
 *   GET  /api                            health
 *   POST /events                         append (EventInput)
 *   GET  /events/:id                     one event
 *   GET  /events/:id/why                 causal chain
 *   GET  /projects                       list
 *   GET  /projects/:p/events?...         history
 *   GET  /projects/:p/head               chain head
 *   GET  /projects/:p/verify             verify
 */
import { EventInput } from "./schema.js";
import { EventStore, appendEvent, verifyProject, explainEvent } from "./store.js";
import { UI_HTML } from "./ui-html.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS } });

export function createHandler(store: EventStore, token?: string) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (parts.length === 0 || parts[0] === "ui") return new Response(UI_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (parts[0] === "favicon.ico") return new Response(null, { status: 204 });
    if (parts[0] === "api" && parts.length === 1) return json({ name: "retrace-api", version: "0.1.0", ok: true, auth: !!token });
    if (token) {
      const auth = req.headers.get("authorization") ?? "";
      const qtok = url.searchParams.get("token");
      if (auth !== `Bearer ${token}` && qtok !== token) return json({ error: "unauthorized" }, 401);
    }
    try {
      if (req.method === "POST" && parts[0] === "events" && parts.length === 1) {
        const parsed = EventInput.safeParse(await req.json());
        if (!parsed.success) return json({ error: "invalid event", issues: parsed.error.issues }, 400);
        for (let attempt = 0; ; attempt++) {
          try {
            const r = await appendEvent(store, parsed.data);
            return json(r, r.deduped ? 200 : 201);
          } catch (e: any) {
            if (!/UNIQUE/i.test(String(e?.message)) || attempt >= 4) throw e;
          }
        }
      }
      if (req.method === "GET" && parts[0] === "events" && parts[1]) {
        const id = decodeURIComponent(parts[1]);
        if (parts[2] === "why") return json(await explainEvent(store, id));
        const e = await store.get(id);
        return e ? json(e) : json({ error: "not found" }, 404);
      }
      if (req.method === "GET" && parts[0] === "projects") {
        if (parts.length === 1) return json(await store.projects());
        const project = decodeURIComponent(parts[1]);
        if (parts[2] === "head") return json(await store.head(project));
        if (parts[2] === "verify") return json(await verifyProject(store, project));
        if (parts[2] === "events") {
          const q = Object.fromEntries(url.searchParams) as Record<string, string>;
          delete q.token;
          return json(await store.history({ ...q, project, limit: q.limit ? Number(q.limit) : undefined }));
        }
      }
      return json({ error: "not found" }, 404);
    } catch (e: any) {
      return json({ error: String(e?.message ?? e) }, 500);
    }
  };
}
