/** Adapt the host's lock and launch records to the validation forecast. */
import { dirname, resolve } from "node:path";
import { lockPlace } from "../../shared/resource-lock-waits.ts";
import { MAX_TIMEOUT_SECONDS } from "../../shared/resource-lock.ts";
import { readResourceLockSamples } from "../../shared/resource-lock-samples.ts";
import { parseMs } from "../../shared/time.ts";
import type { LineLoadGauge } from "./dashboard-contract.ts";
import { holds, type ReadRecord } from "./launches.ts";
import type { LoadReading } from "./load-read.ts";
import { DEFAULT_PICKUP_DEADLINE_MS } from "./section.ts";
import {
  forecastValidation,
  measureValidation,
  validationDemand,
  type ValidationDemand,
  type ValidationForecast,
  type ValidationKind,
  type ValidationMeasurements,
  type ValidationPass,
} from "./validation-capacity.ts";

export interface ValidationLoad {
  measured: ValidationMeasurements;
  demand: ValidationDemand | { unread: string };
  /** How long a launched pass's test stage waits for the lock. */
  waitLimitMs: number;
  /** Where `waitLimitMs` came from, for the reason a person reads. */
  waitSource: string;
  /** Set when the launch's `LOCK_TIMEOUT` is one the lock refuses: validation fails at once. */
  waitInvalid?: string;
  driveDeadlineMs: number;
  admittedRuns: number;
}

/**
 * How long a pass's test stage waits for the lock when `LOCK_TIMEOUT` is
 * unset: an hour, the wait the test stage gives a heavy run (Jig's own
 * `scripts/test.ts`, the launcher's and gc's heavy runs). The lock's own
 * minute (`DEFAULT_TIMEOUT_SECONDS`) is the wait of a bare lock call, which
 * no pass's validation uses.
 */
export const PASS_LOCK_WAIT_SECONDS = 3600;

/**
 * The wait a launched pass's validation has. `env` is the
 * environment a pass is launched with, so it holds `LOCK_TIMEOUT` only where
 * `process.env_keep` retains it. Its test stage waits that value; unset or
 * empty, it waits its own hour, and the source says which default stands in.
 * A value the lock refuses is reported, never replaced by the hour.
 */
export function passLockWait(
  env: Record<string, string | undefined>,
): Pick<ValidationLoad, "waitLimitMs" | "waitSource" | "waitInvalid"> {
  const timeout = env.LOCK_TIMEOUT ?? "";
  const seconds = Number(timeout);
  if (/^[0-9]+$/.test(timeout) && seconds <= MAX_TIMEOUT_SECONDS)
    return { waitLimitMs: seconds * 1000, waitSource: "LOCK_TIMEOUT" };
  if (timeout !== "")
    return {
      waitLimitMs: 0,
      waitSource: "LOCK_TIMEOUT not usable",
      waitInvalid: `LOCK_TIMEOUT=${timeout} is not a whole number of seconds from 0 to ${MAX_TIMEOUT_SECONDS}, so a launched pass's validation is refused by the lock`,
    };
  const why = "LOCK_TIMEOUT unset";
  return {
    waitLimitMs: PASS_LOCK_WAIT_SECONDS * 1000,
    waitSource: `default: the test stage's hour, ${why}`,
  };
}

function passOf({ record, state }: ReadRecord): ValidationPass | null {
  const { action } = record;
  if (action === "followup" || action === "steward") return null;
  if (!holds(state) && state.kind !== "ended") return null;
  const launchedAt =
    state.kind === "pending"
      ? record.createdAt
      : (state.process?.claimedAt ?? record.createdAt);
  return {
    kind: action === "pickup" ? action : "drive",
    workspace: record.workspace ? resolve(record.workspace.path) : null,
    launchedAtMs: parseMs(launchedAt),
    ...(state.kind === "ended" ? { endedAtMs: parseMs(state.exit.at) } : {}),
  };
}

/** Find the closest launch workspace containing the lock command's working directory. */
function workspaceOf(
  cwd: string | null,
  workspaces: ReadonlySet<string>,
): string | null {
  if (cwd === null) return null;
  let path = resolve(cwd);
  for (;;) {
    if (workspaces.has(path)) return path;
    const parent = dirname(path);
    if (parent === path) return null;
    path = parent;
  }
}

export function readValidationLoad(
  records: readonly ReadRecord[],
  lock: LoadReading["lock"],
  nowMs: number,
  driveDeadlineMs: number,
  env: Record<string, string | undefined> = process.env,
): ValidationLoad {
  const { name } = lockPlace(env);
  const passes = records.flatMap((record) => passOf(record) ?? []);
  const workspaces = new Set(
    passes.flatMap(({ workspace }) => workspace ?? []),
  );
  const samples = readResourceLockSamples(name, nowMs, env).map(
    ({ workspace, requestedAt, waitMs, holdMs }) => ({
      workspace: workspaceOf(workspace, workspaces),
      requestedAtMs: parseMs(requestedAt),
      waitMs,
      holdMs,
    }),
  );
  const measured = measureValidation(samples, passes);
  return {
    measured,
    demand:
      "unread" in lock
        ? lock
        : validationDemand(
            measured,
            lock.runs?.map(({ workspace }) => ({
              workspace: workspaceOf(workspace, workspaces),
            })) ??
              Array.from({ length: lock.holders + lock.waiters }, () => ({
                workspace: null,
              })),
            passes.filter(({ endedAtMs }) => endedAtMs === undefined),
            samples,
          ),
    ...passLockWait(env),
    driveDeadlineMs,
    admittedRuns: 0,
  };
}

function forecast(
  state: ValidationLoad,
  kind: ValidationKind,
  deadlineMs: number,
  admittedRuns: number,
  demand?: ValidationDemand,
  waitLimitMs = state.waitLimitMs,
): ValidationForecast | null {
  if ("unread" in state.demand) return null;
  return forecastValidation(
    state.measured,
    kind,
    demand ?? state.demand,
    waitLimitMs,
    deadlineMs || Infinity,
    admittedRuns,
  );
}

function describe(state: ValidationLoad, result: ValidationForecast): string {
  const { concurrency, runMs } = state.measured;
  const ahead = Number(result.ahead.toFixed(2));
  const minutes = (ms: number) => Math.round(ms / 60_000);
  const waited = minutes((result.ahead * runMs) / concurrency);
  const defaults = state.measured.defaults;
  const note = defaults.length > 0 ? ` (defaults: ${defaults.join(", ")})` : "";
  const span =
    result.waitWindowMs < 60_000
      ? `${Math.round(result.waitWindowMs / 1000)} s`
      : `${minutes(result.waitWindowMs)} min`;
  const cut =
    result.waitWindowMs < state.waitLimitMs
      ? ", limited by the pass deadline"
      : "";
  const window = `${span} wait window (${state.waitSource}${cut})`;
  // A window shorter than one run cannot hold a wait for a slot's release:
  // the gauge then admits a pass only while a slot is free, or about to
  // be, for its first run. Say so with its figures, so a misconfigured window reads as one
  // rather than as a busy host.
  const short =
    result.waitWindowMs < runMs
      ? `; the wait window is shorter than one run, so a pass is admitted only while a slot is free, or about to be, for its first run (${Number(result.ownRuns.toFixed(2))} runs per pass)`
      : "";
  return `${ahead} runs ahead, about ${waited} min at ${concurrency} concurrent runs of ${minutes(runMs)} min, capacity ${Number(result.capacity.toFixed(2))} in a ${window}${short}${note}`;
}

export function validationHold(
  state: ValidationLoad,
  line: number,
  kind: ValidationKind,
  pickupDeadlineMs: number,
): string | null {
  // A launch setting the lock refuses fails validation whatever the lock's
  // occupancy, so it is judged before the occupancy reading.
  if (state.waitInvalid !== undefined)
    return `waits on validation capacity: ${state.waitInvalid}`;
  if ("unread" in state.demand) return null;
  const deadline = kind === "pickup" ? pickupDeadlineMs : state.driveDeadlineMs;
  const own = forecast(state, kind, deadline, state.admittedRuns);
  if (own === null) return null;
  if (own.fill === null || own.fill > line)
    return `waits on validation capacity: ${describe(state, own)}`;
  if (kind === "pickup") {
    // Reserve this pickup and a drive in the pickup's window. The independent
    // drive-window check only judges work committed before this pickup, which
    // has not yet been admitted by its caller.
    // An immediately admitted pickup still occupies its slot when a drive
    // arrives next. Reserve every run this pickup commits, not only runs that
    // wait before their own acquisition.
    // A reserved drive starts after this pickup has begun. Its measured time
    // to validation is therefore time in which the pickup's whole service
    // waves can finish. Keep only the runs that can still occupy the lock
    // when that downstream drive asks for it.
    const completedBeforeDrive =
      state.measured.concurrency *
      Math.floor(
        state.measured.kinds.drive.timeToValidationMs / state.measured.runMs,
      );
    // Work already forecast ahead of this pickup spends the early service
    // first. Only remaining service can complete the pickup before a drive
    // reaches validation; otherwise the pickup is incorrectly given the same
    // capacity credit as its predecessors.
    const predecessorRuns =
      state.demand.atLock + state.demand.toArrive + state.admittedRuns;
    const pickupCompletedBeforeDrive = Math.max(
      0,
      Math.min(own.ownRuns, completedBeforeDrive - predecessorRuns),
    );
    const stillRunning = Math.max(0, own.ownRuns - pickupCompletedBeforeDrive);
    const reservedDemand: ValidationDemand = {
      // Only work already at the lock may consume service before the drive
      // arrives. Admitted passes still have to reach validation, even when
      // their eventual runs are being reserved for this downstream drive.
      atLock: state.demand.atLock,
      toArrive: state.demand.toArrive + state.admittedRuns + stillRunning,
    };
    const reserved = forecast(
      state,
      "drive",
      0,
      0,
      reservedDemand,
      own.waitWindowMs,
    );
    const drive = forecast(
      state,
      "drive",
      state.driveDeadlineMs,
      state.admittedRuns,
    );
    for (const result of [reserved, drive]) {
      if (result !== null && (result.fill === null || result.fill > line))
        return `waits on validation capacity to keep room for a drive: ${describe(state, result)}`;
    }
  }
  return null;
}

/** A representative new pickup on the default deadline, before this tick spends capacity. */
export function validationGauge(
  state: ValidationLoad,
  share: number,
): LineLoadGauge {
  const line = `${Math.round(share * 100)}% of validation capacity`;
  const result = forecast(state, "pickup", DEFAULT_PICKUP_DEADLINE_MS, 0);
  const reads =
    state.waitInvalid !== undefined
      ? state.waitInvalid
      : result === null
        ? "unread" in state.demand
          ? state.demand.unread
          : "test lock unread"
        : describe(state, result);
  return {
    gauge: "validation",
    fill:
      state.waitInvalid !== undefined
        ? // Refused outright, as an unfit forecast is: at the line.
          1
        : result === null
          ? null
          : Math.min((result.fill ?? share) / share, Number.MAX_SAFE_INTEGER),
    reads,
    line,
  };
}
