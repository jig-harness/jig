/**
 * The record a working tree keeps of the pull request a drive attached it to.
 *
 * `drive-pr`'s attach (`skills/drive-pr/scripts/attach-pr.ts`) can leave a
 * tree on a detached head: git allows one checkout per branch, so when
 * another working tree holds the pull request's head branch, this one checks
 * out the head commit instead. A detached tree has no branch for `gh pr view`
 * or `@{u}` to read, so the attach writes this record into the tree's own git
 * directory (`git rev-parse --absolute-git-dir`, which is per tree), and every
 * reader that starts from a tree rather than a pull request number reads the
 * branch, the remote and the pull request from it. The drive state keeps the
 * same facts keyed by the pull request (`drivenBranch`); this is the half a
 * reader holding only a tree can find, including code outside the skill
 * (`resolvePr`, resource collection, `resolve-conflicts`).
 *
 * The record is read only while the head is detached: a tree on a branch
 * answers from the branch, so a record left behind by an earlier attach never
 * outranks what the tree has checked out since.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errnoCode, swallow } from "./errors.ts";

/** The record's file name inside the tree's git directory. */
export const DRIVEN_TREE_FILE = "jig-driven-pr.json";

export interface DrivenTree {
  /** The pull request the tree was attached to. */
  pr: number;
  /** The pull request's head branch, on `remote`. */
  branch: string;
  /** The remote the head branch was fetched from and is pushed to. */
  remote: string;
  /** The attach created this tree for the drive, so collection may reap it. */
  created: boolean;
}

/** A git ref component: no whitespace, control characters or `~^:?*[\`. */
export function isRefName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[^\s~^:?*[\\]+$/.test(value) &&
    !/\p{Cc}/u.test(value)
  );
}

/** The record `text` holds, or `null` when it is not a well-formed one. */
export function parseDrivenTree(text: string): DrivenTree | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    swallow(err, "a drive's tree record is not JSON; read as none");
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.pr !== "number" ||
    !Number.isSafeInteger(v.pr) ||
    v.pr <= 0 ||
    !isRefName(v.branch) ||
    !isRefName(v.remote) ||
    typeof v.created !== "boolean"
  )
    return null;
  return { pr: v.pr, branch: v.branch, remote: v.remote, created: v.created };
}

/** The record in the git directory `gitDir`, or `null` when there is none. */
export function readDrivenTree(gitDir: string): DrivenTree | null {
  let text: string;
  try {
    text = readFileSync(join(gitDir, DRIVEN_TREE_FILE), "utf8");
  } catch (err) {
    if (errnoCode(err) !== "ENOENT")
      swallow(err, "a drive's tree record is unreadable; read as none");
    return null;
  }
  return parseDrivenTree(text);
}

/** Write `record` into the git directory `gitDir`. */
export function writeDrivenTree(gitDir: string, record: DrivenTree): void {
  writeFileSync(
    join(gitDir, DRIVEN_TREE_FILE),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
}

/** A git call bounded by its caller: the arguments, then code and stdout. */
export type TreeGit = (
  args: string[],
) => Promise<{ code: number; stdout: string }>;

/**
 * The record of the tree `git` runs in, when that tree's head is detached;
 * `null` on a branch, without a record, or when git cannot say.
 */
export async function detachedTreeRecord(
  git: TreeGit,
): Promise<DrivenTree | null> {
  const branch = await git(["symbolic-ref", "--quiet", "HEAD"]);
  if (branch.code === 0) return null;
  const dir = await git(["rev-parse", "--absolute-git-dir"]);
  const gitDir = dir.stdout.trim();
  if (dir.code !== 0 || gitDir === "") return null;
  return readDrivenTree(gitDir);
}
