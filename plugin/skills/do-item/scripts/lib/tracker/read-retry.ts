import { swallow } from "../../../../../shared/errors.ts";

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
  now = Date.now,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const answer = await send();
    signal.throwIfAborted();
    if (!idempotent || attempt >= 3 || ![429, 503].includes(answer.status))
      return answer;
    const delay = (retryAfterSeconds(answer.headers, now) ?? 1) * 1000;
    if (answer instanceof Response) await discardBody(answer);
    await wait(Math.min(30_000, delay), signal);
  }
}

/** A failed response's cleanup cannot replace its status or prevent a safe retry. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
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
  now = Date.now,
): number | null {
  const header = headers.get("retry-after");
  if (header === null || header.trim() === "") return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds : null;
  const date = Date.parse(header);
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
