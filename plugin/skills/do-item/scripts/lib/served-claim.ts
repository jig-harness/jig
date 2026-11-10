/** Served pickups preserve the person's assignment and revalidate inherited authority live. */
import type { ClaimResult } from "./claim.ts";
import type { Issue, Tracker, TrackerUser } from "./tracker/port.ts";

export interface ServedClaim {
  person: string;
  ancestor?: string;
  epicLabel?: string;
  hitlLabel?: string;
  manualOpsLabel?: string;
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

/** No cached queue fact authorizes this write. Missing ancestry or provenance refuses it. */
export async function claimServedIssue(
  tracker: Tracker,
  key: string,
  options: ServedClaim,
): Promise<ClaimResult> {
  const user = await tracker.user(options.person);
  const refused = (reason: string): ClaimResult => ({
    outcome: "refused",
    issue: key,
    why: "assigned",
    reason,
  });
  let problem = await validateAssignment(tracker, key, user, options);
  if (problem) return refused(problem);
  const assignUnassigned = tracker.assignUnassigned;
  if (options.ancestor && !assignUnassigned)
    return refused(
      "this tracker cannot safely assign an inherited pickup without replacing a concurrent assignee",
    );
  // Re-read the entire authorization immediately before changing the child.
  problem = await validateAssignment(tracker, key, user, options);
  if (problem) return refused(problem);
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
  problem = await validateAssignment(tracker, key, user, options, true);
  if (problem)
    return {
      outcome: "stood_down",
      issue: key,
      reason: `${key} changed during the claim: ${problem}; queue must refresh`,
    };
  return {
    outcome: "claimed",
    issue: key,
    claimant: user,
    state: tracker.stateName("in_progress"),
  };
}
