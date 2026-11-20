/**
 * A claimed pickup whose push the host's test lock held: after its claim,
 * with its work committed, the repository's pre-push hook refused the push
 * only because its wait for the host's machine-wide test lock ran out
 * (`with-resource-lock` printing `could not acquire lock`, no test having
 * run), and the retries the pass could afford did not get through. The pass
 * records `waits --reason test-lock` and asks nothing (`result.ts`).
 *
 * Nothing failed, so no person is asked. The tick relaunches the pickup in
 * its own tree to push and go on (validation, the pre-PR review, the pull
 * request, its drive), without waiting for `dispatch.stalled_after`, as a
 * host fault's stop is relaunched (`pickup-relaunch.ts`), and not before the
 * time the pass named with `--until`, when it named one. The relaunch is
 * held while the host's validation capacity has no room for it, whatever
 * `load.enforce` says (`load.ts`'s `VALIDATION_GAUGES`): started into a full
 * lock, it would only queue there and run out again.
 *
 * Each relaunch's record keeps the record it relaunched (`relaunchOf`), so
 * the lock waits in a row are counted along that chain rather than once
 * per head: a push that never got through leaves the head where it was.
 * Once `LOCK_WAIT_BOUND` such waits are in a row, the pickup is not
 * relaunched again: it is one need, for a diagnosing session (the steward)
 * or a person to find why the lock keeps running out. A batch's stop stays
 * a person's, as a batch's stall does.
 */
import { endedHow } from "./actions/pickup-hold.ts";
import type { ReadRecord } from "./launches.ts";
import { pickupNotice } from "./notices.ts";
import { relaunched, relaunchStep } from "./pickup-relaunch.ts";
import type { PickupInput, PickupPlan } from "./plan-pickups.ts";
import type { LaunchPrReading } from "./stalled-pr.ts";
import type { Action, ClaimedItem } from "./types.ts";
import { parseMs } from "../../shared/time.ts";

/**
 * The lock-wait results in a row, along a pickup's relaunches, after which
 * it is not relaunched again: the first pass's and two relaunches'. A host
 * whose lock runs out that often has a cause a relaunch does not clear (a
 * holder that never lets go, a wait limit too short for its validation
 * load).
 */
export const LOCK_WAIT_BOUND = 3;

/** Whether a pickup's pass recorded that the host's test lock held its push. */
function lockWaited(r: ReadRecord): boolean {
  return (
    r.record.action === "pickup" &&
    r.result === "waits" &&
    r.waitsFor?.reason === "test-lock"
  );
}

/** The lock-wait results in a row ending at `latest`, newest first, along the records each relaunch names. */
function lockWaitChain(
  latest: ReadRecord,
  launches: readonly ReadRecord[],
): ReadRecord[] {
  const chain: ReadRecord[] = [];
  let at: ReadRecord | undefined = latest;
  while (at !== undefined && lockWaited(at) && !chain.includes(at)) {
    chain.push(at);
    const source: string | undefined = at.record.relaunchOf;
    at =
      source === undefined
        ? undefined
        : launches.find((r) => r.record.id === source);
  }
  return chain;
}

/**
 * A claimed item whose latest pickup recorded that the host's test lock
 * held its push: relaunched in its tree, held until the time it named, or,
 * past `LOCK_WAIT_BOUND` waits in a row or with a tree that cannot be
 * relaunched, one need. `false` when the stop is not a lock wait, a pull
 * request it opened moves its item first, it was a batch's, or the relaunch
 * rule does not take it, so the item is planned as any end is.
 */
export function lockWaitStop(
  item: ClaimedItem,
  input: PickupInput,
  plan: PickupPlan,
  latest: ReadRecord | undefined,
  pr: LaunchPrReading,
): boolean {
  if (latest === undefined || pr.step?.kind === "move") return false;
  if (!lockWaited(latest) || latest.record.batchItems !== undefined)
    return false;
  const chain = lockWaitChain(latest, input.launches);
  if (chain.length >= LOCK_WAIT_BOUND) {
    plan.actions.push(
      lockWaitNeed(
        input.slug,
        item,
        latest,
        chain,
        `its push was held by the host's test lock ${chain.length} times in a row, the last ${chain.length - 1} after a relaunch each, so it is not relaunched again`,
      ),
    );
    return true;
  }
  const until = latest.waitsUntil;
  if (until !== undefined && parseMs(until) > input.nowMs) {
    plan.quiet.push({
      target: item.key,
      class: "pickup-ended",
      why: `launch record ${latest.record.id} waits for the host's test lock until ${until}, the time its pass named; then it is relaunched in its tree to push`,
    });
    return true;
  }
  const step = relaunchStep(item, latest, { ...input, lockWait: true });
  if (step.kind === "stall") {
    plan.actions.push(lockWaitNeed(input.slug, item, latest, chain, step.note));
    return true;
  }
  return relaunched(step, item.key, plan);
}

/**
 * The need an item raises when the host's test lock held its pickup's push
 * and no relaunch is left to it: notified once per launch record, for a
 * diagnosing session (the steward) or a person to find why the lock runs
 * out, naming the record, its tree and the lock waits in a row.
 */
function lockWaitNeed(
  slug: string,
  item: Pick<ClaimedItem, "key" | "title" | "state">,
  latest: ReadRecord,
  chain: readonly ReadRecord[],
  note: string,
): Action {
  const { record } = latest;
  const waits = chain.map((r) => r.record.id);
  const reason = `the pickup's push was refused only because the pre-push hook's wait for the host's test lock ran out, and it is not relaunched: ${note}`;
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
      lockWaits: waits.join(", "),
      ended: endedHow(latest),
      ...(record.workspace === null ? {} : { tree: record.workspace.path }),
    },
    cause: "pickup-ended",
    notice: pickupNotice(
      slug,
      `${item.key} test-lock waits, record ${record.id}`,
      `${item.key} (${item.title}): ${reason}; why the host's test lock keeps running out (a holder that never lets go, a wait limit too short for the host's validation load) is diagnosed and repaired, then the branch in ${record.workspace?.path ?? "its tree"} is pushed or the item is left`,
    ),
    ...(record.workspace === null ? {} : { workspace: record.workspace.path }),
    // The pass's ended row in the outcome log already holds how it ended.
    launched: true,
  };
}
