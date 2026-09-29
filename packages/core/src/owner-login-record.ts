import type { Actor, EventInput } from "./schema.js";
import type { ChainHead, EventStore } from "./store.js";
import type { PolicyDocument } from "./policy.js";

export const OWNER_LOGIN_DECISION_PARAM = "owner_login_decision";
export const OWNER_LOGIN_ROW_CAP = 2_000;
export const OWNER_LOGIN_WINDOW_MS = 30 * 60_000;
export type OwnerLoginKind = "comment" | "review" | "pr_open" | "pr_edit" | "push" | "merge";
export type OwnerLoginStatus = "declared_by_seat" | "conflicting" | "unresolved" | "unavailable" | "identity_mapped";
export type OwnerLoginFailure = "store_error" | "budget" | "deadline";
export type GithubPayload = Record<string, unknown> & { login?: string; ingress_at?: string };
export interface OwnerLoginRecord {
  policy: "owner-login/1";
  observer: { producer: "github-webhook"; sealed_by: "webhook:github" };
  login: string;
  shared: boolean;
  payload: GithubPayload;
  decision: {
    status: OwnerLoginStatus;
    reason: string | null;
    kind: OwnerLoginKind | null;
    actor_written: Actor;
    evidence_level: "declaration_only" | "identity_mapped" | null;
    declarations: Array<{ id: string; seq: number; actor: Actor; sealed_by: string; producer_sig_verdict: "verified" }>;
    proximity_hints: number;
    context: { read_head_seq: number; read_head_hash: string; policy_digest: string };
    window: { from: string | null; to: string | null; basis: "ingress_at" };
    received: { webhook: null; declaration: string | null };
    consumed: string[];
    ingress_at: string | null;
    classification_ms: number;
    timing: {
      pre_ms: number | null;
      candidates_ms: number | null;
      consumption_ms: number | null;
      amendments_ms: number | null;
      filter_ms: number | null;
      stage_failed: "candidates" | "consumption" | "amendments" | "filter" | null;
      candidates_rows: number | null;
      budget_rows_remaining: number | null;
      deadline_ms: number;
    };
    allocation?: { attempts: 2; read_head_seq: number; consumed_by: string | null };
  };
}
export type OwnerLoginResult = { kind: "not_applicable" } | { kind: "decision"; input: EventInput; consume: string[] };
export type OwnerLoginArgs = { store: EventStore; input: EventInput; policy: PolicyDocument; canonicalR: string;
  readHead: ChainHead; deadline: number; preMs?: number; now?: () => number };

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export function ownerLoginRecord(input: Pick<EventInput, "method">): OwnerLoginRecord | undefined {
  const value = object(input.method?.params?.[OWNER_LOGIN_DECISION_PARAM]);
  return value?.policy === "owner-login/1" && object(value.decision) ? value as unknown as OwnerLoginRecord : undefined;
}
