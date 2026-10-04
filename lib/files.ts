import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** List files relative to a root; exclusions apply to relative components. */
export function walk(
  root: string,
  exclude: string[] = [".git", "node_modules"],
): string[] {
  const files: string[] = [];
  function visit(relative: string): void {
    for (const entry of readdirSync(join(root, relative), {
      withFileTypes: true,
    })) {
      if (exclude.includes(entry.name)) continue;
      const name = join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (
        entry.isFile() ||
        (entry.isSymbolicLink() && statSync(join(root, name)).isFile())
      )
        files.push(name);
    }
  }
  visit("");
  return files.sort();
}

/** Git supplies repository scope; NUL records preserve spaces and Unicode. */
export function repoFiles(root: string): string[] {
  if (!statSync(root).isDirectory())
    throw new Error(`root is not a directory: ${root}`);
  const probe = Bun.spawnSync([
    "git",
    "-C",
    resolve(root),
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (probe.exitCode !== 0) return walk(root);
  const listed = Bun.spawnSync([
    "git",
    "-C",
    resolve(root),
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (listed.exitCode !== 0)
    throw new Error(`git ls-files failed under ${root}`);
  return [...new Set(listed.stdout.toString().split("\0").filter(Boolean))];
}

export function markdownFiles(root: string, excluded: string[]): string[] {
  return repoFiles(root)
    .filter(
      (name) =>
        name.endsWith(".md") &&
        !name.split(/[\\/]/).some((part) => excluded.includes(part)) &&
        existsSync(join(root, name)),
    )
    .map((name) => join(root, name));
}

/** Mask fenced blocks using the same toggle convention as the legacy gates. */
export function prose(content: string): string {
  let fenced = false;
  return content
    .split("\n")
    .filter((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return false;
      }
      return !fenced;
    })
    .join("\n")
    .replace(/`[^`]*`/g, "");
}
