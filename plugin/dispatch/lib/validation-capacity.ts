import { percentile90 } from "./load-samples.ts";

export type ValidationKind = "pickup" | "drive";

export interface ValidationSample {
  workspace: string | null;
  requestedAtMs: number;
  waitMs: number;
  holdMs: number;
}

export interface ValidationPass {
  kind: ValidationKind;
  workspace: string | null;
  launchedAtMs: number;
  endedAtMs?: number;
}

interface KindMeasurements {
  runsPerPass: number;
  timeToValidationMs: number;
}

export interface ValidationMeasurements {
  runMs: number;
  concurrency: number;
  kinds: Readonly<Record<ValidationKind, KindMeasurements>>;
  defaults: readonly string[];
}

interface OccupancyEvent {
  at: number;
  waiting: number;
  holding: number;
}

function occupancyEvents(sample: ValidationSample): OccupancyEvent[] {
  const acquired = sample.requestedAtMs + sample.waitMs;
  return [
    { at: sample.requestedAtMs, waiting: 1, holding: 0 },
    { at: acquired, waiting: -1, holding: 1 },
    { at: acquired + sample.holdMs, waiting: 0, holding: -1 },
  ];
}

/** Measure concurrency over elapsed time with a waiter, or peak overlap without contention. */
function concurrencyOf(samples: readonly ValidationSample[]): number | null {
  const events = samples
    .filter(({ holdMs }) => holdMs > 0)
    .flatMap(occupancyEvents)
    .sort((a, b) => a.at - b.at);
  let waiting = 0;
  let holding = 0;
  let peak = 0;
  let last = events[0]?.at ?? 0;
  const durations = new Map<number, number>();
  for (const event of events) {
    if (event.at > last) {
      peak = Math.max(peak, holding);
      if (holding > 0 && waiting > 0) {
        durations.set(holding, (durations.get(holding) ?? 0) + event.at - last);
      }
    }
    waiting += event.waiting;
    holding += event.holding;
    last = event.at;
  }
  const half = [...durations.values()].reduce((a, b) => a + b, 0) / 2;
  let elapsed = 0;
  const distribution = [...durations].sort(([a], [b]) => a - b);
  for (const [index, [count, duration]] of distribution.entries()) {
    elapsed += duration;
    if (elapsed > half) return count;
    if (elapsed === half)
      return (count + (distribution[index + 1]?.[0] ?? count)) / 2;
  }
  return peak || null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const right = values[Math.floor(values.length / 2)];
  const left = values[Math.floor((values.length - 1) / 2)];
  return left === undefined || right === undefined ? null : (left + right) / 2;
}

function groupByWorkspace<T extends { workspace: string | null }>(
  entries: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    if (entry.workspace === null) continue;
    let group = groups.get(entry.workspace);
    if (group === undefined) {
      group = [];
      groups.set(entry.workspace, group);
    }
    group.push(entry);
  }
  return groups;
}

interface PassRuns {
  count: number;
  firstRequest: number;
}

/** Attribute each sample to at most one pass, even when a drive workspace is reused. */
function attributeRuns(
  passes: readonly ValidationPass[],
  samples: readonly ValidationSample[],
): Map<ValidationPass, PassRuns> {
  const attributed = new Map<ValidationPass, PassRuns>();
  const byWorkspace = groupByWorkspace(samples);
  for (const [workspace, group] of groupByWorkspace(passes)) {
    group.sort((a, b) => a.launchedAtMs - b.launchedAtMs);
    const requests = byWorkspace.get(workspace) ?? [];
    requests.sort((a, b) => a.requestedAtMs - b.requestedAtMs);
    let index = 0;
    for (const { requestedAtMs } of requests) {
      while ((group[index + 1]?.launchedAtMs ?? Infinity) <= requestedAtMs)
        index++;
      const pass = group[index];
      if (
        pass === undefined ||
        requestedAtMs < pass.launchedAtMs ||
        requestedAtMs >= (pass.endedAtMs ?? Infinity)
      )
        continue;
      const prior = attributed.get(pass);
      if (prior) prior.count++;
      else attributed.set(pass, { count: 1, firstRequest: requestedAtMs });
    }
  }
  return attributed;
}

/** Derive each estimate from observed runs and name every estimate using its default. */
export function measureValidation(
  samples: readonly ValidationSample[],
  passes: readonly ValidationPass[],
): ValidationMeasurements {
  const defaults: string[] = [];
  const measuredOr = (
    number: number | null,
    fallback: number,
    name: string,
  ) => {
    if (number !== null) return number;
    defaults.push(name);
    return fallback;
  };
  const runMs = measuredOr(
    percentile90(samples.map(({ holdMs }) => holdMs).filter((ms) => ms > 0)),
    15 * 60_000,
    "run time",
  );
  const concurrency = measuredOr(concurrencyOf(samples), 1, "runs at once");
  const attributed = attributeRuns(passes, samples);
  const measureKind = (kind: ValidationKind): KindMeasurements => {
    const measured = [...attributed].filter(([pass]) => pass.kind === kind);
    const counts = measured
      .filter(([pass]) => pass.endedAtMs !== undefined)
      .map(([, runs]) => runs.count);
    return {
      runsPerPass: measuredOr(
        counts.length
          ? counts.reduce((a, b) => a + b, 0) / counts.length
          : null,
        1,
        `${kind} runs per pass`,
      ),
      timeToValidationMs: measuredOr(
        median(
          measured.map(([pass, runs]) => runs.firstRequest - pass.launchedAtMs),
        ),
        60 * 60_000,
        `${kind} time to validation`,
      ),
    };
  };
  return {
    runMs,
    concurrency,
    kinds: { pickup: measureKind("pickup"), drive: measureKind("drive") },
    defaults,
  };
}

export interface ValidationForecast extends ValidationDemand {
  ahead: number;
  capacity: number;
  ownRuns: number;
  required: number;
  /** Null when the pass has no time left in which to wait. */
  fill: number | null;
  waitWindowMs: number;
}

export interface ValidationDemand {
  atLock: number;
  toArrive: number;
}

/** Count each in-flight run once, at the lock or among runs yet to arrive. */
export function validationDemand(
  measured: ValidationMeasurements,
  lockRuns: readonly { workspace: string | null }[],
  inFlight: readonly ValidationPass[],
  samples: readonly ValidationSample[],
): ValidationDemand {
  const completed = attributeRuns(inFlight, samples);
  const active = groupByWorkspace(lockRuns);
  let toArrive = 0;
  for (const pass of inFlight) {
    const atLock =
      pass.workspace !== null && Boolean(active.get(pass.workspace)?.pop());
    toArrive += Math.max(
      0,
      measured.kinds[pass.kind].runsPerPass -
        (completed.get(pass)?.count ?? 0) -
        Number(atLock),
    );
  }
  return { atLock: lockRuns.length, toArrive };
}

export function forecastValidation(
  measured: ValidationMeasurements,
  kind: ValidationKind,
  demand: ValidationDemand,
  waitLimitMs: number,
  passLimitMs: number,
  admittedRuns = 0,
): ValidationForecast {
  const { runMs, concurrency } = measured;
  const { runsPerPass: ownRuns, timeToValidationMs } = measured.kinds[kind];
  const { atLock } = demand;
  const toArrive = demand.toArrive + admittedRuns;
  const ahead =
    toArrive + Math.max(0, atLock - (concurrency * timeToValidationMs) / runMs);
  const waitWindowMs = Math.max(
    0,
    Math.min(waitLimitMs, passLimitMs - timeToValidationMs - runMs),
  );
  const capacity = (concurrency * waitWindowMs) / runMs;
  const required = ahead + ownRuns;
  return {
    ahead,
    capacity,
    ownRuns,
    required,
    fill: capacity > 0 ? required / capacity : null,
    atLock,
    toArrive,
    waitWindowMs,
  };
}
