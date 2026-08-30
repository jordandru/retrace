#!/usr/bin/env node
/**
 * retrace-export — signing keys, signed exports, offline verification.
 *   retrace-export keygen [--print-private]           create ~/.retrace/signing-key.json if missing; print kid + public JWK
 *   retrace-export export <project> [--artifact <id>] [--out file.json] [--report file.html]
 *   retrace-export verify <bundle.json> [--pubkey <jwk.json|https-url>] [--checkpoint <checkpoints.jsonl> --checkpoint-pubkey <jwk.json|https-url>] [--allow-self-attested]
 *       Trusted key: --pubkey, else RETRACE_PUBKEY (JWK/file/https url), else RETRACE_URL/.well-known/retrace-pubkey (https only).
 *       Without one the bundle is only self-attested and verify exits 2 unless --allow-self-attested.
 *       Checkpoints require their own trusted key from --checkpoint-pubkey or RETRACE_CHECKPOINT_PUBKEY; the production
 *       checkpoint signer is intentionally separate from the export issuer. A committed
 *       .retrace/checkpoint-public.jwk is the final repository-local fallback.
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

/** Load a public JWK from a file path, an https URL, or an inline JSON string. Plain http is refused: a key fetched over
 *  an interceptable channel is not a trusted key. Accepts a bare JWK or a /.well-known/retrace-pubkey document. */
async function loadPublicKey(src: string, label: string): Promise<JsonWebKey> {
  let raw: any;
  if (/^https:/i.test(src)) raw = await (await fetch(src)).json();
  else if (/^http:/i.test(src)) throw new Error(`${label}: refusing to fetch a trusted key over plain http (${src}) — use https or a local file`);
  else if (src.trim().startsWith("{")) raw = JSON.parse(src);
  else raw = JSON.parse(readFileSync(src, "utf8"));
  const jwk = raw?.public_key ?? raw;
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") throw new Error(`${label}: not an Ed25519 public JWK`);
  if ("d" in jwk) throw new Error(`${label}: that is a PRIVATE key — pass the public JWK`);
  return jwk;
}

/** Resolve the trusted issuer key for verification: explicit flag, RETRACE_PUBKEY, or the issuer's well-known URL. */
async function resolveTrustedKey(flag: unknown): Promise<{ key: JsonWebKey; from: string } | undefined> {
  if (flag) return { key: await loadPublicKey(String(flag), "--pubkey"), from: `--pubkey ${flag}` };
  if (process.env.RETRACE_PUBKEY) return { key: await loadPublicKey(process.env.RETRACE_PUBKEY, "RETRACE_PUBKEY"), from: "RETRACE_PUBKEY" };
  const base = process.env.RETRACE_URL;
  if (base && /^https:/i.test(base)) {
    const url = base.replace(/\/+$/, "") + "/.well-known/retrace-pubkey";
    try { return { key: await loadPublicKey(url, url), from: url }; }
    catch (e: any) { console.error(`  (could not load the issuer key from ${url}: ${e?.message ?? e})`); }
  }
  return undefined;
}

/** Checkpoint witnesses use a separate signing key, so never silently reuse the export issuer key. */
async function resolveCheckpointTrustedKey(flag: unknown): Promise<{ key: JsonWebKey; from: string } | undefined> {
  if (flag) return { key: await loadPublicKey(String(flag), "--checkpoint-pubkey"), from: `--checkpoint-pubkey ${flag}` };
  if (process.env.RETRACE_CHECKPOINT_PUBKEY)
    return { key: await loadPublicKey(process.env.RETRACE_CHECKPOINT_PUBKEY, "RETRACE_CHECKPOINT_PUBKEY"), from: "RETRACE_CHECKPOINT_PUBKEY" };
  const repoKey = ".retrace/checkpoint-public.jwk";
  if (existsSync(repoKey)) return { key: await loadPublicKey(repoKey, repoKey), from: repoKey };
  return undefined;
}

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
    const trusted = await resolveTrustedKey(flags.pubkey);
    const v = await verifyExportBundle(bundle, trusted?.key);
    let ok = exportVerdictOk(v);
    // Self-attested = the bundle verified against the key it carries. Anyone can produce that. Fail closed unless asked.
    if (v.signature === "self_attested" && flags["allow-self-attested"] && v.events_intact && v.links_consistent && v.chain_ok_at_export && v.coverage.complete !== false) ok = true;
    console.log(`${ok ? "VALID" : "NOT VALID"} — signature: ${v.signature}${v.kid ? " (kid " + v.kid + (trusted ? ", trusted key from " + trusted.from : ", key embedded in bundle — NOT a trusted key") + ")" : ""}; events intact: ${v.events_intact}; links: ${v.links_consistent}; chain ok at export: ${v.chain_ok_at_export}; coverage: ${v.coverage.scope === "full" ? (v.coverage.complete ? "complete" : "INCOMPLETE") : "scoped (omission not checkable offline)"} — ${v.coverage.events} of ${v.coverage.total_events} events${v.legacy_hash_events ? `; ${v.legacy_hash_events} legacy-hash event${v.legacy_hash_events === 1 ? "" : "s"} (received_at not provably covered)` : ""}`);
    console.log("  coverage: " + v.coverage.note);
    if (v.signature === "self_attested" && !flags["allow-self-attested"]) console.log("  pass the issuer's public key (--pubkey, RETRACE_PUBKEY, or RETRACE_URL for its /.well-known/retrace-pubkey), or --allow-self-attested to accept an unattributed bundle");
    for (const p of v.problems) console.log("  - " + p);
    if (flags.checkpoint) {
      // Compare against the newest committed checkpoint: the checkpointed head must still be in a later bundle.
      const cps = parseCheckpointLog(readFileSync(String(flags.checkpoint), "utf8"));
      const cp = latestCheckpoint(cps, bundle.scope.project);
      if (!cp) {
        ok = false;
        console.log(`  checkpoint: NOT VERIFIED — none for project ${bundle.scope.project} in ${flags.checkpoint}`);
      }
      else {
        const checkpointTrusted = await resolveCheckpointTrustedKey(flags["checkpoint-pubkey"]);
        if (!checkpointTrusted) {
          ok = false;
          const cv = await verifyCheckpoint(cp);
          console.log(`  checkpoint #${cp.seq} (${cp.at}, signature ${cv.signature}${cv.kid ? ", kid " + cv.kid : ""}): NOT VERIFIED — no trusted checkpoint key`);
          console.log("  - pass --checkpoint-pubkey <jwk.json|https-url>, set RETRACE_CHECKPOINT_PUBKEY, or commit .retrace/checkpoint-public.jwk");
          for (const p of cv.problems) console.log("  - " + p);
        } else {
          const cv = await verifyCheckpoint(cp, checkpointTrusted.key);
          const cmp = compareBundleToCheckpoint(bundle, cp);
          const relationVerified = cmp.relation === "matches" || cmp.relation === "extends";
          if (cv.signature !== "valid" || !relationVerified) ok = false;
          console.log(`  checkpoint #${cp.seq} (${cp.at}, signature ${cv.signature}${cv.kid ? ", kid " + cv.kid : ""}, trusted key from ${checkpointTrusted.from}): ${cmp.relation.toUpperCase()} — ${cmp.note}`);
          for (const p of [...cv.problems, ...cmp.problems]) console.log("  - " + p);
          if (!relationVerified && !cmp.problems.length) console.log(`  - checkpoint relation ${cmp.relation} does not verify this bundle`);
        }
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
    // A checkpoint attests a head; it must never be derived from a bundle whose issuer could not be established.
    const trusted = await resolveTrustedKey(flags.pubkey);
    if (!trusted) throw new Error("no trusted issuer key: pass --pubkey <jwk.json|https-url>, set RETRACE_PUBKEY, or set RETRACE_URL to an https Retrace server (its /.well-known/retrace-pubkey is used)");
    const v = await verifyExportBundle(bundle, trusted.key);
    if (!exportVerdictOk(v)) { for (const p of v.problems) console.error("  - " + p); throw new Error("refusing to checkpoint a bundle that does not verify as a complete full export signed by the trusted key"); }
    if (v.legacy_hash_events) console.error(`  note: ${v.legacy_hash_events} event(s) are under the legacy hash rule (received_at not provably covered)`);
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
  console.log("retrace-export <keygen|export <project>|verify <bundle.json>|checkpoint <project>|share <project>> [--artifact id] [--out f] [--report f.html] [--pubkey jwk|https-url] [--allow-self-attested] [--checkpoint f.jsonl] [--checkpoint-pubkey jwk|https-url] [--bundle f.json] [--label s] [--days n]");
}
if (isMainModule(import.meta.url)) main().catch((e) => { console.error("retrace-export:", e.message ?? e); process.exit(1); });
