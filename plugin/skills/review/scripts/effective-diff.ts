/**
 * The effective file list and diff of a review: what the change touches,
 * read with every git setting that could change what the diff shows fixed on
 * the command line, so neither the caller's git configuration nor the
 * change's own attributes file can hide an edit.
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";

/** One git call's outcome. */
export interface GitResult {
  code: number;
  stdout: string;
}

/**
 * Runs git in the reviewed tree. It rejects unless the exit status is one of
 * `accept`, so a failed call never passes as an empty answer.
 */
export type Git = (
  args: string[],
  accept: readonly number[],
) => Promise<GitResult>;

export class EffectiveDiffError extends Error {
  override name = "EffectiveDiffError";
}

/** What is wrong with the git `git --version` printed, or null when it is new enough. */
export function gitVersionProblem(output: string): string | null {
  const match = /git version (\d+)\.(\d+)/.exec(output);
  if (!match)
    return `review needs git 2.41 or later (for --attr-source), and cannot read the version from: ${output.trim()}`;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 41)
    ? null
    : `review needs git 2.41 or later (for --attr-source); this git is ${major}.${minor}`;
}

/** Options every patch takes: no colour, no external diff or textconv, every file as text. */
const PATCH = ["--no-color", "--no-ext-diff", "--no-textconv", "--text"];
/** Paths from the tree's root, with the standard prefixes, and no context lines. */
const LAYOUT = [
  "--no-relative",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "-U0",
  "--inter-hunk-context=0",
];
/** How many paths one tracked diff names, as `xargs` would split them. */
const PATHS_PER_CALL = 200;

function trackedListArgs(base: string): string[] {
  return [
    "--literal-pathspecs",
    `--attr-source=${base}`,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--no-relative",
    "--ignore-submodules=none",
    "--name-only",
    "-z",
    base,
  ];
}

function trackedDiffArgs(base: string, paths: readonly string[]): string[] {
  return [
    "--literal-pathspecs",
    `--attr-source=${base}`,
    "-c",
    "core.quotePath=false",
    "diff",
    ...PATCH,
    "--no-renames",
    "--ignore-submodules=none",
    "--submodule=short",
    ...LAYOUT,
    base,
    "--",
    ...paths,
  ];
}

/**
 * The comparison of one file with nothing. Attributes come from the base
 * here too: without `--attr-source`, a clean filter the change assigns to
 * its own new file would apply.
 */
function addedFileArgs(base: string, path: string): string[] {
  return [
    `--attr-source=${base}`,
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-index",
    ...PATCH,
    ...LAYOUT,
    "--",
    "/dev/null",
    path,
  ];
}

export function nulSeparated(text: string): string[] {
  if (text && !text.endsWith("\0"))
    throw new EffectiveDiffError("git's path list is not NUL terminated");
  return text.split("\0").filter(Boolean);
}

/** The changed paths git tracks, and the untracked ones, since `base`. */
export async function changedPaths(
  git: Git,
  base: string,
): Promise<{ tracked: string[]; untracked: string[] }> {
  const tracked = nulSeparated((await git(trackedListArgs(base), [0])).stdout);
  const untracked = nulSeparated(
    (await git(["ls-files", "--others", "--exclude-standard", "-z"], [0]))
      .stdout,
  );
  return { tracked, untracked };
}

/** Refuse a named path the reviewed tree does not hold: it cannot be reviewed as it is. */
export function requireExisting(root: string, paths: readonly string[]): void {
  for (const path of paths)
    if (lstatSync(join(root, path), { throwIfNoEntry: false }) === undefined)
      throw new EffectiveDiffError(
        `--files names a path that does not exist in the reviewed tree: ${path}`,
      );
}

/**
 * The effective diff: the tracked paths against `base`, then each of
 * `added` against nothing. Each call runs alone and its status is checked:
 * the tracked diff must exit 0, a comparison with nothing 0, or 1 with a
 * patch. Any other outcome throws, so a partial diff is never returned.
 */
export async function effectiveDiff(
  git: Git,
  base: string,
  tracked: readonly string[],
  added: readonly string[],
): Promise<string> {
  let diff = "";
  for (let i = 0; i < tracked.length; i += PATHS_PER_CALL)
    diff += (
      await git(
        trackedDiffArgs(base, tracked.slice(i, i + PATHS_PER_CALL)),
        [0],
      )
    ).stdout;
  for (const path of added) {
    const result = await git(addedFileArgs(base, path), [0, 1]);
    if (result.code === 1 && !result.stdout.startsWith("diff --git "))
      throw new EffectiveDiffError(
        `git could not compare ${path} with nothing`,
      );
    diff += result.stdout;
  }
  return diff;
}
