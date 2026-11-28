/** The native closure fact used by a pickup dependency. */
export type DependencyState = "open" | "closed";

/** The relations an issue can be given to another. */
export const RELATION_TYPES = ["blocks", "related", "duplicate"] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

/**
 * One relation of an issue, seen from that issue: `blocks` it blocks
 * `issue`, `blocked_by` `issue` blocks it; `duplicate` it is a duplicate of
 * `issue`, `duplicated_by` `issue` is a duplicate of it; `related` links the
 * two in either direction.
 */
export interface IssueRelation {
  type: RelationType | "blocked_by" | "duplicated_by";
  /** The other issue's key. */
  issue: string;
}

/**
 * Whether an adapter can prove two issues share their reader audience, so
 * metadata read from one may be written into a persistent record on the other
 * without crossing a visibility boundary.
 */
export interface TrackerVisibility {
  /**
   * True only when every reader who can see `issue` can also see `other`.
   * Absent, or returning `false`, means shared visibility is unverified and
   * callers must persist only `other`'s key.
   */
  sharesVisibility?(issue: string, other: string): boolean;
}

/** What `migrateRelations` found and did; with `dryRun`, what it would do. */
export interface RelationMigration {
  dryRun: boolean;
  /** Issues whose comments were read. */
  scanned: number;
  /** Native links written, one per pair of issues. */
  links: Array<{ issue: string; related: string }>;
  /** Comments whose link is native and which are now marked superseded. */
  converted: Array<{ issue: string; related: string; comment: string }>;
  /** Comments whose link could not be written, and why; they are read as before and met again. */
  unresolved: Array<{ issue: string; related: string; why: string }>;
  /** Comments that could not be edited: their link is native, they still read as one. */
  unmarked: Array<{
    issue: string;
    related: string;
    comment: string;
    reason: string;
  }>;
}
