/** The need an item raises when its pickup stopped on a fault of its host and no restart is left to it. */
import { endedHow, endedQuestion } from "./actions/pickup-hold.ts";
import type { ReadRecord } from "./launches.ts";
import { pickupNotice } from "./notices.ts";
import type { HostFault } from "./pickup-host-fault.ts";
import type { Action, WantedItem } from "./types.ts";

export function restartedNote(source: ReadRecord): string {
  return `it was restarted once after its pickup stopped on a host fault (launch record ${source.record.id}) and stopped on one again, so it is not restarted a second time`;
}

/**
 * The need an item raises when its pickup stopped on a fault of its host
 * and no restart is left to it: notified once per launch record, for a
 * diagnosing session (the steward) or a person to find the fault's cause.
 */
export function hostFaultNeed(
  slug: string,
  item: Pick<WantedItem, "key" | "title" | "state">,
  latest: ReadRecord,
  fault: HostFault,
  note: string,
): Action {
  const { record } = latest;
  const asked = endedQuestion(latest);
  const reason = `the pickup stopped on a fault of this host (${fault.why}), and it is not restarted: ${note}`;
  return {
    stage: "notify",
    target: item.key,
    record: "runtime",
    reason,
    evidence: {
      record: record.id,
      stage: "pickup",
      title: item.title,
      state: item.state,
      account: record.account,
      hostFault: fault.kind,
      ended: endedHow(latest),
      ...(asked === null ? {} : { question: asked }),
    },
    cause: "pickup-ended",
    notice: pickupNotice(
      slug,
      `${item.key} host fault, record ${record.id}`,
      `${item.key} (${item.title}): ${reason}; the host's fault is diagnosed and repaired, then the item is picked up again or left`,
    ),
    ...(record.workspace === null ? {} : { workspace: record.workspace.path }),
    // The pass's ended row in the outcome log already holds how it ended.
    launched: true,
  };
}
