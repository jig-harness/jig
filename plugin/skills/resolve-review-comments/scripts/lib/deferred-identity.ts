import { JigError } from "../../../../shared/outcome.ts";

/** Stable, non-linkified heading key for one finding in a sticky comment. */
export function summaryEntryKey(
  commentUrl: string,
  fingerprint: string,
): string {
  const match = /#issuecomment-([0-9]+)$/.exec(commentUrl);
  if (match === null) {
    throw new JigError(
      "deferral",
      `cannot derive a summary entry key from '${commentUrl}'`,
    );
  }
  return `ai-review-backlog:issuecomment-${match[1]}:${fingerprint}`;
}

/**
 * Append `entry` to `description`, idempotently keyed on the entry's HEADING
 * LINE: a re-run after a crash mid-round must not duplicate the entry.
 *
 * The key is a whole trimmed line equal to `### <url>`, not a substring search
 * for the URL. A substring is not evidence the thread has an entry, in two
 * measured ways: one thread URL is a PREFIX of another (`…#discussion_r1` sits
 * inside `…#discussion_r10`), and a URL quoted inside a neighbouring finding's
 * text matches too. Either reports `alreadyPresent` for a finding that was
 * never recorded, and the caller then resolves the review thread with nothing
 * tracking it.
 */
/**
 * The exact idempotency key an entry heading names, or null if the line is not one.
 *
 * MEASURED: Linear rewrites a bare
 * URL into a markdown link when it stores a description, so the heading this
 * script WRITES is not the heading it reads back —
 * `### https://…#discussion_r1` returns as
 * `### [https://…#discussion_r1](<https://…#discussion_r1>)`. An exact
 * line-equality key therefore never matched after a round trip: every append
 * failed its own post-write verification, the retry loop re-appended, and the
 * issue ended up with the same entry three times before the run aborted.
 *
 * Parsing the URL out and comparing it EXACTLY keeps the property the
 * line-equality key was chosen for — a thread URL that merely prefixes another
 * (`…_r1` inside `…_r10`) still does not match, and a URL quoted inside a
 * neighbouring finding is not on a `###` line at all.
 */
export function headingEntryKey(line: string): string | null {
  // 0-3 leading spaces, per CommonMark: that is the range which still parses
  // as a heading. FOUR or more makes it an indented CODE BLOCK, so a Markdown
  // example inside a description would otherwise be read as a real entry and
  // make the helper skip the append — resolving the thread with nothing
  // tracking it (a legal-but-unexpected indentation must never read as a
  // real entry). A bare `trim()` erased that distinction.
  const heading = /^ {0,3}### (.*)$/.exec(line.trimEnd());
  if (heading === null) return null;
  const rest = (heading[1] ?? "").trim();
  const link = /^\[([^\]]*)\]\(<?([^)>]*)>?\)$/.exec(rest);
  return link ? link[2] || link[1] || "" : rest;
}

/**
 * The entry headings a description actually contains, skipping anything inside
 * a FENCED code block.
 *
 * CommonMark renders a `### …` line inside ``` or ~~~ as code, not a heading,
 * so counting one as a real entry makes the append skip a finding that was
 * never recorded — the thread then resolves with nothing tracking it. Same
 * failure the indented-code-block bound closed; this is its sibling, and the
 * two together are what "a heading is a heading" actually means here.
 */
interface Fence {
  char: string;
  len: number;
}

/** Classify one Markdown line while retaining the current fenced block. */
function fenceLine(
  line: string,
  fence: Fence | null,
): { fence: Fence | null; consumed: boolean } {
  const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (marker === null) return { fence, consumed: fence !== null };
  const text = marker[1] ?? "";
  const char = text.charAt(0);
  const info = marker[2] ?? "";
  if (fence !== null) {
    const closes =
      char === fence.char && text.length >= fence.len && info.trim() === "";
    return { fence: closes ? null : fence, consumed: true };
  }
  if (char === "`" && info.includes("`"))
    return { fence: null, consumed: false };
  return { fence: { char, len: text.length }, consumed: true };
}

export function entryHeadings(description: string): string[] {
  const found: string[] = [];
  let fence: Fence | null = null;
  for (const line of description.split("\n")) {
    const state = fenceLine(line, fence);
    fence = state.fence;
    if (state.consumed) continue;
    const key = headingEntryKey(line);
    if (key !== null) found.push(key);
  }
  return found;
}

export function hasEntry(description: string, entryKey: string): boolean {
  return entryHeadings(description).includes(entryKey);
}
