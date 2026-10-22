import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Real directory entries with bounded concurrent creation and backdating. */
export async function plantRetirableQuarantine(
  stateDir: string,
  pr: string,
  count: number,
): Promise<void> {
  const old = new Date(Date.now() - 30 * 86_400_000);
  let next = 0;
  await Promise.all(
    Array.from({ length: 32 }, async () => {
      while (next < count) {
        const owner = (next++).toString(16).padStart(24, "0");
        const path = join(
          stateDir,
          `drive-pr-${pr}.json.lock.stale.owner.${owner}`,
        );
        await writeFile(path, "");
        await utimes(path, old, old);
      }
    }),
  );
}
