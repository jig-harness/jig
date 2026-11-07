/** A re-arm request is consumed only after the runtime accepts its launch. */
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
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
): Promise<Outcome<void, "refused">> {
  if (record.rearmLabel == null || record.rearmConsumed === true)
    return ok(undefined);
  const row = await inspectRow(record.id, root);
  if (!pendingRearm(record, row?.state)) return ok(undefined);
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
