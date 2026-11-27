/**
 * The sentences a tick refuses a repository's configuration with: its
 * `dispatch` section, its tracker (the issue facets with it) and its
 * change-area catalog. The tick and `jig dispatch check` both write them
 * from here, so a repository's CI fails with the message the host's tick
 * would print.
 */

/** The configuration file the tick reads, relative to the repository's root. */
export const CONFIGURATION_FILE = ".config/jig.yaml";

/** The repository's dispatch section does not read: the tick plans nothing for it. */
export function sectionRefusal(why: string): string {
  return `the dispatch section on the default branch cannot be read, so nothing is planned: ${why}`;
}

/** The tracker the configuration names cannot be opened, its facets included. */
export function trackerRefusal(why: string): string {
  return `the issue service cannot be opened: ${why}`;
}

/** The change-area catalog does not read: no re-arm starts where it decides. */
export function catalogRefusal(why: string): string {
  return `the change-area catalog cannot be read, so no re-arm starts on a pull request whose serialized areas cannot be told: ${why}`;
}

/** `drive.change_areas_catalog` names a file the default branch does not hold. */
export function catalogMissing(path: string): string {
  return `drive.change_areas_catalog names ${path}, which the default branch does not have`;
}
