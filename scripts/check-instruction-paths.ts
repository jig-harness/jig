// Scope: the instruction files every session reads, `AGENTS.md` and
// `CLAUDE.md` at any depth and the `CONTRIBUTING.md` they point to, outside test `fixtures/`, `templates/` and
// vendored `seeds/` (their paths belong to the repositories they are copied
// into). A path they name in a link or a code span must exist when M2's
// referenced-paths check extracts it
// (modules/M2-generated-artifact-freshness/reference/prose-facts): only a
// reference containing a `/` is extracted, so a bare file name such as
// `GLOSSARY.md` is not checked, and that check's header lists what else it
// skips. A link resolves from the file's folder, a code-span path from the
// file's folder or the repository root, and a bare folder name such as
// `templates/` also from a folder of that name anywhere in the repository.
// Markdown links are also checked by check-md-links.ts; this adds the
// backticked paths. Exit 1 on a missing path.
import { basename } from "node:path";
import { cli } from "../lib/cli.ts";
import { markdownFiles } from "../lib/files.ts";
import { checkPaths } from "../modules/M2-generated-artifact-freshness/reference/prose-facts/check-referenced-paths.ts";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"];

export function checkInstructionPaths(root = "."): number {
  const files = markdownFiles(root, ["fixtures", "templates", "seeds"]).filter(
    (file) => INSTRUCTION_FILES.includes(basename(file)),
  );
  return files.length ? checkPaths(files, root) : 0;
}
if (import.meta.main) cli(() => checkInstructionPaths(process.argv[2]));
