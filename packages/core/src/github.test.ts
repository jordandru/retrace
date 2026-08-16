import { test } from "node:test";
import assert from "node:assert/strict";
import { mapGithubWebhook, mapGithubPullRest, verifyGithubSignature, githubActor, EventInput } from "./index.js";

const repo = { full_name: "slcwitit/rpg" };
const jordan = { login: "jordan", type: "User" };
const pr = { number: 57, title: "Jab counter", body: "Adds jab counter to HUD\n\nRetrace-Caused-By: evt_abc123", html_url: "https://github.com/slcwitit/rpg/pull/57", head: { ref: "feat/jab", sha: "deadbeefcafe1234567890" }, base: { ref: "main" }, additions: 61, deletions: 4, changed_files: 3, updated_at: "2026-08-16T14:20:00Z", user: jordan };

test("pull_request opened / synchronize / merged / closed", () => {
  const [o] = mapGithubWebhook("pull_request", { action: "opened", repository: repo, sender: jordan, pull_request: pr }, { deliveryId: "d1" });
  assert.equal(o.action, "created"); assert.equal(o.project, "slcwitit/rpg"); assert.equal(o.actor.type, "human"); assert.equal(o.actor.id, "github:jordan");
  assert.equal(o.artifacts[0].id, "pr:slcwitit/rpg#57"); assert.deepEqual(o.artifacts[0].derived_from, ["commit:slcwitit/rpg@deadbeefcafe"]);
  assert.equal(o.caused_by, "evt_abc123"); assert.equal(o.idempotency_key, "gh:d1");
  assert.equal(o.intent, "Adds jab counter to HUD"); // trailer stripped from WHY
  const [s] = mapGithubWebhook("pull_request", { action: "synchronize", before: "1111111aaaa", after: "2222222bbbb", repository: repo, sender: jordan, pull_request: pr }, { project: "boxing-rpg" });
  assert.equal(s.action, "edited"); assert.equal(s.project, "boxing-rpg"); assert.match(s.change!.summary!, /1111111 → 2222222/);
  const [m] = mapGithubWebhook("pull_request", { action: "closed", repository: repo, sender: jordan, pull_request: { ...pr, merged: true, merged_at: "2026-08-16T14:23:00Z", merged_by: { login: "coach-mike", type: "User" }, merge_commit_sha: "feedface0000111122223333" } });
  assert.equal(m.action, "merged"); assert.equal(m.actor.id, "github:coach-mike"); assert.equal(m.timestamp, "2026-08-16T14:23:00Z");
  assert.equal(m.artifacts.length, 2); assert.deepEqual(m.artifacts[1].derived_from, ["pr:slcwitit/rpg#57"]);
  const [c] = mapGithubWebhook("pull_request", { action: "closed", repository: repo, sender: jordan, pull_request: { ...pr, merged: false } });
  assert.equal(c.action, "other"); assert.equal(c.action_detail, "closed");
});

test("reviews, comments, workflow_run, bots, push opt-in", () => {
  const [a] = mapGithubWebhook("pull_request_review", { action: "submitted", repository: repo, sender: jordan, pull_request: pr, review: { id: 9, state: "APPROVED", body: "LGTM, played 3 rounds", user: { login: "coach-mike" }, submitted_at: "2026-08-16T14:22:00Z", commit_id: "deadbeef" } });
  assert.equal(a.action, "approved"); assert.equal(a.intent, "LGTM, played 3 rounds"); assert.equal(a.caused_by, "evt_abc123"); // inherits PR body's caused_by
  const [r] = mapGithubWebhook("pull_request_review", { action: "submitted", repository: repo, sender: jordan, pull_request: pr, review: { id: 10, state: "changes_requested", body: null, user: jordan, submitted_at: "2026-08-16T14:22:00Z" } });
  assert.equal(r.action, "rejected");
  const [cm] = mapGithubWebhook("issue_comment", { action: "created", repository: repo, sender: jordan, issue: { number: 57, title: "Jab counter", pull_request: {} }, comment: { id: 5, body: "ship it", user: jordan, created_at: "2026-08-16T14:21:00Z", html_url: "x" } });
  assert.equal(cm.action, "sent"); assert.equal(cm.artifacts[0].id, "pr:slcwitit/rpg#57");
  const [w] = mapGithubWebhook("workflow_run", { action: "completed", repository: repo, workflow_run: { id: 77, name: "CI", run_number: 12, run_attempt: 1, conclusion: "success", head_sha: "deadbeefcafe1234", head_branch: "feat/jab", event: "pull_request", html_url: "y", run_started_at: "2026-08-16T14:20:10Z", updated_at: "2026-08-16T14:21:40Z", pull_requests: [{ number: 57 }] } });
  assert.equal(w.action, "executed"); assert.equal(w.actor.type, "system"); assert.equal(w.duration_ms, 90000); assert.ok(w.artifacts.some((x) => x.id === "pr:slcwitit/rpg#57"));
  assert.equal(githubActor({ login: "dependabot[bot]", type: "Bot" }).type, "system");
  assert.equal(githubActor({ login: "copilot", type: "Bot" }).type, "agent");
  assert.deepEqual(mapGithubWebhook("push", { repository: repo, commits: [{ id: "abc" }] }), []);
  const p = mapGithubWebhook("push", { repository: repo, commits: [{ id: "abcdef1234567890", message: "m", timestamp: "2026-08-16T14:00:00Z", author: { email: "j@x", name: "J" }, added: ["a.ts"], modified: [], removed: [] }] }, { includePush: true });
  assert.equal(p.length, 1); assert.equal(p[0].idempotency_key, "git:abcdef1234567890"); // same key as git adapter → dedupes
  assert.deepEqual(mapGithubWebhook("ping", {}), []);
});

test("REST backfill mapping orders events and signature verifies", async () => {
  const evs = mapGithubPullRest("slcwitit/rpg", { ...pr, created_at: "2026-08-16T14:00:00Z", merged_at: "2026-08-16T14:30:00Z", state: "closed", merge_commit_sha: "feedface0000" }, [{ id: 1, state: "APPROVED", user: { login: "coach-mike" }, submitted_at: "2026-08-16T14:15:00Z", body: "ok" }]);
  assert.deepEqual(evs.map((e) => e.action), ["created", "approved", "merged"]);
  const body = JSON.stringify({ zen: "hi" });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("s3cret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = "sha256=" + [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(await verifyGithubSignature("s3cret", body, sig), true);
  assert.equal(await verifyGithubSignature("wrong", body, sig), false);
  assert.equal(await verifyGithubSignature("s3cret", body + " ", sig), false);
  assert.equal(await verifyGithubSignature("s3cret", body, null), false);
  // every mapped event validates against the schema
  for (const e of evs) EventInput.parse(e);
});
