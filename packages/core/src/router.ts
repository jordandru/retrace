/**
 * Shared HTTP router (fetch API) — used by the Cloudflare Worker and the local Node server.
 *
 * Owner routes (auth: Bearer token, or ?token= on GET/UI only). Per-actor credentials (RETRACE_CREDENTIALS,
 * Bearer only) may also POST /events and read; "pinned" credentials have their actor stamped by the server (with one
 * carve-out: an agent credential may record "instructed" roots for its configured on_behalf_of human), "assert"
 * credentials (git hook, backfill forwarders) may assert only the actors in their allowed_actors list. DELETE/share
 * stay owner-only.
 *   GET  /  | /ui                        UI
 *   GET  /api                            health + the schema surface this build understands (public; see schemaSurface)
 *   GET  /.well-known/retrace-pubkey     issuer public key (JWK) — public
 *   POST /events                         append (EventInput)
 *   GET  /events/:id · /events/:id/why
 *   GET  /projects · /projects/:p/events?… · /projects/:p/head · /projects/:p/verify · /projects/:p/status
 *   GET  /projects/:p/export?artifact_id=…      signed JSON bundle
 *   GET  /projects/:p/report?artifact_id=…      printable HTML report
 *   GET  /projects/:p/lineage?artifact_id=&format=json|dot|mermaid&actors=1   artifact lineage graph
 *   POST /projects/:p/share  {artifact_id?, label?, expires_in_days?}   → {share, url}
 *   DELETE /projects/:p?confirm=:p[&caused_by=evt_…]   delete a project (junk cleanup; confirm must equal the project name) → per-table counts +
 *                                        an ops-project audit event attributed to ownerActor (RETRACE_OWNER) and linked to caused_by
 *
 * Webhooks (auth: HMAC signature, not the bearer token):
 *   POST /hooks/github                    GitHub webhook; project is mapped from HMAC-covered repository.full_name via
 *                                         RETRACE_GITHUB_PROJECTS (never from ?project=, which sits outside the signature).
 *   POST /hooks/gdrive?project=<name>     Google Drive Activity forwarder (Apps Script / retrace-gdrive CLI); bearer-token auth.
 *                                         Assert credentials apply allowed_actors to each mapped actor. Optional payload.caused_by
 *                                         is stored on mapped events; empty/absent → root.
 *
 * Share routes (no auth on GET; scope locked to the share's project/artifact; read-only):
 *   GET  /s/:id                          UI in shared mode
 *   GET  /s/:id/meta · /s/:id/events · /s/:id/verify · /s/:id/export · /s/:id/report · /s/:id/lineage
 *   DELETE /s/:id                        owner-only revoke
 */
import { z } from "zod";
import { Actor, ActorType, EventInput, schemaSurface } from "./schema.js";
import { EventStore, appendEvent, AdapterIdempotencyError, CausedByError, verifyProject, explainEvent, newShareId, shareIsLive, Share, isHeadMovedError, SEALED_BY_PARAM, SEALED_BY_OWNER, SEALED_BY_UNAUTHENTICATED, SEALED_BY_GITHUB_WEBHOOK } from "./store.js";
import { sealEvent } from "./chain.js";
import { buildExportBundle, verifyExportBundle } from "./export.js";
import { renderReportHtml } from "./report.js";
import { buildLineage, renderLineageDot, renderLineageMermaid } from "./lineage.js";
import { mapGithubWebhook, verifyGithubSignature } from "./github.js";
import { mapDriveActivities, DrivePayload } from "./gdrive.js";
import { buildProjectStatus } from "./status.js";
import { publicFromPrivate, keyId } from "./signing.js";
import { UI_HTML } from "./ui-html.js";

function writeClientError(e: unknown): string | undefined {
  const name = (e as any)?.name;
  if (e instanceof AdapterIdempotencyError || name === "AdapterIdempotencyError") return (e as Error).message;
  if (e instanceof CausedByError || name === "CausedByError") return (e as Error).message;
}

const enc = new TextEncoder();

/** Constant-time compare: SHA-256 both sides then XOR, same loop as verifyGithubSignature (audit 2026-08-30). */
export async function tokenEquals(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const xa = new Uint8Array(ha), xb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ xb[i];
  return diff === 0;
}

/** Parse RETRACE_GITHUB_PROJECTS (JSON object of "owner/repo" → project). Throws on malformed config. */
export function parseGithubRepoProjects(raw?: string | null): Record<string, string> {
  if (!raw) return {};
  const obj = JSON.parse(raw);
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new Error("RETRACE_GITHUB_PROJECTS must be a JSON object of repo → project");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "string" || !v.trim()) throw new Error(`RETRACE_GITHUB_PROJECTS["${k}"] must be a non-empty project name`);
    out[k] = v;
  }
  return out;
}

/** Project for a GitHub delivery: HMAC-covered repository.full_name, optionally remapped. Query ?project= is never used. */
export function resolveGithubProject(repoFull: string, map: Record<string, string> | undefined): { project: string } | { error: string } {
  const m = map ?? {};
  if (Object.prototype.hasOwnProperty.call(m, repoFull)) return { project: m[repoFull] };
  if (Object.keys(m).length) return { error: `github repo "${repoFull}" is not in RETRACE_GITHUB_PROJECTS` };
  return { project: repoFull };
}

function publicShare(s: Share): Omit<Share, "created_by"> {
  const { created_by: _drop, ...rest } = s;
  return rest;
}

function errorRef(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** A per-actor credential (security review 2026-08-21, backlog #6). Holders can POST /events and read; they cannot
 *  DELETE or create shares. trust "pinned" (default): the Worker stamps `actor` from the credential — the body may only
 *  add display_name/version and may not claim human/system, except that an agent credential with `actor.on_behalf_of`
 *  may record "instructed" roots attributed to exactly that human (see resolveActor). trust "assert": the body actor
 *  is stored verbatim IF it appears in the credential's allowed_actors list (git hook, backfill, Drive forwarder —
 *  callers that legitimately relay other people's actions, bounded to the actors they are expected to relay). */
export const Credential = z.object({
  token: z.string().min(16),
  /** Human-readable name, recorded nowhere — for the operator's own bookkeeping */
  name: z.string().optional(),
  actor: Actor,
  trust: z.enum(["pinned", "assert"]).default("pinned"),
  /** For assert trust: the ONLY actors this credential may assert on POST /events and /hooks/gdrive, matched on exact
   *  type + id (audit 2026-08-22, P1; Drive actors-map bypass 2026-08-30). Absent or empty = may assert none on those
   *  writes. Ignored for pinned trust. */
  allowed_actors: z.array(z.object({ type: ActorType, id: z.string().min(1) })).optional(),
  /** Optional project allow-list (audit 2026-08-30). Unset = every project; set = POST/hooks/reads only those names. */
  projects: z.array(z.string().min(1)).optional(),
});
export type Credential = z.infer<typeof Credential>;
/** Parse the RETRACE_CREDENTIALS secret (JSON array). Throws on malformed config so a bad deploy fails loudly. */
export function parseCredentials(raw?: string | null): Credential[] {
  if (!raw) return [];
  return z.array(Credential).parse(JSON.parse(raw));
}

export interface RouterOptions {
  /** Owner token: full access, body actor stored verbatim. Bearer on every method; ?token= on GET/UI only. */
  token?: string;
  /** Per-actor credentials; see Credential. Bearer only (never ?token=, which leaks into logs). */
  credentials?: Credential[];
  signingKey?: JsonWebKey | null;
  issuerName?: string;
  /** Public base URL used when building share links (defaults to request origin) */
  publicUrl?: string;
  /** GitHub webhook secret; POST /hooks/github is authenticated by X-Hub-Signature-256 instead of the bearer token */
  githubSecret?: string;
  /** owner/repo → Retrace project. The HMAC covers the repo, not ?project= (audit 2026-08-30). */
  githubRepoProjects?: Record<string, string>;
  /** Also log `push` commits from GitHub (off by default — the git adapter covers commits, and idempotency keys match anyway) */
  githubIncludePush?: boolean;
  /** Project that receives the audit event when a project is deleted (default "retrace") */
  opsProject?: string;
  /** Who the owner token is. Owner-only actions (DELETE /projects/:p) are audited as this actor — typically the operator,
   *  e.g. {type:"human", id:"jordan@example.com"} from RETRACE_OWNER. Unset → {type:"system", id:"worker"}, which says
   *  only that *the server* did it (security review 2026-08-21, audit-event actor). */
  ownerActor?: Actor;
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS" };
const SHARE_CACHE = { "cache-control": "public, max-age=15" };
const json = (data: unknown, status = 200, extra?: Record<string, string>) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS, ...extra } });
const html = (body: string, status = 200, extra?: Record<string, string>) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...extra } });

/** deliveries that map to exactly one event can use the delivery id as idempotency key */
const inputs_needs_unique = (ghEvent: string) => ghEvent !== "push";

const SHARE_WINDOW_MS = 60_000;
const SHARE_MAX = 60;

export function createHandler(store: EventStore, tokenOrOpts?: string | RouterOptions) {
  const opts: RouterOptions = typeof tokenOrOpts === "string" ? { token: tokenOrOpts } : tokenOrOpts ?? {};
  const { token } = opts;
  const credentials = opts.credentials ?? [];
  type Principal = { kind: "owner" } | { kind: "credential"; credential: Credential } | null;
  const shareHits = new Map<string, { n: number; t: number }>();
  const shareLimited = (id: string): boolean => {
    const now = Date.now();
    const w = shareHits.get(id);
    if (!w || now - w.t > SHARE_WINDOW_MS) { shareHits.set(id, { n: 1, t: now }); return false; }
    w.n++;
    return w.n > SHARE_MAX;
  };
  /** WHO SEALED IT. Stamped server-side on every write so a reader can tell a pinned-credential event (the Worker
   *  fixed the actor) from an owner-asserted one (the body actor was stored verbatim) — without this the two are
   *  indistinguishable in the ledger, which is the hole a skeptic attacks first. Server wins over any caller value. */
  const sealedBy = (principal: Principal): string => {
    if (!principal) return SEALED_BY_UNAUTHENTICATED;
    if (principal.kind === "owner") return SEALED_BY_OWNER;
    const c = principal.credential;
    return `${c.trust === "assert" ? "assert" : "pinned"}:${c.name ?? `${c.actor.type}/${c.actor.id}`}`;
  };
  const stampSealedBy = <T extends { method?: EventInput["method"] }>(input: T, by: string): T =>
    ({ ...input, method: { ...input.method, params: { ...input.method?.params, [SEALED_BY_PARAM]: by } } });
  const projectAllowed = (principal: Principal, project: string): boolean => {
    if (principal?.kind !== "credential") return true;
    const allowed = principal.credential.projects;
    if (allowed === undefined) return true;
    return allowed.includes(project);
  };
  const actorAllowed = (principal: Principal, actor: Actor): boolean => {
    if (principal?.kind !== "credential" || principal.credential.trust !== "assert") return true;
    const allowed = principal.credential.allowed_actors ?? [];
    return allowed.some((a) => a.type === actor.type && a.id === actor.id);
  };
  /** Who is calling. `null` = unauthenticated (only valid when no token is configured at all). */
  const authenticate = async (req: Request, url: URL): Promise<Principal | "unauthorized"> => {
    const auth = req.headers.get("authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const queryTok = req.method === "GET" ? url.searchParams.get("token") : null;
    if (token) {
      if (bearer && await tokenEquals(bearer, token)) return { kind: "owner" };
      if (queryTok && await tokenEquals(queryTok, token)) return { kind: "owner" };
    }
    if (bearer) {
      for (const c of credentials) {
        if (await tokenEquals(bearer, c.token)) return { kind: "credential", credential: c };
      }
    }
    return token || credentials.length ? "unauthorized" : null;
  };
  /** Actor to store for POST /events under this principal (mirrors the MCP server's RETRACE_ACTOR_LOCK).
   *  One narrow carve-out so retrace_instruct works over a pinned credential: a pinned AGENT credential may record a
   *  HUMAN actor, but only the human it is configured to work for (`actor.on_behalf_of`) and only as an "instructed"
   *  root — it can relay its operator's instructions (mirroring the MCP server's RETRACE_ON_BEHALF_OF lock) but cannot
   *  forge arbitrary human actors or attribute other actions to its operator. */
  const resolveActor = (principal: Principal, body: Actor, action: string): { actor: Actor; relayed?: true } | { error: string } => {
    if (principal?.kind !== "credential") return { actor: body };
    if (principal.credential.trust === "assert") {
      // Assert trust is now bounded (audit 2026-08-22, P1): the body actor must be in the credential's explicit
      // allow-list — otherwise the holder of e.g. the git-hook token could forge events from any human or agent.
      if (!actorAllowed(principal, body))
        return { error: `actor ${body.type} "${body.id}" is not in this credential's allowed_actors: an assert credential may only record the actors explicitly listed for it in RETRACE_CREDENTIALS.` };
      return { actor: body };
    }
    const { actor } = principal.credential;
    if (body.type === "human" && actor.type === "agent") {
      if (!actor.on_behalf_of)
        return { error: `actor.type "human" is not allowed: this credential is pinned to agent "${actor.id}" and has no on_behalf_of human configured. Add actor.on_behalf_of to this credential in RETRACE_CREDENTIALS to let it relay its operator's instruction roots.` };
      if (body.id !== actor.on_behalf_of)
        return { error: `human "${body.id}" is not allowed: this credential is pinned to agent "${actor.id}" and may only relay instructions from its operator "${actor.on_behalf_of}".` };
      if (action !== "instructed")
        return { error: `action "${action}" is not allowed for a human actor on this credential: agent "${actor.id}" may only record "instructed" roots for "${actor.on_behalf_of}". Log the agent's own work as the agent.` };
      // `relayed` marks that THIS branch produced the actor — the stamp at the call site keys off it, so the stamp
      // can never drift onto other human-actor paths (assert-trust passthrough, pinned human credentials).
      return {
        relayed: true,
        actor: {
          type: "human",
          id: actor.on_behalf_of,
          ...(body.display_name !== undefined ? { display_name: body.display_name } : {}),
          ...(body.version !== undefined ? { version: body.version } : {}),
        },
      };
    }
    if (body.type !== actor.type)
      return { error: `actor.type "${body.type}" is not allowed: this credential is pinned to ${actor.type} "${actor.id}". Use an owner or assert-trust credential to record other actors.` };
    return {
      actor: {
        ...actor,
        ...(body.display_name !== undefined ? { display_name: body.display_name } : {}),
        ...(body.version !== undefined ? { version: body.version } : {}),
        // A pinned credential fixes WHO is acting, not WHICH MODEL ran: it is issued once and outlives every model
        // swap, so a model pinned here goes stale silently and seals the wrong author into an append-only ledger.
        // If the credential names a model it stays authoritative; if it omits one, the producer — the only side that
        // knows what actually ran — reports it. Identity is stamped from the credential either way, so this widens
        // nothing an operator did not opt into by leaving `model` out.
        ...(actor.type === "agent" && actor.model === undefined && body.model !== undefined ? { model: body.model } : {}),
      },
    };
  };

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
    // `schema` is what makes version skew detectable: a producer newer than this deployment would have its unknown
    // fields silently stripped by EventInput.safeParse below. Public, like the rest of this probe — the field NAMES
    // are already in the README, and being readable without a token is the point (you can check a deployment you
    // hold no credential for). See schemaSurface() and scripts/check-deploy.mjs.
    if (parts[0] === "api" && parts.length === 1) return json({ name: "retrace-api", version: "0.1.0", ok: true, auth: !!token || credentials.length > 0, credentials: credentials.length, signing: !!opts.signingKey, schema: schemaSurface() });
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
        let payload: any;
        try { payload = JSON.parse(raw); } catch { return json({ error: "invalid json" }, 400); }
        const repoFull = typeof payload?.repository?.full_name === "string" ? payload.repository.full_name : "";
        if (!repoFull) return json({ error: "github payload missing repository.full_name" }, 400);
        const resolved = resolveGithubProject(repoFull, opts.githubRepoProjects);
        if ("error" in resolved) return json({ error: resolved.error }, 403);
        const project = resolved.project;
        const deliveryKey = delivery && inputs_needs_unique(ghEvent) ? `gh:${delivery}` : undefined;
        if (deliveryKey) {
          for (const p of await store.projects()) {
            if (p === project) continue;
            if (await store.byIdempotencyKey(p, deliveryKey))
              return json({ error: `github delivery already sealed in project "${p}"` }, 409);
          }
        }
        const inputs = mapGithubWebhook(ghEvent, payload, { project, includePush: opts.githubIncludePush, deliveryId: delivery && inputs_needs_unique(ghEvent) ? delivery : undefined });
        const results = [];
        for (const input of inputs) {
          const parsed = EventInput.safeParse(input);
          if (!parsed.success) { results.push({ error: parsed.error.issues }); continue; }
          const stamped = stampSealedBy(parsed.data, SEALED_BY_GITHUB_WEBHOOK);
          for (let attempt = 0; ; attempt++) {
            try { const r = await appendEvent(store, stamped); results.push({ id: r.event.id, seq: r.event.seq, deduped: r.deduped }); break; }
            catch (e: any) {
              const client = writeClientError(e);
              if (client) return json({ error: client }, 400);
              if (!/UNIQUE/i.test(String(e?.message)) || attempt >= 4) throw e;
            }
          }
        }
        return json({ ok: true, event: ghEvent, project, logged: results }, 201);
      }
      // ---- Google Drive activity forwarder (owner token or an assert-trust credential: it relays other people's edits) ----
      if (req.method === "POST" && parts[0] === "hooks" && parts[1] === "gdrive") {
        const principal = await authenticate(req, url);
        if (principal === "unauthorized") return json({ error: "unauthorized" }, 401);
        if (principal?.kind === "credential" && principal.credential.trust !== "assert") return json({ error: "forbidden: the Drive forwarder needs the owner token or an assert-trust credential" }, 403);
        const payload = (await req.json()) as DrivePayload;
        const project = url.searchParams.get("project") ?? payload.project ?? "google-drive";
        if (!projectAllowed(principal, project)) return json({ error: `forbidden: this credential is not scoped to project "${project}"` }, 403);
        const inputs = mapDriveActivities({ ...payload, project }, "google-drive");
        const results = [];
        for (const input of inputs) {
          const parsed = EventInput.safeParse(input);
          if (!parsed.success) { results.push({ error: parsed.error.issues }); continue; }
          if (!actorAllowed(principal, parsed.data.actor)) {
            results.push({ error: `actor ${parsed.data.actor.type} "${parsed.data.actor.id}" is not in this credential's allowed_actors` });
            continue;
          }
          const stamped = stampSealedBy(parsed.data, sealedBy(principal));
          for (let attempt = 0; ; attempt++) {
            try { const r = await appendEvent(store, stamped); results.push({ id: r.event.id, seq: r.event.seq, deduped: r.deduped }); break; }
            catch (e: any) {
              const client = writeClientError(e);
              if (client) return json({ error: client }, 400);
              if (!/UNIQUE/i.test(String(e?.message)) || attempt >= 4) throw e;
            }
          }
        }
        return json({ ok: true, received: (payload.activities ?? []).length, logged: results.filter((r: any) => r.id && !r.deduped).length, deduped: results.filter((r: any) => r.deduped).length, results }, 201);
      }
      // ---- share revoke (owner) then public read-only, scope-locked ----
      if (parts[0] === "s" && parts[1]) {
        if (req.method === "DELETE" && parts.length === 2) {
          const principal = await authenticate(req, url);
          if (principal === "unauthorized") return json({ error: "unauthorized" }, 401);
          if (principal?.kind !== "owner") return json({ error: "forbidden: this route needs the owner token" }, 403);
          if (!store.deleteShare) return json({ error: "share revocation not supported by this store" }, 501);
          const existed = await store.deleteShare(parts[1]);
          return existed ? json({ ok: true, id: parts[1] }) : json({ error: "share not found" }, 404);
        }
        if (shareLimited(parts[1])) return json({ error: "rate limited" }, 429);
        const share = await store.getShare(parts[1]);
        if (!share || !shareIsLive(share)) return parts.length === 2 ? html("<h1>Share link not found or expired</h1>", 404) : json({ error: "share not found or expired" }, 404);
        const sub = parts[2];
        if (!sub) return html(UI_HTML, 200, SHARE_CACHE);
        if (sub === "meta") return json(publicShare(share), 200, SHARE_CACHE);
        if (sub === "verify") return json(await verifyProject(store, share.project), 200, SHARE_CACHE);
        if (sub === "events") {
          // same selection as the export (in-scope events + causal ancestors) so the shared UI can answer "why"
          const b = await buildExportBundle(store, { project: share.project, artifact_id: share.artifact_id });
          return json(b.events, 200, SHARE_CACHE);
        }
        if (sub === "export") return json(await exportFor({ project: share.project, artifact_id: share.artifact_id }), 200, SHARE_CACHE);
        if (sub === "lineage") {
          const b = await buildExportBundle(store, { project: share.project, artifact_id: share.artifact_id });
          return lineageResponse(b.events, url.searchParams.get("format"), url.searchParams.get("actors") === "1");
        }
        if (sub === "report") {
          const b = await exportFor({ project: share.project, artifact_id: share.artifact_id });
          return html(renderReportHtml(b, await verifyExportBundle(b), { baseUrl: base, title: share.label ? `Provenance report — ${share.label}` : undefined }), 200, SHARE_CACHE);
        }
        return json({ error: "not found" }, 404);
      }

      // ---- owner routes ----
      const principal = await authenticate(req, url);
      if (principal === "unauthorized") return json({ error: "unauthorized" }, 401);
      // Per-actor credentials may append and read; anything destructive or outward-facing stays owner-only.
      if (principal?.kind === "credential" && (req.method === "DELETE" || (req.method === "POST" && parts[0] !== "events")))
        return json({ error: "forbidden: this route needs the owner token" }, 403);
      if (req.method === "POST" && parts[0] === "events" && parts.length === 1) {
        const parsed = EventInput.safeParse(await req.json());
        if (!parsed.success) return json({ error: "invalid event", issues: parsed.error.issues }, 400);
        if (!projectAllowed(principal, parsed.data.project))
          return json({ error: `forbidden: this credential is not scoped to project "${parsed.data.project}"` }, 403);
        const resolved = resolveActor(principal, parsed.data.actor, parsed.data.action);
        if ("error" in resolved) return json(resolved, 403);
        const params = { ...parsed.data.method?.params };
        delete params.relayed_by;
        delete params[SEALED_BY_PARAM];
        const location = parsed.data.location ? { ...parsed.data.location } : undefined;
        if (location && !resolved.relayed) delete location.client;
        let input = stampSealedBy({
          ...parsed.data,
          actor: resolved.actor,
          method: parsed.data.method ? { ...parsed.data.method, params } : undefined,
          location,
        }, sealedBy(principal));
        // A relayed instruction root is stamped with the credential's agent id, so the chain records that the human
        // did not write this event themselves — their agent did, on their behalf. Keyed on the carve-out's own flag:
        // assert-trust human events (git hook, forwarders) and other human paths must NOT get a relayed_by stamp.
        if (resolved.relayed && principal?.kind === "credential")
          input = { ...input, method: { ...input.method, params: { ...input.method?.params, relayed_by: principal.credential.actor.id } } };
        for (let attempt = 0; ; attempt++) {
          try {
            const r = await appendEvent(store, input);
            return json(r, r.deduped ? 200 : 201);
          } catch (e: any) {
            const client = writeClientError(e);
            if (client) return json({ error: client }, 400);
            if (!/UNIQUE/i.test(String(e?.message)) || attempt >= 4) throw e;
          }
        }
      }
      if (req.method === "GET" && parts[0] === "events" && parts[1]) {
        const e = parts[2] === "why" ? (await store.get(parts[1])) : await store.get(parts[1]);
        if (!e) return json({ error: "not found" }, 404);
        if (!projectAllowed(principal, e.project)) return json({ error: "not found" }, 404);
        if (parts[2] === "why") return json(await explainEvent(store, parts[1]));
        return json(e);
      }
      if (parts[0] === "projects") {
        if (parts.length === 1) {
          const names = await store.projects();
          if (principal?.kind === "credential" && principal.credential.projects)
            return json(names.filter((p) => principal.credential.projects!.includes(p)));
          return json(names);
        }
        const project = parts[1];
        if (!projectAllowed(principal, project)) return json({ error: `forbidden: this credential is not scoped to project "${project}"` }, 403);
        const sub = parts[2];
        const q = Object.fromEntries(url.searchParams) as Record<string, string>;
        delete q.token;
        if (req.method === "GET") {
          if (sub === "head") return json(await store.head(project));
          if (sub === "verify") return json(await verifyProject(store, project));
          if (sub === "status") return json(await buildProjectStatus(store, project));
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
          const opsProject = opts.opsProject ?? "retrace";
          if (project === opsProject) return json({ error: "refusing to delete the ops/audit project" }, 403);
          for (let attempt = 0; ; attempt++) {
            // Seal the audit event first, then let the store delete + insert it in ONE transaction (B3): a deletion can
            // never exist without its audit record. The final head is recorded so a later re-seed of this project from
            // genesis is detectable against the ops chain. Seq is 0-based, so the event count is head.seq + 1. The head
            // is read inside the loop and handed to the store as the expected head: if a write to the project races the
            // delete, the store throws HeadMovedError instead of committing an audit that misreports the head/count.
            // Attribute the audit to whoever holds the owner token (the only principal allowed here), not to the server.
            const head = await store.head(project);
            if (!head) return json({ error: "project not found" }, 404);
            const auditInput = stampSealedBy({
              project: opsProject,
              actor: opts.ownerActor ?? { type: "system", id: "worker" },
              action: "deleted" as const,
              artifacts: [{ id: `project:${project}`, kind: "project", label: project }],
              intent: "project deleted via DELETE route",
              caused_by: url.searchParams.get("caused_by") ?? undefined,
              method: { tool: "http", automated: !opts.ownerActor, params: { route: "DELETE /projects/:p", principal: "owner" } },
              location: { url: `${base}/projects/${encodeURIComponent(project)}`, system: "retrace-api" },
              change: { summary: `deleted project "${project}" (${head.seq + 1} events) at head ${head.hash} seq ${head.seq}`, before_hash: head.hash },
            } satisfies EventInput, SEALED_BY_OWNER);
            const audit = await sealEvent(auditInput, await store.head(opsProject));
            try {
              const deleted = await store.deleteProject(project, audit, head);
              return json({ ok: true, project, deleted, ops_event: audit.id });
            } catch (e: any) {
              // Either a concurrent ops-project write took our seq (UNIQUE) or the target project was written to
              // (HeadMovedError): the whole transaction rolled back, so re-read both heads, re-seal and retry.
              if (!(isHeadMovedError(e) || /UNIQUE/i.test(String(e?.message))) || attempt >= 4) throw e;
            }
          }
        }
        if (req.method === "POST" && sub === "share") {
          const body = (await req.json().catch(() => ({}))) as { artifact_id?: string; label?: string; expires_in_days?: number; created_by?: string };
          if (body.expires_in_days !== undefined) {
            const d = body.expires_in_days;
            if (typeof d !== "number" || !Number.isFinite(d) || d < 1 || d > 365)
              return json({ error: "expires_in_days must be a number of days between 1 and 365" }, 400);
          }
          const now = new Date();
          const share: Share = {
            id: newShareId(),
            project,
            artifact_id: body.artifact_id || undefined,
            label: body.label || undefined,
            created_at: now.toISOString(),
            expires_at: body.expires_in_days ? new Date(now.getTime() + body.expires_in_days * 86400000).toISOString() : undefined,
            created_by: opts.ownerActor?.id,
          };
          await store.createShare(share);
          return json({ share: publicShare(share), url: `${base}/s/${share.id}`, report_url: `${base}/s/${share.id}/report`, export_url: `${base}/s/${share.id}/export` }, 201);
        }
      }
      return json({ error: "not found" }, 404);
    } catch (e: any) {
      const ref = errorRef();
      console.error(`retrace-api: request failed [${ref}] ${req.method} ${url.pathname}: ${e?.stack ?? e?.message ?? e}`);
      return json({ error: `internal error (ref ${ref})` }, 500);
    }
  };
}
