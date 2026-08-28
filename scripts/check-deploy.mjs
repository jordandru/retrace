#!/usr/bin/env node
/**
 * check-deploy — does a running Retrace deployment understand everything this build can send?
 *
 * `POST /events` re-parses every event with `EventInput.safeParse`, and zod STRIPS keys it does not know. So a
 * producer newer than the deployment loses those fields silently: the event is accepted, sealed and hashed without
 * them, and nothing anywhere reports a problem. That has bitten twice (location.session, bacabed; location.client /
 * ide / workspace / surface, 2026-08-28). This turns it into one command with an exit code.
 *
 *   node scripts/check-deploy.mjs [url]        # default: $RETRACE_URL
 *
 * Exit 0 = the deployment understands every field this build stamps. Exit 1 = it would silently drop the fields
 * listed. No token needed and nothing is written — GET /api is a public capability probe.
 */
import { schemaSurface } from "../packages/core/dist/schema.js";

const url = (process.argv[2] ?? process.env.RETRACE_URL ?? "").replace(/\/$/, "");
if (!url) {
  console.error("check-deploy: pass a deployment URL or set RETRACE_URL\n  node scripts/check-deploy.mjs https://retrace-api.example.workers.dev");
  process.exit(2);
}

let probe;
try {
  const res = await fetch(`${url}/api`);
  if (!res.ok) throw new Error(`GET ${url}/api → ${res.status} ${await res.text()}`);
  probe = await res.json();
} catch (e) {
  console.error(`check-deploy: could not reach ${url} — ${e.message ?? e}`);
  process.exit(2);
}

const local = schemaSurface();
if (!probe.schema) {
  console.error(`NOT CURRENT  ${url}\n  This deployment predates the schema probe entirely, so it cannot be compared —\n  it is at least as old as 2026-08-28 and will silently drop newer fields.\n  Fix: cd apps/worker && npx wrangler deploy`);
  process.exit(1);
}

const missing = Object.entries(local).flatMap(([group, keys]) =>
  keys.filter((k) => !(probe.schema[group] ?? []).includes(k)).map((k) => `${group}.${k}`));
// Not an error: a deployment ahead of this checkout is fine — it understands everything we send and more.
const ahead = Object.entries(probe.schema).flatMap(([group, keys]) =>
  keys.filter((k) => !(local[group] ?? []).includes(k)).map((k) => `${group}.${k}`));

if (missing.length) {
  console.error(`NOT CURRENT  ${url}`);
  console.error(`  Would be silently dropped from every event this build sends:`);
  for (const f of missing) console.error(`    - ${f}`);
  console.error(`  Fix: npm run build && (cd apps/worker && npx wrangler deploy)`);
  process.exit(1);
}
console.log(`CURRENT  ${url}`);
console.log(`  understands all ${Object.values(local).flat().length} fields/verbs this build sends` + (ahead.length ? `, and ${ahead.length} this checkout does not have yet (${ahead.join(", ")})` : ""));
