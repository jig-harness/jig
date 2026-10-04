// Re-derive inventory counts without committing a generated cache.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { cli, ere } from "../../../../lib/cli.ts";
import { walk } from "../../../../lib/files.ts";
export function checkCounts(
  file?: string,
  source?: string,
  noun?: string,
): number {
  if (!file || !source || !noun)
    throw new Error(
      "usage: check-stated-counts.ts <prose-file> <source-dir> <noun>",
    );
  const count = walk(source, []).filter(
    (path) => path.endsWith(".md") && basename(path) !== "index.md",
  ).length;
  const pattern = ere(`[0-9][0-9]* ${noun} (total|available|listed)`, "g");
  let failed = false;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      for (const match of line.matchAll(pattern))
        if (Number.parseInt(match[0], 10) !== count) {
          console.error(
            `${file}:${index + 1} states ${match[0]}, but ${source} has ${count}`,
          );
          failed = true;
        }
    });
  if (!failed)
    console.log(
      `OK: derived ${count} ${noun}; no stated copy in ${file} disagrees.`,
    );
  return failed ? 1 : 0;
}
if (import.meta.main) cli(() => checkCounts(...process.argv.slice(2)));
