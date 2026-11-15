/** Check an operational copy against the value its chapter imports from code. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../../lib/findings.ts";

/** A named operational phrase, including the value it must carry. */
export interface HeldPhrase {
  readonly file: string;
  readonly text: string;
  /** The one-based source line that owns this operational restatement. */
  readonly line?: number;
}

/** Checkout line endings do not change an operational phrase's value. */
const lineEndings = (text: string): string => text.replaceAll("\r\n", "\n");

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
    const atLine = (() => {
      if (typeof phrase.line !== "number") return actual.includes(expected);
      const lines = actual.split("\n");
      const start = lines[phrase.line - 1];
      const firstLine = expected.split("\n")[0] ?? "";
      const offset = start?.indexOf(firstLine) ?? -1;
      return (
        offset >= 0 &&
        [start?.slice(offset), ...lines.slice(phrase.line)]
          .join("\n")
          .startsWith(expected)
      );
    })();
    return atLine
      ? []
      : [
          {
            rule: "protocol-held",
            file,
            problem: `the held restatement of ${chapter} lacks ${JSON.stringify(text)}${typeof phrase.line === "number" ? ` at line ${phrase.line}` : ""}`,
            remedy: `restore the operational phrase using plugin/protocol/${chapter}.md, or replace it with a chapter link and remove its held check`,
          },
        ];
  });
}
