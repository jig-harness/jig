/**
 * The ready pool (`dispatch.pool`): the unassigned open items in the pool's
 * states, inside the tracker's pool scope, picked up as the factory
 * identity's. Nobody assigned them, so trust moves from who assigned an
 * item to who made it ready: the latest move into its state must be a
 * trusted person's (`stateChangedBy`), and an item someone else moved there,
 * or whose mover cannot be read, is reported with why and never planned.
 * The holds and the repository scope a served item meets apply here too, and
 * the wanted items are ranked by the queue's rules.
 *
 * The pickup's claim assigns the item to the factory identity; the claim
 * marker the pool requires decides between hosts that take the same item.
 */
import {
  isRateLimited,
  type TrackerRateLimited,
} from "../../../shared/tracker-budget.ts";
import type {
  Assigner,
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { PickupReads } from "../pickup-reads.ts";
import { queueHold, rankQueue } from "../queue-rank.ts";
import { failureText } from "../text.ts";
import type { DispatchSection, Unplaced, WantedItem } from "../types.ts";
import type { ServedPolicy } from "./served.ts";
import {
  NEEDS_REPOSITORY_LABEL,
  otherRepoLabel,
  unlabeledOutcome,
} from "./served-repo.ts";
import { trackerScope } from "./served-reads.ts";

export interface PoolReading {
  wanted: WantedItem[];
  unplaced: Unplaced[];
  /** The pool's states as the tracker names them, for the read's detail; `null` with no pool. */
  states: string | null;
  /** How many unassigned items the pool held. */
  read: number;
  limited?: TrackerRateLimited;
  /** The pool could not be read: its items are not known. */
  failed?: true;
}

const NONE: PoolReading = { wanted: [], unplaced: [], states: null, read: 0 };

/** The pool's states as the tracker names them. */
function stateNames(tracker: Tracker, pool: { states: string[] }): string {
  return pool.states
    .map((s) => tracker.stateName(s as Parameters<Tracker["stateName"]>[0]))
    .filter((n): n is string => n !== null)
    .join(", ");
}

/** Why the item is not this repository's to start now, or `null` when it is; `"leave"` for another checkout's item. */
function heldOut(issue: PoolIssue, policy: ServedPolicy): string | null {
  if (otherRepoLabel(issue.labels, policy.repoScope) !== null) return "leave";
  const unlabeled = unlabeledOutcome(
    issue.labels,
    policy.repoScope,
    policy.unlabeled,
  );
  if (unlabeled === "leave") return "leave";
  if (unlabeled === "hold") return NEEDS_REPOSITORY_LABEL;
  return queueHold({ issue, blockers: [], unblocks: 0 }, policy);
}

/** Who made `issue` ready, when that is a trusted person; else the row that says why not. */
async function madeReadyBy(
  read: (issue: PoolIssue) => Promise<Assigner>,
  team: string,
  issue: PoolIssue,
): Promise<{ by: string } | { row: Unplaced }> {
  const row = (reason: string): { row: Unplaced } => ({
    row: {
      target: issue.identifier,
      title: issue.title,
      url: issue.url,
      record: "tracker",
      reason,
    },
  });
  let by: Assigner;
  try {
    by = await read(issue);
  } catch (error) {
    if (isRateLimited(error)) throw error;
    return row(
      `in the ready pool (${issue.state.name}), but who made it ready cannot be read: ${failureText(error)}`,
    );
  }
  if (!by.trusted)
    return row(
      `moved to ${issue.state.name} by ${by.name}, who cannot write to ${team}; only an item a person with write access made ready is picked up from the pool`,
    );
  return { by: by.name };
}

/**
 * Who made an item ready, kept in `cache` until the item's update time
 * changes (a move changes it), as a served item's assigner is kept; a read
 * that fails is never kept, and the launch reads it again uncached.
 */
function moverReader(
  tracker: Tracker,
  stateChangedBy: NonNullable<Tracker["stateChangedBy"]>,
  cache: PickupReads | undefined,
): (issue: PoolIssue) => Promise<Assigner> {
  return async (issue) => {
    const key = `${trackerScope(tracker)}:pool:${issue.identifier}`;
    const kept = cache?.get<{ updatedAt: string; by: Assigner }>(key);
    if (issue.updatedAt && kept?.updatedAt === issue.updatedAt) return kept.by;
    const by = await stateChangedBy.call(tracker, issue.identifier);
    if (issue.updatedAt) cache?.set(key, { updatedAt: issue.updatedAt, by });
    return by;
  };
}

/** A pool that picks up nothing, with the row that says why. */
function unread(tracker: Tracker, names: string, reason: string): PoolReading {
  return {
    ...NONE,
    states: names,
    failed: true,
    unplaced: [
      {
        target: `${tracker.adapter} ${tracker.team}`,
        record: "tracker",
        reason,
      },
    ],
  };
}

/** The wanted item for a pool issue a trusted person made ready. */
function wantedOf(issue: PoolIssue, identity: string, by: string): WantedItem {
  return {
    key: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.state.name,
    assignee: identity,
    assignedBy: by,
    pooled: true,
    queueIssue: issue,
    queueRank: { unblocks: 0 },
    ...(issue.updatedAt === undefined ? {} : { updatedAt: issue.updatedAt }),
  };
}

/** One pool issue: held out (`row`), another checkout's (`null`), or who made it ready (`by`). */
async function placed(
  read: (issue: PoolIssue) => Promise<Assigner>,
  team: string,
  issue: PoolIssue,
  policy: ServedPolicy,
): Promise<{ by: string } | { row: Unplaced } | null> {
  const held = heldOut(issue, policy);
  if (held === "leave") return null;
  if (held === null) return madeReadyBy(read, team, issue);
  return {
    row: {
      target: issue.identifier,
      title: issue.title,
      url: issue.url,
      record: "tracker",
      reason: `in the ready pool (${issue.state.name}), but ${held}`,
    },
  };
}

/**
 * Every pool issue placed: the rows of those held out, and the ranked
 * candidates; the rate limit, where a read met it, ends the reading there
 * with nothing wanted.
 */
async function placeAll(
  read: (issue: PoolIssue) => Promise<Assigner>,
  team: string,
  issues: readonly PoolIssue[],
  policy: ServedPolicy,
): Promise<{
  reading: Omit<PoolReading, "states" | "wanted">;
  ranked: Array<{ issue: PoolIssue; by: string }>;
}> {
  const reading: Omit<PoolReading, "states" | "wanted"> = {
    unplaced: [],
    read: issues.length,
  };
  const candidates: Array<{ issue: PoolIssue; by: string }> = [];
  for (const issue of issues) {
    let one: Awaited<ReturnType<typeof placed>>;
    try {
      one = await placed(read, team, issue, policy);
    } catch (error) {
      if (!isRateLimited(error)) throw error;
      return { reading: { ...reading, limited: error }, ranked: [] };
    }
    if (one === null) continue;
    if ("row" in one) reading.unplaced.push(one.row);
    else candidates.push({ issue, by: one.by });
  }
  return {
    reading,
    ranked: rankQueue(
      candidates.map((c) => ({ ...c, blockers: [], unblocks: 0 })),
    ),
  };
}

/**
 * The pool's pickups, ranked, and the items it holds out with why; with no
 * pool configured, nothing. A tracker that cannot read the pool reports so
 * once and picks up nothing from it; the tracker's rate limit ends the
 * reading where it met it.
 */
export async function readPoolPickups(
  tracker: Tracker,
  section: DispatchSection,
  policy: ServedPolicy = {},
  cache?: PickupReads,
): Promise<PoolReading> {
  const { pool, identity } = section;
  if (pool === undefined || identity === null) return NONE;
  const names = stateNames(tracker, pool);
  const { unassignedIssues, stateChangedBy } = tracker;
  if (unassignedIssues === undefined || stateChangedBy === undefined)
    return unread(
      tracker,
      names,
      `dispatch.pool is set, but the ${tracker.adapter} adapter reads no ready pool: nothing is picked up from it`,
    );
  const read = moverReader(tracker, stateChangedBy, cache);
  let issues: PoolIssue[];
  try {
    issues = await unassignedIssues.call(tracker, pool.states);
  } catch (error) {
    if (isRateLimited(error)) return { ...NONE, states: names, limited: error };
    return unread(
      tracker,
      names,
      `the ready pool (${names}) could not be read: ${failureText(error)}`,
    );
  }
  const out = await placeAll(read, tracker.team, issues, policy);
  return {
    ...out.reading,
    states: names,
    wanted: out.ranked.map((c) => wantedOf(c.issue, identity, c.by)),
  };
}

/**
 * The launch-time read of a pool pickup: the item as the tracker holds it
 * while it is still open, unassigned, in a pool state, free of the holds
 * and made ready by a trusted person; else why not.
 */
export async function freshPoolPickup(
  tracker: Tracker,
  section: DispatchSection,
  key: string,
  policy: ServedPolicy = {},
): Promise<PoolIssue | string> {
  const pool = section.pool;
  if (pool === undefined) return "dispatch.pool is no longer set";
  if (tracker.stateChangedBy === undefined)
    return `the ${tracker.adapter} adapter reads no ready pool`;
  let issue: PoolIssue | null;
  try {
    issue = await tracker.poolIssue(key);
  } catch (error) {
    return `the tracker cannot be read again: ${failureText(error)}`;
  }
  if (issue === null) return "it no longer exists";
  if (issue.assignee !== null)
    return `it is assigned to ${issue.assignee.name} since the plan read it`;
  const inPool = pool.states.some((s) => {
    const name = tracker.stateName(s);
    return (
      name !== null && name.toLowerCase() === issue.state.name.toLowerCase()
    );
  });
  if (!inPool)
    return `it is in ${issue.state.name}, no longer in the ready pool (${stateNames(tracker, pool)})`;
  const held = heldOut(issue, policy);
  if (held === "leave")
    return "it carries another repository's label, or no repository label places it here";
  if (held !== null) return held;
  try {
    const by = await tracker.stateChangedBy(key);
    if (!by.trusted)
      return `it was moved to ${issue.state.name} by ${by.name}, who cannot write to ${tracker.team}`;
  } catch (error) {
    return `who made it ready cannot be read again: ${failureText(error)}`;
  }
  return issue;
}
