/**
 * One reading of the host for the load factor (`load.ts`), taken once per
 * tick under the act lock: the host's load and memory as the resource lock
 * reads them (`shared/host-load.ts`, one reading for both), the test lock's
 * holders and waiters (`shared/resource-lock.ts`), the free space of the
 * filesystems the workspaces live on, the forge's budget the tick read at
 * its start, and the memory the processes in each session's workspace use.
 *
 * A process's working directory is read from `/proc` on Linux; elsewhere no
 * session's memory is read, and each kind's default reservation stands.
 *
 * `JIG_DISPATCH_LOAD_READING` names a JSON file whose fields replace the
 * host's own readings (`ReadingOverride`), so a test sees a host of its
 * choosing.
 */
import { readdirSync, readFileSync, readlinkSync, statfsSync } from "node:fs";
import { totalmem } from "node:os";
import { join, sep } from "node:path";
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import { type HostLoad, readHostLoad } from "../../shared/host-load.ts";
import { lockOccupancy, lockPlace } from "../../shared/resource-lock.ts";
import { failureText } from "./text.ts";
import type { TickBudget } from "./tick-reads.ts";

/** A gauge's reading, or why the host gave none. */
export type Read<T> = T | { unread: string };

export interface LoadReading {
  host: HostLoad;
  /** The host's memory in bytes. */
  totalBytes: number;
  platform: NodeJS.Platform;
  disk: Read<{ freeBytes: number; totalBytes: number; path: string }>;
  lock: Read<{ holders: number; waiters: number }>;
  forge: Read<{ remaining: number; limit: number }>;
  /** The bytes the processes in each workspace use, by its path; `null` where the platform shows no process's working directory. */
  sessions: Map<string, number> | null;
}

/** The fields a test's reading file may set. */
interface ReadingOverride {
  load1?: number | null;
  cores?: number;
  availableBytes?: number | null;
  totalBytes?: number;
  diskFreeBytes?: number;
  diskTotalBytes?: number;
  lockHolders?: number;
  lockWaiters?: number;
  sessions?: Record<string, number>;
}

/** `VmRSS` from a `/proc/<pid>/status` text, in bytes, or null. */
export function residentBytes(status: string): number | null {
  const match = /^VmRSS:\s+(\d+) kB/m.exec(status);
  return match ? Number(match[1]) * 1024 : null;
}

/**
 * The memory the processes whose working directory is in each of `paths`
 * use, summed per path, from `/proc`. A process another user owns, or one
 * that ended while it was read, is passed over.
 */
export function workspaceMemory(
  paths: readonly string[],
  proc = "/proc",
): Map<string, number> {
  const out = new Map(paths.map((p) => [p, 0]));
  if (paths.length === 0) return out;
  let pids: string[] = [];
  try {
    pids = readdirSync(proc).filter((p) => /^\d+$/.test(p));
  } catch (error) {
    swallow(error, "no process table: no session's memory is read");
  }
  for (const pid of pids) {
    let cwd: string;
    let status: string;
    try {
      cwd = readlinkSync(join(proc, pid, "cwd"));
      status = readFileSync(join(proc, pid, "status"), "utf8");
    } catch (error) {
      swallow(error, "a process of another user, or one that ended");
      continue;
    }
    const owner = paths
      .filter((p) => cwd === p || cwd.startsWith(p + sep))
      .sort((a, b) => b.length - a.length)[0];
    const bytes = owner === undefined ? null : residentBytes(status);
    if (owner !== undefined && bytes !== null)
      out.set(owner, (out.get(owner) ?? 0) + bytes);
  }
  return out;
}

/** The least free space among the filesystems holding `paths`. */
function readDisk(paths: readonly string[]): LoadReading["disk"] {
  let least: { freeBytes: number; totalBytes: number; path: string } | null =
    null;
  const failures: string[] = [];
  for (const path of new Set(paths)) {
    try {
      const fs = statfsSync(path);
      const freeBytes = Number(fs.bavail) * Number(fs.bsize);
      if (least === null || freeBytes < least.freeBytes)
        least = {
          freeBytes,
          totalBytes: Number(fs.blocks) * Number(fs.bsize),
          path,
        };
    } catch (error) {
      failures.push(`${path}: ${failureText(error)}`);
    }
  }
  if (failures.length > 0)
    return { unread: `free space not read (${failures.join("; ")})` };
  return least ?? { unread: "no workspace to read free space at" };
}

function readLock(env: NodeJS.ProcessEnv): LoadReading["lock"] {
  try {
    const { root, name } = lockPlace(env);
    return lockOccupancy(root, name);
  } catch (error) {
    return { unread: `the test lock not read: ${failureText(error)}` };
  }
}

function forgeOf(budget: TickBudget): LoadReading["forge"] {
  return "unreadable" in budget
    ? { unread: `the forge's budget not read: ${budget.unreadable}` }
    : { remaining: budget.remaining, limit: budget.limit };
}

function override(env: NodeJS.ProcessEnv): ReadingOverride | null {
  const path = env.JIG_DISPATCH_LOAD_READING;
  if (path === undefined || path === "") return null;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isMapping(parsed) ? (parsed as ReadingOverride) : null;
}

/**
 * Read the host now: `workspaces` are the running sessions' workspaces,
 * whose processes' memory is summed, and `disks` the paths whose
 * filesystems' free space is read (the workspaces and the repositories).
 */
export function readLoad(
  workspaces: readonly string[],
  disks: readonly string[],
  budget: TickBudget,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): LoadReading {
  const given = override(env);
  const host = readHostLoad(platform);
  const reading: LoadReading = {
    host,
    totalBytes: totalmem(),
    platform,
    disk: readDisk([...workspaces, ...disks]),
    lock: readLock(env),
    forge: forgeOf(budget),
    sessions: platform === "linux" ? workspaceMemory(workspaces) : null,
  };
  if (given === null) return reading;
  return {
    ...reading,
    host: {
      load1: given.load1 === undefined ? host.load1 : given.load1,
      cores: given.cores ?? host.cores,
      availableBytes:
        given.availableBytes === undefined
          ? host.availableBytes
          : given.availableBytes,
    },
    totalBytes: given.totalBytes ?? reading.totalBytes,
    disk:
      given.diskFreeBytes === undefined
        ? reading.disk
        : {
            freeBytes: given.diskFreeBytes,
            totalBytes: given.diskTotalBytes ?? given.diskFreeBytes * 2,
            path: disks[0] ?? "",
          },
    lock:
      given.lockWaiters === undefined
        ? reading.lock
        : { holders: given.lockHolders ?? 0, waiters: given.lockWaiters },
    sessions:
      given.sessions === undefined
        ? reading.sessions
        : new Map(Object.entries(given.sessions)),
  };
}
