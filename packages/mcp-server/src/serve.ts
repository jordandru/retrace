#!/usr/bin/env node
/**
 * Local Retrace server: serves the timeline UI + REST API from the same SQLite file the MCP server writes to.
 *   retrace-serve            → http://127.0.0.1:7777/?token=…
 *
 * Default-closed: binds the loopback interface only and requires a token. With no RETRACE_TOKEN and no
 * RETRACE_CREDENTIALS a random one-time token is generated for this run and printed with the URL — nothing on the
 * machine (or the LAN, if you widen the bind) can read the ledger without it. RETRACE_OPEN=1 restores an
 * unauthenticated server, and only on a loopback host: opening an unauthenticated ledger to a non-loopback address is
 * refused rather than silently served.
 *
 * Env: RETRACE_DB, RETRACE_HOST (127.0.0.1), RETRACE_PORT (7777), RETRACE_TOKEN (owner bearer/query token; generated per
 *      run if absent), RETRACE_OPEN=1 (no auth; loopback only), RETRACE_CREDENTIALS (per-actor tokens, JSON),
 *      RETRACE_SIGNING_KEY (JWK; else ~/.retrace/signing-key.json, auto-created), RETRACE_ISSUER, RETRACE_PUBLIC_URL,
 *      RETRACE_GITHUB_SECRET (enables POST /hooks/github), RETRACE_GITHUB_PUSH=1 (also log push commits),
 *      RETRACE_OWNER (who holds RETRACE_TOKEN; DELETE /projects/:p audit events are attributed to this human)
 */
import { createServer, IncomingMessage, Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { createHandler, parseCredentials, parseSigningKey, Credential } from "@retrace-dev/core";
import { loadSigningKey } from "./keys.js";
import { makeStore } from "./index.js";
import { isMainModule } from "./is-main.js";

function toRequest(req: IncomingMessage): Request {
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, { method: req.method, headers, body: hasBody ? (Readable.toWeb(req) as any) : undefined, ...(hasBody ? { duplex: "half" } : {}) } as any);
}

export interface ServeConfig {
  host: string;
  port: number;
  /** owner token; undefined only when `open` */
  token?: string;
  /** true when the token was generated for this run (not from RETRACE_TOKEN) */
  generated: boolean;
  /** unauthenticated mode (RETRACE_OPEN=1); allowed on loopback hosts only */
  open: boolean;
  credentials: Credential[];
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7777;

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Decide bind host and auth from the environment (plus explicit overrides). Pure, so it can be tested without
 * opening a socket. Throws when the combination would expose an unauthenticated ledger beyond loopback.
 */
export function resolveServeConfig(env: NodeJS.ProcessEnv = process.env, over: Partial<Pick<ServeConfig, "host" | "port" | "token" | "open">> = {}): ServeConfig {
  const host = over.host ?? env.RETRACE_HOST ?? DEFAULT_HOST;
  const port = over.port ?? Number(env.RETRACE_PORT ?? DEFAULT_PORT);
  const open = over.open ?? env.RETRACE_OPEN === "1";
  const credentials = parseCredentials(env.RETRACE_CREDENTIALS);
  let token = over.token ?? env.RETRACE_TOKEN ?? undefined;
  if (open && !isLoopbackHost(host)) {
    throw new Error(`RETRACE_OPEN=1 serves the ledger without authentication and is only allowed on a loopback host; refusing to bind ${host}. Set RETRACE_TOKEN (or RETRACE_CREDENTIALS) to serve on that address.`);
  }
  let generated = false;
  if (!open && !token && credentials.length === 0) {
    token = randomBytes(24).toString("base64url");
    generated = true;
  }
  return { host, port, token, generated, open, credentials };
}

export interface StartedServer { server: Server; config: ServeConfig; url: string }

export function startServer(over: Partial<Pick<ServeConfig, "host" | "port" | "token" | "open">> = {}, env: NodeJS.ProcessEnv = process.env): StartedServer {
  const config = resolveServeConfig(env, over);
  const handle = createHandler(makeStore(), {
    token: config.token,
    credentials: config.credentials,
    signingKey: parseSigningKey(env.RETRACE_SIGNING_KEY) ?? loadSigningKey(),
    issuerName: env.RETRACE_ISSUER,
    publicUrl: env.RETRACE_PUBLIC_URL,
    githubSecret: env.RETRACE_GITHUB_SECRET,
    githubIncludePush: env.RETRACE_GITHUB_PUSH === "1",
    ownerActor: env.RETRACE_OWNER ? { type: "human", id: env.RETRACE_OWNER } : undefined,
  });
  const server = createServer(async (req, res) => {
    try {
      const out = await handle(toRequest(req));
      const hdrs: Record<string, string> = {};
      out.headers.forEach((v, k) => (hdrs[k] = v));
      res.writeHead(out.status, hdrs);
      res.end(Buffer.from(await out.arrayBuffer()));
    } catch (e: any) {
      // Never echo internal error text (SQL, paths) to a caller who may be unauthenticated; keep it on stderr.
      const ref = randomBytes(4).toString("hex");
      console.error(`retrace-serve: request failed [${ref}] ${req.method} ${req.url}: ${e?.stack ?? e?.message ?? e}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `internal error (ref ${ref})` }));
    }
  });
  const urlHost = config.host.includes(":") ? `[${config.host}]` : config.host;
  const url = `http://${urlHost}:${config.port}`;
  server.listen(config.port, config.host, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : config.port;
    const base = `http://${urlHost}:${port}`;
    if (config.open) console.error(`Retrace UI + API → ${base}  (RETRACE_OPEN=1: no authentication, loopback only)`);
    else if (config.generated) console.error(`Retrace UI + API → ${base}/?token=${config.token}\n  one-time token for this run — set RETRACE_TOKEN to make it stable, or RETRACE_OPEN=1 for an unauthenticated loopback server`);
    else console.error(`Retrace UI + API → ${base}  (token from RETRACE_TOKEN${config.credentials.length ? `, ${config.credentials.length} credential${config.credentials.length === 1 ? "" : "s"}` : ""})`);
    if (!isLoopbackHost(config.host)) console.error(`  bound to ${config.host}: reachable from other machines; every read and write needs the token`);
  });
  return { server, config, url };
}

if (isMainModule(import.meta.url)) {
  try { startServer(); } catch (e: any) { console.error(`retrace-serve: ${e?.message ?? e}`); process.exit(1); }
}
