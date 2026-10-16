/** Shared bounded retries and deadline-based polling. Durations are milliseconds. */
import { type Clock, systemClock } from "./clock.ts";
import { Defect } from "./errors.ts";
import { span } from "./trace.ts";

export type RetryOptions = {
  attempts: number;
  baseMs: number;
  maxMs: number;
  /** Classifies a failure: retry only what this names as transient; anything else is rethrown at once. */
  retryIf: (error: unknown, attempt: number) => boolean;
  signal?: AbortSignal;
  clock?: Clock;
  random?: () => number;
};

/** Equal jitter: half to all of the capped exponential delay. Attempt is one-based. */
export function retryDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  return Math.round(
    Math.min(maxMs, baseMs * 2 ** (attempt - 1)) * (0.5 + random() / 2),
  );
}

/**
 * A promise that rejects with the signal's reason once it aborts, including
 * when it already has: a listener added after the event never fires.
 */
function abortion(signal: AbortSignal): {
  aborted: Promise<never>;
  dispose: () => void;
} {
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    aborted,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

/** Abort even when an injected clock ignores its signal; always remove our listener. */
export async function wait(
  ms: number,
  signal?: AbortSignal,
  clock: Pick<Clock, "sleep"> = systemClock,
): Promise<void> {
  checkDelay("delay", ms);
  signal?.throwIfAborted();
  if (!signal) return clock.sleep(ms);
  const { aborted, dispose } = abortion(signal);
  try {
    await Promise.race([clock.sleep(ms, signal), aborted]);
    signal.throwIfAborted();
  } finally {
    dispose();
  }
}

/** Largest delay setTimeout honours; a longer one fires immediately. */
const MAX_TIMER_MS = 2 ** 31 - 1;

function checkAttempts(attempts: number): void {
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new Defect("attempts must be a positive integer");
}

function checkDelay(name: string, ms: number): void {
  if (!(ms >= 0 && ms <= MAX_TIMER_MS))
    throw new Defect(`${name} must be from 0 to ${MAX_TIMER_MS}`);
}

function checkBackoff(
  options: Pick<RetryOptions, "attempts" | "baseMs" | "maxMs">,
): void {
  checkAttempts(options.attempts);
  checkDelay("baseMs", options.baseMs);
  checkDelay("maxMs", options.maxMs);
}

/** A callback's own work is not cancellable here, so cancellation abandons it and refuses its late result. */
async function settle<T>(
  value: T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal || !(value instanceof Promise)) return value;
  const { aborted, dispose } = abortion(signal);
  try {
    return await Promise.race([value, aborted]);
  } finally {
    dispose();
  }
}

/** Bounded attempts for stateful protocols whose body must retain return/break semantics. */
export async function* retryAttempts(
  options: Omit<RetryOptions, "retryIf">,
): AsyncGenerator<number> {
  checkBackoff(options);
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    options.signal?.throwIfAborted();
    if (attempt > 1)
      await span("retry.wait", { attempt }, () =>
        wait(
          retryDelay(
            attempt - 1,
            options.baseMs,
            options.maxMs,
            options.random,
          ),
          options.signal,
          options.clock,
        ),
      );
    yield attempt;
  }
}

export async function retry<T>(
  fn: (attempt: number) => T | Promise<T>,
  options: RetryOptions,
): Promise<T> {
  checkBackoff(options);
  return span("retry", { attempts: options.attempts }, async () => {
    for (let attempt = 1; ; attempt++) {
      options.signal?.throwIfAborted();
      try {
        const value = await settle(fn(attempt), options.signal);
        options.signal?.throwIfAborted();
        return value;
      } catch (error) {
        options.signal?.throwIfAborted();
        if (attempt >= options.attempts || !options.retryIf(error, attempt))
          throw error;
        await wait(
          retryDelay(attempt, options.baseMs, options.maxMs, options.random),
          options.signal,
          options.clock,
        );
      }
    }
  });
}

/** Synchronous publication races cannot yield without changing their callers' API. */
export function retrySync<T>(
  fn: (attempt: number) => T,
  options: Pick<RetryOptions, "attempts" | "retryIf" | "signal">,
): T {
  checkAttempts(options.attempts);
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      const value = fn(attempt);
      options.signal?.throwIfAborted();
      return value;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (attempt >= options.attempts || !options.retryIf(error, attempt))
        throw error;
    }
  }
}

export class PollTimeoutError extends Error {
  constructor() {
    super("poll deadline elapsed");
    this.name = "PollTimeoutError";
  }
}

export type PollOptions<T> = {
  everyMs: number;
  /** Probe once even when the deadline has already elapsed. */
  immediate?: boolean;
  until: (value: T) => boolean;
  /** Absolute epoch deadline, in the injected clock's units. It is checked
   * between probes; a probe bounds its own call, typically with the remaining
   * budget. */
  deadlineMs: number;
  signal?: AbortSignal;
  clock?: Clock;
};

export async function poll<T>(
  fn: () => T | Promise<T>,
  options: PollOptions<T>,
): Promise<T> {
  const clock = options.clock ?? systemClock;
  if (
    !(options.everyMs > 0 && options.everyMs <= MAX_TIMER_MS) ||
    !Number.isFinite(options.deadlineMs)
  )
    throw new Defect(
      `poll requires a positive interval up to ${MAX_TIMER_MS} and a finite deadline`,
    );
  return span("poll", { every_ms: options.everyMs }, async () => {
    let first = true;
    for (;;) {
      options.signal?.throwIfAborted();
      if (clock.now() >= options.deadlineMs && !(first && options.immediate))
        throw new PollTimeoutError();
      first = false;
      const value = await settle(fn(), options.signal);
      options.signal?.throwIfAborted();
      if (options.until(value)) return value;
      const remaining = options.deadlineMs - clock.now();
      if (remaining <= 0) throw new PollTimeoutError();
      await wait(Math.min(options.everyMs, remaining), options.signal, clock);
    }
  });
}
