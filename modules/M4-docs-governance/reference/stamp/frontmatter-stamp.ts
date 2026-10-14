// Sticky UTC stamping of `last_updated:` for generators that write documents
// into a governed docs tree.
//
// A generated document is still a document: the stale-last_updated gate holds
// it to the same rule as a hand-written one. So a generator that rewrites the
// body must advance the date, or the gate fails on the next pull request that
// happens to regenerate it, not on the change that caused it. Advancing the
// date on every run is the opposite failure: a rerun with nothing new rewrites
// the file with only its date changed, and a freshness check (`--check`) fails
// whenever a day boundary passes between generation and check. The contract:
//
//   - advance the date only when the body (or any other frontmatter) changed;
//     otherwise keep the date the file already carries;
//   - use the UTC date, the one the gate compares against, so a local evening
//     stamp is not a day ahead of or behind CI.
//
// Only the `last_updated:` line is set aside when comparing, never the whole
// frontmatter, so a hand edit to a generated file's other fields still shows
// as drift and is overwritten by the next generation.
//
// The date is read through the shared reader, and stamping is checked in
// absolute terms, never relative to the input: frontmatter that is present
// must close and read with no error before anything else is decided, whether
// or not a `last_updated:` line is found in it, and the stamp must read back
// as exactly the new date with no error after it. A `last_updated:` whose value does not sit whole on its key
// line (a block scalar, a continued plain scalar) cannot be stamped by
// replacing that line, so it is refused rather than written half-replaced.

import { linesWithBreaks, readFrontmatter } from "../docs";

const LAST_UPDATED = /^last_updated[ \t]*:.*$/m;

/** Today's date in UTC, `YYYY-MM-DD`. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The leading frontmatter block (with its delimiters) and the rest, or
 * undefined. The block is the one the shared reader finds, at any of YAML's
 * line breaks, so the stale gate and this helper agree on every document.
 */
function split(content: string): [string, string] | undefined {
  const { present, end } = readFrontmatter(content);
  if (!present || end < 0) return undefined;
  const length = linesWithBreaks(content)
    .slice(0, end + 1)
    .join("").length;
  return [content.slice(0, length), content.slice(length)];
}

/** The `last_updated:` value in the leading frontmatter, as the shared reader reads it, or null. */
export function extractLastUpdated(content: string): string | null {
  if (!split(content)) return null;
  const value = readFrontmatter(content).fields.get("last_updated");
  return typeof value === "string" ? value : null;
}

/**
 * Set `last_updated:` inside the leading frontmatter only; the body is never
 * touched. Content without frontmatter is returned unchanged. Throws when
 * frontmatter is present but never closes or the shared reader reports an
 * error in it, with or without a `last_updated:` line, or when the result does
 * not read as exactly `date` with no error: the value continued past its key
 * line.
 */
export function stampLastUpdated(content: string, date: string): string {
  const frontmatter = readFrontmatter(content);
  if (!frontmatter.present) return content;
  const [unreadable] =
    frontmatter.end < 0 ? ["the frontmatter never closes"] : frontmatter.errors;
  if (unreadable !== undefined)
    throw new Error(
      `cannot stamp last_updated: the frontmatter does not read cleanly (${unreadable})`,
    );
  const parts = split(content);
  if (!parts || !LAST_UPDATED.test(parts[0])) return content;
  const stamped =
    parts[0].replace(LAST_UPDATED, `last_updated: ${date}`) + parts[1];
  const after = readFrontmatter(stamped);
  if (after.fields.get("last_updated") !== date || after.errors.length > 0)
    throw new Error(
      "cannot stamp last_updated: its value continues past the key line; write it as a one-line date",
    );
  return stamped;
}

/** The content with its frontmatter `last_updated:` value set aside, for comparison. */
export function normalizeLastUpdated(content: string): string {
  return stampLastUpdated(content, "<normalized>");
}

/**
 * The date a freshly rendered document should carry, given the file already on
 * disk (null when there is none): today when anything but the date changed,
 * the existing date otherwise.
 */
export function stickyDate(
  existing: string | null,
  fresh: string,
  today: string = utcToday(),
): string {
  if (existing === null) return today;
  if (normalizeLastUpdated(existing) !== normalizeLastUpdated(fresh))
    return today;
  return extractLastUpdated(existing) || today;
}
