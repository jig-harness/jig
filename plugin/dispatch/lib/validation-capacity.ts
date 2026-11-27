import { percentile90 } from "./load-samples.ts";
import {
  arrivalQueue,
  type ArrivalQueueInput,
  type TimedRuns,
  type ValidationArrival,
} from "./validation-arrivals.ts";

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
  /** The repository the pass works on; absent when unknown. */
  repo?: string | null;
  launchedAtMs: number;
  endedAtMs?: number;
}

interface KindMeasurements {
  /** Every repository's measure, charged to a repository without its own. */
  runsPerPass: number;
  /** Runs per pass in each repository whose runs the lock records. */
  runsPerRepository?: ReadonlyMap<string, number>;
  timeToValidationMs: number;
}

export interface ValidationMeasurements {
  /** Every repository's run time, charged to a repository without its own. */
  runMs: number;
  /** The run time of each repository whose runs the lock records often enough. */
  runMsPerRepository?: ReadonlyMap<string, number>;
  /** The run time of the pass being forecast, set by `measurementsFor`. */
  candidateRunMs?: number;
  concurrency: number;
  /** The slots the lock's load check admits now, where the forecast read them. */
  lockSlots?: number;
  kinds: Readonly<Record<ValidationKind, KindMeasurements>>;
  defaults: readonly string[];
}

interface OccupancyEvent {
  at: number;
  holding: number;
}

function occupancyEvents(sample: ValidationSample): OccupancyEvent[] {
  const acquired = sample.requestedAtMs + sample.waitMs;
  return [
    { at: acquired, holding: 1 },
    { at: acquired + sample.holdMs, holding: -1 },
  ];
}

/** The most runs that held the lock together: what its admission allowed. */
function concurrencyOf(samples: readonly ValidationSample[]): number | null {
  const events = samples
    .filter(({ holdMs }) => holdMs > 0)
    .flatMap(occupancyEvents)
    .sort((a, b) => a.at - b.at);
  let holding = 0;
  let peak = 0;
  let last = events[0]?.at ?? 0;
  for (const event of events) {
    if (event.at > last) peak = Math.max(peak, holding);
    holding += event.holding;
    last = event.at;
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
  /** How long each of its runs held the lock. */
  holds: number[];
}

function addRun(
  attributed: Map<ValidationPass, PassRuns>,
  pass: ValidationPass,
  { requestedAtMs, holdMs }: ValidationSample,
): void {
  const prior = attributed.get(pass);
  const holds = holdMs > 0 ? [holdMs] : [];
  if (prior) {
    prior.count++;
    prior.holds.push(...holds);
  } else attributed.set(pass, { count: 1, firstRequest: requestedAtMs, holds });
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
    for (const request of requests) {
      const pass = passForRequest(group, request.requestedAtMs);
      if (pass !== null) addRun(attributed, pass, request);
    }
  }
  return attributed;
}

/** The finished passes a repository needs before its own runs per pass replace every repository's. */
const OWN_MEASURE = 3;

/** The runs a repository's passes made before its own run time replaces every repository's. */
const OWN_RUN_TIME = 5;

/**
 * The 90th percentile of the holds of the runs each repository's passes made,
 * for every repository with at least `OWN_RUN_TIME` of them. Runs the lock
 * recorded outside any pass (a person's run, another tool's) belong to no
 * repository and count only in every repository's figure.
 */
function ownRunMsPerRepository(
  attributed: ReadonlyMap<ValidationPass, PassRuns>,
): Map<string, number> {
  const holds = new Map<string, number[]>();
  for (const [{ repo }, runs] of attributed) {
    if (typeof repo !== "string") continue;
    holds.set(repo, [...(holds.get(repo) ?? []), ...runs.holds]);
  }
  const own = new Map<string, number>();
  for (const [repo, repoHolds] of holds) {
    const runMs = percentile90(repoHolds);
    if (runMs !== null && repoHolds.length >= OWN_RUN_TIME)
      own.set(repo, runMs);
  }
  return own;
}

/**
 * The median number of runs a finished pass made, never under one: a pass
 * admitted for validation makes at least one. Passes that made none count, so
 * one pass of many short runs does not set the figure for every pass.
 */
function runsPerPassOf(counts: number[]): number | null {
  const middle = median(counts);
  return middle === null ? null : Math.max(1, middle);
}

/**
 * The finished passes whose runs the samples can show: ended inside the
 * samples' retention, and in a repository whose runs the lock records (one
 * that recorded none, such as a lock wrapper that keeps no samples, would
 * read as making no runs at all).
 */
function measurablePasses(
  passes: readonly ValidationPass[],
  samples: readonly ValidationSample[],
  attributed: ReadonlyMap<ValidationPass, PassRuns>,
): ValidationPass[] {
  const earliest = samples.reduce(
    (first, { requestedAtMs }) => Math.min(first, requestedAtMs),
    Infinity,
  );
  // A repository's runs are observable from its own first attributed sample:
  // passes before its lock wrapper recorded anything are not zero-run passes.
  const firstRecorded = new Map<string, number>();
  for (const [{ repo }, { firstRequest }] of attributed) {
    if (typeof repo === "string")
      firstRecorded.set(
        repo,
        Math.min(firstRecorded.get(repo) ?? Infinity, firstRequest),
      );
  }
  return passes.filter(({ workspace, repo, endedAtMs }) => {
    if (workspace === null || endedAtMs === undefined) return false;
    if (typeof repo !== "string") return endedAtMs >= earliest;
    const from = firstRecorded.get(repo);
    return from !== undefined && endedAtMs >= Math.max(earliest, from);
  });
}

/** The name `defaults` gives a kind's time to validation when no pass measured it. */
function timeToValidationName(kind: ValidationKind): string {
  return `${kind} time to validation`;
}

type MeasuredOr = (
  number: number | null,
  fallback: number,
  name: string,
) => number;

/** Each repository's run counts per finished pass of `kind`. */
function countsByRepository(
  kind: ValidationKind,
  attributed: ReadonlyMap<ValidationPass, PassRuns>,
  finished: readonly ValidationPass[],
): Map<string | null, number[]> {
  const counts = new Map<string | null, number[]>();
  for (const pass of finished.filter((own) => own.kind === kind)) {
    const repo = pass.repo ?? null;
    const count = attributed.get(pass)?.count ?? 0;
    const own = counts.get(repo);
    if (own) own.push(count);
    else counts.set(repo, [count]);
  }
  return counts;
}

/** The runs per pass of each repository with enough passes to measure on its own. */
function ownRunsPerRepository(
  counts: ReadonlyMap<string | null, number[]>,
): Map<string, number> {
  const own = new Map<string, number>();
  for (const [repo, repoCounts] of counts) {
    const runs = runsPerPassOf(repoCounts);
    if (repo !== null && runs !== null && repoCounts.length >= OWN_MEASURE)
      own.set(repo, runs);
  }
  return own;
}

function kindMeasurements(
  kind: ValidationKind,
  attributed: ReadonlyMap<ValidationPass, PassRuns>,
  finished: readonly ValidationPass[],
  measuredOr: MeasuredOr,
): KindMeasurements {
  const counts = countsByRepository(kind, attributed, finished);
  const measured = [...attributed].filter(([pass]) => pass.kind === kind);
  return {
    runsPerPass: measuredOr(
      runsPerPassOf([...counts.values()].flat()),
      1,
      `${kind} runs per pass`,
    ),
    runsPerRepository: ownRunsPerRepository(counts),
    timeToValidationMs: measuredOr(
      median(
        measured.map(([pass, runs]) => runs.firstRequest - pass.launchedAtMs),
      ),
      60 * 60_000,
      timeToValidationName(kind),
    ),
  };
}

/**
 * Derive each estimate from observed runs and name every estimate using its
 * default. `lockSlots`, the slots the lock's load check admits now where it
 * was read, sets the floor of runs at once: the peak the samples saw may
 * stand above it, since the lock's own check still decides each run.
 */
export function measureValidation(
  samples: readonly ValidationSample[],
  passes: readonly ValidationPass[],
  lockSlots?: number | null,
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
  const peak = concurrencyOf(samples);
  const slots = lockSlots ?? null;
  const concurrency = measuredOr(
    slots === null ? peak : Math.max(peak ?? 0, slots),
    1,
    "runs at once",
  );
  const attributed = attributeRuns(passes, samples);
  const finished = measurablePasses(passes, samples, attributed);
  const measureKind = (kind: ValidationKind) =>
    kindMeasurements(kind, attributed, finished, measuredOr);
  return {
    runMs,
    runMsPerRepository: ownRunMsPerRepository(attributed),
    concurrency,
    ...(slots === null ? {} : { lockSlots: slots }),
    kinds: { pickup: measureKind("pickup"), drive: measureKind("drive") },
    defaults,
  };
}

/** How long a run of a pass in `repo` holds the lock: its repository's run time, else every repository's. */
export function runMsFor(
  measured: ValidationMeasurements,
  repo?: string | null,
): number {
  return (
    (repo ? measured.runMsPerRepository?.get(repo) : undefined) ??
    measured.runMs
  );
}

/** The runs a pass of `kind` in `repo` is charged: its repository's measure, else every repository's. */
export function runsPerPassFor(
  measured: ValidationMeasurements,
  kind: ValidationKind,
  repo?: string | null,
): number {
  const { runsPerPass, runsPerRepository } = measured.kinds[kind];
  const own = repo ? runsPerRepository?.get(repo) : undefined;
  return own ?? runsPerPass;
}

/**
 * The measurements as a new pass in `repo` is charged them: its
 * repository's runs per pass, and its run time for its own runs. The runs
 * ahead of it keep their own passes' run times.
 */
export function measurementsFor(
  measured: ValidationMeasurements,
  repo?: string | null,
): ValidationMeasurements {
  if (!repo) return measured;
  const kind = (name: ValidationKind): KindMeasurements => ({
    ...measured.kinds[name],
    runsPerPass: runsPerPassFor(measured, name, repo),
  });
  return {
    ...measured,
    candidateRunMs: runMsFor(measured, repo),
    kinds: { pickup: kind("pickup"), drive: kind("drive") },
  };
}

export interface ValidationForecast {
  atLock: number;
  toArrive: number;
  /** Runs still holding or waiting for the lock when the pass reaches it. */
  ahead: number;
  /** Runs in flight the lock is expected to have served before the pass reaches it. */
  served: number;
  /** Runs in flight reaching the lock after the pass's first run and ahead of a later one. */
  later: number;
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
  /** Every run yet to arrive, with or without an arrival estimate. */
  toArrive: number;
  /**
   * The passes among `toArrive` whose arrival can be estimated; the runs
   * left over have none and are counted ahead of a new pass.
   */
  arrivals?: readonly ValidationArrival[];
  /**
   * The runs among `toArrive` with no arrival estimate whose repository
   * measures a run time of its own, by that run time; absent when none does.
   * The rest hold a slot for every repository's run time.
   */
  unestimated?: readonly TimedRuns[];
  /**
   * The run times of the runs among `atLock` whose pass's repository
   * measures its own; absent when none does. The rest hold a slot for every
   * repository's run time.
   */
  atLockRunMs?: readonly number[];
}

/**
 * When a pass in flight that has yet to make its first run asks for the
 * lock, from `nowMs`: its launch plus its kind's measured time to
 * validation. Null where the forecast cannot see: its kind's time is a
 * default, its launch does not read, or that time has passed. A pass that
 * has made a run, or holds one at the lock, has none either: nothing
 * measures the gap between a pass's runs.
 */
function arrivalOf(
  measured: ValidationMeasurements,
  pass: ValidationPass,
  started: boolean,
  nowMs: number,
): number | null {
  if (started) return null;
  if (measured.defaults.includes(timeToValidationName(pass.kind))) return null;
  const { timeToValidationMs } = measured.kinds[pass.kind];
  const atMs = pass.launchedAtMs + timeToValidationMs - nowMs;
  return Number.isFinite(atMs) && atMs >= 0 ? atMs : null;
}

/** What one pass in flight still owes the lock, and when it is expected to ask. */
interface PassDemand {
  runs: number;
  arrival: ValidationArrival | null;
  unestimated: TimedRuns | null;
}

function passDemand(
  measured: ValidationMeasurements,
  pass: ValidationPass,
  done: { made: number; atLock: number },
  nowMs: number | undefined,
): PassDemand {
  const { made, atLock } = done;
  const runs = Math.max(
    0,
    runsPerPassFor(measured, pass.kind, pass.repo) - made - atLock,
  );
  if (runs === 0) return { runs, arrival: null, unestimated: null };
  const atMs =
    nowMs === undefined
      ? null
      : arrivalOf(measured, pass, made + atLock > 0, nowMs);
  const runMs = runMsFor(measured, pass.repo);
  const own = runMs !== measured.runMs;
  if (atMs !== null)
    return {
      runs,
      arrival: own ? { atMs, runs, runMs } : { atMs, runs },
      unestimated: null,
    };
  return { runs, arrival: null, unestimated: own ? { runs, runMs } : null };
}

/**
 * Count each in-flight run once, at the lock or among runs yet to arrive.
 * Given `nowMs`, estimate when each pass's next run reaches the lock; a
 * run without an estimate is counted ahead. Each run is charged its own
 * pass's repository's run time, a run at the lock from no pass in flight
 * every repository's.
 */
export function validationDemand(
  measured: ValidationMeasurements,
  lockRuns: readonly { workspace: string | null }[],
  inFlight: readonly ValidationPass[],
  samples: readonly ValidationSample[],
  nowMs?: number,
): ValidationDemand {
  const completed = attributeRuns(inFlight, samples);
  const active = groupByWorkspace(lockRuns);
  let toArrive = 0;
  const arrivals: ValidationArrival[] = [];
  const unestimated: TimedRuns[] = [];
  const atLockRunMs: number[] = [];
  for (const pass of inFlight) {
    const atLock = takeHeld(active, pass);
    const runMs = runMsFor(measured, pass.repo);
    if (runMs !== measured.runMs)
      atLockRunMs.push(...Array<number>(atLock).fill(runMs));
    const made = completed.get(pass)?.count ?? 0;
    const owed = passDemand(measured, pass, { made, atLock }, nowMs);
    toArrive += owed.runs;
    if (owed.arrival !== null) arrivals.push(owed.arrival);
    if (owed.unestimated !== null) unestimated.push(owed.unestimated);
  }
  const demand: ValidationDemand = {
    atLock: lockRuns.length,
    toArrive,
    ...(nowMs === undefined ? {} : { arrivals }),
  };
  if (unestimated.length > 0) demand.unestimated = unestimated;
  if (atLockRunMs.length > 0) demand.atLockRunMs = atLockRunMs;
  return demand;
}

/** The runs at the lock from `pass`'s workspace, taken so no other pass counts them. */
function takeHeld(
  active: Map<string, unknown[]>,
  pass: ValidationPass,
): number {
  if (pass.workspace === null) return 0;
  const held = active.get(pass.workspace)?.length ?? 0;
  active.delete(pass.workspace);
  return held;
}

interface QueueEstimate {
  ahead: number;
  served: number;
  later: number;
  /** Service, in runs, before the pass's longest-waiting run takes a slot. */
  required: number;
  /** When the pass's last run takes its slot, from now. */
  lastStartMs: number;
}

function queued(input: ArrivalQueueInput): QueueEstimate {
  const { waitMs, lastStartMs, ahead, served, later } = arrivalQueue(input);
  return {
    ahead,
    served,
    later,
    required: (input.concurrency * waitMs) / input.runMs,
    lastStartMs,
  };
}

/**
 * A concurrency that is not measured may be fractional, and the slot
 * simulation needs whole slots: count every run yet to arrive ahead, and
 * credit the runs at the lock with the service before the pass arrives.
 */
function aggregate(
  measured: ValidationMeasurements,
  atLock: number,
  toArrive: number,
  ownRuns: number,
  timeToValidationMs: number,
): QueueEstimate {
  const { concurrency, runMs } = measured;
  const early = Math.min(atLock, (concurrency * timeToValidationMs) / runMs);
  const ahead = toArrive + atLock - early;
  const queuedRuns = Math.ceil(ahead) + (ownRuns > 0 ? 1 : 0);
  const required =
    concurrency *
    Math.ceil(Math.max(0, queuedRuns - concurrency) / concurrency);
  // Every run ahead is in the queue before the pass's first run, so each
  // later run asks a run apart from the one before it, with nothing ahead.
  return {
    ahead,
    served: 0,
    later: 0,
    required,
    lastStartMs:
      timeToValidationMs +
      (required * runMs) / concurrency +
      Math.max(0, ownRuns - 1) * (measured.candidateRunMs ?? runMs),
  };
}

function fillOf(input: {
  required: number;
  capacity: number;
  lastStartMs: number;
  passLimitMs: number;
  timeToValidationMs: number;
}): number | null {
  const { required, capacity, lastStartMs, passLimitMs } = input;
  if (passLimitMs <= input.timeToValidationMs) return null;
  if (required > 0 && lastStartMs > passLimitMs) return null;
  if (required === 0) return 0;
  return capacity > 0 ? required / capacity : null;
}

function queuedFor(
  { runMs, candidateRunMs, concurrency }: ValidationMeasurements,
  demand: ValidationDemand,
  toArrive: number,
  candidateRuns: number,
  arriveMs: number,
) {
  const arrivals = demand.arrivals ?? [];
  const unestimated = demand.unestimated ?? [];
  const runsOf = (timed: readonly { runs: number }[]) =>
    timed.reduce((sum, { runs }) => sum + runs, 0);
  return queued({
    concurrency,
    runMs,
    ...(candidateRunMs === undefined ? {} : { candidateRunMs }),
    atLock: demand.atLock,
    ...(demand.atLockRunMs === undefined
      ? {}
      : { atLockRunMs: demand.atLockRunMs }),
    arrivals,
    unknownRuns: Math.max(0, toArrive - runsOf(arrivals) - runsOf(unestimated)),
    unestimated,
    arriveMs,
    candidateRuns,
  });
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
  const waitWindowMs = Math.max(
    0,
    Math.min(waitLimitMs, passLimitMs - timeToValidationMs),
  );
  const capacity = (concurrency * waitWindowMs) / runMs;
  // A lock timeout bounds how long each of a pass's runs may wait to acquire
  // a slot, not how long a run may occupy that slot once it holds it.
  // A pass makes its runs one after another: each asks for the lock when the
  // one before it has released, so its earlier runs are never lock waits for
  // its later ones. A pass in flight with an arrival estimate is served in
  // the order it reaches the lock: a run that releases before this pass
  // arrives is not ahead of it, and one that arrives later queues behind its
  // first run but can still be ahead of a later one. Capacity therefore
  // measures the service before the longest wait of any of its runs. Runs
  // with no estimate, and the runs this tick admitted, which reach
  // validation with this pass, are counted ahead. A partial service wave
  // does not make a slot free, but it does shorten the wait until the next
  // release.
  const { ahead, served, later, required, lastStartMs } = Number.isInteger(
    concurrency,
  )
    ? queuedFor(measured, demand, toArrive, ownRuns, timeToValidationMs)
    : aggregate(measured, atLock, toArrive, ownRuns, timeToValidationMs);
  // The lock timeout bounds each acquisition separately, but the pass's runs
  // are sequential and the pass deadline bounds the last one. An idle lock
  // never queues the pass, so only a pass that waits is held back by its
  // later runs.
  return {
    ahead,
    served,
    later,
    capacity,
    ownRuns,
    required,
    fill: fillOf({
      required,
      capacity,
      lastStartMs,
      passLimitMs,
      timeToValidationMs,
    }),
    atLock,
    toArrive,
    waitWindowMs,
  };
}
