/**
 * The size of a change as the pull-request budget counts it
 * (`pull_requests.size_budget`): the changed lines of `git diff --numstat`,
 * leaving out the files the budget does not count.
 */

/**
 * Files whose changed lines the size budget does not count, and why: the
 * audit record (`/jig:audit`) is rewritten whole by every audit, so counting
 * it would put any pull request that commits it over a budget its own change
 * fits.
 */
export const UNCOUNTED: ReadonlyMap<string, string> = new Map([
  [".config/jig-audit.yaml", "the audit record, rewritten by every audit"],
]);

/** A file left out of the size, with its changed lines and why. */
export interface Uncounted {
  path: string;
  lines: number;
  why: string;
}

/**
 * Changed lines (added plus deleted, binary files ignored) of `git diff
 * --numstat`, and the files in `UNCOUNTED` left out of that total.
 */
export function measureChange(numstat: string): {
  changedLines: number;
  uncounted: Uncounted[];
} {
  let changedLines = 0;
  const uncounted: Uncounted[] = [];
  for (const line of numstat.split("\n")) {
    const [added, deleted, path] = line.split("\t");
    if (added === undefined || deleted === undefined) continue;
    const lines =
      (/^\d+$/.test(added) ? Number(added) : 0) +
      (/^\d+$/.test(deleted) ? Number(deleted) : 0);
    const why = path === undefined ? undefined : UNCOUNTED.get(path);
    if (path !== undefined && why !== undefined)
      uncounted.push({ path, lines, why });
    else changedLines += lines;
  }
  return { changedLines, uncounted };
}

/** Changed lines between `baseRef` and HEAD, as `measureChange` counts them. */
export function countChangedLines(numstat: string): number {
  return measureChange(numstat).changedLines;
}

/** What the size leaves out, as a clause after it: `, not counting <path> (<n> lines, <why>)`. */
export function uncountedNote(uncounted: readonly Uncounted[]): string {
  if (uncounted.length === 0) return "";
  return `, not counting ${uncounted.map((u) => `${u.path} (${u.lines} lines, ${u.why})`).join(", ")}`;
}
