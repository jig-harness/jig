// How busy this machine is, read one way for every Jig mechanism that asks
// whether the host can carry one more run: the resource lock's load
// admission, and the dispatcher's load factor. One reading and one rule, so
// two mechanisms never disagree about the same host.
//
// The reading is the one-minute load average, the core count and the memory
// a new process can have without swapping. A platform with no load average
// (Windows reports zeros) gives no load, and the rule then decides by memory
// alone. Memory is Linux's `MemAvailable`; elsewhere the free memory the
// platform reports, which counts reclaimable caches as used and so errs
// toward refusing.
import { readFileSync } from "node:fs";
import { availableParallelism, freemem, loadavg } from "node:os";
import { swallow } from "./errors.ts";

/** One reading of the host. */
export interface HostLoad {
  /** The one-minute load average; null where the platform keeps none. */
  load1: number | null;
  /** The processors this process may use. */
  cores: number;
  /** Bytes a new process can have without swapping; null when unreadable. */
  availableBytes: number | null;
}

const GIB = 1024 ** 3;

/** `MemAvailable` from a `/proc/meminfo` text, in bytes, or null. */
export function memAvailable(meminfo: string): number | null {
  const match = /^MemAvailable:\s+(\d+) kB/m.exec(meminfo);
  return match ? Number(match[1]) * 1024 : null;
}

/** Read this host's load and memory now. */
export function readHostLoad(
  platform: NodeJS.Platform = process.platform,
  meminfo = "/proc/meminfo",
): HostLoad {
  let availableBytes: number | null = null;
  if (platform === "linux")
    try {
      availableBytes = memAvailable(readFileSync(meminfo, "utf8"));
    } catch (error) {
      swallow(
        error,
        "no /proc/meminfo; the free memory the platform reports stands in",
      );
    }
  if (availableBytes === null) {
    const free = freemem();
    availableBytes = Number.isFinite(free) && free > 0 ? free : null;
  }
  const load = loadavg()[0];
  return {
    load1:
      platform === "win32" || load === undefined || !Number.isFinite(load)
        ? null
        : load,
    cores: Math.max(1, availableParallelism()),
    availableBytes,
  };
}

/** How much of the host one more run may take. */
export interface AdmissionPolicy {
  /** The share of the cores the predicted load must stay under. */
  targetUtilization: number;
  /** The load one run adds once it is running. */
  runCost: number;
  /** The available memory that must remain, in bytes. */
  minAvailableBytes: number;
}

/** The runs already admitted: how many, and how many started too recently for the load average to show. */
export interface Running {
  count: number;
  fresh: number;
}

export type Admission =
  | { admit: true; reason: string }
  | { admit: false; binds: "load" | "memory"; reason: string };

/**
 * Whether one more run fits. The first run always does, so a queue always
 * moves. Otherwise the predicted load (the one-minute average, plus one
 * run's cost for each run started too recently for the average to show)
 * with one more run's cost on top must stay under the cores times the
 * target, and the available memory must stay above the floor.
 */
export function roomForOneMore(
  host: HostLoad,
  running: Running,
  policy: AdmissionPolicy,
): Admission {
  if (running.count === 0)
    return { admit: true, reason: "no run holds a slot" };
  const limit = host.cores * policy.targetUtilization;
  const predicted =
    host.load1 === null ? null : host.load1 + policy.runCost * running.fresh;
  if (predicted !== null && predicted + policy.runCost > limit)
    return {
      admit: false,
      binds: "load",
      reason: `predicted load ${predicted.toFixed(1)} + ${policy.runCost} for one more run exceeds ${limit.toFixed(1)} (${host.cores} cores × ${policy.targetUtilization})`,
    };
  if (
    host.availableBytes !== null &&
    host.availableBytes < policy.minAvailableBytes
  )
    return {
      admit: false,
      binds: "memory",
      reason: `${(host.availableBytes / GIB).toFixed(1)} GiB available, below the ${(policy.minAvailableBytes / GIB).toFixed(1)} GiB floor`,
    };
  return {
    admit: true,
    reason:
      predicted === null
        ? "memory leaves room for one more run"
        : `predicted load ${predicted.toFixed(1)} + ${policy.runCost} fits under ${limit.toFixed(1)}`,
  };
}
