import { readable } from "./ratchet-common.ts";
import type { Counts, FileLinesCounter } from "./ratchet-types.ts";

/**
 * Count excess physical lines, rather than oversized files: growing an
 * already oversized file adds debt too. A final newline terminates the last
 * line; an empty file has no lines. CRLF and LF therefore count alike.
 *
 * In the working tree, a scope that matches no readable file measures
 * nothing, and an empty count would read as "no excess" and pass forever: a
 * mistyped `files` expression is a configuration error, not a clean tree.
 * A historical tree (`historical`) is held to no such check: it may predate
 * every file the scope matches, and then its excess is zero.
 */
export function fileLineCounts(
  tree: string,
  tracked: string[],
  counter: FileLinesCounter,
  historical = false,
): Counts {
  const inScope = scope(counter);
  const excess = new Map<string, number>();
  let examined = 0;
  for (const file of tracked) {
    const text = inScope(file) ? readable(tree, file) : undefined;
    if (text === undefined) continue;
    examined++;
    const lines = physicalLines(text);
    if (lines > counter.limit) excess.set(file, lines - counter.limit);
  }
  if (examined === 0 && !historical) throw new Error(emptyScope(counter));
  return excess.size ? new Map([["excess-lines", excess]]) : new Map();
}

function scope(counter: FileLinesCounter): (file: string) => boolean {
  const include = new RegExp(counter.files);
  const exclude =
    counter.exclude === undefined ? undefined : new RegExp(counter.exclude);
  return (file) => !!file && include.test(file) && !exclude?.test(file);
}

function physicalLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function emptyScope(counter: FileLinesCounter): string {
  const outside =
    counter.exclude === undefined ? "" : ` outside exclude ${counter.exclude}`;
  return `${counter.name}: no file matches files ${counter.files}${outside}`;
}
