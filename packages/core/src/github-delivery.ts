/** GitHub delivery processing shared by authenticated receipt and leased retry.
 * Callers own authentication/routing, receipt clock setup and lease acquisition.
 * This module owns whole-delivery processing and durable completion. Receipt and
 * retry deliberately preserve distinct timing, stamps, failures and retry rules.
 */
import type { ZodIssue } from "zod";
import { EventInput } from "./schema.js";
import {
  appendEvent, AppendDeadlineExceededError, SEALED_BY_PARAM, SEALED_BY_GITHUB_WEBHOOK,
  writeClientError, type EventStore, type PendingDelivery,
} from "./store.js";
import {
  attachClaimDecision, classifyCommitClaim, CLASSIFY_DEADLINE_MS, PENDING_BUDGET_ATTEMPTS,
  recordWebhookClassifyOutcome, webhookBreakerAdmission,
} from "./classify.js";
import {
  isGitCommitSeal, PRODUCER_SIG_VERDICT_PARAM, stampSealedBy, type TrailerPolicy,
} from "./producer-sig.js";
import type { PolicyDocument } from "./policy.js";
import { appendOwnerLoginEvent } from "./owner-login.js";
import { mapGithubWebhook } from "./github.js";

export interface RoutedGithubReceipt {
  event: string;
  rawBody: string;
  payload: unknown;
  deliveryId?: string;
  /** Generated before the caller starts the receipt deadline, distinct from mapping identity. */
  retainedDeliveryId: string;
  ingressAt: string;
  project: string;
  canonicalRepo: string;
  routingSource: string;
  routingDigest?: string;
  currentPolicy: PolicyDocument | null;
}

export interface GithubReceiptContext {
  trailerPolicy: TrailerPolicy;
  /** Admission captured before the receipt clock starts; mapping reads includePush later. */
  pushEnabledAtReceipt: boolean;
  /** May be a getter: preserve the caller option read after retention/breaker awaits. */
  includePush?: boolean;
  /** Absolute deadline established after routing/policy preflight, as before extraction. */
  deadline: number;
  now: () => number;
}

export type GithubLoggedResult =
  | { id: string; seq: number; deduped: boolean }
  | { error: ZodIssue[] };

export type GithubReceiptOutcome =
  | { kind: "complete"; logged: GithubLoggedResult[] }
  // Breaker admission reports raw commit ids before mapping/validation, as before extraction.
  | { kind: "pending"; pending: unknown[]; reason: string }
  | { kind: "client_error"; error: string }
  | { kind: "retention_failed" };

export interface ClaimedGithubDelivery {
  row: PendingDelivery;
  owner: string;
  until: string;
}

export interface GithubRetryContext {
  /** May be a getter: each classifier reads the caller option after deduplication. */
  trailerPolicy: TrailerPolicy;
  now: () => number;
}

export type GithubRetryOutcome = "drained" | "failed";

export const WEBHOOK_DELIVERY_DEADLINE_MS = 2_000;
const DELIVERY_DEADLINE_EXPIRED = Symbol("delivery deadline expired");

type DeliveryWorkOutcome<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

function logExpiredDeliveryRejection<T>(outcome: DeliveryWorkOutcome<T>): void {
  if (outcome.status === "rejected")
    console.error(`retrace-api: delivery work rejected after deadline: ${(outcome.reason as any)?.stack ?? outcome.reason}`);
}

async function withinDeliveryDeadline<T>(work: Promise<T>, deadline: number, now: () => number = () => Date.now()): Promise<T | typeof DELIVERY_DEADLINE_EXPIRED> {
  // Observe both branches before checking the clock: callers pass already-started promises, including with no budget.
  const settled: Promise<DeliveryWorkOutcome<T>> = work.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
  const remaining = deadline - now();
  if (remaining <= 0) {
    void settled.then(logExpiredDeliveryRejection);
    return DELIVERY_DEADLINE_EXPIRED;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    settled,
    new Promise<typeof DELIVERY_DEADLINE_EXPIRED>((resolve) => {
      timer = setTimeout(() => resolve(DELIVERY_DEADLINE_EXPIRED), remaining);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  if (outcome === DELIVERY_DEADLINE_EXPIRED) {
    void settled.then(logExpiredDeliveryRejection);
    return outcome;
  }
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
}

/** Process an authenticated, routed receipt; expected interruptions are response data.
 * Unexpected exceptions retain the caller's existing HTTP error handling.
 */
export async function receive(
  store: EventStore, receipt: RoutedGithubReceipt, context: GithubReceiptContext,
): Promise<GithubReceiptOutcome> {
  const { event: ghEvent, rawBody: raw, deliveryId: delivery, retainedDeliveryId: retainedDelivery,
    ingressAt, project, canonicalRepo: repo, routingSource, routingDigest, currentPolicy } = receipt;
  // Preflight already parsed this JSON and checked its repository. Do not strengthen validation here.
  const payload = receipt.payload as any;
  const { trailerPolicy: mode, deadline: deliveryDeadline, now } = context;
  const ownerLoginDelivery = ["pull_request", "pull_request_review", "issue_comment"].includes(ghEvent);
  const isPushDelivery = context.pushEnabledAtReceipt;
  const isShadowPush = mode === "shadow" && isPushDelivery;
  let probe = false;
  if ((isPushDelivery || ownerLoginDelivery) && store.insertPendingDelivery) {
    try {
      await store.insertPendingDelivery({
        delivery_id: retainedDelivery,
        project, raw_body: raw, received_at: ingressAt, gh_event: ghEvent,
        repo, routing_source: routingSource, routing_digest: routingDigest, routing_state: "received",
      });
    } catch {
      return { kind: "retention_failed" };
    }
  }
  if (isShadowPush) {
    const probeOwner = `${delivery ?? `probe:${repo}`}:${crypto.randomUUID()}`;
    const admit = await withinDeliveryDeadline(
      webhookBreakerAdmission(store, project, now(), probeOwner),
      deliveryDeadline,
      now,
    );
    if (admit === DELIVERY_DEADLINE_EXPIRED)
      return { kind: "pending", pending: (payload.commits ?? []).map((c: any) => c.id), reason: "deadline" };
    if (admit === "pending") return { kind: "pending", pending: (payload.commits ?? []).map((c: any) => c.id), reason: "breaker_open" };
    probe = admit === "probe";
  }
  const inputs = await mapGithubWebhook(ghEvent, payload, { project, includePush: context.includePush, ingressAt, deliveryId: delivery && ghEvent !== "push" ? delivery : undefined });
  const results: GithubLoggedResult[] = [];
  const pendingShas: string[] = [];
  for (let inputIndex = 0; inputIndex < inputs.length; inputIndex++) {
    const input = inputs[inputIndex]!;
    const parsed = EventInput.safeParse(input);
    if (!parsed.success) { results.push({ error: parsed.error.issues }); continue; }
    const remainingShas = () => inputs.slice(inputIndex).map((candidate) => String(candidate.method?.params?.sha ?? "")).filter(Boolean);
    if (mode === "shadow" && isGitCommitSeal(parsed.data)) {
      if (now() >= deliveryDeadline) {
        if (isShadowPush) {
          await withinDeliveryDeadline(
            recordWebhookClassifyOutcome(store, project, "deadline", now(), probe),
            deliveryDeadline,
            now,
          );
        }
        return { kind: "pending", pending: remainingShas(), reason: "deadline" };
      }
      if (parsed.data.idempotency_key) {
        const prior = await withinDeliveryDeadline(
          store.byIdempotencyKey(project, parsed.data.idempotency_key),
          deliveryDeadline,
          now,
        );
        if (prior === DELIVERY_DEADLINE_EXPIRED)
          return { kind: "pending", pending: remainingShas(), reason: "deadline" };
        if (prior) { results.push({ id: prior.id, seq: prior.seq, deduped: true }); continue; }
      }
      const operationDeadline = Math.min(now() + CLASSIFY_DEADLINE_MS, deliveryDeadline);
      const classified = await withinDeliveryDeadline(
        classifyCommitClaim({
          store, input: parsed.data, producer: "github-push",
          sealedBy: SEALED_BY_GITHUB_WEBHOOK, trailerPolicy: mode, canonicalR: repo,
          authenticatedPrincipal: parsed.data.actor.on_behalf_of,
          deadline: operationDeadline,
          now,
        }),
        operationDeadline,
        now,
      );
      if (classified === DELIVERY_DEADLINE_EXPIRED) {
        if (isShadowPush) {
          await withinDeliveryDeadline(
            recordWebhookClassifyOutcome(store, project, "deadline", now(), probe),
            deliveryDeadline,
            now,
          );
        }
        return { kind: "pending", pending: remainingShas(), reason: "deadline" };
      }
      if (classified.kind === "unavailable") {
        if (isShadowPush) {
          const reason = classified.reason === "deadline" || classified.reason === "store_error" || classified.reason === "budget" ? classified.reason : "store_error";
          const recorded = await withinDeliveryDeadline(
            recordWebhookClassifyOutcome(store, project, reason, now(), probe),
            deliveryDeadline,
            now,
          );
          pendingShas.push(...remainingShas());
          return {
            kind: "pending",
            pending: [...new Set(pendingShas)].filter(Boolean),
            reason: recorded === DELIVERY_DEADLINE_EXPIRED ? "deadline" : classified.reason,
          };
        }
      }
      if (isShadowPush && (classified.kind === "decision" || classified.kind === "legacy")) {
        const recorded = await withinDeliveryDeadline(
          recordWebhookClassifyOutcome(store, project, "ok", now(), probe),
          deliveryDeadline,
          now,
        );
        if (recorded === DELIVERY_DEADLINE_EXPIRED)
          return { kind: "pending", pending: remainingShas(), reason: "deadline" };
        probe = false;
      }
      let toSeal = parsed.data;
      if (classified.kind === "decision") toSeal = attachClaimDecision(parsed.data, classified.record);
      const stamped = stampSealedBy(toSeal, SEALED_BY_GITHUB_WEBHOOK);
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await appendEvent(store, stamped, isShadowPush ? { deadline: deliveryDeadline, now } : {});
          results.push({ id: r.event.id, seq: r.event.seq, deduped: r.deduped });
          break;
        }
        catch (e: any) {
          if (e instanceof AppendDeadlineExceededError || e?.name === "AppendDeadlineExceededError")
            return { kind: "pending", pending: remainingShas(), reason: "deadline" };
          const client = writeClientError(e);
          if (client) return { kind: "client_error", error: client };
          if (!/UNIQUE/i.test(String(e?.message)) || attempt >= 4) throw e;
        }
      }
      continue;
    }
    const livePushCommit = isPushDelivery && mode !== "shadow" && isGitCommitSeal(parsed.data);
    if (livePushCommit && now() >= deliveryDeadline)
      return { kind: "pending", pending: remainingShas(), reason: "deadline" };
    const stamped = stampSealedBy(parsed.data, SEALED_BY_GITHUB_WEBHOOK);
    try {
      const r = await appendOwnerLoginEvent(store, stamped, currentPolicy, repo,
        (isPushDelivery || ownerLoginDelivery) ? deliveryDeadline : undefined, now);
      results.push({ id: r.event.id, seq: r.event.seq, deduped: r.deduped });
    } catch (e: any) {
      if (e instanceof AppendDeadlineExceededError || e?.name === "AppendDeadlineExceededError")
        return { kind: "pending", pending: remainingShas(), reason: "deadline" };
      const client = writeClientError(e);
      if (client) return { kind: "client_error", error: client };
      throw e;
    }
  }
  if ((isPushDelivery || ownerLoginDelivery) && store.deletePendingDelivery) {
    const deleted = await withinDeliveryDeadline(store.deletePendingDelivery(retainedDelivery), deliveryDeadline, now);
    if (deleted === DELIVERY_DEADLINE_EXPIRED)
      return { kind: "pending", pending: [], reason: "deadline" };
  }
  return { kind: "complete", logged: results };
}

/** Process one acquired lease; ownership-conditional persistence precedes cleanup.
 * No lease acquisition/renewal or receipt breaker work happens here. Unexpected
 * exceptions still reject the drain, including malformed serialized outcomes.
 */
export async function resume(
  store: EventStore, claim: ClaimedGithubDelivery, opts: GithubRetryContext,
): Promise<GithubRetryOutcome> {
  const { row, owner, until } = claim;
  const { now } = opts;
  let payload: unknown;
  try {
    payload = JSON.parse(row.raw_body);
  } catch {
    const terminal = { ...row, state: "terminal_failure", outcomes: JSON.stringify({ delivery: { status: "terminal_failure", reason: "malformed_payload", attempt_count: 0 } }) };
    if (store.updatePendingDeliveryIfLeaseOwner) await store.updatePendingDeliveryIfLeaseOwner(terminal, owner);
    return "failed";
  }
  const ghEvent = row.gh_event ?? "push";
  const inputs = await mapGithubWebhook(ghEvent, payload, { project: row.project, includePush: true, deliveryId: row.delivery_id, ingressAt: row.received_at });
  const outcomeKey = (input: EventInput) => ghEvent === "push"
    ? String(input.method?.params?.sha ?? "")
    : input.idempotency_key ? `idem:${input.idempotency_key}` : "";
  type Outcome = { status: "pending" | "sealed" | "budget_failed" | "invalid_input"; attempt_count: number; reason?: string };
  const terminalSha = (status: Outcome["status"] | undefined) => status === "sealed" || status === "budget_failed" || status === "invalid_input";
  const rawOutcomes: Record<string, string | Outcome> = row.outcomes ? JSON.parse(row.outcomes) as Record<string, string | Outcome> : {};
  const outcomes: Record<string, Outcome> = Object.fromEntries(Object.entries(rawOutcomes).map(([sha, value]) => [
    sha,
    typeof value === "string"
      ? { status: value === "sealed" ? "sealed" : value === "budget_failed" ? "budget_failed" : value === "invalid_input" ? "invalid_input" : "pending", attempt_count: value === "budget_failed" ? PENDING_BUDGET_ATTEMPTS : 0 }
      : value,
  ]));
  for (const input of inputs) {
    const parsed = EventInput.safeParse(input);
    if (!parsed.success) {
      const sha = outcomeKey(input);
      if (!sha || terminalSha(outcomes[sha]?.status)) continue;
      const artifactIssue = parsed.error.issues.some((issue) =>
        issue.path.includes("artifacts") || /artifact id/i.test(issue.message),
      );
      outcomes[sha] = {
        status: "invalid_input",
        attempt_count: outcomes[sha]?.attempt_count ?? 0,
        reason: artifactIssue ? "invalid_artifact" : "invalid_input",
      };
      continue;
    }
    const sha = outcomeKey(parsed.data);
    if (!sha || terminalSha(outcomes[sha]?.status)) continue;
    if (parsed.data.idempotency_key && await store.byIdempotencyKey(row.project, parsed.data.idempotency_key)) {
      outcomes[sha] = { status: "sealed", attempt_count: outcomes[sha]?.attempt_count ?? 0 };
      continue;
    }
    if (ghEvent !== "push") {
      const stamped = {
        ...parsed.data,
        method: { ...parsed.data.method, params: { ...parsed.data.method?.params,
          [SEALED_BY_PARAM]: SEALED_BY_GITHUB_WEBHOOK, producer_sig_verdict: "none" } },
      };
      try {
        const policy = store.getPolicy ? await store.getPolicy(row.project, { current: true }) : null;
        await appendOwnerLoginEvent(store, stamped, policy, row.repo ?? "", now() + WEBHOOK_DELIVERY_DEADLINE_MS, now);
      } catch (e) {
        if (!(e instanceof AppendDeadlineExceededError)) throw e;
        outcomes[sha] = { status: "pending", attempt_count: outcomes[sha]?.attempt_count ?? 0, reason: "deadline" };
        continue;
      }
      outcomes[sha] = { status: "sealed", attempt_count: outcomes[sha]?.attempt_count ?? 0 };
      continue;
    }
    const classified = await classifyCommitClaim({
      store, input: parsed.data, producer: "github-push",
      sealedBy: SEALED_BY_GITHUB_WEBHOOK, trailerPolicy: opts.trailerPolicy, canonicalR: row.repo,
      authenticatedPrincipal: parsed.data.actor.on_behalf_of,
    });
    if (classified.kind === "unavailable") {
      const attemptCount = outcomes[sha]?.attempt_count ?? 0;
      if (classified.reason === "budget") {
        const nextAttempts = attemptCount + 1;
        outcomes[sha] = nextAttempts >= PENDING_BUDGET_ATTEMPTS
          ? { status: "budget_failed", attempt_count: nextAttempts, reason: "budget" }
          : { status: "pending", attempt_count: nextAttempts, reason: "budget" };
      } else {
        outcomes[sha] = { status: "pending", attempt_count: attemptCount, reason: classified.reason };
      }
      continue;
    }
    if (classified.kind === "skip" && classified.reason === "policy_off") {
      const stamped = {
        ...parsed.data,
        method: { ...parsed.data.method, params: { ...parsed.data.method?.params,
          [SEALED_BY_PARAM]: SEALED_BY_GITHUB_WEBHOOK, [PRODUCER_SIG_VERDICT_PARAM]: "none" } },
      };
      await appendEvent(store, stamped);
      outcomes[sha] = { status: "sealed", attempt_count: outcomes[sha]?.attempt_count ?? 0 };
      continue;
    }
    if (classified.kind === "decision" || classified.kind === "legacy") {
      const withDecision = classified.kind === "decision" ? attachClaimDecision(parsed.data, classified.record) : parsed.data;
      const stamped = {
        ...withDecision,
        method: { ...withDecision.method, params: { ...withDecision.method?.params, [SEALED_BY_PARAM]: SEALED_BY_GITHUB_WEBHOOK } },
      };
      await appendEvent(store, stamped);
      outcomes[sha] = { status: "sealed", attempt_count: outcomes[sha]?.attempt_count ?? 0 };
    } else {
      outcomes[sha] = { status: "pending", attempt_count: outcomes[sha]?.attempt_count ?? 0, reason: classified.reason };
    }
  }
  const shas = inputs.map(outcomeKey).filter(Boolean);
  const allSealed = shas.length > 0 && shas.every((sha) => outcomes[sha]?.status === "sealed");
  const terminal = shas.some((sha) => outcomes[sha]?.status === "budget_failed" || outcomes[sha]?.status === "invalid_input");
  const next = {
    ...row,
    outcomes: JSON.stringify(outcomes),
    lease_owner: allSealed ? owner : undefined,
    lease_until: allSealed ? until : undefined,
    state: allSealed ? "done" : terminal && shas.every((sha) => outcomes[sha]?.status !== "pending") ? "terminal_failure" : row.state,
  };
  const saved = store.updatePendingDeliveryIfLeaseOwner
    ? await store.updatePendingDeliveryIfLeaseOwner(next, owner)
    : false;
  if (!saved) {
    return "failed";
  }
  if (allSealed) {
    if (store.deletePendingDelivery) await store.deletePendingDelivery(row.delivery_id);
    return "drained";
  }
  return "failed";
}
