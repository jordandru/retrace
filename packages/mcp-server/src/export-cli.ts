#!/usr/bin/env node
import { recomputeOwnerLogin } from "./owner-login-replay.js";
/**
 * retrace-export — signing keys, signed exports, offline verification.
 *   retrace-export keygen [--print-private]           create ~/.retrace/signing-key.json if missing; print kid + public JWK
 *   retrace-export producer-keygen [--out path] [--actor id]   mint a producer Ed25519 key (NOT the export issuer);
 *       default ~/.retrace/producer-keys/<actor>.jwk (0600). Prints public JWK + kid only.
 *   retrace-export export <project> [--artifact <id>] [--out file.json] [--report file.html]
 *   retrace-export verify <bundle.json> [--pubkey <jwk.json|https-url>] [--producers <keys.json>] [--checkpoint <checkpoints.jsonl> --checkpoint-pubkey <jwk.json|https-url>] [--allow-self-attested]
 *       Trusted key: --pubkey, else RETRACE_PUBKEY (JWK/file/https url), else RETRACE_URL/.well-known/retrace-pubkey (https only).
 *       Without one the bundle is only self-attested and verify exits 2 unless --allow-self-attested.
 *       Checkpoints require their own trusted key from --checkpoint-pubkey or RETRACE_CHECKPOINT_PUBKEY; the production
 *       checkpoint signer is intentionally separate from the export issuer. A committed
 *       .retrace/checkpoint-public.jwk is the final repository-local fallback.
 *   retrace-export checkpoint <project> [--bundle file.json] [--fresh] [--max-bundle-age-hours 3] [--out .retrace/checkpoints.jsonl]
 *       append a signed head checkpoint; server-fetched bundles older than the age limit are refused
 *   retrace-export witness <project> [--checkpoints f.jsonl] [--witnesses f.jsonl] [--rekor url]   submit the newest checkpoint to the Rekor transparency log; commit both files
 *       verify --checkpoint also takes [--witnesses f.jsonl] [--rekor-pubkey pem] to require the checkpointed head be witnessed by Rekor (offline SET check).
 *   retrace-export reconcile [--repo .] [--since <ref>] [--limit N] [--uncovered warn|fail|info] [--json] [--gate]   git history vs the ledger: capture windows, mis-attributed and missing commits (docs/reconciliation-plan.md)
 *   retrace-export share <project> [--artifact <id>] [--label ..] [--days n]      (local server must be running for the link to resolve)
 * Uses the same store config as the MCP server (RETRACE_DB / RETRACE_URL+RETRACE_TOKEN).
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProducerKey, keyId, buildExportBundle, verifyExportBundle, exportVerdictOk, policyFindingsFailExport, parseExportBundle, renderReportHtml, parseSigningKey, ExportBundle, newShareId, checkpointFromBundle, verifyCheckpoint, compareBundleToCheckpoint, parseCheckpointLog, latestCheckpoint } from "@retrace-dev/core";
import { makeStore } from "./index.js";
import { RemoteStore } from "./remote-store.js";
import { ensureSigningKey, loadSigningKey } from "./keys.js";
import { defaultProducerKeyPath, ensureProducerKey } from "./producer-key.js";
import { witnessCheckpoint, verifyWitness, parseWitnessLog, witnessFor, fetchRekorPublicKey, DEFAULT_REKOR_URL, WitnessRecord } from "./witness.js";
import { isMainModule } from "./is-main.js";
import { amendAttributionMain, attributionOptionsForRepo } from "./attribution.js";
import { collectAttributionAmendments, attributionSummary, renderTimeline } from "@retrace-dev/core";
import { reconcileMain } from "./reconcile.js";
import { loadPublicKey, resolveTrustedKey } from "./trusted-key.js";

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
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const key = a.slice(2); const n = argv[i + 1]; if (n && !n.startsWith("--")) { flags[key] = key === "restricted-hook-stamp" && typeof flags[key] === "string" ? `${flags[key]}\n${n}` : n; i++; } else flags[key] = true; } else pos.push(a); }
  return { flags, pos };
}

function bundleVerifyOpts(flags: Record<string, string | boolean>, bundle: ExportBundle, producers?: ProducerKey[]) {
  // Stamps come from bundle.policies (verifyExportBundle). `.retrace.json` is bootstrap-only.
  return {
    project: bundle.scope.project,
    ...(producers ? { producers } : {}),
  };
}

async function collectAttributionForRepo(flags: Record<string, string | boolean>, bundle: ExportBundle) {
  const attribution = collectAttributionAmendments(bundle.events);
  const repo = String(flags.repo ?? process.cwd());
  if (flags.policy === undefined && !existsSync(join(repo, ".retrace.json"))) {
    attribution.unavailable = `no_repository_context: no .retrace.json in ${repo}; run inside the recorded repository or pass --repo <path>`;
    return attribution;
  }
  try {
    return collectAttributionAmendments(bundle.events, await attributionOptionsForRepo(repo, bundle.events, bundle.scope.project, [], typeof flags.policy === "string" ? flags.policy : undefined));
  } catch (error) {
    attribution.unavailable = error instanceof Error ? error.message : String(error);
    return attribution;
  }
}

type CheckpointStore = ReturnType<typeof makeStore>;

export async function checkpointCommand(
  project: string,
  flags: Record<string, string | boolean>,
  options: { store?: CheckpointStore; now?: Date; log?: (message: string) => void } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const log = options.log ?? console.log;
  let bundle: ExportBundle;
  if (flags.bundle) {
    bundle = parseExportBundle(readFileSync(String(flags.bundle), "utf8"));
    const generatedAt = Date.parse(bundle.generated_at);
    // Issue #160: an unparseable generated_at is an unknown age, and an unknown age is refused, never logged as NaN.
    if (!Number.isFinite(generatedAt))
      throw new Error(`bundle ${flags.bundle} generated_at ${JSON.stringify(bundle.generated_at)} is not a parseable datetime; a bundle of unknown age is refused`);
    const ageHours = Math.max(0, (now.getTime() - generatedAt) / 3_600_000);
    log(`bundle ${flags.bundle} generated_at ${bundle.generated_at}; age ${ageHours.toFixed(2)} hours (--bundle is an explicit operator choice, age limit exempt)`);
  } else {
    const store = options.store ?? makeStore();
    if (store instanceof RemoteStore) {
      bundle = await store.export({ project }, { fresh: flags.fresh === true });
      const rawLimit = flags["max-bundle-age-hours"] ?? "3";
      const maxAgeHours = typeof rawLimit === "string" ? Number(rawLimit) : NaN;
      if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0)
        throw new Error("--max-bundle-age-hours must be a positive number");
      const generatedAt = Date.parse(bundle.generated_at);
      // Issue #160: `NaN > maxAgeHours` is false, so without this check an unparseable generated_at skipped the
      // stale-bundle refusal and the checkpoint proceeded on a bundle of unknown age. Refuse it instead.
      if (!Number.isFinite(generatedAt))
        throw new Error(`server bundle generated_at ${JSON.stringify(bundle.generated_at)} is not a parseable datetime; a bundle of unknown age is refused (--max-bundle-age-hours ${maxAgeHours} cannot be checked)`);
      const ageHours = Math.max(0, (now.getTime() - generatedAt) / 3_600_000);
      if (ageHours > maxAgeHours) {
        const liveHead = await store.head(project);
        throw new Error(
          `refusing server bundle generated_at ${bundle.generated_at}: age ${ageHours.toFixed(2)} hours exceeds ` +
          `--max-bundle-age-hours ${maxAgeHours}; live head ${liveHead ? `#${liveHead.seq} ${liveHead.hash}` : "is absent"}; ` +
          `inspect /projects/${encodeURIComponent(project)}/status export_cache`,
        );
      }
    } else {
      bundle = await buildExportBundle(store, { project }, {
        signingKey: parseSigningKey(process.env.RETRACE_SIGNING_KEY) ?? (await ensureSigningKey()).privateKey,
        issuerName: process.env.RETRACE_ISSUER,
      });
    }
  }
  // A checkpoint attests a head; it must never be derived from a bundle whose issuer could not be established.
  const trusted = await resolveTrustedKey(flags.pubkey);
  if (!trusted) throw new Error("no trusted issuer key: pass --pubkey <jwk.json|https-url>, set RETRACE_PUBKEY, or set RETRACE_URL to an https Retrace server (its /.well-known/retrace-pubkey is used)");
  const v = await verifyExportBundle(bundle, trusted.key, bundleVerifyOpts(flags, bundle));
  if (!exportVerdictOk(v)) {
    for (const problem of v.problems) console.error("  - " + problem);
    throw new Error("refusing to checkpoint a bundle that does not verify as a complete full export signed by the trusted key");
  }
  if (v.legacy_hash_events) console.error(`  note: ${v.legacy_hash_events} event(s) are under the legacy hash rule (received_at not provably covered)`);
  const key = parseSigningKey(process.env.RETRACE_SIGNING_KEY) ?? (await ensureSigningKey()).privateKey;
  const cp = await checkpointFromBundle(bundle, { signingKey: key, signerName: process.env.RETRACE_ISSUER });
  const out = String(flags.out ?? ".retrace/checkpoints.jsonl");
  if (existsSync(out)) {
    const prev = latestCheckpoint(parseCheckpointLog(readFileSync(out, "utf8")), project);
    if (prev && prev.seq === cp.seq && prev.head_hash === cp.head_hash) {
      log(`unchanged — ${out} already has head #${cp.seq} ${cp.head_hash.slice(0, 12)}… for ${project}`);
      return;
    }
    if (prev && prev.seq > cp.seq) throw new Error(`${out} already records #${prev.seq} for ${project}; this bundle stops at #${cp.seq} — the ledger shrank, investigate before checkpointing`);
  } else mkdirSync(dirname(out), { recursive: true });
  appendFileSync(out, JSON.stringify(cp) + "\n");
  log(`appended head #${cp.seq} ${cp.head_hash.slice(0, 12)}… (${cp.total_events} events, issuer kid ${(cp.source as any).issuer_kid ?? "unsigned"}, signer kid ${cp.signer?.kid}) to ${out}\ncommit and push ${out} — that commit is the witness a later verify --checkpoint compares against`);
}

export async function requireValidWitnessForAppend(rec: WitnessRecord, cp: Parameters<typeof verifyWitness>[1], pem: string): Promise<void> {
  const verdict = await verifyWitness(rec, cp, pem);
  if (!verdict.ok) throw new Error(`refusing to append a witness that does not verify: ${verdict.problems.join("; ")}`);
}

export async function witnessCommand(
  project: string,
  flags: Record<string, string | boolean>,
  options: {
    witness?: typeof witnessCheckpoint;
    fetchPublicKey?: typeof fetchRekorPublicKey;
    rekorPublicKeyPem?: string;
    log?: (message: string) => void;
  } = {},
): Promise<void> {
  const log = options.log ?? console.log;
  const cpsPath = String(flags.checkpoints ?? ".retrace/checkpoints.jsonl");
  const wPath = String(flags.witnesses ?? ".retrace/witnesses.jsonl");
  const rekorUrl = String(flags.rekor ?? DEFAULT_REKOR_URL);
  const cp = latestCheckpoint(parseCheckpointLog(readFileSync(cpsPath, "utf8")), project);
  if (!cp) throw new Error(`no checkpoint for project ${project} in ${cpsPath} — run \`retrace-export checkpoint ${project}\` first`);
  const existing = existsSync(wPath) ? parseWitnessLog(readFileSync(wPath, "utf8")) : [];
  if (witnessFor(existing, cp)) {
    log(`unchanged — ${wPath} already witnesses checkpoint #${cp.seq} for ${project}`);
    return;
  }
  const key = parseSigningKey(process.env.RETRACE_SIGNING_KEY) ?? loadSigningKey();
  if (!key) throw new Error("no signing key: set RETRACE_SIGNING_KEY (the checkpoint key) — the Rekor entry must be signed by the checkpoint's signer");
  const rec = await (options.witness ?? witnessCheckpoint)(cp, key, { rekorUrl });
  const committedPemPath = ".retrace/rekor-public.pem";
  let pem = options.rekorPublicKeyPem;
  if (!pem) {
    try { pem = readFileSync(committedPemPath, "utf8"); }
    catch { pem = await (options.fetchPublicKey ?? fetchRekorPublicKey)(rekorUrl); }
  }
  await requireValidWitnessForAppend(rec, cp, pem);
  mkdirSync(dirname(wPath), { recursive: true });
  const pemPath = dirname(wPath) + "/rekor-public.pem";
  if (!existsSync(pemPath)) {
    writeFileSync(pemPath, pem);
    log(`wrote ${pemPath} — Rekor's public key, committed so SETs verify offline`);
  }
  appendFileSync(wPath, JSON.stringify(rec) + "\n");
  log(`witnessed checkpoint #${cp.seq} ${cp.head_hash.slice(0, 12)}… in the Rekor transparency log: index ${rec.log_index}, ${new Date(rec.integrated_time * 1000).toISOString()}\nappended to ${wPath} — commit and push it with ${cpsPath}; verify with: retrace-export verify <bundle> --checkpoint ${cpsPath} --witnesses ${wPath}`);
}

async function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  if (cmd === "owner-login") {
    if (!flags.recompute || typeof flags.bundle !== "string") throw new Error("usage: retrace-export owner-login --recompute --bundle <export.json> [--policy <digest>] [--limit-seq <n>]");
    const started = Date.now();
    const progress = (message: string) => console.error(`owner-login: ${message} (${Date.now() - started} ms)`);
    const limitFlag = flags["limit-seq"];
    if (limitFlag !== undefined && (typeof limitFlag !== "string" || !/^\d+$/.test(limitFlag) || !Number.isSafeInteger(Number(limitFlag))))
      throw new Error("--limit-seq must be a non-negative safe integer");
    const bundle = parseExportBundle(readFileSync(flags.bundle, "utf8"));
    progress(`bundle parsed: ${bundle.events.length} events`);
    const replay = await recomputeOwnerLogin(bundle, typeof flags.policy === "string" ? flags.policy : undefined,
      { limitSeq: limitFlag === undefined ? undefined : Number(limitFlag), progress });
    console.log("owner-login consistency replay (does not establish issuer identity)");
    for (const row of replay.results) console.log(`${row.id}: ${row.result}${row.replay_unavailable ? `; replay produced unavailable (${row.replay_unavailable}); this reason came from the replay's own evidence reads, not a preserved sealed outcome` : ""}; event received_at ${row.received_at}; preserved observed fields: ${row.preserved.join(", ") || "none"}`);
    console.log(`consumption rebuilt: ${replay.consumption.length} rows`);
    process.exitCode = replay.ok ? 0 : 1; return;
  }
  if (cmd === "amend-attribution") { process.exitCode = await amendAttributionMain(flags); return; }
  if (cmd === "render") {
    if (!pos[1]) throw new Error("usage: retrace-export render <bundle.json> [--effective] [--repo . --policy policy.json]");
    const bundle = parseExportBundle(readFileSync(pos[1],"utf8"));
    const trusted=await resolveTrustedKey(flags.pubkey);
    const verdict=await verifyExportBundle(bundle,trusted?.key, bundleVerifyOpts(flags, bundle));
    let attribution=collectAttributionAmendments(bundle.events);
    if (exportVerdictOk(verdict) && !bundle.scope.artifact_id) {
      attribution=await collectAttributionForRepo(flags,bundle);
    }
    if(!exportVerdictOk(verdict))attribution.unavailable="untrusted_export: signature or complete-chain verification failed";
    if(verdict.coverage.scope!=="full")attribution.unavailable="incomplete_snapshot: scoped export";
    const header=flags.effective && !attribution.unavailable ? `effective view — recorded actors in parentheses; ${[...attribution.effective.values()].flat().length} amendments applied` : attributionSummary(bundle.events,attribution);
    console.error(header); console.log(renderTimeline(bundle.events,{attribution,effective:flags.effective===true,banner:true})); return;
  }
  if (cmd === "keygen") {
    const k = await ensureSigningKey();
    console.log(`${k.created ? "created" : "existing"} signing key at ${k.path}\nkid: ${k.kid}\npublic JWK: ${JSON.stringify(k.publicKey)}`);
    if (flags["print-private"]) console.log(`\nRETRACE_SIGNING_KEY='${JSON.stringify(k.privateKey)}'`);
    else console.log(`\nFor the Cloudflare Worker: wrangler secret put RETRACE_SIGNING_KEY   (paste the private JWK; print it with --print-private)`);
    return;
  }
  if (cmd === "producer-keygen") {
    const out = (flags.out as string) ?? defaultProducerKeyPath(String(flags.actor ?? "producer"));
    const k = await ensureProducerKey(out);
    console.log(`${k.created ? "created" : "existing"} producer key at ${k.path}\nkid: ${k.kid}\npublic JWK: ${JSON.stringify(k.publicKey)}`);
    console.log("\nPaste the public JWK into the credential's public_key. Keep the private file off the Worker (RETRACE_PRODUCER_KEY_FILE / RETRACE_HOOK_KEY_FILE).");
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
    if (flags.report) { writeFileSync(flags.report as string, renderReportHtml(bundle, await verifyExportBundle(bundle, undefined, bundleVerifyOpts(flags, bundle)))); console.log(`wrote ${flags.report}`); }
    return;
  }
  if (cmd === "verify") {
    const file = pos[1]; if (!file) throw new Error("usage: retrace-export verify <bundle.json> [--pubkey jwk.json|url]");
    const bundle = parseExportBundle(readFileSync(file, "utf8"));
    const trusted = await resolveTrustedKey(flags.pubkey);
    // --producers: a TRUSTED producer-key list that replaces the bundle's own (which is self-attested, like the
    // issuer key). Each entry's kid is recomputed from its public_key; a mismatch is a corrupt or tampered file.
    let producers: ProducerKey[] | undefined;
    if (flags.producers) {
      const raw = JSON.parse(readFileSync(String(flags.producers), "utf8")) as ProducerKey[];
      producers = await Promise.all(raw.map(async (e) => {
        const kid = await keyId(e.public_key);
        if (e.kid && e.kid !== kid) throw new Error(`--producers: entry for actor ${e.actor_id ?? "?"} declares kid ${e.kid} but its public_key derives ${kid}`);
        return { ...e, kid };
      }));
    }
    const v = await verifyExportBundle(bundle, trusted?.key, bundleVerifyOpts(flags, bundle, producers));
    let ok = exportVerdictOk(v);
    // Self-attested = the bundle verified against the key it carries. Anyone can produce that. Fail closed unless asked.
    // Policy selection failures still never pass VALID.
    if (v.signature === "self_attested" && flags["allow-self-attested"] && v.events_intact && v.links_consistent && v.chain_ok_at_export && v.coverage.complete !== false && !policyFindingsFailExport(v.policy_findings)) ok = true;
    console.log(`${ok ? "VALID" : "NOT VALID"} — signature: ${v.signature}${v.kid ? " (kid " + v.kid + (trusted ? ", trusted key from " + trusted.from : ", key embedded in bundle — NOT a trusted key") + ")" : ""}; events intact: ${v.events_intact}; links: ${v.links_consistent}; chain ok at export: ${v.chain_ok_at_export}; coverage: ${v.coverage.scope === "full" ? (v.coverage.complete ? "complete" : "INCOMPLETE") : "scoped (omission not checkable offline)"} — ${v.coverage.events} of ${v.coverage.total_events} events${v.legacy_hash_events ? `; ${v.legacy_hash_events} legacy-hash event${v.legacy_hash_events === 1 ? "" : "s"} (received_at not provably covered)` : ""}${v.producer_signed || v.producer_invalid || v.producer_unsigned_agent_events ? `; producer sigs: ${v.producer_signed} verified · ${v.producer_invalid} INVALID · ${v.producer_unsigned_agent_events} unsigned agent event${v.producer_unsigned_agent_events === 1 ? "" : "s"}` : ""}`);
    console.log("  coverage: " + v.coverage.note);
    let attribution=collectAttributionAmendments(bundle.events);
    if(exportVerdictOk(v) && !bundle.scope.artifact_id) {
      attribution=await collectAttributionForRepo(flags,bundle);
    }
    if(!exportVerdictOk(v))attribution.unavailable="untrusted_export: signature or complete-chain verification failed";
    if(v.coverage.scope!=="full")attribution.unavailable="incomplete_snapshot: scoped export";
    console.log(attributionSummary(bundle.events,attribution));
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
        // --witnesses: the checkpointed head must also be witnessed by the Rekor transparency log (offline SET check).
        // Passing the flag states the expectation, so a missing or failing witness is NOT VALID.
        if (flags.witnesses) {
          const witnesses = parseWitnessLog(readFileSync(String(flags.witnesses), "utf8"));
          const w = witnessFor(witnesses, cp);
          if (!w) { ok = false; console.log(`  witness: NONE for checkpoint #${cp.seq} in ${flags.witnesses}`); }
          else {
            const pemSrc = flags["rekor-pubkey"] ? String(flags["rekor-pubkey"]) : ".retrace/rekor-public.pem";
            let pem: string;
            try { pem = readFileSync(pemSrc, "utf8"); }
            catch { pem = await fetchRekorPublicKey(w.rekor_url); console.log(`  (Rekor public key fetched from ${w.rekor_url} — commit it as .retrace/rekor-public.pem for offline verification)`); }
            const wv = await verifyWitness(w, cp, pem);
            if (!wv.ok) ok = false;
            console.log(`  witness: ${wv.ok ? wv.note : "NOT VALID"} (${w.rekor_url}, uuid ${w.uuid.slice(0, 16)}…)`);
            for (const p of wv.problems) console.log("  - " + p);
          }
        }
      }
    }
    process.exit(ok ? 0 : 2);
  }
  if (cmd === "checkpoint") {
    const project = pos[1]; if (!project) throw new Error("usage: retrace-export checkpoint <project> [--bundle file.json] [--fresh] [--max-bundle-age-hours 3] [--out .retrace/checkpoints.jsonl]");
    await checkpointCommand(project, flags);
    return;
  }
  if (cmd === "witness") {
    const project = pos[1]; if (!project) throw new Error("usage: retrace-export witness <project> [--checkpoints .retrace/checkpoints.jsonl] [--witnesses .retrace/witnesses.jsonl] [--rekor url]");
    await witnessCommand(project, flags);
    return;
  }
  if (cmd === "reconcile") { process.exitCode = await reconcileMain(flags, pos); return; } // exitCode, not exit(): let a large --json flush
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
  console.log("retrace-export <amend-attribution|render <bundle.json>|keygen|producer-keygen|export <project>|verify <bundle.json>|checkpoint <project>|witness <project>|reconcile|share <project>> [--artifact id] [--out f] [--report f.html] [--pubkey jwk|https-url] [--allow-self-attested] [--checkpoint f.jsonl] [--checkpoint-pubkey jwk|https-url] [--bundle f.json] [--fresh] [--max-bundle-age-hours n] [--label s] [--days n] [--actor id]");
}
if (isMainModule(import.meta.url)) main().catch((e) => { console.error("retrace-export:", e.message ?? e); process.exit(1); });
