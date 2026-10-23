/**
 * The clock, passed in rather than read from globals, so a test can pin the
 * time and skip the waits. Code that reads the time or waits takes a `Clock`
 * (or the half of it it uses) in its dependencies object, defaulting to
 * `systemClock`.
 */

export type Clock = {
  /** Milliseconds since the epoch, as `Date.now()`. */
  now(): number;
  /**
   * Wait `ms` milliseconds. Resolves early, without rejecting, when `signal`
   * aborts, and then leaves no timer or listener behind.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      // Removed on both outcomes: `{ once: true }` alone removes a listener
      // only when the event fires, so every ordinary wait on a long-lived
      // signal would leave one behind.
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};
