/**
 * `blocked` is never a claim state: an item there waits on a person's answer
 * to its drive's park, and only the drive-ledger projection
 * (`blocked-move.ts`) or a person moves it out. A claim, `do-item`'s or a
 * served person's, refuses it before anything is written. Nothing is read
 * when the repository leaves `issue_tracker.states.blocked` unset.
 */
import type { PoolIssue, Tracker } from "./tracker/port.ts";

/** A claim refused because the item is `blocked`, in the claim's result shape. */
export interface BlockedRefusal {
  outcome: "refused";
  issue: string;
  why: "blocked";
  reason: string;
}

/** The refusal for `key` when it is `blocked`; `null` when it is not, or the state is unset. */
export async function blockedClaimRefusal(
  tracker: Pick<Tracker, "stateName"> & {
    poolIssue(key: string): Promise<PoolIssue | null>;
  },
  key: string,
): Promise<BlockedRefusal | null> {
  const blocked = tracker.stateName("blocked");
  if (blocked === null) return null;
  const issue = await tracker.poolIssue(key);
  if (
    issue === null ||
    issue.state.name.trim().toLowerCase() !== blocked.trim().toLowerCase()
  )
    return null;
  return {
    outcome: "refused",
    issue: key,
    why: "blocked",
    reason: `${key} is ${blocked}: its drive stopped on parked work, and only the drive's projection or a person moves it out`,
  };
}
