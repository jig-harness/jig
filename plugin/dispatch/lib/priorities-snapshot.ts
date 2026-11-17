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
  const priority = priorityOf(issue.priority);
  if (priority === null) gaps.push("priority");
  if (issue.type === null) gaps.push("type");
  const blockers = openBlockers(
    "relations" in issue ? issue.relations : undefined,
  );
  if (blockers === null) gaps.push("blockers");
  const parent =
    "parent" in issue ? (issue.parent?.issue.identifier ?? null) : undefined;
  if (parent === undefined) gaps.push("parent");
  if (lacksChildren(issue, options.children)) gaps.push("children");
  const assigned = assignedOf(issue, options.assigned);
  if (assigned === null) gaps.push("assignee");
  const ready = stateOf(issue.state.name, options.readyState);
  gaps.push("dueDate", "project", "cycle");
  return {
    scope: options.scope,
    key: issue.identifier,
    title: issue.title,
    priority,
    type: issue.type === null ? null : issue.type.toLowerCase(),
    state: ready,
    isEpic: issue.isEpic,
    parent: parent ?? null,
    children: options.children ?? [],
    blockers: blockers ?? [],
    assigned,
    labels: [...issue.labels].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    dueDate: null,
    project: null,
    cycle: null,
    excluded: options.excluded ?? null,
    gaps,
  };
}

function priorityOf(n: number): 1 | 2 | 3 | 4 | null {
  return n >= 1 && n <= 4 ? (n as 1 | 2 | 3 | 4) : null;
}

/** Whether an epic or parent's children are unread: the walk carried none and the issue has some. */
function lacksChildren(
  issue: PoolIssue | QueueIssue,
  children: string[] | null | undefined,
): boolean {
  if (children !== undefined && children !== null) return false;
  return issue.isEpic || issue.hasOpenChildren;
}

/** The caller's answer where it gave one, else whether the issue has an assignee. */
function assignedOf(
  issue: PoolIssue | QueueIssue,
  given: boolean | null | undefined,
): boolean | null {
  return given !== undefined ? given : issue.assignee !== null;
}

/** The keys of the open issues blocking this one, sorted; `null` where the read carried no relations. */
function openBlockers(
  relations:
    | ReadonlyArray<{
        type: string;
        issue: string;
        state: string | null;
      }>
    | null
    | undefined,
): string[] | null {
  if (relations === undefined || relations === null) return null;
  return relations
    .filter(
      (r) =>
        r.type === "blocked_by" &&
        (r.state === null || !DONE.has(r.state.toLowerCase())),
    )
    .map((r) => r.issue)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The state name, or `ready` where it matches the configured ready state. */
function stateOf(name: string, readyState: string | undefined): string {
  if (readyState === undefined) return name;
  return name.toLowerCase() === readyState.toLowerCase() ? "ready" : name;
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
