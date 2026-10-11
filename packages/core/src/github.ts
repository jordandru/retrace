/**
 * GitHub adapter — pure mapping from GitHub webhook payloads (and REST objects) to Retrace EventInputs,
 * plus HMAC-SHA256 signature verification. Runs in Workers and Node.
 *
 * Handled events
 *   pull_request      opened/reopened → created · synchronize → edited · closed(merged) → merged · closed → other:closed
 *                     ready_for_review → other:ready_for_review · converted_to_draft → other:converted_to_draft
 *   pull_request_review  approved → approved · changes_requested → rejected · commented → other:reviewed
 *   issue_comment (on PR) → sent
 *   workflow_run      completed → executed (system actor = GitHub Actions)
 *   push              → skipped by default; enable with includePush. Then each pushed commit becomes a `committed` event
 *                       from a SECOND producer (GitHub, HMAC-verified) with its own key `gh:push:<repo>:<sha>` — it
 *                       never dedupes against the git hook's `git:<sha>`, so reconcile can compare the two. The actor
 *                       is resolved from the commit message exactly as the hook does (core commit-actor.ts).
 *
 * Artifact ids line up with the git adapter: `pr:<owner/repo>#<n>`, `commit:<owner/repo>@<sha12>`, `repo:<owner/repo>#<path>`.
 * WHY: PR body / review body; `caused_by` from a `Retrace-Caused-By: evt_…` line in the PR body.
 * PROV role (what the webhook authoritatively knows): opened → PR generated · synchronize → PR both · review/comment → PR used ·
 *   merged → PR used + merge commit generated · workflow_run → run generated, PRs/commit used · push → commit + files generated ·
 *   closed-unmerged / ready_for_review / converted_to_draft / edited → absent (state changes, not content).
 */
import { EventInput, Actor, ArtifactRole } from "./schema.js";
import { resolveCommitActor } from "./commit-actor.js";
import { sha256Hex } from "./chain.js";

const enc = new TextEncoder();
const subtle: SubtleCrypto = (globalThis as any).crypto.subtle;

export async function verifyGithubSignature(secret: string, rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const key = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await subtle.sign("HMAC", key, enc.encode(rawBody)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = signatureHeader.slice(7).toLowerCase();
  if (given.length !== hex.length) return false;
  let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

const BOT_RE = /\[bot\]$|^copilot$|^dependabot|^renovate|^github-actions/i;

export function githubActor(user: any, fallback = "github"): Actor {
  const login: string = user?.login ?? fallback;
  const bot = user?.type === "Bot" || BOT_RE.test(login);
  const agenty = /copilot|claude|codex|devin|cursor|aider|sweep/i.test(login);
  return {
    type: bot ? (agenty ? "agent" : "system") : "human",
    id: bot ? login : (user?.email ? user.email : `github:${login}`),
    display_name: user?.name ?? login,
    ...(agenty ? { model: undefined } : {}),
  };
}

const CAUSED_BY_KEY = "Retrace-Caused-By:";
const CAUSED_BY_FULL = /^evt_[a-f0-9]{32}$/i;
const REJECTED_TOKEN_CAP = 64;
/** The last line that starts with the key wins. A value longer than 64 characters keeps that prefix and its full length. */
function boundRejected(token: string): string {
  if (token.length <= REJECTED_TOKEN_CAP) return token;
  return `${token.slice(0, REJECTED_TOKEN_CAP)}…(${token.length})`;
}
function trimAsciiSpace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value.charCodeAt(start) === 0x20 || value.charCodeAt(start) === 0x09)) start++;
  while (end > start && (value.charCodeAt(end - 1) === 0x20 || value.charCodeAt(end - 1) === 0x09)) end--;
  return value.slice(start, end);
}
/**
 * Split on U+000A only. A trailing U+000D is stripped. The value is the rest of
 * that line, with only ASCII spaces and tabs trimmed. U+2028, U+2029, U+0085,
 * NBSP, and zero-width characters stay in the value. The last matching line wins.
 * A 32-hex id is stored lowercase. The git hook uses this same function.
 */
export function causedByFrom(text?: string | null): { id?: string; rejected?: string } {
  if (!text) return {};
  let token: string | undefined;
  let saw = false;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith(CAUSED_BY_KEY)) continue;
    saw = true;
    token = trimAsciiSpace(line.slice(CAUSED_BY_KEY.length));
  }
  if (!saw || !token || !/^evt_/i.test(token)) return {};
  if (CAUSED_BY_FULL.test(token)) return { id: token.toLowerCase() };
  return { rejected: boundRejected(token) };
}
const trim = (s: string | null | undefined, n = 300) => { const t = s?.replace(/^\s*Retrace-[\w-]+:.*$/gim, "").trim(); return t ? (t.length > n ? t.slice(0, n - 1) + "…" : t) : undefined; };

/** The declaration and ingestion paths hash exactly these UTF-8 bytes (N§3.4). */
export function normaliseGithubBody(s: string): string {
  return s.replace(/\r\n/g, "\n").split("\n").map(line => line.trimEnd()).join("\n").replace(/\n+$/, "");
}

export function githubBodySha256(s: string): Promise<string> {
  return sha256Hex(normaliseGithubBody(s));
}

export interface GithubMapOptions { project?: string; includePush?: boolean; deliveryId?: string; ingressAt?: string }

/** Map one webhook delivery to zero or more events. `event` = X-GitHub-Event header. */
export async function mapGithubWebhook(event: string, payload: any, opts: GithubMapOptions = {}): Promise<EventInput[]> {
  const repoFull: string = payload?.repository?.full_name ?? "unknown/unknown";
  const project = opts.project ?? repoFull;
  const idem = (suffix: string) => (opts.deliveryId ? `gh:${opts.deliveryId}` : `gh:${repoFull}:${suffix}`);
  const where = (url?: string) => ({ system: "github", url });
  const prArtifact = (pr: any, role?: ArtifactRole) => ({ id: `pr:${repoFull}#${pr.number}`, kind: "pr", label: `PR #${pr.number} ${pr.title ?? ""}`.trim(), derived_from: pr.head?.sha ? [`commit:${repoFull}@${pr.head.sha.slice(0, 12)}`] : undefined, ...(role ? { role } : {}) });

  if (event === "pull_request") {
    const pr = payload.pull_request; const a = payload.action;
    const merged = a === "closed" && pr.merged;
    const withBody = a === "opened" || a === "reopened" || a === "edited";
    const githubPayload = {
      login: merged ? (pr.merged_by?.login ?? payload.sender?.login) : payload.sender?.login,
      login_source: merged && pr.merged_by?.login != null ? "merged_by" : "sender",
      branch: pr.head?.ref, head_repo: pr.head?.repo?.full_name,
      ...(withBody ? { body_sha256: await githubBodySha256(pr.body ?? ""), body_null: pr.body == null,
        title_sha256: await githubBodySha256(pr.title ?? "") } : {}),
      ...(a === "opened" || a === "reopened" ? { head_sha: pr.head?.sha } : {}),
      ...(a === "synchronize" ? { head_sha: payload.after } : {}),
      ...(merged ? { merge_commit_sha: pr.merge_commit_sha } : {}),
      delivery: opts.deliveryId, ingress_at: opts.ingressAt,
      payload_time: merged ? pr.merged_at : pr.updated_at,
    };
    const prCause = causedByFrom(pr.body);
    const base: Omit<EventInput, "action"> = {
      project, actor: githubActor(payload.sender), artifacts: [prArtifact(pr)], timestamp: pr.updated_at ?? new Date().toISOString(),
      location: where(pr.html_url), caused_by: prCause.id, method: { tool: "github", automated: false, params: { action: a, head: pr.head?.ref, base: pr.base?.ref, head_sha: pr.head?.sha, additions: pr.additions, deletions: pr.deletions, changed_files: pr.changed_files, github_payload: githubPayload, ...(prCause.rejected ? { caused_by_rejected: prCause.rejected } : {}) } },
      idempotency_key: idem(`pr${pr.number}:${a}:${pr.updated_at}`), tags: ["github", "pr"],
    };
    if (a === "opened" || a === "reopened") return [{ ...base, action: "created", artifacts: [prArtifact(pr, "generated")], intent: trim(pr.body) ?? `Opened PR: ${pr.title}`, change: { summary: `${pr.title} (${pr.head?.ref} → ${pr.base?.ref})`, after_hash: pr.head?.sha } }];
    if (a === "synchronize") return [{ ...base, action: "edited", artifacts: [prArtifact(pr, "both")], intent: `pushed new commits to PR #${pr.number}`, change: { before_hash: payload.before, after_hash: payload.after, summary: `head ${String(payload.before).slice(0, 7)} → ${String(payload.after).slice(0, 7)}` } }];
    if (a === "closed") {
      if (pr.merged) return [{ ...base, actor: githubActor(pr.merged_by ?? payload.sender), action: "merged", timestamp: pr.merged_at ?? base.timestamp, intent: trim(pr.body) ?? `Merged PR #${pr.number}`, change: { summary: `${pr.title} — merged ${pr.head?.ref} into ${pr.base?.ref} (+${pr.additions ?? "?"} −${pr.deletions ?? "?"}, ${pr.changed_files ?? "?"} files)`, after_hash: pr.merge_commit_sha }, artifacts: [prArtifact(pr, "used"), ...(pr.merge_commit_sha ? [{ id: `commit:${repoFull}@${pr.merge_commit_sha.slice(0, 12)}`, kind: "commit", label: `${repoFull}@${pr.merge_commit_sha.slice(0, 7)}`, derived_from: [`pr:${repoFull}#${pr.number}`], role: "generated" as const }] : [])] , tags: ["github", "pr", "merge"] }];
      return [{ ...base, action: "other", action_detail: "closed", intent: `closed PR #${pr.number} without merging` }];
    }
    if (a === "ready_for_review" || a === "converted_to_draft" || a === "edited") return [{ ...base, action: "other", action_detail: a, intent: `${a.replace(/_/g, " ")}: ${pr.title}` }];
    return [];
  }
  if (event === "pull_request_review" && payload.action === "submitted") {
    const pr = payload.pull_request, r = payload.review; const state = String(r.state).toLowerCase();
    const action = state === "approved" ? "approved" : state === "changes_requested" ? "rejected" : "other";
    const reviewCause = causedByFrom(r.body);
    const prCause = causedByFrom(pr.body);
    const cause = reviewCause.id || reviewCause.rejected ? reviewCause : prCause;
    return [{
      project, actor: githubActor(r.user ?? payload.sender), action, action_detail: action === "other" ? "reviewed" : undefined,
      artifacts: [prArtifact(pr, "used")], timestamp: r.submitted_at ?? new Date().toISOString(), location: where(r.html_url ?? pr.html_url),
      intent: trim(r.body) ?? (state === "approved" ? `approved PR #${pr.number}` : state === "changes_requested" ? `requested changes on PR #${pr.number}` : `reviewed PR #${pr.number}`),
      caused_by: cause.id, method: { tool: "github-review", automated: false, params: { state, commit: r.commit_id, ...(cause.rejected ? { caused_by_rejected: cause.rejected } : {}), github_payload: {
        login: r.user?.login ?? payload.sender?.login, login_source: r.user?.login != null ? "review.user" : "sender",
        branch: pr.head?.ref, head_repo: pr.head?.repo?.full_name,
        body_sha256: await githubBodySha256(r.body ?? ""), body_null: r.body == null,
        review_state: state, head_sha: r.commit_id, review_id: r.id,
        delivery: opts.deliveryId, ingress_at: opts.ingressAt, payload_time: r.submitted_at,
      } } },
      idempotency_key: idem(`review${r.id}`), tags: ["github", "review"],
    }];
  }
  if (event === "issue_comment" && payload.action === "created" && payload.issue?.pull_request) {
    const c = payload.comment, n = payload.issue.number;
    const commentCause = causedByFrom(c.body);
    return [{
      project, actor: githubActor(c.user ?? payload.sender), action: "sent", artifacts: [{ id: `pr:${repoFull}#${n}`, kind: "pr", label: `PR #${n} ${payload.issue.title ?? ""}`.trim(), role: "used" as const }],
      timestamp: c.created_at, location: where(c.html_url), intent: trim(c.body), caused_by: commentCause.id, method: { tool: "github-comment", automated: false, params: { ...(commentCause.rejected ? { caused_by_rejected: commentCause.rejected } : {}), github_payload: {
        login: c.user?.login ?? payload.sender?.login, login_source: c.user?.login != null ? "comment.user" : "sender",
        body_sha256: await githubBodySha256(c.body ?? ""), body_null: c.body == null, comment_id: c.id,
        delivery: opts.deliveryId, ingress_at: opts.ingressAt, payload_time: c.created_at,
      } } },
      idempotency_key: idem(`comment${c.id}`), tags: ["github", "comment"],
    }];
  }
  if (event === "workflow_run" && payload.action === "completed") {
    const w = payload.workflow_run; const prs: any[] = w.pull_requests ?? [];
    return [{
      project, actor: { type: "system", id: "github-actions", display_name: `GitHub Actions · ${w.name}` }, action: "executed",
      artifacts: [{ id: `run:${repoFull}#${w.id}`, kind: "workflow_run", label: `${w.name} #${w.run_number}`, role: "generated" as const }, ...prs.map((p) => ({ id: `pr:${repoFull}#${p.number}`, kind: "pr", label: `PR #${p.number}`, role: "used" as const })), { id: `commit:${repoFull}@${String(w.head_sha).slice(0, 12)}`, kind: "commit", label: `${repoFull}@${String(w.head_sha).slice(0, 7)}`, role: "used" as const }],
      timestamp: w.updated_at, duration_ms: w.run_started_at && w.updated_at ? Date.parse(w.updated_at) - Date.parse(w.run_started_at) : undefined,
      location: where(w.html_url), intent: `${w.name} on ${w.head_branch}: ${w.conclusion}`, change: { summary: `conclusion: ${w.conclusion}`, after_hash: w.head_sha },
      method: { tool: "github-actions", automated: true, params: { event: w.event, conclusion: w.conclusion, attempt: w.run_attempt } },
      idempotency_key: idem(`run${w.id}:${w.run_attempt}`), tags: ["github", "ci", String(w.conclusion)],
    }];
  }
  if (event === "push" && opts.includePush) {
    return (payload.commits ?? []).map((c: any) => {
      const r = resolveCommitActor({ message: String(c.message ?? ""), authorName: c.author?.name, authorEmail: c.author?.email ?? (c.author?.username ? `github:${c.author.username}` : undefined), principalRule: "agent-address/1" });
      const actor = r.actor.type === "agent" && r.actor.on_behalf_of === undefined && payload.sender?.type === "User"
        ? { ...r.actor, on_behalf_of: `github:${payload.sender.login}` }
        : r.actor;
      const files: string[] = [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])];
      const parentsComplete = Array.isArray(c.parents);
      const parents: string[] = parentsComplete
        ? c.parents.filter((p: unknown): p is string => typeof p === "string")
        : [];
      const pushCause = causedByFrom(String(c.message ?? ""));
      return {
        project, actor, action: "committed" as const,
        artifacts: [{ id: `commit:${repoFull}@${String(c.id).slice(0, 12)}`, kind: "commit", label: `${repoFull}@${String(c.id).slice(0, 7)}`, role: "generated" as const }, ...files.map((f) => ({ id: `repo:${repoFull}#${f}`, kind: "file", label: f, role: "generated" as const }))],
        timestamp: c.timestamp, location: where(c.url), intent: r.intent, caused_by: pushCause.id,
        change: { after_hash: c.id, summary: `${files.length} file${files.length === 1 ? "" : "s"} (pushed to ${String(payload.ref ?? "").replace(/^refs\/heads\//, "")})` },
        method: { tool: "git", automated: actor.type !== "human", params: {
          sha: c.id, producer: "github-push", ref: payload.ref, pusher: payload.pusher?.name,
          ...(pushCause.rejected ? { caused_by_rejected: pushCause.rejected } : {}),
          raw_message: String(c.message ?? ""), author: { name: c.author?.name, email: c.author?.email ?? (c.author?.username ? `github:${c.author.username}` : undefined) },
          parents, parents_complete: parentsComplete, model_claim: r.modelClaim, principal_rule: "agent-address/1",
        } },
        idempotency_key: `gh:push:${repoFull}:${c.id}`, tags: ["github", "push"],
      };
    });
  }
  return [];
}

/** Map a REST /pulls item (+ its reviews) for backfill. */
export async function mapGithubPullRest(repoFull: string, pr: any, reviews: any[] = [], project = repoFull): Promise<EventInput[]> {
  const fake = { repository: { full_name: repoFull } };
  const out: EventInput[] = [];
  out.push(...await mapGithubWebhook("pull_request", { ...fake, action: "opened", sender: pr.user, pull_request: { ...pr, updated_at: pr.created_at } }, { project }));
  for (const r of reviews) out.push(...await mapGithubWebhook("pull_request_review", { ...fake, action: "submitted", sender: r.user, review: r, pull_request: pr }, { project }));
  if (pr.merged_at) out.push(...await mapGithubWebhook("pull_request", { ...fake, action: "closed", sender: pr.merged_by ?? pr.user, pull_request: { ...pr, merged: true, updated_at: pr.merged_at } }, { project }));
  else if (pr.state === "closed") out.push(...await mapGithubWebhook("pull_request", { ...fake, action: "closed", sender: pr.user, pull_request: { ...pr, merged: false, updated_at: pr.closed_at ?? pr.updated_at } }, { project }));
  return out.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}
