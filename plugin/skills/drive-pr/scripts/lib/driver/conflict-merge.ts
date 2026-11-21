/**
 * The merge a conflict-resolve pass leaves open.
 *
 * A pass can stage its resolution and then end without concluding it: refused
 * the commit by its permission mode, killed at its deadline, out of quota. No
 * step after it can use that state: `base-sync.ts` and `finish-round.ts` refuse
 * an unconcluded operation, an attach refuses it once the pull request's head
 * has moved, convergence stops on it, and the stop's own `Fix:` command, a
 * `git merge`, fails on it. So a merge the pass started and did not conclude is
 * aborted, and the next pass, a re-arm or a person starts that merge again from
 * a clean tree.
 *
 * Only a merge the tree did not hold before the pass is the pass's own. One that
 * was already open may be a person's, or an earlier drive's, and is left for the
 * pass to finish or restart (`SKILL.md` § 0), never discarded here.
 */
import { treeFence } from "./../attach.ts";

import {
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  unconcludedGitOpMarker,
} from "./../proc.ts";

import type { DriveLock } from "./locks.ts";

/** Git's options for the tree this drive drives. */
function inDrivenTree(): {
  cwd?: string;
  env: ReturnType<typeof gitIdentityEnv>;
} {
  const anchor = process.env.DRIVE_PR_WORKTREE;
  return { ...(anchor ? { cwd: anchor } : {}), env: gitIdentityEnv() };
}

/** Whether a merge is open in the driven tree; `null` when that cannot be read. */
export async function mergeOpen(): Promise<boolean | null> {
  const op = await unconcludedGitOpMarker(
    gitCallTimeoutSeconds(),
    inDrivenTree(),
  );
  return op.ok ? op.marker === "MERGE_HEAD" : null;
}

/**
 * Read, before a conflict-resolve pass starts, whether the tree holds a merge;
 * the step to run once the pass has ended aborts one it left open. `held` is the
 * driver's locks: a pass that hit its deadline unwitnessed gave them up and may
 * still be working this tree, so nothing is aborted under it.
 */
export async function beforeConflictPass(
  pr: string,
  held: readonly DriveLock[],
): Promise<() => Promise<string | null>> {
  const openBefore = await mergeOpen();
  const options = cleanupOptions();
  const before =
    openBefore === false ? await listedFiles(options, ["--cached"]) : null;
  const head =
    openBefore === false ? await git(["rev-parse", "HEAD"], options) : null;
  return async () => {
    if (openBefore === false && held.length > 0) {
      return settleConflictTree(
        pr,
        before,
        head?.code === 0 ? head.stdout : null,
      );
    } else if (openBefore !== true && (await mergeOpen()) === true) {
      const why =
        held.length === 0
          ? "the driver no longer holds its locks"
          : "the initial merge state was unreadable";
      const result = `An open merge (MERGE_HEAD) remains because ${why}.`;
      console.error(`PR #${pr}: ${result}`);
      return result;
    }
    return null;
  };
}

function cleanupOptions() {
  return {
    ...inDrivenTree(),
    stderr: "pipe" as const,
    timeoutSec: gitCallTimeoutSeconds(),
  };
}

async function listedFiles(
  options: ReturnType<typeof cleanupOptions>,
  extra: string[] = [],
) {
  const result = await git(
    ["ls-files", "-z", "--others", "--exclude-standard", ...extra],
    options,
  );
  return result.code === 0
    ? new Set(result.stdout.split("\0").filter(Boolean))
    : null;
}

/** Restore a pass's unfinished merge under the same fence as its other writes. */
async function settleConflictTree(
  pr: string,
  before: ReadonlySet<string> | null,
  originalHead: string | null,
): Promise<string | null> {
  const left = `PR #${pr}: the conflict-resolution pass left its merge open`;
  const opts = cleanupOptions();
  const operation = await unconcludedGitOpMarker(opts.timeoutSec, opts);
  if (!operation.ok) {
    console.error(
      `PR #${pr}: could not read the merge state after the conflict-resolution pass`,
    );
    return "The merge state could not be read after the conflict-resolution pass.";
  }
  if (operation.marker !== null && operation.marker !== "MERGE_HEAD")
    return null;
  const open = operation.marker === "MERGE_HEAD";
  const head = await git(["rev-parse", "HEAD"], opts);
  if (!open && (head.code !== 0 || head.stdout !== originalHead)) return null;
  let fence: Awaited<ReturnType<typeof treeFence>>;
  try {
    fence = await treeFence(pr, "drive.ts");
  } catch (err) {
    console.error(
      `${open ? left : `PR #${pr}: could not check conflict-resolution leftovers`}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return open
      ? "The merge (MERGE_HEAD) could not be aborted because the tree fence was refused."
      : "Conflict-resolution leftovers could not be checked because the tree fence was refused.";
  }
  try {
    if (open) {
      const held = await git(
        ["status", "--short", "--untracked-files=normal"],
        opts,
      );
      const abort = await git(["merge", "--abort"], opts);
      if (abort.code !== 0 || (await mergeOpen()) !== false) {
        console.error(
          `${left}, and 'git merge --abort' did not close it: ${abort.stderr.trim() || "merge closure could not be verified"}`,
        );
        return "Git could not verify that aborting the unfinished merge closed MERGE_HEAD.";
      }
      console.error(`${left}; aborted it. It held:`);
      for (const line of held.stdout.trimEnd().split("\n"))
        console.error(`  ${line}`);
    }
    const after = before === null ? null : await listedFiles(opts);
    if (after === null || before === null) {
      console.error(
        `PR #${pr}: could not identify new untracked files after conflict resolution`,
      );
      return "New untracked files could not be identified after conflict resolution.";
    }
    let removed = 0;
    for (const path of after) {
      // A trailing slash represents an embedded repository. Leave it for
      // the final status check to report.
      if (before.has(path) || path.endsWith("/")) continue;
      const clean = await git(
        ["--literal-pathspecs", "clean", "-f", "--", path],
        opts,
      );
      if (clean.code === 0) removed += 1;
      else
        console.error(
          `PR #${pr}: could not remove ${JSON.stringify(path)}: ${clean.stderr.trim()}`,
        );
    }
    const status = await git(
      [
        "status",
        "--porcelain",
        "--untracked-files=normal",
        "--ignore-submodules=none",
      ],
      opts,
    );
    if (status.code !== 0 || status.stdout !== "") {
      console.error(
        `PR #${pr}: the conflict-resolution worktree could not be verified clean:\n${(status.stdout || status.stderr).trimEnd()}`,
      );
      return "The conflict-resolution worktree could not be verified clean.";
    }
    if (open || removed > 0) {
      console.error(
        `PR #${pr}: verified the worktree is clean after discarding unfinished conflict-resolution work`,
      );
      return open
        ? "The pass ended with its merge open. The driver aborted it and verified that the worktree is clean."
        : "The driver removed new untracked files and verified that the worktree is clean.";
    }
    return null;
  } finally {
    fence?.release();
  }
}
