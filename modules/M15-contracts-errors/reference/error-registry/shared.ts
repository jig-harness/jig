// Shared by the two error-registry gates: the typed error their exit-code
// boundary maps to "could not check", the walk over source and documentation
// files with its exclusions, and the reader of a line-based list (the
// registry's codes, an allowlist, a baseline).
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readRegularFile, walk } from "../../../../lib/files.ts";
import {
  type ReasonedEntry,
  reasonedEntries,
} from "../../../../lib/findings.ts";

/**
 * An input the gate cannot read or use. The boundary (`lib/cli.ts`) prints
 * its message and exits 2, so a bad input never reads as a pass.
 */
export class InputError extends Error {}

/** `path` relative to `root`, with forward slashes. */
export function relPath(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

/** `path` resolved against `root`; it must exist. */
export function existing(root: string, path: string, what: string): string {
  const full = isAbsolute(path) ? path : resolve(root, path);
  if (!existsSync(full))
    throw new InputError(`${what} does not exist: ${path}`);
  return full;
}

/** Tests and type declarations are left out of every scan. */
export function isTestPath(path: string): boolean {
  return (
    /(^|\/)__tests__\//.test(path) ||
    /\.(test|spec)\.[^/]+$/.test(path) ||
    path.endsWith(".d.ts")
  );
}

/** Whether `path` is `prefix` itself or lies under it. */
const under = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

/** Whether a path has a dot-directory or `node_modules` segment. */
const hidden = (file: string): boolean =>
  file
    .split("/")
    .some((part) => part.startsWith(".") || part === "node_modules");

/** Whether `file`, relative to the root, is of a kind a scan reads. */
function isEligible(file: string, extensions: readonly string[]): boolean {
  return (
    extensions.some((extension) => file.endsWith(extension)) &&
    !isTestPath(file) &&
    !hidden(file)
  );
}

/** `full` itself when it is a file, else every file under it; relative to `root`. */
function filesAt(root: string, full: string): string[] {
  if (!statSync(full).isDirectory()) return [relPath(root, full)];
  return [...walk(full, [".git", "node_modules"])]
    .filter(
      (entry) => !entry.split(/[\\/]/).some((part) => part.startsWith(".")),
    )
    .map((entry) => relPath(root, join(full, entry)));
}

/**
 * The files to scan, relative to `root`: each of `paths` (a file, or every
 * file under a directory) that carries one of `extensions`, is not a test,
 * does not lie under an `excluded` path and passes `keep`. Dot-directories
 * and `node_modules` are skipped.
 *
 * A scan that reads nothing under a path it was given would pass without
 * having checked it, so three cases throw: a path that does not exist, a
 * path that holds no file of a scanned kind (a test, a type declaration or
 * another extension is not one), and paths whose every such file is
 * excluded or not kept. A path wholly excluded beside one that is not is
 * accounted for: the exclusion is the caller's statement about it.
 */
export function listFiles(
  root: string,
  paths: readonly string[],
  extensions: readonly string[],
  excluded: readonly string[],
  what: string,
  keep: (file: string) => boolean = () => true,
): string[] {
  const skip = excluded.map((path) =>
    relPath(root, existing(root, path, "an excluded path")),
  );
  const files = new Set<string>();
  for (const path of paths) {
    const eligible = filesAt(root, existing(root, path, what)).filter((file) =>
      isEligible(file, extensions),
    );
    if (eligible.length === 0)
      throw new InputError(
        `${what} holds no file to scan: ${path} (extensions ${extensions.join(",") || "none"}; tests and type declarations left out)`,
      );
    for (const file of eligible)
      if (!skip.some((prefix) => under(file, prefix)) && keep(file))
        files.add(file);
  }
  if (paths.length > 0 && files.size === 0)
    throw new InputError(
      `no file to scan under ${paths.join(", ")}: every one is excluded`,
    );
  return [...files].sort();
}

/** `text` with every character a regular expression gives meaning escaped. */
export const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The value after the option `name` at `index`; a missing one throws. */
export function optionValue(
  args: readonly string[],
  index: number,
  name: string,
  usage: string,
  allowDashes = false,
): string {
  const value = args[index];
  if (value === undefined || (value.startsWith("--") && !allowDashes))
    throw new InputError(`${name} needs a value\n${usage}`);
  return value;
}

/** The text of a file under `root`; a file that cannot be read throws. */
export function readText(root: string, path: string, what: string): string {
  try {
    return readRegularFile(resolve(root, path));
  } catch (error) {
    throw new InputError(`${what} cannot be read: ${path}`, { cause: error });
  }
}

/**
 * The entries of a line-based list, each with the `#` comment lines that
 * open its group as its reason (`lib/findings.ts` `reasonedEntries`).
 */
export function readList(
  root: string,
  path: string,
  what: string,
): ReasonedEntry[] {
  return reasonedEntries(readText(root, path, what));
}

/** A comma-separated option value as a list, blanks dropped. */
export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}
