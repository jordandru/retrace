#!/usr/bin/env node
/**
 * retrace-gdrive — Google Drive adapter helpers (the Apps Script forwarder is the zero-infra path; this is for backfills & testing).
 *   retrace-gdrive backfill --token <OAuth access token> [--project p] [--folder <id>] [--since 2026-08-01] [--max 1000]
 *        queries the Drive Activity API directly (scope drive.activity.readonly; e.g. `gcloud auth print-access-token`
 *        or OAuth Playground) and logs the mapped events. Actor emails resolve via People API when the token allows.
 *   retrace-gdrive replay <payload.json> [--project p]      map a saved forwarder payload / activity.query response and log it
 * Store config: RETRACE_DB (local) or RETRACE_URL(+RETRACE_TOKEN).
 */
import { readFileSync } from "node:fs";
import { mapDriveActivities, appendEvent, describeEvent, DrivePayload } from "@retrace/core";
import { makeStore } from "./index.js";
import { RemoteStore } from "./remote-store.js";

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {}; const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const n = argv[i + 1]; if (n && !n.startsWith("--")) { flags[a.slice(2)] = n; i++; } else flags[a.slice(2)] = true; } else pos.push(a); }
  return { flags, pos };
}
async function logAll(payload: DrivePayload, project?: string) {
  const inputs = mapDriveActivities({ ...payload, project: project ?? payload.project }, "google-drive");
  const store = makeStore(); let n = 0, d = 0;
  for (const input of inputs) { const r = store instanceof RemoteStore ? await store.append(input) : await appendEvent(store, input); r.deduped ? d++ : (n++, console.log(describeEvent(r.event))); }
  return { logged: n, deduped: d, mapped: inputs.length };
}
async function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const cmd = pos[0]; const project = (flags.project as string) ?? process.env.RETRACE_PROJECT;
  if (cmd === "replay") {
    const raw = JSON.parse(readFileSync(pos[1], "utf8"));
    const payload: DrivePayload = Array.isArray(raw.activities) ? raw : { activities: raw };
    const r = await logAll(payload, project); console.log(`replay: ${r.mapped} mapped, ${r.logged} logged, ${r.deduped} deduped`); return;
  }
  if (cmd === "backfill") {
    const token = (flags.token as string) ?? process.env.GOOGLE_ACCESS_TOKEN; if (!token) throw new Error("--token <OAuth access token> required (scope drive.activity.readonly)");
    const since = flags.since ? new Date(String(flags.since)).toISOString() : new Date(Date.now() - 7 * 86400000).toISOString();
    const max = Number(flags.max ?? 1000); const acts: any[] = []; let pageToken: string | undefined;
    do {
      const body: any = { filter: `time >= "${since}"`, pageSize: 100, ...(pageToken ? { pageToken } : {}), ...(flags.folder ? { ancestorName: `items/${flags.folder}` } : {}) };
      const res = await fetch("https://driveactivity.googleapis.com/v2/activity:query", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`Drive Activity ${res.status}: ${await res.text()}`);
      const j: any = await res.json(); acts.push(...(j.activities ?? [])); pageToken = j.nextPageToken;
    } while (pageToken && acts.length < max);
    const actors: Record<string, { email?: string; name?: string }> = {};
    const names = new Set<string>(); for (const a of acts) for (const x of a.actors ?? []) { const pn = (x.user ?? x.impersonation?.impersonatedUser)?.knownUser?.personName; if (pn) names.add(pn); }
    for (const pn of names) {
      try { const res = await fetch(`https://people.googleapis.com/v1/${pn}?personFields=emailAddresses,names`, { headers: { authorization: `Bearer ${token}` } }); if (res.ok) { const p: any = await res.json(); actors[pn] = { email: p.emailAddresses?.[0]?.value, name: p.names?.[0]?.displayName }; } } catch {}
    }
    const r = await logAll({ activities: acts, actors, source: "cli" }, project); console.log(`backfill: ${acts.length} activities, ${r.mapped} mapped, ${r.logged} logged, ${r.deduped} deduped`); return;
  }
  console.log("retrace-gdrive <backfill --token T [--folder id] [--since date] | replay <payload.json>> [--project name]");
}
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) main().catch((e) => { console.error("retrace-gdrive:", e.message ?? e); process.exit(1); });
