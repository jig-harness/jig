/**
 * The tracker snapshot the ranker reads: each item's priority, type, state,
 * parent, children, blockers and assignee, normalized from what the tracker
 * port's adapters (GitHub, Linear, Jira) already read through their governed
 * transports. A facet the read did not carry is a gap, named in `gaps`, never
 * a low priority: `priority` is `null` for an unknown priority, and the ranker
 * shows the gap.
 */
import type {
  PoolIssue,
  QueueIssue,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";

/** A facet the snapshot can be missing. */
export type SnapshotFacet =
  | "priority"
  | "type"
  | "state"
  | "parent"
  | "children"
  | "blockers"
  | "assignee"
  | "dueDate"
  | "project"
  | "cycle";

/** One tracker item as the ranker reads it. */
export interface SnapshotItem {
  /** The tracker scope the key belongs to (a repository, a Linear team, a Jira project). */
  scope: string;
  key: string;
  title: string;
  /** 1 (urgent) to 4 (low); `null` when the tracker holds none or the read did not carry it. */
  priority: 1 | 2 | 3 | 4 | null;
  /** The type facet (`bug`, `feature`, …); `null` for none. */
  type: string | null;
  /** The canonical state: `ready` work waits to start; any other state is not ready. */
  state: string | null;
  isEpic: boolean;
  parent: string | null;
  children: string[];
  /** Keys of open items that block this one. */
  blockers: string[];
  /** Whether it is assigned to the person the host serves; `null` when unknown. */
  assigned: boolean | null;
  labels: string[];
  dueDate?: string | null;
  project?: string | null;
  cycle?: string | null;
  /** Why the existing start guards, holds, blocker rules or claims keep it from a start; `null` when they do not. */
  excluded: string | null;
  gaps: SnapshotFacet[];
}

/** An immutable tracker snapshot. */
export interface TrackerSnapshot {
  /** When the reads were taken. */
  readAt: string;
  items: SnapshotItem[];
}

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
