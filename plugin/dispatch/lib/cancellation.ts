import type { ReadRecord } from "./launches.ts";

/** Cancellation is proof only without a wrapper identity, exit or uncertain runtime receipt. */
export function cancelledBeforeExecution(r: ReadRecord): boolean {
  return (
    r.record.cancelledAt !== undefined &&
    r.state.kind === "died" &&
    r.state.process.pid === 0 &&
    r.record.attempts.every((a) => a.outcome === "failed")
  );
}
