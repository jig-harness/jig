/**
 * `drivenBranch`: the drive state's copy of which working tree the last attach
 * prepared for a pull request, and the branch it pushes to.
 *
 * Written by every attach (`lib/attach.ts`). The source every script reads is
 * the tree's own record (`shared/driven-tree.ts`), which a reader holding only
 * a tree can find; this copy is what the handoff file shows a person, keyed
 * by the pull request. `created` says the attach made the tree for the drive
 * (`attach-pr.ts --place`).
 *
 * Optional in a stored state: a state file written before the field existed
 * reads as `null`, since nothing about a drive in progress changes when the
 * field appears. A value that is present must be well-formed.
 */
import { isRefName } from "../../../../../shared/driven-tree.ts";

export interface DrivenBranch {
  /** The pull request's head branch, the only branch the drive pushes to. */
  branch: string;
  /** The remote the head branch is fetched from and pushed to. */
  remote: string;
  /** The absolute path of the working tree the attach prepared. */
  worktree: string;
  /** The tree checked out the head commit rather than the branch. */
  detached: boolean;
  /** The attach created the tree for this drive (`attach-pr.ts --place`). */
  created: boolean;
  /** When the attach recorded this. */
  at: string;
}

/** Absent, `null`, or a well-formed record: what a stored state may hold. */
export function isOptionalDrivenBranch(v: unknown): boolean {
  return v === undefined || v === null || isDrivenBranch(v);
}

export function isDrivenBranch(v: unknown): v is DrivenBranch {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const d = v as Record<string, unknown>;
  return (
    isRefName(d.branch) &&
    isRefName(d.remote) &&
    typeof d.worktree === "string" &&
    d.worktree.length > 0 &&
    !/[\n\r]/.test(d.worktree) &&
    typeof d.detached === "boolean" &&
    typeof d.created === "boolean" &&
    typeof d.at === "string" &&
    Number.isFinite(Date.parse(d.at))
  );
}
