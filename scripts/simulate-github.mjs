// Simulates signed GitHub webhook deliveries against a running Retrace server (default http://localhost:7777).
// Usage: RETRACE_GITHUB_SECRET=... node scripts/simulate-github.mjs [baseUrl] [project]
import { createHmac } from "node:crypto";
const base = process.argv[2] ?? "http://localhost:7777", project = process.argv[3] ?? "boxing-rpg", secret = process.env.RETRACE_GITHUB_SECRET ?? "hooksecret";
const repo = { full_name: "slcwitit/rpg" }, jordan = { login: "jordan", type: "User" }, mike = { login: "coach-mike", type: "User" };
const pr = { number: 57, title: "Jab counter + triple flash", body: "Adds jab counter to the HUD, flashes red on a triple.\n\nRetrace-Caused-By: PLACEHOLDER", html_url: "https://github.com/slcwitit/rpg/pull/57", head: { ref: "feat/jab-counter", sha: "6557ce5aa11bb22cc33dd44ee55ff6677889900" }, base: { ref: "main" }, additions: 61, deletions: 4, changed_files: 3, user: jordan };
async function send(event, payload, id) {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const res = await fetch(`${base}/hooks/github?project=${encodeURIComponent(project)}`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": id, "x-hub-signature-256": sig }, body });
  console.log(event, res.status, (await res.text()).slice(0, 160));
}
// find the last human instruction in the project to link the PR to
const evs = await (await fetch(`${base}/projects/${project}/events?actor_type=human&action=instructed`)).json();
const root = evs.at(-1)?.id; if (root) pr.body = pr.body.replace("PLACEHOLDER", root);
const t = (m) => new Date(Date.parse("2026-08-16T14:24:00Z") + m * 60000).toISOString();
await send("ping", { zen: "Keep it logically awesome.", repository: repo }, "d-ping");
await send("pull_request", { action: "opened", repository: repo, sender: jordan, pull_request: { ...pr, updated_at: t(0) } }, "d-1");
await send("workflow_run", { action: "completed", repository: repo, workflow_run: { id: 9001, name: "CI", run_number: 12, run_attempt: 1, conclusion: "success", head_sha: pr.head.sha, head_branch: pr.head.ref, event: "pull_request", html_url: "https://github.com/slcwitit/rpg/actions/runs/9001", run_started_at: t(0.2), updated_at: t(1.5), pull_requests: [{ number: 57 }] } }, "d-2");
await send("pull_request_review", { action: "submitted", repository: repo, sender: mike, pull_request: pr, review: { id: 501, state: "approved", body: "Played 3 rounds on the test build — the triple flash reads great from the corner. LGTM.", user: mike, submitted_at: t(4), commit_id: pr.head.sha, html_url: "https://github.com/slcwitit/rpg/pull/57#pullrequestreview-501" } }, "d-3");
await send("issue_comment", { action: "created", repository: repo, sender: jordan, issue: { number: 57, title: pr.title, pull_request: {} }, comment: { id: 77, body: "Thanks coach — merging.", user: jordan, created_at: t(5), html_url: "https://github.com/slcwitit/rpg/pull/57#issuecomment-77" } }, "d-4");
await send("pull_request", { action: "closed", repository: repo, sender: jordan, pull_request: { ...pr, merged: true, merged_at: t(6), merged_by: jordan, merge_commit_sha: "abc123def4567890aaaa", updated_at: t(6) } }, "d-5");
await send("pull_request", { action: "closed", repository: repo, sender: jordan, pull_request: { ...pr, merged: true, merged_at: t(6), merged_by: jordan, merge_commit_sha: "abc123def4567890aaaa", updated_at: t(6) } }, "d-5"); // redelivery → deduped
// bad signature
const res = await fetch(`${base}/hooks/github?project=${project}`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": "sha256=00" }, body: "{}" });
console.log("bad signature →", res.status);
