// The link destinations a Markdown file declares, read the way a CommonMark
// renderer reads them: inline links and images (`[text](dest "title")`, with
// `<dest>` for a destination that holds spaces) and link reference
// definitions (`[label]: dest "title"`). Text inside fenced code blocks and
// code spans is literal, so it declares no link. A title is not part of the
// destination. Indented code blocks and HTML are not read.

/** One destination and the 1-based line it starts on. */
export interface MarkdownLink {
  target: string;
  line: number;
}

/** Every link destination `content` declares, in document order. */
export function markdownLinks(content: string): MarkdownLink[] {
  const text = blankCodeSpans(blankFences(content));
  const found: { target: string; index: number }[] = [];
  for (const match of text.matchAll(/\]\(/g)) {
    const start = match.index + 2;
    const target = destinationAt(text, start);
    if (target !== null) found.push({ target, index: start });
  }
  for (const match of text.matchAll(
    /^ {0,3}\[(?!\^)(?:[^\]\\\n]|\\.)+\]:[ \t]*(<[^<>\n]*>|\S+)/gm,
  )) {
    const raw = match[1] ?? "";
    found.push({
      target: unescapeDestination(raw.startsWith("<") ? raw.slice(1, -1) : raw),
      index: match.index + match[0].length - raw.length,
    });
  }
  return found
    .sort((a, b) => a.index - b.index)
    .map(({ target, index }) => ({
      target,
      line: content.slice(0, index).split("\n").length,
    }));
}

/** `text` with every character of a fenced code block, fences included, blanked. */
function blankFences(content: string): string {
  let fence: string | null = null;
  return content
    .split("\n")
    .map((line) => {
      if (fence === null) {
        fence = openingFence(line);
        return fence === null ? line : blank(line);
      }
      if (closesFence(line, fence)) fence = null;
      return blank(line);
    })
    .join("\n");
}

/** The fence `line` opens, or null when it opens none. */
function openingFence(line: string): string | null {
  const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  const marker = opening?.[1] ?? "";
  if (!marker) return null;
  return marker.startsWith("`") && opening?.[2]?.includes("`") ? null : marker;
}

/** Whether `line` closes the block `fence` opened. */
function closesFence(line: string, fence: string): boolean {
  const marker = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1] ?? "";
  return marker[0] === fence[0] && marker.length >= fence.length;
}

/** `text` with every code span blanked; a span never crosses a blank line. */
function blankCodeSpans(text: string): string {
  return text.replace(/(`+)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g, blank);
}

/** Spaces in place of every character but a newline, so offsets hold. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/**
 * The destination of an inline link whose `(` ends just before `start`, or
 * null when what follows is not a destination (and so no link). A
 * destination never crosses a line.
 */
function destinationAt(text: string, start: number): string | null {
  const lineEnd = text.indexOf("\n", start);
  const rest = text.slice(start, lineEnd < 0 ? undefined : lineEnd).trimStart();
  if (rest.startsWith("<")) {
    const inner = /^<([^<>]*)>/.exec(rest)?.[1];
    return inner === undefined ? null : unescapeDestination(inner);
  }
  const end = bareEnd(rest);
  return end === null ? null : unescapeDestination(rest.slice(0, end));
}

/**
 * Where a destination not in angle brackets ends in `rest`: at whitespace or
 * at the `)` that closes the link, its own parentheses balanced; null when
 * they are not.
 */
function bareEnd(rest: string): number | null {
  let depth = 0;
  for (const { 0: token, index } of rest.matchAll(
    /\\.|[()\s]|[^()\s\\]+|\\/g,
  )) {
    if (/^\s$/.test(token) || (token === ")" && depth === 0))
      return depth === 0 ? index : null;
    if (token === "(") depth++;
    else if (token === ")") depth--;
  }
  return depth === 0 ? rest.length : null;
}

/** A destination with its backslash escapes removed. */
function unescapeDestination(target: string): string {
  return target.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/** A destination's percent-encoding decoded, or the destination as written. */
export function decode(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}
