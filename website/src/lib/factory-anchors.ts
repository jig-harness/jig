/**
 * Where an anchor of the single factory page lives now that its sections have
 * pages of their own.
 *
 * Links into `/factory/#…` exist outside this site (bookmarks, other
 * documents), so every anchor the single page had and the overview no longer
 * renders forwards to the page that does. The set is closed: it is the single
 * page's anchors, which no longer change.
 */

/** The single page's anchors that moved, by the factory page that renders each now. */
const MOVED: Readonly<Record<string, readonly string[]>> = {
  scaffolding: [
    "scaffolding",
    "scaffolding-many",
    "provides",
    "fitted",
    "trk-cap",
  ],
  design: ["design"],
  execution: ["execution"],
  "learning-loop": ["flywheel"],
};

/** A scaffolding job's row anchor, `job-<id>`, which moved with the scaffolding section. */
const MOVED_JOB_PAGE = "scaffolding";

/**
 * Every moved anchor and the factory page it is on now. `jobIds` are the
 * scaffolding jobs, whose rows carry `job-<id>`. Built without a prototype,
 * so a fragment such as `#constructor` names nothing.
 */
export function movedFactoryAnchors(
  jobIds: readonly string[],
): Record<string, string> {
  const moved: Record<string, string> = Object.create(null);
  for (const [page, ids] of Object.entries(MOVED)) {
    for (const id of ids) moved[id] = page;
  }
  for (const id of jobIds) moved[`job-${id}`] = MOVED_JOB_PAGE;
  return moved;
}
