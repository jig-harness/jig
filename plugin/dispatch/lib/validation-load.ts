/** Adapt the host's lock and launch records to the validation forecast. */
import { dirname, resolve } from "node:path";
import { lockPlace } from "../../shared/resource-lock-waits.ts";
import { MAX_TIMEOUT_SECONDS } from "../../shared/resource-lock.ts";
import type { HostLoad } from "../../shared/host-load.ts";
import { readResourceLockSamples } from "../../shared/resource-lock-samples.ts";
import { parseMs } from "../../shared/time.ts";
import type { LineLoadGauge } from "./dashboard-contract.ts";
import { holds, type ReadRecord } from "./launches.ts";
import type { LoadReading } from "./load-read.ts";
import { DEFAULT_PICKUP_DEADLINE_MS } from "./section.ts";
import { lockSlots } from "./validation-slots.ts";
import {
  forecastValidation,
  measurementsFor,
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
  /** Why the lock's slot count was not read, so runs at once is the peak the samples saw. */
  slotsUnread?: string;
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

function launchedAtOf({ record, state }: ReadRecord): string {
  return state.kind !== "pending"
    ? (state.process?.claimedAt ?? record.createdAt)
    : record.createdAt;
}

function passOf(read: ReadRecord): ValidationPass | null {
  const { record, state } = read;
  const { action } = record;
  if (action === "followup" || action === "steward") return null;
  if (!holds(state) && state.kind !== "ended") return null;
  return {
    kind: action === "pickup" ? action : "drive",
    workspace: record.workspace ? resolve(record.workspace.path) : null,
    repo: record.repo,
    launchedAtMs: parseMs(launchedAtOf(read)),
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

/** The launch records as the validation passes the measurements read. */
export function validationPassesOf(
  records: readonly ReadRecord[],
): ValidationPass[] {
  return records.flatMap((record) => passOf(record) ?? []);
}

/**
 * The slots the lock admits now, from the host's reading and the lock's
 * holders the load average shows, or why they cannot be read. A reading
 * that does not say which holders it shows takes none out of the load.
 */
function slotsOf(
  host: HostLoad | undefined,
  lock: LoadReading["lock"],
  env: Record<string, string | undefined>,
): { slots: number } | { unread: string } {
  if (host === undefined) return { unread: "no host reading" };
  if ("unread" in lock) return { unread: lock.unread };
  const slots = lockSlots(host, lock.settled ?? 0, env);
  return slots.ok ? { slots: slots.value } : { unread: slots.failure.reason };
}

export function readValidationLoad(
  records: readonly ReadRecord[],
  lock: LoadReading["lock"],
  nowMs: number,
  driveDeadlineMs: number,
  env: Record<string, string | undefined> = process.env,
  host?: HostLoad,
): ValidationLoad {
  const { name } = lockPlace(env);
  const passes = validationPassesOf(records);
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
  const slots = slotsOf(host, lock, env);
  const measured = measureValidation(
    samples,
    passes,
    "slots" in slots ? slots.slots : null,
  );
  return {
    measured,
    ...("unread" in slots ? { slotsUnread: slots.unread } : {}),
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
            nowMs,
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

/** Where runs at once came from, when not only from the samples. */
function concurrencySource(state: ValidationLoad): string {
  const { concurrency, lockSlots: slots } = state.measured;
  if (slots !== undefined)
    return slots === concurrency
      ? ` (the lock's load check admits ${slots})`
      : ` (the most seen together; the lock's load check admits ${slots})`;
  return state.slotsUnread === undefined
    ? ""
    : ` (the most seen together; the lock's slot count unread: ${state.slotsUnread})`;
}

/** The candidate's own run time, when its repository's differs from every repository's. */
function ownRunTime(measured: ValidationMeasurements): string {
  const own = measured.candidateRunMs;
  return own === undefined || own === measured.runMs
    ? ""
    : `, its repository's runs ${Math.round(own / 60_000)} min`;
}

function describe(state: ValidationLoad, result: ValidationForecast): string {
  const { concurrency, runMs } = state.measured;
  const ahead = Number(result.ahead.toFixed(2));
  const minutes = (ms: number) => Math.round(ms / 60_000);
  const waited = minutes((result.required * runMs) / concurrency);
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
  // The runs credited as served say why a pass is admitted with work in
  // flight; the runs ahead, why one waits.
  const served =
    result.served > 0
      ? ` (${result.served} in flight served before it reaches the lock)`
      : "";
  const later =
    result.later > 0
      ? `, and ${result.later} arriving after its first run ahead of a later one`
      : "";
  return `${ahead} runs ahead${served}${later}, about ${waited} min at ${concurrency} concurrent runs${concurrencySource(state)} of ${minutes(runMs)} min${ownRunTime(state.measured)}, capacity ${Number(result.capacity.toFixed(2))} in a ${window}${short}${note}`;
}

/**
 * A relaunch told to push at once reaches the lock without the pickup's usual
 * delay, so its own kind is forecast arriving immediately.
 */
function arrivingAt(
  measured: ValidationMeasurements,
  kind: ValidationKind,
  immediate: boolean,
): ValidationMeasurements {
  if (!immediate) return measured;
  return {
    ...measured,
    kinds: {
      ...measured.kinds,
      [kind]: { ...measured.kinds[kind], timeToValidationMs: 0 },
    },
  };
}

/**
 * The demand a drive launched after this pickup meets: everything ahead of
 * the pickup, the runs this tick admitted, and the pickup's runs still on the
 * lock when the drive asks for it.
 */
function driveReserve(
  state: ValidationLoad & { demand: ValidationDemand },
  ownRuns: number,
): ValidationDemand {
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
    Math.min(ownRuns, completedBeforeDrive - predecessorRuns),
  );
  const stillRunning = Math.max(0, ownRuns - pickupCompletedBeforeDrive);
  // Only work at the lock, and passes in flight with an arrival estimate,
  // may consume service before the drive arrives. Admitted passes still have
  // to reach validation, even when their eventual runs are being reserved
  // for this downstream drive, so they and the pickup's own runs are counted
  // ahead of it, the pickup's at its repository's run time.
  const { candidateRunMs, runMs } = state.measured;
  const timed =
    candidateRunMs === undefined ||
    candidateRunMs === runMs ||
    stillRunning <= 0
      ? []
      : [{ runs: stillRunning, runMs: candidateRunMs }];
  return {
    ...state.demand,
    toArrive: state.demand.toArrive + state.admittedRuns + stillRunning,
    ...(timed.length > 0
      ? { unestimated: [...(state.demand.unestimated ?? []), ...timed] }
      : {}),
  };
}

/** Why a pass of `kind` in `repo` waits on validation capacity; `null` when it fits. */
export function validationHold(
  load: ValidationLoad,
  line: number,
  kind: ValidationKind,
  pickupDeadlineMs: number,
  repo?: string,
  immediate = false,
): string | null {
  // A launch setting the lock refuses fails validation whatever the lock's
  // occupancy, so it is judged before the occupancy reading.
  if (load.waitInvalid !== undefined)
    return `waits on validation capacity: ${load.waitInvalid}`;
  const { demand } = load;
  if ("unread" in demand) return null;
  const state = {
    ...load,
    demand,
    measured: arrivingAt(measurementsFor(load.measured, repo), kind, immediate),
  };
  const deadline = kind === "pickup" ? pickupDeadlineMs : state.driveDeadlineMs;
  const own = forecast(state, kind, deadline, state.admittedRuns);
  if (own === null) return null;
  if (own.fill === null || own.fill > line)
    return `waits on validation capacity: ${describe(state, own)}`;
  if (kind === "pickup") {
    // Reserve this pickup and a drive in the pickup's window. The independent
    // drive-window check only judges work committed before this pickup, which
    // has not yet been admitted by its caller.
    const reservedDemand = driveReserve(state, own.ownRuns);
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
