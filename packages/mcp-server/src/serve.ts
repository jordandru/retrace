#!/usr/bin/env node
/**
 * Local Retrace server: serves the timeline UI + REST API from the same SQLite file the MCP server writes to.
 *   retrace-serve            → http://localhost:7777
 * Env: RETRACE_DB, RETRACE_PORT (7777), RETRACE_TOKEN (optional bearer/query token),
 *      RETRACE_SIGNING_KEY (JWK; else ~/.retrace/signing-key.json, auto-created), RETRACE_ISSUER, RETRACE_PUBLIC_URL
 */
import { createServer, IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { createHandler, parseSigningKey } from "@retrace/core";
import { loadSigningKey } from "./keys.js";
import { makeStore } from "./index.js";

function toRequest(req: IncomingMessage): Request {
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, { method: req.method, headers, body: hasBody ? (Readable.toWeb(req) as any) : undefined, ...(hasBody ? { duplex: "half" } : {}) } as any);
}

export function startServer(port = Number(process.env.RETRACE_PORT ?? 7777)) {
  const handle = createHandler(makeStore(), {
    token: process.env.RETRACE_TOKEN,
    signingKey: parseSigningKey(process.env.RETRACE_SIGNING_KEY) ?? loadSigningKey(),
    issuerName: process.env.RETRACE_ISSUER,
    publicUrl: process.env.RETRACE_PUBLIC_URL,
  });
  const server = createServer(async (req, res) => {
    try {
      const out = await handle(toRequest(req));
      const hdrs: Record<string, string> = {};
      out.headers.forEach((v, k) => (hdrs[k] = v));
      res.writeHead(out.status, hdrs);
      res.end(Buffer.from(await out.arrayBuffer()));
    } catch (e: any) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  });
  server.listen(port, () => console.error(`Retrace UI + API → http://localhost:${port}`));
  return server;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) startServer();
