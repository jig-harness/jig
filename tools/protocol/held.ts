/** Check an operational copy against the value its chapter imports from code. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../../lib/findings.ts";

/** A named operational phrase, including the value it must carry. */
export interface HeldPhrase {
  readonly file: string;
  readonly text: string;
  /** The Markdown heading that owns this operational restatement. */
  readonly section?: string;
  /** Command contracts may intentionally appear in a fenced example. */
  readonly includeCodeExamples?: boolean;
}

/** Checkout line endings do not change an operational phrase's value. */
const lineEndings = (text: string): string => text.replaceAll("\r\n", "\n");

/** HTML comments are not operational Markdown, so they cannot satisfy a check. */
const protectedFencedCommentOpener = "\uE000held-comment-opener\uE001";

function withoutHtmlComments(text: string): string {
  let visible = "";
  let cursor = 0;
  while (true) {
    const codeStart = nextUnescapedBacktick(text, cursor);
    const start = text.indexOf("<!--", cursor);
    if (start < 0 && codeStart < 0) return visible + text.slice(cursor);
    if (codeStart >= 0 && (start < 0 || codeStart < start)) {
      let end = codeStart;
      while (text[end] === "`") end += 1;
      const delimiter = text.slice(codeStart, end);
      const close = closingDelimiter(text, delimiter, end);
      if (close < 0) {
        const boundary = text.slice(end).search(/\n[ \t]*\n/);
        if (boundary < 0) return visible + text.slice(cursor);
        // This unmatched opener is literal text in its paragraph. Resume at
        // it so comments in the following block remain comments.
        visible += text.slice(cursor, end);
        cursor = end;
        continue;
      }
      visible += text.slice(cursor, close + delimiter.length);
      cursor = close + delimiter.length;
      continue;
    }
    visible += text.slice(cursor, start);
    const end = text.indexOf("-->", start + "<!--".length);
    const hidden = text.slice(
      start,
      end < 0 ? text.length : end + "-->".length,
    );
    // Preserve every line boundary so section locations stay aligned with the
    // source while comments cannot join phrase fragments or satisfy a check.
    visible += hidden.replaceAll(/[^\n]/g, " ");
    if (end < 0) return visible;
    cursor = end + "-->".length;
  }
}

/** Preserve literal comment openers in fenced examples while comments are stripped. */
function protectFencedCommentOpeners(source: string): string {
  let fence: { char: "`" | "~"; length: number } | undefined;
  return source
    .split("\n")
    .map((line) => {
      if (fence !== undefined) {
        if (closesFence(line, fence, 0)) fence = undefined;
        return line.replaceAll("<!--", protectedFencedCommentOpener);
      }
      const marker = fenceMarker(line);
      if (marker !== null) fence = marker;
      return line;
    })
    .join("\n");
}

/** A backslash escapes a delimiter when it is preceded by an odd backslash run. */
function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === "\\";
    cursor -= 1
  )
    slashes += 1;
  return slashes % 2 === 1;
}

function nextUnescapedBacktick(text: string, from: number): number {
  for (
    let index = text.indexOf("`", from);
    index >= 0;
    index = text.indexOf("`", index + 1)
  )
    if (!isEscaped(text, index)) return index;
  return -1;
}

/** Find an inline-code closer with exactly the opening delimiter. */
function closingDelimiter(
  text: string,
  delimiter: string,
  from: number,
): number {
  for (let cursor = from; cursor < text.length; cursor += 1) {
    // An inline code span cannot make a later Markdown block part of its
    // context. In particular, an unmatched delimiter in one paragraph must
    // not shield an HTML comment after a blank line.
    if (/^\n[ \t]*\n/.test(text.slice(cursor))) return -1;
    if (text.startsWith(delimiter, cursor)) {
      const beforeMatches = text[cursor - 1] === "`";
      const afterMatches = text[cursor + delimiter.length] === "`";
      if (!beforeMatches && !afterMatches) return cursor;
    }
  }
  return -1;
}

/** Render indentation as Markdown columns, where a tab moves to the next stop. */
function indentationColumns(text: string): number {
  let columns = 0;
  for (const char of text) columns += char === "\t" ? 4 - (columns % 4) : 1;
  return columns;
}

function listContentIndent(line: string): number | null {
  const match = /^(?:[ \t]*)(?:[-+*]|\d+[.)])[ \t]+/.exec(line);
  return match === null ? null : indentationColumns(match[0]);
}

/** Drop the optional whitespace-delimited closing hash sequence of an ATX heading. */
function withoutClosingHeadingHashes(text: string): string {
  const trimmed = text.trimEnd();
  let start = trimmed.length;
  while (start > 0 && trimmed[start - 1] === "#") start -= 1;
  if (
    start === trimmed.length ||
    start === 0 ||
    !/[ \t]/.test(trimmed.charAt(start - 1))
  )
    return trimmed;
  return trimmed.slice(0, start).trimEnd();
}

/** An ATX heading outside code, normalized to the form declarations use. */
function markdownHeading(line: string): { text: string; level: number } | null {
  let offset = 0;
  while (offset < 3 && line[offset] === " ") offset += 1;
  const start = offset;
  while (line[offset] === "#") offset += 1;
  const level = offset - start;
  if (level < 1 || level > 6) return null;
  const remainder = line.slice(offset);
  if (remainder !== "" && !/^[ \t]/.test(remainder)) return null;
  const content = withoutClosingHeadingHashes(remainder);
  return {
    text: `${"#".repeat(level)}${content === "" ? "" : ` ${content.trimStart()}`}`,
    level,
  };
}

function fenceMarker(
  line: string,
  containerIndent = 0,
): { char: "`" | "~"; length: number; end: number } | null {
  let offset = 0;
  let columns = 0;
  while (
    offset < line.length &&
    (line[offset] === " " || line[offset] === "\t")
  ) {
    columns += line[offset] === "\t" ? 4 - (columns % 4) : 1;
    offset += 1;
  }
  if (columns > containerIndent + 3) return null;
  const char = line[offset];
  if (char !== "`" && char !== "~") return null;
  const start = offset;
  while (line[offset] === char) offset += 1;
  if (offset - start < 3) return null;
  return { char, length: offset - start, end: offset };
}

function closesFence(
  line: string,
  fence: { char: "`" | "~"; length: number },
  containerIndent: number,
): boolean {
  const marker = fenceMarker(line, containerIndent);
  return (
    marker !== null &&
    marker.char === fence.char &&
    marker.length >= fence.length &&
    /^[ \t]*$/.test(line.slice(marker.end))
  );
}

interface ListContainer {
  readonly contentIndent: number;
  readonly markerIndent: number;
}

/** Carry nested list containers across blank lines and continuations. */
function nextListContainers(
  line: string,
  current: readonly ListContainer[],
): readonly ListContainer[] {
  const listed = listContentIndent(line);
  const leading = indentationColumns(/^[ \t]*/.exec(line)?.[0] ?? "");
  if (listed !== null) {
    const retained = current.filter(
      ({ markerIndent }) => markerIndent < leading,
    );
    return [...retained, { markerIndent: leading, contentIndent: listed }];
  }
  if (line.trim() === "") return current;
  return current.filter(({ contentIndent }) => leading >= contentIndent);
}

function activeListIndent(containers: readonly ListContainer[]): number {
  return containers.at(-1)?.contentIndent ?? 0;
}

function isIndentedCode(line: string, listIndent: number | undefined): boolean {
  const leading = indentationColumns(/^[ \t]*/.exec(line)?.[0] ?? "");
  return leading >= (listIndent === undefined ? 4 : listIndent + 4);
}

/**
 * Visible Markdown lines, preserving headings while excluding code examples.
 *
 * Held instructions live in prose. A command example can legitimately repeat an
 * exit code or even resemble a heading, so it must neither delimit a section
 * nor satisfy the held-value check. Empty separators prevent excluded blocks
 * from joining phrase fragments that were not adjacent in the source.
 */
function visibleLines(source: string): string[] {
  const lines: string[] = [];
  let fence:
    | { char: "`" | "~"; length: number; containerIndent: number }
    | undefined;
  let indentedCode = false;
  let previousWasBlank = true;
  let listContainers: readonly ListContainer[] = [];
  for (const line of source.split("\n")) {
    if (fence) {
      if (closesFence(line, fence, fence.containerIndent)) fence = undefined;
      lines.push("");
      previousWasBlank = true;
      continue;
    }
    listContainers = nextListContainers(line, listContainers);
    const listIndent = activeListIndent(listContainers);
    const marker = fenceMarker(line, listIndent);
    if (marker !== null) {
      fence = { ...marker, containerIndent: listIndent };
      lines.push("");
      previousWasBlank = true;
      continue;
    }
    const indented = isIndentedCode(line, listIndent);
    if (indentedCode && (indented || line.trim() === "")) {
      lines.push("");
      previousWasBlank = true;
      continue;
    }
    indentedCode = previousWasBlank && indented;
    if (indentedCode) {
      lines.push("");
      previousWasBlank = true;
      continue;
    }
    lines.push(line);
    previousWasBlank = line.trim() === "";
  }
  return lines;
}

/** The one prose section named by `heading`, through its next peer or parent heading. */
function sectionOf(
  source: string,
  heading: string,
  includeCodeExamples = false,
): string | null {
  // Remove block-code contexts before looking for comments. A literal comment
  // token in a fenced example is data, not an HTML comment in this document.
  const lines = withoutHtmlComments(visibleLines(source).join("\n")).split(
    "\n",
  );
  const headings = lines
    .map((line, index) => ({ index, parsed: markdownHeading(line) }))
    .filter(
      (
        entry,
      ): entry is { index: number; parsed: { text: string; level: number } } =>
        entry.parsed !== null,
    );
  const matches = headings.filter(({ parsed }) => parsed.text === heading);
  const start = matches[0];
  if (matches.length !== 1 || start === undefined) return null;
  const next = headings.find(
    ({ index, parsed }) =>
      index > start.index && parsed.level <= start.parsed.level,
  );
  if (!includeCodeExamples)
    return lines.slice(start.index, next?.index).join("\n");
  // `visibleLines` retains one line for every source line, so its heading
  // boundaries also locate the raw command examples in this section.
  return withoutHtmlComments(
    protectFencedCommentOpeners(
      source.split("\n").slice(start.index, next?.index).join("\n"),
    ),
  ).replaceAll(protectedFencedCommentOpener, "<!--");
}

/** Escape literal text for the small semantic-pattern check below. */
const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A section-scoped exit instruction cannot be masked by a contradictory copy.
 *
 * The stable phrases carry exit numbers in code spans. Treat those numbers as
 * the variable part of one instruction shape: every visible copy must carry
 * the declared value, and there must be exactly one such copy.
 */
function isOneOperationalOccurrence(source: string, text: string): boolean {
  const parts = text.split(/(`\d+`)/);
  if (parts.length === 1) {
    const first = source.indexOf(text);
    return first >= 0 && first === source.lastIndexOf(text);
  }
  const pattern = parts
    .map((part) => (/^`\d+`$/.test(part) ? "`\\d+`" : escapeRegExp(part)))
    .join("");
  const matches = [...source.matchAll(new RegExp(pattern, "g"))].map(
    (match) => match[0],
  );
  return matches.length === 1 && matches[0] === text;
}

export function checkHeldPhrases(
  root: string,
  chapter: string,
  phrases: readonly HeldPhrase[],
): Finding[] {
  return phrases.flatMap((phrase) => {
    const { file, text } = phrase;
    let source: string;
    try {
      source = readFileSync(join(root, file), "utf8");
    } catch (error) {
      return [
        {
          rule: "protocol-held",
          file,
          problem: `the held restatement of ${chapter} could not be read: ${error instanceof Error ? error.message : String(error)}`,
          remedy:
            "restore the named file and read access, then rerun the protocol check",
        },
      ];
    }
    const expected = lineEndings(text);
    const actual = lineEndings(source);
    const operational =
      phrase.section === undefined
        ? actual
        : sectionOf(actual, phrase.section, phrase.includeCodeExamples);
    return operational !== null &&
      (phrase.section === undefined
        ? operational.includes(expected)
        : isOneOperationalOccurrence(operational, expected))
      ? []
      : [
          {
            rule: "protocol-held",
            file,
            problem: `the held restatement of ${chapter} lacks ${JSON.stringify(text)}${phrase.section === undefined ? "" : ` in ${phrase.section}`}`,
            remedy: `restore the operational phrase using plugin/protocol/${chapter}.md, or replace it with a chapter link and remove its held check`,
          },
        ];
  });
}
