/** Delivery survives a lost runtime receipt when the wrapper claimed the record. */
import type { LaunchRecord, LaunchState } from "./launches.ts";

export function pendingRearm(
  record: LaunchRecord,
  state?: LaunchState,
): boolean {
  const claimed =
    state !== undefined &&
    state.kind !== "pending" &&
    state.process !== null &&
    state.process.pid > 0;
  return (
    record.rearmLabel != null &&
    record.rearmConsumed !== true &&
    (claimed || record.attempts.some((a) => a.outcome === "sent"))
  );
}
