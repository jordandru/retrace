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
 *   push              → skipped by default (the git adapter covers commits); enable with includePush
 *
 * Artifact ids line up with the git adapter: `pr:<owner/repo>#<n>`, `commit:<owner/repo>@<sha12>`, `repo:<owner/repo>#<path>`.
 * WHY: PR body / review body; `caused_by` from a `Retrace-Caused-By: evt_…` line in the PR body.
 * PROV role (what the webhook authoritatively knows): opened → PR generated · synchronize → PR both · review/comment → PR used ·
 *   merged → PR used + merge commit generated · workflow_run → run generated, PRs/commit used · push → commit + files generated ·
 *   closed-unmerged / ready_for_review / converted_to_draft / edited → absent (state changes, not content).
 */
import { EventInput, Actor, ArtifactRole } from "./schema.js";

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

const causedByFrom = (text?: string | null): string | undefined => text?.match(/Retrace-Caused-By:\s*(evt_[a-f0-9]+)/i)?.[1];
const trim = (s: string | null | undefined, n = 300) => { const t = s?.replace(/^\s*Retrace-[\w-]+:.*$/gim, "").trim(); return t ? (t.length > n ? t.slice(0, n - 1) + "…" : t) : undefined; };

export interface GithubMapOptions { project?: string; includePush?: boolean; deliveryId?: string }

/** Map one webhook delivery to zero or more events. `event` = X-GitHub-Event header. */
export function mapGithubWebhook(event: string, payload: any, opts: GithubMapOptions = {}): EventInput[] {
  const repoFull: string = payload?.repository?.full_name ?? "unknown/unknown";
  const project = opts.project ?? repoFull;
  const idem = (suffix: string) => (opts.deliveryId ? `gh:${opts.deliveryId}` : `gh:${repoFull}:${suffix}`);
  const where = (url?: string) => ({ system: "github", url });
  const prArtifact = (pr: any, role?: ArtifactRole) => ({ id: `pr:${repoFull}#${pr.number}`, kind: "pr", label: `PR #${pr.number} ${pr.title ?? ""}`.trim(), derived_from: pr.head?.sha ? [`commit:${repoFull}@${pr.head.sha.slice(0, 12)}`] : undefined, ...(role ? { role } : {}) });

  if (event === "pull_request") {
    const pr = payload.pull_request; const a = payload.action;
    const base: Omit<EventInput, "action"> = {
      project, actor: githubActor(payload.sender), artifacts: [prArtifact(pr)], timestamp: pr.updated_at ?? new Date().toISOString(),
      location: where(pr.html_url), caused_by: causedByFrom(pr.body), method: { tool: "github", automated: false, params: { action: a, head: pr.head?.ref, base: pr.base?.ref, head_sha: pr.head?.sha, additions: pr.additions, deletions: pr.deletions, changed_files: pr.changed_files } },
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
    return [{
      project, actor: githubActor(r.user ?? payload.sender), action, action_detail: action === "other" ? "reviewed" : undefined,
      artifacts: [prArtifact(pr, "used")], timestamp: r.submitted_at ?? new Date().toISOString(), location: where(r.html_url ?? pr.html_url),
      intent: trim(r.body) ?? (state === "approved" ? `approved PR #${pr.number}` : state === "changes_requested" ? `requested changes on PR #${pr.number}` : `reviewed PR #${pr.number}`),
      caused_by: causedByFrom(r.body) ?? causedByFrom(pr.body), method: { tool: "github-review", automated: false, params: { state, commit: r.commit_id } },
      idempotency_key: idem(`review${r.id}`), tags: ["github", "review"],
    }];
  }
  if (event === "issue_comment" && payload.action === "created" && payload.issue?.pull_request) {
    const c = payload.comment, n = payload.issue.number;
    return [{
      project, actor: githubActor(c.user ?? payload.sender), action: "sent", artifacts: [{ id: `pr:${repoFull}#${n}`, kind: "pr", label: `PR #${n} ${payload.issue.title ?? ""}`.trim(), role: "used" as const }],
      timestamp: c.created_at, location: where(c.html_url), intent: trim(c.body), caused_by: causedByFrom(c.body), method: { tool: "github-comment", automated: false },
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
    return (payload.commits ?? []).map((c: any) => ({
      project, actor: { type: "human" as const, id: c.author?.email ?? `github:${c.author?.username}`, display_name: c.author?.name }, action: "committed" as const,
      artifacts: [{ id: `commit:${repoFull}@${String(c.id).slice(0, 12)}`, kind: "commit", label: `${repoFull}@${String(c.id).slice(0, 7)}`, role: "generated" as const }, ...[...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])].map((f: string) => ({ id: `repo:${repoFull}#${f}`, kind: "file", label: f, role: "generated" as const }))],
      timestamp: c.timestamp, location: where(c.url), intent: c.message, method: { tool: "git", automated: false }, idempotency_key: `git:${c.id}`, tags: ["github", "push"],
    }));
  }
  return [];
}

/** Map a REST /pulls item (+ its reviews) for backfill. */
export function mapGithubPullRest(repoFull: string, pr: any, reviews: any[] = [], project = repoFull): EventInput[] {
  const fake = { repository: { full_name: repoFull } };
  const out: EventInput[] = [];
  out.push(...mapGithubWebhook("pull_request", { ...fake, action: "opened", sender: pr.user, pull_request: { ...pr, updated_at: pr.created_at } }, { project }));
  for (const r of reviews) out.push(...mapGithubWebhook("pull_request_review", { ...fake, action: "submitted", sender: r.user, review: r, pull_request: pr }, { project }));
  if (pr.merged_at) out.push(...mapGithubWebhook("pull_request", { ...fake, action: "closed", sender: pr.merged_by ?? pr.user, pull_request: { ...pr, merged: true, updated_at: pr.merged_at } }, { project }));
  else if (pr.state === "closed") out.push(...mapGithubWebhook("pull_request", { ...fake, action: "closed", sender: pr.user, pull_request: { ...pr, merged: false, updated_at: pr.closed_at ?? pr.updated_at } }, { project }));
  return out.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}
