/** How a tick holds or resumes pickups with a named dependency. */
import { pickupClaimed } from "./actions/pickup-hold.ts";
import type { Holding } from "./holding.ts";
import { holds, type ReadRecord } from "./launches.ts";
import { pickupNotice } from "./notices.ts";
import {
  pickupHoldReason,
  type PersonPickupHold,
} from "./person-pickup-holds.ts";
import { pickupConditionWords } from "./pickup-condition.ts";
import { latestPickupFor } from "./pickup-host-fault.ts";
import { readLaunchPr, type LaunchPrReading } from "./stalled-pr.ts";
import { relaunchStep } from "./pickup-relaunch.ts";
import type { PickupInput, PickupPlan } from "./plan-pickups.ts";
import type { Action, ClaimedItem } from "./types.ts";

export interface ConditionalPickups {
  conditionalHolds?: PersonPickupHold[];
}

export function planConditionNeeds(input: PickupInput, plan: PickupPlan): void {
  for (const wait of input.conditionalHolds ?? []) {
    // A hold whose item left the line (completed, deleted, reassigned) needs no one;
    // an item still claimed or still assigned for pickup is on it. With no claimed
    // list read, keep the need rather than drop it.
    const onLine =
      input.claimed == null ||
      input.claimed.some((item) => item.key === wait.item) ||
      input.pickups.some((item) => item.key === wait.item);
    if (wait.settled === "closed-unmerged" && onLine)
      plan.actions.push(conditionNeed(input, wait, pickupHoldReason(wait)));
  }
}

/** The ended pickup no longer holds a ready item once the dependency clears. */
export function conditionalRecords(
  input: Pick<PickupInput, "launches" | "conditionalHolds">,
  item: string,
): ReadRecord[] | null {
  const wait = input.conditionalHolds?.find((hold) => hold.item === item);
  if (wait === undefined) return input.launches;
  if (wait.settled !== "cleared") return null;
  return input.launches.filter(
    ({ record, state }) =>
      record.item !== item ||
      record.batchItems !== undefined ||
      record.createdAt > wait.at ||
      holds(state),
  );
}

/** Resume the pickup's original claim once its dependency is satisfied. */
export function planConditionalClaim(
  item: ClaimedItem,
  input: PickupInput,
  plan: PickupPlan,
  held: Holding,
  settledByPr: (pr: LaunchPrReading) => boolean,
): boolean {
  const stored = input.conditionalHolds?.find((hold) => hold.item === item.key);
  const latest = latestPickupFor(item.key, input.launches);
  const wait = storedOrReleased(item, stored, latest);
  if (wait === null) return false;
  if (wait.settled !== "cleared") return true;
  if (latest !== undefined && latest.record.createdAt > wait.at) return false;
  if (held.kind === "unknown") return keepUnplaced(item.key, plan, held.reason);
  const record = latest?.record;
  if (
    record === undefined ||
    (wait.resumeRecord !== undefined && record.id !== wait.resumeRecord) ||
    !pickupClaimed(record, item.key) ||
    wait.condition === undefined
  )
    return false;
  const pr = readLaunchPr(item, input.launches, input.sessions, input.prOpen);
  if (settledByPr(pr)) return true;
  // An open pull request may already settle the pickup: wait for a tick that reads it.
  if (pr.read.kind === "unread")
    return keepUnplaced(item.key, plan, pr.read.why);
  const dependency = pickupConditionWords(wait.condition);
  const step = relaunchStep(item, latest, { ...input, dependency });
  if (step.kind === "relaunch") plan.actions.push(step.action);
  else if (step.kind === "held")
    plan.quiet.push({ target: item.key, class: "claimed", why: step.why });
  else if (step.kind === "stall")
    plan.actions.push(conditionNeed(input, wait, step.note));
  else if (input.trees !== undefined)
    plan.actions.push(
      conditionNeed(
        input,
        wait,
        `the dependency cleared, but the claimed pickup's original workspace cannot be resumed`,
      ),
    );
  return true;
}

function conditionNeed(
  input: PickupInput,
  wait: PersonPickupHold,
  detail: string,
): Action {
  const title =
    input.claimed?.find((item) => item.key === wait.item)?.title ?? wait.title;
  const reason = `pickup ${wait.item}: ${detail}`;
  return {
    stage: "notify",
    target: wait.item,
    record: "tracker",
    reason,
    cause: "pickup-ended",
    evidence: { stage: "pickup", title },
    notice: pickupNotice(
      input.slug,
      `${wait.item} dependency, hold ${wait.at}`,
      reason,
    ),
  };
}

function keepUnplaced(key: string, plan: PickupPlan, reason: string): true {
  plan.idleKeep.push(key);
  plan.unplaced.push({ target: key, record: "runtime", reason });
  return true;
}

/** The stored hold, or one rebuilt from the waiting record of a hold a person released. */
function storedOrReleased(
  item: ClaimedItem,
  stored: PersonPickupHold | undefined,
  latest: ReturnType<typeof latestPickupFor>,
): PersonPickupHold | null {
  if (stored !== undefined) return stored;
  // A person who releases a conditional hold deletes its row; the pickup's
  // waiting record then still names the condition, and it resumes like a cleared one.
  const condition =
    latest?.result === "waits" ? latest.waitsFor?.condition : undefined;
  if (condition === undefined) return null;
  return {
    item: item.key,
    by: "a person",
    at: latest?.record.createdAt ?? "",
    title: item.title,
    url: null,
    condition,
    settled: "cleared",
  };
}
