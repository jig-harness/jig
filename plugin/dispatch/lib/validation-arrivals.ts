/**
 * The validation lock's queue as a new pass makes its runs: which runs in
 * flight are still holding or waiting for a slot when it arrives, which the
 * lock has already served, and how long each of its own runs waits.
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
  /** The candidate's runs, one after another; a fraction counts as a whole run. */
  candidateRuns: number;
}

export interface ArrivalQueue {
  /** The longest any of the candidate's runs waits for a slot. */
  waitMs: number;
  /** When the candidate's last run takes its slot, from now. */
  lastStartMs: number;
  /** Runs holding or waiting for the lock when the candidate arrives. */
  ahead: number;
  /** Runs the lock is expected to have released by then. */
  served: number;
  /** Runs asking after the candidate's arrival whose slot would otherwise have served one of its runs sooner. */
  later: number;
  /** Requests the simulation served: one pass over every run asked for, never a replay per request. */
  served_requests: number;
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

function precedes(left: Request, right: Request): boolean {
  return left.at < right.at || (left.at === right.at && left.rank < right.rank);
}

function earliest(pending: Request[]): Request | undefined {
  let best = 0;
  pending.forEach((request, index) => {
    const chosen = pending[best];
    if (chosen !== undefined && precedes(request, chosen)) best = index;
  });
  return pending.splice(best, 1)[0];
}

/** Every request known before the lock serves any: the queue, the estimated and unestimated arrivals, the candidate. */
function requestsOf(input: ArrivalQueueInput, holding: number): Request[] {
  const pending: Request[] = [];
  const add = (count: number, request: Request) => {
    for (let index = 0; index < count; index++) pending.push({ ...request });
  };
  add(input.atLock - holding, { at: 0, rank: QUEUED, next: 0 });
  for (const { atMs, runs } of input.arrivals)
    add(runs > 0 ? 1 : 0, {
      at: Math.max(0, atMs),
      rank: ESTIMATED,
      next: Math.ceil(runs) - 1,
    });
  add(Math.ceil(input.unknownRuns), {
    at: input.arriveMs,
    rank: UNESTIMATED,
    next: 0,
  });
  const own = Math.ceil(input.candidateRuns);
  add(own > 0 ? 1 : 0, {
    at: input.arriveMs,
    rank: CANDIDATE,
    next: own - 1,
  });
  return pending;
}

interface Occupancy {
  start: number;
  end: number;
}

/**
 * Serve the lock's requests in the order they arrive, each on the slot that
 * frees first, until the candidate's last run takes one. A holder now may
 * have just begun, so it releases a whole run from now. A run counts ahead
 * when it asked by the candidate's arrival and still holds or waits then,
 * and served when it released before; a run asking later queues behind the
 * candidate's first run, but can still be ahead of its later ones, each of
 * which asks when the one before releases. A later run counts when it held a
 * slot while one of the candidate's runs waited for one, so runs that jointly
 * fill the slots each count. One pass serves everything; nothing is replayed.
 */
export function arrivalQueue(input: ArrivalQueueInput): ArrivalQueue {
  const { concurrency, runMs, arriveMs } = input;
  const holding = Math.min(input.atLock, concurrency);
  const releases = Array.from({ length: concurrency }, (_, index) =>
    index < holding ? runMs : 0,
  );
  const result = {
    waitMs: 0,
    lastStartMs: arriveMs,
    ahead: 0,
    served: 0,
    later: 0,
    served_requests: 0,
  };
  const settle = (end: number) => {
    if (end <= arriveMs) result.served++;
    else result.ahead++;
  };
  releases.slice(0, holding).forEach(settle);
  const pending = requestsOf(input, holding);
  const waits: Occupancy[] = [];
  const laterRuns: Occupancy[] = [];
  const record = (request: Request, start: number, end: number) => {
    if (request.rank === CANDIDATE) {
      result.waitMs = Math.max(result.waitMs, start - request.at);
      result.lastStartMs = start;
      if (start > request.at) waits.push({ start: request.at, end: start });
    } else if (request.at <= arriveMs) settle(end);
    else laterRuns.push({ start, end });
  };
  let ownLeft = Math.ceil(input.candidateRuns);
  for (;;) {
    const request = earliest(pending);
    if (request === undefined || (ownLeft <= 0 && request.at > arriveMs)) break;
    releases.sort((left, right) => left - right);
    const start = Math.max(request.at, releases[0] ?? 0);
    const end = start + runMs;
    releases[0] = end;
    result.served_requests++;
    record(request, start, end);
    if (request.rank === CANDIDATE && --ownLeft <= 0) break;
    if (request.next > 0)
      pending.push({ ...request, at: end, next: request.next - 1 });
  }
  result.later = laterRuns.filter((run) =>
    waits.some((wait) => run.start < wait.end && run.end > wait.start),
  ).length;
  return result;
}
