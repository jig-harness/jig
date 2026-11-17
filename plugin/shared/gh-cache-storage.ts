/** Filesystem storage for bounded, owner-only GitHub cache entries. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { renameWithRetry } from "./rename-with-retry.ts";
import { currentMs } from "./time.ts";

/** Entries kept before pruning, and what pruning trims down to. */
const MAX_ENTRIES = 256;
const KEEP_ENTRIES = 128;
const CACHE_ENTRY_NAME = /^[0-9a-f]{40}\.json$/;
/**
 * GitHub responses can contain pull-request discussions. Keep their local
 * cache only briefly: an entry is unusable and removed after this age.
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
    if (currentMs() - statSync(file).mtimeMs >= CACHE_RETENTION_MS) {
      rmSync(file, { force: true });
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function writeJsonFile(dir: string, file: string, value: unknown): void {
  try {
    // Entries hold PR documents: owner-only, whatever the umask says.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameWithRetry(tmp, file);
    prune(dir);
  } catch {
    // Best-effort: a cache that cannot be written costs a re-read, no more.
  }
}

function prune(dir: string): void {
  const names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  const now = currentMs();
  for (const n of names) {
    if (!CACHE_ENTRY_NAME.test(n)) continue;
    const file = join(dir, n);
    try {
      if (now - statSync(file).mtimeMs >= CACHE_RETENTION_MS)
        rmSync(file, { force: true });
    } catch {
      // A concurrently removed entry is already gone; any other failure is
      // best-effort cache housekeeping and must not break its caller.
    }
  }
  const retained = readdirSync(dir).filter((n) => n.endsWith(".json"));
  if (retained.length <= MAX_ENTRIES) return;
  const aged = retained
    .map((n) => {
      try {
        return { n, t: statSync(join(dir, n)).mtimeMs };
      } catch {
        return { n, t: 0 };
      }
    })
    .sort((a, b) => a.t - b.t);
  for (const { n } of aged.slice(0, retained.length - KEEP_ENTRIES)) {
    rmSync(join(dir, n), { force: true });
  }
}
