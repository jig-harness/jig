/**
 * A read held to the tick's bound: a rejection once the bound's signal has
 * ended it, whatever the tracker's own transport does after.
 */
import type { FacetBound } from "./tracker-facets.ts";

/** `read`, or a rejection once `bound` has ended it. */
export async function within<T>(
  read: Promise<T>,
  bound: FacetBound,
): Promise<T> {
  let stop: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(new Error("stopped at the tick's deadline"));
    if (bound.signal.aborted) stop();
    else bound.signal.addEventListener("abort", stop, { once: true });
  });
  read.catch(() => undefined);
  try {
    return await Promise.race([read, stopped]);
  } finally {
    if (stop !== undefined) bound.signal.removeEventListener("abort", stop);
  }
}

/** Whether `bound` has ended: its signal fired or its deadline passed. */
export function ended(bound: FacetBound | undefined): boolean {
  return (
    bound !== undefined &&
    (bound.signal.aborted || Date.now() >= bound.deadline)
  );
}
