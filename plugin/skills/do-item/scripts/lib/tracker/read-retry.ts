import { swallow } from "../../../../../shared/errors.ts";
import { currentMs, parseHttpDateMs } from "../../../../../shared/time.ts";

/** Bounded retries for requests their builders explicitly identify as reads. */
interface RetryAnswer {
  status: number;
  headers: Headers;
}

/** Retry only refused or unavailable reads; every attempt shares one deadline. */
export async function retryRead<T extends RetryAnswer>(
  send: () => Promise<T>,
  idempotent: boolean,
  signal: AbortSignal,
  wait = waitForRetry,
  now = currentMs,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const answer = await send();
    signal.throwIfAborted();
    if (!idempotent || attempt >= 3 || ![429, 503].includes(answer.status))
      return answer;
    const delay = (retryAfterSeconds(answer.headers, now) ?? 1) * 1000;
    if (answer instanceof Response) await discardBody(answer, signal);
    await wait(Math.min(30_000, delay), signal);
  }
}

/** A failed response's cleanup cannot replace its status or prevent a safe retry. */
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
    swallow(
      err,
      "response cleanup failed after its retryable status was recorded",
    );
  }
}

/** Retry-After permits either nonnegative seconds or an HTTP date. */
export function retryAfterSeconds(
  headers: Headers,
  now = currentMs,
): number | null {
  const header = headers.get("retry-after");
  if (header === null || header.trim() === "") return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds : null;
  const date = parseHttpDateMs(header);
  return Number.isFinite(date) ? Math.max(0, date - now()) / 1000 : null;
}

/** Cancel the timer and detach its listener on both completion paths. */
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
