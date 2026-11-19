/** Adapt the host's lock and launch records to the validation forecast. */
import { dirname, resolve } from "node:path";
import { lockPlace } from "../../shared/resource-lock-waits.ts";
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
} from "../../shared/resource-lock.ts";
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
  waitLimitMs: number;
  driveDeadlineMs: number;
  admittedRuns: number;
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
): ValidationLoad {
  const { name } = lockPlace(process.env);
  const passes = records.flatMap((record) => passOf(record) ?? []);
  const workspaces = new Set(
    passes.flatMap(({ workspace }) => workspace ?? []),
  );
  const samples = readResourceLockSamples(name, nowMs).map(
    ({ workspace, requestedAt, waitMs, holdMs }) => ({
      workspace: workspaceOf(workspace, workspaces),
      requestedAtMs: parseMs(requestedAt),
      waitMs,
      holdMs,
    }),
  );
  const measured = measureValidation(samples, passes);
  const timeout = process.env.LOCK_TIMEOUT ?? String(DEFAULT_TIMEOUT_SECONDS);
  const waitSeconds = Number(timeout || Number.NaN);
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
    waitLimitMs:
      /^[0-9]+$/.test(timeout) && waitSeconds <= MAX_TIMEOUT_SECONDS
        ? waitSeconds * 1000
        : DEFAULT_TIMEOUT_SECONDS * 1000,
    driveDeadlineMs,
    admittedRuns: 0,
  };
}

function forecast(
  state: ValidationLoad,
  kind: ValidationKind,
  deadlineMs: number,
  admittedRuns: number,
): ValidationForecast | null {
  if ("unread" in state.demand) return null;
  return forecastValidation(
    state.measured,
    kind,
    state.demand,
    state.waitLimitMs,
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
  return `${ahead} runs ahead, about ${waited} min at ${concurrency} concurrent runs of ${minutes(runMs)} min, capacity ${Number(result.capacity.toFixed(2))}${note}`;
}

export function validationHold(
  state: ValidationLoad,
  line: number,
  kind: ValidationKind,
  pickupDeadlineMs: number,
): string | null {
  const deadline = kind === "pickup" ? pickupDeadlineMs : state.driveDeadlineMs;
  const own = forecast(state, kind, deadline, state.admittedRuns);
  if (own === null) return null;
  if (own.fill === null || own.fill > line)
    return `waits on validation capacity: ${describe(state, own)}`;
  if (kind === "pickup") {
    // Reserve this pickup and a drive in the pickup's window. The independent
    // drive-window check only judges work committed before this pickup, which
    // has not yet been admitted by its caller.
    // A run that can take an idle slot immediately does not delay a later
    // drive. Reserve only this pickup's runs which must queue behind demand
    // already forecast at its arrival.
    const immediatelyAdmitted = Math.min(
      own.ownRuns,
      Math.max(0, state.measured.concurrency - own.ahead),
    );
    const committedRuns =
      state.admittedRuns + own.ownRuns - immediatelyAdmitted;
    const reserved = forecast(state, "drive", deadline, committedRuns);
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
    result === null
      ? "unread" in state.demand
        ? state.demand.unread
        : "test lock unread"
      : describe(state, result);
  return {
    gauge: "validation",
    fill:
      result === null
        ? null
        : Math.min((result.fill ?? share) / share, Number.MAX_SAFE_INTEGER),
    reads,
    line,
  };
}
