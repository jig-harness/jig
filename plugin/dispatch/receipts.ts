/**
 * One receipt per tick under `~/.local/state/jig/dispatch/receipts/<date>/`:
 * the records the tick read and from where, and each action it planned with
 * its reason. The next tick reads the latest receipt for the date the
 * follow-up stage started per repository (`followupSince`), so that window
 * stays where it began however often the tick runs.
 *
 * A tick removes receipts older than the retention, keeping the latest
 * completed one whatever its age.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isMapping } from "../shared/config-layers.ts";
import type { RepoReport } from "./lib/types.ts";

/** Days a receipt is kept; the machine file sets it once there is one. */
export const RETENTION_DAYS = 30;

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

/** A receipt, or `null` when the file does not hold one. */
export function readReceipt(path: string): TickReceipt | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isMapping(value) &&
      value.version === 1 &&
      typeof value.runId === "string" &&
      typeof value.startedAt === "string" &&
      Array.isArray(value.repos)
      ? (value as unknown as TickReceipt)
      : null;
  } catch {
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

/** Remove receipts past the retention, keeping the latest completed one. */
export function pruneReceipts(
  nowMs: number,
  root = stateRoot(),
  days = RETENTION_DAYS,
): string[] {
  const paths = receiptPaths(root);
  const keep = [...paths]
    .reverse()
    .find((p) => readReceipt(p)?.completed === true);
  const cutoff = nowMs - days * 86_400_000;
  const removed: string[] = [];
  for (const path of paths) {
    if (path === keep) continue;
    const day = Date.parse(`${basename(dirname(path))}T00:00:00Z`);
    if (!Number.isFinite(day) || day + 86_400_000 > cutoff) continue;
    rmSync(path, { force: true });
    removed.push(path);
  }
  return removed;
}

/** The tick lock: one tick per machine. Returns its release, or the holder. */
export function takeTickLock(
  root = stateRoot(),
): { release: () => void } | { heldBy: string } {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "tick.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return { release: () => rmSync(path, { force: true }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const text = readFileSync(path, "utf8").trim();
      // An empty lock is one another tick is still writing.
      if (text === "") return { heldBy: path };
      const holder = Number(text);
      if (!Number.isSafeInteger(holder) || holder <= 0 || alive(holder))
        return { heldBy: `process ${holder} (${path})` };
      // The holder is gone: the lock is stale, and taken once more.
      rmSync(path, { force: true });
    }
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
