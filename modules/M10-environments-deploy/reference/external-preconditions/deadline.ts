/**
 * Bound one adapter operation. The work receives a signal that aborts at the
 * deadline; the caller stops waiting then even if the work ignores the signal,
 * so a stalled adapter cannot hold back the rest of the run.
 */
export async function withDeadline<T>(
  ms: number,
  what: string,
  work: (signal: AbortSignal) => T | Promise<T>,
  timeoutError: (message: string) => Error,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0)
    throw timeoutError(`invalid deadline for ${what}: ${ms}`);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = timeoutError(`${what} did not finish within ${ms} ms`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
