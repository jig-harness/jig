/** An accepted retry must produce a newer completed attempt before CI can decide again. */
import type { CiAttempts, RetryForge } from "./ci-attempts.ts";

export async function retryWitness(
  head: string,
  state: CiAttempts,
  forge: RetryForge,
  limit: number,
): Promise<"clear" | "waiting" | "expired" | "refresh"> {
  let waiting = false;
  let refreshed = false;
  for (const [key, pending] of state.pending) {
    if (pending.head !== head) continue;
    const current = await forge.observe(head, pending.run);
    if (
      current !== null &&
      current.attempt > pending.attempt &&
      current.completed
    ) {
      state.pending.delete(key);
      refreshed = true;
      continue;
    }
    pending.polls += 1;
    // A retry must not wait forever when the forge never acknowledges it.
    if (pending.polls > (limit > 0 ? limit : 180)) {
      console.error(
        `Retry of run ${pending.run} on head ${head} has no newer completed attempt after ${pending.polls - 1} polls; CI remains indeterminate.`,
      );
      return "expired";
    }
    console.error(
      `Waiting for retry of run ${pending.run} on head ${head} after attempt ${pending.attempt}.`,
    );
    waiting = true;
  }
  return waiting ? "waiting" : refreshed ? "refresh" : "clear";
}
