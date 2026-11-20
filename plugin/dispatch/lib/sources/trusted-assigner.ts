/**
 * The assigned lane's trust check: each item assigned to the factory
 * identity is wanted only when a person with write access made the
 * assignment. Who made it is read through `assigner-reads.ts`, which keeps
 * the answer between ticks while the item is unchanged; within a tick the
 * shared view reads it once.
 */
import {
  isRateLimited,
  type TrackerRateLimited,
} from "../../../shared/outbound/budget.ts";
import type {
  Assigner,
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { PickupReads } from "../pickup-reads.ts";
import { readFailureOfError } from "../read-failures.ts";
import { failureText } from "../text.ts";
import type { Unplaced, WantedItem } from "../types.ts";
import { keptAssignedBy, type KeptAssigner } from "./assigner-reads.ts";
import { CUT_AT_BOUND, ended, heldTo, passedBefore } from "./bounded.ts";
import type { ServedView } from "./served-reads.ts";
import type { FacetBound } from "./tracker-facets.ts";

export type AssignedBy = Assigner;

/**
 * The assigned items a person with write access assigned, wanted; the
 * others, and those whose assigner cannot be read or `tick` ended before
 * it was, unplaced with why.
 */
export async function byTrustedAssigner(
  tracker: Tracker,
  issues: ReadonlyArray<PoolIssue>,
  identity: string,
  cache: PickupReads,
  view?: ServedView,
  tick?: FacetBound,
): Promise<{
  wanted: WantedItem[];
  unplaced: Unplaced[];
  limited?: TrackerRateLimited;
  assigners: Map<string, AssignedBy>;
}> {
  const wanted: WantedItem[] = [];
  const assigners = new Map<string, AssignedBy>();
  const unplaced: Unplaced[] = [];
  for (const issue of issues) {
    if (view === undefined && ended(tick)) {
      unplaced.push({
        target: issue.identifier,
        title: issue.title,
        url: issue.url,
        record: "tracker",
        reason: `assigned to ${identity} in ${issue.state.name}, but ${passedBefore("who assigned it was read")}`,
        readFailed: true,
        failure: CUT_AT_BOUND,
      });
      continue;
    }
    const read = await readAssigner(
      tracker,
      issue,
      identity,
      cache,
      view,
      tick,
    );
    if ("limited" in read)
      return { wanted: [], unplaced, limited: read.limited, assigners };
    if ("unplaced" in read) {
      unplaced.push(read.unplaced);
      continue;
    }
    assigners.set(issue.identifier, read.by);
    wanted.push(read.wanted);
  }
  return { wanted, unplaced, assigners };
}

/** Who assigned one item, held to `tick` where there is one; the rate limit or an unplaced item when the read failed. */
async function readAssignedBy(
  tracker: Tracker,
  issue: PoolIssue,
  identity: string,
  cache: PickupReads,
  view?: ServedView,
  tick?: FacetBound,
): Promise<
  { by: AssignedBy } | { unplaced: Unplaced } | { limited: TrackerRateLimited }
> {
  const row = (reason: string): Unplaced => ({
    target: issue.identifier,
    title: issue.title,
    url: issue.url,
    record: "tracker",
    reason: `who assigned it cannot be read: ${reason}`,
  });
  let by: KeptAssigner;
  try {
    by =
      view === undefined
        ? await heldTo(
            (signal) => keptAssignedBy(tracker, issue, identity, cache, signal),
            tick,
          )
        : await view.once(
            `assignment ${issue.identifier} ${identity} ${issue.updatedAt ?? ""}`,
            () => keptAssignedBy(tracker, issue, identity, cache, tick?.signal),
          );
  } catch (error) {
    if (isRateLimited(error)) return { limited: error };
    // Every throw fails the read, even when no call class explains it.
    const failure = readFailureOfError(error);
    return {
      unplaced: {
        ...row(failureText(error)),
        readFailed: true as const,
        ...(failure === undefined && !ended(tick)
          ? {}
          : { failure: failure ?? CUT_AT_BOUND }),
      },
    };
  }
  // A complete negative assignment answer is informational.
  return by.ok ? { by: by.value } : { unplaced: row(by.failure.reason) };
}

/** One assigned item's assigner read, held to `tick` where there is one, as a wanted item, an unplaced one or the rate limit. */
async function readAssigner(
  tracker: Tracker,
  issue: PoolIssue,
  identity: string,
  cache: PickupReads,
  view?: ServedView,
  tick?: FacetBound,
): Promise<
  | { wanted: WantedItem; by: AssignedBy }
  | { unplaced: Unplaced }
  | { limited: TrackerRateLimited }
> {
  const read = await readAssignedBy(
    tracker,
    issue,
    identity,
    cache,
    view,
    tick,
  );
  if (!("by" in read)) return read;
  const { by } = read;
  if (!by.trusted) {
    return {
      unplaced: {
        target: issue.identifier,
        title: issue.title,
        url: issue.url,
        record: "tracker",
        reason: `${by.atCreation === true ? "created assigned" : "assigned"} to ${identity} by ${by.name}, who cannot write to ${tracker.team}; only a person with write access starts a pickup`,
        cause: "assigner-cannot-write",
      },
    };
  }
  return {
    by,
    wanted: {
      key: issue.identifier,
      title: issue.title,
      url: issue.url,
      state: issue.state.name,
      assignee: issue.assignee?.name ?? identity,
      assignedBy: by.name,
      queueIssue: issue,
      ...(issue.updatedAt === undefined ? {} : { updatedAt: issue.updatedAt }),
    },
  };
}
