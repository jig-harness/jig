// Scope: tracked/non-ignored Markdown, excluding consumer templates, test
// fixtures and frozen seeds/docs. Ignored local workspaces are not content.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cli } from "../lib/cli.ts";
import { markdownFiles } from "../lib/files.ts";
export function checkLinks(root = "."): number {
  let failed = false;
  for (const file of markdownFiles(root, [
    "templates",
    "fixtures",
    "seeds",
    "docs",
  ])) {
    for (const match of readFileSync(file, "utf8").matchAll(/\]\(([^)]*)\)/g)) {
      const target = match[1] ?? "";
      if (/^(https?:\/\/|mailto:|#|<)/.test(target)) continue;
      const path = target.split("#")[0]?.replace(/ $/, "") ?? "";
      if (path && !existsSync(join(dirname(file), path))) {
        console.error(`broken link: ${file} -> ${target}`);
        failed = true;
      }
    }
  }
  return failed ? 1 : 0;
}
if (import.meta.main) cli(() => checkLinks(process.argv[2]));
