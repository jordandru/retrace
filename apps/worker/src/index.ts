/**
 * Retrace API + UI — Cloudflare Worker + D1. Routes live in @retrace/core createHandler:
 *   GET  /  or /ui                       timeline UI
 *   POST /events                         append an event (body = EventInput)
 *   GET  /events/:id · /events/:id/why
 *   GET  /projects · /projects/:p/events?… · /projects/:p/head · /projects/:p/verify
 *   DELETE /projects/:p?confirm=:p        junk-project cleanup; audit event goes to RETRACE_OPS_PROJECT, attributed to RETRACE_OWNER
 * Auth: Bearer RETRACE_TOKEN (secret) or ?token= (used by the UI). Share links /s/:id are public + read-only.
 *   RETRACE_CREDENTIALS (secret, JSON array of {token, actor, trust?}) — per-actor tokens that may POST /events + read;
 *   "pinned" (default) stamps the actor server-side, "assert" stores the body actor verbatim. See core Credential.
 *   GET /projects/:p/export|report|lineage · POST /projects/:p/share · GET /.well-known/retrace-pubkey
 *   POST /hooks/github?project=…  (GitHub webhook; HMAC-verified with RETRACE_GITHUB_SECRET)
 */
import { createHandler, parseCredentials, parseSigningKey } from "@retrace/core";
import { D1Store } from "./d1-store.js";

export interface Env {
  DB: D1Database;
  RETRACE_TOKEN?: string;
  /** `wrangler secret put RETRACE_CREDENTIALS` — JSON array of per-actor credentials (see @retrace/core Credential) */
  RETRACE_CREDENTIALS?: string;
  /** Ed25519 private JWK (JSON) — `wrangler secret put RETRACE_SIGNING_KEY` (generate with `retrace-export keygen`) */
  RETRACE_SIGNING_KEY?: string;
  RETRACE_ISSUER?: string;
  RETRACE_PUBLIC_URL?: string;
  /** `wrangler secret put RETRACE_GITHUB_SECRET` — same value as the webhook secret in GitHub repo settings */
  RETRACE_GITHUB_SECRET?: string;
  RETRACE_GITHUB_PUSH?: string;
  /** Project that receives the audit event when DELETE /projects/:p runs (default "retrace") */
  RETRACE_OPS_PROJECT?: string;
  /** Email/name of the person who holds RETRACE_TOKEN; owner-only actions (DELETE) are audited as this human */
  RETRACE_OWNER?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return createHandler(new D1Store(env.DB), {
      token: env.RETRACE_TOKEN,
      credentials: parseCredentials(env.RETRACE_CREDENTIALS),
      signingKey: parseSigningKey(env.RETRACE_SIGNING_KEY),
      issuerName: env.RETRACE_ISSUER,
      publicUrl: env.RETRACE_PUBLIC_URL,
      githubSecret: env.RETRACE_GITHUB_SECRET,
      githubIncludePush: env.RETRACE_GITHUB_PUSH === "1",
      opsProject: env.RETRACE_OPS_PROJECT,
      ownerActor: env.RETRACE_OWNER ? { type: "human", id: env.RETRACE_OWNER } : undefined,
    })(req);
  },
};
