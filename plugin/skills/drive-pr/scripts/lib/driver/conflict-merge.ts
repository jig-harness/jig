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
): Promise<() => Promise<void>> {
  const openBefore = await mergeOpen();
  return async () => {
    if (openBefore === false && held.length > 0) await abortMergeLeftOpen(pr);
  };
}

/**
 * Abort the merge a conflict-resolve pass left open, under the tree's fence, and
 * say what it held. A merge that cannot be aborted (its files edited since they
 * were staged, another session holding the tree) stays and is reported: its
 * content is not this driver's to force away.
 */
async function abortMergeLeftOpen(pr: string): Promise<void> {
  if ((await mergeOpen()) !== true) return;
  const left = `PR #${pr}: the conflict-resolution pass left its merge open`;
  let fence: Awaited<ReturnType<typeof treeFence>>;
  try {
    fence = await treeFence(pr, "drive.ts");
  } catch (err) {
    console.error(
      `${left}, and it stays: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  try {
    const opts = {
      ...inDrivenTree(),
      stderr: "pipe" as const,
      timeoutSec: gitCallTimeoutSeconds(),
    };
    const held = await git(["status", "--short", "--untracked-files=no"], opts);
    const abort = await git(["merge", "--abort"], opts);
    if (abort.code !== 0 || (await mergeOpen()) !== false) {
      console.error(
        `${left}, and 'git merge --abort' did not close it: ${abort.stderr.trim()}`,
      );
      return;
    }
    console.error(`${left}; aborted it, so nothing is half-merged. It held:`);
    for (const line of held.stdout.trimEnd().split("\n"))
      console.error(`  ${line}`);
  } finally {
    fence?.release();
  }
}
