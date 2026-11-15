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
}

/** Checkout line endings do not change an operational phrase's value. */
const lineEndings = (text: string): string => text.replaceAll("\r\n", "\n");

/** HTML comments are not operational Markdown, so they cannot satisfy a check. */
function withoutHtmlComments(text: string): string {
  let visible = "";
  let cursor = 0;
  while (true) {
    const start = text.indexOf("<!--", cursor);
    if (start < 0) return visible + text.slice(cursor);
    visible += text.slice(cursor, start);
    const end = text.indexOf("-->", start + "<!--".length);
    if (end < 0) return `${visible}\n`;
    // Keep a boundary: removing a comment must not join two phrase fragments.
    visible += "\n";
    cursor = end + "-->".length;
  }
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
  const content = remainder.replace(/[ \t]+#+[ \t]*$/, "").trimEnd();
  return {
    text: `${"#".repeat(level)}${content === "" ? "" : ` ${content.trimStart()}`}`,
    level,
  };
}

function fenceMarker(
  line: string,
): { char: "`" | "~"; length: number; end: number } | null {
  let offset = 0;
  while (offset < 3 && line[offset] === " ") offset += 1;
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
): boolean {
  const marker = fenceMarker(line);
  return (
    marker !== null &&
    marker.char === fence.char &&
    marker.length >= fence.length &&
    /^[ \t]*$/.test(line.slice(marker.end))
  );
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
  let fence: { char: "`" | "~"; length: number } | undefined;
  let indentedCode = false;
  let previousWasBlank = true;
  for (const line of source.split("\n")) {
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
      lines.push("");
      previousWasBlank = true;
      continue;
    }
    const marker = fenceMarker(line);
    if (marker !== null) {
      fence = marker;
      lines.push("");
      previousWasBlank = true;
      continue;
    }
    const indented = line.startsWith("    ") || line.startsWith("\t");
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
function sectionOf(source: string, heading: string): string | null {
  const lines = visibleLines(source);
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
  return lines.slice(start.index, next?.index).join("\n");
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
  if (parts.length === 1)
    return source.indexOf(text) === source.lastIndexOf(text);
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
    const actual =
      phrase.section === undefined
        ? lineEndings(source)
        : withoutHtmlComments(lineEndings(source));
    const operational =
      phrase.section === undefined ? actual : sectionOf(actual, phrase.section);
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
