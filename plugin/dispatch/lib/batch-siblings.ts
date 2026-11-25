/**
 * Claimed siblings of a whole-batch question. The question names no member,
 * so it is one need, on the batch's anchor; each claimed sibling is settled
 * once every item is planned, by whether the anchor's own plan raised it.
 */
import type { ReadRecord } from "./launches.ts";
import type { Holding } from "./holding.ts";
import type { latestPickupFor } from "./pickup-host-fault.ts";
import type { LaunchPrReading } from "./stalled-pr.ts";
import type { PickupInput, PickupPlan } from "./plan-pickups.ts";
import type { Action, ClaimedItem } from "./types.ts";

export interface WaitingSibling {
  item: ClaimedItem;
  input: PickupInput;
  held: Holding;
  pr: LaunchPrReading;
  latest: ReturnType<typeof latestPickupFor>;
  record: ReadRecord;
  anchor: string;
}

/** What settling a sibling needs from the planner, passed in to avoid a cycle. */
export interface SiblingPlanner {
  /** The need a sibling surfaces for the anchor's whole-batch question. */
  asked: (w: WaitingSibling, anchor: ClaimedItem) => Action | null;
  /** Plan the sibling as any claimed item. */
  idle: (w: WaitingSibling) => void;
}

const waitingSiblings = new WeakMap<PickupPlan, WaitingSibling[]>();

/** Record a claimed sibling to settle once every item is planned. */
export function waitForBatchAnchor(
  plan: PickupPlan,
  sibling: WaitingSibling,
): void {
  const waiting = waitingSiblings.get(plan) ?? [];
  waiting.push(sibling);
  waitingSiblings.set(plan, waiting);
}

/**
 * A claimed sibling of a whole-batch question waits quietly only while the
 * anchor's own plan raised that question; the answer is the anchor's to
 * settle. When the anchor is carried by an open pull request and so cannot
 * show it, a sibling surfaces the decision, keeping the anchor as its target
 * so the answer settles the whole batch without releasing the carried claim.
 * Otherwise (the anchor was released) the sibling is planned as any claimed
 * item.
 */
export function settleBatchSiblings(
  plan: PickupPlan,
  planner: SiblingPlanner,
): void {
  for (const w of waitingSiblings.get(plan) ?? []) {
    const shows = plan.actions.some(
      (a) =>
        a.target === w.anchor &&
        a.cause === "pickup-question" &&
        a.evidence.record === w.record.record.id,
    );
    const carried = plan.quiet.some(
      (q) => q.target === w.anchor && q.class === "claimed-carried",
    );
    const asked =
      !shows && carried
        ? planner.asked(
            w,
            w.input.claimed?.find((item) => item.key === w.anchor) ?? w.item,
          )
        : null;
    if (asked !== null) plan.actions.push(asked);
    else if (!shows) {
      planner.idle(w);
      continue;
    }
    plan.quiet.push({
      target: w.item.key,
      class: "pickup-ended",
      why: `waits on the question its batch's pass asked on ${w.anchor}, which names no member; the answer settles the batch while its carried anchor keeps its claim (launch record ${w.record.record.id})`,
    });
  }
}
