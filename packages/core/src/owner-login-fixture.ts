/** Synthetic /2 ingestion fixture, shared by memory, SQLite and workerd tests. */
import { EventStore, appendEvent } from "./store.js";
import { githubBodySha256, mapGithubWebhook } from "./github.js";
import { PolicyDocument, POLICY_PROFILE_V2 } from "./policy.js";
export async function ownerLoginScenario(store: EventStore) {
  const repo = "owner/repo", project = "owner-login-test", ingress = new Date(Date.now() + 1000).toISOString();
  const policy: PolicyDocument = { body: { profile: POLICY_PROFILE_V2, project, trusted_hook_stamps: [], unresolved_claims: "record",
    repositories: [{ name: repo, aliases: [] }], github_repos: [repo], github: { shared_logins: ["owner"], identities: {} } },
    envelope: { version: 1, created_at: ingress, set_by: { type: "human", id: "owner" }, supersedes: null,
      activation: { event_id: "synthetic-policy", seq: 1 } }, digest: "a".repeat(64) };
  const declaration = (await appendEvent(store, { project, actor: { type: "agent", id: "codex" }, action: "sent",
    artifacts: [{ id: `pr:${repo}#1`, role: "used" }], method: { params: { sealed_by: "pinned:codex", producer_sig_verdict: "verified",
      github_action: { kind: "comment", repo, login: "owner", pr: 1, body_sha256: await githubBodySha256("hello") } } } })).event;
  const payload = { repository: { full_name: repo }, action: "created", sender: { login: "owner" },
    issue: { number: 1, pull_request: {} }, comment: { id: 1, body: "hello", created_at: ingress } };
  const input = (await mapGithubWebhook("issue_comment", payload, { project, ingressAt: ingress, deliveryId: "first" }))[0];
  input.method!.params = { ...input.method!.params, sealed_by: "webhook:github", producer_sig_verdict: "none" };
  return { repo, project, ingress, policy, declaration, input, payload };
}
