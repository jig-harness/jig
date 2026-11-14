/**
 * The read position the comment-only sweep keeps between runs
 * (design/tracker-facets.md, "The weekly sweep"): the cursor of the last
 * issue a run handled, which the next run resumes after, or `null` to start
 * from the oldest issue. A scheduled runner keeps the file between runs (on
 * Jig's own workflow, the Actions cache).
 *
 * The file only saves work: a missing one starts from the oldest issue, and
 * so does one that cannot be read, with a warning, since starting again
 * reaches every issue a little later rather than not at all. It is written
 * beside itself and renamed into place, so a run cut short leaves the last
 * whole position.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "../../../../shared/guards.ts";

export const POSITION_KIND = "issue-fields-position";
export const POSITION_VERSION = 1;

/** The position in `path`, and a warning when the file is there but unusable. */
export function readPosition(path: string): {
  after: string | null;
  warning: string | null;
} {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { after: null, warning: null };
    return {
      after: null,
      warning: `the read position ${path} cannot be read (${(err as Error).message}); starting from the oldest issue`,
    };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (
      isRecord(value) &&
      value.kind === POSITION_KIND &&
      value.version === POSITION_VERSION &&
      (value.after === null || typeof value.after === "string")
    )
      return { after: value.after, warning: null };
  } catch {
    // Read below as a file of another shape.
  }
  return {
    after: null,
    warning: `the read position ${path} is not an ${POSITION_KIND} record of version ${POSITION_VERSION}; starting from the oldest issue`,
  };
}

/** Save the cursor the next run resumes after, renamed into place. */
export function writePosition(path: string, after: string | null): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.${process.pid}.next`;
  writeFileSync(
    next,
    `${JSON.stringify({ kind: POSITION_KIND, version: POSITION_VERSION, after })}\n`,
  );
  renameSync(next, path);
}
