/** Filesystem storage for bounded, owner-only GitHub cache entries. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { swallow } from "./errors.ts";
import { renameWithRetry } from "./rename-with-retry.ts";
import { currentMs } from "./time.ts";

/** How many entries a directory holds before pruning (`max`), and how many the newest pruning leaves (`keep`). */
export interface EntryLimit {
  max: number;
  keep: number;
}

/** The bound of a directory a caller does not size itself. */
export const DEFAULT_ENTRIES: EntryLimit = { max: 256, keep: 128 };

export function entryFile(dir: string, scope: string, request: string): string {
  const key = createHash("sha256")
    .update(`${scope}\n${request}`)
    .digest("hex")
    .slice(0, 40);
  return join(dir, `${key}.json`);
}

export function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (error) {
    swallow(error, "a cached GitHub answer that does not read is a miss");
    return null;
  }
}

/**
 * Mark `file` as just used, so pruning, which removes the least recently
 * written or used entries first, keeps an entry a caller still reuses.
 * Best effort: an entry that cannot be touched may be pruned, costing a
 * re-read.
 */
export function touchFile(file: string): void {
  try {
    const now = currentMs() / 1000;
    utimesSync(file, now, now);
  } catch (error) {
    swallow(error, "an entry that cannot be marked used may be pruned");
  }
}

export function writeJsonFile(
  dir: string,
  file: string,
  value: unknown,
  limit: EntryLimit = DEFAULT_ENTRIES,
): void {
  try {
    // Entries hold PR documents: owner-only, whatever the umask says.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameWithRetry(tmp, file);
    prune(dir, limit);
  } catch {
    // Best-effort: a cache that cannot be written costs a re-read, no more.
  }
}

function prune(dir: string, limit: EntryLimit): void {
  const names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  if (names.length <= limit.max) return;
  const aged = names
    .map((n) => {
      try {
        return { n, t: statSync(join(dir, n)).mtimeMs };
      } catch {
        return { n, t: 0 };
      }
    })
    .sort((a, b) => a.t - b.t);
  for (const { n } of aged.slice(0, names.length - limit.keep)) {
    rmSync(join(dir, n), { force: true });
  }
}
