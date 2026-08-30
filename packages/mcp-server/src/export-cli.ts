#!/usr/bin/env node
/**
 * retrace-export — signing keys, signed exports, offline verification.
 *   retrace-export keygen [--print-private]           create ~/.retrace/signing-key.json if missing; print kid + public JWK
 *   retrace-export export <project> [--artifact <id>] [--out file.json] [--report file.html]
 *   retrace-export verify <bundle.json> [--pubkey <jwk.json|url>] [--checkpoint <checkpoints.jsonl>]
 *   retrace-export checkpoint <project> [--bundle file.json] [--out .retrace/checkpoints.jsonl]   append a signed head checkpoint; commit the file
 *   retrace-export share <project> [--artifact <id>] [--label ..] [--days n]      (local server must be running for the link to resolve)
 * Uses the same store config as the MCP server (RETRACE_DB / RETRACE_URL+RETRACE_TOKEN).
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildExportBundle, verifyExportBundle, exportVerdictOk, renderReportHtml, parseSigningKey, ExportBundle, newShareId, checkpointFromBundle, verifyCheckpoint, compareBundleToCheckpoint, parseCheckpointLog, latestCheckpoint } from "@retrace-dev/core";
import { makeStore } from "./index.js";
import { RemoteStore } from "./remote-store.js";
import { ensureSigningKey, loadSigningKey } from "./keys.js";
import { isMainModule } from "./is-main.js";

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
    let ok = exportVerdictOk(v);
    console.log(`${ok ? "VALID" : "NOT VALID"} — signature: ${v.signature}${v.kid ? " (kid " + v.kid + (trusted ? ", trusted key" : ", key embedded in bundle") + ")" : ""}; events intact: ${v.events_intact}; links: ${v.links_consistent}; chain ok at export: ${v.chain_ok_at_export}; coverage: ${v.coverage.scope === "full" ? (v.coverage.complete ? "complete" : "INCOMPLETE") : "scoped (omission not checkable offline)"} — ${v.coverage.events} of ${v.coverage.total_events} events`);
    console.log("  coverage: " + v.coverage.note);
    for (const p of v.problems) console.log("  - " + p);
    if (flags.checkpoint) {
      // Compare against the newest committed checkpoint: the checkpointed head must still be in a later bundle.
      const cps = parseCheckpointLog(readFileSync(String(flags.checkpoint), "utf8"));
      const cp = latestCheckpoint(cps, bundle.scope.project);
      if (!cp) console.log(`  checkpoint: none for project ${bundle.scope.project} in ${flags.checkpoint}`);
      else {
        const cv = await verifyCheckpoint(cp);
        const cmp = compareBundleToCheckpoint(bundle, cp);
        if (cmp.relation === "conflict" || cmp.relation === "other_project") ok = false;
        console.log(`  checkpoint #${cp.seq} (${cp.at}, signature ${cv.signature}${cv.kid ? ", kid " + cv.kid : ""}): ${cmp.relation.toUpperCase()} — ${cmp.note}`);
        for (const p of [...cv.problems, ...cmp.problems]) console.log("  - " + p);
      }
    }
    process.exit(ok ? 0 : 2);
  }
  if (cmd === "checkpoint") {
    const project = pos[1]; if (!project) throw new Error("usage: retrace-export checkpoint <project> [--bundle file.json] [--out .retrace/checkpoints.jsonl]");
    let bundle: ExportBundle;
    if (flags.bundle) bundle = JSON.parse(readFileSync(String(flags.bundle), "utf8"));
    else {
      const store = makeStore();
      if (store instanceof RemoteStore) bundle = await store.export({ project });
      else bundle = await buildExportBundle(store, { project }, { signingKey: parseSigningKey(process.env.RETRACE_SIGNING_KEY) ?? (await ensureSigningKey()).privateKey, issuerName: process.env.RETRACE_ISSUER });
    }
    const v = await verifyExportBundle(bundle);
    if (!exportVerdictOk(v)) { for (const p of v.problems) console.error("  - " + p); throw new Error("refusing to checkpoint a bundle that does not verify as a complete, signed full export"); }
    const key = parseSigningKey(process.env.RETRACE_SIGNING_KEY) ?? (await ensureSigningKey()).privateKey;
    const cp = await checkpointFromBundle(bundle, { signingKey: key, signerName: process.env.RETRACE_ISSUER });
    const out = String(flags.out ?? ".retrace/checkpoints.jsonl");
    if (existsSync(out)) {
      const prev = latestCheckpoint(parseCheckpointLog(readFileSync(out, "utf8")), project);
      if (prev && prev.seq === cp.seq && prev.head_hash === cp.head_hash) { console.log(`unchanged — ${out} already has head #${cp.seq} ${cp.head_hash.slice(0, 12)}… for ${project}`); return; }
      if (prev && prev.seq > cp.seq) throw new Error(`${out} already records #${prev.seq} for ${project}; this bundle stops at #${cp.seq} — the ledger shrank, investigate before checkpointing`);
    } else mkdirSync(dirname(out), { recursive: true });
    appendFileSync(out, JSON.stringify(cp) + "\n");
    console.log(`appended head #${cp.seq} ${cp.head_hash.slice(0, 12)}… (${cp.total_events} events, issuer kid ${(cp.source as any).issuer_kid ?? "unsigned"}, signer kid ${cp.signer?.kid}) to ${out}\ncommit and push ${out} — that commit is the witness a later verify --checkpoint compares against`);
    return;
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
  console.log("retrace-export <keygen|export <project>|verify <bundle.json>|checkpoint <project>|share <project>> [--artifact id] [--out f] [--report f.html] [--pubkey jwk|url] [--checkpoint f.jsonl] [--bundle f.json] [--label s] [--days n]");
}
if (isMainModule(import.meta.url)) main().catch((e) => { console.error("retrace-export:", e.message ?? e); process.exit(1); });
