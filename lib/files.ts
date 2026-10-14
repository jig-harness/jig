import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * List files relative to a root; exclusions apply to relative components.
 * Regular files and links to them by default; with `everyEntry`, every entry
 * that is not a directory, so a caller that checks an entry's kind before
 * reading it also sees links to nothing, FIFOs and devices.
 */
export function walk(
  root: string,
  exclude: string[] = [".git", "node_modules"],
  everyEntry = false,
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
        everyEntry ||
        entry.isFile() ||
        (entry.isSymbolicLink() && statSync(join(root, name)).isFile())
      )
        files.push(name);
    }
  }
  visit("");
  return files.sort();
}

/**
 * A file's text, read only once its path is shown to reach a regular file.
 * A FIFO blocks the read and a device such as /dev/zero never ends it, so
 * every other kind of entry, a link to nothing included, throws instead.
 */
export function readRegularFile(path: string): string {
  const target = statSync(path, { throwIfNoEntry: false });
  if (!target) throw new Error("a link to nothing");
  if (!target.isFile()) throw new Error("not a regular file");
  return readFileSync(path, "utf8");
}

/**
 * Git supplies repository scope; NUL records preserve spaces and Unicode.
 * Outside a git work tree the walk stands in, `everyEntry` as for `walk`.
 */
export function repoFiles(root: string, { everyEntry = false } = {}): string[] {
  if (!statSync(root).isDirectory())
    throw new Error(`root is not a directory: ${root}`);
  const probe = Bun.spawnSync([
    "git",
    "-C",
    resolve(root),
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (probe.exitCode !== 0)
    return walk(root, [".git", "node_modules"], everyEntry);
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
