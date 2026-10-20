/** Render stop reports and verify the final worktree without changing round accounting. */
import {
  readTimeoutEnv,
  run,
  tsArgv,
  git,
  gitCallTimeoutSeconds,
  unconcludedGitOpMarker,
} from "./../proc.ts";

import { loopMetrics } from "./paths.ts";

/**
 * The loop-economy block a drive prints when it stops: rounds,
 * thread count, outcome mix, and how much of the code landed AFTER review
 * started — temporal, not causal; see `lib/metrics.ts` § "What the split does
 * NOT establish".
 *
 * BEST-EFFORT, and that is a deliberate asymmetry with every other spawn in
 * this file. The round budget, the durable counters and the parked set are all
 * read HARD — an unreadable one is a loop with no bound, so it stops the drive.
 * This is a REPORT: nothing acts on it, no gate consumes it, and a drive that
 * converged has converged whether or not its epilogue rendered. Failing the
 * drive over a missing summary would be strictly worse than printing a note.
 *
 * Returns the text rather than writing it, so a caller can pay the network cost
 * at a point of its choosing and print at another — which the converged path
 * needs, because its final HEAD re-read must stay the LAST thing before the
 * convergence is reported. Always a string: a failure renders as a note saying
 * so, never as silence, so an operator can tell "cheap loop" from "no answer".
 */
export async function loopEconomy(pr: string): Promise<string> {
  // Leniently read, unlike announce-merge-ready.ts's validated use of the same
  // variable: a malformed deadline there refuses an announcement, and here it
  // would refuse a decoration. Fall back to the documented default instead.
  const read = readTimeoutEnv("DRIVE_PR_HELPER_TIMEOUT", 120);
  const r = await run(tsArgv(loopMetrics, [pr]), {
    timeoutSec: read.ok ? read.seconds : 120,
    stderr: "ignore",
  });
  if (r.code !== 0 || r.stdout.trim() === "") {
    return `  (loop-metrics could not read PR #${pr} — no economy summary this run)\n`;
  }
  return r.stdout;
}

/**
 * Surface a total severity-parsing outage before an agent starts triaging the
 * round. This is reporting only: an unreadable metric must never prevent a
 * pass that could repair the reviewer format or its findings.
 */
export async function severityWarnings(pr: string): Promise<string> {
  const read = readTimeoutEnv("DRIVE_PR_HELPER_TIMEOUT", 120);
  const r = await run(tsArgv(loopMetrics, [pr, "--severity-warnings"]), {
    timeoutSec: read.ok ? read.seconds : 120,
    stderr: "ignore",
  });
  if (r.code !== 0) {
    return `  (loop-metrics could not read severity warnings for PR #${pr} — continuing without them this round)\n`;
  }
  return r.stdout;
}

/**
 * What the driven worktree still holds, for a NON-converged stop.
 *
 * The converged path already certifies a clean tree and refuses to exit 0 over
 * leftovers, so it needs no such report. The stall stop is the mirror case: a
 * pass that made real, correct edits and then stood down without committing
 * exits the loop with its work product sitting in the worktree, and without
 * this report nothing tells the operator so; a `git checkout`, a re-arm, or a
 * branch switch would then destroy those edits.
 *
 * Reports rather than decides: the exit code is the caller's, unchanged.
 * Never silence — a tree that cannot be READ is reported as unreadable,
 * because "no leftovers" over a failed probe is the false all-clear this
 * exists to prevent; a clean tree is stated positively for the same reason;
 * an unconcluded git operation and uncommitted paths are each named when
 * present, together when both are (leftoverReport below is the source of
 * truth for the exact population — this comment doesn't re-enumerate it).
 * Silence is what the operator could not distinguish from any of these.
 *
 * Same flags as the convergence-path probe, for the same measured reasons:
 * `--untracked-files=normal` because `--porcelain` alone inherits
 * `status.showUntrackedFiles`, where `=no` hides an untracked file entirely,
 * and `--ignore-submodules=none` because `submodule.<name>.ignore = all` hides
 * modifications one level down regardless of the untracked-files mode.
 */
export async function leftoverReport(): Promise<string> {
  const dirty = await git(
    [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ],
    { stderr: "ignore", timeoutSec: gitCallTimeoutSeconds() },
  );
  if (dirty.code !== 0) {
    return (
      "  This worktree is UNREADABLE, so what it still holds is unknown — check it\n" +
      "  by hand before any command that discards state (git checkout/reset, a branch\n" +
      "  switch, a re-arm).\n"
    );
  }
  // Porcelain answers "is anything uncommitted", not "is a git operation
  // still open": resolving a conflict back to a tree that matches what was
  // already committed leaves MERGE_HEAD behind while porcelain reports empty
  // — the same gap the CONVERGED
  // path checks via this same helper, below.
  const op = await unconcludedGitOpMarker(gitCallTimeoutSeconds());
  // A stalled tree can carry BOTH signals at once — a conflict-resolution
  // pass commonly does — so report every one that's KNOWN rather than
  // collapsing to one message and hiding the rest (an early return on the op
  // marker once discarded already-collected dirty paths, and a failed op-marker
  // PROBE discarded them too, even though `dirty` — read successfully above
  // — was already known). `op.ok === false` means only the marker check
  // itself is unreadable; the porcelain read that already succeeded is not
  // thereby unknown, so it is still reported, alongside an explicit note
  // that the operation-marker state specifically could not be determined.
  if (op.ok && op.marker === null && dirty.stdout === "") {
    return "  This worktree is clean — nothing was left behind by the stalled pass(es).\n";
  }
  let report = "";
  if (!op.ok) {
    report +=
      "  Whether an unconcluded git operation (MERGE_HEAD or similar) is present could\n" +
      "  NOT be determined — check by hand before any command that discards state.\n";
  } else if (op.marker !== null) {
    report +=
      `  An UNCONCLUDED GIT OPERATION is present (${op.marker}) — resolve or abort it\n` +
      "  (git merge/cherry-pick/revert --abort) before any command that discards state.\n";
  }
  if (dirty.stdout !== "") {
    report +=
      "  UNCOMMITTED WORK IS LEFT IN THIS WORKTREE. It shipped in no round and no push,\n" +
      "  so it exists nowhere else — commit it on this branch or copy it out BEFORE any\n" +
      "  command that discards state (git checkout/reset, a branch switch, a re-arm):\n" +
      dirty.stdout;
  } else {
    // `dirty.stdout === ''` is known regardless of `op.ok` — the porcelain
    // read succeeded earlier and is independent of the op-marker probe. A
    // failed probe must not suppress this already-known result too (an
    // earlier `else if (op.ok)` guard here was the SAME bug it was meant to
    // close, one level down).
    report += "  No uncommitted paths — porcelain status is clean.\n";
  }
  return report;
}

/** Re-certify the local tree immediately before the converged success return. */
export async function certifyFinalWorktree(
  reviewedHead: string,
  passes: number,
): Promise<boolean> {
  const unreadable = () => {
    console.error(
      `review converged after ${passes} round(s), but the working tree is UNREADABLE —`,
    );
    console.error(
      "cannot certify the worktree is clean, so not exiting 0 over unknown leftovers.",
    );
  };
  const timeoutSec = gitCallTimeoutSeconds();
  const localHeadRes = await git(["rev-parse", "HEAD"], {
    stderr: "ignore",
    timeoutSec,
  });
  if (localHeadRes.code !== 0) {
    unreadable();
    return false;
  }
  if (reviewedHead === "" || localHeadRes.stdout.trim() !== reviewedHead) {
    console.error(
      `review converged after ${passes} round(s), but local HEAD is ${localHeadRes.stdout.trim() || "<empty>"},`,
    );
    console.error(
      `while the reviewed head is ${reviewedHead || "<empty>"} — a commit landed here`,
    );
    console.error(
      "that was never pushed or reviewed. Push it, or reset to the reviewed head, then re-run.",
    );
    return false;
  }
  const op = await unconcludedGitOpMarker(timeoutSec);
  if (!op.ok) {
    unreadable();
    return false;
  }
  if (op.marker !== null) {
    console.error(
      `review converged after ${passes} round(s), but an unconcluded git operation is present (${op.marker}) —`,
    );
    console.error("resolve or abort it, then re-run.");
    return false;
  }
  const dirty = await git(
    [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ],
    { stderr: "ignore", timeoutSec },
  );
  if (dirty.code !== 0) {
    unreadable();
    return false;
  }
  if (dirty.stdout !== "") {
    console.error(
      `review converged after ${passes} round(s), but this worktree still has uncommitted state:`,
    );
    process.stderr.write(dirty.stdout);
    console.error(
      "These edits shipped in no round — commit or discard them, then re-run.",
    );
    return false;
  }
  const finalHeadRes = await git(["rev-parse", "HEAD"], {
    stderr: "ignore",
    timeoutSec,
  });
  if (finalHeadRes.code !== 0) {
    unreadable();
    return false;
  }
  if (finalHeadRes.stdout.trim() !== reviewedHead) {
    console.error(
      `review converged after ${passes} round(s), but local HEAD is ${finalHeadRes.stdout.trim() || "<empty>"},`,
    );
    console.error(
      `while the reviewed head is ${reviewedHead || "<empty>"} — a commit landed here during the final check.`,
    );
    console.error("Push it, or reset to the reviewed head, then re-run.");
    return false;
  }
  return true;
}
