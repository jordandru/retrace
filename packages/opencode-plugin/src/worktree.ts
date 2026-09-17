import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A Retrace worktree is one whose root carries `.retrace.json` and the shared agent rules. */
export function isRetraceWorktree(dir: string): boolean {
  if (!dir) return false;
  const marker = join(dir, ".retrace.json");
  if (!existsSync(marker) || !existsSync(join(dir, "docs", "agent-rules.md"))) return false;
  try {
    const parsed = JSON.parse(readFileSync(marker, "utf8")) as { project?: unknown };
    return typeof parsed.project === "string" && parsed.project.length > 0;
  } catch {
    return false;
  }
}

