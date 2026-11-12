/** Served pickups preserve the person's assignment and revalidate inherited authority live. */
import {
  type ClaimResult,
  blockedStateRefusal,
  claimFromRefusal,
} from "./claim.ts";
import type {
  CanonicalState,
  Issue,
  Tracker,
  TrackerUser,
} from "./tracker/port.ts";

export interface ServedClaim {
  person: string;
  ancestor?: string;
  epicLabel?: string;
  hitlLabel?: string;
  manualOpsLabel?: string;
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
    tracker.stateName("in_progress").toLowerCase()
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
  if (!child && !issue.labels.includes(options.epicLabel ?? "epic"))
    return { reason: `${current} is no longer an epic` };
  const blocked = await blockedReason(tracker, current);
  return blocked ? { reason: blocked } : { issue };
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
    claimFromRefusal(tracker, key, start.state.name, claimFrom) ??
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
  if (!options.claimFrom && tracker.stateName("blocked") === null) return null;
  const current = await tracker.getIssue(key);
  if (current === null && !options.claimFrom) return null;
  if (current === null)
    return {
      outcome: "refused",
      issue: key,
      why: "state",
      reason: `${key} could not be read, so its state is not known to be in claim_from`,
    };
  return (
    blockedStateRefusal(tracker, key, current.state.name) ??
    (options.claimFrom
      ? claimFromRefusal(tracker, key, current.state.name, options.claimFrom)
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
  state: string,
  options: ServedClaim,
): ClaimResult | null {
  const blocked = blockedStateRefusal(tracker, key, state);
  if (blocked && options.ancestor)
    return {
      outcome: "stood_down",
      issue: key,
      reason: `${key} changed before it could be started: ${blocked.reason}; queue must refresh`,
    };
  if (blocked) return blocked;
  const outside = options.claimFrom
    ? claimFromRefusal(tracker, key, state, options.claimFrom)
    : null;
  if (!outside || !options.ancestor) return outside;
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
      tracker.stateName("in_progress").toLowerCase() ||
    !only(await tracker.assignees(key), user)
  )
    return {
      outcome: "stood_down",
      issue: key,
      reason: `${key} changed during the claim; queue must refresh`,
    };
  const problem = await validateAssignment(tracker, key, user, options, true);
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
  if (tracker.stateName("blocked") === null) return null;
  const current = await tracker.getIssue(key);
  return current ? blockedStateRefusal(tracker, key, current.state.name) : null;
}

const refusedAssigned = (key: string, reason: string): ClaimResult => ({
  outcome: "refused",
  issue: key,
  why: "assigned",
  reason,
});

/** The pre-write read of the item's own state, then the whole authorization. */
async function validateBeforeWrite(
  tracker: Tracker,
  key: string,
  user: TrackerUser,
  options: ServedClaim,
): Promise<ClaimResult | null> {
  const blocked = await blockedNow(tracker, key);
  if (blocked) return blocked;
  const problem = await validateAssignment(tracker, key, user, options);
  return problem ? refusedAssigned(key, problem) : null;
}

/** No cached queue fact authorizes this write. Missing ancestry or provenance refuses it. */
async function claimServed(
  tracker: Tracker,
  key: string,
  options: ServedClaim,
): Promise<ClaimResult> {
  const user = await tracker.user(options.person);
  let stop = await validateBeforeWrite(tracker, key, user, options);
  if (stop) return stop;
  const assignUnassigned = tracker.assignUnassigned;
  if (options.ancestor && !assignUnassigned)
    return refusedAssigned(
      key,
      "this tracker cannot safely assign an inherited pickup without replacing a concurrent assignee",
    );
  // Re-read the entire authorization immediately before changing the child.
  stop = await validateBeforeWrite(tracker, key, user, options);
  if (stop) return stop;
  if (options.ancestor && assignUnassigned) {
    const outsideNow = await stateBeforeAssignment(tracker, key, options);
    if (outsideNow) return outsideNow;
  }
  if (
    options.ancestor &&
    assignUnassigned &&
    !(await assignUnassigned(key, user))
  )
    return {
      outcome: "stood_down",
      issue: key,
      reason: `${key}: assignment raced the claim; queue must refresh`,
    };
  const before = await tracker.getIssue(key);
  // Before the waiting guard, so a readable state outside claim_from is a
  // refusal for a direct claim whatever its type.
  const outside = before
    ? startStateRefusal(tracker, key, before.state.name, options)
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
  await tracker.transition(key, "in_progress");
  const standDown = await startedStandDown(tracker, key, user, options);
  if (standDown) return standDown;
  return {
    outcome: "claimed",
    issue: key,
    claimant: user,
    state: tracker.stateName("in_progress"),
  };
}
