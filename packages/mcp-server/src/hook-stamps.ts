import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Exact `reconcile.hook_sealed_by` from `.retrace.json` — the same list captureSeals and reconcile
 * already consume. Offline verify/export must pass this into the shared producer-sig verifier so
 * the two never disagree on a stored withheld event.
 */
export function trustedHookStampsFromRepo(repo: string): readonly string[] | undefined {
  const p = join(repo, ".retrace.json");
  if (!existsSync(p)) return undefined;
  let cfg: { reconcile?: { hook_sealed_by?: unknown } };
  try {
    cfg = JSON.parse(readFileSync(p, "utf8")) as { reconcile?: { hook_sealed_by?: unknown } };
  } catch {
    return undefined;
  }
  const list = cfg.reconcile?.hook_sealed_by;
  if (!Array.isArray(list)) return undefined;
  const stamps = list.filter((s): s is string => typeof s === "string");
  return stamps.length ? stamps : undefined;
}

export function producerVerifyOptsForRepo(repo: string): { trustedHookStamps?: readonly string[] } | undefined {
  const trustedHookStamps = trustedHookStampsFromRepo(repo);
  return trustedHookStamps ? { trustedHookStamps } : undefined;
}
