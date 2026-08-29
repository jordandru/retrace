import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True when an ES module is the process entry point, including npm bin symlinks. */
export function isMainModule(moduleUrl: string, entryPoint = process.argv[1]): boolean {
  if (!entryPoint) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryPoint);
  } catch {
    return false;
  }
}
