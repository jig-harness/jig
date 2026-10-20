import { readable } from "./ratchet-common.ts";
import type { Counts, FileLinesCounter } from "./ratchet-types.ts";

/**
 * Count excess physical lines, rather than oversized files: growing an
 * already oversized file adds debt too. A final newline terminates the last
 * line; an empty file has no lines. CRLF and LF therefore count alike.
 */
export function fileLineCounts(
  tree: string,
  tracked: string[],
  counter: FileLinesCounter,
): Counts {
  const include = new RegExp(counter.files);
  const exclude =
    counter.exclude === undefined ? undefined : new RegExp(counter.exclude);
  const excess = new Map<string, number>();
  for (const file of tracked) {
    if (!file || !include.test(file) || exclude?.test(file)) continue;
    const text = readable(tree, file);
    if (!text) continue;
    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    if (lines > counter.limit) excess.set(file, lines - counter.limit);
  }
  return excess.size ? new Map([["excess-lines", excess]]) : new Map();
}
