// Deterministic index generator. Atomic replacement prevents partial output.
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { cli } from "../../../../lib/cli.ts";
import { walk } from "../../../../lib/files.ts";
export function indexContent(root: string): string {
  // Sort after separators are normalized: native paths order differently on
  // POSIX and Windows ("a/z.md" vs "a0.md"), so sorting them would not be stable.
  const entries = walk(root, [])
    .filter((name) => name.endsWith(".md") && basename(name) !== "index.md")
    .map((name) => ({ name, relative: name.replaceAll("\\", "/") }))
    .sort((a, b) =>
      a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0,
    );
  return (
    "<!-- GENERATED FILE - do not edit by hand.\n     Regenerate: bun generate-index.ts <docs-dir>  (see README.md) -->\n# Index\n\n" +
    entries
      .map(({ name, relative }) => {
        const title =
          readFileSync(join(root, name), "utf8")
            .split("\n")
            .find((line) => line.startsWith("# "))
            ?.slice(2) || relative;
        return `- [${title}](${relative})\n`;
      })
      .join("")
  );
}
export function generateIndex(root?: string, output?: string): number {
  if (!root)
    throw new Error("usage: generate-index.ts <docs-dir> [output-file]");
  const target = output || join(root, "index.md"),
    temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, indexContent(root), { flag: "wx" });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  console.error(`generated: ${target}`);
  return 0;
}
if (import.meta.main) cli(() => generateIndex(...process.argv.slice(2)));
