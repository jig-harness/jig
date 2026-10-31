/**
 * Each account's usage-limit wall, as the dispatcher records it, under
 * `~/.local/state/jig/dispatch/walls/<account>/`. A launch that ends with
 * `drive.ts`'s exit `16` writes one file there with the reset the drive
 * recorded, or, when the reset is unknown, `wall_backoff` from the stop.
 *
 * Every write is a file of its own and the wall is the latest reset of all
 * of them, so a write can never move the reset earlier, however many
 * sessions write the same account's wall at once. A file whose reset has
 * passed lifts nothing a later one holds, and is removed by the next read.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import { stateRoot } from "../receipts.ts";

export interface Wall {
  account: string;
  /** When the wall lifts. */
  resetAt: string;
  /** Where the reset came from: the drive's record, or the backoff. */
  source: string;
}

function wallsDir(account: string, root: string): string {
  return join(root, "walls", account);
}

/** Record a wall for `account`, lifting at `resetAt`. */
export function writeWall(wall: Wall, root = stateRoot()): string {
  const dir = wallsDir(wall.account, root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`;
  const path = join(dir, name);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(wall)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

function readWallFile(path: string): Wall | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isMapping(value) &&
      typeof value.account === "string" &&
      typeof value.resetAt === "string" &&
      Number.isFinite(Date.parse(value.resetAt))
      ? (value as unknown as Wall)
      : null;
  } catch (error) {
    swallow(error, `${path} is not a wall`);
    return null;
  }
}

/**
 * The wall in effect on `account` at `nowMs`: the latest reset any write
 * recorded, while it is still ahead; `null` when none is. Files whose reset
 * has passed are removed.
 */
export function wallOf(
  account: string,
  nowMs: number,
  root = stateRoot(),
): Wall | null {
  const dir = wallsDir(account, root);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let latest: Wall | null = null;
  for (const name of names) {
    const wall = readWallFile(join(dir, name));
    if (wall === null) continue;
    if (Date.parse(wall.resetAt) <= nowMs) {
      rmSync(join(dir, name), { force: true });
      continue;
    }
    if (
      latest === null ||
      Date.parse(wall.resetAt) > Date.parse(latest.resetAt)
    )
      latest = wall;
  }
  return latest;
}
