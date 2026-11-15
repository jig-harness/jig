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

/** Strip inline-code spans and escaped characters before looking for comments. */
function commentSyntax(line: string): string {
  let out = "";
  let ticks = 0;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] ?? "";
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "`") {
      let end = i;
      while (line[end] === "`") end += 1;
      const length = end - i;
      if (ticks === 0) ticks = length;
      else if (ticks === length) ticks = 0;
      i = end - 1;
      continue;
    }
    if (ticks === 0) out += char;
  }
  return out;
}

/** HTML comments are invisible Markdown content, never entry records. */
function commentLine(
  line: string,
  inComment: boolean,
): {
  inComment: boolean;
  consumed: boolean;
} {
  const syntax = commentSyntax(line);
  let cursor = 0;
  let open = inComment;
  while (cursor < syntax.length) {
    if (open) {
      const end = syntax.indexOf("-->", cursor);
      if (end < 0) return { inComment: true, consumed: true };
      cursor = end + 3;
      open = false;
      continue;
    }
    const start = syntax.indexOf("<!--", cursor);
    if (start < 0) break;
    const end = syntax.indexOf("-->", start + 4);
    if (end < 0) return { inComment: true, consumed: true };
    cursor = end + 3;
  }
  return { inComment: open, consumed: inComment || syntax.includes("<!--") };
}

function openingFence(line: string): { fence: Fence; info: string } | null {
  let start = 0;
  while (line[start] === " " && start < 4) start += 1;
  const char = line[start];
  if ((char !== "`" && char !== "~") || start === 4) return null;
  let end = start;
  while (line[end] === char) end += 1;
  const len = end - start;
  return len < 3 ? null : { fence: { char, len }, info: line.slice(end) };
}

/** Classify one Markdown line while retaining the current fenced block. */
function fenceLine(
  line: string,
  fence: Fence | null,
): { fence: Fence | null; consumed: boolean } {
  const marker = openingFence(line);
  if (marker === null) return { fence, consumed: fence !== null };
  if (fence !== null) {
    const closes =
      marker.fence.char === fence.char &&
      marker.fence.len >= fence.len &&
      marker.info.trim() === "";
    return { fence: closes ? null : fence, consumed: true };
  }
  if (marker.fence.char === "`" && marker.info.includes("`"))
    return { fence: null, consumed: false };
  return { fence: marker.fence, consumed: true };
}

export function entryHeadings(description: string): string[] {
  const found: string[] = [];
  let fence: Fence | null = null;
  let inComment = false;
  for (const line of description.split("\n")) {
    if (fence === null && inComment) {
      const comment = commentLine(line, inComment);
      inComment = comment.inComment;
      continue;
    }
    if (fence === null && indentedCodeLine(line)) continue;
    const state = fenceLine(line, fence);
    fence = state.fence;
    if (state.consumed) continue;
    const comment = commentLine(line, inComment);
    inComment = comment.inComment;
    if (comment.consumed) continue;
    const key = headingEntryKey(line);
    if (key !== null) found.push(key);
  }
  return found;
}

export function hasEntry(description: string, entryKey: string): boolean {
  return entryHeadings(description).includes(entryKey);
}

/** Whether Markdown treats this as an indented code-block line. */
function indentedCodeLine(line: string): boolean {
  let columns = 0;
  for (const char of line) {
    if (char === " ") columns += 1;
    else if (char === "\t") columns += 4 - (columns % 4);
    else break;
    if (columns >= 4) return true;
  }
  return false;
}

/** Lines that can carry an entry record, excluding Markdown examples. */
export function authoritativeLines(description: string): string[] {
  const found: string[] = [];
  let fence: Fence | null = null;
  let inComment = false;
  for (const line of description.split("\n")) {
    if (fence === null && inComment) {
      const comment = commentLine(line, inComment);
      inComment = comment.inComment;
      continue;
    }
    if (fence === null && indentedCodeLine(line)) continue;
    const state = fenceLine(line, fence);
    fence = state.fence;
    if (state.consumed) continue;
    const comment = commentLine(line, inComment);
    inComment = comment.inComment;
    if (!comment.consumed && !indentedCodeLine(line)) found.push(line);
  }
  return found;
}
