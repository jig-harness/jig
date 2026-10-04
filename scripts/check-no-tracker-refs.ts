// Scope: every tracked/non-ignored text file, including templates and frozen
// material. Excludes fixtures and exactly the active pattern file. Invalid
// patterns, failed listings and unreadable paths are errors (exit 2).
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { cli, ere } from "../lib/cli.ts";
import { repoFiles } from "../lib/files.ts";
export function checkTracker(
  root = ".",
  patterns = join(import.meta.dir, "tracker-key-patterns.txt"),
): number {
  const patternPath = realpathSync(patterns);
  const regexes = readFileSync(patternPath, "utf8")
    .split("\n")
    .map((line) => line.trimStart())
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => ere(line));
  if (!regexes.length) throw new Error(`no patterns in ${patterns}`);
  let failed = false;
  for (const relative of repoFiles(root)) {
    if (relative.split(/[\\/]/).includes("fixtures")) continue;
    const file = resolve(root, relative);
    if (file === patternPath) continue;
    let content: Buffer;
    try {
      content = readFileSync(file);
    } catch (error) {
      // Only an observed deletion is skipped. EACCES and broken links fail.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          if (lstatSync(file).isSymbolicLink()) throw error;
        } catch (statError) {
          if (
            statError === error ||
            (statError as NodeJS.ErrnoException).code !== "ENOENT"
          )
            throw statError;
        }
        // realpath on the parent distinguishes a missing file from an
        // inaccessible ancestor; EACCES must propagate rather than pass.
        const { dirname } = require("node:path") as typeof import("node:path");
        let parent = dirname(file);
        for (;;) {
          try {
            realpathSync(parent);
            break;
          } catch (parentError) {
            if ((parentError as NodeJS.ErrnoException).code !== "ENOENT")
              throw parentError;
            const next = dirname(parent);
            if (next === parent) throw error;
            parent = next;
          }
        }
        continue;
      }
      throw error;
    }
    if (content.includes(0)) continue;
    content
      .toString("utf8")
      .split("\n")
      .forEach((line, index) => {
        if (regexes.some((regex) => regex.test(line))) {
          console.error(`${file}:${index + 1}:${line}`);
          failed = true;
        }
      });
  }
  if (failed)
    console.error(
      "issue-tracker reference found: state the rationale in the doc or a code comment instead",
    );
  return failed ? 1 : 0;
}
if (import.meta.main) cli(() => checkTracker(...process.argv.slice(2)));
