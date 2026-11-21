/**
 * The validation lock's queue when a new pass reaches it: which runs in
 * flight are still holding or waiting for a slot then, and which the lock
 * has already served.
 */

/** When a pass in flight is expected to ask for the lock next, from now. */
export interface ValidationArrival {
  /** Milliseconds from now until the pass's next run asks for the lock. */
  atMs: number;
  /** The runs it still makes, one after another. */
  runs: number;
}

export interface ArrivalQueueInput {
  /** Whole slots: the simulation needs physical slots. */
  concurrency: number;
  runMs: number;
  /** Runs holding or waiting for the lock now. */
  atLock: number;
  /** Passes with an arrival estimate. */
  arrivals: readonly ValidationArrival[];
  /** Runs with no estimate, counted at the lock when the candidate arrives. */
  unknownRuns: number;
  /** When the candidate's first run asks for the lock, from now. */
  arriveMs: number;
  /** Whether the candidate makes a run at all. */
  candidate: boolean;
}

export interface ArrivalQueue {
  /** When the candidate's first run takes a slot, from now; its arrival without a run. */
  acquireMs: number;
  /** Runs holding or waiting for the lock when the candidate arrives. */
  ahead: number;
  /** Runs the lock is expected to have released by then. */
  served: number;
}

interface Request {
  at: number;
  /** Ties at one moment: the lock's queue, then estimated, unestimated, the candidate. */
  rank: number;
  /** Runs the same pass asks for after this one, each when the one before releases. */
  next: number;
}

const QUEUED = 0;
const ESTIMATED = 1;
const UNESTIMATED = 2;
const CANDIDATE = 3;

function earliest(pending: Request[]): Request | undefined {
  let best = 0;
  for (let index = 1; index < pending.length; index++) {
    const request = pending[index];
    const chosen = pending[best];
    if (
      request !== undefined &&
      chosen !== undefined &&
      (request.at < chosen.at ||
        (request.at === chosen.at && request.rank < chosen.rank))
    )
      best = index;
  }
  return pending.splice(best, 1)[0];
}

/**
 * Serve the lock's requests in the order they arrive, each on the slot that
 * frees first, until the candidate's first run takes one. A holder now may
 * have just begun, so it releases a whole run from now. A run counts ahead
 * when it is still holding or waiting at the candidate's arrival, and
 * served when it released before; a run asking later queues behind the
 * candidate. Passes estimated to arrive together contend for the same
 * slots, so the ones a slot cannot take in time stay ahead.
 */
export function arrivalQueue(input: ArrivalQueueInput): ArrivalQueue {
  const { concurrency, runMs, arriveMs } = input;
  const releases = Array.from({ length: concurrency }, () => 0);
  const holding = Math.min(input.atLock, concurrency);
  let ahead = 0;
  let served = 0;
  const settle = (end: number) => {
    if (end <= arriveMs) served++;
    else ahead++;
  };
  for (let index = 0; index < holding; index++) {
    releases[index] = runMs;
    settle(runMs);
  }
  const pending: Request[] = [];
  for (let index = holding; index < input.atLock; index++)
    pending.push({ at: 0, rank: QUEUED, next: 0 });
  for (const { atMs, runs } of input.arrivals) {
    const whole = Math.ceil(runs);
    if (whole > 0)
      pending.push({ at: Math.max(0, atMs), rank: ESTIMATED, next: whole - 1 });
  }
  for (let index = 0; index < Math.ceil(input.unknownRuns); index++)
    pending.push({ at: arriveMs, rank: UNESTIMATED, next: 0 });
  if (input.candidate) pending.push({ at: arriveMs, rank: CANDIDATE, next: 0 });
  for (;;) {
    const request = earliest(pending);
    if (request === undefined || request.at > arriveMs)
      return { acquireMs: arriveMs, ahead, served };
    releases.sort((left, right) => left - right);
    const start = Math.max(request.at, releases[0] ?? 0);
    if (request.rank === CANDIDATE) return { acquireMs: start, ahead, served };
    const end = start + runMs;
    releases[0] = end;
    settle(end);
    if (request.next > 0)
      pending.push({ at: end, rank: ESTIMATED, next: request.next - 1 });
  }
}
