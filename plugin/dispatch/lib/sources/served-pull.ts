/** Which open blockers of a served item are pulled forward, and why the others are not. */
import { PULL_DEPTH } from "../../../skills/do-item/scripts/lib/blocker-chain.ts";
import type {
  IssueRelation,
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { queueHold } from "../queue-rank.ts";
import { otherRepoLabel, type RepoScope } from "./served-repo.ts";

export const closed = (i: PoolIssue) =>
  ["completed", "canceled", "duplicate"].includes(i.state.type);
export const ready = (i: PoolIssue) =>
  !closed(i) && ["triage", "backlog", "unstarted"].includes(i.state.type);

export interface OpenBlocker {
  key: string;
  /** `null` when the blocker cannot be read: it still blocks, and is never pulled. */
  issue: PoolIssue | null;
}

/** A failed blocker read holds the item: absence of evidence never means unblocked. */
export async function openBlockers(
  tracker: Tracker,
  relations: IssueRelation[],
): Promise<OpenBlocker[]> {
  const open: OpenBlocker[] = [];
  for (const r of relations)
    if (r.type === "blocked_by") {
      const other = await tracker.poolIssue(r.issue);
      if (other === null || !closed(other))
        open.push({ key: r.issue, issue: other });
    }
  return open;
}

export interface PullPolicy {
  epic: string;
  hitl?: string | undefined;
  manualOps?: string | undefined;
  repoScope?: RepoScope | undefined;
}

/**
 * Why an open blocker is not worked on the strength of the item it blocks:
 * only an unassigned, open, unheld item of this repository, and no epic,
 * qualifies. `null` when it does. An assigned blocker is its assignee's to
 * start, so it is never taken from them.
 */
function whyNotPulled(
  blocker: PoolIssue | null,
  policy: PullPolicy,
): string | null {
  if (blocker === null) return "cannot be read";
  if (blocker.truncated.length > 0) return "its read is incomplete";
  if (blocker.assignee !== null) return `assigned to ${blocker.assignee.name}`;
  if (blocker.labels.includes(policy.epic))
    return "an epic; assign it to start it";
  if (!ready(blocker)) return `in ${blocker.state.name}`;
  if (otherRepoLabel(blocker.labels, policy.repoScope) !== null)
    return "another repository's";
  const held = queueHold({ issue: blocker, blockers: [], unblocks: 0 }, policy);
  return held === null ? null : "needs a person to start";
}

/** Where a pulled item's authority comes from: the served item that waits on it. */
export interface PullOrigin {
  /** The item carrying the assignment, direct or inherited. */
  root: string;
  /** The epic the root inherits its assignment through. */
  rootAncestor: string | undefined;
  /** Links between the root and this item. */
  depth: number;
}

/** What one blocked node pulls: the items to queue, and the reason the node reports. */
export function pullBlockers(
  blocked: PoolIssue,
  origin: PullOrigin | undefined,
  ancestor: string | undefined,
  open: readonly OpenBlocker[],
  policy: PullPolicy,
): { reason: string; pulled: PoolIssue[]; origin: PullOrigin } {
  const depth = origin?.depth ?? 0;
  const next: PullOrigin = {
    root: origin?.root ?? blocked.identifier,
    rootAncestor: origin === undefined ? ancestor : origin.rootAncestor,
    depth: depth + 1,
  };
  const pulled: PoolIssue[] = [];
  const parts = open.map((b) => {
    const why =
      depth >= PULL_DEPTH
        ? "too many links from the assigned item"
        : ready(blocked)
          ? whyNotPulled(b.issue, policy)
          : `${blocked.identifier} is not open`;
    if (why !== null || b.issue === null) return `${b.key} (${why})`;
    pulled.push(b.issue);
    return `${b.key} (picked up first)`;
  });
  return { reason: `waiting on ${parts.join(", ")}`, pulled, origin: next };
}
