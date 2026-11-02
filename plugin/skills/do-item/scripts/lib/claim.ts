/**
 * `do-item`'s claim of an issue, through the tracker port: refuse an issue
 * someone already holds, mark it started and assigned to this session's
 * own identity (the user the tracker's credential acts as), then read it
 * again and stand down when another claim landed first.
 *
 * A tracker offers no conditional write, so a claim racing another inside
 * the re-read is narrowed, not closed; and two claims made with the same
 * identity cannot be told apart by the issue's state and assignee. The
 * dispatcher checks its running sessions for that case.
 */

import {
  type Tracker,
  TrackerRequestError,
  type TrackerUser,
} from "./tracker/port.ts";

export type ClaimTracker = Pick<
  Tracker,
  "viewer" | "assignees" | "assign" | "poolIssue" | "transition" | "stateName"
>;

export type ClaimResult =
  | {
      outcome: "claimed";
      issue: string;
      /** The identity the issue is now assigned to. */
      claimant: TrackerUser;
      /** The tracker's name for the state it is now in. */
      state: string;
    }
  | {
      /** Nothing was written: someone already holds the issue. */
      outcome: "refused";
      issue: string;
      why: "in_progress" | "assigned";
      reason: string;
    }
  | {
      /** The claim was written and the re-read shows another one landed first. */
      outcome: "stood_down";
      issue: string;
      reason: string;
    };

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function names(users: TrackerUser[]): string {
  return users.map((u) => u.name).join(", ");
}

/** Claim `key` for the identity the tracker's credential acts as. */
export async function claimIssue(
  tracker: ClaimTracker,
  key: string,
): Promise<ClaimResult> {
  const me = await tracker.viewer();
  const before = await tracker.poolIssue(key);
  if (before === null)
    throw new TrackerRequestError("unresolved", `issue ${key} does not exist`);
  const started = tracker.stateName("in_progress");
  if (sameName(before.state.name, started))
    return {
      outcome: "refused",
      issue: key,
      why: "in_progress",
      reason: `${key} is already ${started}: another session holds it`,
    };
  const holders = await tracker.assignees(key);
  const others = holders.filter((u) => u.id !== me.id);
  if (others.length > 0)
    return {
      outcome: "refused",
      issue: key,
      why: "assigned",
      reason: `${key} is assigned to ${names(others)}, not to ${me.name}`,
    };

  // The assignment first: a claim racing this one then reads it and refuses.
  if (!holders.some((u) => u.id === me.id)) await tracker.assign(key, me);
  await tracker.transition(key, "in_progress");

  const now = await tracker.assignees(key);
  const after = await tracker.poolIssue(key);
  const landed = now.filter((u) => u.id !== me.id);
  if (landed.length > 0 || !now.some((u) => u.id === me.id))
    return {
      outcome: "stood_down",
      issue: key,
      reason:
        landed.length > 0
          ? `another claim landed first: ${key} is now assigned to ${names(landed)}`
          : `another claim landed first: ${key} is no longer assigned to ${me.name}`,
    };
  if (after === null || !sameName(after.state.name, started))
    return {
      outcome: "stood_down",
      issue: key,
      reason: `another change landed first: ${key} is now ${after?.state.name ?? "gone"}, not ${started}`,
    };
  return { outcome: "claimed", issue: key, claimant: me, state: started };
}
