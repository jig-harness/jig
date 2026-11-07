/** A re-arm request is consumed only after the runtime accepts its launch. */
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import { failureText } from "../text.ts";
import { type LaunchRecord, writeRecord } from "../launches.ts";
import { writeCommandLabel } from "../requests.ts";

export function pendingRearm(record: LaunchRecord): boolean {
  return (
    record.rearmLabel != null &&
    record.rearmConsumed !== true &&
    record.attempts.some((a) => a.outcome === "sent")
  );
}

/** Keep a failed removal pending so later ticks retry it without another launch. */
export async function consumeRearm(
  record: LaunchRecord,
  root?: string,
  remove: typeof writeCommandLabel = writeCommandLabel,
): Promise<Outcome<void, "refused">> {
  if (!pendingRearm(record)) return ok(undefined);
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
    );
  }
  return ok(undefined);
}
