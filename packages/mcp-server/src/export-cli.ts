#!/usr/bin/env node
/**
 * retrace-export — signing keys, signed exports, offline verification.
 *   retrace-export keygen [--print-private]           create ~/.retrace/signing-key.json if missing; print kid + public JWK
 *   retrace-export export <project> [--artifact <id>] [--out file.json] [--report file.html]
 *   retrace-export verify <bundle.json> [--pubkey <jwk.json|url>]
 *   retrace-export share <project> [--artifact <id>] [--label ..] [--days n]      (local server must be running for the link to resolve)
 * Uses the same store config as the MCP server (RETRACE_DB / RETRACE_URL+RETRACE_TOKEN).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildExportBundle, verifyExportBundle, renderReportHtml, parseSigningKey, ExportBundle, newShareId } from "@retrace/core";
import { makeStore } from "./index.js";
import { RemoteStore } from "./remote-store.js";
import { ensureSigningKey, loadSigningKey } from "./keys.js";

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {}; const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const n = argv[i + 1]; if (n && !n.startsWith("--")) { flags[a.slice(2)] = n; i++; } else flags[a.slice(2)] = true; } else pos.push(a); }
  return { flags, pos };
}

async function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  if (cmd === "keygen") {
    const k = await ensureSigningKey();
    console.log(`${k.created ? "created" : "existing"} signing key at ${k.path}\nkid: ${k.kid}\npublic JWK: ${JSON.stringify(k.publicKey)}`);
    if (flags["print-private"]) console.log(`\nRETRACE_SIGNING_KEY='${JSON.stringify(k.privateKey)}'`);
    else console.log(`\nFor the Cloudflare Worker: wrangler secret put RETRACE_SIGNING_KEY   (paste the private JWK; print it with --print-private)`);
    return;
  }
  if (cmd === "export") {
    const project = pos[1]; if (!project) throw new Error("usage: retrace-export export <project>");
    const store = makeStore();
    let bundle: ExportBundle;
    if (store instanceof RemoteStore) bundle = await store.export({ project, artifact_id: flags.artifact as string });
    else {
      const key = parseSigningKey(process.env.RETRACE_SIGNING_KEY) ?? (await ensureSigningKey()).privateKey;
      bundle = await buildExportBundle(store, { project, artifact_id: flags.artifact as string | undefined }, { signingKey: key, issuerName: process.env.RETRACE_ISSUER });
    }
    const out = (flags.out as string) ?? `retrace-${project}${flags.artifact ? "-" + String(flags.artifact).replace(/[^\w.-]+/g, "_") : ""}.json`;
    writeFileSync(out, JSON.stringify(bundle, null, 2));
    console.log(`wrote ${out} — ${bundle.events.length} events, chain ${bundle.chain.ok ? "intact" : "BROKEN"}, ${bundle.signature ? "signed kid " + bundle.issuer!.kid : "UNSIGNED"}`);
    if (flags.report) { writeFileSync(flags.report as string, renderReportHtml(bundle, await verifyExportBundle(bundle))); console.log(`wrote ${flags.report}`); }
    return;
  }
  if (cmd === "verify") {
    const file = pos[1]; if (!file) throw new Error("usage: retrace-export verify <bundle.json> [--pubkey jwk.json|url]");
    const bundle = JSON.parse(readFileSync(file, "utf8")) as ExportBundle;
    let trusted: JsonWebKey | undefined;
    if (flags.pubkey) {
      const src = String(flags.pubkey);
      const raw = /^https?:/.test(src) ? await (await fetch(src)).json() : JSON.parse(readFileSync(src, "utf8"));
      trusted = raw.public_key ?? raw;
    }
    const v = await verifyExportBundle(bundle, trusted);
    const ok = v.signature === "valid" && v.events_intact && v.links_consistent && v.chain_ok_at_export;
    console.log(`${ok ? "VALID" : "NOT VALID"} — signature: ${v.signature}${v.kid ? " (kid " + v.kid + (trusted ? ", trusted key" : ", key embedded in bundle") + ")" : ""}; events intact: ${v.events_intact}; links: ${v.links_consistent}; chain ok at export: ${v.chain_ok_at_export}; ${bundle.events.length} events`);
    for (const p of v.problems) console.log("  - " + p);
    process.exit(ok ? 0 : 2);
  }
  if (cmd === "share") {
    const project = pos[1]; if (!project) throw new Error("usage: retrace-export share <project>");
    const store = makeStore();
    const body = { project, artifact_id: flags.artifact as string | undefined, label: flags.label as string | undefined, expires_in_days: flags.days ? Number(flags.days) : undefined };
    if (store instanceof RemoteStore) { const r = await store.share(body); console.log(`${r.url}\nreport: ${r.url}/report`); return; }
    const id = newShareId(); const now = new Date();
    await store.createShare({ id, project, artifact_id: body.artifact_id, label: body.label, created_at: now.toISOString(), expires_at: body.expires_in_days ? new Date(now.getTime() + body.expires_in_days * 86400000).toISOString() : undefined });
    const base = process.env.RETRACE_PUBLIC_URL ?? `http://localhost:${process.env.RETRACE_PORT ?? 7777}`;
    console.log(`${base}/s/${id}\nreport: ${base}/s/${id}/report`);
    return;
  }
  console.log("retrace-export <keygen|export <project>|verify <bundle.json>|share <project>> [--artifact id] [--out f] [--report f.html] [--pubkey jwk|url] [--label s] [--days n]");
}
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) main().catch((e) => { console.error("retrace-export:", e.message ?? e); process.exit(1); });
