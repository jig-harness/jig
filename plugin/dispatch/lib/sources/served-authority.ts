/** Whether an item's assignment still rests on a repository writer, checked again just before it starts. */
import { isEpicPickup } from "../../../shared/epic-pickup.ts";
import { blocksWithin } from "../../../skills/do-item/scripts/lib/blocker-chain.ts";
import type {
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { queueHold, type QueueHoldPolicy } from "../queue-rank.ts";
import { ready, whyNotPulled } from "./served-pull.ts";
import type { RepoScope } from "./served-repo.ts";

export async function freshAuthority(
  tracker: Tracker,
  issue: PoolIssue,
  identity: string,
  ancestor?: string,
): Promise<string | null> {
  return ancestor === undefined
    ? directAuthority(tracker, issue, identity)
    : inheritedAuthority(tracker, issue, identity, ancestor);
}

async function directAuthority(
  tracker: Tracker,
  issue: PoolIssue,
  identity: string,
): Promise<string | null> {
  const user = await tracker.user(identity);
  if (issue.assignee?.id !== user.id) return "the served assignment changed";
  if (!(await tracker.assignedBy(issue.identifier, identity)).trusted)
    return "the assigner cannot write";
  return null;
}

async function inheritedAuthority(
  tracker: Tracker,
  issue: PoolIssue,
  identity: string,
  ancestor: string,
): Promise<string | null> {
  if (issue.assignee !== null)
    return "the inherited item has acquired an assignee";
  const user = await tracker.user(identity);
  const seen = new Set<string>();
  let current: PoolIssue | null = issue;
  for (;;) {
    if (current === null || current.truncated.length)
      return "the inherited ancestry cannot be read completely";
    if (seen.has(current.identifier) || seen.size >= 100)
      return "the inherited ancestry is cyclic or too deep";
    seen.add(current.identifier);
    if (current.identifier === ancestor)
      return ancestorChanged(tracker, current, user.id, identity);
    if (current.assignee !== null)
      return "the inherited ancestry assignment changed";
    const full = await tracker.getIssue(current.identifier);
    if (full === null || full.parent === null)
      return "the inherited ancestor is no longer live";
    current = await tracker.poolIssue(full.parent.identifier);
  }
}

async function ancestorChanged(
  tracker: Tracker,
  ancestor: PoolIssue,
  userId: string,
  identity: string,
): Promise<string | null> {
  if (
    ancestor.assignee?.id !== userId ||
    !(await tracker.assignedBy(ancestor.identifier, identity)).trusted
  )
    return "the inherited assignment changed";
  return null;
}

/** A pulled blocker is unassigned; the served item it blocks must still hold the person's authority and wait on it. */
export async function freshPulledAuthority(
  tracker: Tracker,
  issue: PoolIssue,
  identity: string,
  blockingFor: string,
  ancestor: string | undefined,
  policy: QueueHoldPolicy & { repoScope?: RepoScope },
  parentHold: (item: PoolIssue) => Promise<string | null>,
): Promise<string | null> {
  if (issue.assignee !== null)
    return "the pulled blocker has acquired an assignee";
  if (isEpicPickup(issue)) return "the pulled blocker has become an epic";
  const origin = await tracker.poolIssue(blockingFor);
  if (
    origin === null ||
    !ready(origin, tracker.stateName("blocked", origin.nativeType ?? null))
  )
    return `${blockingFor}, which it blocks, is no longer open and not started`;
  if (queueHold({ issue: origin, blockers: [], unblocks: 0 }, policy) !== null)
    return `${blockingFor}, which it blocks, needs a person to start`;
  const originHold = await parentHold(origin);
  if (originHold !== null) return `${blockingFor}: ${originHold}`;
  const authority = await freshAuthority(tracker, origin, identity, ancestor);
  if (authority !== null) return `${blockingFor}: ${authority}`;
  const through = async (via: string): Promise<boolean> => {
    const item = await tracker.poolIssue(via);
    return (
      whyNotPulled(item, {
        hitl: policy.hitl,
        manualOps: policy.manualOps,
        repoScope: policy.repoScope,
        blockedState: (item) =>
          tracker.stateName("blocked", item.nativeType ?? null),
      }) === null && (await parentHold(item as PoolIssue)) === null
    );
  };
  return (await blocksWithin(tracker, blockingFor, issue.identifier, through))
    ? null
    : `it no longer blocks ${blockingFor}`;
}
