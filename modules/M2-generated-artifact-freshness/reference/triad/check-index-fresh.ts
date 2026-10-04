// Compare using the real generator, never an independent definition of fresh.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../../../../lib/cli.ts";
import { indexContent } from "./generate-index.ts";
export function checkIndex(root?: string, index?: string): number {
  if (!root)
    throw new Error("usage: check-index-fresh.ts <docs-dir> [index-file]");
  const target = index || join(root, "index.md");
  if (
    !existsSync(target) ||
    readFileSync(target, "utf8") !== indexContent(root)
  ) {
    console.error(`STALE: ${target}. To fix: bun generate-index.ts ${root}`);
    return 1;
  }
  console.log(`OK: ${target} matches what the generator produces.`);
  return 0;
}
if (import.meta.main) cli(() => checkIndex(...process.argv.slice(2)));
