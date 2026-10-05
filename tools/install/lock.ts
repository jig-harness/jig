import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/** Atomic directory claim; never steal a live owner's lock. */
export async function locked<T>(
  path: string,
  run: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      mkdirSync(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() > deadline) {
        let owner = "unknown owner";
        try {
          owner = readFileSync(join(path, "owner"), "utf8");
        } catch {}
        throw new Error(
          `timed out waiting for ${path} (${owner}); remove a crashed owner's lock before retrying`,
        );
      }
      await Bun.sleep(50);
    }
  }
  try {
    writeFileSync(join(path, "owner"), String(process.pid));
    return await run();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
