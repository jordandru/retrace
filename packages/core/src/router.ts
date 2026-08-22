/**
 * Shared HTTP router (fetch API) — used by the Cloudflare Worker and the local Node server.
 *
 * Owner routes (auth: Bearer token or ?token= when a token is configured):
 *   GET  /  | /ui                        UI
 *   GET  /api                            health
 *   GET  /.well-known/retrace-pubkey     issuer public key (JWK) — public
 *   POST /events                         append (EventInput)
 *   GET  /events/:id · /events/:id/why
 *   GET  /projects · /projects/:p/events?… · /projects/:p/head · /projects/:p/verify
 *   GET  /projects/:p/export?artifact_id=…      signed JSON bundle
 *   GET  /projects/:p/report?artifact_id=…      printable HTML report
 *   GET  /projects/:p/lineage?artifact_id=&format=json|dot|mermaid&actors=1   artifact lineage graph
 *   POST /projects/:p/share  {artifact_id?, label?, expires_in_days?}   → {share, url}
 *   DELETE /projects/:p?confirm=:p       delete a project (junk cleanup; confirm must equal the project name) → per-table counts + an ops-project audit event
 *
 * Webhooks (auth: HMAC signature, not the bearer token):
 *   POST /hooks/github?project=<name>     GitHub webhook receiver (pull_request, pull_request_review, issue_comment, workflow_run[, push])
 *   POST /hooks/gdrive?project=<name>     Google Drive Activity forwarder (Apps Script / retrace-gdrive CLI); bearer-token auth
 *
 * Share routes (no auth; scope locked to the share's project/artifact; read-only):
 *   GET  /s/:id                          UI in shared mode
 *   GET  /s/:id/meta · /s/:id/events · /s/:id/verify · /s/:id/export · /s/:id/report · /s/:id/lineage
 */
import { EventInput } from "./schema.js";
import { EventStore, appendEvent, verifyProject, explainEvent, newShareId, shareIsLive, Share } from "./store.js";
import { buildExportBundle, verifyExportBundle } from "./export.js";
import { renderReportHtml } from "./report.js";
import { buildLineage, renderLineageDot, renderLineageMermaid } from "./lineage.js";
import { mapGithubWebhook, verifyGithubSignature } from "./github.js";
import { mapDriveActivities, DrivePayload } from "./gdrive.js";
import { publicFromPrivate, keyId } from "./signing.js";
import { UI_HTML } from "./ui-html.js";

export interface RouterOptions {
  token?: string;
  signingKey?: JsonWebKey | null;
  issuerName?: string;
  /** Public base URL used when building share links (defaults to request origin) */
  publicUrl?: string;
  /** GitHub webhook secret; POST /hooks/github?project=… is authenticated by X-Hub-Signature-256 instead of the bearer token */
  githubSecret?: string;
  /** Also log `push` commits from GitHub (off by default — the git adapter covers commits, and idempotency keys match anyway) */
  githubIncludePush?: boolean;
  /** Project that receives the audit event when a project is deleted (default "retrace") */
  opsProject?: string;
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/** deliveries that map to exactly one event can use the delivery id as idempotency key */
const inputs_needs_unique = (ghEvent: string) => ghEvent !== "push";

export function createHandler(store: EventStore, tokenOrOpts?: string | RouterOptions) {
  const opts: RouterOptions = typeof tokenOrOpts === "string" ? { token: tokenOrOpts } : tokenOrOpts ?? {};
  const { token } = opts;

  const lineageResponse = async (events: any[], fmt: string | null, actors: boolean) => {
    const l = buildLineage(events, { includeActors: actors });
    if (fmt === "dot") return new Response(renderLineageDot(l), { headers: { "content-type": "text/vnd.graphviz; charset=utf-8", ...CORS } });
    if (fmt === "mermaid") return new Response(renderLineageMermaid(l), { headers: { "content-type": "text/plain; charset=utf-8", ...CORS } });
    return json(l);
  };
  const exportFor = (scope: { project: string; artifact_id?: string }) => buildExportBundle(store, scope, { signingKey: opts.signingKey, issuerName: opts.issuerName });

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const base = (opts.publicUrl ?? url.origin).replace(/\/$/, "");
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (parts.length === 0 || parts[0] === "ui") return html(UI_HTML);
    if (parts[0] === "favicon.ico") return new Response(null, { status: 204 });
    if (parts[0] === "api" && parts.length === 1) return json({ name: "retrace-api", version: "0.1.0", ok: true, auth: !!token, signing: !!opts.signingKey });
    if (parts[0] === ".well-known" && parts[1] === "retrace-pubkey") {
      if (!opts.signingKey) return json({ error: "no signing key configured" }, 404);
      const pub = publicFromPrivate(opts.signingKey);
      return json({ kid: await keyId(pub), alg: "Ed25519", public_key: pub, name: opts.issuerName });
    }

    try {
      // ---- GitHub webhook ----
      if (req.method === "POST" && parts[0] === "hooks" && parts[1] === "github") {
        if (!opts.githubSecret) return json({ error: "github webhook not configured (set RETRACE_GITHUB_SECRET)" }, 404);
        const raw = await req.text();
        if (!(await verifyGithubSignature(opts.githubSecret, raw, req.headers.get("x-hub-signature-256")))) return json({ error: "bad signature" }, 401);
        const ghEvent = req.headers.get("x-github-event") ?? "";
        const delivery = req.headers.get("x-github-delivery") ?? undefined;
        if (ghEvent === "ping") return json({ ok: true, pong: true });
        const inputs = mapGithubWebhook(ghEvent, JSON.parse(raw), { project: url.searchParams.get("project") ?? undefined, includePush: opts.githubIncludePush, deliveryId: delivery && inputs_needs_unique(ghEvent) ? delivery : undefined });
        const results = [];
        for (const input of inputs) {
          const parsed = EventInput.safeParse(input);
          if (!parsed.success) { results.push({ error: parsed.error.issues }); continue; }
          for (let attempt = 0; ; attempt++) {
            try { const r = await appendEvent(store, parsed.data); results.push({ id: r.event.id, seq: r.event.seq, deduped: r.deduped }); break; }
            catch (e: any) { if (!/UNIQUE/i.test(String(e?.message)) || attempt >= 4) throw e; }
          }
        }
        return json({ ok: true, event: ghEvent, logged: results }, 201);
      }
      // ---- Google Drive activity forwarder (bearer auth like owner routes) ----
      if (req.method === "POST" && parts[0] === "hooks" && parts[1] === "gdrive") {
        if (token) {
          const auth = req.headers.get("authorization") ?? "";
          if (auth !== `Bearer ${token}` && url.searchParams.get("token") !== token) return json({ error: "unauthorized" }, 401);
        }
        const payload = (await req.json()) as DrivePayload;
        const inputs = mapDriveActivities({ ...payload, project: url.searchParams.get("project") ?? payload.project }, "google-drive");
        const results = [];
        for (const input of inputs) {
          const parsed = EventInput.safeParse(input);
          if (!parsed.success) { results.push({ error: parsed.error.issues }); continue; }
          for (let attempt = 0; ; attempt++) {
            try { const r = await appendEvent(store, parsed.data); results.push({ id: r.event.id, seq: r.event.seq, deduped: r.deduped }); break; }
            catch (e: any) { if (!/UNIQUE/i.test(String(e?.message)) || attempt >= 4) throw e; }
          }
        }
        return json({ ok: true, received: (payload.activities ?? []).length, logged: results.filter((r: any) => r.id && !r.deduped).length, deduped: results.filter((r: any) => r.deduped).length, results }, 201);
      }
      // ---- shared, read-only, scope-locked ----
      if (parts[0] === "s" && parts[1]) {
        const share = await store.getShare(parts[1]);
        if (!share || !shareIsLive(share)) return parts.length === 2 ? html("<h1>Share link not found or expired</h1>", 404) : json({ error: "share not found or expired" }, 404);
        const sub = parts[2];
        if (!sub) return html(UI_HTML);
        if (sub === "meta") return json(share);
        if (sub === "verify") return json(await verifyProject(store, share.project));
        if (sub === "events") {
          // same selection as the export (in-scope events + causal ancestors) so the shared UI can answer "why"
          const b = await buildExportBundle(store, { project: share.project, artifact_id: share.artifact_id });
          return json(b.events);
        }
        if (sub === "export") return json(await exportFor({ project: share.project, artifact_id: share.artifact_id }));
        if (sub === "lineage") {
          const b = await buildExportBundle(store, { project: share.project, artifact_id: share.artifact_id });
          return lineageResponse(b.events, url.searchParams.get("format"), url.searchParams.get("actors") === "1");
        }
        if (sub === "report") {
          const b = await exportFor({ project: share.project, artifact_id: share.artifact_id });
          return html(renderReportHtml(b, await verifyExportBundle(b), { baseUrl: base, title: share.label ? `Provenance report — ${share.label}` : undefined }));
        }
        return json({ error: "not found" }, 404);
      }

      // ---- owner routes ----
      if (token) {
        const auth = req.headers.get("authorization") ?? "";
        if (auth !== `Bearer ${token}` && url.searchParams.get("token") !== token) return json({ error: "unauthorized" }, 401);
      }
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
        if (parts[2] === "why") return json(await explainEvent(store, parts[1]));
        const e = await store.get(parts[1]);
        return e ? json(e) : json({ error: "not found" }, 404);
      }
      if (parts[0] === "projects") {
        if (parts.length === 1) return json(await store.projects());
        const project = parts[1];
        const sub = parts[2];
        const q = Object.fromEntries(url.searchParams) as Record<string, string>;
        delete q.token;
        if (req.method === "GET") {
          if (sub === "head") return json(await store.head(project));
          if (sub === "verify") return json(await verifyProject(store, project));
          if (sub === "events") return json(await store.history({ ...q, project, limit: q.limit ? Number(q.limit) : undefined }));
          if (sub === "export") return json(await exportFor({ project, artifact_id: q.artifact_id }));
          if (sub === "lineage") {
            const evs = q.artifact_id ? (await buildExportBundle(store, { project, artifact_id: q.artifact_id })).events : await store.all(project);
            return lineageResponse(evs, q.format ?? null, q.actors === "1");
          }
          if (sub === "report") {
            const b = await exportFor({ project, artifact_id: q.artifact_id });
            return html(renderReportHtml(b, await verifyExportBundle(b), { baseUrl: base }));
          }
        }
        if (req.method === "DELETE" && parts.length === 2) {
          if (!store.deleteProject) return json({ error: "project deletion not supported by this store" }, 501);
          const confirm = url.searchParams.get("confirm");
          if (confirm !== project) return json({ error: `destructive route: repeat the exact project name as ?confirm=${encodeURIComponent(project)} to delete it` }, 400);
          const head = await store.head(project);
          if (!head) return json({ error: "project not found" }, 404);
          const opsProject = opts.opsProject ?? "retrace";
          if (project === opsProject) return json({ error: "refusing to delete the ops/audit project" }, 403);
          const deleted = await store.deleteProject(project);
          // Record the final head so a later re-seed of this project from genesis is detectable against the ops chain.
          const ops = await appendEvent(store, {
            project: opsProject,
            actor: { type: "system", id: "worker" },
            action: "deleted",
            artifacts: [{ id: `project:${project}`, kind: "project", label: project }],
            intent: "project deleted via DELETE route",
            change: {
              summary: `deleted ${Object.entries(deleted).map(([t, n]) => `${n} ${t}`).join(", ")} at head ${head.hash} seq ${head.seq}`,
              before_hash: head.hash,
            },
          });
          return json({ ok: true, project, deleted, ops_event: ops.event.id });
        }
        if (req.method === "POST" && sub === "share") {
          const body = (await req.json().catch(() => ({}))) as { artifact_id?: string; label?: string; expires_in_days?: number; created_by?: string };
          const now = new Date();
          const share: Share = {
            id: newShareId(),
            project,
            artifact_id: body.artifact_id || undefined,
            label: body.label || undefined,
            created_at: now.toISOString(),
            expires_at: body.expires_in_days ? new Date(now.getTime() + body.expires_in_days * 86400000).toISOString() : undefined,
            created_by: body.created_by,
          };
          await store.createShare(share);
          return json({ share, url: `${base}/s/${share.id}`, report_url: `${base}/s/${share.id}/report`, export_url: `${base}/s/${share.id}/export` }, 201);
        }
      }
      return json({ error: "not found" }, 404);
    } catch (e: any) {
      return json({ error: String(e?.message ?? e) }, 500);
    }
  };
}
