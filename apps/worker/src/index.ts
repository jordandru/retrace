/**
 * Retrace API + UI — Cloudflare Worker + D1. Routes live in @retrace-dev/core createHandler:
 *   GET  /  or /ui                       timeline UI
 *   POST /events                         append an event (body = EventInput)
 *   GET  /events/:id · /events/:id/why
 *   GET  /projects · /projects/:p/events?… · /projects/:p/head · /projects/:p/verify
 *   DELETE /projects/:p?confirm=:p        junk-project cleanup; audit event goes to RETRACE_OPS_PROJECT, attributed to RETRACE_OWNER
 * Auth: Bearer RETRACE_TOKEN (secret) or ?token= (used by the UI). Share links /s/:id are public + read-only.
 *   RETRACE_CREDENTIALS (secret, JSON array of {token, actor, trust?}) — per-actor tokens that may POST /events + read;
 *   "pinned" (default) stamps the actor server-side, "assert" stores the body actor verbatim. See core Credential.
 *   GET /projects/:p/export|report|lineage · POST /projects/:p/share · GET /.well-known/retrace-pubkey
 *   POST /hooks/github  (GitHub webhook; HMAC-verified with RETRACE_GITHUB_SECRET; project from repo via RETRACE_GITHUB_PROJECTS)
 */
import { createHandler, parseCheckpointProjectAllowlist, parseCredentials, parseGithubRepoProjects, parseSigningKey, runCheckpointCron } from "@retrace-dev/core";
import { D1Store } from "./d1-store.js";
import { D1CheckpointLog } from "./checkpoint-log.js";
import { handleRemoteMcp } from "./mcp.js";

export interface Env {
  DB: D1Database;
  RETRACE_TOKEN?: string;
  /** `wrangler secret put RETRACE_CREDENTIALS` — JSON array of per-actor credentials (see @retrace-dev/core Credential) */
  RETRACE_CREDENTIALS?: string;
  /** Ed25519 private JWK (JSON) — `wrangler secret put RETRACE_SIGNING_KEY` (generate with `retrace-export keygen`) */
  RETRACE_SIGNING_KEY?: string;
  RETRACE_ISSUER?: string;
  RETRACE_PUBLIC_URL?: string;
  /** Explicit kill switch for the experimental Streamable HTTP audit endpoint at /mcp. */
  RETRACE_MCP_ENABLED?: string;
  /** `wrangler secret put RETRACE_GITHUB_SECRET` — same value as the webhook secret in GitHub repo settings */
  RETRACE_GITHUB_SECRET?: string;
  /** JSON object of "owner/repo" → Retrace project. The HMAC covers the repo, not ?project=. */
  RETRACE_GITHUB_PROJECTS?: string;
  /** JSON array of projects whose checkpoint contents may be published to the public Rekor log. Missing = none. */
  RETRACE_CHECKPOINT_PROJECTS?: string;
  RETRACE_GITHUB_PUSH?: string;
  /** Project that receives the audit event when DELETE /projects/:p runs (default "retrace") */
  RETRACE_OPS_PROJECT?: string;
  /** Email/name of the person who holds RETRACE_TOKEN; owner-only actions (DELETE) are audited as this human */
  RETRACE_OWNER?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const store = new D1Store(env.DB);
    const api = createHandler(store, {
      // Cloud deployments have no safe implicit-open mode: missing secrets must make the service unavailable rather
      // than granting anonymous read, append, share, and delete access. Local RETRACE_OPEN remains explicit in serve.ts.
      requireAuth: true,
      token: env.RETRACE_TOKEN,
      credentials: parseCredentials(env.RETRACE_CREDENTIALS),
      signingKey: parseSigningKey(env.RETRACE_SIGNING_KEY),
      issuerName: env.RETRACE_ISSUER,
      publicUrl: env.RETRACE_PUBLIC_URL,
      githubSecret: env.RETRACE_GITHUB_SECRET,
      githubRepoProjects: parseGithubRepoProjects(env.RETRACE_GITHUB_PROJECTS),
      githubIncludePush: env.RETRACE_GITHUB_PUSH === "1",
      opsProject: env.RETRACE_OPS_PROJECT,
      ownerActor: env.RETRACE_OWNER ? { type: "human", id: env.RETRACE_OWNER } : undefined,
    });
    if (new URL(req.url).pathname === "/mcp") return handleRemoteMcp(req, env, store, api);
    return api(req);
  },

  /** Hourly cron (wrangler.toml [triggers]): checkpoint explicitly opted-in moved heads and witness them in Rekor.
   *  Signed with the Worker's own signing key — the witness's authority is Rekor's log, not the key. No signing key
   *  configured → the run is skipped (an unsigned scheduled checkpoint asserts nothing worth storing). */
  async scheduled(_controller: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    const projects = parseCheckpointProjectAllowlist(env.RETRACE_CHECKPOINT_PROJECTS);
    if (projects.length === 0) {
      console.log("checkpoint cron skipped: RETRACE_CHECKPOINT_PROJECTS has no opted-in projects");
      return;
    }
    const signingKey = parseSigningKey(env.RETRACE_SIGNING_KEY);
    if (!signingKey) return;
    ctx.waitUntil(
      runCheckpointCron(new D1Store(env.DB), new D1CheckpointLog(env.DB), { signingKey, projects, signerName: env.RETRACE_ISSUER }).then(
        (results) => console.log("checkpoint cron:", JSON.stringify(results)),
        (e) => console.error("checkpoint cron failed:", String((e as Error)?.message ?? e)),
      ),
    );
  },
};
