/**
 * Where an earlier factory address lands now.
 *
 * Links into the factory exist outside this site (bookmarks, other
 * documents), so every anchor a factory page had and no longer renders, and
 * every page that was renamed, forwards to the page and anchor that hold the
 * same part now. The sets are closed: they are the anchors and pages the
 * earlier layouts had, which no longer change.
 */

/** A factory page by its path under `/factory/` (`""` is the overview), and an anchor on it. */
export interface Forward {
  page: string;
  anchor: string;
}

/**
 * The overview's anchors that moved, by the factory page that renders each
 * now: the single page's sections that became pages of their own, and the
 * anchors the line's renaming moved.
 */
const MOVED: Readonly<Record<string, readonly string[]>> = {
  scaffolding: [
    "scaffolding",
    "scaffolding-many",
    "provides",
    "fitted",
    "trk-cap",
  ],
  design: ["design"],
  "learning-loop": ["flywheel"],
};

/** Moved anchors that also changed their name: the old id, and where it lands. */
const RENAMED: Readonly<Record<string, Forward>> = {
  execution: { page: "line", anchor: "line" },
  "execution-level": { page: "", anchor: "line-level" },
};

/** A scaffolding job's row anchor, `job-<id>`, which moved with the scaffolding section. */
const MOVED_JOB_PAGE = "scaffolding";

/**
 * Every moved anchor of the overview and where it is now. `jobIds` are the
 * scaffolding jobs, whose rows carry `job-<id>`. Built without a prototype,
 * so a fragment such as `#constructor` names nothing.
 */
export function movedFactoryAnchors(
  jobIds: readonly string[],
): Record<string, Forward> {
  const moved: Record<string, Forward> = Object.create(null);
  for (const [page, ids] of Object.entries(MOVED)) {
    for (const id of ids) moved[id] = { page, anchor: id };
  }
  for (const id of jobIds)
    moved[`job-${id}`] = { page: MOVED_JOB_PAGE, anchor: `job-${id}` };
  for (const [id, to] of Object.entries(RENAMED)) moved[id] = to;
  return moved;
}

/**
 * Factory pages that were renamed: the old page, the page it is now, and the
 * old page's anchors that the new page renders under another name. Every
 * other anchor of the old page keeps its name on the new one.
 */
export const RENAMED_PAGES: Readonly<
  Record<string, { to: string; anchors: Readonly<Record<string, string>> }>
> = {
  execution: { to: "line", anchors: { execution: "line" } },
};

/** The address a forward goes to: `/factory/line/#line`. */
export function forwardHref(to: Forward): string {
  const page = to.page ? `${to.page}/` : "";
  return `/factory/${page}#${encodeURIComponent(to.anchor)}`;
}
