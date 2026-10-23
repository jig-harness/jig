/**
 * The dropped-change check: which lines that a side added relative to the
 * base are missing from the resolved file.
 *
 * It compares whole files, not only the conflict regions. Resolving a file by
 * taking one side wholesale (`git checkout --ours`) also throws away the
 * other side's edits that git had already merged cleanly elsewhere in the
 * file; only a whole-file comparison sees those.
 *
 * Lines are compared trimmed and exactly. Blank lines and lines with no
 * letter or digit (braces, punctuation) are ignored: they recur everywhere
 * and say nothing about whether a change survived.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git, indexBlob, readBlob } from "./git.ts";
import type { SideName } from "./operation.ts";

export interface AddedLine {
  /** 1-based line number in the side's version of the file. */
  line: number;
  text: string;
}

export interface Dropped {
  side: SideName;
  line: number;
  text: string;
}

/** A line worth checking: it carries at least one letter or digit. */
export function significant(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function lines(text: string): string[] {
  const all = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (all.at(-1) === "") all.pop();
  return all;
}

/**
 * The significant lines `sideBlob` adds relative to `baseBlob`. Without a
 * base (both sides added the file) every line counts as added; without a
 * side blob (the side deleted the file) it added nothing.
 */
export function addedLines(
  root: string,
  baseBlob: string | null,
  sideBlob: string | null,
): AddedLine[] {
  if (sideBlob === null) return [];
  if (baseBlob === null)
    return lines(readBlob(root, sideBlob))
      .map((text, i) => ({ line: i + 1, text: text.trim() }))
      .filter((added) => significant(added.text));
  const diff = git(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--text",
    "--unified=0",
    baseBlob,
    sideBlob,
  ]);
  const added: AddedLine[] = [];
  let inHunks = false;
  let next = 0;
  for (const raw of diff.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      inHunks = true;
      next = Number(header[1]);
      continue;
    }
    if (!inHunks) continue;
    if (line.startsWith("+")) {
      const text = line.slice(1).trim();
      if (significant(text)) added.push({ line: next, text });
      next++;
    }
  }
  return added;
}

/** The added lines of each side that are absent from `resolved`. */
export function droppedLines(
  root: string,
  stages: {
    base: string | null;
    ours: string | null;
    theirs: string | null;
  },
  resolved: string,
): Dropped[] {
  const present = new Set(lines(resolved).map((line) => line.trim()));
  const dropped: Dropped[] = [];
  for (const side of ["ours", "theirs"] as const)
    for (const added of addedLines(root, stages.base, stages[side]))
      if (!present.has(added.text)) dropped.push({ side, ...added });
  return dropped;
}

/**
 * The resolved text of `path`: what is staged for it, or, before it is
 * staged, the working-tree file. Null when it exists in neither.
 */
export function resolvedText(root: string, path: string): string | null {
  const blob = indexBlob(root, path);
  if (blob !== null) return readBlob(root, blob);
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
}
