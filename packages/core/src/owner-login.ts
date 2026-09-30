/** Content-bound testimony for shared GitHub accounts (owner-login/1). */
import { Actor, Event, EventInput, GENESIS_HASH, assertEventArtifactIds } from "./schema.js";
import { PolicyDocument, POLICY_PROFILE_V2 } from "./policy.js";
import { ArtifactIndexQuery, ChainHead, EventStore, appendEvent, appendReadWithinDeadline, artifactIndexRows } from "./store.js";
import { evaluateAmendmentsAtU, OWNER_LOGIN_DEADLINE_MS } from "./classify.js";
import { sameArtifact } from "./capture.js";

export * from "./owner-login-record.js";
import { OWNER_LOGIN_DECISION_PARAM, OWNER_LOGIN_ROW_CAP, OWNER_LOGIN_WINDOW_MS, OwnerLoginKind, OwnerLoginFailure,
  GithubPayload, OwnerLoginRecord, OwnerLoginArgs, OwnerLoginResult, ownerLoginRecord } from "./owner-login-record.js";
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export function ownerLoginKind(input: EventInput): OwnerLoginKind | null {
  if (input.method?.tool === "github-review") return "review";
  if (input.method?.tool === "github-comment") return "comment";
  if (input.method?.tool !== "github") return null;
  switch (input.method.params?.action) {
    case "opened": case "reopened": return "pr_open";
    case "edited": return "pr_edit";
    case "synchronize": return "push";
    case "closed": return input.action === "merged" ? "merge" : null;
    default: return null;
  }
}
export function ownerLoginPr(input: EventInput, repo: string): number | undefined {
  const prefix = `pr:${repo}#`;
  const id = input.artifacts.find(a => a.id.startsWith(prefix))?.id.slice(prefix.length);
  return id && /^\d+$/.test(id) ? Number(id) : undefined;
}
export function declarationProject(e: Event, input: EventInput): boolean { return e.project === input.project; }
export function declarationPinned(e: Event): boolean {
  return typeof e.method?.params?.sealed_by === "string" && e.method.params.sealed_by.startsWith("pinned:") && e.method.params.producer_sig_verdict === "verified";
}
export function declarationAgent(e: Event): boolean { return e.actor.type === "agent"; }
export function declarationUnamended(e: Event, amended: ReadonlySet<string>): boolean { return e.action_detail !== "amended" && !amended.has(e.id); }
export function declarationAction(e: Event): Record<string, unknown> | undefined {
  const a = object(e.method?.params?.github_action);
  return a && !Object.hasOwn(a, "result") ? a : undefined;
}
export function declarationWindow(e: Event, ingress: number, head: number): boolean {
  const receipt = Date.parse(e.received_at ?? "");
  return e.seq <= head && Number.isFinite(receipt) && receipt >= ingress - OWNER_LOGIN_WINDOW_MS && receipt <= ingress;
}
export function declarationUnconsumed(e: Event, consumed: ReadonlySet<string>): boolean { return !consumed.has(e.id); }
export function normaliseGithubAction(a: Record<string, unknown>): Record<string, unknown> {
  const states: Record<string, string> = { comment: "commented", commented: "commented", approve: "approved", approved: "approved", request_changes: "changes_requested", changes_requested: "changes_requested" };
  const state = a.review_state ?? a.state;
  return { ...a, head_sha: a.head_sha ?? a.commit_id,
    review_state: typeof state === "string" ? states[state.toLowerCase()] : undefined };
}
export function declarationTarget(e: Event, a: Record<string, unknown>, kind: OwnerLoginKind, repo: string, pr: number | undefined, payload: GithubPayload): boolean {
  return a.repo === repo && typeof a.login === "string" && a.login.toLowerCase() === payload.login?.toLowerCase() && a.kind === kind &&
    (kind === "pr_open" ? typeof payload.branch === "string" && e.artifacts.some(art => art.id === `git:${repo}#${payload.branch}`) : pr !== undefined && a.pr === pr);
}
const CONTENT_FIELDS: Record<OwnerLoginKind, string[]> = {
  comment: ["body_sha256"], review: ["body_sha256", "review_state", "head_sha"],
  pr_open: ["body_sha256", "title_sha256", "head_sha"], pr_edit: ["body_sha256", "title_sha256"],
  push: ["head_sha"], merge: ["merge_commit_sha"],
};
export function declarationContent(a: Record<string, unknown>, kind: OwnerLoginKind, payload: GithubPayload): boolean {
  const normalized = normaliseGithubAction(a);
  return CONTENT_FIELDS[kind].every(field => typeof normalized[field] === "string" && normalized[field] !== "" && normalized[field] === payload[field]);
}
export function ownerLoginAccount(login: string): Actor { return { type: "system", id: `github:${login}`, display_name: `${login} (GitHub account, shared)` }; }
export function attachOwnerLoginDecision(input: EventInput, record: OwnerLoginRecord): EventInput {
  return { ...input, actor: record.decision.actor_written, method: { ...input.method, params: { ...input.method?.params, [OWNER_LOGIN_DECISION_PARAM]: record } } };
}
export function ownerLoginAllocationFailed(input: EventInput, consumedBy: string | null): EventInput {
  const record = ownerLoginRecord(input)!;
  return attachOwnerLoginDecision(input, { ...record, decision: { ...record.decision, status: "unresolved", reason: "allocation_failed",
    allocation: { attempts: 2, read_head_seq: record.decision.context.read_head_seq, consumed_by: consumedBy },
    actor_written: ownerLoginAccount(record.login), evidence_level: null, declarations: [], consumed: [], received: { webhook: null, declaration: null } } });
}

/** Shared aggregate budget across candidates, consumption, amendment candidates, dependencies and capture reads. */
class EvidenceBudget {
  remaining = OWNER_LOGIN_ROW_CAP;
  failure?: OwnerLoginFailure;
  constructor(readonly deadline: number, readonly now: () => number) {}
  fail(reason: OwnerLoginFailure): never { this.failure = reason; throw new Error(`owner-login ${reason}`); }
  check() { if (this.now() >= this.deadline) this.fail("deadline"); }
  take(n: number) { this.check(); if (n > this.remaining) this.fail("budget"); this.remaining -= n; }
  async read<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.failure = "deadline"; reject(new Error("owner-login deadline")); }, Math.max(0, this.deadline - this.now()));
      })]);
      this.check(); return result;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  indexedRows(events: Event[], q: ArtifactIndexQuery): number {
    return events.reduce((n, e) => n + artifactIndexRows(e).filter(row => q.artifact_keys.some(key => sameArtifact(key, row.artifact_key)) || q.artifact_prefixes?.some(prefix => row.artifact_key.startsWith(prefix))).length, 0);
  }
  /** Wrap the existing bounded amendment evaluator, retaining its full semantics and failing closed. */
  wrap(store: EventStore): EventStore {
    return new Proxy(store, { get: (target, property) => {
      if (property === "amendmentEventsUpTo" && target.amendmentEventsUpTo) return async (p: string, u: number, limit: number) => {
        const rows = await this.read(() => target.amendmentEventsUpTo!(p, u, Math.min(limit, this.remaining + 1)));
        this.take(rows.length); return rows;
      };
      if (property === "getMany" && target.getMany) return async (ids: string[]) => {
        this.take(ids.length); return this.read(() => target.getMany!(ids));
      };
      if (property === "get") return async (id: string) => { this.take(1); return this.read(() => target.get(id)); };
      if (property === "eventsReferencingArtifacts" && target.eventsReferencingArtifacts) return async (q: ArtifactIndexQuery) => {
        if (this.remaining < 1) this.fail("budget");
        const rows = await this.read(() => target.eventsReferencingArtifacts!({ ...q, row_cap: Math.min(q.row_cap, this.remaining), deadline: Math.min(q.deadline, this.deadline) }, this.now));
        if (!rows.ok) this.fail(rows.reason);
        this.take(this.indexedRows(rows.events, q)); return rows;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
}

export async function classifyOwnerLogin(args: OwnerLoginArgs): Promise<OwnerLoginResult> {
  const now = args.now ?? Date.now, started = now();
  const payload = object(args.input.method?.params?.github_payload) as GithubPayload | undefined;
  if (args.policy.body.profile !== POLICY_PROFILE_V2 || !payload || typeof payload.login !== "string") return { kind: "not_applicable" };
  const login = payload.login;
  const config = args.policy.body.github;
  const mapped = Object.entries(config?.identities ?? {}).find(([key]) => key.toLowerCase() === login.toLowerCase())?.[1];
  const shared = config?.shared_logins.some(key => key.toLowerCase() === login.toLowerCase()) ?? false;
  if (!mapped && !shared) return { kind: "not_applicable" };
  const ingress = Date.parse(payload.ingress_at ?? "");
  const kind = ownerLoginKind(args.input);
  const record: OwnerLoginRecord = { policy: "owner-login/1", observer: { producer: "github-webhook", sealed_by: "webhook:github" }, login, shared,
    payload: { ...payload }, decision: { status: "unresolved", reason: "no_declaration", kind,
      actor_written: ownerLoginAccount(login), evidence_level: null, declarations: [], proximity_hints: 0,
      context: { read_head_seq: args.readHead.seq, read_head_hash: args.readHead.hash, policy_digest: args.policy.digest },
      window: { from: Number.isFinite(ingress) ? new Date(ingress - OWNER_LOGIN_WINDOW_MS).toISOString() : null, to: payload.ingress_at ?? null, basis: "ingress_at" },
      received: { webhook: null, declaration: null }, consumed: [], ingress_at: payload.ingress_at ?? null, classification_ms: 0,
      timing: { pre_ms: args.preMs ?? null, candidates_ms: null, consumption_ms: null, amendments_ms: null, filter_ms: null,
        stage_failed: null, candidates_rows: null, budget_rows_remaining: null, deadline_ms: args.deadline - started } } };
  const finish = (): OwnerLoginResult => {
    record.decision.classification_ms = Math.max(0, now() - started);
    return { kind: "decision", input: attachOwnerLoginDecision(args.input, record), consume: record.decision.consumed };
  };
  if (mapped) {
    Object.assign(record.decision, { status: "identity_mapped", reason: null, actor_written: { type: "agent", id: mapped }, evidence_level: "identity_mapped" });
    return finish();
  }
  if (!kind) return finish();
  const budget: EvidenceBudget = new EvidenceBudget(args.deadline, now);
  const timing = record.decision.timing;
  type Stage = NonNullable<typeof timing.stage_failed>;
  type TimedStage = Exclude<Stage, "setup" | "final_check">;
  let stage: Stage = "setup";
  let openStage: { name: TimedStage; started: number } | undefined;
  const endStage = () => {
    if (!openStage) return;
    const key = `${openStage.name}_ms` as const;
    timing[key] = (timing[key] ?? 0) + Math.max(0, now() - openStage.started);
    openStage = undefined;
  };
  const beginStage = (next: TimedStage) => { stage = next; openStage = { name: next, started: now() }; };
  try {
    if (!Number.isFinite(ingress)) budget.fail("store_error");
    const store = budget.wrap(args.store);
    if (!store.eventsReferencingArtifacts || !store.ownerLoginConsumptionUpTo) budget.fail("store_error");
    const pr = ownerLoginPr(args.input, args.canonicalR);
    const keys = [ ...(pr !== undefined ? [`pr:${args.canonicalR}#${pr}`] : []),
      ...(typeof payload.branch === "string" ? [`git:${args.canonicalR}#${payload.branch}`] : []),
      ...(typeof payload.head_sha === "string" ? [`commit:${args.canonicalR}@${payload.head_sha.slice(0, 12)}`] : []) ];
    beginStage("candidates");
    const candidates = await store.eventsReferencingArtifacts!({ project: args.input.project, artifact_keys: keys, after_seq: -1,
      through_seq: args.readHead.seq, row_cap: budget.remaining, deadline: args.deadline }, now);
    if (!candidates.ok) budget.fail(candidates.reason);
    timing.candidates_rows = candidates.events.length;
    endStage();
    beginStage("filter");
    const eligibleTime = candidates.events.filter(e => declarationProject(e, args.input) && declarationWindow(e, ingress, args.readHead.seq));
    endStage();
    beginStage("consumption");
    const rows = await budget.read(() => store.ownerLoginConsumptionUpTo!(args.input.project, eligibleTime.map(e => e.id), args.readHead.seq, { deadline: args.deadline, row_cap: budget.remaining }));
    if (!rows.ok) budget.fail(rows.reason);
    budget.take(rows.rows.length);
    const consumed = new Set(rows.rows.map(row => row.declaration_event_id));
    endStage();
    beginStage("amendments");
    const amended = await evaluateAmendmentsAtU({ store, project: args.input.project, U: args.readHead.seq, headHash: args.readHead.hash,
      policy: args.policy.body, policyDigest: args.policy.digest, canonicalRepo: args.canonicalR, captureEvents: candidates.events,
      coveredArtifactKeys: keys, deadline: args.deadline, now });
    if (!amended.ok) budget.fail(budget.failure ?? amended.reason);
    endStage();
    beginStage("filter");
    const amendments = new Set(amended.collection.effective.keys());
    // Webhook observations are never declaration candidates or proximity testimony.
    const available = eligibleTime.filter(e => e.method?.params?.sealed_by !== "webhook:github" && declarationUnconsumed(e, consumed));
    const eligible = available.filter(e => declarationPinned(e) && declarationAgent(e) && declarationUnamended(e, amendments) &&
      !!declarationAction(e) && declarationTarget(e, declarationAction(e)!, kind, args.canonicalR, pr, payload) && declarationContent(declarationAction(e)!, kind, payload))
      .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
    record.decision.proximity_hints = available.length - eligible.length;
    const seats = new Set(eligible.map(e => e.actor.id));
    const selected = seats.size === 1 ? eligible.slice(0, 1) : eligible;
    record.decision.declarations = selected.map(e => ({ id: e.id, seq: e.seq, actor: e.actor,
      sealed_by: e.method!.params!.sealed_by as string, producer_sig_verdict: "verified" }));
    if (seats.size === 1) {
      const e = selected[0];
      Object.assign(record.decision, { status: "declared_by_seat", reason: null, evidence_level: "declaration_only",
        actor_written: { type: "agent", id: e.actor.id, ...(e.actor.on_behalf_of ? { on_behalf_of: e.actor.on_behalf_of } : {}) },
        consumed: [e.id], received: { webhook: null, declaration: e.received_at ?? null } });
    } else if (seats.size > 1) Object.assign(record.decision, { status: "conflicting", reason: "multiple_declarers" });
    else record.decision.reason = available.length ? "proximity_only" : "no_declaration";
    endStage();
    stage = "final_check";
    budget.check();
  } catch {
    endStage();
    timing.stage_failed = stage;
    Object.assign(record.decision, { status: "unavailable", reason: budget.failure ?? "store_error", actor_written: ownerLoginAccount(login),
      evidence_level: null, declarations: [], consumed: [], received: { webhook: null, declaration: null } });
  }
  timing.budget_rows_remaining = budget.remaining;
  return finish();
}

/** Shared ingress/drain append path, with exactly one reclassification on allocation loss. */
export async function appendOwnerLoginEvent(store: EventStore, input: EventInput, policy: PolicyDocument | null,
  canonicalR: string, deliveryDeadline?: number, now: () => number = Date.now) {
  // Validate new input before classification; read-only replay still accepts historical sealed events.
  assertEventArtifactIds(input);
  const opts = deliveryDeadline === undefined ? { now } : { deadline: deliveryDeadline, now };
  let failures = 0;
  let classified = await classify();
  let toSeal = classified.kind === "decision" ? classified.input : input;
  let consume = classified.kind === "decision" ? classified.consume : [];
  async function classify() {
    const preStarted = now();
    const readHead = await appendReadWithinDeadline(() => store.head(input.project), opts) ?? { seq: -1, hash: GENESIS_HASH };
    // A policy may activate between routing and classification. Select through this U, never at a later head.
    const selectedPolicy = store.getPolicyByActivationSeq
      ? await appendReadWithinDeadline(() => store.getPolicyByActivationSeq!(input.project, readHead.seq), opts) ?? policy : policy;
    const preMs = Math.max(0, now() - preStarted);
    return selectedPolicy ? classifyOwnerLogin({ store, input, policy: selectedPolicy, canonicalR, readHead, preMs,
      deadline: Math.min(now() + OWNER_LOGIN_DEADLINE_MS, deliveryDeadline ?? Infinity), now }) : { kind: "not_applicable" as const };
  }
  for (let seqAttempt = 0; ; ) {
    const payload = object(input.method?.params?.github_payload);
    const extras = { owner_login_consumption: consume.map(declaration_event_id => ({ declaration_event_id,
      ...(typeof payload?.delivery === "string" ? { consumed_by_delivery: payload.delivery } : {}) })) };
    try { return await appendEvent(store, toSeal, { ...opts, extras }); }
    catch (e) {
      // D1 may wrap SQLite's error. Name AND constraint type are required; arbitrary store failures never retry.
      if (/UNIQUE constraint failed:.*owner_login_consumption/i.test(String(e)) && consume.length) {
        failures++;
        if (failures === 1) {
          classified = await classify();
          toSeal = classified.kind === "decision" ? classified.input : input;
          consume = classified.kind === "decision" ? classified.consume : [];
        } else {
          const row = store.ownerLoginConsumptionRow
            ? await appendReadWithinDeadline(() => store.ownerLoginConsumptionRow!(input.project, consume[0]), opts) : null;
          toSeal = ownerLoginAllocationFailed(toSeal, row?.consumed_by_event_id ?? null);
          consume = [];
        }
        seqAttempt = 0;
        continue;
      }
      if (/owner_login_consumption/i.test(String(e)) || !/UNIQUE/i.test(String(e)) || seqAttempt++ >= 4) throw e;
    }
  }
}
