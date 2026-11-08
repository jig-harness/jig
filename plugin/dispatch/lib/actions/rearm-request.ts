/** A re-arm request is consumed only after the runtime accepts its launch. */
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import {
  ghCallTimeoutSeconds,
  KILL_ESCALATE_MS,
} from "../../../skills/drive-pr/scripts/lib/proc.ts";
import { failureText } from "../text.ts";
import { type LaunchRecord, inspectRow, writeRecord } from "../launches.ts";
import { writeCommandLabel } from "../requests.ts";
import { pendingRearm } from "../rearm-state.ts";
export { pendingRearm } from "../rearm-state.ts";

/** Keep a failed removal pending so later ticks retry it without another launch. */
export async function consumeRearm(
  record: LaunchRecord,
  root?: string,
  remove: typeof writeCommandLabel = writeCommandLabel,
  timeLeft: () => number | null = () => null,
): Promise<Outcome<void, "refused">> {
  if (record.rearmLabel == null || record.rearmConsumed === true)
    return ok(undefined);
  // Reserve the native process probe as well as the forge call's kill grace.
  const probeSec = 5;
  const room = (probeMs: number) => {
    const left = timeLeft();
    return (
      left === null ||
      left >= probeMs + ghCallTimeoutSeconds() * 1000 + KILL_ESCALATE_MS
    );
  };
  const later = () =>
    failed(
      "refused" as const,
      "the tick deadline has no room for rearm acknowledgment and its receipt; a later tick retries it",
    );
  if (!room(probeSec * 1000)) return later();
  const row = await inspectRow(record.id, root, probeSec);
  if (!pendingRearm(record, row?.state)) return ok(undefined);
  if (!room(0)) return later();
  const removed = await remove(
    record.repo,
    Number(record.pr),
    String(record.rearmLabel),
    false,
  );
  if (!removed.ok) return removed;
  record.rearmConsumed = true;
  try {
    writeRecord(record, root);
  } catch (error) {
    record.rearmConsumed = false;
    return failed(
      "refused",
      `the rearm label was removed but its acknowledgment could not be kept: ${failureText(error)}`,
      error,
    );
  }
  return ok(undefined);
}
