export type CredentialPrincipal = { type: "human" | "team"; id: string };

/** Subset of Credential used for issuance / principal reports. Avoids importing router (cycle). */
export type IssuanceCredential = {
  name?: string;
  actor: { type: string; id: string; on_behalf_of?: string };
  trust?: "pinned" | "assert";
  projects?: string[];
  retired_at?: string;
  principal?: CredentialPrincipal;
};

export function samePrincipal(a: CredentialPrincipal, b: CredentialPrincipal): boolean {
  return a.type === b.type && a.id === b.id;
}

export function formatPrincipal(p: CredentialPrincipal): string {
  return `${p.type}/${p.id}`;
}

/** `human/<id>` or `team/<id>`. Id may itself contain slashes. */
export function parsePrincipalRef(raw: string): CredentialPrincipal {
  const slash = raw.indexOf("/");
  const type = slash > 0 ? raw.slice(0, slash) : "";
  const id = slash > 0 ? raw.slice(slash + 1) : "";
  if ((type !== "human" && type !== "team") || !id) throw new Error(`principal must be human/<id> or team/<id> (got "${raw}")`);
  return { type, id };
}

/** `agent/codex`, `system/retrace-git-acme`. Id may contain slashes. */
export function parseActorRef(raw: string): { type: string; id: string } {
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) throw new Error(`actor must be type/id (got "${raw}")`);
  return { type: raw.slice(0, slash), id: raw.slice(slash + 1) };
}

export function credentialCoversProject(c: { projects?: string[] }, project: string): boolean {
  if (!c.projects || c.projects.includes("*")) return true;
  return c.projects.includes(project);
}

export function isLivePinnedCredential(c: Pick<IssuanceCredential, "trust" | "retired_at">): boolean {
  return (c.trust ?? "pinned") === "pinned" && !c.retired_at;
}

export type SharedActorId = { type: string; id: string; count: number };

export type CredentialPrincipalReport = {
  actor: { type: string; id: string };
  principal: CredentialPrincipal | "missing";
  live: boolean;
  name?: string;
};

export type PrincipalConflictLive = {
  name?: string;
  principal: CredentialPrincipal | "missing";
};

/** Historical principal clash for one actor id. `live` is every non-retired covering credential (usable), not only pinned. */
export type PrincipalConflict = {
  project: string;
  actor: { type: string; id: string };
  principals: CredentialPrincipal[];
  live: PrincipalConflictLive[];
};

export type ProjectIssuanceStatus = {
  shared_actor_id: SharedActorId[];
  principals: CredentialPrincipalReport[];
  principal_conflicts: PrincipalConflict[];
};

/** Live pinned credentials for `project` that share an actor {type,id}. Empty when issuance is healthy. */
export function sharedLivePinnedActorIds(credentials: readonly IssuanceCredential[] | undefined, project: string): SharedActorId[] {
  const counts = new Map<string, { type: string; id: string; count: number }>();
  for (const c of credentials ?? []) {
    if (!isLivePinnedCredential(c) || !credentialCoversProject(c, project)) continue;
    const key = `${c.actor.type}\0${c.actor.id}`;
    const row = counts.get(key) ?? { type: c.actor.type, id: c.actor.id, count: 0 };
    row.count++;
    counts.set(key, row);
  }
  return [...counts.values()].filter((r) => r.count >= 2).sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
}

export function credentialPrincipalReports(credentials: readonly IssuanceCredential[] | undefined, project: string): CredentialPrincipalReport[] {
  const out: CredentialPrincipalReport[] = [];
  for (const c of credentials ?? []) {
    if (!credentialCoversProject(c, project)) continue;
    out.push({
      actor: { type: c.actor.type, id: c.actor.id },
      principal: c.principal ?? "missing",
      live: isLivePinnedCredential(c),
      ...(c.name ? { name: c.name } : {}),
    });
  }
  return out;
}

export function projectIssuanceStatus(credentials: readonly IssuanceCredential[] | undefined, project: string): ProjectIssuanceStatus {
  return {
    shared_actor_id: sharedLivePinnedActorIds(credentials, project),
    principals: credentialPrincipalReports(credentials, project),
    principal_conflicts: historicalPrincipalConflicts(credentials, project),
  };
}

function actorKey(actor: { type: string; id: string }): string {
  return `${actor.type}\0${actor.id}`;
}

export function coveringActorCredentials(
  credentials: readonly IssuanceCredential[],
  project: string,
  actor: { type: string; id: string },
): IssuanceCredential[] {
  return credentials.filter((c) => c.actor.type === actor.type && c.actor.id === actor.id && credentialCoversProject(c, project));
}

function isUsableCredential(c: Pick<IssuanceCredential, "retired_at">): boolean {
  return !c.retired_at;
}

/** Two or more distinct principals historically bound to the same actor id in this project. */
export function historicalPrincipalConflicts(credentials: readonly IssuanceCredential[] | undefined, project: string): PrincipalConflict[] {
  const groups = new Map<string, IssuanceCredential[]>();
  for (const c of credentials ?? []) {
    if (!credentialCoversProject(c, project)) continue;
    const key = actorKey(c.actor);
    const rows = groups.get(key) ?? [];
    rows.push(c);
    groups.set(key, rows);
  }
  const out: PrincipalConflict[] = [];
  for (const rows of groups.values()) {
    const actor = { type: rows[0]!.actor.type, id: rows[0]!.actor.id };
    const principals = boundPrincipals(rows, project, actor);
    if (principals.length < 2) continue;
    out.push({
      project,
      actor,
      principals,
      live: rows.filter(isUsableCredential).map((c) => ({
        ...(c.name ? { name: c.name } : {}),
        principal: c.principal ?? "missing",
      })),
    });
  }
  return out.sort((a, b) => a.actor.type.localeCompare(b.actor.type) || a.actor.id.localeCompare(b.actor.id));
}

/** Distinct principals already bound to this actor id in the project (live or retired). Missing principals are skipped, never guessed. */
export function boundPrincipals(
  credentials: readonly IssuanceCredential[],
  project: string,
  actor: { type: string; id: string },
): CredentialPrincipal[] {
  const seen = new Map<string, CredentialPrincipal>();
  for (const c of credentials) {
    if (c.actor.type !== actor.type || c.actor.id !== actor.id || !credentialCoversProject(c, project) || !c.principal) continue;
    const key = formatPrincipal(c.principal);
    if (!seen.has(key)) seen.set(key, c.principal);
  }
  return [...seen.values()];
}

export function neverReissueError(
  project: string,
  actor: { type: string; id: string },
  original: CredentialPrincipal | CredentialPrincipal[],
  requested: CredentialPrincipal,
): string {
  const originals = Array.isArray(original) ? original : [original];
  const named = originals.map(formatPrincipal).join(", ");
  return `refusing to re-issue ${actor.type}/${actor.id} in project "${project}" to ${formatPrincipal(requested)} — originally bound to ${named}`;
}

export function unresolvedHistoryError(project: string, actor: { type: string; id: string }, unresolved: number): string {
  return `refusing to re-issue ${actor.type}/${actor.id} in project "${project}" — ${unresolved} credential(s) covering this actor have no principal. Run retrace-admin set-principal ${project} --actor ${actor.type}/${actor.id} --principal human/<email> first (do not guess from on_behalf_of).`;
}

/** T29: refuse minting this actor for a principal other than every historical binding. Unresolved (missing) history blocks every principal. */
export function refuseReissueIfBound(
  credentials: readonly IssuanceCredential[],
  project: string,
  actor: { type: string; id: string },
  requested: CredentialPrincipal,
): string | undefined {
  const covering = coveringActorCredentials(credentials, project, actor);
  const unresolved = covering.filter((c) => !c.principal).length;
  if (unresolved) return unresolvedHistoryError(project, actor, unresolved);
  const bound = boundPrincipals(covering, project, actor);
  if (!bound.length) return undefined;
  if (bound.every((p) => samePrincipal(p, requested))) return undefined;
  return neverReissueError(project, actor, bound, requested);
}

/** Finding 1: a planned batch must not bind one actor id to two principals, or mint two live pinned copies. */
export function batchPrincipalConflicts(planned: readonly IssuanceCredential[], project: string): string | undefined {
  const groups = new Map<string, IssuanceCredential[]>();
  for (const c of planned) {
    if (!credentialCoversProject(c, project)) continue;
    const key = actorKey(c.actor);
    const rows = groups.get(key) ?? [];
    rows.push(c);
    groups.set(key, rows);
  }
  for (const rows of groups.values()) {
    const actor = { type: rows[0]!.actor.type, id: rows[0]!.actor.id };
    const principals = boundPrincipals(rows, project, actor);
    if (principals.length >= 2) {
      return `refusing to mint ${actor.type}/${actor.id} in project "${project}" bound to multiple principals in this batch (${principals.map(formatPrincipal).join(", ")}). An actor id binds to one principal. Use a single --member; add-agent of the same harness for a second person is refused. A second person needs a distinct actor id.`;
    }
    const livePinned = rows.filter(isLivePinnedCredential);
    if (livePinned.length >= 2) {
      return `refusing to mint a second live pinned ${actor.type}/${actor.id} credential for project "${project}" in this batch — an actor id has one live pinned credential. Use a single --member.`;
    }
  }
  return undefined;
}

/** set-principal may not introduce a second principal onto an actor that already has established history. */
export function refuseSetPrincipalIfConflict(
  credentials: readonly IssuanceCredential[],
  project: string,
  actor: { type: string; id: string },
  requested: CredentialPrincipal,
): string | undefined {
  const bound = boundPrincipals(credentials, project, actor);
  if (bound.length > 1) {
    return `refusing to set principal ${formatPrincipal(requested)} on ${actor.type}/${actor.id} in project "${project}" — history already conflicts (${bound.map(formatPrincipal).join(", ")}); retiring a holder is not a repair`;
  }
  if (bound.length === 1 && !samePrincipal(bound[0]!, requested)) {
    return `refusing to set principal ${formatPrincipal(requested)} on ${actor.type}/${actor.id} in project "${project}" — already bound to ${formatPrincipal(bound[0]!)}`;
  }
  return undefined;
}
