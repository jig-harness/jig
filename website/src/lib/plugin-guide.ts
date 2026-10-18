/**
 * The plugin README renders on the getting-started and plugin pages: the sections that take a reader
 * from nothing installed to a first audit on getting started (`/adopt/`), the
 * rest on the plugin page (`/adopt/plugin/`).
 */
/** The README's sections that getting started renders, by title, in its order. */
export const START_SECTIONS = [
  "Set up from an agent session",
  "Requirements",
  "Install the plugin",
  "Use a skill",
  "Configure a repository",
] as const;

/** Their anchors, which a link into the README follows to getting started. */
export const START_ANCHORS: ReadonlySet<string> = new Set(
  START_SECTIONS.map((t) => t.toLowerCase().replaceAll(" ", "-")),
);
