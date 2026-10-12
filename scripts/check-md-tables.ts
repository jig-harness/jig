// Scope: tracked/non-ignored Markdown except test fixtures and frozen seeds.
// Tables in templates are checked too.
import { readFileSync } from "node:fs";
import { cli } from "../lib/cli.ts";
import { markdownFiles } from "../lib/files.ts";
export function checkTables(root = "."): number {
  let failed = false;
  for (const file of markdownFiles(root, ["fixtures", "seeds"])) {
    let previous = "",
      fenced = false;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
        else if (
          !fenced &&
          /^\s*\|/.test(line) &&
          !/^\s*\|/.test(previous) &&
          !/^\s*$/.test(previous)
        ) {
          console.error(
            `${file}:${index + 1}: table not preceded by a blank line`,
          );
          failed = true;
        }
        previous = line;
      });
  }
  return failed ? 1 : 0;
}
if (import.meta.main) cli(() => checkTables(process.argv[2]));
