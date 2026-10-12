// Scope: tracked/non-ignored prose except templates, test fixtures
// (`fixtures/` and `fixture/` directories) and the frozen seeds. Acronyms are a proxy; fenced and inline code is excluded.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cli } from "../lib/cli.ts";
import { markdownFiles, prose } from "../lib/files.ts";
const acronyms = (content: string) =>
  new Set(prose(content).match(/\b[A-Z][A-Za-z]*[A-Z]\b/g) ?? []);
export function checkGlossary(
  root = ".",
  glossary = join(root, "GLOSSARY.md"),
  allowlist = join(root, "scripts/glossary-allowlist.txt"),
): number {
  const known = acronyms(readFileSync(glossary, "utf8"));
  let allowed = "";
  try {
    allowed = readFileSync(allowlist, "utf8");
  } catch {
    /* The original allowlist is optional. */
  }
  for (const term of allowed
    .split("\n")
    .filter((line) => line && !line.startsWith("#")))
    known.add(term);
  let failed = false;
  for (const file of markdownFiles(root, [
    "templates",
    "fixtures",
    "fixture",
    "seeds",
  ])) {
    if (resolve(file) === resolve(glossary)) continue;
    for (const term of acronyms(readFileSync(file, "utf8")))
      if (!known.has(term)) {
        console.error(
          `undefined term of art: '${term}' in ${file} (define it in GLOSSARY.md or allowlist it)`,
        );
        failed = true;
      }
  }
  return failed ? 1 : 0;
}
if (import.meta.main) cli(() => checkGlossary(...process.argv.slice(2)));
