/**
 * Bound one adapter operation. The work receives a signal that aborts at the
 * deadline; the caller stops waiting then even if the work ignores the signal,
 * so a stalled adapter cannot hold back the rest of the run. Synchronous work
 * blocks the timer, so a result that arrives after the deadline is rejected as
 * late rather than counted: overrunning work never succeeds, it only delays the
 * failure until it yields.
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
  const expiredError = () =>
    timeoutError(`${what} did not finish within ${ms} ms`);
  const due = performance.now() + ms;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = expiredError();
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      expired,
    ]);
    if (performance.now() >= due) {
      const error = expiredError();
      controller.abort(error);
      throw error;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Let an overdue deadline's timer run, then stop if it fired. Multi-step
 * adapters call this between synchronous steps so a deadline ends the work at
 * the next step rather than after every remaining one.
 */
export async function checkpoint(
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return;
  await new Promise((resolve) => setTimeout(resolve, 0));
  signal.throwIfAborted();
}
