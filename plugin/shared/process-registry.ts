import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PROCESS_REGISTRY_ENV = "JIG_PROCESS_REGISTRY_DIR";
export interface ProcessIdentity {
  pid: number;
  start: string;
}

/** A pass owns its registry; nested commands inherit it instead of hiding their runners. */
export function createProcessRegistry(): { dir: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), "jig-processes-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Pending launch markers or unreadable records withhold any termination witness. */
export function processRegistryRoots(dir: string): ProcessIdentity[] | null {
  try {
    const roots: ProcessIdentity[] = [];
    for (const file of readdirSync(dir)) {
      const record: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (!record || typeof record !== "object") return null;
      const { pid, start } = record as Partial<ProcessIdentity>;
      if (
        !Number.isSafeInteger(pid) ||
        (pid ?? 0) <= 0 ||
        typeof start !== "string" ||
        start === ""
      )
        return null;
      roots.push({ pid: pid as number, start });
    }
    return roots;
  } catch {
    return null;
  }
}
