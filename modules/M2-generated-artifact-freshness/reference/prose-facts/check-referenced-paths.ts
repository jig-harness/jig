// Conservative prose-path extraction; URLs, placeholders and globs are skipped.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cli } from "../../../../lib/cli.ts";
// A leading-slash Markdown link is relative to the repository root, not to the
// prose file's directory or the filesystem root. Outside a git checkout the
// working directory stands in for the root.
function repoRoot(from: string): string {
  const top = Bun.spawnSync([
    "git",
    "-C",
    from,
    "rev-parse",
    "--show-toplevel",
  ]);
  return top.exitCode === 0 ? top.stdout.toString().trim() : process.cwd();
}
export function checkPaths(files: string[]): number {
  if (!files.length)
    throw new Error("usage: check-referenced-paths.ts <prose-file>...");
  let failed = false,
    checked = 0;
  for (const file of files) {
    let fenced = false;
    const root = repoRoot(resolve(dirname(file)));
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (line.startsWith("```")) {
          fenced = !fenced;
          return;
        }
        if (fenced) return;
        const targets = [
          { link: true, pattern: /\]\(([^)]+)\)/g },
          { link: false, pattern: /`([^`]+)`/g },
        ].flatMap(({ link, pattern }) =>
          [...line.matchAll(pattern)].flatMap((match) =>
            (match[1] ?? "").split(/\s+/).map((part) => ({ part, link })),
          ),
        );
        for (const target of targets) {
          let candidate = target.part;
          candidate = candidate.replace(/[#?].*$/, "").replace(/[.,;:)]*$/, "");
          if (
            !candidate.includes("/") ||
            /:\/\/|^(http:|https:|mailto:)|[<{$*?[ ]/.test(candidate)
          )
            continue;
          checked++;
          const found = candidate.startsWith("/")
            ? existsSync(join(root, candidate)) ||
              (!target.link && existsSync(candidate))
            : existsSync(join(dirname(file), candidate)) ||
              (!target.link && existsSync(candidate));
          if (!found) {
            console.error(`${file}:${index + 1}  ${candidate}`);
            failed = true;
          }
        }
      });
  }
  if (!failed)
    console.log(`OK: all ${checked} extracted path reference(s) resolve.`);
  return failed ? 1 : 0;
}
if (import.meta.main) cli(() => checkPaths(process.argv.slice(2)));
