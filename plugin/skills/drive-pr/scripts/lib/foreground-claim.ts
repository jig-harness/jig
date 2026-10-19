import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errnoCode } from "../../../../shared/errors.ts";

/** Establish the launcher capability in a claimed generation directory. */
export function claimGenerationLauncher(dir: string, pid: number): boolean {
  try {
    // O_EXCL binds this write to its opened file, never a later replacement path.
    writeFileSync(join(dir, "launcher.pid"), `${pid}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return false;
    throw error;
  }
}

/** A pathname alone never proves this launch still owns its reservation. */
export function ownsGenerationLauncher(dir: string, pid: number): boolean {
  try {
    return (
      readFileSync(join(dir, "launcher.pid"), "utf8").trim() === String(pid)
    );
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}
