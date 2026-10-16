// The repository side of change notes: where they are, in which order they
// merged, and git's view of a branch. Shared by release.ts and check.ts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { isRecord } from "../../drive-pr/scripts/lib/fleet-health-sources.ts";
import { type ChangeNote, parseNote } from "./change-notes.ts";

/** Where a repository keeps its notes, its changelog and its version. */
export interface NotesConfig {
  root: string;
  /** The notes directory, relative to the root. */
  notes: string;
  /** The changelog, relative to the root. */
  changelog: string;
  /** JSON files whose top-level `version` is the released version; all agree. */
  versionFiles: string[];
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
function landings(root: string, paths: string[]): Map<string, string | null> {
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

/** A JSON file's top-level `version`; null when it has none. */
export function versionOf(json: string): string | null {
  const parsed: unknown = JSON.parse(json);
  return isRecord(parsed) && typeof parsed.version === "string"
    ? parsed.version
    : null;
}

/** The version every version file carries; throws when they disagree. */
export function currentVersion(config: NotesConfig): string {
  const versions = config.versionFiles.map((path) =>
    versionOf(readFileSync(join(config.root, path), "utf8")),
  );
  const [first] = versions;
  if (!first || versions.some((v) => v !== first))
    throw new Error(
      `the version files disagree: ${config.versionFiles.map((p, i) => `${p}=${versions[i] ?? "(none)"}`).join(", ")}`,
    );
  return first;
}

function gitEnv(): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
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
