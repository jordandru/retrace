import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Exact `reconcile.hook_sealed_by` for a *named ledger project*. Returns undefined (fail closed,
 * no hook substitution) unless this repo's declared `.retrace.json` `project` equals `targetProject`.
 * `basename(repo)` is a fallback only when `cfg.project` is absent — the same order doctor/reconcile
 * use to pick the ledger project (`cfg.project ?? basename`). A directory name never widens a
 * declared project's trust domain; `repoNamesFor` aliases are repository/artifact names, not
 * ledger-project trust domains.
 *
 * Do not use the cwd list for some other bundle's `scope.project`: that is how repo A's policy
 * authorized reconstruction of repo B's event.
 */
export function trustedHookStampsFor(repo: string, targetProject: string): readonly string[] | undefined {
  const p = join(repo, ".retrace.json");
  if (!existsSync(p) || !targetProject) return undefined;
  let cfg: { project?: unknown; reconcile?: { hook_sealed_by?: unknown } };
  try {
    cfg = JSON.parse(readFileSync(p, "utf8")) as { project?: unknown; reconcile?: { hook_sealed_by?: unknown } };
  } catch {
    return undefined;
  }
  const declared = typeof cfg.project === "string" && cfg.project ? cfg.project : undefined;
  const identity = declared ?? basename(repo);
  if (identity !== targetProject) return undefined;
  const list = cfg.reconcile?.hook_sealed_by;
  if (!Array.isArray(list)) return undefined;
  const stamps = list.filter((s): s is string => typeof s === "string");
  return stamps.length ? stamps : undefined;
}

/** Options for the shared verifier: always carry the project being verified; stamps only if this repo owns it. */
export function producerVerifyOptsFor(repo: string, targetProject: string): { project: string; trustedHookStamps?: readonly string[] } {
  const trustedHookStamps = trustedHookStampsFor(repo, targetProject);
  return { project: targetProject, ...(trustedHookStamps ? { trustedHookStamps } : {}) };
}
