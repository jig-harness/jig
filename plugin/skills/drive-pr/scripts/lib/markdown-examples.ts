/**
 * Strip Markdown code blocks (fenced and indented) and HTML comments from a
 * reviewer summary body while keeping line breaks intact so line-oriented
 * summary parsers never join two live bullets or mistake quoted examples for
 * live findings or unanchored-count declarations.
 */

type MarkdownContainer = { kind: "quote" } | { kind: "list"; indent: number };

type MarkdownFence = {
  char: string;
  length: number;
  containers: readonly MarkdownContainer[];
};

type LineCursor = {
  line: string;
  index: number;
  column: number;
  /** Remaining columns from a partially consumed tab character. */
  pendingSpaces: number;
};

type FenceDelimiter = {
  char: string;
  length: number;
  info: string;
};

type ScannerState = {
  fence: MarkdownFence | null;
  indentedCode: boolean;
  previousBlank: boolean;
  containers: MarkdownContainer[];
  inHtmlComment: boolean;
};

function startCursor(line: string): LineCursor {
  return { line, index: 0, column: 0, pendingSpaces: 0 };
}

function peekIndent(cursor: LineCursor): {
  columns: number;
  index: number;
  column: number;
  blank: boolean;
} {
  let index = cursor.index;
  let column = cursor.column + cursor.pendingSpaces;
  let columns = cursor.pendingSpaces;
  while (index < cursor.line.length) {
    const ch = cursor.line[index];
    if (ch === " ") {
      columns += 1;
      column += 1;
      index += 1;
    } else if (ch === "\t") {
      const step = 4 - (column % 4);
      columns += step;
      column += step;
      index += 1;
    } else {
      return { columns, index, column, blank: false };
    }
  }
  return { columns, index, column, blank: true };
}

function advanceColumns(cursor: LineCursor, count: number): LineCursor {
  let remaining = count;
  let index = cursor.index;
  let column = cursor.column;
  let pendingSpaces = cursor.pendingSpaces;
  if (pendingSpaces > 0) {
    const take = Math.min(pendingSpaces, remaining);
    pendingSpaces -= take;
    column += take;
    remaining -= take;
  }
  while (remaining > 0 && index < cursor.line.length) {
    const ch = cursor.line[index];
    if (ch === " ") {
      index += 1;
      column += 1;
      remaining -= 1;
    } else if (ch === "\t") {
      const step = 4 - (column % 4);
      index += 1;
      if (step <= remaining) {
        column += step;
        remaining -= step;
      } else {
        column += remaining;
        pendingSpaces = step - remaining;
        remaining = 0;
      }
    } else {
      break;
    }
  }
  return { line: cursor.line, index, column, pendingSpaces };
}

function consumeQuoteMarker(
  cursor: LineCursor,
  ws: { index: number; column: number },
): LineCursor {
  const afterMarker: LineCursor = {
    line: cursor.line,
    index: ws.index + 1,
    column: ws.column + 1,
    pendingSpaces: 0,
  };
  // CommonMark §5.1: at most one optional space (or one column of a tab)
  // after `>` belongs to the quote marker; further spaces remain content.
  const next = afterMarker.line[afterMarker.index];
  return next === " " || next === "\t"
    ? advanceColumns(afterMarker, 1)
    : afterMarker;
}

function matchContainers(
  start: LineCursor,
  containers: readonly MarkdownContainer[],
): { cursor: LineCursor; matched: number } {
  let cursor = start;
  let matched = 0;
  for (const container of containers) {
    const ws = peekIndent(cursor);
    if (container.kind === "quote") {
      if (ws.blank || ws.columns > 3 || cursor.line[ws.index] !== ">") break;
      cursor = consumeQuoteMarker(cursor, ws);
      matched += 1;
    } else if (ws.blank) {
      // Blank lines do not end an open list item.
      matched += 1;
    } else if (ws.columns >= container.indent) {
      cursor = advanceColumns(cursor, container.indent);
      matched += 1;
    } else {
      break;
    }
  }
  return { cursor, matched };
}

function consumeListMarker(
  cursor: LineCursor,
  ws: { columns: number; index: number; column: number },
): { cursor: LineCursor; indent: number } | null {
  const markerMatch = cursor.line
    .slice(ws.index)
    .match(/^(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)/);
  if (!markerMatch) return null;
  const markerLen = markerMatch[0].length;
  const afterMarker: LineCursor = {
    line: cursor.line,
    index: ws.index + markerLen,
    column: ws.column + markerLen,
    pendingSpaces: 0,
  };
  const afterWs = peekIndent(afterMarker);
  // CommonMark §5.2: 1..4 columns of whitespace after the marker set the
  // item's content column; a blank item or >=5 columns (indented code)
  // allocates only one column to the marker separator.
  const postSpaces =
    afterWs.blank || afterWs.columns > 4 ? 1 : Math.max(1, afterWs.columns);
  return {
    cursor: afterWs.blank
      ? afterMarker
      : advanceColumns(afterMarker, postSpaces),
    indent: ws.columns + markerLen + postSpaces,
  };
}

function openNewContainers(
  start: LineCursor,
  containers: MarkdownContainer[],
): { cursor: LineCursor; opened: boolean } {
  let cursor = start;
  let opened = false;
  while (true) {
    const ws = peekIndent(cursor);
    if (ws.blank || ws.columns > 3) break;
    if (cursor.line[ws.index] === ">") {
      cursor = consumeQuoteMarker(cursor, ws);
      containers.push({ kind: "quote" });
      opened = true;
      continue;
    }
    const list = consumeListMarker(cursor, ws);
    if (!list) break;
    cursor = list.cursor;
    containers.push({ kind: "list", indent: list.indent });
    opened = true;
  }
  return { cursor, opened };
}

function matchFenceDelimiter(cursor: LineCursor): FenceDelimiter | null {
  const ws = peekIndent(cursor);
  if (ws.blank || ws.columns > 3) return null;
  const match = cursor.line.slice(ws.index).match(/^(`{3,}|~{3,})([^\r\n]*)$/);
  if (!match) return null;
  return {
    char: match[1]?.[0] ?? "`",
    length: match[1]?.length ?? 0,
    info: match[2] ?? "",
  };
}

function opensFence(delim: FenceDelimiter | null): delim is FenceDelimiter {
  return delim !== null && !(delim.char === "`" && delim.info.includes("`"));
}

function closesFence(
  delim: FenceDelimiter | null,
  fence: MarkdownFence,
): boolean {
  return (
    delim !== null &&
    delim.char === fence.char &&
    delim.length >= fence.length &&
    /^[ \t]*$/.test(delim.info)
  );
}

function countRun(text: string, start: number, char: string): number {
  let end = start;
  while (end < text.length && text[end] === char) end += 1;
  return end;
}

/**
 * Given `start` at a backtick run, return the index immediately after its
 * matching CommonMark code span closer on this line, or after the opening run
 * alone when no same-length closing run exists.
 */
function advanceCodeSpan(line: string, start: number): number {
  const runEnd = countRun(line, start, "`");
  const runLen = runEnd - start;
  let search = runEnd;
  while (search < line.length) {
    const nextTick = line.indexOf("`", search);
    if (nextTick === -1) return runEnd;
    const tickEnd = countRun(line, nextTick, "`");
    if (tickEnd - nextTick === runLen) return tickEnd;
    search = tickEnd;
  }
  return runEnd;
}

/**
 * Strip HTML comments on one line while preserving CommonMark matched-backtick
 * inline code spans verbatim and carrying multi-line comment state across
 * lines. Uses a linear character scan rather than HTML-filtering regexes.
 */
function stripHtmlCommentsOnLine(line: string, state: ScannerState): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (state.inHtmlComment) {
      const end = line.indexOf("-->", i);
      if (end === -1) break;
      state.inHtmlComment = false;
      i = end + 3;
    } else if (line[i] === "`") {
      const next = advanceCodeSpan(line, i);
      out += line.slice(i, next);
      i = next;
    } else if (line.startsWith("<!--", i)) {
      state.inHtmlComment = true;
      i += 4;
    } else {
      out += line[i];
      i += 1;
    }
  }
  return out;
}

function consumeActiveFence(line: string, state: ScannerState): boolean {
  const fence = state.fence;
  if (fence === null) return false;
  const { cursor, matched } = matchContainers(
    startCursor(line),
    fence.containers,
  );
  if (matched < fence.containers.length) {
    state.fence = null;
    return false;
  }
  if (closesFence(matchFenceDelimiter(cursor), fence)) state.fence = null;
  state.previousBlank = false;
  return true;
}

function scanLine(line: string, state: ScannerState): string {
  // An active fence is authoritative: literal list markers, quote markers
  // and comment openers inside it are code, not parser state.
  if (consumeActiveFence(line, state)) return "";

  let effectiveLine = line;
  let commentsStripped = false;
  if (state.inHtmlComment) {
    effectiveLine = stripHtmlCommentsOnLine(line, state);
    commentsStripped = true;
    if (state.inHtmlComment || effectiveLine.trim() === "") {
      state.previousBlank = !state.inHtmlComment;
      return "";
    }
  }

  const existing = matchContainers(
    startCursor(effectiveLine),
    state.containers,
  );
  state.containers.length = existing.matched;
  const { cursor, opened } = openNewContainers(
    existing.cursor,
    state.containers,
  );
  const ws = peekIndent(cursor);

  // Indented code starts only where Markdown can start a new block; a
  // four-column paragraph continuation remains live prose.
  if (
    !ws.blank &&
    ws.columns >= 4 &&
    (state.previousBlank || opened || state.indentedCode)
  ) {
    state.indentedCode = true;
    state.previousBlank = false;
    return "";
  }

  const delim = matchFenceDelimiter(cursor);
  if (opensFence(delim)) {
    state.fence = {
      char: delim.char,
      length: delim.length,
      containers: [...state.containers],
    };
    state.indentedCode = false;
    state.previousBlank = false;
    return "";
  }

  state.indentedCode = false;
  const cleaned = commentsStripped
    ? effectiveLine
    : stripHtmlCommentsOnLine(effectiveLine, state);
  state.previousBlank = cleaned.trim() === "";
  return cleaned;
}

export function withoutFencedExamples(body: string): string {
  const state: ScannerState = {
    fence: null,
    indentedCode: false,
    previousBlank: true,
    containers: [],
    inHtmlComment: false,
  };
  return body
    .split(/\r?\n/)
    .map((line) => scanLine(line, state))
    .join("\n");
}
