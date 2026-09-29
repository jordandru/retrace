import type { Event } from "./schema.js";
import { ownerLoginRecord } from "./owner-login-record.js";

export function ownerLoginDisplay(e: Pick<Event, "method">): string | undefined {
  const record = ownerLoginRecord(e);
  if (!record) return undefined;
  const d = record.decision, base = `GitHub account ${record.login} (shared login)`;
  if (d.status === "identity_mapped") return `${d.actor_written.id} (GitHub App identity)`;
  if (d.status === "declared_by_seat") return `${base} — declared by ${d.actor_written.id} (${d.declarations.map(e => e.id.slice(0, 16)).join(", ")}), not identity-verified`;
  if (d.status === "conflicting") return `${base} — conflicting: ${[...new Set(d.declarations.map(e => e.actor.id))].join(", ")}`;
  return `${base} — who acted: ${d.status} (${d.reason ?? "no_declaration"})`;
}
export function githubWebhookProduced(e: Event): boolean {
  const stamp = e.method?.params?.sealed_by;
  return stamp === "webhook:github" || (stamp === undefined && ["github", "github-review", "github-comment", "github-push"].includes(e.method?.tool ?? ""));
}
export function recordedGithubLogin(e: Event): string | undefined {
  const payload = e.method?.params?.github_payload as { login?: unknown } | undefined;
  if (payload) return typeof payload.login === "string" ? payload.login : undefined;
  return e.actor.id.startsWith("github:") ? e.actor.id.slice(7) : undefined;
}
