// Waits poll with a deadline; the fixed delays left are local timing.
export async function retry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await attempt();
    } catch (error) {
      if (n === 3) throw error;
      // fixed-delay: back-off between attempts at a flaky local resource
      await Bun.sleep(2 ** n * 100);
    }
  }
}

export function abortAfter(ms: number, controller: AbortController) {
  return setTimeout(() => controller.abort(), ms); // fixed-delay: abort deadline
}

/* A look-alike that is not a delay: oversleep(now) names no delay text. */
export const oversleep = (now: number) => now + 1;
