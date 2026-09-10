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

export type ProjectIssuanceStatus = {
  shared_actor_id: SharedActorId[];
  principals: CredentialPrincipalReport[];
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
  };
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

/** T29: refuse minting this actor for a principal other than every historical binding. No binding yet → allow. */
export function refuseReissueIfBound(
  credentials: readonly IssuanceCredential[],
  project: string,
  actor: { type: string; id: string },
  requested: CredentialPrincipal,
): string | undefined {
  const bound = boundPrincipals(credentials, project, actor);
  if (!bound.length) return undefined;
  if (bound.every((p) => samePrincipal(p, requested))) return undefined;
  return neverReissueError(project, actor, bound, requested);
}
