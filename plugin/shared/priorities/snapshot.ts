/**
 * The tracker snapshot the ranker reads: each item's priority, type, state,
 * parent, children, blockers and assignee, normalized from what the tracker
 * port's adapters (GitHub, Linear, Jira) already read through their governed
 * transports (`dispatch/lib/priorities-snapshot.ts` normalizes the port's
 * issue forms). A facet the read did not carry is a gap, named in `gaps`, never
 * a low priority: `priority` is `null` for an unknown priority, and the ranker
 * shows the gap.
 */
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
