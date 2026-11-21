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
  const options = cleanupOptions();
  const initial = await unconcludedGitOpMarker(options.timeoutSec, options);
  // Leave operations the pass inherited available for it to finish or restart.
  if (initial.ok && initial.marker !== null) return async () => null;
  if (!initial.ok)
    console.error(
      `PR #${pr}: could not read the initial git operation: ${initial.reason}`,
    );

  const before = initial.ok ? await listedFiles(pr, options, "before") : null;
  const head = initial.ok ? await git(["rev-parse", "HEAD"], options) : null;
  if (head !== null && head.code !== 0)
    console.error(
      `PR #${pr}: could not read HEAD before conflict resolution (exit ${head.code}): ${head.stderr.trim()}`,
    );
  return async () => {
    if (initial.ok && held.length > 0)
      return settleConflictTree(
        pr,
        before,
        head?.code === 0 ? head.stdout : null,
      );

    const why = initial.ok
      ? "the driver no longer holds its locks"
      : "the initial git operation was unreadable";
    return reportBlockedCleanup(pr, options, why);
  };
}

async function reportBlockedCleanup(
  pr: string,
  options: GitOptions,
  why: string,
) {
  const final = await unconcludedGitOpMarker(options.timeoutSec, options);
  if (final.ok && final.marker !== "MERGE_HEAD") return null;
  const result = final.ok
    ? `An open merge (MERGE_HEAD) remains because ${why}.`
    : `The final merge state could not be verified, and cleanup was skipped because ${why}.`;
  console.error(`PR #${pr}: ${result}`);
  if (!final.ok) console.error(final.reason);
  return result;
}

function cleanupOptions() {
  return {
    ...inDrivenTree(),
    stderr: "pipe" as const,
    timeoutSec: gitCallTimeoutSeconds(),
  };
}

async function listedFiles(
  pr: string,
  options: ReturnType<typeof cleanupOptions>,
  phase: "before" | "after",
) {
  const args = ["ls-files", "-z", "--others", "--exclude-standard"];
  if (phase === "before") args.push("--cached");
  const result = await git(args, options);
  if (result.code !== 0) {
    console.error(
      `PR #${pr}: git ls-files exited ${result.code} ${phase} the conflict-resolution pass: ${result.stderr.trim()}`,
    );
    return null;
  }
  // `--ignored` lists only ignored paths, so collect it separately rather than
  // making a pre-existing ignored path look like pass-created cleanup.
  const ignored = await git([...args, "--ignored"], options);
  if (ignored.code === 0)
    return new Set(
      `${result.stdout}${ignored.stdout}`.split("\0").filter(Boolean),
    );
  console.error(
    `PR #${pr}: git ls-files --ignored exited ${ignored.code} ${phase} the conflict-resolution pass: ${ignored.stderr.trim()}`,
  );
  return null;
}

type GitOptions = ReturnType<typeof cleanupOptions>;

async function abortUnfinishedMerge(
  pr: string,
  opts: GitOptions,
): Promise<boolean> {
  const left = `PR #${pr}: the conflict-resolution pass left its merge open`;
  const held = await git(
    ["status", "--short", "--untracked-files=normal"],
    opts,
  );
  if (held.code !== 0)
    console.error(
      `PR #${pr}: the merge inventory failed (git status exit ${held.code}): ${held.stderr.trim()}`,
    );
  const abort = await git(["merge", "--abort"], opts);
  if (abort.code !== 0) {
    console.error(
      `${left}, and 'git merge --abort' did not close it (exit ${abort.code}): ${abort.stderr.trim()}`,
    );
    return false;
  }
  const final = await unconcludedGitOpMarker(opts.timeoutSec, opts);
  if (!final.ok || final.marker !== null) {
    const reason = final.ok ? `${final.marker} remains` : final.reason;
    console.error(
      `${left}, and 'git merge --abort' did not close it: ${reason}`,
    );
    return false;
  }
  console.error(`${left}; aborted it. It held:\n${held.stdout.trimEnd()}`);
  return true;
}

async function removeNewUntracked(
  pr: string,
  opts: GitOptions,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): Promise<boolean> {
  let removed = false;
  for (const path of after) {
    // Leave embedded repositories and names that could not be decoded
    // losslessly for the final status check to report.
    if (before.has(path) || path.endsWith("/") || path.includes("\uFFFD"))
      continue;
    const clean = await git(
      ["--literal-pathspecs", "clean", "-f", "-x", "--", path],
      opts,
    );
    if (clean.code === 0) removed = true;
    else
      console.error(
        `PR #${pr}: could not remove ${JSON.stringify(path)}: ${clean.stderr.trim()}`,
      );
  }
  return removed;
}

async function verifyRestoredTree(
  pr: string,
  opts: GitOptions,
): Promise<boolean> {
  const status = await git(
    [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ],
    opts,
  );
  if (status.code === 0 && status.stdout === "") return true;
  console.error(
    `PR #${pr}: the conflict-resolution worktree could not be verified clean:\n${status.stdout.trimEnd()}`,
  );
  if (status.code !== 0)
    console.error(
      `PR #${pr}: git status exited ${status.code}: ${status.stderr.trim()}`,
    );
  return false;
}

async function restoreConflictTree(
  pr: string,
  opts: GitOptions,
  open: boolean,
  before: ReadonlySet<string> | null,
): Promise<string | null> {
  if (open && !(await abortUnfinishedMerge(pr, opts)))
    return "Git could not verify that aborting the unfinished merge closed MERGE_HEAD.";
  const after = await listedFiles(pr, opts, "after");
  if (before === null || after === null) {
    const reason =
      "New untracked files could not be identified after conflict resolution.";
    console.error(`PR #${pr}: ${reason}`);
    return reason;
  }
  const removed = await removeNewUntracked(pr, opts, before, after);
  if (!(await verifyRestoredTree(pr, opts)))
    return "The conflict-resolution worktree could not be verified clean.";
  if (!open && !removed) return null;
  console.error(
    `PR #${pr}: verified the worktree is clean after discarding unfinished conflict-resolution work`,
  );
  return open
    ? "The pass ended with its merge open. The driver aborted it and verified that the worktree is clean."
    : "The driver removed new untracked files and verified that the worktree is clean.";
}

async function compareHead(
  pr: string,
  opts: GitOptions,
  originalHead: string | null,
): Promise<"same" | "changed" | { reason: string }> {
  const head = await git(["rev-parse", "HEAD"], opts);
  if (head.code === 0 && originalHead !== null)
    return head.stdout === originalHead ? "same" : "changed";
  const reason =
    "Could not verify the worktree's HEAD before and after conflict resolution, so new untracked files were left in place.";
  console.error(`PR #${pr}: ${reason}`);
  if (head.code !== 0)
    console.error(
      `git rev-parse HEAD exited ${head.code}: ${head.stderr.trim()}`,
    );
  return { reason };
}

/** Restore a pass's unfinished merge under the same fence as its other writes. */
async function settleConflictTree(
  pr: string,
  before: ReadonlySet<string> | null,
  originalHead: string | null,
): Promise<string | null> {
  const opts = cleanupOptions();
  const operation = await unconcludedGitOpMarker(opts.timeoutSec, opts);
  if (!operation.ok) {
    console.error(
      `PR #${pr}: could not read the merge state after the conflict-resolution pass: ${operation.reason}`,
    );
    return "The merge state could not be read after the conflict-resolution pass.";
  }
  if (operation.marker !== null && operation.marker !== "MERGE_HEAD")
    return null;
  const open = operation.marker === "MERGE_HEAD";
  const head = open ? "same" : await compareHead(pr, opts, originalHead);
  if (head === "changed") return null;
  if (head !== "same") return head.reason;

  let fence: Awaited<ReturnType<typeof treeFence>>;
  try {
    fence = await treeFence(pr, "drive.ts");
  } catch (err) {
    const reason = open
      ? "The merge (MERGE_HEAD) could not be aborted because the tree fence was refused."
      : "Conflict-resolution leftovers could not be checked because the tree fence was refused.";
    console.error(
      `PR #${pr}: ${reason} ${err instanceof Error ? err.message : String(err)}`,
    );
    return reason;
  }
  try {
    return await restoreConflictTree(pr, opts, open, before);
  } finally {
    fence?.release();
  }
}
