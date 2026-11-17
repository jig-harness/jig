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
import { basename, dirname, join } from "node:path";
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
const CACHE_ENTRY_NAME = /^[0-9a-f]{40}\.json$/;
/**
 * GitHub responses can contain pull-request discussions. An entry is never
 * reused after this age. Expired entries are deleted when a cache operation
 * visits the directory; an inactive cache can retain them until then.
 */
export const CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function entryFile(dir: string, scope: string, request: string): string {
  const key = createHash("sha256")
    .update(`${scope}\n${request}`)
    .digest("hex")
    .slice(0, 40);
  return join(dir, `${key}.json`);
}

export function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    // A read is a cache operation too: expire siblings even if this resource
    // keeps returning 304, so quiet entries cannot outlive active neighbours.
    prune(dirname(file), DEFAULT_ENTRIES, false);
    if (
      CACHE_ENTRY_NAME.test(basename(file)) &&
      currentMs() - statSync(file).mtimeMs >= CACHE_RETENTION_MS
    ) {
      rmSync(file, { force: true });
      return null;
    }
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
 * used entries first, keeps an entry a caller still reuses. Preserve mtime:
 * it is the response's retention clock, and reuse must not prolong retention.
 * Best effort: an entry that cannot be touched may be pruned, costing a
 * re-read.
 */
export function touchFile(file: string): void {
  try {
    const now = currentMs() / 1000;
    utimesSync(file, now, statSync(file).mtime);
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

function prune(dir: string, limit: EntryLimit, enforceLimit = true): void {
  const names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  const now = currentMs();
  for (const n of names) {
    if (!CACHE_ENTRY_NAME.test(n)) continue;
    const file = join(dir, n);
    try {
      if (now - statSync(file).mtimeMs >= CACHE_RETENTION_MS)
        rmSync(file, { force: true });
    } catch (error) {
      swallow(
        error,
        "an expired cached GitHub answer that cannot be removed is a miss",
      );
    }
  }
  if (!enforceLimit) return;
  const retained = readdirSync(dir).filter((n) => n.endsWith(".json"));
  if (retained.length <= limit.max) return;
  const aged = retained
    .map((n) => {
      try {
        return { n, t: statSync(join(dir, n)).atimeMs };
      } catch {
        return { n, t: 0 };
      }
    })
    .sort((a, b) => a.t - b.t);
  for (const { n } of aged.slice(0, retained.length - limit.keep)) {
    rmSync(join(dir, n), { force: true });
  }
}
