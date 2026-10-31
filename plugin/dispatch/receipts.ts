/**
 * One receipt per tick under `~/.local/state/jig/dispatch/receipts/<date>/`:
 * the records the tick read and from where, and each action it planned with
 * its reason. The next tick reads the latest receipt for the date the
 * follow-up stage started per repository (`followupSince`), so that window
 * stays where it began however often the tick runs.
 *
 * A tick removes receipts older than the retention, keeping the latest
 * completed one whatever its age, and the latest completed one naming each
 * repository, since that receipt is the only record of the repository's
 * follow-up window.
 */
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isMapping } from "../shared/config-layers.ts";
import { swallow } from "../shared/errors.ts";
import type { RepoReport } from "./lib/types.ts";

/** Days a receipt is kept; the machine file sets it once there is one. */
const RETENTION_DAYS = 30;

export interface TickReceipt {
  version: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  completed: boolean;
  apply: false;
  exitStatus: number;
  repos: RepoReport[];
}

function stateRoot(): string {
  return join(homedir(), ".local", "state", "jig", "dispatch");
}

function receiptsRoot(root: string): string {
  return join(root, "receipts");
}

const RUN_ID = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-\d+-[a-f\d]{8}$/;

export function newRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Write the receipt atomically; returns its path. */
export function writeReceipt(receipt: TickReceipt, root = stateRoot()): string {
  const dir = join(receiptsRoot(root), receipt.startedAt.slice(0, 10));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${receipt.runId}.json`);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  return path;
}

/** Every receipt's path, oldest first. */
export function receiptPaths(root = stateRoot()): string[] {
  let days: string[];
  try {
    days = readdirSync(receiptsRoot(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return days
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))
    .sort()
    .flatMap((day) =>
      readdirSync(join(receiptsRoot(root), day))
        .filter(
          (name) =>
            name.endsWith(".json") && RUN_ID.test(basename(name, ".json")),
        )
        .sort()
        .map((name) => join(receiptsRoot(root), day, name)),
    );
}

function isRepoEntry(value: unknown): boolean {
  return (
    isMapping(value) &&
    typeof value.path === "string" &&
    Array.isArray(value.actions) &&
    Array.isArray(value.records) &&
    (value.followupSince === null ||
      value.followupSince === undefined ||
      (typeof value.followupSince === "string" &&
        Number.isFinite(Date.parse(value.followupSince))))
  );
}

/** A receipt, or `null` when the file does not hold one. */
export function readReceipt(path: string): TickReceipt | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isMapping(value) &&
      value.version === 1 &&
      typeof value.runId === "string" &&
      typeof value.startedAt === "string" &&
      typeof value.completed === "boolean" &&
      Array.isArray(value.repos) &&
      value.repos.every(isRepoEntry)
      ? (value as unknown as TickReceipt)
      : null;
  } catch (err) {
    swallow(err, `${path} is not a receipt`);
    return null;
  }
}

/**
 * The follow-up window's start for a repository, as the latest completed
 * receipt that names it recorded; `null` when no receipt does.
 */
export function previousFollowupSince(
  repoPath: string,
  root = stateRoot(),
): string | null {
  for (const path of receiptPaths(root).reverse()) {
    const receipt = readReceipt(path);
    if (receipt === null || !receipt.completed) continue;
    const repo = receipt.repos.find((r) => r.path === repoPath);
    if (repo?.followupSince) return repo.followupSince;
  }
  return null;
}

/** The receipts to keep whatever their age: the latest completed one naming each repository, and the latest overall. */
function newestPerRepository(paths: string[]): Set<string> {
  const keep = new Set<string>();
  const seen = new Set<string>();
  let latest = true;
  for (const path of [...paths].reverse()) {
    const receipt = readReceipt(path);
    if (receipt === null || !receipt.completed) continue;
    if (latest) keep.add(path);
    latest = false;
    for (const repo of receipt.repos)
      if (!seen.has(repo.path)) {
        seen.add(repo.path);
        keep.add(path);
      }
  }
  return keep;
}

/** Remove receipts past the retention, except those `newestPerRepository` keeps. */
export function pruneReceipts(
  nowMs: number,
  root = stateRoot(),
  days = RETENTION_DAYS,
): string[] {
  const paths = receiptPaths(root);
  const keep = newestPerRepository(paths);
  const cutoff = nowMs - days * 86_400_000;
  const removed: string[] = [];
  for (const path of paths) {
    if (keep.has(path)) continue;
    const day = Date.parse(`${basename(dirname(path))}T00:00:00Z`);
    if (!Number.isFinite(day) || day + 86_400_000 > cutoff) continue;
    rmSync(path, { force: true });
    removed.push(path);
  }
  return removed;
}

/** Seconds an unreadable or empty lock is given before it counts as abandoned. */
const LOCK_GRACE_MS = 10_000;

/**
 * The lock file is published whole: the pid is written to a private file that
 * is then linked to the lock path, so the lock never exists empty and only
 * one contender can create it.
 */
function publishLock(path: string): boolean {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, String(process.pid), { mode: 0o600 });
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** The pid a lock file names; `null` while it is empty or unreadable. */
function lockHolder(path: string): number | null {
  try {
    const holder = Number(readFileSync(path, "utf8").trim());
    return Number.isSafeInteger(holder) && holder > 0 ? holder : null;
  } catch (err) {
    swallow(err, `${path} cannot be read`);
    return null;
  }
}

function olderThan(path: string, ms: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > ms;
  } catch (err) {
    swallow(err, `${path} is gone`);
    return false;
  }
}

/**
 * Replace a lock the caller saw to be abandoned. Contenders serialize on a
 * guard file and re-read the lock under it, so a lock another tick took in
 * the meantime is left alone.
 */
function reclaim(path: string, seen: number | null): boolean {
  const guard = `${path}.reclaim`;
  if (!publishLock(guard)) {
    // A guard whose owner is gone is cleared for the next attempt.
    const owner = lockHolder(guard);
    if (
      (owner === null && olderThan(guard, LOCK_GRACE_MS)) ||
      (owner !== null && !alive(owner))
    )
      rmSync(guard, { force: true });
    return false;
  }
  try {
    const now = lockHolder(path);
    const abandoned =
      now === null ? olderThan(path, LOCK_GRACE_MS) : !alive(now);
    if (!abandoned || now !== seen) return false;
    rmSync(path, { force: true });
    return publishLock(path);
  } finally {
    rmSync(guard, { force: true });
  }
}

/** The tick lock: one tick per machine. Returns its release, or the holder. */
export function takeTickLock(
  root = stateRoot(),
): { release: () => void } | { heldBy: string } {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "tick.lock");
  const release = () => {
    // Only the owner removes the lock: a replaced one belongs to another tick.
    if (lockHolder(path) === process.pid) rmSync(path, { force: true });
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (publishLock(path)) return { release };
    const holder = lockHolder(path);
    const abandoned =
      holder === null ? olderThan(path, LOCK_GRACE_MS) : !alive(holder);
    if (!abandoned)
      return { heldBy: `process ${holder ?? "unknown"} (${path})` };
    if (reclaim(path, holder)) return { release };
  }
  return { heldBy: path };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
