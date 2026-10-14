// Scope: tracked/non-ignored Markdown, excluding consumer templates, test
// fixtures (`fixtures/` and `fixture/` directories) and the frozen seeds. Ignored local workspaces are not content.
// A relative link must name a file or folder that exists; URLs, `mailto:`
// and anchors are not followed. Exit 1 on a broken link, 2 when there is no
// Markdown file to check.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cli } from "../lib/cli.ts";
import { markdownFiles } from "../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  repoPath,
  reportFindings,
} from "../lib/findings.ts";

const RULE = "md-links";

export function checkLinks(root = "."): number {
  const files = markdownFiles(root, [
    "templates",
    "fixtures",
    "fixture",
    "seeds",
  ]);
  if (!files.length)
    return couldNotCheck(RULE, `no Markdown file under ${root}`);
  const findings: Finding[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(/\]\(([^)]*)\)/g)) {
      const target = match[1] ?? "";
      if (/^(https?:\/\/|mailto:|#|<)/.test(target)) continue;
      const path = target.split("#")[0]?.replace(/ $/, "") ?? "";
      if (path && !existsSync(join(dirname(file), path)))
        findings.push({
          rule: RULE,
          file: repoPath(root, file),
          line: content.slice(0, match.index).split("\n").length,
          problem: `broken link to ${target}`,
          remedy:
            "point the link at an existing file, relative to this document's folder, or remove it",
        });
    }
  }
  if (findings.length) {
    reportFindings(findings);
    return 1;
  }
  console.log(
    `${RULE}: OK — ${files.length} Markdown files; every relative link resolves (URLs and anchors are not followed; templates, fixtures and seeds are skipped)`,
  );
  return 0;
}
if (import.meta.main) cli(() => checkLinks(process.argv[2]));
