/** Durable observations of cooperative passes; unknown launch windows never authorize recovery. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../../../shared/guards.ts";
import { log } from "../../../../shared/log.ts";
import { failureFields, swallow } from "../../../../shared/errors.ts";
import {
  captureIdentity,
  judge,
  thisHost,
  type ProcessIdentity,
} from "../../../../shared/liveness.ts";
import {
  processTable,
  type ProcessRow,
} from "../../../../shared/process-table.ts";
import { captureRegisteredProcessTrees } from "../../../../shared/process-tree.ts";
import { partitionProcessTree } from "../../../../shared/process-uncertainty.ts";
import { inspectLock, prLockName } from "./driver/locks.ts";
import { reserveDeadDriver } from "./driver-recovery.ts";
import { run, type RunOptions, type RunResult } from "./proc.ts";

interface Observation {
  version: 1;
  nonce: string;
  started: string;
  driver: ProcessIdentity;
  registry: string | null;
  pending: boolean;
  uncertain: boolean;
  targets: Array<Pick<ProcessRow, "pid" | "start">>;
  groups: number[];
}

/** Acquisition-keyed: a later driver cannot overwrite its predecessor's observations. */
export function observationPath(
  stateDir: string,
  pr: string,
  started: string,
): string {
  const token = createHash("sha256").update(started).digest("hex").slice(0, 32);
  return join(stateDir, `drive-observation-${pr}-${token}.json`);
}

function publish(path: string, value: Observation): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

let active: { path: string; value: Observation } | null = null;

/** Called under both driver locks, before any pass may be spawned. */
export async function startDriverObservation(
  stateDir: string,
  pr: string,
  started: string,
  registry: string | null,
  nonce: string,
): Promise<void> {
  active = null;
  const identity = await captureIdentity();
  // An unreadable driver identity allows ordinary work, but never crash recovery.
  if (!identity.ok) {
    log.warn(
      "persistent driver observations disabled: driver identity unavailable",
      { ...identity.failure, ...failureFields(identity.failure.cause) },
    );
    return;
  }
  const value: Observation = {
    version: 1,
    nonce,
    started,
    driver: identity.value,
    registry,
    pending: false,
    uncertain: false,
    targets: [],
    groups: [],
  };
  const path = observationPath(stateDir, pr, started);
  publish(path, value);
  active = { path, value };
}

/** Persist the unknown spawn interval before run() can start any child. */
export async function runObservedPass(
  argv: string[],
  options: RunOptions,
  table = processTable,
): Promise<RunResult> {
  const acquisition = active;
  if (acquisition === null) return run(argv, options);
  acquisition.value.pending = true;
  publish(acquisition.path, acquisition.value);
  let childPid: number | undefined;
  let childGone = false;
  let captured = false;
  let sampling: Promise<void> | null = null;
  const sample = (): Promise<void> => {
    if (sampling !== null) return sampling;
    sampling = (async () => {
      if (childPid === undefined) return;
      // Keep the previous snapshot unusable throughout a new read or publication.
      acquisition.value.pending = true;
      publish(acquisition.path, acquisition.value);
      const rows = await table();
      if (rows === null) {
        acquisition.value.uncertain = true;
      } else {
        if (capturePassRoot(acquisition.value, rows, childPid, childGone))
          captured = true;
        acquisition.value.targets = liveTargets(acquisition.value, rows);
        acquisition.value.groups = acquisition.value.groups.filter((group) =>
          rows.some((row) => row.pgid === group && !row.stat.startsWith("Z")),
        );
        acquisition.value.pending = !captured;
        // An absent root cannot clear a launch we never captured.
      }
      publish(acquisition.path, acquisition.value);
    })().finally(() => {
      sampling = null;
    });
    return sampling;
  };
  const timer = setInterval(() => {
    void sample().catch((error) => {
      acquisition.value.uncertain = true;
      swallow(
        error,
        "pass observation could not be refreshed; crash recovery remains unknown",
      );
    });
  }, 250);
  timer.unref();
  try {
    return await run(argv, {
      ...options,
      onSpawn: (handle) => {
        childPid = handle.pid;
        void handle.exited.then(() => {
          childGone = true;
        });
        void sample().catch((error) => {
          acquisition.value.uncertain = true;
          swallow(error, "pass identity could not be retained");
        });
        options.onSpawn?.(handle);
      },
    });
  } finally {
    clearInterval(timer);
    if (sampling !== null) await sampling;
    if (childPid !== undefined && !captured) {
      acquisition.value.uncertain = true;
      publish(acquisition.path, acquisition.value);
    }
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function creationIdentity(
  value: unknown,
): value is Pick<ProcessRow, "pid" | "start"> {
  return (
    isRecord(value) &&
    positiveInteger(value.pid) &&
    typeof value.start === "string" &&
    value.start !== ""
  );
}

function driverIdentity(value: unknown): value is ProcessIdentity {
  if (!isRecord(value)) return false;
  const fields = [value.hostId, value.host, value.bootId];
  return (
    creationIdentity(value) &&
    fields.every((field) => typeof field === "string")
  );
}

function isObservation(v: unknown): v is Observation {
  if (
    !isRecord(v) ||
    v.version !== 1 ||
    typeof v.nonce !== "string" ||
    !v.nonce ||
    typeof v.started !== "string" ||
    v.pending !== false ||
    v.uncertain !== false
  )
    return false;
  if (!driverIdentity(v.driver)) return false;
  if (v.registry !== null && typeof v.registry !== "string") return false;
  return (
    Array.isArray(v.targets) &&
    v.targets.every(creationIdentity) &&
    Array.isArray(v.groups) &&
    v.groups.every(positiveInteger)
  );
}

/** Capture only the still-owned child, retaining every observed creation identity. */
function capturePassRoot(
  value: Observation,
  rows: ProcessRow[],
  pid: number,
  gone: boolean,
): boolean {
  const root = rows.find((r) => r.pid === pid);
  if (gone || !root?.start || root.ppid !== process.pid) return false;
  if (process.platform !== "win32" && root.pgid !== root.pid) return false;
  const previous = value.targets.filter((r) => r.pid === pid);
  if (previous.length > 0 && !previous.some((r) => r.start === root.start))
    return false;
  const found = partitionProcessTree(root.pid, rows);
  if (found.uncertain.length > 0) value.uncertain = true;
  retainPassIdentities(value, found.targets);
  if (root.pgid === root.pid && !value.groups.includes(root.pgid))
    value.groups.push(root.pgid);
  return true;
}

function retainPassIdentities(value: Observation, targets: ProcessRow[]): void {
  for (const target of targets) {
    if (
      value.targets.some(
        (r) => r.pid === target.pid && r.start === target.start,
      )
    )
      continue;
    value.targets.push({ pid: target.pid, start: target.start });
  }
}

/** Only a positive death verdict retires an identity, including across time zones. */
function liveTargets(
  value: Observation,
  rows: ProcessRow[],
): Observation["targets"] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return value.targets.filter((target) => {
    const row = byPid.get(target.pid);
    const verdict = judge(
      { ...value.driver, ...target },
      row ? [row] : [],
      thisHost(),
    );
    return !verdict.ok || verdict.value.state !== "dead";
  });
}

/** Strictly read an owned acquisition; legacy, damaged and incomplete observations stay unknown. */
function readObservation(path: string, started: string): Observation | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObservation(v) && v.started === started ? v : null;
  } catch (error) {
    swallow(
      error,
      "driver observations are absent or unreadable; crash recovery withheld",
    );
    return null;
  }
}

/** No signals: establish only that the observed and registered work has ended. */
export async function observedDriverGone(
  stateDir: string,
  pr: string,
  record: { started: string; pid: number; host: string },
  table = processTable,
): Promise<boolean> {
  const v = readObservation(
    observationPath(stateDir, pr, record.started),
    record.started,
  );
  if (
    v === null ||
    v.driver.pid !== record.pid ||
    v.driver.host !== record.host
  )
    return false;
  const lock = inspectLock(stateDir, prLockName(pr));
  if (
    lock === null ||
    lock.nonce !== v.nonce ||
    lock.diag?.started !== record.started ||
    lock.pid !== v.driver.pid ||
    // The nonce and acquisition time bind Windows locks, which omit start.
    (lock.start !== "" && lock.start !== v.driver.start)
  )
    return false;
  const rows = await table();
  const verdict = judge(v.driver, rows, thisHost());
  if (!verdict.ok || verdict.value.state !== "dead" || rows === null)
    return false;
  if (liveTargets(v, rows).length > 0) return false;
  if (
    v.groups.some((g) =>
      rows.some((r) => r.pgid === g && !r.stat.startsWith("Z")),
    )
  )
    return false;
  if (v.registry !== null) {
    const registered = await captureRegisteredProcessTrees(v.registry, () =>
      Promise.resolve(rows),
    );
    if (registered === null || registered.some((r) => !r.stat.startsWith("Z")))
      return false;
  }
  return true;
}

/** Drop only this acquisition's observation when a durable released witness replaces it. */
export function removeDriverObservation(
  stateDir: string,
  pr: string,
  started: string,
): void {
  const path = observationPath(stateDir, pr, started);
  if (active?.path === path) active = null;
  rmSync(path, { force: true });
}

/** Hold the PR driver slot during reconciliation so an unpublished successor cannot be overwritten. */
export async function recoverObservedDriver(
  stateDir: string,
  pr: string,
  record: { started: string; pid: number; host: string; worktree: string },
  recover: () => Promise<void>,
): Promise<boolean> {
  if (!(await observedDriverGone(stateDir, pr, record))) return false;
  return reserveDeadDriver(
    stateDir,
    pr,
    record,
    async () => {
      removeDriverObservation(stateDir, pr, record.started);
      await recover();
    },
    true,
  );
}
