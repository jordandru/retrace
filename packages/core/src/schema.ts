/**
 * Retrace core schema — the six dimensions of provenance:
 * WHO (actor) · WHAT (action + artifacts + change) · WHEN (timestamp/seq)
 * WHERE (location) · WHY (intent + caused_by) · HOW (method)
 * plus integrity (hash chain).
 *
 * Deliberately close to W3C PROV (Agent / Activity / Entity) so we can export later.
 */
import { z } from "zod";

/** WHEN carries at most millisecond precision (issue #131). Every store orders `since`/`until` by the instant a
 *  timestamp names; the memory store parses it and SQLite renders it with `strftime('%f')`, which computes in floating
 *  point and can round an exact half-millisecond the other way. Rather than imitate that arithmetic, the contract
 *  excludes the input: a timestamp or cursor with more than three fractional second digits is refused at append and at
 *  query, so both sides see only values they render identically. The live ledger held 0 such rows in 16913 at
 *  2026-10-10 (coordinator scan). */
export const TIMESTAMP_MAX_FRACTION_DIGITS = 3;
/** Fractional second digits of an ISO 8601 timestamp (`.123Z` → 3, `.1234-06:00` → 4, no fraction → 0). */
export function timestampFractionDigits(s: string): number {
  const m = /\.(\d+)(?=(?:Z|[+-]\d{2}:?\d{2})?$)/.exec(s);
  return m ? m[1]!.length : 0;
}
/** The timestamp grammar every store agrees on (issue #131, round 3). `YYYY-MM-DDTHH:MM:SS[.SSS]` then `Z` or `±HH:MM`:
 *  a real calendar instant, millisecond precision, colon offset. Anything else is refused at append. The grammar is
 *  stated rather than inherited from a parser because the parsers disagree at the edges: zod's `datetime({ offset })`
 *  and `Date.parse` accept a compact `+0530`, SQLite's `strftime` does not (Codex, round 3, 2026-10-10); SQLite reads a
 *  bare number as a Julian day and the word `now` as the clock, `Date.parse` does not. The live ledger's 16913 rows all
 *  fit this grammar (scan 2026-10-10: `.SSSZ`, `Z`, `-HH:MM`, `.SSS-HH:MM`). */
export const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
/** The wider grammar a history cursor may use: the timestamp grammar, or a zone-less date or date-time
 *  (`2026-01-01`, `2026-01-01T00:00`, `2026-01-01 00:00:00.5`), which SQLite and this code both read as UTC. */
export const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;
/** The UTC instant (`YYYY-MM-DDTHH:MM:SS.SSSZ`) a text in `INSTANT_RE` names, computed from its fields, not by
 *  `Date.parse`; `undefined` for text outside the grammar or naming no real calendar instant (`2026-02-30`, `24:00`,
 *  an offset past `±14:59`). This is what SQLite's `strftime('%Y-%m-%dT%H:%M:%fZ', x)` renders for the same text, so the
 *  memory store and the SQL stores order every accepted value identically (`TIMESTAMP_INSTANT_SQL`). */
/** The largest offset hour SQLite's date parser accepts (`±14:59` parses, `±15:00` does not); the grammar stops there too. */
export const TIMESTAMP_OFFSET_MAX_HOURS = 14;
export function instantFromText(s: string): string | undefined {
  const m = INSTANT_RE.exec(s);
  if (!m) return undefined;
  const [, Y, Mo, D, h = "00", mi = "00", sec = "00", frac = "", zone = "Z"] = m;
  const y = Number(Y), mo = Number(Mo), d = Number(D), hh = Number(h), mm = Number(mi), ss = Number(sec);
  const ms = Number((frac + "000").slice(0, 3));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return undefined;
  const probe = new Date(0);
  probe.setUTCFullYear(y, mo - 1, d); // not Date.UTC: it reads a year below 100 as 19xx
  probe.setUTCHours(hh, mm, ss, ms);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return undefined;
  let t = probe.getTime();
  if (zone !== "Z") {
    const oh = Number(zone.slice(1, 3)), om = Number(zone.slice(4, 6));
    // SQLite parses an offset only up to hour 14 (any minutes; +14:59 yes, +15:00 NULL): the same bound here, so no
    // accepted offset is normalized on one side and compared by bytes on the other (Codex, round 4, 2026-10-10)
    if (oh > TIMESTAMP_OFFSET_MAX_HOURS || om > 59) return undefined;
    t -= (zone[0] === "-" ? -1 : 1) * (oh * 60 + om) * 60_000;
  }
  return new Date(t).toISOString();
}
/** An event timestamp: `TIMESTAMP_RE` and a real calendar instant. zod's own datetime check stays underneath. */
export const Timestamp = z.string().datetime({ offset: true }).refine(
  (s) => TIMESTAMP_RE.test(s) && instantFromText(s) !== undefined,
  { message: `timestamp is YYYY-MM-DDTHH:MM:SS[.SSS] followed by Z or ±HH:MM: a real calendar instant, millisecond precision (at most ${TIMESTAMP_MAX_FRACTION_DIGITS} fractional digits), colon offset within ±${TIMESTAMP_OFFSET_MAX_HOURS}:59` },
);

export const ActorType = z.enum(["human", "agent", "system"]);
export type ActorType = z.infer<typeof ActorType>;

export const ModelSource = z.enum([
  "harness-runtime",
  "harness-config",
  "harness-display",
  "credential-pinned",
  "operator-stated",
  "self-report",
  "none",
]);
export type ModelSource = z.infer<typeof ModelSource>;

/** A second model claim. `source` is optional so a displaced legacy value that carried none can still be recorded. */
export const ModelClaim = z.object({
  value: z.string().min(1),
  source: ModelSource.optional(),
  note: z.string().optional(),
});
export type ModelClaim = z.infer<typeof ModelClaim>;

/** Empty-string `model` is absent for the presence-based pairing rule (model-source §4.1 Low, step 3). */
function actorModelPresent(model: string | undefined): boolean {
  return model !== undefined && model !== "";
}

function actorModelSourceConsistent(actor: { model?: string; model_source?: ModelSource }): boolean {
  if (actor.model_source === "none") return !actorModelPresent(actor.model);
  if (actor.model_source !== undefined) return actorModelPresent(actor.model);
  return true;
}

const actorObject = z.object({
  type: ActorType,
  /** Stable identifier: email, agent name, service id */
  id: z.string().min(1),
  display_name: z.string().optional(),
  /** For agents: model + version that performed the action */
  model: z.string().optional(),
  version: z.string().optional(),
  /** Delegation: an agent acting for a human, or a sub-agent for a parent agent */
  on_behalf_of: z.string().optional(),
  /** How `model` was obtained. Absent on legacy events; after adoption, omission is a producer defect. */
  model_source: ModelSource.optional(),
  /** Other model values the producer holds; a pin that replaces `model` pushes the displaced pair here. */
  model_claims: z.array(ModelClaim).optional(),
});

export const Actor = actorObject.refine(actorModelSourceConsistent, {
  message: "model_source other than none requires model; model_source none requires model absent",
  path: ["model_source"],
});
export type Actor = z.infer<typeof actorObject>;

/** Small controlled verb vocabulary. `other` requires `action_detail`. */
export const Action = z.enum([
  "created",
  "edited",
  "deleted",
  "read",
  "executed",
  "approved",
  "rejected",
  "sent",
  "received",
  "moved",
  "renamed",
  "instructed",
  "committed",
  "merged",
  "other",
]);
export type Action = z.infer<typeof Action>;

/**
 * PROV role of an artifact within an event: was it an input the activity `used`, an output it `generated`, or `both`
 * (read then rewritten). Optional — absence means "unspecified" and is a legal, permanent state: events sealed before
 * this field existed are never backfilled or re-hashed (absence is information).
 *   Export mapping (for a future prov exporter): used → prov:used (Activity→Entity), generated → prov:wasGeneratedBy
 *   (Entity→Activity), both → both edges, absent → degrades to prov:wasInfluencedBy.
 *   Distinct from `derived_from`, which is Entity→Entity (prov:wasDerivedFrom) and unchanged. Invalidation (a deleted
 *   artifact, prov:wasInvalidatedBy) is deliberately NOT a role — a deleted ref stays absent until that is a first-class edge.
 */
export const ArtifactRole = z.enum(["used", "generated", "both"]);
export type ArtifactRole = z.infer<typeof ArtifactRole>;

/** Well-formed UTF-16: every high surrogate is paired with a low surrogate, and no low surrogate stands alone. */
export function isWellFormedUtf16(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length) return false;
      const n = s.charCodeAt(i + 1);
      if (n < 0xdc00 || n > 0xdfff) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Why `id` is not an accepted artifact id, or `undefined` if it is. Empty, U+0000, and unpaired surrogates. */
export function artifactIdProblem(id: string): string | undefined {
  if (typeof id !== "string" || id.length < 1) return "artifact id must be a non-empty string";
  if (id.includes("\u0000")) return "artifact id must not contain U+0000";
  if (!isWellFormedUtf16(id)) return "artifact id must be well-formed Unicode (no unpaired surrogates)";
}

export class InvalidArtifactIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArtifactIdError";
  }
}

/** Fail closed: refuse the id. Never sanitize, coerce, or replace lone surrogates / NUL. */
export function assertArtifactId(id: string): void {
  const problem = artifactIdProblem(id);
  if (problem) throw new InvalidArtifactIdError(problem);
}

export function assertEventArtifactIds(input: { artifacts: { id: string; derived_from?: string[] }[] }): void {
  for (const a of input.artifacts) {
    assertArtifactId(a.id);
    for (const d of a.derived_from ?? []) assertArtifactId(d);
  }
}

export const ArtifactId = z.string().min(1).superRefine((id, ctx) => {
  const problem = artifactIdProblem(id);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
});

export const ArtifactRef = z.object({
  /** Stable id for the thing being worked on, e.g. "repo:my-app#src/main.ts" or "doc:abc123" */
  id: ArtifactId,
  kind: z.string().optional(), // file, doc, dataset, pr, message, decision, ...
  label: z.string().optional(),
  /** Lineage: this artifact was derived from these */
  derived_from: z.array(ArtifactId).optional(),
  /** PROV: input (used) / output (generated) / both. Body-only, hash-covered on new events; see ArtifactRole. */
  role: ArtifactRole.optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

/**
 * Default role of an artifact ref for an action verb, for when the caller says nothing. `undefined` = leave absent.
 *   read → used · created/committed/merged → generated · edited/moved/renamed → both (the prior state is read, the new
 *   one written) · executed/sent/received/approved/rejected → used (the thing run/sent/reviewed was an input; an OUTPUT
 *   such as a deployment or report must be said by the caller) · deleted/instructed/other → absent.
 * Adapters stamp what they authoritatively know and only fall back to this where the verb alone is the truth.
 */
export function defaultArtifactRole(action: Action): ArtifactRole | undefined {
  switch (action) {
    case "read": return "used";
    case "created": case "committed": case "merged": return "generated";
    case "edited": case "moved": case "renamed": return "both";
    case "executed": case "sent": case "received": case "approved": case "rejected": return "used";
    default: return undefined; // deleted, instructed, other
  }
}

/** Fill `role` from defaultArtifactRole ONLY where a ref has none — a caller-supplied role is never overwritten. Refs
 *  that get no default come back as they were (no `role` key, so hashes of role-less inputs are unaffected). */
export function applyDefaultRoles<T extends ArtifactRef>(action: Action, artifacts: T[]): T[] {
  const def = defaultArtifactRole(action);
  return artifacts.map((a) => (a.role !== undefined || def === undefined ? a : { ...a, role: def }));
}

export const Change = z.object({
  before_hash: z.string().optional(),
  after_hash: z.string().optional(),
  diff: z.string().optional(),
  summary: z.string().optional(),
});

export const Location = z.object({
  /** repo path, doc section, URL, table, etc. */
  path: z.string().optional(),
  url: z.string().optional(),
  environment: z.string().optional(), // prod, staging, local, ...
  device: z.string().optional(),
  system: z.string().optional(), // github, gdocs, cursor, claude-code, ...
  /** Run/session id of the producing process (backlog #15; body-only, like every location field). On the MCP path
   *  this is the harness's own session id when it exposes one (CLAUDE_CODE_SESSION_ID or GROK_SESSION_ID), so the same string appears on
   *  events from the agent AND on the commits it drives. It is a *session* key — subagents share it — not a per-run id. */
  session: z.string().optional(),
  /** The MCP client that drove the write, verbatim from the `initialize` handshake as "<name>@<version>" — e.g.
   *  "claude-code@2.1.250", "cursor-vscode@1.7.3". Server-stamped only: it is evidence ABOUT the writer, so the
   *  writer may not assert it (see SERVER_ONLY in the MCP server). */
  client: z.string().optional(),
  /** IDE / agent-development environment hosting the actor, e.g. "orca". Deliberately distinct from `system` (the tool
   *  that produced the event, "claude-code") and from `client` (which build of it): the IDE is the app AROUND both, and
   *  neither of the other two can express it. Only stamped when the IDE identifies itself in the environment. */
  ide: z.string().optional(),
  /** Isolated workspace within `ide` — an Orca worktree id, a codespace or devcontainer name. This is what tells two
   *  parallel agents apart when they run the same project, on the same host, as the same actor. */
  workspace: z.string().optional(),
  /** Whether the producing process had a controlling terminal: "tty" = a human at a keyboard, "agent" = spawned by a
   *  harness with none. Linux-only today (read from /proc/self/stat); absent everywhere else, and absence is a legal
   *  permanent state. EVIDENCE, never authority — it must not override the actor determination. */
  surface: z.enum(["tty", "agent"]).optional(),
});
export type Location = z.infer<typeof Location>;

export const MethodParams = z.object({
  /** Self-reported by a review agent from the configuration it actually ran with. */
  reasoning_effort: z.string().min(1).optional(),
  /** Routing decision this review fulfils. */
  routing_event_id: z.string().min(1).optional(),
}).catchall(z.unknown());
export type MethodParams = z.infer<typeof MethodParams>;

export const Method = z.object({
  tool: z.string().optional(), // e.g. "Edit", "git commit", "gdocs-ui"
  /** Reference to instruction/prompt that drove this (id, hash, or short text) */
  instruction: z.string().optional(),
  params: MethodParams.optional(),
  automated: z.boolean().optional(),
  tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
});

/** What a client submits. Server fills in id/seq/hash/prev_hash. */
export const EventInput = z.object({
  project: z.string().min(1),
  actor: Actor,
  action: Action,
  action_detail: z.string().optional(),
  artifacts: z.array(ArtifactRef).min(1),
  change: Change.optional(),
  timestamp: Timestamp.optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  location: Location.optional(),
  /** WHY — free text reason */
  intent: z.string().optional(),
  /** WHY — causal parent (event id). The instruction that led to this action. */
  caused_by: z.string().optional(),
  method: Method.optional(),
  /** Client-provided idempotency key */
  idempotency_key: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** Rung 5: the producer's Ed25519 signature over an explicit payload (producer-sig.ts) made with a key the server
   *  never holds. A top-level field, so the v2 hash seals it — stripping it after the seal breaks the chain. */
  producer_sig: z.object({
    kid: z.string().min(8),
    sig: z.string().min(40),
    /** Absent means retrace-producer-sig/1. Unknown values fail closed at verify, not at parse. */
    format: z.string().min(1).optional(),
  }).optional(),
});
export type EventInput = z.infer<typeof EventInput>;

export const Event = EventInput.extend({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  timestamp: Timestamp,
  prev_hash: z.string(),
  hash: z.string(),
  received_at: Timestamp,
  /** Hash rule the seal used. 2 = the digest covers `received_at` and this field; absent = legacy seal (pre-2026-08-30),
   *  whose digest may or may not cover `received_at`. Covered by the hash, so it cannot be stripped to downgrade a verifier. */
  hash_v: z.literal(2).optional(),
});
export type Event = z.infer<typeof Event>;

/**
 * The schema surface a build understands, derived from the zod shapes themselves so it can never drift from the code.
 *
 * This exists because the failure it detects is SILENT: `POST /events` re-parses with `EventInput.safeParse`, and zod
 * strips keys it does not know, so a producer running newer code than the deployment loses those fields with no error
 * anywhere — the event is accepted, sealed and hashed without them. It has happened twice (`location.session`,
 * `bacabed`; `location.client`/`ide`/`workspace`/`surface`, 2026-08-28), both times found by eye.
 * `GET /api` publishes this, and `npm run check-deploy` diffs a deployment against the local build.
 * The `actor` group exists so an older Worker that would silently drop `actor.model_source` at
 * `EventInput.parse` fails doctor's "would drop" check instead of staying invisible.
 */
export function schemaSurface(): { event: string[]; actor: string[]; location: string[]; artifact: string[]; actions: string[] } {
  return {
    event: Object.keys(EventInput.shape).sort(),
    actor: Object.keys(actorObject.shape).sort(),
    location: Object.keys(Location.shape).sort(),
    artifact: Object.keys(ArtifactRef.shape).sort(),
    actions: [...Action.options].sort(),
  };
}

export const GENESIS_HASH = "0".repeat(64);
