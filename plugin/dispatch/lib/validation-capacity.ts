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

function recordContention(
  durations: Map<number, number>,
  holding: number,
  waiting: number,
  duration: number,
): void {
  if (holding > 0 && waiting > 0)
    durations.set(holding, (durations.get(holding) ?? 0) + duration);
}

function contentionMedian(durations: Map<number, number>): number | null {
  const half =
    [...durations.values()].reduce((sum, duration) => sum + duration, 0) / 2;
  let elapsed = 0;
  const distribution = [...durations].sort(([left], [right]) => left - right);
  for (const [index, [count, duration]] of distribution.entries()) {
    elapsed += duration;
    if (elapsed > half) return count;
    if (elapsed === half)
      return (count + (distribution[index + 1]?.[0] ?? count)) / 2;
  }
  return null;
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
      recordContention(durations, holding, waiting, event.at - last);
    }
    waiting += event.waiting;
    holding += event.holding;
    last = event.at;
  }
  return (contentionMedian(durations) ?? peak) || null;
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

function addRun(
  attributed: Map<ValidationPass, PassRuns>,
  pass: ValidationPass,
  requestedAtMs: number,
): void {
  const prior = attributed.get(pass);
  if (prior) prior.count++;
  else attributed.set(pass, { count: 1, firstRequest: requestedAtMs });
}

function passForRequest(
  passes: readonly ValidationPass[],
  requestedAtMs: number,
): ValidationPass | null {
  const pass = passes.findLast(
    ({ launchedAtMs }) => launchedAtMs <= requestedAtMs,
  );
  return pass === undefined || requestedAtMs >= (pass.endedAtMs ?? Infinity)
    ? null
    : pass;
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
    for (const { requestedAtMs } of requests) {
      const pass = passForRequest(group, requestedAtMs);
      if (pass !== null) addRun(attributed, pass, requestedAtMs);
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
  /**
   * Null when the pass has no time left in which to wait, or must wait with
   * no window to wait in; zero when its first run finds a slot free, even
   * with a wait of zero.
   */
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
      pass.workspace === null ? 0 : (active.get(pass.workspace)?.length ?? 0);
    if (pass.workspace !== null) active.delete(pass.workspace);
    toArrive += Math.max(
      0,
      measured.kinds[pass.kind].runsPerPass -
        (completed.get(pass)?.count ?? 0) -
        atLock,
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
    Math.min(waitLimitMs, passLimitMs - timeToValidationMs),
  );
  const capacity = (concurrency * waitWindowMs) / runMs;
  // A lock timeout bounds how long each of a pass's runs may wait to acquire
  // a slot, not how long a run may occupy that slot once it holds it.
  // A pass makes its runs one after another: each asks for the lock when the
  // one before it has released, so its earlier runs are never lock waits for
  // its later ones. Every run counted ahead is in the queue before the
  // candidate's first run, so that run waits longest; each later run asks
  // when its predecessor releases a slot, with nothing left ahead of it.
  // Capacity therefore measures the service before the candidate's first
  // acquisition. A partial service wave does not make a slot free, but it
  // does shorten the wait until the next release.
  const waitingRuns = ownRuns > 0 ? 1 : 0;
  const completedWaves = Math.floor(timeToValidationMs / runMs);
  const activeRuns = Math.max(0, atLock - concurrency * completedWaves);
  const residualMs =
    activeRuns === 0 ? 0 : runMs - (timeToValidationMs % runMs);
  const queuedRuns = Math.ceil(ahead) + waitingRuns;
  const requiredWithoutActiveRuns =
    concurrency *
    Math.ceil(Math.max(0, queuedRuns - concurrency) / concurrency);
  let required = requiredWithoutActiveRuns;
  // Preserve each slot's release time. In particular, a predecessor can take
  // an idle slot while another waits for an occupied slot; treating both as
  // one residual wave would let the candidate acquire too early.
  // A measured concurrency may be fractional (the midpoint of two observed
  // contention levels). The aggregate calculation above preserves that
  // estimate; a slot simulation requires physical, whole slots.
  if (Number.isInteger(concurrency)) {
    // `atLock` contains both holders and queued runs. Model the queued runs
    // too: when it exceeds the number of slots, omitting them lets a later
    // candidate take a holder's release before the runs already waiting do.
    const holdingRuns = Math.min(activeRuns, concurrency);
    const queuedAtLock = activeRuns - holdingRuns;
    const releases = Array.from({ length: concurrency }, (_, index) =>
      index < holdingRuns ? residualMs : 0,
    );
    const acquire = () => {
      releases.sort((left, right) => left - right);
      const at = releases[0] ?? 0;
      releases[0] = at + runMs;
      return at;
    };
    for (let index = 0; index < queuedAtLock; index++) acquire();
    for (let index = 0; index < toArrive; index++) acquire();
    const firstAcquisition = waitingRuns > 0 ? acquire() : 0;
    required = (concurrency * firstAcquisition) / runMs;
  }
  // The lock timeout bounds each acquisition separately, but the pass's runs
  // are sequential and the pass deadline bounds the last one: it asks for the
  // lock a run apart from the one before it, after the first acquisition.
  // An idle lock never queues the pass, so only a pass that waits is held
  // back by its later runs.
  const lastRequestMs =
    timeToValidationMs +
    (required * runMs) / concurrency +
    Math.max(0, ownRuns - 1) * runMs;
  return {
    ahead,
    capacity,
    ownRuns,
    required,
    fill:
      passLimitMs <= timeToValidationMs ||
      (required > 0 && lastRequestMs > passLimitMs)
        ? null
        : required === 0
          ? 0
          : capacity > 0
            ? required / capacity
            : null,
    atLock,
    toArrive,
    waitWindowMs,
  };
}
