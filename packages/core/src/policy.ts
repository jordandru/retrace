/**
 * Project policy document — retrace-project-policy/1 (docs/design/project-policy-document.md v4.1).
 *
 * canonicalPolicyV1 is RFC 8785 JCS plus the /1 constraints. It is not chain.ts canonicalize().
 */
import { Event, EventInput } from "./schema.js";
import { newId, sealEvent, sha256Hex } from "./chain.js";
import { ChainHead, EventStore, SEALED_BY_OWNER } from "./store.js";

export const POLICY_PROFILE = "retrace-project-policy/1";
export const POLICY_IDEMPOTENCY_PREFIX = "policy:";
export const POLICY_ACTOR_ID = "retrace-api";
export const MAX_SAFE_UINT = Number.MAX_SAFE_INTEGER; // 2^53−1

const enc = new TextEncoder();

export class PolicyError extends Error {
  readonly status: 400 | 403 | 409 | 412 | 500 | 501;
  constructor(status: 400 | 403 | 409 | 412 | 500 | 501, message: string) {
    super(message);
    this.name = "PolicyError";
    this.status = status;
  }
}

export type OwnerPrincipal = { type: "human" | "team"; id: string };

export interface PolicyRepository {
  name: string;
  aliases: string[];
}

export interface PolicyBody {
  profile: typeof POLICY_PROFILE;
  project: string;
  trusted_hook_stamps: string[];
  unresolved_claims: "record" | "withhold";
  repositories: PolicyRepository[];
  github_repos: string[];
}

export interface PolicyEnvelope {
  version: number;
  created_at: string;
  set_by: OwnerPrincipal;
  supersedes: string | null;
  activation: { event_id: string; seq: number };
}

export interface PolicyDocument {
  body: PolicyBody;
  envelope: PolicyEnvelope;
  digest: string;
}

export type PolicyRouteState = "active" | "revoked";
export interface PolicyRouteRow {
  repo: string;
  state: PolicyRouteState;
  project: string;
  digest: string;
  activation_seq: number;
  set_at: string;
}

export type PolicyRouteChange = {
  repo: string;
  from_project?: string;
  to_project?: string;
  state: PolicyRouteState;
};

export type PolicyWrite = {
  events: Event[];
  documents: PolicyDocument[];
  routes: PolicyRouteRow[];
};

export type PolicySnapshot = {
  U: number;
  events: Event[];
  activations: Event[];
};

export type PolicySelection =
  | { status: "none" }
  | { status: "selected"; digest: string; version: number; seq: number; document: PolicyDocument }
  | { status: "incomplete"; reason: "policy_missing" | "policy_corrupt" | "policy_backref_mismatch"; seq: number };

export type PolicyVerifyFinding =
  | "policy_missing"
  | "policy_misselected"
  | "policy_selection_unverifiable"
  | "policy_corrupt"
  | "policy_project_mismatch"
  | "policy_unsupported_profile";

export function parseOwnerPrincipal(raw?: string | null): OwnerPrincipal | undefined {
  if (!raw || !raw.trim()) return undefined;
  const v = raw.trim();
  if (v.startsWith("team:")) {
    const id = v.slice(5);
    if (!id) return undefined;
    return { type: "team", id };
  }
  return { type: "human", id: v };
}

export function canonicalGithubRepo(fullName: string): string {
  return fullName.trim().toLowerCase();
}

/** UTF-8 byte order (RFC 8785 /1 array comparator). */
export function compareUtf8(a: string, b: string): number {
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) if (ba[i] !== bb[i]) return ba[i]! - bb[i]!;
  return ba.length - bb.length;
}

export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
      // NaN comparisons are always false — a trailing high surrogate is still lone.
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function isSafeUint(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/** RFC 8785 §3.2.2.2 string serialisation. No Unicode normalisation. */
export function jcsSerializeString(s: string): string {
  if (hasLoneSurrogate(s)) throw new PolicyError(400, "string contains a lone Unicode surrogate");
  let out = "\"";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += "\\\"";
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else if (c >= 0xd800 && c <= 0xdbff) {
      out += s[i]! + s[i + 1]!;
      i++;
    } else out += s[i]!;
  }
  return out + "\"";
}

/**
 * RFC 8785 JCS. Integers only in /1: 0 ≤ n ≤ 2^53−1. Object keys sorted by UTF-16 code units.
 * Does not accept undefined. Duplicate keys are a parse-time concern (see parseJsonRejectDuplicateKeys).
 */
export function jcsSerialize(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!isSafeUint(value)) throw new PolicyError(400, "numbers must be integers in 0..2^53-1");
    return String(value);
  }
  if (typeof value === "string") return jcsSerializeString(value);
  if (Array.isArray(value)) return "[" + value.map(jcsSerialize).join(",") + "]";
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => jcsSerializeString(k) + ":" + jcsSerialize((value as Record<string, unknown>)[k])).join(",") + "}";
  }
  throw new PolicyError(400, "unsupported JSON value");
}

export function canonicalPolicyV1(document: Record<string, unknown>): string {
  return jcsSerialize(document);
}

export function policyDocumentFromRow(row: { body: string; envelope: string; digest: string }): PolicyDocument {
  return { body: JSON.parse(row.body) as PolicyBody, envelope: JSON.parse(row.envelope) as PolicyEnvelope, digest: row.digest };
}

export function policyHashObject(body: PolicyBody, envelope: PolicyEnvelope): Record<string, unknown> {
  return { ...body, ...envelope };
}

export async function policyDigestOf(body: PolicyBody, envelope: PolicyEnvelope): Promise<string> {
  return sha256Hex(canonicalPolicyV1(policyHashObject(body, envelope)));
}

/** Parse JSON and reject duplicate object keys on the raw bytes before a parser would keep the last. */
export function parseJsonRejectDuplicateKeys(raw: string): unknown {
  const s = raw;
  let i = 0;
  const skipWs = () => { while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++; };
  const fail = (m: string): never => { throw new PolicyError(400, m); };
  const parseString = (): string => {
    if (s[i] !== "\"") fail("invalid JSON string");
    i++;
    let out = "";
    while (i < s.length) {
      const c = s[i]!;
      if (c === "\"") { i++; return out; }
      if (c === "\\") {
        const e = s[++i];
        i++;
        if (e === "\"" || e === "\\" || e === "/") out += e;
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "n") out += "\n";
        else if (e === "r") out += "\r";
        else if (e === "t") out += "\t";
        else if (e === "u") {
          const hex = s.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else fail("invalid escape");
      } else {
        out += c;
        i++;
      }
    }
    return fail("unterminated string");
  };
  const parseNumber = (): number => {
    const start = i;
    if (s[i] === "-") i++;
    if (s[i] === "0") i++;
    else if (s[i] && s[i]! >= "1" && s[i]! <= "9") { while (s[i] && s[i]! >= "0" && s[i]! <= "9") i++; }
    else fail("invalid number");
    if (s[i] === ".") { i++; if (!(s[i] && s[i]! >= "0" && s[i]! <= "9")) fail("invalid number"); while (s[i] && s[i]! >= "0" && s[i]! <= "9") i++; }
    if (s[i] === "e" || s[i] === "E") {
      i++;
      if (s[i] === "+" || s[i] === "-") i++;
      if (!(s[i] && s[i]! >= "0" && s[i]! <= "9")) fail("invalid number");
      while (s[i] && s[i]! >= "0" && s[i]! <= "9") i++;
    }
    const n = Number(s.slice(start, i));
    if (!Number.isFinite(n)) fail("invalid number");
    return n;
  };
  const parseValue = (): unknown => {
    skipWs();
    const c = s[i];
    if (c === "{") {
      i++;
      skipWs();
      const obj: Record<string, unknown> = {};
      const seen = new Set<string>();
      if (s[i] === "}") { i++; return obj; }
      while (i < s.length) {
        skipWs();
        const key = parseString();
        if (seen.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
        seen.add(key);
        skipWs();
        if (s[i] !== ":") fail("expected ':'");
        i++;
        obj[key] = parseValue();
        skipWs();
        if (s[i] === "}") { i++; return obj; }
        if (s[i] !== ",") fail("expected ',' or '}'");
        i++;
      }
      fail("unterminated object");
    }
    if (c === "[") {
      i++;
      skipWs();
      const arr: unknown[] = [];
      if (s[i] === "]") { i++; return arr; }
      while (i < s.length) {
        arr.push(parseValue());
        skipWs();
        if (s[i] === "]") { i++; return arr; }
        if (s[i] !== ",") fail("expected ',' or ']'");
        i++;
      }
      fail("unterminated array");
    }
    if (c === "\"") return parseString();
    if (c === "t" && s.slice(i, i + 4) === "true") { i += 4; return true; }
    if (c === "f" && s.slice(i, i + 5) === "false") { i += 5; return false; }
    if (c === "n" && s.slice(i, i + 4) === "null") { i += 4; return null; }
    if (c === "-" || (c && c >= "0" && c <= "9")) return parseNumber();
    fail("invalid JSON");
  };
  const value = parseValue();
  skipWs();
  if (i !== s.length) fail("trailing data after JSON value");
  return value;
}

const BODY_KEYS = new Set(["profile", "project", "trusted_hook_stamps", "unresolved_claims", "repositories", "github_repos"]);
const REPO_KEYS = new Set(["name", "aliases"]);
const ENVELOPE_KEYS = new Set(["version", "created_at", "set_by", "supersedes", "activation"]);
const SET_BY_KEYS = new Set(["type", "id"]);
const ACTIVATION_KEYS = new Set(["event_id", "seq"]);

function requireObject(v: unknown, label: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new PolicyError(400, `${label} must be an object`);
  return v as Record<string, unknown>;
}

function rejectUnknown(obj: Record<string, unknown>, allowed: Set<string>, label: string) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new PolicyError(400, `unknown field ${JSON.stringify(k)} in ${label}`);
  }
}

function requireString(v: unknown, label: string): string {
  if (typeof v !== "string") throw new PolicyError(400, `${label} must be a string`);
  if (hasLoneSurrogate(v)) throw new PolicyError(400, `${label} contains a lone Unicode surrogate`);
  return v;
}

function requireSortedUniqueStrings(v: unknown, label: string): string[] {
  if (!Array.isArray(v)) throw new PolicyError(400, `${label} must be an array of strings`);
  const arr = v.map((x, i) => {
    if (typeof x !== "string") throw new PolicyError(400, `${label}[${i}] must be a string`);
    if (hasLoneSurrogate(x)) throw new PolicyError(400, `${label}[${i}] contains a lone Unicode surrogate`);
    return x;
  });
  for (let i = 1; i < arr.length; i++) {
    const cmp = compareUtf8(arr[i - 1]!, arr[i]!);
    if (cmp > 0) throw new PolicyError(400, `${label} must be sorted unique by UTF-8 bytes`);
    if (cmp === 0) throw new PolicyError(400, `${label} must be unique`);
  }
  return arr;
}

const CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const GITHUB_REPO_RE = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;

export function assertCanonicalGithubRepo(name: string, label: string): string {
  const c = canonicalGithubRepo(name);
  if (c !== name) throw new PolicyError(400, `${label} must be canonical owner/name lower-cased`);
  if (!GITHUB_REPO_RE.test(c) || c.split("/").length !== 2) throw new PolicyError(400, `${label} must be canonical owner/name`);
  return c;
}

export function validatePolicyBody(raw: unknown, expectedProject?: string): PolicyBody {
  const obj = requireObject(raw, "policy body");
  rejectUnknown(obj, BODY_KEYS, "policy body");
  for (const k of BODY_KEYS) if (!(k in obj)) throw new PolicyError(400, `missing required field ${k}`);
  if (obj.profile !== POLICY_PROFILE) throw new PolicyError(400, `profile must be ${POLICY_PROFILE}`);
  const project = requireString(obj.project, "project");
  if (!project) throw new PolicyError(400, "project must be non-empty");
  if (expectedProject !== undefined && project !== expectedProject)
    throw new PolicyError(400, `body.project must equal URL project ${JSON.stringify(expectedProject)}`);
  const trusted_hook_stamps = requireSortedUniqueStrings(obj.trusted_hook_stamps, "trusted_hook_stamps");
  if (obj.unresolved_claims !== "record" && obj.unresolved_claims !== "withhold")
    throw new PolicyError(400, 'unresolved_claims must be "record" or "withhold"');
  if (!Array.isArray(obj.repositories)) throw new PolicyError(400, "repositories must be an array");
  const repositories: PolicyRepository[] = obj.repositories.map((r, i) => {
    const ro = requireObject(r, `repositories[${i}]`);
    rejectUnknown(ro, REPO_KEYS, `repositories[${i}]`);
    if (!("name" in ro) || !("aliases" in ro)) throw new PolicyError(400, `repositories[${i}] requires name and aliases`);
    const name = assertCanonicalGithubRepo(requireString(ro.name, `repositories[${i}].name`), `repositories[${i}].name`);
    const aliases = requireSortedUniqueStrings(ro.aliases, `repositories[${i}].aliases`);
    return { name, aliases };
  });
  for (let i = 1; i < repositories.length; i++) {
    const cmp = compareUtf8(repositories[i - 1]!.name, repositories[i]!.name);
    if (cmp > 0) throw new PolicyError(400, "repositories must be sorted by name (UTF-8 bytes)");
    if (cmp === 0) throw new PolicyError(400, "repositories names must be unique");
  }
  const github_repos = requireSortedUniqueStrings(obj.github_repos, "github_repos").map((n, i) =>
    assertCanonicalGithubRepo(n, `github_repos[${i}]`),
  );
  return {
    profile: POLICY_PROFILE,
    project,
    trusted_hook_stamps,
    unresolved_claims: obj.unresolved_claims,
    repositories,
    github_repos,
  };
}

export function validatePolicyEnvelope(raw: unknown): PolicyEnvelope {
  const obj = requireObject(raw, "policy envelope");
  rejectUnknown(obj, ENVELOPE_KEYS, "policy envelope");
  for (const k of ENVELOPE_KEYS) if (!(k in obj)) throw new PolicyError(400, `missing required envelope field ${k}`);
  if (!isSafeUint(obj.version) || obj.version < 1) throw new PolicyError(400, "envelope.version must be an integer ≥ 1 and ≤ 2^53-1");
  const created_at = requireString(obj.created_at, "created_at");
  if (!CREATED_AT_RE.test(created_at)) throw new PolicyError(400, "created_at must be RFC 3339 UTC with millisecond precision and Z");
  const setBy = requireObject(obj.set_by, "set_by");
  rejectUnknown(setBy, SET_BY_KEYS, "set_by");
  if (!("type" in setBy) || !("id" in setBy)) throw new PolicyError(400, "set_by requires type and id");
  if (setBy.type !== "human" && setBy.type !== "team") throw new PolicyError(400, 'set_by.type must be "human" or "team"');
  const id = requireString(setBy.id, "set_by.id");
  if (!id) throw new PolicyError(400, "set_by.id must be non-empty");
  let supersedes: string | null;
  if (obj.supersedes === null) supersedes = null;
  else {
    const d = requireString(obj.supersedes, "supersedes");
    if (!DIGEST_RE.test(d)) throw new PolicyError(400, "supersedes must be a 64-char hex digest or null");
    supersedes = d;
  }
  const act = requireObject(obj.activation, "activation");
  rejectUnknown(act, ACTIVATION_KEYS, "activation");
  if (!("event_id" in act) || !("seq" in act)) throw new PolicyError(400, "activation requires event_id and seq");
  const event_id = requireString(act.event_id, "activation.event_id");
  if (!event_id) throw new PolicyError(400, "activation.event_id must be non-empty");
  if (!isSafeUint(act.seq)) throw new PolicyError(400, "activation.seq must be an integer in 0..2^53-1");
  return {
    version: obj.version,
    created_at,
    set_by: { type: setBy.type, id },
    supersedes,
    activation: { event_id, seq: act.seq },
  };
}

export async function assemblePolicyDocument(body: PolicyBody, envelope: PolicyEnvelope): Promise<PolicyDocument> {
  const digest = await policyDigestOf(body, envelope);
  return { body, envelope, digest };
}

export function bodiesEqual(a: PolicyBody, b: PolicyBody): boolean {
  return canonicalPolicyV1(a as unknown as Record<string, unknown>) === canonicalPolicyV1(b as unknown as Record<string, unknown>);
}

export function policyArtifactId(project: string, digest: string): string {
  return `policy:${project}@${digest}`;
}

export function policyIdempotencyKey(project: string, version: number): string {
  return `${POLICY_IDEMPOTENCY_PREFIX}${project}:${version}`;
}

function asParams(e: Event): Record<string, unknown> {
  const p = e.method?.params;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

export function looksLikePolicyActivation(e: Event): boolean {
  const key = e.idempotency_key ?? "";
  if (!key.startsWith(POLICY_IDEMPOTENCY_PREFIX)) return false;
  if (asParams(e)[ "sealed_by"] !== SEALED_BY_OWNER) return false;
  if (e.action !== "created" || e.method?.tool !== "retrace-api") return false;
  const arts = e.artifacts.filter((a) => a.id.startsWith("policy:"));
  return arts.length === 1 && arts[0]!.id.startsWith(`policy:${e.project}@`);
}

/**
 * Authoritative activation predicate (§6). Same rule online and offline.
 *
 * Builder note 1: an event that looks like an activation (clauses 1–3) whose required document is
 * absent is incomplete evidence — fail closed — not an ignorable ordinary event.
 */
export function evaluateActivation(
  e: Event,
  documents: ReadonlyMap<string, PolicyDocument>,
  earlierEligibleVersions: number[],
): PolicySelection | { status: "ignored" } | { status: "eligible"; digest: string; version: number; seq: number; document: PolicyDocument } {
  const key = e.idempotency_key ?? "";
  const params = asParams(e);
  const arts = e.artifacts.filter((a) => typeof a.id === "string" && a.id.startsWith("policy:"));
  const looks =
    key.startsWith(POLICY_IDEMPOTENCY_PREFIX) &&
    params.sealed_by === SEALED_BY_OWNER &&
    e.action === "created" &&
    e.method?.tool === "retrace-api" &&
    arts.length === 1 &&
    arts[0]!.id.startsWith(`policy:${e.project}@`);
  if (!looks) return { status: "ignored" };

  const digest = arts[0]!.id.slice(`policy:${e.project}@`.length);
  const doc = documents.get(documentMapKey(e.project, digest)) ?? documents.get(digest);
  // Builder note 1: clauses 1–3 hold and the required document is absent → incomplete, not ignored.
  if (!doc) return { status: "incomplete", reason: "policy_missing", seq: e.seq };
  if (doc.body.project !== e.project || doc.body.profile !== POLICY_PROFILE)
    return { status: "incomplete", reason: "policy_corrupt", seq: e.seq };
  // Clause 4/5 failures (forged or copied activations) are ordinary ignored events so a later
  // real activation stays selectable (P4). Missing document is the fail-closed case.
  if (doc.digest !== digest) return { status: "ignored" };
  if (doc.envelope.activation.event_id !== e.id || doc.envelope.activation.seq !== e.seq)
    return { status: "ignored" };
  const pDigest = params.policy_digest;
  const pVersion = params.policy_version;
  const pProfile = params.policy_profile;
  const pSupersedes = params.supersedes === undefined ? null : params.supersedes;
  if (pDigest !== digest || pVersion !== doc.envelope.version || pProfile !== doc.body.profile)
    return { status: "ignored" };
  if (pSupersedes !== doc.envelope.supersedes) return { status: "ignored" };
  if (typeof pVersion !== "number" || earlierEligibleVersions.some((v) => pVersion <= v))
    return { status: "ignored" };
  return { status: "eligible", digest, version: doc.envelope.version, seq: e.seq, document: doc };
}

export function documentMapKey(project: string, digest: string): string {
  return `${project}\0${digest}`;
}

/**
 * Greatest eligible activation with seq ≤ U. Walks activations newest-first; an incomplete
 * later activation fails closed (builder note 1) instead of falling back to an older version.
 */
export function selectPolicyForContext(
  snapshot: PolicySnapshot,
  documents: ReadonlyMap<string, PolicyDocument>,
): PolicySelection {
  const activations = (snapshot.activations.length ? snapshot.activations : snapshot.events)
    .filter((e) => e.seq <= snapshot.U)
    .sort((a, b) => b.seq - a.seq);

  const olderEligibleVersions = (seq: number): number[] => {
    const older = activations.filter((e) => e.seq < seq).sort((a, b) => a.seq - b.seq);
    const versions: number[] = [];
    for (const e of older) {
      const ev = evaluateActivation(e, documents, versions);
      if (ev.status === "eligible") versions.push(ev.version);
    }
    return versions;
  };

  // Newest-first: a present activation whose document is absent fails closed (builder note 1).
  // Clause 5 uses only older eligible versions so a copy of v1 after v2 cannot win.
  for (const e of activations) {
    const ev = evaluateActivation(e, documents, olderEligibleVersions(e.seq));
    if (ev.status === "incomplete") return ev;
    if (ev.status === "eligible") {
      return { status: "selected", digest: ev.digest, version: ev.version, seq: ev.seq, document: ev.document };
    }
  }
  return { status: "none" };
}

/** Stable classification context key (project, canonical R, sha) — interface for step 3, not a classifier. */
export function canonicalRepositoryR(policy: PolicyBody, nameOrAlias: string): string | undefined {
  const needle = nameOrAlias.trim();
  for (const r of policy.repositories) {
    if (r.name === needle || r.aliases.includes(needle)) return r.name;
    if (canonicalGithubRepo(r.name) === canonicalGithubRepo(needle)) return r.name;
    if (r.aliases.some((a) => a === needle || canonicalGithubRepo(a) === canonicalGithubRepo(needle))) return r.name;
  }
  return undefined;
}

export function contextKey(project: string, canonicalR: string, sha: string): string {
  return `${project}\0${canonicalR}\0${sha}`;
}

export function rfc3339UtcMs(d: Date): string {
  return d.toISOString();
}

async function sealActivationWithId(opts: {
  project: string;
  digest: string;
  version: number;
  supersedes: string | null;
  setBy: OwnerPrincipal;
  routesChanged: PolicyRouteChange[];
  reservedId: string;
  prev: ChainHead | null;
  now: Date;
}): Promise<Event> {
  const input: EventInput = {
    project: opts.project,
    actor: { type: "system", id: POLICY_ACTOR_ID, on_behalf_of: `${opts.setBy.type}:${opts.setBy.id}` },
    action: "created",
    artifacts: [{
      id: policyArtifactId(opts.project, opts.digest),
      kind: "policy",
      role: "generated",
      ...(opts.supersedes ? { derived_from: [policyArtifactId(opts.project, opts.supersedes)] } : {}),
    }],
    intent: `policy v${opts.version} activated`,
    method: {
      tool: "retrace-api",
      automated: true,
      params: {
        policy_profile: POLICY_PROFILE,
        policy_version: opts.version,
        policy_digest: opts.digest,
        supersedes: opts.supersedes,
        set_by: { type: opts.setBy.type, id: opts.setBy.id },
        routes_changed: opts.routesChanged,
        sealed_by: SEALED_BY_OWNER,
      },
    },
    idempotency_key: policyIdempotencyKey(opts.project, opts.version),
    timestamp: rfc3339UtcMs(opts.now),
  };
  return sealEvent(input, opts.prev, opts.now, { id: opts.reservedId });
}

function currentIfMatch(current: PolicyDocument | null): string {
  return current ? current.digest : "none";
}

function parseIfMatch(header: string | null | undefined): string | undefined {
  if (header === undefined || header === null) return undefined;
  const v = header.trim();
  if (!v) return undefined;
  return v.replace(/^W\//, "").replace(/^"|"$/g, "");
}

export type PutPolicyResult =
  | { status: 200; document: PolicyDocument }
  | { status: 201; document: PolicyDocument; write: PolicyWrite; expectedHeads: Record<string, ChainHead | null> }
  | { status: 400 | 403 | 409 | 412 | 500 | 501; error: string };

/**
 * §3 PUT as one planned operation. The caller (router) submits `write` through `store.applyPolicyWrite`
 * inside the store's transaction. Collision retry is the router's once-then-409.
 */
export async function planPolicyPut(opts: {
  project: string;
  rawBody: string;
  ifMatchHeader: string | null | undefined;
  reassignFrom?: string;
  ownerPrincipal: OwnerPrincipal | undefined;
  current: PolicyDocument | null;
  currentByProject: Record<string, PolicyDocument | null>;
  routeByRepo: (repo: string) => PolicyRouteRow | null | Promise<PolicyRouteRow | null>;
  heads: Record<string, ChainHead | null>;
  now?: Date;
}): Promise<PutPolicyResult> {
  if (!opts.ownerPrincipal) return { status: 403, error: "no owner principal configured" };
  const ifMatch = parseIfMatch(opts.ifMatchHeader);
  if (!ifMatch) return { status: 400, error: "If-Match is required (digest or none)" };

  const current = opts.current;
  const expected = currentIfMatch(current);
  if (ifMatch !== expected) return { status: 412, error: "If-Match does not match the current policy digest" };

  let parsed: unknown;
  try { parsed = parseJsonRejectDuplicateKeys(opts.rawBody); }
  catch (e) {
    if (e instanceof PolicyError) return { status: 400, error: e.message };
    return { status: 400, error: "invalid JSON body" };
  }
  let body: PolicyBody;
  try { body = validatePolicyBody(parsed, opts.project); }
  catch (e) {
    if (e instanceof PolicyError) return { status: e.status === 400 ? 400 : 400, error: e.message };
    throw e;
  }

  const now = opts.now ?? new Date();
  const routePlan = await planRouteChanges({
    project: opts.project,
    body,
    current,
    reassignFrom: opts.reassignFrom,
    routeByRepo: opts.routeByRepo,
    currentByProject: opts.currentByProject,
  });
  if ("error" in routePlan) return { status: 409, error: routePlan.error };

  if (current && bodiesEqual(current.body, body)) {
    return { status: 200, document: current };
  }

  const version = (current?.envelope.version ?? 0) + 1;
  const reservedId = newId();
  const prev = opts.heads[opts.project] ?? null;
  const seq = prev ? prev.seq + 1 : 0;
  const envelope: PolicyEnvelope = {
    version,
    created_at: rfc3339UtcMs(now),
    set_by: { type: opts.ownerPrincipal.type, id: opts.ownerPrincipal.id },
    supersedes: current?.digest ?? null,
    activation: { event_id: reservedId, seq },
  };
  const document = await assemblePolicyDocument(body, envelope);
  const event = await sealActivationWithId({
    project: opts.project,
    digest: document.digest,
    version,
    supersedes: envelope.supersedes,
    setBy: opts.ownerPrincipal,
    routesChanged: routePlan.primaryChanges,
    reservedId,
    prev,
    now,
  });
  if (event.seq !== seq || event.id !== reservedId)
    return { status: 500, error: "activation seq/id reservation failed" };

  const documents = [document];
  const events = [event];
  const expectedHeads: Record<string, ChainHead | null> = { [opts.project]: prev };

  if (routePlan.fromWrite) {
    const fromProject = routePlan.fromWrite.project;
    const fromCurrent = opts.currentByProject[fromProject] ?? null;
    if (!fromCurrent) return { status: 409, error: `reassign source project ${fromProject} has no policy document` };
    const fromPrev = opts.heads[fromProject] ?? null;
    const fromVersion = fromCurrent.envelope.version + 1;
    const fromId = newId();
    const fromSeq = fromPrev ? fromPrev.seq + 1 : 0;
    const fromEnvelope: PolicyEnvelope = {
      version: fromVersion,
      created_at: rfc3339UtcMs(now),
      set_by: { type: opts.ownerPrincipal.type, id: opts.ownerPrincipal.id },
      supersedes: fromCurrent.digest,
      activation: { event_id: fromId, seq: fromSeq },
    };
    const fromDoc = await assemblePolicyDocument(routePlan.fromWrite.body, fromEnvelope);
    const fromEvent = await sealActivationWithId({
      project: fromProject,
      digest: fromDoc.digest,
      version: fromVersion,
      supersedes: fromCurrent.digest,
      setBy: opts.ownerPrincipal,
      routesChanged: routePlan.fromWrite.changes,
      reservedId: fromId,
      prev: fromPrev,
      now,
    });
    documents.push(fromDoc);
    events.push(fromEvent);
    expectedHeads[fromProject] = fromPrev;
    for (const row of routePlan.routes) {
      if (row.project === fromProject) row.digest = fromDoc.digest;
      if (row.project === opts.project) row.digest = document.digest;
    }
  } else {
    for (const row of routePlan.routes) if (row.project === opts.project) row.digest = document.digest;
  }
  for (const row of routePlan.routes) {
    if (row.project === opts.project) {
      row.digest = document.digest;
      row.activation_seq = seq;
      row.set_at = envelope.created_at;
    }
  }

  return {
    status: 201,
    document,
    write: { events, documents, routes: routePlan.routes },
    expectedHeads,
  };
}

function dropRepoFromBody(body: PolicyBody, repo: string): PolicyBody {
  const github_repos = body.github_repos.filter((r) => r !== repo);
  const repositories = body.repositories.filter((r) => r.name !== repo);
  return { ...body, github_repos, repositories };
}

async function planRouteChanges(opts: {
  project: string;
  body: PolicyBody;
  current: PolicyDocument | null;
  reassignFrom?: string;
  routeByRepo: (repo: string) => PolicyRouteRow | null | Promise<PolicyRouteRow | null>;
  currentByProject: Record<string, PolicyDocument | null>;
}): Promise<{ primaryChanges: PolicyRouteChange[]; routes: PolicyRouteRow[]; fromWrite?: { project: string; body: PolicyBody; changes: PolicyRouteChange[] } } | { error: string }> {
  const claimed = new Set(opts.body.github_repos);
  const previously = new Set(opts.current?.body.github_repos ?? []);
  const primaryChanges: PolicyRouteChange[] = [];
  const routes: PolicyRouteRow[] = [];
  let fromWrite: { project: string; body: PolicyBody; changes: PolicyRouteChange[] } | undefined;
  const reassignNeeded = new Set<string>();

  for (const repo of claimed) {
    const existing = await opts.routeByRepo(repo);
    if (!existing) {
      routes.push({ repo, state: "active", project: opts.project, digest: "", activation_seq: 0, set_at: "" });
      primaryChanges.push({ repo, to_project: opts.project, state: "active" });
      continue;
    }
    if (existing.state === "active" && existing.project === opts.project) {
      routes.push({ ...existing, state: "active", project: opts.project });
      continue;
    }
    if (existing.state === "revoked" && existing.project === opts.project) {
      routes.push({ ...existing, state: "active", project: opts.project });
      primaryChanges.push({ repo, from_project: existing.project, to_project: opts.project, state: "active" });
      continue;
    }
    if (existing.state === "active" && existing.project !== opts.project) {
      if (!opts.reassignFrom || opts.reassignFrom !== existing.project)
        return { error: `repository ${repo} is routed to project ${existing.project}; pass ?reassign=${existing.project}` };
      reassignNeeded.add(repo);
      continue;
    }
    // revoked row owned by another project: still not env-eligible; claiming requires reassign of that project.
    if (existing.state === "revoked" && existing.project !== opts.project) {
      if (!opts.reassignFrom || opts.reassignFrom !== existing.project)
        return { error: `repository ${repo} has a revoked route owned by ${existing.project}; pass ?reassign=${existing.project}` };
      reassignNeeded.add(repo);
    }
  }

  if (opts.reassignFrom && reassignNeeded.size === 0 && claimed.size)
    return { error: `?reassign=${opts.reassignFrom} does not match any claimed repository's current owner` };

  if (reassignNeeded.size) {
    const fromProject = opts.reassignFrom!;
    const fromCurrent = opts.currentByProject[fromProject];
    if (!fromCurrent) return { error: `reassign source ${fromProject} has no policy document` };
    let fromBody = fromCurrent.body;
    const fromChanges: PolicyRouteChange[] = [];
    for (const repo of reassignNeeded) {
      if (!fromCurrent.body.github_repos.includes(repo))
        return { error: `reassign source ${fromProject} does not currently claim ${repo}` };
      fromBody = dropRepoFromBody(fromBody, repo);
      fromChanges.push({ repo, from_project: fromProject, to_project: opts.project, state: "active" });
      primaryChanges.push({ repo, from_project: fromProject, to_project: opts.project, state: "active" });
      routes.push({ repo, state: "active", project: opts.project, digest: "", activation_seq: 0, set_at: "" });
    }
    fromWrite = { project: fromProject, body: fromBody, changes: fromChanges };
  }

  for (const repo of previously) {
    if (claimed.has(repo)) continue;
    const existing = await opts.routeByRepo(repo);
    routes.push({
      repo,
      state: "revoked",
      project: opts.project,
      digest: existing?.digest ?? "",
      activation_seq: existing?.activation_seq ?? 0,
      set_at: existing?.set_at ?? "",
    });
    primaryChanges.push({ repo, from_project: opts.project, state: "revoked" });
  }

  return { primaryChanges, routes, fromWrite };
}

export type WebhookRouting =
  | { kind: "routed"; project: string; source: "policy" | "env"; digest?: string; repo: string }
  | { kind: "unresolved"; repo: string; reason: string };

/**
 * §7 delivery-time routing. Env fallback only when there is no route row and the env candidate has no document.
 */
export function routeGithubDelivery(opts: {
  fullName: string;
  route: PolicyRouteRow | null;
  envProject: string | undefined;
  envProjectHasDocument: boolean;
}): WebhookRouting {
  const repo = canonicalGithubRepo(opts.fullName);
  if (opts.route?.state === "active")
    return { kind: "routed", project: opts.route.project, source: "policy", digest: opts.route.digest, repo };
  if (opts.route?.state === "revoked")
    return { kind: "unresolved", repo, reason: "revoked" };
  if (!opts.route && opts.envProject && !opts.envProjectHasDocument)
    return { kind: "routed", project: opts.envProject, source: "env", repo };
  return { kind: "unresolved", repo, reason: opts.route ? "unroutable" : "no route" };
}

export type MissingPolicyMode = "off" | "shadow" | "enforce";

/** P8: env-routed, no document. off → seal unclassified; shadow/enforce → stay pending. */
export function missingPolicyDisposition(mode: MissingPolicyMode, hasDocument: boolean): "seal_unclassified" | "pending_loud" | "proceed" {
  if (hasDocument) return "proceed";
  if (mode === "off") return "seal_unclassified";
  return "pending_loud";
}

export function proposedPolicyBody(opts: {
  project: string;
  stamps: string[];
  repositories: PolicyRepository[];
  github_repos: string[];
}): PolicyBody {
  const stamps = [...opts.stamps].sort(compareUtf8);
  const github_repos = [...new Set(opts.github_repos.map(canonicalGithubRepo))].sort(compareUtf8);
  const repositories = [...opts.repositories]
    .map((r) => ({
      name: canonicalGithubRepo(r.name),
      aliases: [...r.aliases].sort(compareUtf8),
    }))
    .sort((a, b) => compareUtf8(a.name, b.name));
  return {
    profile: POLICY_PROFILE,
    project: opts.project,
    trusted_hook_stamps: stamps,
    unresolved_claims: "record",
    repositories,
    github_repos,
  };
}

export async function bodyPreviewSha256(body: PolicyBody): Promise<string> {
  return sha256Hex(canonicalPolicyV1(body as unknown as Record<string, unknown>));
}

export function localConfigDrift(local: {
  stamps?: string[];
  repositories?: PolicyRepository[];
}, body: Pick<PolicyBody, "trusted_hook_stamps" | "repositories"> | null): { drifted: boolean; detail: string } {
  if (!body) return { drifted: true, detail: "no current policy document to compare" };
  const stamps = [...(local.stamps ?? [])].sort(compareUtf8);
  const bodyStamps = [...body.trusted_hook_stamps].sort(compareUtf8);
  const repos = (local.repositories ?? []).map((r) => r.name).sort(compareUtf8);
  const bodyRepos = body.repositories.map((r) => r.name).sort(compareUtf8);
  const stampEq = JSON.stringify(stamps) === JSON.stringify(bodyStamps);
  const repoEq = JSON.stringify(repos) === JSON.stringify(bodyRepos);
  if (stampEq && repoEq) return { drifted: false, detail: "local .retrace.json settings match the current policy body" };
  const bits = [];
  if (!stampEq) bits.push("trusted_hook_stamps");
  if (!repoEq) bits.push("repositories");
  return { drifted: true, detail: `local .retrace.json ${bits.join(" and ")} differ from the current policy body` };
}

/** Completeness of the event prefix through `readHeadSeq` (full contiguous 0..U). */
export function chainCompleteThrough(events: Event[], readHeadSeq: number): boolean {
  if (readHeadSeq < 0) return true;
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  for (let s = 0; s <= readHeadSeq; s++) if (!bySeq.has(s)) return false;
  return true;
}

export function verifyPolicySelectionOffline(opts: {
  project: string;
  claimedDigest: string | undefined;
  readHeadSeq: number | undefined;
  events: Event[];
  policies: PolicyDocument[];
  coverageComplete: boolean;
}): { ok: boolean; findings: PolicyVerifyFinding[]; selected?: PolicySelection } {
  const findings: PolicyVerifyFinding[] = [];
  const documents = new Map<string, PolicyDocument>();
  for (const d of opts.policies) {
    if (d.body.profile !== POLICY_PROFILE) findings.push("policy_unsupported_profile");
    if (d.body.project !== opts.project) findings.push("policy_project_mismatch");
    const key = documentMapKey(d.body.project, d.digest);
    const prior = documents.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(d)) findings.push("policy_corrupt");
    documents.set(key, d);
    documents.set(d.digest, d);
  }
  const U = opts.readHeadSeq ?? -1;
  if (U < 0 && !opts.claimedDigest) return { ok: findings.length === 0, findings };
  if (!opts.coverageComplete) {
    findings.push("policy_selection_unverifiable");
    return { ok: false, findings };
  }
  if (U >= 0 && !chainCompleteThrough(opts.events, U)) {
    findings.push("policy_selection_unverifiable");
    return { ok: false, findings };
  }
  const snapshot: PolicySnapshot = { U: U < 0 ? -1 : U, events: opts.events.filter((e) => e.seq <= U), activations: opts.events.filter((e) => e.seq <= U) };
  const selected = selectPolicyForContext(snapshot, documents);
  if (selected.status === "incomplete") {
    findings.push(selected.reason === "policy_missing" ? "policy_missing" : "policy_corrupt");
    return { ok: false, findings, selected };
  }
  if (opts.claimedDigest) {
    if (selected.status === "none") {
      findings.push("policy_missing");
      return { ok: false, findings, selected };
    }
    if (selected.digest !== opts.claimedDigest) {
      findings.push("policy_misselected");
      return { ok: false, findings, selected };
    }
  }
  return { ok: findings.length === 0, findings, selected };
}

export function eventPolicyRef(e: Event): { digest?: string; readHeadSeq?: number } {
  const p = asParams(e);
  const cd = p.claim_decision;
  const fromCd = cd && typeof cd === "object" && !Array.isArray(cd) ? (cd as { context?: { policy_digest?: unknown; read_head_seq?: unknown } }).context : undefined;
  const fromTop = p.context && typeof p.context === "object" && !Array.isArray(p.context)
    ? (p.context as { policy_digest?: unknown; read_head_seq?: unknown })
    : undefined;
  const ctx = fromCd ?? fromTop;
  const digest = typeof ctx?.policy_digest === "string" ? ctx.policy_digest : undefined;
  const readHeadSeq = typeof ctx?.read_head_seq === "number" ? ctx.read_head_seq : undefined;
  return { digest, readHeadSeq };
}

export function collectReferencedPolicies(events: Event[], all: PolicyDocument[]): PolicyDocument[] {
  const wanted = new Set<string>();
  for (const e of events) {
    const ref = eventPolicyRef(e);
    if (ref.digest) wanted.add(documentMapKey(e.project, ref.digest));
    for (const a of e.artifacts) {
      if (a.id.startsWith(`policy:${e.project}@`)) wanted.add(documentMapKey(e.project, a.id.slice(`policy:${e.project}@`.length)));
    }
  }
  return all.filter((d) => wanted.has(documentMapKey(d.body.project, d.digest)));
}
