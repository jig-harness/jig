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
  runMs: number;
  concurrency: number;
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

/** The finished passes a repository needs before its own runs per pass replace every repository's. */
const OWN_MEASURE = 3;

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
  const finished = measurablePasses(passes, samples, attributed);
  const measureKind = (kind: ValidationKind): KindMeasurements => {
    const measured = [...attributed].filter(([pass]) => pass.kind === kind);
    const counts = new Map<string | null, number[]>();
    for (const pass of finished) {
      if (pass.kind !== kind) continue;
      const repo = pass.repo ?? null;
      const count = attributed.get(pass)?.count ?? 0;
      const repoCounts = counts.get(repo);
      if (repoCounts) repoCounts.push(count);
      else counts.set(repo, [count]);
    }
    const runsPerRepository = new Map<string, number>();
    for (const [repo, repoCounts] of counts) {
      const runs = runsPerPassOf(repoCounts);
      if (repo !== null && runs !== null && repoCounts.length >= OWN_MEASURE)
        runsPerRepository.set(repo, runs);
    }
    return {
      runsPerPass: measuredOr(
        runsPerPassOf([...counts.values()].flat()),
        1,
        `${kind} runs per pass`,
      ),
      runsPerRepository,
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

/** The measurements as a new pass in `repo` is charged them. */
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
    kinds: { pickup: kind("pickup"), drive: kind("drive") },
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
      pass.workspace === null ? 0 : (active.get(pass.workspace)?.length ?? 0);
    if (pass.workspace !== null) active.delete(pass.workspace);
    toArrive += Math.max(
      0,
      runsPerPassFor(measured, pass.kind, pass.repo) -
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
  // A lock timeout bounds how long a pass may wait to acquire a slot, not how
  // long its own run may occupy that slot after immediate admission.
  // One candidate run can use each currently idle slot immediately. Its
  // remaining runs must queue behind the work already at the lock, so they
  // consume the same waiting capacity as work from earlier passes.
  // Capacity measures service before the candidate's last acquisition. Once
  // that run acquires a slot, its execution is not lock-wait time. A partial
  // service wave does not make a slot free, but it does shorten the wait
  // until the next release.
  const completedWaves = Math.floor(timeToValidationMs / runMs);
  const activeRuns = Math.max(0, atLock - concurrency * completedWaves);
  const residualMs =
    activeRuns === 0 ? 0 : runMs - (timeToValidationMs % runMs);
  const queuedRuns = Math.ceil(ahead) + ownRuns;
  const requiredWithoutActiveRuns =
    concurrency *
    Math.ceil(Math.max(0, queuedRuns - concurrency) / concurrency);
  let required = requiredWithoutActiveRuns;
  // Preserve each slot's release time. In particular, a predecessor can take
  // an idle slot while another waits for an occupied slot; treating both as
  // one residual wave would let the candidate acquire too early.
  // A concurrency that is not measured may be fractional. The aggregate
  // calculation above preserves it; a slot simulation requires physical,
  // whole slots.
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
    let lastAcquisition = 0;
    for (let index = 0; index < ownRuns; index++) lastAcquisition = acquire();
    required = (concurrency * lastAcquisition) / runMs;
  }
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
