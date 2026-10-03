import { test } from "node:test";
import assert from "node:assert/strict";
import { mapGithubWebhook, mapGithubPullRest, verifyGithubSignature, githubActor, EventInput } from "./index.js";

const repo = { full_name: "slcwitit/rpg" };
const jordan = { login: "jordan", type: "User" };
const pr = { number: 57, title: "Jab counter", body: "Adds jab counter to HUD\n\nRetrace-Caused-By: evt_abc123", html_url: "https://github.com/slcwitit/rpg/pull/57", head: { ref: "feat/jab", sha: "deadbeefcafe1234567890" }, base: { ref: "main" }, additions: 61, deletions: 4, changed_files: 3, updated_at: "2026-08-16T14:20:00Z", user: jordan };

test("pull_request opened / synchronize / merged / closed", async () => {
  const [o] = await mapGithubWebhook("pull_request", { action: "opened", repository: repo, sender: jordan, pull_request: pr }, { deliveryId: "d1" });
  assert.equal(o.action, "created"); assert.equal(o.project, "slcwitit/rpg"); assert.equal(o.actor.type, "human"); assert.equal(o.actor.id, "github:jordan");
  assert.equal(o.artifacts[0].id, "pr:slcwitit/rpg#57"); assert.deepEqual(o.artifacts[0].derived_from, ["commit:slcwitit/rpg@deadbeefcafe"]);
  assert.equal(o.caused_by, "evt_abc123"); assert.equal(o.idempotency_key, "gh:d1");
  assert.equal(o.intent, "Adds jab counter to HUD"); // trailer stripped from WHY
  const [s] = await mapGithubWebhook("pull_request", { action: "synchronize", before: "1111111aaaa", after: "2222222bbbb", repository: repo, sender: jordan, pull_request: pr }, { project: "boxing-rpg" });
  assert.equal(s.action, "edited"); assert.equal(s.project, "boxing-rpg"); assert.match(s.change!.summary!, /1111111 → 2222222/);
  const [m] = await mapGithubWebhook("pull_request", { action: "closed", repository: repo, sender: jordan, pull_request: { ...pr, merged: true, merged_at: "2026-08-16T14:23:00Z", merged_by: { login: "coach-mike", type: "User" }, merge_commit_sha: "feedface0000111122223333" } });
  assert.equal(m.action, "merged"); assert.equal(m.actor.id, "github:coach-mike"); assert.equal(m.timestamp, "2026-08-16T14:23:00Z");
  assert.equal(m.artifacts.length, 2); assert.deepEqual(m.artifacts[1].derived_from, ["pr:slcwitit/rpg#57"]);
  const [c] = await mapGithubWebhook("pull_request", { action: "closed", repository: repo, sender: jordan, pull_request: { ...pr, merged: false } });
  assert.equal(c.action, "other"); assert.equal(c.action_detail, "closed");
  // PROV role: opened generates the PR, synchronize rewrites it, a merge uses the PR and generates the merge commit; a
  // state change (closed unmerged) says nothing
  assert.equal(o.artifacts[0].role, "generated"); assert.equal(s.artifacts[0].role, "both");
  assert.deepEqual(m.artifacts.map((a) => a.role), ["used", "generated"]);
  assert.ok(!("role" in c.artifacts[0]));
});

test("reviews, comments, workflow_run, bots, push opt-in", async () => {
  const [a] = await mapGithubWebhook("pull_request_review", { action: "submitted", repository: repo, sender: jordan, pull_request: pr, review: { id: 9, state: "APPROVED", body: "LGTM, played 3 rounds", user: { login: "coach-mike" }, submitted_at: "2026-08-16T14:22:00Z", commit_id: "deadbeef" } });
  assert.equal(a.action, "approved"); assert.equal(a.intent, "LGTM, played 3 rounds"); assert.equal(a.caused_by, "evt_abc123"); // inherits PR body's caused_by
  const [r] = await mapGithubWebhook("pull_request_review", { action: "submitted", repository: repo, sender: jordan, pull_request: pr, review: { id: 10, state: "changes_requested", body: null, user: jordan, submitted_at: "2026-08-16T14:22:00Z" } });
  assert.equal(r.action, "rejected");
  const [cm] = await mapGithubWebhook("issue_comment", { action: "created", repository: repo, sender: jordan, issue: { number: 57, title: "Jab counter", pull_request: {} }, comment: { id: 5, body: "ship it", user: jordan, created_at: "2026-08-16T14:21:00Z", html_url: "x" } });
  assert.equal(cm.action, "sent"); assert.equal(cm.artifacts[0].id, "pr:slcwitit/rpg#57");
  const [w] = await mapGithubWebhook("workflow_run", { action: "completed", repository: repo, workflow_run: { id: 77, name: "CI", run_number: 12, run_attempt: 1, conclusion: "success", head_sha: "deadbeefcafe1234", head_branch: "feat/jab", event: "pull_request", html_url: "y", run_started_at: "2026-08-16T14:20:10Z", updated_at: "2026-08-16T14:21:40Z", pull_requests: [{ number: 57 }] } });
  assert.equal(w.action, "executed"); assert.equal(w.actor.type, "system"); assert.equal(w.duration_ms, 90000); assert.ok(w.artifacts.some((x) => x.id === "pr:slcwitit/rpg#57"));
  assert.equal(githubActor({ login: "dependabot[bot]", type: "Bot" }).type, "system");
  assert.equal(githubActor({ login: "copilot", type: "Bot" }).type, "agent");
  assert.deepEqual(await mapGithubWebhook("push", { repository: repo, commits: [{ id: "abc" }] }), []);
  const p = await mapGithubWebhook("push", { repository: repo, ref: "refs/heads/main", pusher: { name: "jordandru" }, commits: [{ id: "abcdef1234567890", message: "m", timestamp: "2026-08-16T14:00:00Z", author: { email: "j@x", name: "J" }, added: ["a.ts"], modified: [], removed: [] }] }, { includePush: true });
  assert.equal(p.length, 1); assert.equal(p[0].idempotency_key, "gh:push:slcwitit/rpg:abcdef1234567890"); // its OWN key: a second producer, never deduped against the hook's git:<sha>
  assert.deepEqual(p[0].actor, { type: "human", id: "j@x", display_name: "J" });
  assert.equal(p[0].method?.params?.producer, "github-push");
  assert.equal(p[0].method?.params?.principal_rule, "agent-address/1");
  // an agent commit resolves the same actor the hook would, from the trailers in the pushed message
  const [ag] = await mapGithubWebhook("push", { repository: repo, commits: [{ id: "0123456789abcdef", message: "Fix\n\nRetrace-Actor: codex\nRetrace-Model: gpt-5\nRetrace-Caused-By: evt_" + "a".repeat(32), timestamp: "2026-08-16T14:00:00Z", author: { email: "j@x", name: "J" }, added: [], modified: ["b.ts"], removed: [] }] }, { includePush: true });
  assert.deepEqual(ag.actor, { type: "agent", id: "codex", model: "gpt-5", on_behalf_of: "j@x" });
  assert.equal(ag.caused_by, "evt_" + "a".repeat(32)); assert.equal(ag.intent, "Fix"); assert.equal(ag.method?.automated, true);
  assert.equal(ag.method?.params?.model_claim, "source-missing");
  const [agSrc] = await mapGithubWebhook("push", { repository: repo, commits: [{ id: "1123456789abcdef", message: "Fix\n\nRetrace-Actor: codex\nRetrace-Model: gpt-5\nRetrace-Model-Source: harness-runtime\nRetrace-Caused-By: evt_" + "a".repeat(32), timestamp: "2026-08-16T14:00:00Z", author: { email: "j@x", name: "J" }, added: [], modified: ["b.ts"], removed: [] }] }, { includePush: true });
  assert.equal(agSrc.actor.model_source, "harness-runtime");
  assert.equal(agSrc.method?.params?.model_claim, "complete");
  const [agBad] = await mapGithubWebhook("push", { repository: repo, commits: [{ id: "2123456789abcdef", message: "Fix\n\nRetrace-Actor: codex\nRetrace-Model: gpt-5\nRetrace-Model-Source: none", timestamp: "2026-08-16T14:00:00Z", author: { email: "j@x", name: "J" }, added: [], modified: ["b.ts"], removed: [] }] }, { includePush: true });
  assert.equal(agBad.actor.model_source, undefined);
  assert.equal(agBad.actor.model, "gpt-5");
  assert.equal(agBad.method?.params?.model_claim, "inconsistent");
  EventInput.parse(agBad);
  const [bot] = await mapGithubWebhook("push", { repository: repo, commits: [{ id: "fedcba9876543210", message: "Checkpoint", timestamp: "2026-08-16T14:00:00Z", author: { email: "41898282+github-actions[bot]@users.noreply.github.com", name: "retrace-checkpoint[bot]" }, added: [".retrace/checkpoints.jsonl"], modified: [], removed: [] }] }, { includePush: true });
  assert.equal(bot.actor.type, "system");
  assert.deepEqual(await mapGithubWebhook("ping", {}), []);
  // PROV role: reviews and comments use the PR; a run is generated by executing on PRs/commit (inputs); push mirrors the git hook
  assert.equal(a.artifacts[0].role, "used"); assert.equal(r.artifacts[0].role, "used"); assert.equal(cm.artifacts[0].role, "used");
  assert.deepEqual(w.artifacts.map((x) => [x.kind, x.role]), [["workflow_run", "generated"], ["pr", "used"], ["commit", "used"]]);
  assert.deepEqual(p[0].artifacts.map((x) => x.role), ["generated", "generated"]);
});

test("T8 push agent-address/1 resolves a user sender as the authenticated principal", async () => {
  const payload = {
    repository: repo,
    ref: "refs/heads/main",
    sender: { login: "jordan", type: "User" },
    commits: [{
      id: "abc123",
      message: "change\n\nRetrace-Actor: claude-code\n",
      timestamp: "2026-09-01T00:00:00Z",
      author: { name: "Claude", email: "noreply@anthropic.com" },
      modified: ["a.ts"],
      parents: [],
    }],
  };
  const [event] = await mapGithubWebhook("push", payload, { includePush: true });
  assert.equal(event.actor.id, "claude-code");
  assert.equal(event.actor.on_behalf_of, "github:jordan");

  const [nonUser] = await mapGithubWebhook("push", {
    ...payload,
    sender: { login: "deploy-bot", type: "Bot" },
  }, { includePush: true });
  assert.equal(nonUser.actor.id, "claude-code");
  assert.equal(nonUser.actor.on_behalf_of, undefined);
});

test("REST backfill mapping orders events and signature verifies", async () => {
  const evs = await mapGithubPullRest("slcwitit/rpg", { ...pr, created_at: "2026-08-16T14:00:00Z", merged_at: "2026-08-16T14:30:00Z", state: "closed", merge_commit_sha: "feedface0000" }, [{ id: 1, state: "APPROVED", user: { login: "coach-mike" }, submitted_at: "2026-08-16T14:15:00Z", body: "ok" }]);
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

test("F17: push mapping records explicit parents and never invents ancestry from array order", async () => {
  const x = "0".repeat(40), a = "1".repeat(40), b = "2".repeat(40), merge = "3".repeat(40);
  const commit = (id: string, parents?: string[]) => ({
    id, message: "work", timestamp: "2026-09-10T12:00:00.000Z",
    author: { name: "Jordan", email: "jordan@example.com" },
    added: [], modified: [], removed: [], ...(parents ? { parents } : {}),
  });
  const mapped = await mapGithubWebhook("push", {
    before: "f".repeat(40), ref: "refs/heads/main", repository: { full_name: "acme/app" },
    commits: [commit(a, [x]), commit(b, [x]), commit(merge, [a, b])],
  }, { includePush: true });
  assert.deepEqual(mapped.map((event) => event.method?.params?.parents), [[x], [x], [a, b]]);
  assert.deepEqual(mapped.map((event) => event.method?.params?.parents_complete), [true, true, true]);

  const forcePush = await mapGithubWebhook("push", {
    before: "e".repeat(40), forced: true, ref: "refs/heads/main", repository: { full_name: "acme/app" },
    commits: [commit(a), commit(b), commit(merge)],
  }, { includePush: true });
  assert.deepEqual(forcePush.map((event) => event.method?.params?.parents), [[], [], []]);
  assert.deepEqual(forcePush.map((event) => event.method?.params?.parents_complete), [false, false, false]);
});

// §1.1 ingestion contract: compare against Node's independent SHA-256 implementation.
test("§1.1 normaliseGithubBody: UTF-8, CRLF, per-line whitespace, empty and long bodies", async () => {
  const { createHash } = await import("node:crypto");
  const { normaliseGithubBody, githubBodySha256 } = await import("./github.js");
  for (const [raw, normalized] of [
    ["", ""], [" \t\r\n\r\n", ""], ["  é🐈 \t\r\nnext\t\r\n\r\n", "  é🐈\nnext"],
    ["a".repeat(10000) + " \n", "a".repeat(10000)],
  ]) {
    assert.equal(normaliseGithubBody(raw), normalized);
    assert.equal(await githubBodySha256(raw), createHash("sha256").update(normalized, "utf8").digest("hex"));
  }
});

test("§1.1 github_payload: PR open/reopen/edit hash full body and title; ingress is optional for REST", async () => {
  const { githubBodySha256 } = await import("./github.js");
  const body = "x".repeat(500) + " \r\nsecond\t\n";
  const title = "A title \t";
  const opts = { deliveryId: "payload-delivery", ingressAt: "2026-09-28T22:00:00.123Z" };
  const head = { ...pr.head, repo: { full_name: "fork/rpg" } };
  for (const action of ["opened", "reopened", "edited"]) {
    const [event] = await mapGithubWebhook("pull_request", { repository: repo, sender: jordan, action, pull_request: { ...pr, head, body, title } }, opts);
    assert.deepEqual(event.method!.params!.github_payload, {
      login: "jordan", login_source: "sender", branch: head.ref, head_repo: "fork/rpg",
      body_sha256: await githubBodySha256(body), body_null: false, title_sha256: await githubBodySha256(title),
      ...(action === "edited" ? {} : { head_sha: head.sha }),
      delivery: opts.deliveryId, ingress_at: opts.ingressAt, payload_time: pr.updated_at,
    });
  }
  const [empty] = await mapGithubWebhook("pull_request", { repository: repo, sender: jordan, action: "opened", pull_request: { ...pr, body: null } });
  assert.equal((empty.method!.params!.github_payload as any).body_null, true);
  assert.equal((empty.method!.params!.github_payload as any).body_sha256, await githubBodySha256(""));
  const [rest] = await mapGithubPullRest(repo.full_name, { ...pr, created_at: pr.updated_at });
  assert.equal((rest.method!.params!.github_payload as any).ingress_at, undefined);
});

test("§1.1 github_payload: synchronize, merge login and fallback, other PR state changes", async () => {
  const opts = { deliveryId: "d", ingressAt: "2026-09-28T22:00:00Z" };
  const payload = { repository: repo, sender: jordan, pull_request: pr };
  const [sync] = await mapGithubWebhook("pull_request", { ...payload, action: "synchronize", after: "new-sha" }, opts);
  assert.deepEqual(sync.method!.params!.github_payload, {
    login: "jordan", login_source: "sender", branch: pr.head.ref, head_repo: undefined,
    head_sha: "new-sha", delivery: "d", ingress_at: opts.ingressAt, payload_time: pr.updated_at,
  });
  for (const mergedBy of [{ login: "merger" }, null]) {
    const [event] = await mapGithubWebhook("pull_request", { ...payload, action: "closed", pull_request: {
      ...pr, merged: true, merged_by: mergedBy, merge_commit_sha: "merge-sha", merged_at: "2026-09-28T21:59:59Z",
    } }, opts);
    assert.deepEqual(event.method!.params!.github_payload, {
      login: mergedBy ? "merger" : "jordan", login_source: mergedBy ? "merged_by" : "sender",
      branch: pr.head.ref, head_repo: undefined, merge_commit_sha: "merge-sha", delivery: "d",
      ingress_at: opts.ingressAt, payload_time: "2026-09-28T21:59:59Z",
    });
  }
  for (const action of ["closed", "ready_for_review", "converted_to_draft"]) {
    const [event] = await mapGithubWebhook("pull_request", { ...payload, action }, opts);
    assert.deepEqual(event.method!.params!.github_payload, {
      login: "jordan", login_source: "sender", branch: pr.head.ref, head_repo: undefined,
      delivery: "d", ingress_at: opts.ingressAt, payload_time: pr.updated_at,
    });
  }
});

test("§1.1 github_payload: reviews and comments keep user, null body, ids, time and no invented comment branch", async () => {
  const { githubBodySha256 } = await import("./github.js");
  const opts = { deliveryId: "d", ingressAt: "2026-09-28T22:00:00Z" };
  for (const user of [{ login: "writer" }, null]) {
    for (const body of ["full body \r\n", null]) {
      const [review] = await mapGithubWebhook("pull_request_review", { action: "submitted", repository: repo, sender: jordan,
        pull_request: { ...pr, head: { ...pr.head, repo: { full_name: "fork/rpg" } } },
        review: { id: 42, state: "CHANGES_REQUESTED", user, body, commit_id: "reviewed-sha", submitted_at: "payload-time" },
      }, opts);
      assert.deepEqual(review.method!.params!.github_payload, {
        login: user ? "writer" : "jordan", login_source: user ? "review.user" : "sender",
        branch: pr.head.ref, head_repo: "fork/rpg", body_sha256: await githubBodySha256(body ?? ""), body_null: body === null,
        review_state: "changes_requested", head_sha: "reviewed-sha", review_id: 42,
        delivery: "d", ingress_at: opts.ingressAt, payload_time: "payload-time",
      });
      const [comment] = await mapGithubWebhook("issue_comment", { action: "created", repository: repo, sender: jordan,
        issue: { number: 57, pull_request: { url: "api-url" } }, comment: { id: 43, user, body, created_at: "payload-time" },
      }, opts);
      assert.deepEqual(comment.method!.params!.github_payload, {
        login: user ? "writer" : "jordan", login_source: user ? "comment.user" : "sender",
        body_sha256: await githubBodySha256(body ?? ""), body_null: body === null, comment_id: 43,
        delivery: "d", ingress_at: opts.ingressAt, payload_time: "payload-time",
      });
    }
  }
});

test("§1.1 push and workflow_run serialized bytes are unchanged by ingestion options", async () => {
  const { readFileSync } = await import("node:fs");
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/github-before-owner-login.json", import.meta.url), "utf8"));
  for (const fixture of fixtures) {
    const actual = await mapGithubWebhook(fixture.event, fixture.payload, { includePush: true, ingressAt: "new-ingress" });
    assert.equal(JSON.stringify(actual), fixture.serialized);
  }
});
