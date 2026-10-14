// Poll, don't sleep: wait for external state by checking it repeatedly
// against a hard deadline, and fail with a message naming what was awaited.
//
// A fixed sleep is wrong both ways. On a healthy system it wastes the whole
// delay even when the state arrived in milliseconds; on a broken one it ends
// on time and lets the run continue with stale or empty state, so the
// failure surfaces later as an unrelated assertion. Polling returns as soon as
// the state is there and, when it never comes, fails at the deadline with
// what it waited for, how long and how many checks it made.
//
// Time comes from an injected clock and the pause between checks from an
// injected sleep, so a test drives the whole wait without real time passing.
// The deadline is hard. The deadline and cancellation are both read at every
// point the wait commits, including the moment a queued check or pause would
// start: no check or pause starts, and no value is returned, once the clock
// says the time is up or the signal has aborted. A check or pause still
// running at the deadline is cut off by a timer set to the time the clock
// says is left, so a hanging call fails with the same message instead of
// waiting forever. Cutting off is cooperative: the wait's abort signal,
// passed to `check` and `sleep`, fires at the deadline or when the caller
// cancels, and only a check that hands it on (to `fetch`, say) actually stops
// its work. `systemClock`, `systemSleep` and `systemTimer` are the only
// places here that touch real time.

/**
 * A point in time, in milliseconds; injected so tests control it. Only the
 * difference between two readings is used, so the system clock is monotonic.
 */
export interface Clock {
  now(): number;
}

/** Calls `fire` after `ms` milliseconds; returns a function that cancels it. */
export type Timer = (ms: number, fire: () => void) => () => void;

// Monotonic: a wall-clock adjustment (NTP, by hand) during a wait would
// otherwise stretch or shorten its deadline.
export const systemClock: Clock = { now: () => performance.now() };

export const systemTimer: Timer = (ms, fire) => {
  // fixed-delay: cuts off a check or pause still running at the deadline
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
};

/**
 * Pauses for `ms` milliseconds. When `signal` aborts, before or during the
 * pause, it rejects with the signal's reason; either way it leaves no
 * listener behind.
 */
export const systemSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    // fixed-delay: poll interval tick, bounded by the caller's deadline
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export interface PollOptions<T> {
  /**
   * Returns the awaited value, or null/undefined while it is not there yet.
   * `signal` aborts at the deadline or on cancellation; hand it to the
   * request so a check cut off at the deadline stops its work too.
   */
  check: (
    signal: AbortSignal,
  ) => T | null | undefined | Promise<T | null | undefined>;
  /** What is awaited, in words the failure message can name. */
  waitingFor: string;
  /** The longest the whole wait may take, in milliseconds. */
  deadlineMs: number;
  /** The pause between checks, in milliseconds. */
  intervalMs: number;
  /** Cancels the wait; it then rejects with the signal's reason. */
  signal?: AbortSignal;
  clock?: Clock;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  timer?: Timer;
}

/**
 * Run `step`, unless the deadline timer or `signal` ends it first. `open`
 * throws once the wait may not go on (cancelled, or past its deadline), and
 * it is read again at the moment the step would start, so a step never
 * starts on a closed wait: a cancel or a deadline that lands before that
 * moment fires no event the step could hear.
 */
async function within<V>(
  step: () => V | Promise<V>,
  ms: number,
  timer: Timer,
  expire: () => void,
  signal: AbortSignal,
  open: () => void,
): Promise<V> {
  open();
  let cancel: (() => void) | undefined;
  let onAbort: (() => void) | undefined;
  const cutOff = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    cancel = timer(Math.max(ms, 0), expire);
  });
  try {
    const started = Promise.resolve().then(() => {
      open();
      return step();
    });
    return await Promise.race([started, cutOff]);
  } finally {
    cancel?.();
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

const positive = (n: number) => Number.isFinite(n) && n > 0;

/** Resolve with the first value `check` returns that is not null or undefined. */
export async function pollUntil<T>(options: PollOptions<T>): Promise<T> {
  const { check, waitingFor, deadlineMs, intervalMs } = options;
  if (!positive(deadlineMs) || !positive(intervalMs))
    throw new Error(
      `pollUntil(${waitingFor}): deadlineMs and intervalMs must be positive and finite`,
    );
  const clock = options.clock ?? systemClock;
  const sleep = options.sleep ?? systemSleep;
  const timer = options.timer ?? systemTimer;
  const caller = options.signal;
  caller?.throwIfAborted();
  const start = clock.now();
  // Nothing that can throw runs between adding this listener and the `try`
  // whose `finally` removes it.
  const wait = new AbortController();
  const cancel = () => wait.abort(caller?.reason);
  caller?.addEventListener("abort", cancel, { once: true });
  const left = () => start + deadlineMs - clock.now();
  let attempts = 0;
  // Runs as a timer callback, where a throw would escape the wait and leave
  // it unaborted: a clock that fails here ends the wait with its error.
  const timeOut = () => {
    let reason: unknown;
    try {
      reason = new Error(
        `timed out after ${Math.round(clock.now() - start)}ms waiting for ${waitingFor} (${attempts} checks)`,
      );
    } catch (error) {
      reason = error;
    }
    wait.abort(reason);
  };
  const expire = (): never => {
    timeOut();
    throw wait.signal.reason;
  };
  // Every point the wait commits reads this one gate.
  const open = () => {
    wait.signal.throwIfAborted();
    if (left() <= 0) expire();
  };
  const step = <V>(run: () => V | Promise<V>) =>
    within(run, left(), timer, timeOut, wait.signal, open);
  try {
    for (;;) {
      const value = await step(() => {
        attempts++;
        return check(wait.signal);
      });
      // A cancel or the deadline can land after the step settled.
      open();
      if (value !== null && value !== undefined) return value;
      await step(() => sleep(Math.min(intervalMs, left()), wait.signal));
    }
  } finally {
    caller?.removeEventListener("abort", cancel);
    // The wait is over either way: stop anything still holding the signal.
    if (!wait.signal.aborted) wait.abort(new Error("pollUntil finished"));
  }
}
