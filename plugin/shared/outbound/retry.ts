/**
 * The one retry a transport makes inside a call: a read that found the
 * system unreachable or at fault (`retriedOnce` in `failure.ts`) is sent
 * once more, after a jittered backoff, or after the wait the system asked
 * for (`Retry-After`) when that is longer. A write is never sent again: its
 * first request may have landed. Nothing is sent again past the call's
 * deadline: a backoff that would end after it is not waited out, and the
 * first answer stands. A `rate-limited` answer is not retried: nothing is
 * sent before the time it names.
 */
import { swallow } from "../errors.ts";
import { failureOf, type OutboundFailure, retriedOnce } from "./failure.ts";

/** The most requests one call sends: the first and one retry. */
const MOST_ATTEMPTS = 2;

/** The backoff before the retry, before its jitter. */
const BACKOFF_MS = 1_000;

/** The longest wait before a retry; a system that asks for longer is not asked again in this call. */
export const MOST_WAIT_MS = 30_000;

export interface RetryOptions<T> {
  /** Whether the request only reads: only a read is sent again. */
  read: boolean;
  /** The call's cancellation, its deadline included. */
  signal: AbortSignal;
  /** The failure an answer stands for; `null` for an answer to return. */
  failureOf: (answer: T) => OutboundFailure | null;
  /** The failure a throw stands for; the library's `failureOf` when not given. */
  thrownFailure?: (error: unknown) => OutboundFailure;
  /** When the call's deadline passes, epoch milliseconds: a wait that would end after it is not taken. */
  deadlineAt?: number;
  /** Lets go of an answer that is about to be replaced (a response's body). */
  discard?: (answer: T, signal: AbortSignal) => Promise<void>;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  /** A number in [0, 1) for the jitter. */
  random?: () => number;
}

/** The wait before the retry of `failure`: the jittered backoff, or the system's own ask when it is longer. */
export function backoffMs(
  failure: OutboundFailure,
  random: () => number = Math.random,
): number {
  const jittered = BACKOFF_MS * (0.5 + random());
  return Math.max(jittered, failure.retryAfterMs ?? 0);
}

/**
 * Send `send`, and once more when it is a read whose first answer or throw
 * is of a class retried once and the backoff fits before the deadline. The
 * second answer, or the first when there is no second, is returned; a
 * throw is rethrown.
 */
export async function retryRead<T>(
  send: () => Promise<T>,
  options: RetryOptions<T>,
): Promise<T> {
  const { signal } = options;
  const wait = options.wait ?? waitForRetry;
  const now = options.now ?? Date.now;
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    const sent = await sendOnce(send);
    if (!sent.ok && signal.aborted) throw sent.error;
    signal.throwIfAborted();
    const delay = retryDelay(sentFailure(sent, options), attempt, options, now);
    if (delay === null) return settled(sent);
    if (sent.ok) await options.discard?.(sent.answer, signal);
    await wait(delay, signal);
  }
}

/** What one send gave: its answer, or what it threw. */
type Sent<T> = { ok: true; answer: T } | { ok: false; error: unknown };

async function sendOnce<T>(send: () => Promise<T>): Promise<Sent<T>> {
  try {
    return { ok: true, answer: await send() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** The failure a send met: its answer's, or its throw's; `null` for an answer to return. */
function sentFailure<T>(
  sent: Sent<T>,
  options: RetryOptions<T>,
): OutboundFailure | null {
  return sent.ok
    ? options.failureOf(sent.answer)
    : (options.thrownFailure ?? failureOf)(sent.error);
}

/** The send's answer, or its throw again. */
function settled<T>(sent: Sent<T>): T {
  if (sent.ok) return sent.answer;
  throw sent.error;
}

/** How long to wait before sending again; `null` when the call does not send again. */
function retryDelay<T>(
  failure: OutboundFailure | null,
  attempt: number,
  options: RetryOptions<T>,
  now: () => number,
): number | null {
  if (failure === null || !options.read || attempt >= MOST_ATTEMPTS)
    return null;
  if (!retriedOnce(failure.code)) return null;
  const delay = backoffMs(failure, options.random);
  if (delay > MOST_WAIT_MS) return null;
  if (options.deadlineAt !== undefined && now() + delay >= options.deadlineAt)
    return null;
  return delay;
}

/** Lets go of a response's body, never waiting past `signal`; a failed cleanup cannot replace the answer it follows. */
export async function discardBody(
  response: Response,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation === undefined) return;
    if (signal === undefined) {
      await cancellation;
      return;
    }
    await Promise.race([
      cancellation,
      new Promise<never>((_, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        void cancellation.then(
          () => signal.removeEventListener("abort", abort),
          () => signal.removeEventListener("abort", abort),
        );
      }),
    ]);
  } catch (err) {
    swallow(err, "response cleanup failed after its failure was recorded");
  }
}

/** Waits `ms`, or rejects with `signal`'s reason when it aborts first; the timer and the listener go either way. */
export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}
