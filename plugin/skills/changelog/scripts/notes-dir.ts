// The repository side of change notes: where they are, in which order they
// merged, and git's view of a branch. Shared by release.ts and check.ts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { type ChangeNote, parseNote } from "./change-notes.ts";
import type { Format } from "./formats.ts";
import {
  currentVersion,
  type FileReader,
  type VersionSource,
} from "./versions.ts";

/** Where a repository keeps its notes, its changelog and its version, and the format they follow. */
export interface NotesConfig {
  root: string;
  /** The notes directory, relative to the root. */
  notes: string;
  /** The changelog, relative to the root. */
  changelog: string;
  format: Format;
  /** Where the released version lives. */
  version: VersionSource;
  /** What a version's tag puts before it. */
  tagPrefix: string;
}

/**
 * Whether a repository-relative path is a note: a Markdown file directly in
 * the notes directory, other than its README. The release step reads exactly
 * these, so the branch check counts exactly these.
 */
export function isNoteFile(notes: string, path: string): boolean {
  const name = posix.basename(path);
  return (
    posix.dirname(path) === posix.normalize(notes).replace(/\/+$/, "") &&
    name.endsWith(".md") &&
    name.toLowerCase() !== "readme.md"
  );
}

/**
 * The file name, within the notes folder, of the note a branch carries: the
 * branch's name with every character but a letter, a digit, `.`, `_` or `-`
 * replaced by `-` and cut to its first 64 characters, so a long name stays
 * within what a file system allows, then the first eight hexadecimal digits
 * of the SHA-256 of the full name, which keep `feat/x` and `feat-x` (and two
 * names alike in their first 64 characters) apart.
 */
export function noteName(branch: string): string {
  const digest = new Bun.CryptoHasher("sha256")
    .update(branch)
    .digest("hex")
    .slice(0, 8);
  return `${branch.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64)}-${digest}.md`;
}

/** The note files, by name. */
export function noteFiles(config: NotesConfig): string[] {
  const dir = join(config.root, config.notes);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => isNoteFile(config.notes, posix.join(config.notes, f)))
    .sort();
}

/**
 * Every note, read and checked, in the order the merges adding them landed on
 * the current branch (a note not committed yet sorts last). Notes from one
 * merge keep file-name order.
 */
export function readNotes(config: NotesConfig): {
  notes: ChangeNote[];
  errors: string[];
} {
  const notes: ChangeNote[] = [];
  const errors: string[] = [];
  for (const file of noteFiles(config)) {
    // Forward slashes on every platform: a note's name is a repository path.
    const path = posix.join(config.notes, file);
    const parsed = parseNote(
      path,
      readFileSync(join(config.root, path), "utf8"),
      config.format,
    );
    errors.push(...parsed.errors);
    if (parsed.note) notes.push(parsed.note);
  }
  const landedIn = landings(
    config.root,
    notes.map((n) => n.file),
  );
  const order = mergeOrder(config.root);
  const position = (file: string) =>
    order.get(landedIn.get(file) ?? "") ?? Number.POSITIVE_INFINITY;
  notes.sort(
    (a, b) =>
      position(a.file) - position(b.file) || a.file.localeCompare(b.file),
  );
  return { notes, errors };
}

/**
 * The commit on the branch's first-parent line (the merge, or the squashed
 * commit) that last added each path; null when none has. The last addition
 * is the note as it is now, so a file name reused after a release counts
 * from its new merge. First-parent history is the order merges landed in,
 * which commit timestamps are not: two merges can share a second, and a
 * commit's date can be anything its author set.
 */
export function landings(
  root: string,
  paths: string[],
): Map<string, string | null> {
  return new Map(
    paths.map((path) => [
      path,
      tryGit(root, [
        "log",
        "--first-parent",
        "--diff-filter=A",
        "-1",
        "--format=%H",
        "--",
        path,
      ])?.trim() || null,
    ]),
  );
}

/** Each commit on the branch's first-parent line, by its position from the root. */
export function mergeOrder(root: string): Map<string, number> {
  const commits = (
    tryGit(root, ["rev-list", "--first-parent", "--reverse", "HEAD"]) ?? ""
  )
    .split("\n")
    .filter(Boolean);
  return new Map(commits.map((commit, i) => [commit, i]));
}

/** The files of the working tree, by path relative to the root. */
export function workingTree(root: string): FileReader {
  return (path) => {
    const full = join(root, path);
    return existsSync(full) ? readFileSync(full, "utf8") : null;
  };
}

/** Every tag of the repository; none when git cannot list them. */
export function tagsOf(root: string): string[] {
  return (tryGit(root, ["tag", "--list"]) ?? "").split("\n").filter(Boolean);
}

/** The version released now, from the working tree. */
export function currentVersionOf(config: NotesConfig): string {
  const read = workingTree(config.root);
  return currentVersion(config.version, {
    read,
    format: config.format,
    tagPrefix: config.tagPrefix,
    changelog: read(config.changelog) ?? "",
    tags: () => tagsOf(config.root),
  });
}

/** The environment a child process gets: this one's, without what a git hook exports. */
export function gitEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([key]) =>
          !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
      ),
    ),
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** git's output, or null when git fails (no repository, an unknown revision). */
export function tryGit(root: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", root, ...args], { env: gitEnv() });
  return result.status === 0 ? result.stdout : null;
}
