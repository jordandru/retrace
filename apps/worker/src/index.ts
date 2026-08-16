/**
 * Retrace API + UI — Cloudflare Worker + D1. Routes live in @retrace/core createHandler:
 *   GET  /  or /ui                       timeline UI
 *   POST /events                         append an event (body = EventInput)
 *   GET  /events/:id · /events/:id/why
 *   GET  /projects · /projects/:p/events?… · /projects/:p/head · /projects/:p/verify
 * Auth: Bearer RETRACE_TOKEN (secret) or ?token= (used by the UI).
 */
import { createHandler } from "@retrace/core";
import { D1Store } from "./d1-store.js";

export interface Env {
  DB: D1Database;
  RETRACE_TOKEN?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return createHandler(new D1Store(env.DB), env.RETRACE_TOKEN)(req);
  },
};
