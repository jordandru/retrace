/**
 * Retrace API + UI — Cloudflare Worker + D1. Routes live in @retrace/core createHandler:
 *   GET  /  or /ui                       timeline UI
 *   POST /events                         append an event (body = EventInput)
 *   GET  /events/:id · /events/:id/why
 *   GET  /projects · /projects/:p/events?… · /projects/:p/head · /projects/:p/verify
 * Auth: Bearer RETRACE_TOKEN (secret) or ?token= (used by the UI). Share links /s/:id are public + read-only.
 *   GET /projects/:p/export|report · POST /projects/:p/share · GET /.well-known/retrace-pubkey
 */
import { createHandler, parseSigningKey } from "@retrace/core";
import { D1Store } from "./d1-store.js";

export interface Env {
  DB: D1Database;
  RETRACE_TOKEN?: string;
  /** Ed25519 private JWK (JSON) — `wrangler secret put RETRACE_SIGNING_KEY` (generate with `retrace-export keygen`) */
  RETRACE_SIGNING_KEY?: string;
  RETRACE_ISSUER?: string;
  RETRACE_PUBLIC_URL?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return createHandler(new D1Store(env.DB), {
      token: env.RETRACE_TOKEN,
      signingKey: parseSigningKey(env.RETRACE_SIGNING_KEY),
      issuerName: env.RETRACE_ISSUER,
      publicUrl: env.RETRACE_PUBLIC_URL,
    })(req);
  },
};
