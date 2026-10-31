/**
 * One receipt per tick under `~/.local/state/jig/dispatch/receipts/<date>/`:
 * the records the tick read and from where, and each action it planned with
 * its reason. The next tick reads the latest receipt for the date the
 * follow-up stage started per repository (`followupSince`), so that window
 * stays where it began however often the tick runs.
 *
 * A tick removes receipts older than the retention, keeping the latest
 * completed one whatever its age, the latest completed one naming each
 * repository, and the latest one recording a follow-up window for each, since
 * a receipt of a refused read names the repository without its window.
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

/** Days a receipt is kept unless the machine file's `receipts_days` says otherwise. */
const RETENTION_DAYS = 30;

export interface TickReceipt {
  version: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  completed: boolean;
  /** Whether the tick launched what the machine file enables. */
  apply: boolean;
  exitStatus: number;
  /** Launch record files that do not read, left out of every count. */
  unreadableLaunches?: string[];
  repos: RepoReport[];
}

export function stateRoot(): string {
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
    .sort((a, b) => a.localeCompare(b))
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

/** The receipts to keep whatever their age: the latest completed one overall, the latest naming each repository, and the latest holding each repository's follow-up window. */
function newestPerRepository(paths: string[]): Set<string> {
  const keep = new Set<string>();
  const named = new Set<string>();
  const windowed = new Set<string>();
  const first = (seen: Set<string>, repo: string) => {
    const fresh = !seen.has(repo);
    seen.add(repo);
    return fresh;
  };
  const completed = [...paths]
    .reverse()
    .map((path) => ({ path, receipt: readReceipt(path) }))
    .filter((r) => r.receipt?.completed);
  if (completed[0] !== undefined) keep.add(completed[0].path);
  for (const { path, receipt } of completed)
    for (const repo of receipt?.repos ?? []) {
      if (first(named, repo.path)) keep.add(path);
      if (repo.followupSince && first(windowed, repo.path)) keep.add(path);
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
/** The content a reclaim guard holds once its owner is done with it. */
const FINISHED = "finished";

/**
 * Publish `text` at `path` whole and only when nothing is there: it is
 * written to a private file that is then linked to the path, so the file
 * never exists empty and only one writer can create it. False when
 * something already is there.
 */
export function publishOnce(path: string, text: string): boolean {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
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

/** The lock file, holding this process's pid, published by `publishOnce`. */
function publishLock(path: string): boolean {
  return publishOnce(path, String(process.pid));
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

/** Whether a lock file's owner is gone: dead, or never wrote its pid within the grace. */
function ownerGone(file: string): boolean {
  if (finished(file)) return true;
  const holder = lockHolder(file);
  return holder === null ? olderThan(file, LOCK_GRACE_MS) : !alive(holder);
}

/** Whether a guard was marked finished by its owner. */
function finished(file: string): boolean {
  try {
    return readFileSync(file, "utf8").trim() === FINISHED;
  } catch (err) {
    swallow(err, `${file} cannot be read`);
    return false;
  }
}

/** The guards of a lock, oldest generation first. */
function guardsOf(path: string): { generation: number; file: string }[] {
  const prefix = `${basename(path)}.reclaim.`;
  const found: { generation: number; file: string }[] = [];
  for (const name of readdirSync(dirname(path)))
    if (name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
      found.push({
        generation: Number(name.slice(prefix.length)),
        file: join(dirname(path), name),
      });
  return found.sort((a, b) => a.generation - b.generation);
}

/**
 * Remove the guards below the newest generation whose owners are gone. The
 * newest guard stays, finished or not, so the next generation is always above
 * every one ever published and a number is never reused.
 */
function sweepGuards(path: string): void {
  const all = guardsOf(path);
  for (const g of all.slice(0, -1))
    if (ownerGone(g.file)) rmSync(g.file, { force: true });
}

/** Replace the lock under the guard when it is still the abandoned one the caller saw. */
function replaceSeen(path: string, seen: number | null): boolean {
  const now = lockHolder(path);
  const gone = now === null ? olderThan(path, LOCK_GRACE_MS) : !alive(now);
  if (!gone || now !== seen) return false;
  rmSync(path, { force: true });
  return publishLock(path);
}

/**
 * Replace a lock the caller saw to be abandoned. Contenders serialize on a
 * guard and re-read the lock under it, so a lock another tick took in the
 * meantime is left alone. A guard is never removed on someone else's
 * observation: a contender publishes the guard of the generation after the
 * newest one, whose owner is gone or which is marked finished, and yields when
 * a newer generation than its own exists. The newest guard is kept, so
 * generations only grow and two contenders never hold the same abandoned lock
 * at once.
 */
function reclaim(path: string, seen: number | null): boolean {
  const newest = guardsOf(path).at(-1);
  if (newest !== undefined && !ownerGone(newest.file)) return false;
  const generation = (newest?.generation ?? 0) + 1;
  const guard = `${path}.reclaim.${generation}`;
  if (!publishLock(guard)) return false;
  try {
    return (
      !guardsOf(path).some((g) => g.generation > generation) &&
      replaceSeen(path, seen)
    );
  } finally {
    writeFileSync(guard, FINISHED);
    sweepGuards(path);
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
