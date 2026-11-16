/** How a launch's test-lock wait reads in a reason; apart from the observer so a result write can use it. */
import { currentMs, parseMs } from "../../shared/time.ts";
import type { LaunchRecord } from "./launches.ts";

/** A current wait, or the last observed wait, never evidence that a deadline was paused. */
export function testLockNote(
  record: LaunchRecord,
  now = currentMs(),
  historical = false,
): string | null {
  const wait = record.testLockWait;
  if (wait === undefined) return null;
  const current = wait.waiting && !historical;
  const duration = Math.max(
    0,
    (current ? now : parseMs(wait.observedAt)) - parseMs(wait.since),
  );
  return `${current ? "is waiting" : "was last seen waiting"} for the test lock for ${Math.floor(duration / 60000)}m (pid ${wait.pid}, since ${wait.since}, observed ${wait.observedAt})`;
}
