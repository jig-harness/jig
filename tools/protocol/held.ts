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
const withoutHtmlComments = (text: string): string =>
  text.replaceAll(/<!--[\s\S]*?-->/g, "");

/** The one section named by `heading`, through its next peer or parent heading. */
function sectionOf(source: string, heading: string): string | null {
  const lines = source.split("\n");
  const indexes = lines
    .map((line, index) => (line.trim() === heading ? index : -1))
    .filter((index) => index >= 0);
  const [start] = indexes;
  if (indexes.length !== 1 || start === undefined) return null;
  const level = heading.match(/^#+/)?.[0].length;
  if (level === undefined) return null;
  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      (line.match(/^(#+)\s/)?.[1]?.length ?? Number.POSITIVE_INFINITY) <= level,
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
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
    return operational?.includes(expected)
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
