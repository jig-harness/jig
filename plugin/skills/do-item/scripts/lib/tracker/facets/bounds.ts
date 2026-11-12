/**
 * The bounds of a facet read: the caller's cancellation signal and its
 * overall deadline, folded into one signal every request and page of the
 * read is given. A read whose signal has aborted, or whose deadline has
 * passed, starts no further request; the request in flight ends with it.
 */

import type { FacetReadOptions } from "../port.ts";
import { currentMs } from "../../../../../../shared/time.ts";

/** A facet read stopped by its caller's signal or its deadline. */
export class FacetReadStopped extends Error {}

/**
 * One signal for the read `options` bound, or `undefined` when they bound
 * nothing. A deadline already passed gives a signal already aborted.
 */
export function readSignal(
  options: FacetReadOptions | undefined,
): AbortSignal | undefined {
  const parts: AbortSignal[] = [];
  if (options?.signal !== undefined) parts.push(options.signal);
  if (options?.deadline !== undefined) {
    const left = options.deadline - currentMs();
    parts.push(
      left <= 0
        ? AbortSignal.abort(
            new FacetReadStopped("the facet read's deadline has passed"),
          )
        : AbortSignal.timeout(left),
    );
  }
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : AbortSignal.any(parts);
}

/** Throw before a read starts when its signal has already aborted. */
export function refuseStopped(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const reason: unknown = signal.reason;
  throw reason instanceof Error
    ? new FacetReadStopped(`the facet read was stopped: ${reason.message}`)
    : new FacetReadStopped("the facet read was stopped");
}
