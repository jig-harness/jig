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

/** The inline Markdown constructs that can hide a record across lines. */
interface InlineState {
  inComment: boolean;
  codeDelimiter: string | null;
}

function backtickRun(line: string, start: number): number {
  let end = start;
  while (line[end] === "`") end += 1;
  return end;
}

/** Find a complete closing run, never a prefix inside a longer run. */
function closingRun(
  line: string,
  start: number,
  delimiter: string,
): number | null {
  for (let cursor = start; cursor < line.length; cursor += 1) {
    if (line[cursor] !== "`") continue;
    const end = backtickRun(line, cursor);
    if (end - cursor === delimiter.length) return end;
    cursor = end - 1;
  }
  return null;
}

function hasClosingRun(
  lines: readonly string[],
  afterLine: number,
  delimiter: string,
): boolean {
  for (let index = afterLine + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (inlineBoundary(line)) return false;
    if (closingRun(line, 0, delimiter) !== null) return true;
  }
  return false;
}

/** A block boundary cannot share an inline-code span with adjacent prose. */
function inlineBoundary(line: string): boolean {
  return (
    line.trim() === "" ||
    /^ {0,3}#{1,6}(?:\s|$)/.test(line) ||
    /^ {0,3}(?:\*[ \t]*){3,}$/.test(line) ||
    /^ {0,3}(?:-[ \t]*){3,}$/.test(line) ||
    /^ {0,3}(?:_[ \t]*){3,}$/.test(line) ||
    openingFence(line) !== null
  );
}

/**
 * Whether a line has record-bearing text outside HTML comments and inline
 * code. Inline code spans can cross line endings within one paragraph, so the
 * delimiter is retained until its complete, equal-length closing run.
 */
function inlineLine(
  line: string,
  state: InlineState,
  hasFutureClosing: (delimiter: string) => boolean,
): { state: InlineState; consumed: boolean } {
  let { inComment, codeDelimiter } = state;
  if (!inComment && codeDelimiter !== null && line.trim() === "") {
    codeDelimiter = null;
  }

  let cursor = 0;
  let visible = false;
  while (cursor < line.length) {
    if (inComment) {
      const end = line.indexOf("-->", cursor);
      if (end < 0) {
        return {
          state: { inComment: true, codeDelimiter },
          consumed: !visible,
        };
      }
      inComment = false;
      cursor = end + 3;
      continue;
    }
    if (codeDelimiter !== null) {
      const close = closingRun(line, cursor, codeDelimiter);
      if (close === null) {
        return { state: { inComment, codeDelimiter }, consumed: !visible };
      }
      codeDelimiter = null;
      cursor = close;
      continue;
    }
    if (line[cursor] === "\\") {
      visible = true;
      cursor += 2;
      continue;
    }
    if (line.startsWith("<!--", cursor)) {
      inComment = true;
      cursor += 4;
      continue;
    }
    if (line[cursor] === "`") {
      const end = backtickRun(line, cursor);
      const delimiter = line.slice(cursor, end);
      const close = closingRun(line, end, delimiter);
      if (close === null) {
        if (inlineBoundary(line) || !hasFutureClosing(delimiter)) {
          visible = true;
          cursor = end;
          continue;
        }
        return {
          state: { inComment, codeDelimiter: delimiter },
          consumed: !visible,
        };
      }
      // Preserve ordinary text that happens to contain an inline-code example.
      // The callers still reject records hidden by a span that crosses lines.
      visible = true;
      cursor = close;
      continue;
    }
    if (!/\s/.test(line[cursor] ?? "")) visible = true;
    cursor += 1;
  }
  return { state: { inComment, codeDelimiter }, consumed: !visible };
}

function openingFence(line: string): { fence: Fence; info: string } | null {
  let start = 0;
  while (line[start] === " " && start < 4) start += 1;
  const char = line[start];
  if ((char !== "`" && char !== "~") || start === 4) return null;
  let end = start;
  while (line[end] === char) end += 1;
  const len = end - start;
  const info = line.slice(end);
  if (len < 3 || (char === "`" && info.includes("`"))) return null;
  return { fence: { char, len }, info };
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
  return { fence: marker.fence, consumed: true };
}

export function entryHeadings(description: string): string[] {
  const found: string[] = [];
  let fence: Fence | null = null;
  let inline: InlineState = { inComment: false, codeDelimiter: null };
  const lines = description.split("\n");
  for (const [index, line] of lines.entries()) {
    if (
      fence === null &&
      (inline.inComment ||
        (inline.codeDelimiter !== null && !inlineBoundary(line)))
    ) {
      inline = inlineLine(line, inline, (delimiter) =>
        hasClosingRun(lines, index, delimiter),
      ).state;
      continue;
    }
    if (inline.codeDelimiter !== null)
      inline = { ...inline, codeDelimiter: null };
    if (fence === null && indentedCodeLine(line)) continue;
    const state = fenceLine(line, fence);
    fence = state.fence;
    if (state.consumed) continue;
    const lineState = inlineLine(line, inline, (delimiter) =>
      hasClosingRun(lines, index, delimiter),
    );
    inline = lineState.state;
    if (lineState.consumed) continue;
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
  let inline: InlineState = { inComment: false, codeDelimiter: null };
  const lines = description.split("\n");
  for (const [index, line] of lines.entries()) {
    if (
      fence === null &&
      (inline.inComment ||
        (inline.codeDelimiter !== null && !inlineBoundary(line)))
    ) {
      inline = inlineLine(line, inline, (delimiter) =>
        hasClosingRun(lines, index, delimiter),
      ).state;
      continue;
    }
    if (inline.codeDelimiter !== null)
      inline = { ...inline, codeDelimiter: null };
    if (fence === null && indentedCodeLine(line)) continue;
    const state = fenceLine(line, fence);
    fence = state.fence;
    if (state.consumed) continue;
    const lineState = inlineLine(line, inline, (delimiter) =>
      hasClosingRun(lines, index, delimiter),
    );
    inline = lineState.state;
    if (!lineState.consumed && !indentedCodeLine(line)) found.push(line);
  }
  return found;
}
