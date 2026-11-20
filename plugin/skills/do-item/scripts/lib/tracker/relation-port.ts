/** The native closure fact used by a pickup dependency. */
export type DependencyState = "open" | "closed";

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
