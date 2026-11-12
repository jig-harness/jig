/** Served pickups preserve the person's assignment and revalidate inherited authority live. */
import {
  type ClaimResult,
  blockedStateRefusal,
  claimFromRefusal,
} from "./claim.ts";
import { blocksWithin } from "./blocker-chain.ts";
import { servedParentHold } from "../../../../dispatch/lib/sources/served-parents.ts";
import type {
  CanonicalState,
  Issue,
  PoolIssue,
  Tracker,
  TrackerUser,
} from "./tracker/port.ts";

export interface ServedClaim {
  person: string;
  /** The epic the claimed item's authority is inherited through; with `blocking`, the epic of that item. */
  ancestor?: string;
  /** A served item the claimed one blocks: the claim pulls an unassigned blocker forward on that item's authority. */
  blocking?: string;
  /** Set while the `blocking` item itself is validated: it waits on the claimed one by definition. */
  blocked?: boolean;
  hitlLabel?: string;
  manualOpsLabel?: string;
  /** `do_item.execution_plan_block`: the fenced block the origin's ancestor plans are read from. */
  executionPlanBlock?: string;
  /** `do_item.claim_from`; `null` or absent keeps the not-started states alone. */
  claimFrom?: readonly CanonicalState[] | null;
}
const only = (holders: TrackerUser[], user: TrackerUser) =>
  holders.length === 1 && holders[0]?.id === user.id;
const waiting = (type: string) =>
  ["triage", "backlog", "unstarted"].includes(type);
const hold = (labels: string[], options: ServedClaim) =>
  labels.some(
    (l) =>
      l === (options.hitlLabel ?? "hitl") ||
      l.startsWith(`${options.hitlLabel ?? "hitl"}:`) ||
      l === (options.manualOpsLabel ?? "manual-ops") ||
      l === "jig:hold",
  );

/** Open blockers, including unreadable ones, withhold permission to start. */
async function blockedReason(
  tracker: Tracker,
  key: string,
): Promise<string | null> {
  for (const relation of await tracker.listRelations(key)) {
    if (relation.type !== "blocked_by") continue;
    const blocker = await tracker.poolIssue(relation.issue);
    if (
      !blocker ||
      !["completed", "canceled", "duplicate"].includes(blocker.state.type)
    )
      return `waiting on ${relation.issue}`;
  }
  return null;
}

/** A claimed child must still be in the exact state this claim wrote. */
function nodeStateAllowed(
  tracker: Tracker,
  issue: Issue,
  child: boolean,
  claimed: boolean,
): boolean {
  if (!child)
    return ["triage", "backlog", "unstarted", "started"].includes(
      issue.state.type,
    );
  if (!claimed) return waiting(issue.state.type);
  return (
    issue.state.name.toLowerCase() ===
    tracker.stateName("in_progress", issue)?.toLowerCase()
  );
}

/** Each ancestry node must be readable, open and free of holds. */
async function readNode(
  tracker: Tracker,
  current: string,
  child: boolean,
  options: ServedClaim,
  claimed: boolean,
): Promise<{ issue: Issue } | { reason: string }> {
  const issue = await tracker.getIssue(current);
  const pool = await tracker.poolIssue(current);
  if (!pool || pool.truncated.length)
    return { reason: `${current} has incomplete pickup facts` };
  if (!issue || issue.identifier !== current)
    return { reason: `cannot verify ancestry at ${current}` };
  const allowed = nodeStateAllowed(tracker, issue, child, claimed);
  if (!allowed)
    return { reason: `${current} is no longer open and not started` };
  if (hold(issue.labels, options))
    return { reason: `${current} needs a person to start` };
  if (child && blockedStateRefusal(tracker, current, issue.state.name, issue))
    return { reason: `${current} is in the blocked state` };
  if (!child && !issue.isEpic)
    return { reason: `${current} is no longer an epic` };
  const blocked = await blockedReasonForNode(tracker, current, child, options);
  return blocked ? { reason: blocked } : { issue };
}

/** A claimed child already represents its blocker's successful admission. */
async function blockedReasonForNode(
  tracker: Tracker,
  current: string,
  child: boolean,
  options: ServedClaim,
): Promise<string | null> {
  if (child && options.blocked) return null;
  return blockedReason(tracker, current);
}

/** Only the sole served assignee, assigned by a writer, supplies authority. */
async function authorityReason(
  tracker: Tracker,
  current: string,
  holders: TrackerUser[],
  user: TrackerUser,
  person: string,
): Promise<string | null> {
  if (!only(holders, user))
    return `${current} is not assigned solely to ${user.name}`;
  const assigner = await tracker.assignedBy(current, person);
  return assigner.trusted
    ? null
    : `${current}'s assignment was not made by a repository writer`;
}

/** Inherited claims require an empty child before writing, and our person alone afterwards. */
function inheritedAssignmentMismatch(
  child: boolean,
  options: ServedClaim,
  holders: TrackerUser[],
  user: TrackerUser,
  claimed: boolean,
): boolean {
  if (!child || !options.ancestor) return false;
  return claimed ? !only(holders, user) : holders.length !== 0;
}

/** The live parent links, rather than a queue snapshot, establish inherited authority. */
async function validateAssignment(
  tracker: Tracker,
  key: string,
  user: TrackerUser,
  options: ServedClaim,
  claimed = false,
): Promise<string | null> {
  const seen = new Set<string>();
  let current = key;
  for (;;) {
    if (seen.has(current) || seen.size >= 100)
      return "ancestry is cyclic or too deep";
    seen.add(current);
    const node = await readNode(
      tracker,
      current,
      current === key,
      options,
      claimed,
    );
    if ("reason" in node) return node.reason;
    const holders = await tracker.assignees(current);
    if (
      inheritedAssignmentMismatch(
        current === key,
        options,
        holders,
        user,
        claimed,
      )
    )
      return `${key} no longer has the expected assignment`;
    if (current === (options.ancestor ?? key))
      return authorityReason(tracker, current, holders, user, options.person);
    if (holders.some((h) => h.id !== user.id))
      return `${current} has a conflicting assignee`;
    if (!node.issue.parent)
      return `${options.ancestor} is no longer an ancestor of ${key}`;
    current = node.issue.parent.identifier;
  }
}

/** An epic, or an item with open children: a queue never pulls one forward. */
async function isEpic(tracker: Tracker, key: string): Promise<boolean> {
  const item = await tracker.poolIssue(key);
  return item !== null && (item.hasOpenChildren || item.isEpic);
}

/** The reason an item's epic plans hold it, else null; an unreadable plan holds. */
async function planHold(
  tracker: Tracker,
  item: PoolIssue,
  options: ServedClaim,
): Promise<string | null> {
  return servedParentHold(
    tracker,
    item,
    { get: () => null, set: () => undefined },
    options.executionPlanBlock,
  );
}

/** Whether a blocker chain may pass through an item, as the queue would traverse it. */
async function passable(
  tracker: Tracker,
  key: string,
  options: ServedClaim,
): Promise<boolean> {
  const item = await tracker.poolIssue(key);
  return (
    item !== null &&
    item.truncated.length === 0 &&
    item.assignee === null &&
    waiting(item.state.type) &&
    blockedStateRefusal(
      tracker,
      key,
      item.state.name,
      item.nativeType ?? null,
    ) === null &&
    !(await isEpic(tracker, key)) &&
    !hold(item.labels, options) &&
    (await planHold(tracker, item, options)) === null
  );
}

/**
 * A pulled blocker carries no assignment of its own: it must be an empty, open,
 * unheld non-epic that the served item blocks through live relations, and that
 * item must still hold the person's authority, directly or through its epic.
 */
async function validatePulled(
  tracker: Tracker,
  key: string,
  user: TrackerUser,
  options: ServedClaim,
  claimed: boolean,
): Promise<string | null> {
  const origin = options.blocking as string;
  const node = await readNode(tracker, key, true, options, claimed);
  if ("reason" in node) return node.reason;
  if (await isEpic(tracker, key))
    return `${key} is an epic and is not pulled forward`;
  const holders = await tracker.assignees(key);
  if (claimed ? !only(holders, user) : holders.length !== 0)
    return `${key} no longer has the expected assignment`;
  if (origin === key) return `${key} cannot block itself`;
  const authority = await validateAssignment(
    tracker,
    origin,
    user,
    {
      person: options.person,
      ...(options.ancestor ? { ancestor: options.ancestor } : {}),
      ...(options.hitlLabel ? { hitlLabel: options.hitlLabel } : {}),
      ...(options.manualOpsLabel
        ? { manualOpsLabel: options.manualOpsLabel }
        : {}),
      blocked: true,
    },
    false,
  );
  if (authority) return `${origin}, which ${key} blocks: ${authority}`;
  // Every item that authorizes the work is gated by its epic plans at the write: the origin, the target and each item between.
  const originItem = await tracker.poolIssue(origin);
  if (originItem === null)
    return `${origin}, which ${key} blocks, cannot be read`;
  const originHold = await planHold(tracker, originItem, options);
  if (originHold !== null)
    return `${origin}, which ${key} blocks: ${originHold}`;
  const targetItem = await tracker.poolIssue(key);
  if (targetItem === null) return `${key} cannot be read`;
  const targetHold = await planHold(tracker, targetItem, options);
  if (targetHold !== null) return `${key}: ${targetHold}`;
  const through = (via: string) => passable(tracker, via, options);
  return (await blocksWithin(tracker, origin, key, through))
    ? null
    : `${key} no longer blocks ${origin}`;
}

/** The live links, not a queue snapshot, establish authority: a pulled blocker through the item it blocks. */
function validateClaim(
  tracker: Tracker,
  key: string,
  user: TrackerUser,
  options: ServedClaim,
  claimed = false,
): Promise<string | null> {
  return options.blocking
    ? validatePulled(tracker, key, user, options, claimed)
    : validateAssignment(tracker, key, user, options, claimed);
}

/**
 * A served claim: refused before any write when the item's state is
 * outside `claim_from`, else `claimServed`.
 */
export async function claimServedIssue(
  tracker: Tracker,
  key: string,
  options: ServedClaim,
): Promise<ClaimResult> {
  const claimFrom = options.claimFrom ?? null;
  if (claimFrom === null) return claimServed(tracker, key, options);
  const start = await tracker.getIssue(key);
  if (start === null)
    return {
      outcome: "refused",
      issue: key,
      why: "state",
      reason: `${key} could not be read, so its state is not known to be in claim_from`,
    };
  return (
    claimFromRefusal(tracker, key, start.state.name, claimFrom, start) ??
    claimServed(tracker, key, options)
  );
}

/**
 * The state is checked again before an inherited assignment write, so a
 * refusal for it never follows a write; an unreadable item is not known to be
 * in `claim_from`.
 */
async function stateBeforeAssignment(
  tracker: Tracker,
  key: string,
  options: ServedClaim,
): Promise<ClaimResult | null> {
  if (
    tracker.adapter !== "jira" &&
    !options.claimFrom &&
    tracker.stateName("blocked") === null
  )
    return null;
  const current = await tracker.getIssue(key);
  if (current === null && !options.claimFrom) return null;
  if (current === null)
    return {
      outcome: "refused",
      issue: key,
      why: "state",
      reason: `${key} could not be read, so its state is not known to be in claim_from`,
    };
  if (tracker.stateName("in_progress", current) === null)
    return {
      outcome: "refused",
      issue: key,
      why: "state",
      reason: `${key} has no in_progress state in its workflow`,
    };
  return (
    blockedStateRefusal(tracker, key, current.state.name, current) ??
    (options.claimFrom
      ? claimFromRefusal(
          tracker,
          key,
          current.state.name,
          options.claimFrom,
          current,
        )
      : null)
  );
}

/**
 * The state the start write begins from is the one just read, not the first
 * read's. A direct claim has written nothing yet, so it keeps the state
 * refusal; an inherited one may already have written the assignment, so it
 * stands down.
 */
function startStateRefusal(
  tracker: Tracker,
  key: string,
  issue: Issue,
  options: ServedClaim,
): ClaimResult | null {
  const blocked = blockedStateRefusal(tracker, key, issue.state.name, issue);
  if (blocked && (options.ancestor || options.blocking))
    return {
      outcome: "stood_down",
      issue: key,
      reason: `${key} changed before it could be started: it is now blocked; queue must refresh`,
    };
  if (blocked) return blocked;
  const outside = options.claimFrom
    ? claimFromRefusal(tracker, key, issue.state.name, options.claimFrom, issue)
    : null;
  if (!outside || !(options.ancestor || options.blocking)) return outside;
  return {
    outcome: "stood_down",
    issue: key,
    reason: `${key} changed before it could be started: ${
      outside.outcome === "refused"
        ? outside.reason
        : "its state left claim_from"
    }; queue must refresh`,
  };
}

/** What the claim re-reads after the start write: any change stands it down. */
async function startedStandDown(
  tracker: Tracker,
  key: string,
  user: TrackerUser,
  options: ServedClaim,
): Promise<ClaimResult | null> {
  const after = await tracker.poolIssue(key);
  if (
    !after ||
    after.truncated.length > 0 ||
    hold(after.labels, options) ||
    after.state.name.toLowerCase() !==
      tracker
        .stateName("in_progress", after.nativeType ?? null)
        ?.toLowerCase() ||
    !only(await tracker.assignees(key), user)
  )
    return {
      outcome: "stood_down",
      issue: key,
      reason: `${key} changed during the claim; queue must refresh`,
    };
  const problem = await validateClaim(tracker, key, user, options, true);
  if (!problem) return null;
  return {
    outcome: "stood_down",
    issue: key,
    reason: `${key} changed during the claim: ${problem}; queue must refresh`,
  };
}

/** A read of the item's own state: `blocked` is never a claim state, before or after an assignment. */
async function blockedNow(
  tracker: Tracker,
  key: string,
): Promise<ClaimResult | null> {
  if (tracker.adapter !== "jira" && tracker.stateName("blocked") === null)
    return null;
  const current = await tracker.getIssue(key);
  return current
    ? blockedStateRefusal(tracker, key, current.state.name, current)
    : null;
}

const refusedAssigned = (key: string, reason: string): ClaimResult => ({
  outcome: "refused",
  issue: key,
  why: "assigned",
  reason,
});

/**
 * An inherited pickup (an ancestor's or a blocker's) assigns the unassigned
 * item first. Returns the refusal or stand-down that ends the claim, null when
 * the item is assigned or the claim is direct.
 */
async function assignInherited(
  tracker: Tracker,
  key: string,
  user: TrackerUser,
  options: ServedClaim,
): Promise<ClaimResult | null> {
  const refused = (reason: string) => refusedAssigned(key, reason);
  const assignUnassigned = tracker.assignUnassigned;
  const inherits = Boolean(options.ancestor || options.blocking);
  if (inherits && !assignUnassigned)
    return refused(
      "this tracker cannot safely assign an inherited pickup without replacing a concurrent assignee",
    );
  // Re-read the entire authorization immediately before changing the child.
  const blocked = await blockedNow(tracker, key);
  if (blocked) return blocked;
  const problem = await validateClaim(tracker, key, user, options);
  if (problem) return refused(problem);
  if (!inherits || !assignUnassigned) return null;
  const outsideNow = await stateBeforeAssignment(tracker, key, options);
  if (outsideNow) return outsideNow;
  if (await assignUnassigned(key, user)) return null;
  return {
    outcome: "stood_down",
    issue: key,
    reason: `${key}: assignment raced the claim; queue must refresh`,
  };
}

/** No cached queue fact authorizes this write. Missing ancestry or provenance refuses it. */
async function claimServed(
  tracker: Tracker,
  key: string,
  options: ServedClaim,
): Promise<ClaimResult> {
  const user = await tracker.user(options.person);
  const blocked = await blockedNow(tracker, key);
  if (blocked) return blocked;
  const problem = await validateClaim(tracker, key, user, options);
  if (problem) return refusedAssigned(key, problem);
  const assigned = await assignInherited(tracker, key, user, options);
  if (assigned) return assigned;
  const before = await tracker.getIssue(key);
  // Before the waiting guard, so a readable state outside claim_from is a
  // refusal for a direct claim whatever its type.
  const outside = before
    ? startStateRefusal(tracker, key, before, options)
    : null;
  if (outside) return outside;
  if (
    !before ||
    !waiting(before.state.type) ||
    hold(before.labels, options) ||
    !only(await tracker.assignees(key), user)
  )
    return {
      outcome: "stood_down",
      issue: key,
      reason: `${key} changed before it could be started; queue must refresh`,
    };
  const target = tracker.stateName("in_progress", before);
  if (target === null) return absentStartState(key, options);
  await tracker.transition(key, "in_progress");
  const standDown = await startedStandDown(tracker, key, user, options);
  if (standDown) return standDown;
  return {
    outcome: "claimed",
    issue: key,
    claimant: user,
    state: target,
  };
}

/** An unavailable target is a stand-down after an inherited assignment. */
function absentStartState(key: string, options: ServedClaim): ClaimResult {
  return options.ancestor || options.blocking
    ? {
        outcome: "stood_down",
        issue: key,
        reason: `${key} no longer has an in_progress state in its workflow after its assignment; queue must refresh`,
      }
    : {
        outcome: "refused",
        issue: key,
        why: "state",
        reason: `${key} has no in_progress state in its workflow`,
      };
}
