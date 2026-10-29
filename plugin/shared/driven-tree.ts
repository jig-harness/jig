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
 * branch, the remote and the pull request from it, including code outside the
 * skill (`resolvePr`, resource collection, `resolve-conflicts`). It is the
 * source; the drive state's `drivenBranch` is a copy keyed by the pull
 * request, for the handoff file.
 *
 * This record, not the state's, is what every script that starts from a tree
 * reads. It is read only while the head is detached and only while it still
 * describes the tree (`recordChecks`): a tree on a branch answers from the
 * branch, an attach by name removes the record, and a tree detached
 * somewhere else since answers as unrecorded, so a record left behind never
 * outranks what the tree has checked out since.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errnoCode, swallow } from "./errors.ts";
import { renameWithRetry } from "./rename-with-retry.ts";

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
  /** The pull request's head commit the attach put the tree on. */
  head: string;
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
    typeof v.created !== "boolean" ||
    typeof v.head !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(v.head)
  )
    return null;
  return {
    pr: v.pr,
    branch: v.branch,
    remote: v.remote,
    created: v.created,
    head: v.head,
  };
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

/** Remove the record from the git directory `gitDir`, if there is one. */
export function removeDrivenTree(gitDir: string): void {
  rmSync(join(gitDir, DRIVEN_TREE_FILE), { force: true });
}

/**
 * Write `record` into the git directory `gitDir`, whole or not at all: it is
 * written beside the record and renamed over it, so a write that fails or is
 * interrupted leaves the previous record, never an empty or partial one.
 */
export function writeDrivenTree(gitDir: string, record: DrivenTree): void {
  const path = join(gitDir, DRIVEN_TREE_FILE);
  const staged = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(staged, `${JSON.stringify(record)}\n`, "utf8");
    renameWithRetry(staged, path);
  } finally {
    rmSync(staged, { force: true });
  }
}

/** A git call bounded by its caller: the arguments, then code and stdout. */
export type TreeGit = (
  args: string[],
) => Promise<{ code: number; stdout: string }>;

/**
 * The git calls that must all succeed for a record to still describe the tree
 * it sits in: its `HEAD` descends from the commit the attach put it on, and
 * the head branch it names is still a remote-tracking branch. A tree detached
 * somewhere else since, or a branch gone from the remote, reads as unrecorded.
 */
export function recordChecks(record: DrivenTree): string[][] {
  return [
    ["merge-base", "--is-ancestor", record.head, "HEAD"],
    [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/${record.remote}/${record.branch}^{commit}`,
    ],
  ];
}

/**
 * The record of the tree `git` runs in, when that tree's head is detached and
 * the record still describes it (`recordChecks`); `null` on a branch, without
 * a record, for a stale one, or when git cannot say.
 */
export async function detachedTreeRecord(
  git: TreeGit,
): Promise<DrivenTree | null> {
  const branch = await git(["symbolic-ref", "--quiet", "HEAD"]);
  if (branch.code === 0) return null;
  const dir = await git(["rev-parse", "--absolute-git-dir"]);
  const gitDir = dir.stdout.trim();
  if (dir.code !== 0 || gitDir === "") return null;
  const record = readDrivenTree(gitDir);
  if (record === null) return null;
  for (const check of recordChecks(record))
    if ((await git(check)).code !== 0) return null;
  return record;
}
