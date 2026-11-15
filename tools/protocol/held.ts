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

/** Line wrapping and list indentation do not change an operational phrase. */
const collapsed = (text: string): string => text.replaceAll(/\s+/g, " ");

/** Control characters that mark blocks in the rendered text; none occur in prose. */
const headingOpen = "\u0003";
const headingMid = "\u0004";
const headingClose = "\u0005";
const codeOpen = "\u0001";
const codeClose = "\u0002";
const markerCharacters = new RegExp(
  `[${codeOpen}${codeClose}${headingOpen}${headingMid}${headingClose}]`,
  "g",
);

/** An HTML comment is not operational Markdown, so it cannot satisfy a check. */
const htmlComment = /<!--[\s\S]*?(?:-->|$)/g;

interface Block {
  readonly kind: "heading" | "prose" | "code";
  readonly text: string;
  readonly level?: number;
}

function flattenHeadings(content: string): string {
  return content.replaceAll(
    new RegExp(
      `${headingOpen}\\d${headingMid}([^${headingClose}]*)${headingClose}`,
      "g",
    ),
    "$1\n",
  );
}

/**
 * The document's blocks in order, from Bun's CommonMark parser.
 *
 * Block structure (what ends a paragraph, where a code span or an HTML comment
 * can start) comes from the parser, never from patterns here. Prose keeps its
 * inline code, emphasis and links in source form; comments become a space so
 * they cannot join phrase fragments; code examples stay apart.
 */
function parseBlocks(source: string): Block[] {
  const lines = (content: string): string =>
    content.endsWith("\n") ? content : `${content}\n`;
  const rendered = Bun.markdown.render(
    source.replaceAll(markerCharacters, ""),
    {
      text: (content: string) =>
        /^<!--[\s\S]*-->$/.test(content) ? " " : content,
      codespan: (content: string) => `\`${content}\``,
      emphasis: (content: string) => `*${content}*`,
      strong: (content: string) => `**${content}**`,
      link: (content: string, meta?: { href?: string }) =>
        `[${content}](${meta?.href ?? ""})`,
      paragraph: lines,
      // A heading inside a quote or list item is that container's text, not a
      // section boundary of the document.
      listItem: (content: string) => lines(flattenHeadings(content)),
      blockquote: (content: string) => lines(flattenHeadings(content)),
      tr: (content: string) => lines(`${content}|`),
      td: (content: string) => `| ${content} `,
      th: (content: string) => `| ${content} `,
      html: (content: string) => lines(content.replaceAll(htmlComment, " ")),
      code: (content: string) => `${codeOpen}${content}${codeClose}`,
      heading: (content: string, meta?: { level?: number }) =>
        `${headingOpen}${meta?.level ?? 1}${headingMid}${content}${headingClose}`,
    } as never,
  );
  const pattern = new RegExp(
    `${headingOpen}(\\d)${headingMid}([^${headingClose}]*)${headingClose}|${codeOpen}([^${codeClose}]*)${codeClose}`,
    "g",
  );
  const blocks: Block[] = [];
  let cursor = 0;
  for (const match of rendered.matchAll(pattern)) {
    blocks.push({ kind: "prose", text: rendered.slice(cursor, match.index) });
    cursor = match.index + match[0].length;
    if (match[1] === undefined)
      blocks.push({ kind: "code", text: match[3] ?? "" });
    else {
      const level = Number(match[1]);
      blocks.push({
        kind: "heading",
        level,
        text: `${"#".repeat(level)} ${(match[2] ?? "").trim()}`,
      });
    }
  }
  blocks.push({ kind: "prose", text: rendered.slice(cursor) });
  return blocks;
}

/** The one prose section named by `heading`, through its next peer or parent heading. */
function sectionOf(
  source: string,
  heading: string,
  includeCodeExamples = false,
): string | null {
  const blocks = parseBlocks(source);
  const matches = blocks.filter(
    (block) => block.kind === "heading" && block.text === heading,
  );
  const start = matches[0];
  if (matches.length !== 1 || start === undefined) return null;
  const from = blocks.indexOf(start);
  const next = blocks.findIndex(
    (block, index) =>
      index > from &&
      block.kind === "heading" &&
      (block.level ?? 0) <= (start.level ?? 0),
  );
  return blocks
    .slice(from, next < 0 ? undefined : next)
    .filter(
      (block) =>
        block.kind === "prose" ||
        (includeCodeExamples && block.kind === "code"),
    )
    .map((block) => block.text)
    .join("\n");
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
    const expected = collapsed(lineEndings(text));
    const actual = lineEndings(source);
    const scope =
      phrase.section === undefined
        ? actual
        : sectionOf(actual, phrase.section, phrase.includeCodeExamples);
    const operational = scope === null ? null : collapsed(scope);
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
