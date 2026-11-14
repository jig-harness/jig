/**
 * A read held to the tick's bound: a rejection once the bound's signal has
 * ended it, whatever the tracker's own transport does after.
 *
 * A tick its launcher bounds has one bound (`TickBound`), made as it starts
 * from the launcher's deadline less the time its receipt needs
 * (`tick-context.ts`): every read of its observe phase is held to it. A read
 * the bound ended before it started is not started, and is reported as a
 * failed read in the words `passedBefore` gives; one in flight is given the
 * bound's signal where its transport takes one, and held to it with
 * `within` either way. A tick no launcher bounds has no bound, and its reads
 * run as they always did.
 *
 * Either way the read fails as `unreachable`, the class of a deadline that
 * passed with nothing received
 * ([ADR-0021](../../../../docs/adr/ADR-0021-outbound-calls-are-governed.md)):
 * it clears by waiting, and the failure ledger tells a person when it keeps
 * happening.
 */
import type { FacetBound } from "./tracker-facets.ts";
import type { Outcome } from "../../../shared/outcome.ts";
import {
  type CausedFailure,
  failedBy,
  OutboundError,
  outboundFailure,
} from "../../../shared/outbound/failure.ts";
import { currentMs } from "../../../shared/time.ts";

/** The tick's own bound: its deadline (epoch milliseconds) and the signal that fires there. */
export type TickBound = FacetBound;

/** The bound of a tick that must have ended by `deadline` (epoch milliseconds); none without one. */
export function boundAt(
  deadline: number | undefined,
  now = currentMs(),
): TickBound | undefined {
  if (deadline === undefined) return undefined;
  return {
    deadline,
    signal: AbortSignal.timeout(Math.max(0, deadline - now)),
  };
}

/** Why a read was not started: the tick's deadline passed before `what`. */
export function passedBefore(what: string): string {
  return `the tick's deadline passed before ${what}`;
}

/** The failed read of what the tick's bound ended before: `unreachable`, saying what was not done. */
export function passedRead(what: string): {
  ok: false;
  failure: CausedFailure<"unreadable">;
} {
  const reason = passedBefore(what);
  return failedBy("unreadable", outboundFailure("unreachable", reason), reason);
}

/** `read`, or an `unreachable` rejection once `bound` has ended it. */
export async function within<T>(
  read: Promise<T>,
  bound: FacetBound,
): Promise<T> {
  let stop: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    stop = () =>
      reject(
        new OutboundError("unreachable", "stopped at the tick's deadline"),
      );
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

/** `read` started with `bound`'s signal and held to it; started plainly when there is no bound. */
export function heldTo<T>(
  read: (signal?: AbortSignal) => Promise<T>,
  bound: FacetBound | undefined,
): Promise<T> {
  return bound === undefined ? read() : within(read(bound.signal), bound);
}

/** `read`, not started once `bound` has ended: a failed read then, saying what was not done before the deadline. */
export function unlessEnded<T>(
  bound: FacetBound | undefined,
  what: string,
  read: () => Promise<Outcome<T, "unreadable">>,
): Promise<Outcome<T, "unreadable">> {
  return ended(bound) ? Promise.resolve(passedRead(what)) : read();
}

/** Whether `bound` has ended: its signal fired or its deadline passed. */
export function ended(bound: FacetBound | undefined): boolean {
  return (
    bound !== undefined &&
    (bound.signal.aborted || currentMs() >= bound.deadline)
  );
}
