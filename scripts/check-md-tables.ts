// Scope: tracked/non-ignored Markdown except test fixtures and frozen seeds.
// Tables in templates are checked too. Exit 1 on a table not preceded by a
// blank line, 2 when there is no Markdown file to check.
import { readFileSync } from "node:fs";
import { cli } from "../lib/cli.ts";
import { markdownFiles } from "../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  repoPath,
  reportFindings,
} from "../lib/findings.ts";

const RULE = "md-table-blank-line";

export function checkTables(root = "."): number {
  const files = markdownFiles(root, ["fixtures", "seeds"]);
  if (!files.length)
    return couldNotCheck(RULE, `no Markdown file under ${root}`);
  const findings: Finding[] = [];
  for (const file of files) {
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
        )
          findings.push({
            rule: RULE,
            file: repoPath(root, file),
            line: index + 1,
            problem: "table not preceded by a blank line",
            remedy:
              "add a blank line before the table; many renderers break it otherwise",
          });
        previous = line;
      });
  }
  if (findings.length) {
    reportFindings(findings);
    return 1;
  }
  console.log(
    `${RULE}: OK — ${files.length} Markdown files; every table outside a code block follows a blank line (fixtures and seeds are skipped)`,
  );
  return 0;
}
if (import.meta.main) cli(() => checkTables(process.argv[2]));
