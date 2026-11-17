/**
 * The tracker port's issue forms as the ranker's snapshot items
 * (`shared/priorities/snapshot.ts`). Every adapter (GitHub, Linear, Jira)
 * hands the dispatcher the same normalized `PoolIssue`, and the served walk's
 * `QueueIssue` adds relations and parent, so one normalizer serves all three.
 * A facet the read did not carry is a gap: a missing priority is `null`,
 * never Low; relations the read could not take are a blockers gap.
 */
import type {
  PoolIssue,
  QueueIssue,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import type {
  SnapshotFacet,
  SnapshotItem,
} from "../../shared/priorities/snapshot.ts";

/** Closed state categories a blocker no longer blocks in. */
const DONE = new Set([
  "done",
  "closed",
  "completed",
  "canceled",
  "cancelled",
  "duplicate",
]);

/**
 * One snapshot item from the port's pool form, with the served walk's
 * relations and parent where the read carried them (`QueueIssue`). The
 * facets the port does not carry (due date, project, cycle) are gaps.
 */
export function snapshotItem(
  issue: PoolIssue | QueueIssue,
  options: {
    scope: string;
    /** The canonical state name for `ready`; the issue's canonical state is matched to it. */
    readyState?: string;
    assigned?: boolean | null;
    excluded?: string | null;
    children?: string[] | null;
  },
): SnapshotItem {
  const gaps: SnapshotFacet[] = [];
  const priority =
    issue.priority >= 1 && issue.priority <= 4
      ? (issue.priority as 1 | 2 | 3 | 4)
      : null;
  if (priority === null) gaps.push("priority");
  if (issue.type === null) gaps.push("type");
  const relations = "relations" in issue ? issue.relations : undefined;
  let blockers: string[] = [];
  if (relations === undefined || relations === null) gaps.push("blockers");
  else
    blockers = relations
      .filter(
        (r) =>
          r.type === "blocked_by" &&
          (r.state === null || !DONE.has(r.state.toLowerCase())),
      )
      .map((r) => r.issue)
      .sort();
  let parent: string | null = null;
  if ("parent" in issue) parent = issue.parent?.issue.identifier ?? null;
  else gaps.push("parent");
  const children = options.children ?? [];
  if (options.children === undefined || options.children === null)
    if (issue.isEpic || issue.hasOpenChildren) gaps.push("children");
  const assigned =
    options.assigned !== undefined ? options.assigned : issue.assignee !== null;
  if (assigned === null) gaps.push("assignee");
  const stateName = issue.state.name;
  const ready =
    options.readyState === undefined
      ? stateName
      : stateName.toLowerCase() === options.readyState.toLowerCase()
        ? "ready"
        : stateName;
  gaps.push("dueDate", "project", "cycle");
  return {
    scope: options.scope,
    key: issue.identifier,
    title: issue.title,
    priority,
    type: issue.type === null ? null : issue.type.toLowerCase(),
    state: ready,
    isEpic: issue.isEpic,
    parent,
    children,
    blockers,
    assigned,
    labels: [...issue.labels].sort(),
    dueDate: null,
    project: null,
    cycle: null,
    excluded: options.excluded ?? null,
    gaps,
  };
}

/**
 * The issue's parent as a snapshot node, carried for its rank and its own
 * parent's key and never as a start: where the read carried the parent, the
 * ancestor chain reaches past an in-progress intermediate parent to the
 * declared epic. `null` where the read carried no parent.
 */
export function ancestorItem(
  issue: PoolIssue | QueueIssue,
  scope: string,
): SnapshotItem | null {
  if (!("parent" in issue) || issue.parent === null) return null;
  const node = snapshotItem(issue.parent.issue, { scope });
  return {
    ...node,
    parent: issue.parent.parent,
    gaps: node.gaps.filter((g) => g !== "parent"),
    state: "ancestor",
    excluded: "an ancestor carried for its rank, not a start",
  };
}
