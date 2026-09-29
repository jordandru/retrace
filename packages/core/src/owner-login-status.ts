/** Historical read-time labels never change seals or consume declarations. */
import { Event } from "./schema.js";
import { EventStore } from "./store.js";
import { PolicyDocument } from "./policy.js";
import { evaluateAmendmentsAtU } from "./classify.js";
import { classifyOwnerLogin, declarationAgent, declarationPinned, ownerLoginKind, ownerLoginRecord, OwnerLoginStatus } from "./owner-login.js";
import { githubWebhookProduced, recordedGithubLogin } from "./owner-login-view.js";

export interface OwnerLoginStats {
  total: number; sealed_as_human: number; legacy_unknown_login: number;
  by_status: Record<OwnerLoginStatus, number>;
  read_time_labels: { declared_by_seat: number; conflicting: number; unresolved: number };
  computed_at_seq: number;
  identity_mapped_scope: "current policy identities; separate from shared-login total";
}
function repoOf(e: Event): string | undefined { return e.artifacts.map(a => /^pr:(.+)#\d+$/.exec(a.id)?.[1]).find(Boolean); }
function idInEvent(e: Event, id: unknown, kind: "review" | "comment"): boolean {
  if ((typeof id !== "number" && typeof id !== "string") || !/^\d+$/.test(String(id))) return false;
  const anchor = kind === "review" ? "pullrequestreview" : "issuecomment";
  const url = e.location?.url ?? "", key = e.idempotency_key ?? "";
  return new RegExp(`(?:#${anchor}-|/${kind === "review" ? "reviews" : "comments"}/)${id}(?:$|[^0-9])`).test(url) ||
    new RegExp(`(?:^|:)${kind}${id}(?:$|[^0-9])`).test(key);
}
function outcomeSeats(e: Event, events: Event[], login: string, amended: ReadonlySet<string>): string[] {
  const repo = repoOf(e), kind = ownerLoginKind(e), pr = e.artifacts.find(a => a.id.startsWith(`pr:${repo}#`))?.id;
  const seats = new Set<string>();
  for (const candidate of events) {
    if (candidate.project !== e.project || !declarationPinned(candidate) || !declarationAgent(candidate) || candidate.action_detail === "amended" || amended.has(candidate.id)) continue;
    const a = candidate.method?.params?.github_action as Record<string, any> | undefined;
    if (!a || !a.result || typeof a.result !== "object" || a.repo !== repo || typeof a.login !== "string" || a.login.toLowerCase() !== login.toLowerCase() || a.kind !== kind) continue;
    if (kind === "review" || kind === "comment") {
      if (!idInEvent(e, a.result[kind === "review" ? "review_id" : "comment_id"], kind)) continue;
    } else if (!pr || Number(pr.slice(pr.lastIndexOf("#") + 1)) !== (a.result.pr ?? a.pr)) continue;
    seats.add(candidate.actor.id);
  }
  return [...seats];
}
export async function ownerLoginStats(store: EventStore, events: Event[], policy: PolicyDocument | null): Promise<OwnerLoginStats> {
  const stats: OwnerLoginStats = { total: 0, sealed_as_human: 0, legacy_unknown_login: 0,
    by_status: { declared_by_seat: 0, conflicting: 0, unresolved: 0, unavailable: 0, identity_mapped: 0 },
    read_time_labels: { declared_by_seat: 0, conflicting: 0, unresolved: 0 },
    computed_at_seq: events.at(-1)?.seq ?? -1, identity_mapped_scope: "current policy identities; separate from shared-login total" };
  if (!policy || policy.body.profile !== "retrace-project-policy/2") return stats;
  const shared = new Set(policy.body.github?.shared_logins.map(s => s.toLowerCase()));
  const identities = new Set(Object.keys(policy.body.github?.identities ?? {}).map(s => s.toLowerCase()));
  // Same predicate and bounded evaluator, but consumption is intentionally absent from this label-only view.
  const readStore = new Proxy(store, { get(target, key) {
    if (key === "ownerLoginConsumptionUpTo") return async () => ({ ok: true, rows: [] });
    const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v;
  } });
  const head = events.at(-1);
  const amendedByRepo = new Map<string, Set<string> | null>();
  const amendments = async (repo: string): Promise<Set<string> | null> => {
    if (amendedByRepo.has(repo)) return amendedByRepo.get(repo)!;
    if (!head) return null;
    const result = await evaluateAmendmentsAtU({ store, project: policy.body.project, U: head.seq, headHash: head.hash,
      policy: policy.body, policyDigest: policy.digest, canonicalRepo: repo, captureEvents: events,
      coveredArtifactKeys: [], deadline: Date.now()+300, now: Date.now });
    const ids = result.ok ? new Set(result.collection.effective.keys()) : null;
    amendedByRepo.set(repo, ids); return ids;
  };
  for (const e of events) {
    if (!githubWebhookProduced(e)) continue;
    const login = recordedGithubLogin(e), status = ownerLoginRecord(e)?.decision.status;
    if (!login) { stats.legacy_unknown_login++; continue; }
    if (identities.has(login.toLowerCase()) && status === "identity_mapped") stats.by_status.identity_mapped++;
    if (!shared.has(login.toLowerCase())) continue;
    stats.total++;
    if (status && status !== "identity_mapped" && Object.hasOwn(stats.by_status, status)) stats.by_status[status]++;
    if (e.actor.type !== "human") continue;
    stats.sealed_as_human++;
    let label: keyof OwnerLoginStats["read_time_labels"] = "unresolved";
    const amended = repoOf(e) ? await amendments(repoOf(e)!) : null;
    const seats = new Set(amended ? outcomeSeats(e, events, login, amended) : []);
    if (e.method?.params?.github_payload && head && repoOf(e)) {
      const result = await classifyOwnerLogin({ store: readStore, input: e, policy, canonicalR: repoOf(e)!, readHead: head, deadline: Date.now()+300 });
      if (result.kind === "decision") {
        const decision = ownerLoginRecord(result.input)!.decision;
        for (const declaration of decision.declarations) seats.add(declaration.actor.id);
      }
    }
    if (seats.size === 1) label = "declared_by_seat";
    else if (seats.size > 1) label = "conflicting";
    stats.read_time_labels[label]++;
  }
  return stats;
}
