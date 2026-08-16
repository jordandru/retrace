#!/usr/bin/env node
/**
 * retrace-github — GitHub PR adapter helpers.
 *   retrace-github setup <owner/repo> --url https://retrace-api.you.workers.dev [--project name]
 *        prints the exact webhook settings to paste into GitHub (or a `gh api` one-liner)
 *   retrace-github backfill <owner/repo> [--project name] [--state all|open|closed] [--max 100] [--token $GITHUB_TOKEN]
 *        pulls PRs + reviews via the REST API and logs them (idempotent) into the configured store
 *   retrace-github replay <payload.json> --event pull_request [--project name]
 *        maps a saved webhook payload and logs it (handy for testing without a public URL)
 * Store config as everywhere: RETRACE_DB (local) or RETRACE_URL(+RETRACE_TOKEN).
 */
import { readFileSync } from "node:fs";
import { mapGithubPullRest, mapGithubWebhook, appendEvent, describeEvent, EventInput } from "@retrace/core";
import { makeStore } from "./index.js";
import { RemoteStore } from "./remote-store.js";

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {}; const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const n = argv[i + 1]; if (n && !n.startsWith("--")) { flags[a.slice(2)] = n; i++; } else flags[a.slice(2)] = true; } else pos.push(a); }
  return { flags, pos };
}

async function gh(path: string, token?: string) {
  const res = await fetch(`https://api.github.com${path}`, { headers: { accept: "application/vnd.github+json", "user-agent": "retrace-github", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!res.ok) throw new Error(`GitHub ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function logAll(inputs: EventInput[]) {
  const store = makeStore(); let n = 0, d = 0;
  for (const input of inputs) {
    const r = store instanceof RemoteStore ? await store.append(input) : await appendEvent(store, input);
    r.deduped ? d++ : n++;
    if (!r.deduped) console.log(describeEvent(r.event));
  }
  return { logged: n, deduped: d };
}

async function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  if (cmd === "setup") {
    const repo = pos[1]; const url = (flags.url as string) ?? process.env.RETRACE_URL ?? "https://<your-worker>.workers.dev";
    const project = (flags.project as string) ?? process.env.RETRACE_PROJECT ?? repo;
    const hook = `${url.replace(/\/$/, "")}/hooks/github?project=${encodeURIComponent(project)}`;
    console.log(`GitHub → repo ${repo} → Settings → Webhooks → Add webhook
  Payload URL:   ${hook}
  Content type:  application/json
  Secret:        <the value you set with: wrangler secret put RETRACE_GITHUB_SECRET>
  Events:        Pull requests, Pull request reviews, Issue comments, Workflow runs${flags.push ? ", Pushes" : ""}

or with the GitHub CLI:
  gh api repos/${repo}/hooks -f name=web -F active=true \\
    -f "config[url]=${hook}" -f "config[content_type]=json" -f "config[secret]=$RETRACE_GITHUB_SECRET" \\
    -f "events[]=pull_request" -f "events[]=pull_request_review" -f "events[]=issue_comment" -f "events[]=workflow_run"`);
    return;
  }
  if (cmd === "backfill") {
    const repo = pos[1]; if (!repo) throw new Error("usage: retrace-github backfill <owner/repo>");
    const token = (flags.token as string) ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const project = (flags.project as string) ?? process.env.RETRACE_PROJECT ?? repo;
    const state = (flags.state as string) ?? "all"; const max = Number(flags.max ?? 100);
    const inputs: EventInput[] = [];
    for (let page = 1; inputs.length < max * 3; page++) {
      const prs: any[] = await gh(`/repos/${repo}/pulls?state=${state}&sort=created&direction=asc&per_page=50&page=${page}`, token);
      if (!prs.length) break;
      for (const pr of prs.slice(0, max)) {
        const reviews: any[] = await gh(`/repos/${repo}/pulls/${pr.number}/reviews`, token).catch(() => []);
        inputs.push(...mapGithubPullRest(repo, pr, reviews, project));
      }
      if (prs.length < 50) break;
    }
    inputs.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    const r = await logAll(inputs);
    console.log(`backfill ${repo}: ${r.logged} logged, ${r.deduped} already present → project '${project}'`);
    return;
  }
  if (cmd === "replay") {
    const file = pos[1]; const ev = flags.event as string; if (!file || !ev) throw new Error("usage: retrace-github replay <payload.json> --event <x-github-event>");
    const inputs = mapGithubWebhook(ev, JSON.parse(readFileSync(file, "utf8")), { project: (flags.project as string) ?? process.env.RETRACE_PROJECT, includePush: !!flags.push });
    const r = await logAll(inputs);
    console.log(`replay: ${r.logged} logged, ${r.deduped} deduped`);
    return;
  }
  console.log("retrace-github <setup <owner/repo> --url U | backfill <owner/repo> [--token T] [--state all] [--max n] | replay <payload.json> --event E> [--project name]");
}
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) main().catch((e) => { console.error("retrace-github:", e.message ?? e); process.exit(1); });
