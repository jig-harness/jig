/**
 * A command line held in one setting, split into the words a program is
 * started with. Spaces separate words, single or double quotes keep spaces
 * inside one, and no shell runs it, so the same setting behaves alike on
 * every operating system and nothing in it is expanded or substituted.
 */
import { failed, ok, type Outcome } from "./outcome.ts";

/**
 * The words of `line`, or why it has none to give: an unclosed quote. The
 * reason never repeats the line, which may hold an argument its owner would
 * not want in a log.
 */
export function splitCommandWords(
  line: string,
): Outcome<string[], "unclosed-quote"> {
  const words: string[] = [];
  // A word is a run of unquoted non-space characters and quoted stretches.
  const word = /(?:[^\s'"]+|'[^']*'|"[^"]*")+/g;
  for (const match of line.matchAll(word))
    words.push(match[0].replace(/'([^']*)'|"([^"]*)"/g, "$1$2"));
  const unclosed = /['"]/.exec(line.replace(word, ""));
  return unclosed === null
    ? ok(words)
    : failed("unclosed-quote", `unclosed ${unclosed[0]}`);
}
