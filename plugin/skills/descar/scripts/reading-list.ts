#!/usr/bin/env bun
/**
 * Print the lines of each named document that use wording typical of an
 * archaeological layer (scar class S4): "previously", "no longer",
 * "**Update:**", and so on.
 *
 * Usage: bun reading-list.ts <file.md>...
 *
 * The output is a reading list, not a verdict. Its precision is poor by
 * construction, and the S4 scars that mislead most use none of these words:
 * read the whole document regardless. Exit 0 whatever it finds; 2 when a file
 * cannot be read.
 */
import { readText, s4Lines } from "./lib/docs.ts";

export function readingList(files: string[]): string[] {
  return files.flatMap((file) =>
    s4Lines(readText(file)).map(({ line, text }) => `${file}:${line}: ${text}`),
  );
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: bun reading-list.ts <file.md>...");
    process.exitCode = 2;
  } else {
    try {
      for (const line of readingList(files)) console.log(line);
    } catch (error) {
      console.error(
        `reading-list: ${error instanceof Error ? error.message : error}`,
      );
      process.exitCode = 2;
    }
  }
}
