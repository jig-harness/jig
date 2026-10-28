/**
 * What a test-runner reader takes and gives. A reader is a pure function
 * from the repository's files to the test-file rules its runner's
 * configuration declares, each with the file and key it was read from, and
 * the configuration files it found but could not read.
 */
import { posix } from "node:path";

/** The repository's tracked paths, and a way to read one as text. */
export interface RepoFiles {
  paths: readonly string[];
  /** The file's text, or null when it cannot be read. */
  read(path: string): string | null;
}

/** One rule a runner's configuration declares: these files are tests. */
export interface RunnerRule {
  /** The reader that found it: `jest`, `vitest`, `pytest`, `Gradle`, `Maven`. */
  reader: string;
  /** The configuration file, relative to the repository root. */
  file: string;
  /** The key or convention the rule came from (`testMatch`, `the src/test/java default`). */
  key: string;
  /** The value as the configuration writes it. */
  pattern: string;
  /** The folder every path the rule matches lies under (`""`: the root). */
  scope: string;
  matches(path: string): boolean;
}

/** A configuration file a reader found but cannot read without running it. */
export interface Unreadable {
  reader: string;
  path: string;
  why: string;
}

/** What one reader, or every reader, found. */
export interface Reading {
  rules: RunnerRule[];
  unreadable: Unreadable[];
}

export const EMPTY_READING: Reading = { rules: [], unreadable: [] };

/** Thrown inside a reader for a file it cannot read; the reader reports it. */
export class UnreadableError extends Error {}

/**
 * Read each configuration file with `read`: its rules, or, when it throws an
 * `UnreadableError`, the file reported unreadable with no rule from it. A
 * file `read` returns null for is not this runner's configuration.
 */
export function readEach(
  reader: string,
  files: RepoFiles,
  configs: readonly string[],
  read: (path: string, text: string) => RunnerRule[] | null,
): Reading {
  const reading: Reading = { rules: [], unreadable: [] };
  for (const path of configs) {
    const text = files.read(path);
    if (text === null) continue;
    try {
      reading.rules.push(...(read(path, text) ?? []));
    } catch (error) {
      if (!(error instanceof UnreadableError)) throw error;
      reading.unreadable.push({ reader, path, why: error.message });
    }
  }
  return reading;
}

/** The folder of a repository path, `""` at the root. */
export function folderOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/** The last part of a repository path. */
export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * `relative` resolved against the repository folder `base`, as a repository
 * path (`""` for the root). Refused when it is absolute or leaves the
 * repository: its meaning would then depend on where the repository is
 * checked out.
 */
export function inside(base: string, relative: string, what: string): string {
  if (relative.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relative))
    throw new UnreadableError(`${what} is an absolute path`);
  const joined = posix.normalize(posix.join(base || ".", relative));
  if (joined === ".." || joined.startsWith("../"))
    throw new UnreadableError(`${what} points outside the repository`);
  // normalize leaves at most one trailing slash.
  return joined === "." ? "" : joined.replace(/\/$/, "");
}

/** Whether `path` lies under the repository folder `folder`. */
export function under(folder: string, path: string): boolean {
  return folder === "" || path.startsWith(`${folder}/`);
}

/** A rule claiming every file under the repository folder `folder`. */
export function folderRule(
  source: Pick<RunnerRule, "reader" | "file" | "key" | "pattern">,
  folder: string,
): RunnerRule {
  return { ...source, scope: folder, matches: (path) => under(folder, path) };
}

/** The deepest folder that holds every one of `folders`. */
export function commonFolder(folders: readonly string[]): string {
  const [first, ...rest] = folders;
  if (first === undefined) return "";
  let common = first.split("/");
  for (const folder of rest) {
    const parts = folder.split("/");
    let i = 0;
    while (i < common.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  return common.join("/");
}

/** `path` relative to `folder`, which holds it. */
export function within(folder: string, path: string): string {
  return folder === "" ? path : path.slice(folder.length + 1);
}
